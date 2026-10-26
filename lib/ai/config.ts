/**
 * lib/ai/config —— AI 通道配置解析（OpenAI 兼容协议）
 *
 * 设计要点：
 *   1. 只认一套环境变量约定，不引入新的配置概念：
 *        AI_PROVIDER             通道名（deepseek / opendesign / zcode / 其他）
 *        <PROVIDER>_API_KEY      该通道的密钥，如 DEEPSEEK_API_KEY（本地通道可空）
 *        <PROVIDER>_BASE_URL     该通道的 /v1 地址（有预设时可省）
 *        <PROVIDER>_MODEL        模型名（有预设时可省）
 *      以及通用兜底 AI_API_KEY / AI_BASE_URL / AI_MODEL。
 *   2. 预设表不只是「默认值」，还记录**该通道的协议差异**（是否需要密钥、
 *      是否接受 system role）。这些差异是实测出来的事实，必须随预设一起走，
 *      否则换通道就会撞上难以定位的 4xx。
 *   3. 缺配置时返回结构化原因而不是抛异常，路由据此回 503 并把原因写进日志。
 *
 * 与 DeepSeek 官方文档对齐的取值（https://api-docs.deepseek.com/zh-cn/api/create-chat-completion）：
 *   - 模型只有 deepseek-flash / deepseek-v4-pro 两个
 *   - max_tokens 取值 1 ~ 393216；不传时非思考默认 8K、思考默认 64K（effort=max 时 128K）
 *   - reasoning_effort 取 none / low / high / max，none 表示关闭思考；
 *     minimal 映射 low，medium / xhigh 映射 high，ultra 映射 max
 *   - stream_options.include_usage 让流式响应带上 token 统计
 */

/**
 * reasoning_effort 取值（按 DeepSeek 官方定义）。
 * none 关闭思考模式；low / high / max 开启思考并指定强度。
 */
export type ReasoningEffort = 'none' | 'low' | 'high' | 'max';

/**
 * 官方给出的别名映射表：请求传入 effort → 实际映射 effort。
 * 用户写 medium / ultra 这类词时按官方规则归一，而不是直接透传导致 422。
 */
const EFFORT_ALIASES: Record<string, ReasoningEffort> = {
  none: 'none',
  minimal: 'low',
  low: 'low',
  medium: 'high',
  high: 'high',
  xhigh: 'high',
  max: 'max',
  ultra: 'max',
};

/** 官方 max_tokens 上限 384K */
export const MAX_TOKENS_LIMIT = 384 * 1024;

export interface AIConfig {
  provider: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  /**
   * 单次回复的内容预算。**不设时完全不上送该字段**，
   * 交给上游按官方默认处理（非思考 8K / 思考 64K），
   * 这比硬编码一个偏小的值更安全：思考模式会先吃掉预算，给小了会返回空串。
   */
  maxTokens?: number;
  /** 空闲超时：连续这么久没收到任何数据才中断，而不是限制整条流的总时长 */
  idleTimeoutMs: number;
  /**
   * 首字正文超时：从发出请求起，多久还没拿到**第一段正文**就放弃。
   *
   * 为什么需要它（与 idleTimeoutMs 不同）：思考型模型会先连续吐 reasoning_content，
   * 这会不断重置空闲计时器，所以「连接还活着」并不等于「在给用户产出」。
   * 实测本地 GLM 通道遇到复杂结构化提问时会长时间只思考不产出正文，
   * 客户端于是空转数分钟看不到任何内容。有了这个上限才能及时报错。
   */
  firstContentTimeoutMs: number;
  /** 上送 reasoning_effort；不设则用上游默认 */
  reasoningEffort?: ReasoningEffort;
  /** 可重试状态（429/500/503）的最大尝试次数，含首次 */
  maxAttempts: number;
  /** 指数退避基准毫秒 */
  retryBaseMs: number;
  /** 是否上送 stream_options.include_usage 以获取 token 统计 */
  includeUsage: boolean;
  /**
   * 该通道是否接受 `role: 'system'` 消息。
   *
   * 绝大多数 OpenAI 兼容服务都接受，但不接受时必须把 system 内容并进
   * 第一条 user 消息 —— 见 openai-compat.ts 的 foldSystemIntoUser()。
   * 这不是可选优化：某些通道会直接以 4xx 拒绝含 system 的请求。
   */
  supportsSystemRole: boolean;
  /**
   * 追加到末条 user 消息之后的一句额外约束（可选）。
   *
   * 为什么需要：实测本地 GLM 通道（glm-5.3-flash）在收到「分五段详细分析」
   * 这类不封顶的输出要求时，会把预算全烧在 reasoning 上，正文一个字都不产出；
   * 同一提示词加上「总长控制在 400 字内」即可正常返回（90s 无输出 → 68s 完整回答）。
   * 这不是模型缺陷而是该通道的推理预算特性，故以通道级配置兜住，
   * 不去改前端的产品提示词。
   */
  outputHint?: string;
}

