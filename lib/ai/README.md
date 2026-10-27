# `lib/ai` —— AI 解读层

上游开源版把 `/api/interpret` 与 `/api/heming` 留空（线上是私有的）。这里按前端已约定的契约补齐，走 **OpenAI 兼容协议**，默认按 **DeepSeek 官方 API 规范**实现，同时兼容 OpenDesign、Azure、one-api、本地 Ollama / vLLM 等任何符合该协议的服务。

## 文件

| 文件 | 职责 |
|---|---|
| `config.ts` | 环境变量 → `AIConfig`；缺配置返回结构化原因而不抛异常 |
| `errors.ts` | `AIError`，带 HTTP 语义与上游原文，单独成文件避免循环引用 |
| `openai-compat.ts` | 流式客户端：SSE 解析、错误码映射、退避重试、空闲超时、截断检测、usage 统计 |
| `sse.ts` | **服务端**：把上游流包成前端约定的 `text/event-stream` |
| `sse-client.ts` | **浏览器端**：跨分片安全地解析 SSE，统一三处调用点 |
| `chart-context.ts` | `ZiweiChart` → 模型可读的结构化文本（十二宫、星曜、四化、大限、格局） |
| `prompts.ts` | 解读与合盘两套 system prompt（倪海厦《天纪》方法论 + 《紫微斗数全书》框架） |

路由：`app/api/interpret/route.ts`（多轮对话）、`app/api/heming/route.ts`（双人合盘）。

## SSE 帧协议（服务端与前端必须同步）

```
data: {"delta":{"text":"..."}}                         正文增量
data: {"error":{"message":"...","status":N}}           流内错误
data: {"meta":{"usage":{...},"finishReason":"stop"}}   结束元信息
data: [DONE]                                           结束哨兵
```

一旦写出第一个字节，HTTP 状态码就锁定 200，无法再回 5xx。因此**流中途的错误必须走 `error` 帧**。早期实现写成 `{"error":"文本"}` 而前端只读 `delta.text`，错误被静默吞掉、用户只看到空白气泡——现已改为嵌套结构并让前端识别。

## 配置

只认一套约定，没有预设的通道必须给齐三个变量：

```ini
AI_PROVIDER=deepseek           # 通道名
DEEPSEEK_API_KEY=sk-xxx        # <通道>_API_KEY
# DEEPSEEK_BASE_URL=...        # 有预设时可省
# DEEPSEEK_MODEL=...           # 有预设时可省
```

通用兜底：`AI_API_KEY` / `AI_BASE_URL` / `AI_MODEL`（配了就以它为准，不分通道）。

预设表见 `config.ts` 的 `PRESETS`：

| 通道 | BASE_URL | MODEL | 说明 |
|---|---|---|---|
| `deepseek` | `https://api.deepseek.com/v1` | `deepseek-flash` | 官方，需密钥 |
| `opendesign` | `https://amr-link.open-design.ai/v1` | `deepseek-v4.1-flash` | 需密钥 |
| `zcode` | `http://127.0.0.1:8081/v1` | `glm-5.3-flash` | 本地反代，**无需密钥**；协议差异见下 |

新增通道不必改代码：`AI_PROVIDER=foo` + `FOO_API_KEY` / `FOO_BASE_URL` / `FOO_MODEL`。

### 通道协议差异（zcode 实测，2026-10-27）

预设表不只存地址，还存**该通道的协议事实**——这些差异都会让「看起来正确」的代码失败：

| 事实 | 影响 | 处理位置 |
|---|---|---|
| 不接受 `role: 'system'`，返回 405 / `code 3012 unusual activity` | 报错完全不提 system，极难定位 | 所有通道统一折叠：`foldSystemIntoUser()` 把 system 并入首条 user，用 `---` 分隔 |
| 不需要 `Authorization` | 空 Bearer 可能被拒 | `apiKey` 为空时不下发该头 |
| `thinking:{type}` 不支持（400） | 不能用标准开关关思考 | 不上送该字段 |
| `reasoning_effort` 接受但不生效 | 无法关闭思考阶段 | 仍上送（无害），日志告警 |
| `max_tokens` 被忽略（设 8 也不截断） | 无法限制输出 | 仍上送（无害），日志告警 |
| 「分多段详细分析」类不封顶要求会**只思考不产出** | 90s 内正文 0 字 | 字数上限写进提示词（单人 450 / 合盘 650 字）|

最后一条最隐蔽：同一提示词加上「总长控制在 400 字以内」后，
90s 无输出 → 68s 完整回答（实测）。

### 调优变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `AI_MAX_TOKENS` | **不设** | 不设时不上送该字段，由上游按官方默认处理：非思考 8K、思考 64K（effort=max 时 128K）。显式设置上限 393216 |
| `AI_IDLE_TIMEOUT_MS` | 120000 | **空闲超时**：连续这么久收不到任何字节才中断，而非限制整条流总时长 |
| `AI_FIRST_CONTENT_TIMEOUT_MS` | 90000 | **首字正文超时**：从请求发出算起，这么久还没第一段正文就报错。思考型模型只吐 reasoning 时空闲计时器会被不断重置，必须靠这道闸兜住 |
| `AI_REASONING_EFFORT` | 不传 | `none` / `low` / `high` / `max`；别名 `minimal`→low、`medium`/`xhigh`→high、`ultra`→max。不传时用官方默认（`high`） |
| `AI_MAX_ATTEMPTS` | 3 | 429 / 500 / 503 的最大尝试次数（含首次） |
| `AI_RETRY_BASE_MS` | 1000 | 指数退避基准；有 `Retry-After` 时优先用它，上限 30s |
| `AI_INCLUDE_USAGE` | true | 上送 `stream_options.include_usage` 以获取 token 统计 |

