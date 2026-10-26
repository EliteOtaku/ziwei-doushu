/**
 * lib/ai/openai-compat —— OpenAI 兼容流式客户端（以 DeepSeek 官方规范为准）
 *
 * 职责边界：只负责「把 /chat/completions 的 SSE 流拆成事件」，
 * 不理解紫微斗数、不拼 system prompt、不决定 HTTP 响应形状。
 *
 * 为什么自己写而不装 openai SDK：
 *   协议本身是「POST 一个 JSON、按行读 data:」，用 fetch 足够；
 *   为一层 while 循环引入一个 SDK 及它的版本演进成本不划算。
 *
 * 官方规范中必须处理、且极易踩错的六件事：
 *
 *   1. reasoning_content 与 content 是**两个字段**。
 *      思考模式下 delta 先连续吐 reasoning_content（思考过程），再吐 content（正式回答）。
 *      只能取 content，否则前端会把「先想一遍」也当答案显示。
 *
 *   2. max_tokens 不传 ≠ 8K。
 *      官方：非思考默认 8K，思考默认 64K，effort=max 时 128K。
 *      硬编码一个偏小的值会让思考吃光预算、content 为空串。
 *      所以 config 层默认不设，只在用户显式配置时才上送。
 *
 *   3. finish_reason 必须检查。
 *      length = 被 max_tokens 截断；insufficient_system_resource = 推理资源不足中断。
 *      这两种都是「回答不完整」，不能当成功返回，否则用户看到半句话却不知道为何断了。
 *
 *   4. 错误码语义（官方 https://api-docs.deepseek.com/zh-cn/quick_start/error_codes）：
 *      400 格式错误 / 401 认证失败 / 402 余额不足 / 422 参数错误
 *      429 速率上限 / 500 服务器故障 / 503 服务器繁忙
 *      其中 429 / 500 / 503 是**瞬时**的，应退避重试；其余重试无意义，直接报给用户。
 *
 *   5. 超时应该是**空闲超时**而非总时长。
 *      思考模式生成长文可能跑几分钟，用固定总时长会误杀正常请求；
 *      而「连续 N 秒收不到任何字节」才是真正的挂死信号。
 *
 *   6. stream_options.include_usage 让最后一帧带 token 统计。
 *      官方在 usage 帧里 choices 为空数组，只带 usage，不能因 choices[0] 不存在就跳过。
 */

import { AIError } from './errors';
import type { AIConfig } from './config';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** 上游返回的 token 统计 */
export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  /** 其中思考部分消耗的 token（官方在 completion_tokens_details 里给出） */
  reasoningTokens?: number;
  totalTokens: number;
}

/** 一次流式调用的完整结果元信息，供调用方记录或透传 */
export interface StreamMeta {
  usage?: TokenUsage;
  finishReason?: string;
}

export interface StreamChunk {
  /** 正文增量 */
  text?: string;
  /** 思考过程增量（默认不转发给前端，但保留以便将来做「思考中」提示） */
  reasoning?: string;
  /** 该帧携带的元信息（通常是最后一帧） */
  meta?: StreamMeta;
}

/** 官方文档明确的瞬时错误码，值得退避重试 */
const RETRYABLE_STATUS = new Set([429, 500, 503]);

/**
 * 把 system 消息折叠进第一条 user 消息。
 *
 * 为什么需要：多数 OpenAI 兼容服务接受 `role: 'system'`，但并非全部。
 * 本地 Zcode 反代的 GLM 通道实测会以 405 / code 3012（unusual activity）
 * 直接拒绝含 system 的请求 —— 报错信息完全不提 system，极难从表象定位。
 *
 * 折叠而不是丢弃：system 里放的是命理口径与输出格式要求，
 * 丢了会让回答风格跑偏。合并成 `{system}\n\n---\n\n{user}` 的形态，
 * 语义上等价于「先交代背景，再提问」。
 *
 * 多条 system 按顺序拼接；若没有 user 消息（理论上不会发生），
 * 则把文本作为唯一的 user 消息发出去，避免出现空 messages。
 */
function foldSystemIntoUser(messages: ChatMessage[]): ChatMessage[] {
  const systemTexts: string[] = [];
  const rest: ChatMessage[] = [];

  for (const m of messages) {
    if (m.role === 'system') {
      if (m.content.trim()) systemTexts.push(m.content);
    } else {
      rest.push(m);
    }
  }

  if (systemTexts.length === 0) return messages;

  const preamble = systemTexts.join('\n\n');
  const firstUserIndex = rest.findIndex(m => m.role === 'user');
  if (firstUserIndex === -1) {
    return [{ role: 'user', content: preamble }, ...rest];
  }

  const merged: ChatMessage[] = [...rest];
  const target = merged[firstUserIndex];
  merged[firstUserIndex] = {
    role: 'user',
    content: `${preamble}\n\n---\n\n${target.content}`,
  };
  return merged;
}

