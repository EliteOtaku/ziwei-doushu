/**
 * lib/ai/sse-client —— 浏览器端：把 /api/* 的 SSE 流读完并回调增量
 *
 * 为什么需要这个文件（修复一个真实缺陷）：
 *   原先三个消费者（ChatPanel、InsightPanel、heming/page）各自内联了同一段解析：
 *
 *       const chunk = decoder.decode(value, { stream: true });
 *       for (const line of chunk.split('\n')) { ... JSON.parse(data) ... }
 *
 *   这段逻辑有两个问题：
 *
 *   1. **按网络分片切行**。fetch 的 read() 边界与逻辑行边界无关，
 *      一个 `data: {...}` 很可能被切成两片，第一片是半截 JSON。
 *      JSON.parse 抛错后被 catch 静默跳过 —— 用户看到的就是「回复中间突然缺一段」。
 *      正确做法是维护跨分片的 buffer，只在遇到 \n 时才切出一整行。
 *
 *   2. **错误帧被吞掉**。服务端在流中途出错时会发 `{"error":{"message":...}}`，
 *      而旧代码只读 `parsed.delta.text`，于是错误变成了空字符串，
 *      前端显示一个空白气泡，用户完全不知道发生了什么。
 *
 *   这里把两者一并修掉，并统一三处调用点，避免同类 bug 再各写一遍。
 */

/** 服务端流内错误帧的形状 */
export interface StreamErrorPayload {
  message: string;
  status?: number;
}

export interface ConsumeOptions {
  /** 收到正文增量时回调（累积由调用方负责，便于它直接 setState） */
  onDelta: (text: string) => void;
  /** 流内错误。调用方应展示它，并保留已收到的正文 */
  onError?: (err: StreamErrorPayload) => void;
  /** 结束元信息（token 用量、finish_reason），可选 */
  onMeta?: (meta: unknown) => void;
  /** 外部取消信号 */
  signal?: AbortSignal;
}

/**
 * 读取 SSE 流直到 [DONE] 或流结束。
 *
 * 不抛异常：所有失败都通过 onError 传递，调用方无需再包 try/catch
 * （但网络级失败仍会 reject，因为此时 onError 的语义不适用）。
 */
export async function consumeSSE(
  response: Response,
  opts: ConsumeOptions,
): Promise<void> {
  if (!response.body) {
    opts.onError?.({ message: '服务端未返回响应流' });
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let sawError = false;
  let done = false;

  try {
    while (!done) {
      const { done: streamDone, value } = await reader.read();
      if (streamDone) break;

      buffer += decoder.decode(value, { stream: true });

      // 关键：只在 \n 处切行，残片留到下一轮。绝不能按分片边界切。
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).replace(/\r$/, '');
        buffer = buffer.slice(nl + 1);

        if (!line || line.startsWith(':')) continue;
        if (!line.startsWith('data:')) continue;

        const payload = line.slice(5).trim();
        if (payload === '[DONE]') {
          done = true;
          break;
        }
        if (!payload) continue;

        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(payload) as Record<string, unknown>;
        } catch {
          // 到这里还 parse 失败，说明上游本身发了坏帧，跳过即可（不再静默丢正文）
          continue;
        }

        // 错误帧：服务端用嵌套结构，兼容个别中转站的平铺写法
        const errObj = parsed.error as { message?: unknown; status?: unknown } | string | undefined;
        if (errObj !== undefined) {
          sawError = true;
          const message =
            typeof errObj === 'string'
              ? errObj
              : typeof errObj.message === 'string'
                ? errObj.message
                : 'AI 服务返回错误';
          const status =
            typeof errObj === 'object' && typeof errObj.status === 'number'
              ? errObj.status
              : undefined;
          opts.onError?.({ message, ...(status !== undefined ? { status } : {}) });
          done = true;
          break;
        }

        const delta = parsed.delta as { text?: unknown } | undefined;
        if (delta && typeof delta.text === 'string' && delta.text) {
          opts.onDelta(delta.text);
        }

        if (parsed.meta) {
          opts.onMeta?.(parsed.meta);
        }
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* 已释放 */
    }
  }

  // 流结束但没有 [DONE] 也没有错误：说明连接被上游掐断，属异常
  if (!done && !sawError && buffer.trim()) {
    opts.onError?.({ message: '连接意外中断，回答可能不完整，请重试' });
  }
}

/**
 * 从失败响应里读取 JSON 错误体。
 * 用于 fetch 后 response.ok === false 的情况（此时还没进入 SSE）。
 */
export async function readErrorResponse(res: Response): Promise<StreamErrorPayload> {
  try {
    const text = await res.text();
    if (text) {
      try {
        const j = JSON.parse(text) as { error?: unknown; detail?: unknown };
        const base = typeof j.error === 'string' ? j.error : `请求失败（HTTP ${res.status}）`;
        return {
          message: typeof j.detail === 'string' && j.detail ? `${base}：${j.detail}` : base,
          status: res.status,
        };
      } catch {
        return { message: text.slice(0, 300), status: res.status };
      }
    }
  } catch {
    /* 读不到就退回状态码 */
  }

  if (res.status === 503) {
    return { message: 'AI 服务未配置，请在 .env.local 中填写密钥后重启服务', status: 503 };
  }
  return { message: `请求失败（HTTP ${res.status}）`, status: res.status };
}
