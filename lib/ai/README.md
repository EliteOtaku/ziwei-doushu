# `lib/ai` —— AI 解读层

上游开源版把 `/api/interpret` 与 `/api/heming` 留空（线上是私有的）。这里按前端已经约定的契约补齐了一版，走 **OpenAI 兼容协议**，所以 DeepSeek 官方、OpenDesign、Azure、one-api、本地 Ollama / vLLM 都能直接接。

## 文件

| 文件 | 职责 |
|---|---|
| `config.ts` | 从环境变量解析通道配置；缺配置时返回结构化原因而不是抛异常 |
| `openai-compat.ts` | 把上游 SSE 解析成前端要的帧格式，含超时与错误映射 |
| `chart-context.ts` | `ZiweiChart` 对象 → 模型可读的结构化文本（十二宫、星曜、四化、大限、格局） |
| `prompts.ts` | 解读与合盘两套 system prompt（倪海厦《天纪》方法论 + 《紫微斗数全书》框架） |
| `sse.ts` | `text/event-stream` 响应封装与错误 JSON |

路由在 `app/api/interpret/route.ts`（多轮对话）和 `app/api/heming/route.ts`（双人合盘）。

## 配置

只认一套约定，没有预设的通道必须给齐三个变量：

```ini
AI_PROVIDER=deepseek           # 通道名
DEEPSEEK_API_KEY=sk-xxx        # <通道>_API_KEY
# DEEPSEEK_BASE_URL=...        # 有预设时可省
# DEEPSEEK_MODEL=...           # 有预设时可省
```

通用兜底：`AI_API_KEY` / `AI_BASE_URL` / `AI_MODEL`（配了就以它为准，不分通道）。

预设表在 `config.ts:31`：

| 通道 | BASE_URL | MODEL |
|---|---|---|
| `deepseek` | `https://api.deepseek.com/v1` | `deepseek-flash` |
| `opendesign` | `https://amr-link.open-design.ai/v1` | `deepseek-v4.1-flash` |

新增通道不必改代码，`AI_PROVIDER=foo` + `FOO_API_KEY` / `FOO_BASE_URL` / `FOO_MODEL` 即可。

### 调优变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `AI_MAX_TOKENS` | 8000 | **推理模型必须先花一部分做思考**，给小了会出现"流正常结束但没内容"。遇到空回复优先调大这个 |
| `AI_TIMEOUT_MS` | 180000 | 整条流的最长存活时间 |
| `AI_REASONING_EFFORT` | 不传 | OpenDesign 端点只认 `reasoning_effort`，**不认** `thinking:{type:disabled}`。设 `none` 可省约九成 token |

## 已知约束

- **`reasoning_effort` 必须显式设 `none`**（若用的是支持该字段的端点）：命理解读这类任务加思考几乎零收益。实测同类抽取任务默认/`none`/`low`/`high` 质量都是满分，但 completion token 是 2412 / 256 / 1534 / 2024。
- **单次回复预算要留够**：`deepseek-v4.1-flash` 这类 `always_reasoning: true` 的模型，`max_tokens` 太小会让推理吃光预算、返回空字符串。默认 8000 是留了余量的值。
- **不要用 `AI_REASONING_EFFORT=high` 配小 `max_tokens`**，两者叠加最容易触发空回复。

## 排查

服务端日志会打印结构化原因：

- `503 {"error":"AI 服务未配置","detail":"未配置 DEEPSEEK_API_KEY（或 AI_API_KEY）。..."}` —— 密钥没读到
- `200` + `data: {"error":"无法连接 AI 服务：fetch failed"}` —— 密钥读到了但地址不通（DNS / 代理 / 端口）
- 流正常结束但前端没文字 —— `AI_MAX_TOKENS` 给小了

快速查配置是否生效：

```bash
curl -s -X POST http://localhost:3000/api/interpret \
  -H 'Content-Type: application/json' \
  -d '{"chart":null,"messages":[{"role":"user","content":"hi"}]}'
# 预期 400（chart 校验先拦下），说明路由活着
```