/** 官方错误码 → 面向用户的中文说明 + 可操作建议 */
function describeStatus(status: number, detail: string): string {
  const tail = detail ? `（上游原文：${detail}）` : '';
  switch (status) {
    case 400:
      return `请求格式错误，请检查命盘数据是否完整${tail}`;
    case 401:
      return `API Key 认证失败，请核对 .env.local 中的密钥是否正确、是否已失效${tail}`;
    case 402:
      return `账户余额不足，请前往 DeepSeek 开放平台充值后重试${tail}`;
    case 422:
      return `请求参数非法，通常是模型名或 max_tokens 等取值不被支持${tail}`;
    case 429:
      return `请求速率或并发达到上限，已自动重试仍失败，请稍后再试${tail}`;
    case 500:
      return `AI 服务内部故障，已自动重试仍失败，请稍后再试${tail}`;
    case 503:
      return `AI 服务负载过高，已自动重试仍失败，请稍后再试${tail}`;
    default:
      return `AI 服务返回错误 ${status}${tail}`;
  }
}

/** 从上游错误响应里抽出人类可读的原因 */
async function readErrorDetail(res: Response): Promise<string> {
  try {
    const text = await res.text();
    if (!text) return '';
    try {
      const j = JSON.parse(text) as { error?: { message?: unknown }; message?: unknown };
      const msg = j?.error?.message ?? j?.message;
      if (typeof msg === 'string') return msg;
    } catch {
      /* 非 JSON，原样截断返回 */
    }
    return text.slice(0, 300);
  } catch {
    return '';
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new AIError('请求已取消', 499));
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new AIError('请求已取消', 499));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** 解析一帧 JSON 里的 usage，字段缺失时返回 undefined 而不是假零 */
function parseUsage(raw: unknown): TokenUsage | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const u = raw as Record<string, unknown>;
  const prompt = typeof u.prompt_tokens === 'number' ? u.prompt_tokens : undefined;
  const completion = typeof u.completion_tokens === 'number' ? u.completion_tokens : undefined;
  const total = typeof u.total_tokens === 'number' ? u.total_tokens : undefined;
  if (prompt === undefined && completion === undefined && total === undefined) return undefined;

  const details = u.completion_tokens_details as Record<string, unknown> | undefined;
  const reasoning =
    details && typeof details.reasoning_tokens === 'number' ? details.reasoning_tokens : undefined;

  return {
    promptTokens: prompt ?? 0,
    completionTokens: completion ?? 0,
    ...(reasoning !== undefined ? { reasoningTokens: reasoning } : {}),
    totalTokens: total ?? (prompt ?? 0) + (completion ?? 0),
  };
}

/**
 * 发起一次流式请求（含瞬时错误重试），逐帧产出增量。
 *
 * 重试只覆盖「还没吐出任何正文」的阶段：
 * 一旦已经开始 yield 内容，再重试会让用户看到重复片段，所以直接抛错。
 */
