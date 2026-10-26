/**
 * 回归测试 — SSE 客户端解析（2026-10-26）
 *
 * 起因：用户反馈 AI 回复「中间突然缺一段」。
 * 排查结论：三处前端消费者都按**网络分片**切行：
 *     const chunk = decoder.decode(value, { stream: true });
 *     for (const line of chunk.split('\n')) { ... JSON.parse(line) ... }
 * fetch 的 read() 边界与逻辑行边界无关，一个 `data: {...}` 常被切成两片，
 * 第一片是半截 JSON，JSON.parse 抛错后被 `catch {}` 静默跳过 —— 内容就消失了。
 *
 * 本测试把这一场景固化成断言：无论上游怎么切片，只要字节流正确，
 * 拼出来的正文必须与逐帧发送的内容完全一致。
 *
 * 跑: npx tsx scripts/regression/sse-client-parse.test.ts
 * 失败 exit 1
 *
 * 不引 vitest，沿用项目现有的 tsx + 自定义断言惯例。
 */
import { consumeSSE } from '../../lib/ai/sse-client';

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`);
  }
}

/** 用给定的分片序列构造一个 Response，模拟真实网络切片 */
function mockResponse(pieces: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const p of pieces) controller.enqueue(encoder.encode(p));
      controller.close();
    },
  });
  return new Response(stream, {
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

/** 把一帧 SSE 事件序列化成线上格式 */
function frame(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

async function runCase(name: string, pieces: string[], expected: string) {
  let text = '';
  const errors: string[] = [];
  await consumeSSE(mockResponse(pieces), {
    onDelta: d => {
      text += d;
    },
    onError: e => errors.push(e.message),
  });
  check(name, text === expected && errors.length === 0, `  实际="${text}"\n      期望="${expected}"\n      错误=${JSON.stringify(errors)}`);
}

async function main() {
  console.log('SSE 客户端解析回归测试');

  // ─── 场景 1：一切正常，每帧一个分片 ───────────────────────
  await runCase(
    '正常流：逐帧完整到达',
    [frame({ delta: { text: '紫微' } }), frame({ delta: { text: '坐命' } }), 'data: [DONE]\n\n'],
    '紫微坐命',
  );

  // ─── 场景 2：核心回归 —— JSON 被切成两片 ──────────────────
  // 这是用户实际遇到的 bug：半截 JSON 导致该帧被静默丢弃
  const one = frame({ delta: { text: '天机化禄' } });
  const cut = Math.floor(one.length / 2);
  await runCase(
    '跨分片：单帧 JSON 被拦腰截断',
    [one.slice(0, cut), one.slice(cut), 'data: [DONE]\n\n'],
    '天机化禄',
  );

  // ─── 场景 3：更极端 —— 逐字节到达 ─────────────────────────
  const full = [
    frame({ delta: { text: '太阳' } }),
    frame({ delta: { text: '太阴' } }),
    'data: [DONE]\n\n',
  ].join('');
  await runCase(
    '逐字节分片：每个字符一个分片',
    Array.from(full),
    '太阳太阴',
  );

  // ─── 场景 4：一帧被切成多段散落在多个分片 ─────────────────
  const f1 = frame({ delta: { text: '武曲' } });
  const f2 = frame({ delta: { text: '天相' } });
  const combined = f1 + f2 + 'data: [DONE]\n\n';
  await runCase(
    '混合分片：帧边界与分片边界完全错位',
    [combined.slice(0, 3), combined.slice(3, 20), combined.slice(20, 41), combined.slice(41)],
    '武曲天相',
  );

  // ─── 场景 5：CRLF 换行（部分中转站会发 \r\n）───────────────
  await runCase(
    'CRLF 行尾',
    [`data: ${JSON.stringify({ delta: { text: '文昌' } })}\r\n\r\n`, 'data: [DONE]\r\n\r\n'],
    '文昌',
  );

  // ─── 场景 6：空行与 SSE 注释心跳不应干扰 ──────────────────
  await runCase(
    '忽略注释心跳与空行',
    [
      ': keep-alive\n\n',
      frame({ delta: { text: '左辅' } }),
      ': ping\n\n',
      frame({ delta: { text: '右弼' } }),
      'data: [DONE]\n\n',
    ],
    '左辅右弼',
  );

  // ─── 场景 7：错误帧必须被识别（旧实现的第二个 bug）────────
  {
    let text = '';
    const errors: string[] = [];
    await consumeSSE(
      mockResponse([
        frame({ delta: { text: '已生成的部分' } }),
        frame({ error: { message: '余额不足', status: 402 } }),
        'data: [DONE]\n\n',
      ]),
      { onDelta: d => { text += d; }, onError: e => errors.push(e.message) },
    );
    check('错误帧被识别且保留已收正文',
      text === '已生成的部分' && errors[0] === '余额不足',
      `  正文="${text}" 错误=${JSON.stringify(errors)}`);
  }

  // ─── 场景 8：错误帧也被切成两片，仍须识别 ────────────────
  {
    const errFrame = frame({ error: { message: '限速中', status: 429 } });
    const c = Math.floor(errFrame.length / 2);
    const errors: string[] = [];
    await consumeSSE(
      mockResponse([errFrame.slice(0, c), errFrame.slice(c), 'data: [DONE]\n\n']),
      { onDelta: () => {}, onError: e => errors.push(e.message) },
    );
    check('跨分片的错误帧仍被识别', errors[0] === '限速中', `  错误=${JSON.stringify(errors)}`);
  }

  // ─── 场景 9：meta 帧不应被当成正文 ───────────────────────
  {
    let text = '';
    let gotMeta = false;
    await consumeSSE(
      mockResponse([
        frame({ delta: { text: '答案' } }),
        frame({ meta: { usage: { totalTokens: 9 }, finishReason: 'stop' } }),
        'data: [DONE]\n\n',
      ]),
      { onDelta: d => { text += d; }, onMeta: () => { gotMeta = true; } },
    );
    check('meta 帧不混入正文', text === '答案' && gotMeta, `  正文="${text}" gotMeta=${gotMeta}`);
  }

  // ─── 场景 10：正文含真实换行，序列化后不应破坏帧 ──────────
  {
    let text = '';
    await consumeSSE(
      mockResponse([
        frame({ delta: { text: '第一段\n第二段' } }),
        'data: [DONE]\n\n',
      ]),
      { onDelta: d => { text += d; } },
    );
    check('正文含换行符仍完整', text === '第一段\n第二段', `  实际="${JSON.stringify(text)}"`);
  }

  console.log('');
  if (failures > 0) {
    console.error(`✗ ${failures} 项失败`);
    process.exit(1);
  }
  console.log('✓ 全部通过');
}

main().catch(e => {
  console.error('测试本身抛错：', e);
  process.exit(1);
});
