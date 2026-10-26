/**
 * lib/ai/openai-compat —— 最小可用的 OpenAI 兼容流式客户端
 *
 * 只做一件事：把 /chat/completions 的 SSE 流拆成纯文本增量吐出来。
 *
 * 为什么自己写而不装 SDK：
 *   协议本身只有「POST 一个 JSON、按行读 data:」两步，用 fetch 就够；
 *   现有依赖里 @anthropic-ai/sdk 是另一套协议，openai 包没必要为一层 while 循环引入。
 *
 * 两个必须处理的上游差异（实测踩过）：
 *   1. 推理模型（deepseek 系、hy、glm-flash 等）的 delta 里会同时出现
 *      reasoning_content 和 content。reasoning_content 是思考过程，不能拼进答案，
 *      否则前端会把「先想一遍」也显示给用户。这里只取 content。
 *   2. 推理模型的思考会吃掉 max_tokens 预算，预算给小了会出现
 *      「流正常结束但 content 一个字都没有」。这种情况抛出明确错误，
 *      而不是让前端显示一条空白消息。
 */

import type { AIConfig } from './config';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export class AIError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'AIError';
  }
}

/** 从上游错误响应里尽量抽出人类可读的原因 */
async function readErrorDetail(res: Response): Promise<string> {
  try {
    const text = await res.text();
    if (!text) return '';
    try {
      const j = JSON.parse(text);
      const msg = j?.error?.message ?? j?.message;
      if (typeof msg === 'string') return msg;
    } catch {
      /* 非 JSON，原样截断返回 */
    }
    return text.slice(0, 500);
  } catch {
    return '';
  }
}

/**
 * 调用 OpenAI 兼容接口并以异步生成器返回文本增量。
 *
 * 超时用 AbortController 控制整条流：推理模型首 token 可能几秒到十几秒，
 * 但总时长必须有上限，否则上游静默挂死会把 fetch 永久占住。
 */
export async function* streamChat(
  config: AIConfig,
  messages: ChatMessage[],
): AsyncGenerator<string, void, unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);

  let response: Response;
  try {
    response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages,
        stream: true,
        max_tokens: config.maxTokens,
        // OpenDesign 端点只认 reasoning_effort；不需要思考时设 none 可省 90% token
        ...(config.reasoningEffort ? { reasoning_effort: config.reasoningEffort } : {}),
      }),
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    if (e instanceof Error && e.name === 'AbortError') {
      throw new AIError('上游响应超时', 504);
    }
    throw new AIError(`无法连接 AI 服务：${e instanceof Error ? e.message : String(e)}`, 502);
  }

  if (!response.ok) {
    const detail = await readErrorDetail(response);
    clearTimeout(timer);
    throw new AIError(`AI 服务返回 ${response.status}`, response.status, detail);
  }
  if (!response.body) {
    clearTimeout(timer);
    throw new AIError('AI 服务未返回响应流', 502);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let emitted = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // 按行切；最后一段可能不完整，留在 buffer 里等下次
      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newlineIndex).replace(/\r$/, '');
        buffer = buffer.slice(newlineIndex + 1);

        if (!line.startsWith('data:')) continue; // 空行、注释、event: 行都跳过
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;

        let chunk: unknown;
        try {
          chunk = JSON.parse(payload);
        } catch {
          continue; // 半截 JSON 或心跳噪声
        }

        const delta = (chunk as { choices?: { delta?: Record<string, unknown> }[] })
          ?.choices?.[0]?.delta;
        if (!delta) continue;

        const text = delta.content;
        if (typeof text === 'string' && text.length > 0) {
          emitted = true;
          yield text;
        }
        // delta.reasoning_content 是思考过程，刻意丢弃
      }
    }
  } finally {
    clearTimeout(timer);
    reader.releaseLock?.();
  }

  if (!emitted) {
    throw new AIError(
      '模型返回了空内容。推理模型会先消耗 max_tokens 做思考，请调大 AI_MAX_TOKENS（当前上限见配置）',
      502,
    );
  }
}