## 体系口径：只用生年四化，不用大限四化与宫干自化

三条独立证据一致，2026-10-27 定案：

1. `lib/ziwei/patterns.ts` 第 6 行：「倪师立场：不使用宫干自化、大限四化、来因宫等飞星派工具」
2. `lib/classics/data/quanshu.ts` 四化论：「生年四化为本命四化，永远固定；倪师强调四化星不动，
   只看大限流年走到何处。北派飞星派之自化、宫干飞化、来因宫等，倪师不主张使用。」
3. `docs/tianji-ziwei` 1849 条原话统计：宫干 / 自化 / 飞星 / 飞化 / 来因宫 / 大限四化 出现次数均为 0；
   「四化」仅 5 次，全部指科权禄忌。

落到代码：

- `chart-context.ts` **不再输出** `宫干自化`，也**不再输出** `大限四化` 与该宫天干；
  大限段落只保留「X-Y 岁，行【某宫】」。排盘层仍计算这些字段（命盘看板要用），只是 AI 上下文不携带。
- 提示词明确要求：论大限只看「大限走到哪一宫、那一宫本有什么星」，并显式禁止上述飞星派工具。
- 若日后要改用大限四化，必须同时改这三处，不能只翻提示词。

## 与官方规范对齐的要点

1. **`reasoning_content` 与 `content` 是两个字段**。思考模式先连续吐 `reasoning_content`（思考过程），再吐 `content`（正式回答）。只取 `content`，否则前端会把"先想一遍"当答案显示。
2. **`max_tokens` 不传 ≠ 8K**。硬编码偏小值会让思考吃光预算、`content` 为空串。因此默认不设，只在显式配置时上送。
3. **必须检查 `finish_reason`**。`length` = 被长度上限截断；`insufficient_system_resource` = 推理资源不足中断。两者都属"回答不完整"，要明确告知用户而不是当成功返回。
4. **错误码语义**（[官方文档](https://api-docs.deepseek.com/zh-cn/quick_start/error_codes)）：400 格式错误 / 401 认证失败 / 402 余额不足 / 422 参数错误 / 429 速率上限 / 500 服务器故障 / 503 服务器繁忙。其中 **429 / 500 / 503 是瞬时错误**，应退避重试；其余重试无意义，直接报给用户。
5. **超时用空闲超时**。思考模式生成长文可能跑几分钟，固定总时长会误杀正常请求；"连续 N 秒无字节"才是挂死信号。
6. **`stream_options.include_usage`**：官方在最后一帧返回 usage，此时 `choices` 为空数组，不能因 `choices[0]` 不存在就跳过。
7. **首个正文 token 之前必须冲刷响应头**。ReadableStream 要等到第一次 enqueue 才发 headers；思考型模型可能 30s+ 才吐第一个正文 token，不先发一帧 SSE 注释，浏览器会一直停在「等响应头」，表现为「点了没反应」。

## 已修复的缺陷

**服务端：首字之前零字节**

`streamAIResponse` 早期只在拿到 `chunk.text` 时才 enqueue。思考型模型先连吐几十秒 `reasoning_content`，这期间：
- 响应头未发出 → 浏览器 fetch 停在 pending，UI 显示「生成中…」毫无进展
- 空闲超时被 reasoning 帧不断重置 → 永不触发

现于流启动时立即下发 `: connected` 注释帧，并每 10s 发一次心跳；同时新增 `AI_FIRST_CONTENT_TIMEOUT_MS` 独立闸门，到点给出可操作错误而非无限等待。

**客户端：按网络分片切行**

原先 `ChatPanel`、`InsightPanel`、`heming/page` 三处各自内联同一段解析：

```ts
const chunk = decoder.decode(value, { stream: true });
for (const line of chunk.split('\n')) { ... JSON.parse ... }
```

两个 bug：

- **按网络分片切行**：`read()` 的边界与逻辑行边界无关，一个 `data: {...}` 常被切成两片，第一片是半截 JSON，`JSON.parse` 抛错后被 `catch {}` 静默跳过——表现就是"回复中间突然缺一段"。正确做法是维护跨分片 buffer，只在 `\n` 处切行。
- **错误帧被吞**：旧代码只读 `parsed.delta.text`，服务端的错误帧变成空串，用户看到空白气泡。

现已收敛到 `sse-client.ts` 的 `consumeSSE()`，三处调用点共用。

## 排查

服务端会打印结构化原因（不含密钥）：

- `503 {"error":"AI 服务未配置","detail":"未配置 DEEPSEEK_API_KEY..."}` —— 密钥没读到
- `[ai/stream] 失败 status=401 detail=...` —— 密钥错误或失效
- `[ai/stream] 失败 status=402` —— 余额不足
- 流内 `error` 帧带具体 message —— 上游中途失败或回答被截断

快速确认路由存活：

```bash
curl -s -X POST http://localhost:3000/api/interpret \
  -H 'Content-Type: application/json' \
  -d '{"chart":null,"messages":[{"role":"user","content":"hi"}]}'
# 预期 400（chart 校验先拦下），说明路由活着
```
