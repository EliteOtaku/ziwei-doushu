/**
 * lib/ai/sse —— 服务端：把 AI 流包装成前端约定的 SSE 响应
 *
 * 帧类型（前端 lib/ai/sse-client.ts 与之对应，两边必须同步改）：
 *   data: {"delta":{"text":"..."}}                       正文增量
 *   data: {"error":{"message":"...","status":N}}          流中途出错（HTTP 已 200，无法改状态码）
 *   data: {"meta":{"usage":{...},"finishReason":"stop"}} 结束元信息（可选）
 *   data: [DONE]                                          流结束哨兵
 *
 * 为什么流内错误要单独一帧：
 *   一旦写出第一个字节，HTTP 状态码就锁定为 200 了，无法再回 5xx。
 *   早期实现只写 {"error":"文本"}，而前端三种消费者都只读 parsed.delta.text，
 *   于是错误被静默吞掉，用户只看到一个空白气泡 —— 这是必须修的缺陷。
 *   现在用嵌套的 error.message 结构，前端能明确识别并展示。
 *
 * 另一个坑：前端按行解析，JSON 里若有真实换行会把一帧拆成多行导致 parse 失败。
 * JSON.stringify 会把 \n 转义成 \\n，天然安全，不要手工拼 JSON。
 */

import { AIError } from './errors';
import { streamChat, type ChatMessage, type StreamMeta } from './openai-compat';
import type { AIConfig } from './config';

export interface ErrorBody {
  error: string;
  detail?: string;
}

export function jsonError(status: number, error: string, detail?: string): Response {
  const body: ErrorBody = { error, ...(detail ? { detail } : {}) };
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

/**
 * 启动流式回复。
 *
 * 错误分两段处理：
 *   - 连不上 / 上游非 2xx 且重试耗尽：还没写出任何 SSE 字节，直接回 JSON + 真实状态码，
 *     前端能据此给出精确提示（注意：404 语义留给「接口未实现」，上游 404 改判 502）。
 *   - 已开流后出错：写一帧 error 事件后结束，前端保留已收到内容并展示错误。
 */
export function streamAIResponse(config: AIConfig, messages: ChatMessage[]): Response {
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (obj: unknown) => {
        if (closed) return;
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
      };
      const finish = () => {
        if (closed) return;
        closed = true;
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      };

      try {
        // 立刻发一帧 SSE 注释，作用有两个：
        //   1. 冲刷响应头。ReadableStream 要等到第一次 enqueue 才会把 headers 发出去，
        //      而思考型模型可能几十秒才吐第一个正文 token —— 不先 flush，
        //      浏览器端 fetch 会一直停在等响应头，看起来像「点了没反应」。
        //   2. 让前端立刻知道请求已受理。
        // 注释帧以 ':' 开头，标准的 SSE 客户端与我们的 consumeSSE 都会跳过。
        controller.enqueue(encoder.encode(': connected\n\n'));

        // 之后每 10s 发一次心跳，避免中间层（Nginx / CDN / 反代）因长时间无数据断连。
        const heartbeat = setInterval(() => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(': keep-alive\n\n'));
          } catch {
            /* 流已关闭，忽略 */
          }
        }, 10_000);

        try {
          for await (const chunk of streamChat(config, messages)) {
            if (chunk.text) {
              send({ delta: { text: chunk.text } });
            }
            // reasoning 增量刻意不转发：前端没有「思考过程」的展示位，
            // 混进正文会让用户以为模型在自说自话。
            if (chunk.meta && (chunk.meta.usage || chunk.meta.finishReason)) {
              const meta: StreamMeta = chunk.meta;
              send({ meta });
            }
          }
          finish();
        } finally {
          clearInterval(heartbeat);
        }
      } catch (e) {
        const isAI = e instanceof AIError;
        const message = isAI
          ? e.message
          : e instanceof Error
            ? e.message
            : '未知错误';

        if (isAI) {
          console.error(`[ai/stream] 失败 status=${e.status}${e.detail ? ` detail=${e.detail}` : ''}：${e.message}`);
        } else {
          console.error('[ai/stream] 未预期异常：', e);
        }

        // 无论是否已吐出正文，都发同一帧：前端拿到 message 就展示，
        // 已有内容会保留在气泡里（用户看到「半截回答 + 错误原因」比空白更有用）。
        send({ error: { message, status: isAI ? e.status : 502 } });
        finish();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // 关掉 Nginx / CDN 缓冲，否则流式会变成「憋到最后一次性吐出来」
      'X-Accel-Buffering': 'no',
    },
  });
}
