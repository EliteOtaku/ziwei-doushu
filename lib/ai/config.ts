/**
 * lib/ai/config —— AI 通道配置解析（OpenAI 兼容协议）
 *
 * 设计要点：
 *   1. 只认一套环境变量约定，不引入新的配置概念：
 *        AI_PROVIDER             通道名（deepseek / opendesign / 其他）
 *        <PROVIDER>_API_KEY      该通道的密钥，如 OPENDESIGN_API_KEY
 *        <PROVIDER>_BASE_URL     该通道的 /v1 地址（有预设时可省）
 *        <PROVIDER>_MODEL        模型名（有预设时可省）
 *      以及通用兜底 AI_API_KEY / AI_BASE_URL / AI_MODEL。
 *   2. 预设表只放「确实需要记的默认值」，其余全靠环境变量，
 *      新增通道不必改代码——只要 AI_PROVIDER + 三个变量给齐。
 *   3. 缺配置时返回结构化原因而不是抛异常，路由据此回 503 并把原因写进日志，
 *      避免排障时只能看到「解读失败，请稍后重试」。
 */

export interface AIConfig {
  provider: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  /** 单次回复的内容预算。推理模型会先花一部分在 reasoning 上，给小了会返回空串 */
  maxTokens: number;
  /** 整条流的最长存活时间，防止上游挂死把连接拖住 */
  timeoutMs: number;
  /** 部分端点的思考等级开关（OpenDesign 只认这个字段）；不设则用上游默认 */
  reasoningEffort?: string;
}

/** 已知通道的默认地址与模型；未列出的通道必须显式给 BASE_URL / MODEL */
const PRESETS: Record<string, { baseUrl: string; model: string }> = {
  deepseek: {
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

  const reasoningEffort = (process.env.AI_REASONING_EFFORT || '').trim() || undefined;

  return {
    ok: true,
    config: {
      provider,
      baseUrl,
      apiKey,
      model,
      maxTokens: positiveInt(process.env.AI_MAX_TOKENS, 8000),
      timeoutMs: positiveInt(process.env.AI_TIMEOUT_MS, 180_000),
      reasoningEffort,
    },
  };
}
