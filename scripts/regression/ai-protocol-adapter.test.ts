/**
 * 回归测试 — AI 通道协议适配（2026-10-27）
 *
 * 起因：本地 Zcode 反代的 GLM 通道对含 `role: 'system'` 的请求直接返回
 *   405 / code 3012 "request has been blocked due to unusual activity"
 * 报错信息完全不提 system，从表象极难定位。而本项目所有 prompt 都以
 * system 角色下发，于是整条 AI 解读链路在这个通道上全部失败。
 *
 * 本测试把三条协议差异固化成断言：
 *   1. supportsSystemRole=false 时，system 必须被折叠进第一条 user 消息，
 *      且内容不能丢（丢了会让回答风格跑偏）
 *   2. supportsSystemRole=true 时，system 必须原样保留
 *   3. apiKey 为空时不得下发 Authorization 头
 *
 * 跑: npx tsx scripts/regression/ai-protocol-adapter.test.ts
 * 失败 exit 1
 *
 * 不引 vitest，沿用项目现有的 tsx + 自定义断言惯例。
 */
import { streamChat } from '../../lib/ai/openai-compat';
import { resolveAIConfig, type AIConfig } from '../../lib/ai/config';

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`);
  }
}

/** 构造一个最小可用的 SSE 响应 */
function sseResponse(frames: unknown[]): Response {
  const encoder = new TextEncoder();
  const body = frames.map(f => `data: ${JSON.stringify(f)}\n\n`).join('') + 'data: [DONE]\n\n';
  return new Response(
    new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(encoder.encode(body));
        c.close();
      },
    }),
    { headers: { 'Content-Type': 'text/event-stream' } },
  );
}

interface Captured {
  body?: Record<string, unknown>;
  headers?: Record<string, string>;
}

/** 拦截全局 fetch，记录实际发出去的请求体与头部 */
async function withMockFetch<T>(fn: () => Promise<T>): Promise<{ result: T; captured: Captured }> {
  const captured: Captured = {};
  const original = globalThis.fetch;

  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    captured.body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    // HeadersInit 可能是多种形态，统一转成普通对象
    const h = (init?.headers ?? {}) as Record<string, string>;
    captured.headers = h;
    return sseResponse([
      { choices: [{ delta: { content: '好的' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ]);
  }) as typeof fetch;

  try {
    const result = await fn();
    return { result, captured };
  } finally {
    globalThis.fetch = original;
  }
}

function baseConfig(over: Partial<AIConfig> = {}): AIConfig {
  return {
    provider: 'test',
    baseUrl: 'http://127.0.0.1:1/v1',
    apiKey: 'test-key',
    model: 'test-model',
    idleTimeoutMs: 5000,
    firstContentTimeoutMs: 5000,
    maxAttempts: 1,
    retryBaseMs: 10,
    includeUsage: false,
    supportsSystemRole: true,
    ...over,
  };
}

async function drain(config: AIConfig, messages: Parameters<typeof streamChat>[1]) {
  let text = '';
  for await (const chunk of streamChat(config, messages)) {
    if (chunk.text) text += chunk.text;
  }
  return text;
}

const SYSTEM = '你是紫微斗数命理师。\n## 表达要求\n用简体中文，不用表格。';
const USER = '请分析我的命宫主星特点。';

async function main() {
  console.log('AI 通道协议适配回归测试');

  // ─── 1. 不支持 system role：必须折叠进第一条 user ──────────────
  {
    const { result, captured } = await withMockFetch(() =>
      drain(baseConfig({ supportsSystemRole: false }), [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: USER },
      ]),
    );
    const msgs = (captured.body?.messages ?? []) as { role: string; content: string }[];

    check('不支持 system 时，messages 中不再含 system 角色',
      msgs.every(m => m.role !== 'system'),
      `  实际角色：${msgs.map(m => m.role).join(',')}`);

    check('system 内容被折叠进第一条 user（内容不丢）',
      msgs[0]?.role === 'user' && msgs[0].content.includes('紫微斗数命理师') && msgs[0].content.includes(USER),
      `  实际内容：${JSON.stringify(msgs[0]?.content?.slice(0, 80))}`);

    check('消息条数从 2 合并为 1', msgs.length === 1, `  实际 ${msgs.length} 条`);

    check('仍能正常收到正文', result === '好的', `  实际=${JSON.stringify(result)}`);
  }

  // ─── 2. 支持 system role：必须原样保留 ────────────────────────
  {
    const { captured } = await withMockFetch(() =>
      drain(baseConfig({ supportsSystemRole: true }), [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: USER },
      ]),
    );
    const msgs = (captured.body?.messages ?? []) as { role: string; content: string }[];

    check('支持 system 时角色与顺序原样保留',
      msgs.length === 2 && msgs[0].role === 'system' && msgs[1].role === 'user',
      `  实际：${msgs.map(m => m.role).join(',')}`);

    check('支持 system 时内容未被改写',
      msgs[0]?.content === SYSTEM,
      `  实际：${JSON.stringify(msgs[0]?.content?.slice(0, 40))}`);
  }

  // ─── 3. 多轮对话：折叠只影响 system，历史顺序不变 ──────────────
  {
    const { captured } = await withMockFetch(() =>
      drain(baseConfig({ supportsSystemRole: false }), [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: '第一问' },
        { role: 'assistant', content: '第一答' },
        { role: 'user', content: '第二问' },
      ]),
    );
    const msgs = (captured.body?.messages ?? []) as { role: string; content: string }[];

    check('折叠后仍保留完整轮次（4 条 → 3 条）',
      msgs.length === 3,
      `  实际 ${msgs.length} 条：${msgs.map(m => m.role).join(',')}`);

    check('轮次顺序正确且仅首条 user 被注入 system',
      msgs[0]?.role === 'user' && msgs[0].content.includes('第一问') && msgs[0].content.includes('命理师') &&
      msgs[1]?.role === 'assistant' &&
      msgs[2]?.role === 'user' && !msgs[2].content.includes('命理师'),
      `  实际：${msgs.map(m => `${m.role}:${m.content.slice(0, 12)}`).join(' | ')}`);
  }

  // ─── 4. apiKey 为空时不下发 Authorization ────────────────────
  {
    const { captured } = await withMockFetch(() =>
      drain(baseConfig({ apiKey: '', supportsSystemRole: false }), [{ role: 'user', content: 'hi' }]),
    );
    check('空密钥时不下发 Authorization 头',
      !captured.headers || !('Authorization' in captured.headers),
      `  实际头部：${JSON.stringify(captured.headers)}`);
  }

  // ─── 5. apiKey 存在时必须下发 ────────────────────────────────
  {
    const { captured } = await withMockFetch(() =>
      drain(baseConfig({ apiKey: 'sk-abc' }), [{ role: 'user', content: 'hi' }]),
    );
    check('有密钥时正常下发 Bearer',
      captured.headers?.Authorization === 'Bearer sk-abc',
      `  实际：${JSON.stringify(captured.headers?.Authorization)}`);
  }

  // ─── 6. 配置解析：免鉴权通道允许空密钥 ──────────────────────
  // 这里曾写成 `if (!apiKey && !preset.requiresApiKey) return 错误`，
  // 把「不需要密钥」判断反了，导致 zcode 通道始终报「未配置 ZCODE_API_KEY」。
  {
    const saved = { ...process.env };
    const setEnv = (obj: Record<string, string | undefined>) => {
      for (const k of Object.keys(obj)) {
        if (obj[k] === undefined) delete process.env[k];
        else process.env[k] = obj[k] as string;
      }
    };

    setEnv({ AI_PROVIDER: 'zcode', ZCODE_API_KEY: undefined, AI_API_KEY: undefined });
    const r1 = resolveAIConfig();
    check('zcode 通道无密钥也应解析成功',
      r1.ok === true,
      r1.ok ? '' : `  实际失败原因：${r1.reason}`);
    check('zcode 通道被标记为不支持 system role',
      r1.ok === true && r1.config.supportsSystemRole === false,
      r1.ok ? `  实际 ${r1.config.supportsSystemRole}` : '');
    check('zcode 通道使用本地默认地址与 GLM 模型',
      r1.ok === true && r1.config.baseUrl === 'http://127.0.0.1:8081/v1' && r1.config.model === 'glm-5.3-flash',
      r1.ok ? `  实际 ${r1.config.baseUrl} / ${r1.config.model}` : '');

    // 对照：官方通道缺密钥必须报错
    setEnv({ AI_PROVIDER: 'deepseek', DEEPSEEK_API_KEY: undefined, AI_API_KEY: undefined });
    const r2 = resolveAIConfig();
    check('deepseek 通道缺密钥应解析失败', r2.ok === false, r2.ok ? '  实际却成功了' : '');

    // 恢复环境，避免影响后续用例
    setEnv(saved);
  }

  // ─── 7. 只吐思考不吐正文：必须在首字超时后报错，不能无限等 ──────
  // 实测本地 GLM 通道遇到复杂结构化提问时会持续输出 reasoning_content
  // 却始终不产出 content。此时空闲计时器被不断重置，客户端会空转数分钟。
  {
    const original = globalThis.fetch;
    // 定时器必须在流被取消时清掉，否则测试进程会一直挂住不退出
    let ticker: ReturnType<typeof setInterval> | undefined;
    globalThis.fetch = (async () => {
      const enc = new TextEncoder();
      return new Response(
        new ReadableStream<Uint8Array>({
          start(c) {
            ticker = setInterval(() => {
              try {
                c.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: '思考中…' } }] })}\n\n`));
              } catch {
                if (ticker) clearInterval(ticker);
              }
            }, 50);
          },
          cancel() {
            if (ticker) clearInterval(ticker);
          },
        }),
        { headers: { 'Content-Type': 'text/event-stream' } },
      );
    }) as typeof fetch;

    let caught: unknown = null;
    const t0 = Date.now();
    try {
      // 首字超时设 300ms，避免测试拖长
      await drain(baseConfig({ firstContentTimeoutMs: 300, idleTimeoutMs: 30_000 }), [
        { role: 'user', content: '复杂问题' },
      ]);
    } catch (e) {
      caught = e;
    } finally {
      if (ticker) clearInterval(ticker);
      globalThis.fetch = original;
    }

    const msg = caught instanceof Error ? caught.message : '';
    check('只吐思考时会因首字超时中断（而非无限等待）',
      caught !== null && msg.includes('仍未输出正文'),
      `  实际抛出：${msg || '(没有抛错)'}`);
    check('中断发生在首字超时附近（未拖到空闲超时）',
      Date.now() - t0 < 5000,
      `  实际耗时 ${Date.now() - t0}ms`);
  }

  // ─── 8. 通道级输出约束应追加到末条 user 消息末尾 ────────────
  {
    const HINT = '回答要求：总长控制在 400 字以内。';
    const { captured } = await withMockFetch(() =>
      drain(baseConfig({ supportsSystemRole: false, outputHint: HINT }), [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: '第一问' },
        { role: 'assistant', content: '第一答' },
        { role: 'user', content: '第二问' },
      ]),
    );
    const msgs = (captured.body?.messages ?? []) as { role: string; content: string }[];

    check('输出约束只追加到末条 user 消息',
      msgs[msgs.length - 1]?.content.includes(HINT) && msgs[msgs.length - 1].content.includes('第二问'),
      `  末条内容：${JSON.stringify(msgs[msgs.length - 1]?.content?.slice(-60))}`);

    check('输出约束不会污染更早的消息',
      !msgs[0].content.includes(HINT) && msgs[1]?.content === '第一答',
      `  首条含 HINT=${msgs[0].content.includes(HINT)}`);
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