export async function* streamChat(
  config: AIConfig,
  messages: ChatMessage[],
  outerSignal?: AbortSignal,
): AsyncGenerator<StreamChunk, void, unknown> {
  // 通道不接受 system role 时（如本地 GLM 反代）折叠进第一条 user 消息。
  // 这一步必须发生在组装 body 之前，否则上送的就是被上游拒绝的原始结构。
  const baseMessages = config.supportsSystemRole ? messages : foldSystemIntoUser(messages);

  // 通道级输出约束：追加到**最后一条 user 消息**末尾，作为最近、最强的指令。
  // 放在末尾而不是开头，是因为模型的注意力更靠后，且不会冲淡产品提示词。
  let wireMessages = baseMessages;
  if (config.outputHint) {
    const lastUser = [...baseMessages].reverse().findIndex(m => m.role === 'user');
    if (lastUser !== -1) {
      const idx = baseMessages.length - 1 - lastUser;
      wireMessages = [...baseMessages];
      wireMessages[idx] = {
        role: 'user',
        content: `${wireMessages[idx].content}\n\n${config.outputHint}`,
      };
    }
  }

  const body: Record<string, unknown> = {
    model: config.model,
    messages: wireMessages,
    stream: true,
  };
  // 关键：只有显式配置才上送 max_tokens，否则交给上游按模式取默认（思考 64K）
  if (config.maxTokens !== undefined) body.max_tokens = config.maxTokens;
  if (config.reasoningEffort) body.reasoning_effort = config.reasoningEffort;
  if (config.includeUsage) body.stream_options = { include_usage: true };

  let attempt = 0;
  let emitted = false;

  while (true) {
    attempt += 1;
    // 每次尝试各自计时：首字正文超时应从本次请求发出算起
    const requestStart = Date.now();
    const controller = new AbortController();
    const onOuterAbort = () => controller.abort();
    outerSignal?.addEventListener('abort', onOuterAbort, { once: true });

    // 空闲超时：每收到一帧就重置。挂死 ≠ 跑得慢。
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const resetIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, config.idleTimeoutMs);
    };

    try {
      resetIdle();

      let response: Response;
      try {
        // 本地免鉴权通道不下发 Authorization：某些反代对空的 Bearer 会返回 401
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
        };
        if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;

        response = await fetch(`${config.baseUrl}/chat/completions`, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (e) {
        if (e instanceof Error && e.name === 'AbortError') {
          throw new AIError(
            timedOut
              ? `AI 服务 ${Math.round(config.idleTimeoutMs / 1000)} 秒无任何响应，已中断`
              : '请求已取消',
            timedOut ? 504 : 499,
          );
        }
        // 网络层失败（DNS / 连接被拒 / TLS），可重试
        if (attempt < config.maxAttempts && !emitted) {
          await sleep(config.retryBaseMs * 2 ** (attempt - 1), controller.signal);
          continue;
        }
        throw new AIError(
          `无法连接 AI 服务：${e instanceof Error ? e.message : String(e)}`,
          502,
        );
      }

      if (!response.ok) {
        const detail = await readErrorDetail(response);
        const err = new AIError(describeStatus(response.status, detail), response.status, detail);

        if (RETRYABLE_STATUS.has(response.status) && attempt < config.maxAttempts && !emitted) {
          const wait = config.retryBaseMs * 2 ** (attempt - 1);
          // Retry-After 优先于退避算法
          const retryAfter = Number(response.headers.get('retry-after'));
          const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : wait;
          if (idleTimer) clearTimeout(idleTimer);
          outerSignal?.removeEventListener('abort', onOuterAbort);
          await sleep(Math.min(delay, 30_000), controller.signal);
          continue;
        }
        throw err;
      }

      if (!response.body) {
        throw new AIError('AI 服务未返回响应流', 502);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let finishReason: string | undefined;
      let usage: TokenUsage | undefined;

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          resetIdle();

          buffer += decoder.decode(value, { stream: true });

          // 按行切；最后一段可能不完整，留在 buffer 等下一片。
          // 必须用 \n 切而不是按网络分片切 —— 分片边界会落在 JSON 中间。
          let nl: number;
          while ((nl = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, nl).replace(/\r$/, '');
            buffer = buffer.slice(nl + 1);

            if (!line || line.startsWith(':')) continue; // 空行 / SSE 注释心跳
            if (!line.startsWith('data:')) continue; // event: / id: / retry: 一律跳过
            const payload = line.slice(5).trim();
            if (payload === '[DONE]') continue;

            let chunk: Record<string, unknown>;
            try {
              chunk = JSON.parse(payload) as Record<string, unknown>;
            } catch {
              continue; // 心跳噪声或上游偶发非 JSON 行
            }

            // usage 帧：官方在最后一帧返回，此时 choices 为空数组
            const u = parseUsage(chunk.usage);
            if (u) usage = u;

            // 流内错误对象（部分中转站用它代替 HTTP 状态码）
            const inlineErr = chunk.error as { message?: unknown; code?: unknown } | undefined;
            if (inlineErr) {
              const msg =
                typeof inlineErr.message === 'string' ? inlineErr.message : '上游在流中返回错误';
              throw new AIError(msg, 502);
            }

            const choices = chunk.choices as
              | { delta?: Record<string, unknown>; finish_reason?: unknown }[]
              | undefined;
            const choice = choices?.[0];
            if (!choice) continue;

            if (typeof choice.finish_reason === 'string') {
              finishReason = choice.finish_reason;
            }

            const delta = choice.delta;
            if (!delta) continue;

            const reasoning = delta.reasoning_content;
            if (typeof reasoning === 'string' && reasoning) {
              // 首字正文超时：思考型模型会长时间只吐 reasoning，空闲计时器被不断重置，
              // 连接看似正常但用户什么都看不到。到点主动放弃，给一条可操作的错误。
              if (!emitted && Date.now() - requestStart > config.firstContentTimeoutMs) {
                throw new AIError(
                  `模型持续思考 ${Math.round(config.firstContentTimeoutMs / 1000)} 秒仍未输出正文，已中断。` +
                    '可能是提问要求的输出结构过于复杂。请把问题拆小（例如只问一个宫位或一个主题）后重试。',
                  504,
                );
              }
              yield { reasoning };
            }

            const text = delta.content;
            if (typeof text === 'string' && text) {
              emitted = true;
              yield { text };
            }
          }
        }
      } finally {
        if (idleTimer) clearTimeout(idleTimer);
        reader.releaseLock?.();
      }

      // 流正常结束：检查是否被截断
      if (usage || finishReason) {
        yield { meta: { usage, finishReason } };
      }
      if (finishReason === 'length') {
        throw new AIError(
          '回答因达到长度上限被截断。如需完整回答，请调大 AI_MAX_TOKENS（上限 393216）或改用更具体的问题',
          502,
        );
      }
      if (finishReason === 'insufficient_system_resource') {
        throw new AIError('推理资源不足，回答被中断，请重试', 503);
      }

      if (!emitted) {
        // 思考模式吃光预算的典型症状：流正常结束但正文一个字都没有
        throw new AIError(
          '模型没有返回正文内容。若启用了思考模式，可能是 max_tokens 过小导致思考占满预算，' +
            '请调大 AI_MAX_TOKENS（上限 393216），或把 AI_REASONING_EFFORT 设为 none',
          502,
        );
      }

      return;
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
      outerSignal?.removeEventListener('abort', onOuterAbort);
    }
  }
}