interface Preset {
  baseUrl: string;
  model: string;
  /** 该通道不需要密钥（本地反代 / 免鉴权自建服务） */
  requiresApiKey?: boolean;
  /** 该通道不接受 system role，需并入 user 消息 */
  supportsSystemRole?: boolean;
  /** 该通道对 max_tokens / reasoning_effort 的实际支持情况，仅用于文档与告警 */
  ignoresMaxTokens?: boolean;
  ignoresReasoningEffort?: boolean;
  /** 追加到末条 user 消息后的额外输出约束 */
  outputHint?: string;
}

/**
 * 已知通道的默认地址与模型，以及实测出的协议差异。
 * 未列出的通道必须显式给 BASE_URL / MODEL。
 */
const PRESETS: Record<string, Preset> = {
  deepseek: {
    // 官方 OpenAI 格式 base url 是 https://api.deepseek.com；
    // 这里保留 /v1 前缀，因为实际拼的是 {baseUrl}/chat/completions，
    // 而 /v1 在官方与绝大多数中转站上都是兼容的。
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-flash',
  },
  opendesign: {
    baseUrl: 'https://amr-link.open-design.ai/v1',
    model: 'deepseek-v4.1-flash',
  },
  zcode: {
    // 本地 Zcode 反代出来的智谱 GLM 通道（2026-10-27 实测）
    // 实测结论：
    //   - 不需要 Authorization（带 dummy 头也放行）
    //   - **含 role:'system' 会被上游风控拦截**（405 / code 3012），必须并入 user
    //   - thinking:{type} 不被支持（400）
    //   - max_tokens 被忽略（设 8 也不截断）
    //   - reasoning_effort 接受但不真正关闭思考，始终有思考阶段
    baseUrl: 'http://127.0.0.1:8081/v1',
    model: 'glm-5.3-flash',
    requiresApiKey: false,
    supportsSystemRole: false,
    ignoresMaxTokens: true,
    ignoresReasoningEffort: true,
    // 不加这句时，前端「分五段详细分析」类提示词会让它 90s 内只思考不产出。
    // 加了之后同一提示词可正常返回（实测 68s / 429 字）。
    outputHint:
      '回答要求：直接开始输出正文，总长控制在 400 字以内，各部分简明扼要，不要展开长篇推理。',
  },
};

export type ResolveResult =
  | { ok: true; config: AIConfig }
  | { ok: false; reason: string };

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/** 归一 reasoning_effort；无法识别的词返回 undefined */
export function normalizeEffort(raw: string | undefined): ReasoningEffort | undefined {
  const key = (raw || '').trim().toLowerCase();
  if (!key) return undefined;
  return EFFORT_ALIASES[key];
}

