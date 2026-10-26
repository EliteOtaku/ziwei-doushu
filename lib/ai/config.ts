/**
 * lib/ai/config —— AI 通道配置解析（OpenAI 兼容协议，以 DeepSeek 官方规范为准）
 *
 * 设计要点：
 *   1. 只认一套环境变量约定，不引入新的配置概念：
 *        AI_PROVIDER             通道名（deepseek / opendesign / 其他）
 *        <PROVIDER>_API_KEY      该通道的密钥，如 DEEPSEEK_API_KEY
 *        <PROVIDER>_BASE_URL     该通道的 /v1 地址（有预设时可省）
 *        <PROVIDER>_MODEL        模型名（有预设时可省）
 *      以及通用兜底 AI_API_KEY / AI_BASE_URL / AI_MODEL。
 *   2. 预设表只放「确实需要记的默认值」，其余全靠环境变量，
 *      新增通道不必改代码——只要 AI_PROVIDER + 三个变量给齐。
 *   3. 缺配置时返回结构化原因而不是抛异常，路由据此回 503 并把原因写进日志，
 *      避免排障时只能看到「解读失败，请稍后重试」。
 *
 * 与 DeepSeek 官方文档对齐的取值（https://api-docs.deepseek.com/zh-cn/api/create-chat-completion）：
 *   - 模型只有 deepseek-flash / deepseek-v4-pro 两个
 *   - max_tokens 取值 1 ~ 393216；不传时非思考默认 8K、思考默认 64K（effort=max 时 128K）
 *   - reasoning_effort 取 none / low / high / max，none 表示关闭思考；
 *     minimal 映射 low，medium / xhigh 映射 high，ultra 映射 max
 *   - stream_options.include_usage 让流式响应带上 token 统计
 */

/**
 * DeepSeek 官方 reasoning_effort 取值。
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
  /** 上送 reasoning_effort；不设则用上游默认（DeepSeek 官方默认 high） */
  reasoningEffort?: ReasoningEffort;
  /** 可重试状态（429/500/503）的最大尝试次数，含首次 */
  maxAttempts: number;
  /** 指数退避基准毫秒 */
  retryBaseMs: number;
  /** 是否上送 stream_options.include_usage 以获取 token 统计 */
  includeUsage: boolean;
}

/** 已知通道的默认地址与模型；未列出的通道必须显式给 BASE_URL / MODEL */
const PRESETS: Record<string, { baseUrl: string; model: string }> = {
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
};

export type ResolveResult =
  | { ok: true; config: AIConfig }
  | { ok: false; reason: string };

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/** 归一 reasoning_effort；无法识别的词返回 undefined 并把原因带到日志 */
export function normalizeEffort(raw: string | undefined): ReasoningEffort | undefined {
  const key = (raw || '').trim().toLowerCase();
  if (!key) return undefined;
  return EFFORT_ALIASES[key];
}

export function resolveAIConfig(): ResolveResult {
  const provider = (process.env.AI_PROVIDER || 'deepseek').trim().toLowerCase();
  const prefix = provider.toUpperCase().replace(/[^A-Z0-9]/g, '_');
  const preset = PRESETS[provider] ?? {};

  const apiKey = (process.env[`${prefix}_API_KEY`] || process.env.AI_API_KEY || '').trim();
  if (!apiKey) {
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
  const reasoningEffort = normalizeEffort(rawEffort);
  if (rawEffort && rawEffort.trim() && !reasoningEffort) {
    // 不阻断请求：无法识别的值直接不上送，让上游按默认处理，同时在日志里留痕
    console.warn(
      `[ai/config] 无法识别的 AI_REASONING_EFFORT="${rawEffort.trim()}"，已忽略。` +
        '可选值：none / low / high / max（也接受 minimal / medium / xhigh / ultra 别名）。',
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

  return {
    ok: true,
    config: {
      provider,
      baseUrl,
      apiKey,
      model,
      maxTokens,
      idleTimeoutMs: positiveInt(process.env.AI_IDLE_TIMEOUT_MS, 120_000),
      reasoningEffort,
      maxAttempts: positiveInt(process.env.AI_MAX_ATTEMPTS, 3),
      retryBaseMs: positiveInt(process.env.AI_RETRY_BASE_MS, 1_000),
      includeUsage: process.env.AI_INCLUDE_USAGE !== 'false',
    },
  };
}
