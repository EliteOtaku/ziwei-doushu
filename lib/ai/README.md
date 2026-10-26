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

| 通道 | BASE_URL | MODEL |
|---|---|---|
| `deepseek` | `https://api.deepseek.com/v1` | `deepseek-flash` |
| `opendesign` | `https://amr-link.open-design.ai/v1` | `deepseek-v4.1-flash` |

新增通道不必改代码：`AI_PROVIDER=foo` + `FOO_API_KEY` / `FOO_BASE_URL` / `FOO_MODEL`。

### 调优变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `AI_MAX_TOKENS` | **不设** | 不设时不上送该字段，由上游按官方默认处理：非思考 8K、思考 64K（effort=max 时 128K）。显式设置上限 393216 |
| `AI_IDLE_TIMEOUT_MS` | 120000 | **空闲超时**：连续这么久收不到任何字节才中断，而非限制整条流总时长 |
| `AI_REASONING_EFFORT` | 不传 | `none` / `low` / `high` / `max`；别名 `minimal`→low、`medium`/`xhigh`→high、`ultra`→max。不传时用官方默认（`high`） |
| `AI_MAX_ATTEMPTS` | 3 | 429 / 500 / 503 的最大尝试次数（含首次） |
| `AI_RETRY_BASE_MS` | 1000 | 指数退避基准；有 `Retry-After` 时优先用它，上限 30s |
| `AI_INCLUDE_USAGE` | true | 上送 `stream_options.include_usage` 以获取 token 统计 |

## 与官方规范对齐的要点

1. **`reasoning_content` 与 `content` 是两个字段**。思考模式先连续吐 `reasoning_content`（思考过程），再吐 `content`（正式回答）。只取 `content`，否则前端会把"先想一遍"当答案显示。
2. **`max_tokens` 不传 ≠ 8K**。硬编码偏小值会让思考吃光预算、`content` 为空串。因此默认不设，只在显式配置时上送。
3. **必须检查 `finish_reason`**。`length` = 被长度上限截断；`insufficient_system_resource` = 推理资源不足中断。两者都属"回答不完整"，要明确告知用户而不是当成功返回。
4. **错误码语义**（[官方文档](https://api-docs.deepseek.com/zh-cn/quick_start/error_codes)）：400 格式错误 / 401 认证失败 / 402 余额不足 / 422 参数错误 / 429 速率上限 / 500 服务器故障 / 503 服务器繁忙。其中 **429 / 500 / 503 是瞬时错误**，应退避重试；其余重试无意义，直接报给用户。
5. **超时用空闲超时**。思考模式生成长文可能跑几分钟，固定总时长会误杀正常请求；"连续 N 秒无字节"才是挂死信号。
6. **`stream_options.include_usage`**：官方在最后一帧返回 usage，此时 `choices` 为空数组，不能因 `choices[0]` 不存在就跳过。

## 已修复的客户端缺陷

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