export function resolveAIConfig(): ResolveResult {
  const provider = (process.env.AI_PROVIDER || 'deepseek').trim().toLowerCase();
  const prefix = provider.toUpperCase().replace(/[^A-Z0-9]/g, '_');
  const preset: Preset = PRESETS[provider] ?? ({} as Preset);

  const apiKey = (process.env[`${prefix}_API_KEY`] || process.env.AI_API_KEY || '').trim();
  // 预设默认「需要密钥」；只有显式声明 requiresApiKey:false 的本地通道才允许留空
  const requiresApiKey = preset.requiresApiKey !== false;
  if (!apiKey && requiresApiKey) {
    return { ok: false, reason: `未配置 ${prefix}_API_KEY（或 AI_API_KEY）` };
  }

  const baseUrl = (process.env[`${prefix}_BASE_URL`] || process.env.AI_BASE_URL || preset.baseUrl || '')
    .trim()
    .replace(/\/+$/, '');
  if (!baseUrl) {
    return { ok: false, reason: `未配置 ${prefix}_BASE_URL（或 AI_BASE_URL）` };
  }

  const model = (process.env[`${prefix}_MODEL`] || process.env.AI_MODEL || preset.model || '').trim();
  if (!model) {
    return { ok: false, reason: `未配置 ${prefix}_MODEL（或 AI_MODEL）` };
  }

  const rawEffort = process.env.AI_REASONING_EFFORT;
  let reasoningEffort = normalizeEffort(rawEffort);
  if (rawEffort && rawEffort.trim() && !reasoningEffort) {
    // 不阻断请求：无法识别的值直接不上送，让上游按默认处理，同时在日志里留痕
    console.warn(
      `[ai/config] 无法识别的 AI_REASONING_EFFORT="${rawEffort.trim()}"，已忽略。` +
        '可选值：none / low / high / max（也接受 minimal / medium / xhigh / ultra 别名）。',
    );
  }
  if (reasoningEffort && preset.ignoresReasoningEffort) {
    console.warn(
      `[ai/config] 通道 ${provider} 实测不响应 reasoning_effort，但仍会照常上送（无害）。` +
        '该通道无法通过此参数关闭思考阶段。',
    );
  }

  // max_tokens 只在显式配置时上送，且按官方上限截断
  const rawMaxTokens = process.env.AI_MAX_TOKENS;
  let maxTokens: number | undefined;
  if (rawMaxTokens && rawMaxTokens.trim()) {
    const n = Number(rawMaxTokens);
    if (Number.isFinite(n) && n > 0) {
      maxTokens = Math.min(Math.floor(n), MAX_TOKENS_LIMIT);
    }
  }
  if (maxTokens !== undefined && preset.ignoresMaxTokens) {
    console.warn(`[ai/config] 通道 ${provider} 实测忽略 max_tokens，该设置不会生效。`);
  }

  return {
    ok: true,
    config: {
      provider,
      baseUrl,
      apiKey,
      model,
      maxTokens,
      // 本地 GLM 通道首轮冷启动实测可达 90s+，默认给足 3 分钟；
      // 注意这是「空闲」超时，只要还在持续出字就不会被打断。
      idleTimeoutMs: positiveInt(process.env.AI_IDLE_TIMEOUT_MS, 180_000),
      // 首段正文必须在这个时间内出现；思考型模型可能长时间只吐 reasoning。
      firstContentTimeoutMs: positiveInt(process.env.AI_FIRST_CONTENT_TIMEOUT_MS, 90_000),
      reasoningEffort,
      maxAttempts: positiveInt(process.env.AI_MAX_ATTEMPTS, 3),
      retryBaseMs: positiveInt(process.env.AI_RETRY_BASE_MS, 1_000),
      includeUsage: process.env.AI_INCLUDE_USAGE !== 'false',
      supportsSystemRole: preset.supportsSystemRole !== false,
      outputHint: (process.env.AI_OUTPUT_HINT || preset.outputHint || '').trim() || undefined,
    },
  };
}
