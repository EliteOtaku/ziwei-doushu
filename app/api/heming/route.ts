/**
 * app/api/heming/route.ts —— 双人合盘 AI 分析
 *
 * 契约来自前端（app/heming/page.tsx）：
 *   请求 POST { chartA: ZiweiChart, chartB: ZiweiChart, question?: string }
 *   响应 text/event-stream，每帧 data: {"delta":{"text":"..."}}，末尾 data: [DONE]
 *
 * 与 /api/interpret 的差别：合盘是一次性分析，没有多轮对话，
 * 所以 messages 只有 system + 一条 user（可选的自定义问题）。
 */

import { resolveAIConfig } from '@/lib/ai/config';
import { buildHemingSystemPrompt } from '@/lib/ai/prompts';
import { jsonError, streamAIResponse } from '@/lib/ai/sse';
import type { ChatMessage } from '@/lib/ai/openai-compat';
import type { ZiweiChart } from '@/lib/ziwei/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_QUESTION_CHARS = 2000;

function isChart(v: unknown): v is ZiweiChart {
  if (!v || typeof v !== 'object') return false;
  const c = v as Partial<ZiweiChart>;
  return (
    !!c.birthInfo &&
    typeof c.birthInfo === 'object' &&
    Array.isArray(c.palaces) &&
    c.palaces.length === 12 &&
    typeof c.mingGongBranch === 'number'
  );
}

const DEFAULT_QUESTION =
  '请按框架完整分析这两张命盘的匹配度：从命格基础、夫妻宫互参、太阳太阴、四化飞化、大限同步五个维度展开，最后给出相处建议。';

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonError(400, '请求体不是合法 JSON');
  }

  const { chartA, chartB, question } = (body ?? {}) as {
    chartA?: unknown;
    chartB?: unknown;
    question?: unknown;
  };

  if (!isChart(chartA) || !isChart(chartB)) {
    return jsonError(400, '缺少有效的双方命盘数据（chartA / chartB）');
  }

  const resolved = resolveAIConfig();
  if (!resolved.ok) {
    console.error('[api/heming] AI 配置缺失：', resolved.reason);
    return jsonError(
      503,
      'AI 服务未配置',
      `${resolved.reason}。请在 .env.local 中填写后重启服务，参见 .env.example。`,
    );
  }

  const ask =
    typeof question === 'string' && question.trim()
      ? question.trim().slice(0, MAX_QUESTION_CHARS)
      : DEFAULT_QUESTION;

  const payload: ChatMessage[] = [
    { role: 'system', content: buildHemingSystemPrompt(chartA, chartB) },
    { role: 'user', content: ask },
  ];

  return streamAIResponse(resolved.config, payload);
}
