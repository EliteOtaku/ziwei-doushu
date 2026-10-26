/**
 * app/api/interpret/route.ts —— 单人命盘 AI 解读
 *
 * 契约来自前端（components/ChatPanel.tsx、components/InsightPanel.tsx）：
 *   请求 POST { chart: ZiweiChart, messages: {role:'user'|'assistant', content:string}[] }
 *   响应 text/event-stream，每帧 data: {"delta":{"text":"..."}}，末尾 data: [DONE]
 *
 * 前端在 status===404 时显示「开源版不含该接口」。
 * 因此本路由一旦存在，就绝不能对上游错误回 404 —— 那会被误判成「接口没实现」。
 */

import { resolveAIConfig } from '@/lib/ai/config';
import { buildInterpretSystemPrompt } from '@/lib/ai/prompts';
import { jsonError, streamAIResponse } from '@/lib/ai/sse';
import type { ChatMessage } from '@/lib/ai/openai-compat';
import type { ZiweiChart } from '@/lib/ziwei/types';

export const runtime = 'nodejs';
// 流式输出不能被静态化
export const dynamic = 'force-dynamic';

const MAX_HISTORY = 20;
const MAX_MESSAGE_CHARS = 4000;

/** 轻量校验：只挡住会让后续代码崩掉的形状，不做 zod 式全字段校验（chart 来自本站自己生成） */
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

function normalizeMessages(v: unknown): ChatMessage[] | null {
  if (!Array.isArray(v) || v.length === 0) return null;
  const out: ChatMessage[] = [];
  for (const raw of v.slice(-MAX_HISTORY)) {
    if (!raw || typeof raw !== 'object') continue;
    const m = raw as { role?: unknown; content?: unknown };
    const role = m.role === 'assistant' ? 'assistant' : m.role === 'user' ? 'user' : null;
    if (!role || typeof m.content !== 'string') continue;
    const content = m.content.slice(0, MAX_MESSAGE_CHARS);
    if (!content.trim()) continue;
    out.push({ role, content });
  }
  // 最后一条必须是 user，否则模型没有要回答的问题
  if (out.length === 0 || out[out.length - 1].role !== 'user') return null;
  return out;
}

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonError(400, '请求体不是合法 JSON');
  }

  const { chart, messages } = (body ?? {}) as { chart?: unknown; messages?: unknown };

  if (!isChart(chart)) {
    return jsonError(400, '缺少有效的命盘数据（chart）');
  }

  const history = normalizeMessages(messages);
  if (!history) {
    return jsonError(400, '缺少有效的对话消息（messages）');
  }

  const resolved = resolveAIConfig();
  if (!resolved.ok) {
    console.error('[api/interpret] AI 配置缺失：', resolved.reason);
    return jsonError(
      503,
      'AI 服务未配置',
      `${resolved.reason}。请在 .env.local 中填写后重启服务，参见 .env.example。`,
    );
  }

  const payload: ChatMessage[] = [
    { role: 'system', content: buildInterpretSystemPrompt(chart) },
    ...history,
  ];

  return streamAIResponse(resolved.config, payload);
}
