/**
 * lib/ai/sse —— 把异步文本流包成前端约定的 SSE 响应
 *
 * 前端（components/ChatPanel.tsx、components/InsightPanel.tsx、app/heming/page.tsx）
 * 的解析逻辑固定为：
 *   逐行看是否以 "data: " 开头，去掉前缀后若是 "[DONE]" 结束，
 *   否则 JSON.parse 并取 .delta.text 拼接。
 * 所以这里必须严格产出该格式，且每帧以空行分隔。
 *
 * 一个容易踩的坑：前端是按 \n 切分并逐行 parse 的，
 * 如果 JSON 里含有真实换行符，会把一帧拆成多行、导致 JSON.parse 失败而被静默丢弃，
 * 表现就是「回复里整段内容突然消失」。JSON.stringify 会把 \n 转义成 \\n，天然安全。
 */

import { AIError, streamChat, type ChatMessage } from './openai-compat';
import type { AIConfig } from './config';

export interface ErrorBody {
  error: string;
  detail?: string;
}

function jsonError(status: number, error: string, detail?: string): Response {
  return new Response(JSON.stringify({ error, ...(detail ? { detail } : {}) } satisfies ErrorBody), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

/**
 * 启动流式回复。
 *
 * 错误分两段处理：
 *   - 上游连不上 / 返回非 2xx：还没有写出任何 SSE 字节，直接回 JSON 错误，
 *     前端能拿到真实状态码（404 语义要留给「接口不存在」，所以这里把上游的 404 改判为 502）。
 *   - 已经开流后出错：只能往流里塞一帧 error 事件并结束，前端会保留已收到的内容。
 */
export function streamAIResponse(config: AIConfig, messages: ChatMessage[]): Response {
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (obj: unknown) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
      };

      try {
        for await (const delta of streamChat(config, messages)) {
          send({ delta: { text: delta } });
        }
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      } catch (e) {
        const message =
          e instanceof AIError ? e.message : e instanceof Error ? e.message : '未知错误';
        send({ error: message });
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // 关掉 Nginx / CDN 的缓冲，否则流式会变成「憋到最后一次性吐出来」
      'X-Accel-Buffering': 'no',
    },
  });
}

export { jsonError };
