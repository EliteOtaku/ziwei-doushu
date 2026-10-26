# AI 解读能力增强方案

> 本文档供 AI 编码 Agent（如 Gemini Argon）阅读并执行。
> 每个任务都给了文件路径、做法、验收标准和验证命令，可独立认领。
> 文中所有「实测」数据均来自 2026-10-26 ~ 10-27 的真实调试记录，不是估算。

---

## 一、背景与目标

**项目**：`https://github.com/EliteOtaku/ziwei-doushu`（上游 `Renhuai123/ziwei-doushu` 的 fork）
**本地路径**：`D:/AI/ziwei-doushu`
**分支**：`main`，当前 HEAD `23c853a`

这是一个倪海厦体系紫微斗数排盘系统。上游开源了排盘引擎、古籍原文、格局规则库，但**故意不含 AI 解读后端**（`app/api/` 为空，`lib/ziwei/db-analysis.ts` 是空壳）。

**使用场景已明确**：个人自用、非商用。使用者学过一些周易，目的是**评估这套系统解读的成色**。

这个场景决定了优先级：

- **准确性、可核验性 >> 速度、产品功能**
- 商业化相关的（用户系统、支付、防刷）一律不做
- 语料是 CC BY-NC-SA（禁止商用），自用可以直接使用

---

## 二、运行环境

```bash
cd D:/AI/ziwei-doushu
npm run typecheck        # tsc --noEmit
npm test                 # 11 个回归测试，全部应通过
npm run build            # next build
npx pm2 restart ziwei-doushu   # 生产服务，端口 3000
```

服务由 pm2 托管，配置见 `ecosystem.config.js`（**必须 `args: 'start'`，缺了会退化成 dev 模式导致所有按钮失灵**，这是踩过的坑）。

日志：`logs/ziwei-out.log`、`logs/ziwei-error.log`

---

## 三、已完成的部分（不要重复做）

### 3.1 AI 后端（全部为新增，上游没有）

| 文件 | 行数 | 职责 |
|---|---|---|
| `lib/ai/config.ts` | 239 | 环境变量 → `AIConfig`；含通道预设与协议差异标记 |
| `lib/ai/errors.ts` | 22 | `AIError(message, status, detail)` |
| `lib/ai/openai-compat.ts` | 428 | 流式客户端：SSE 解析、错误码映射、退避重试、空闲超时、首字超时、usage |
| `lib/ai/prompts.ts` | 82 | 解读/合盘 system prompt |
| `lib/ai/chart-context.ts` | 142 | `ZiweiChart` → 模型可读文本 |
| `lib/ai/sse.ts` | 128 | 服务端 SSE 封装（含立即冲刷响应头 + 心跳） |
| `lib/ai/sse-client.ts` | 163 | 浏览器端跨分片安全解析 |
| `app/api/interpret/route.ts` | 90 | 多轮对话接口 |
| `app/api/heming/route.ts` | 77 | 双人合盘接口 |

测试：`scripts/regression/sse-client-parse.test.ts`（10 项）、`ai-protocol-adapter.test.ts`（16 项），已并入 `npm test`。

### 3.2 前端改动

- `components/InsightPanel.tsx`：等待首字期间显示「AI 正在思考并撰写… 已 N 秒」
- `components/ChatPanel.tsx`：**死代码，未被任何页面引用**（`/chart` 用 `InsightPanel`，合盘页自己实现了一份）
- `app/chart/page.tsx`：起盘前文案说明 AI 面板位置
- `app/heming/page.tsx`：错误原因具体化

### 3.3 当前通道

`.env.local`（已被 gitignore，不在仓库里）：

```ini
AI_PROVIDER=zcode                 # 本地 Zcode 反代的智谱 GLM-5.3-Flash，无需密钥
AI_IDLE_TIMEOUT_MS=180000
AI_FIRST_CONTENT_TIMEOUT_MS=120000
```

预设定义在 `lib/ai/config.ts` 的 `PRESETS`。

---

## 四、关键实测数据（决策依据）

### 4.1 各通道行为差异

| 事实 | 数据 | 来源 |
|---|---|---|
| GLM 通道**不支持** `role:'system'` | 返回 405 / code 3012「unusual activity」，报错不提 system | 实测 |
| GLM 通道**忽略** `max_tokens` | 设 8 也不截断 | 实测 |
| GLM 通道 `reasoning_effort` 接受但**不生效** | 无法关闭思考 | 实测 |
| GLM 通道 `thinking:{type}` **不支持** | 返回 400 | 实测 |
| GLM 通道对「不封顶的长输出要求」只思考不产出 | 同提示词：90s 内正文 0 字；追加「总长 400 字内」→ 68s 出 429 字 | 实测 |
| GLM 通道并发 | 3 并发 5.3 秒全部完成（**可并发**） | 实测 |
| GLM 通道响应耗时 | 简单问答 10–15s；五段式解读 25–90s | 实测 6 个话题 |
| DeepSeek 官方 `reasoning_effort=none` | 可真正关闭思考，10s 级出字 | 实测（需密钥） |

### 4.2 输出质量现状（这是要改的重点）

问「引用倪海厦原话说明命宫七杀性格」时，模型的真实反应：

> 您的命宫在己丑，坐的是太阳不化禄、太阴庙化科，即「日月同宫」格，并非七杀……
> **我不能虚构倪师原话引用**，也无法替不存在的星曜论断。

核对结论：模型**读盘正确**（命宫确实在丑），**也拒绝编造**。这是好事。

但结论同样明确：**它手里一条原话都没有，所以永远引不出真原话。**

注入原话后再测（RAG 预演）：prompt 1339 字（含 8 条原话 697 字）→ 35.9s 出 345 字正文，技术上可行。**但即使明确要求「只能引用以下材料」，模型仍输出了一条语料中查不到的引文**。→ 必须加引文校验。

### 4.3 语料规格（`docs/tianji-ziwei/`）

- 18 个 markdown 文件，2.1 MB，**1849 条**倪师原话
- **100% 带结构化标签**，格式：

```
- [00:00:32](https://www.bilibili.com/video/BV1KJsLekEfA?p=19&t=32) 「我们又名叫做英星入庙迁移，英星入庙成格迁移」　<sub>格局 › 一、必定成格（吉格） · 将星得地</sub>
```

- 一级标签分布：方法论 673 / 主星 378 / 十二宫 366 / 四化 174 / 格局 127 / 疾厄 80 / 占断 24 / 堪舆 19 / 易理总纲 7
- 每条带**逐秒视频链接**，可直接溯源

---

## 五、任务清单

### P0-1 原话检索增强（RAG）

**目标**：让 AI 能引用倪师真实原话，而不是泛泛而谈。

**步骤**

1. **建索引**：新增 `scripts/build-quotes-index.ts`，解析 `docs/tianji-ziwei/*.md`，输出 `lib/ai/quotes-index.ts`（或 `public/` 下的 JSON）。

   解析正则参考（已实测可用，解析出 1849 条）：

   ```ts
   /^- \[(\d\d:\d\d:\d\d)\]\((\S+?)\)\s*「(.+?)」\s*(?:<sub>(.+?)<\/sub>)?/
   ```

   字段：`{ file, ts, url, quote, tags, tagL1, tagL2, tagL3 }`

2. **召回**：新增 `lib/ai/recall.ts`。输入 `ZiweiChart`，按命盘特征打分召回 top-N（建议 N=6~8）：
   - 命宫主星名（如「七杀」「太阳」）→ 匹配 `主星#` 标签
   - 各宫主星 + 宫位名 → 匹配 `十二宫#` 标签
   - `detectPatterns()` 命中的格局名 → 匹配 `格局#` 标签
   - 生年四化星 → 匹配 `四化#` 标签
   - 未命中时回退到 `方法论#`

   要求：**召回结果必须去重、按分值排序、总字数控制在 800 字以内**（注入过长会让该通道变慢甚至不出字）。

3. **注入**：改 `lib/ai/prompts.ts`，在 system prompt 里追加一段：

   ```
   ## 可引用的倪师原话（只能引用以下材料，逐字为准，不得改写或编造）
   [1] [10上 00:00:32] 「……」（格局 › 将星得地）
   ...
   若上述材料未覆盖你要讲的点，直接用自己的话论述，不要伪造引文。
   ```

   同时**移除** `components/InsightPanel.tsx` 里 TOPIC_PROMPTS 中「引用倪海厦原话或观点」这类要求（现在它是在逼模型编造），改为「如有材料请引用」。

4. **暴露到接口返回值**：让 `/api/interpret` 在流结束时通过 `meta` 帧带上本次召回的引文列表，供前端展示「参考来源」。

**验收**
- 同一命盘同一问题，输出中出现 `「…」` 引文时，该引文**能在 `docs/tianji-ziwei/` 里逐字找到**
- prompt 总长度不超过 2500 字
- GLM 通道下仍能出正文（不能因变长而退化成「只思考不产出」）

**验证命令**

```bash
npx tsx scripts/verify-citations.ts   # 需新建：随机 10 个命盘，检查引文可溯源率
```

---

### P0-2 引文校验（强制门，与 P0-1 一起做）

**目标**：杜绝伪造引文。这是上游作者花大量精力清理过的问题，不能开倒车。

**做法**：新增 `lib/ai/citation-check.ts`，在 `lib/ai/sse.ts` 输出前做后置过滤。

- 检测正文中的 `「…」` 片段（长度 ≥ 4 字）
- 与**本次注入的召回材料**做包含匹配（前 12 字精确匹配即可）
- 未命中处理：剥掉引号改为普通叙述，或替换为 `（引文未在校验语料中）`
- 命中时可在 meta 帧里带上 `episode/ts/url`，前端做成可点击跳 B 站

**验收**
- 构造一个「必定诱发编造」的提问（如要求引用某星在某宫的冷门原话），输出的引文要么可溯源、要么已被剥离
- 不能误伤正常正文内容

---

### P1-1 接入 OpenDesign（等额度恢复）

**背景**：使用者的 OpenDesign 订阅额度每晚恢复，需要切换过去做对比。

**做法**：无需改代码，`lib/ai/config.ts` 已有预设：

```ini
AI_PROVIDER=opendesign
OPENDESIGN_API_KEY=<key>
# 预设 BASE_URL=https://amr-link.open-design.ai/v1  MODEL=deepseek-v4.1-flash
```

改完执行 `npx pm2 restart ziwei-doushu`。

**注意**
- 该端点只认 `reasoning_effort`，**不认** `thinking:{type}`（会静默忽略）
- 命理解读这类任务实测 `AI_REASONING_EFFORT=none` 质量不掉、token 省约 90%
- 可用模型（2026-10-26 实测 `/v1/models`）：`deepseek-v4.1-flash`、`deepseek-v4-pro`、`glm-5.3-flash`、`kimi-k2.7-code`、`claude-haiku-5.5` 等
- 2026-10-26 当天曾返回 402 `coding_plan_exhausted`（额度耗尽），额度恢复后应正常

**验收**：切换后 `/api/interpret` 能出正文，且耗时明显低于 GLM 通道（预期 10–30s）。

**建议做的对比实验**（服务于「评估成色」这个目标）：
固定同一张命盘和同一个问题，分别在 `glm-5.3-flash` / `deepseek-v4.1-flash` / `deepseek-v4-pro` 下跑，人工比对：
- 是否落到了具体的宫位/星曜/亮度/四化
- 是否出现盘面上没有的星曜（幻觉）
- 论断是否有可追溯的依据（接上 P0-1 后应能给出原话）

---

### P1-2 预生成缓存（可选，改善等待）

**背景**：GLM 通道点话题要等 25–90 秒。已验证该通道**支持 3 并发**。

**做法**
- 起盘时后台并行预生成 `overview` + 最常用 2 个话题，存内存 Map（key = 命盘指纹 hash + 话题 key）
- 点按钮先查缓存，命中直接逐字回放

**注意**：单机 pm2 有效；多实例部署需换 Redis。

---

### P2 其他（按需）

| 项 | 说明 |
|---|---|
| 响应去重缓存 | 同一命盘 + 同一问题不重复烧额度 |
| 限流 | 目前 `/api/*` 无鉴权，任何人可调；自用可加个 token 校验 |
| 多轮历史裁剪 | `app/api/interpret/route.ts` 里 `MAX_HISTORY=20`，可再收紧以降低延迟 |
| 删除 `ChatPanel.tsx` | 死代码 |
| 断语库自建 | 见下 |

**关于断语库**（`lib/ziwei/db-analysis.ts` 现在是 `STAR_DB = {}` 空壳，导致 `/knowledge/[star]/[topic]` 预渲染 **0 条**）：
填上它能让知识库从 0 变 182 条静态页。但**不建议现在做**——批量生成上万行断语的质量上限受当前模型约束，而实测当前模型连「只引用给定材料」都做不到。等接上更强的模型（DeepSeek 官方/付费 Claude）再考虑。

---

## 六、合规（重要）

| 内容 | 协议 | 能否用于本项目 |
|---|---|---|
| 代码 `lib/` `app/` `components/` | MIT | 可以 |
| 数据集（Releases 里的样本集/13 维解读） | CC BY 4.0 | 可以，需注明来源 |
| 古籍原文 `lib/classics/` | 公有领域 | 可以 |
| **`docs/tianji-ziwei/` 倪师原话 1849 条** | **CC BY-NC-SA 4.0** | **仅限非商业使用** |

**当前场景是个人自用，可以使用。** 但如果日后要公开部署并收费，必须：
- 移除 P0-1 里注入的原话原文，只保留方法论层转述
- 或者改用其他语料

`lib/ai/prompts.ts` 目前写的是「引用倪海厦原话或观点」但没有语料支撑，P0 做完后会变成「有据可引」，那时**必须同步标注来源**（meta 帧里带 url 已解决）。

---

## 七、已知坑（踩过的，别再踩）

1. **`ecosystem.config.js` 的 `args: 'start'` 不能删**。缺了 Next CLI 会默认走 `dev` 模式，页面能开但所有按钮失灵（dev 模式拒绝非同源开发资源，hydration 失败）。
2. **`.env.local` 写入受 DSH 文件策略保护**，某些工具链会拒绝写入，用编辑器手改更稳。
3. **`bash` 的 `/tmp` 与 `C:\tmp` 不是同一目录**，跨 Node/PowerShell 传路径要用绝对 Windows 路径。
4. **`pkill` 在 Windows 无效**，杀端口占用要 `netstat -ano | grep ":PORT" | grep LISTENING` 取 PID 再 `taskkill //F //PID`。
5. **`pm2 jlist | ConvertFrom-Json` 会因键大小写冲突报错**，需加 `-AsHashTable`。
6. **改完代码必须 `npm run build` 再 `pm2 restart`**，`next start` 只读 `.next` 里已构建的产物。
7. **`next build` 会自动改写 `next-env.d.ts`**，提交前 `git checkout -- next-env.d.ts` 还原。
8. **`next build` 会跑全量 TypeScript 检查**（包括 `scripts/`），但 `npx tsx` 不检查——测试脚本的类型错误只在 build 阶段暴露。
9. **不要用 `pm2 delete all`**，会连无关服务一起停。

---

## 八、总验收清单

做完 P0 后应满足：

```bash
cd D:/AI/ziwei-doushu
npx tsc --noEmit                 # 无输出
npm test                         # 11 个测试文件全通过
npm run build                    # 成功
git checkout -- next-env.d.ts
npx pm2 restart ziwei-doushu
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3000/chart   # 200
```

外加：

- [ ] 输出的每条 `「…」` 引文都能在 `docs/tianji-ziwei/` 逐字找到
- [ ] prompt 长度 ≤ 2500 字
- [ ] GLM 通道与 OpenDesign 通道都能出正文
- [ ] `/knowledge/[star]/[topic]` 若做了断语库，预渲染条数 > 0

---

## 九、给执行 Agent 的建议顺序

1. 先跑一遍 `npm run typecheck && npm test` 确认基线干净
2. P0-1 的第 1 步（建索引）是纯函数，可先单独跑通、打印 1849 条确认无误
3. P0-1 第 2 步（召回）可先用 CLI 脚本验证：给定一张盘，打印召回了哪些原话、是否切题
4. P0-1 第 3 步改 prompt 后，**必须用真实命盘跑一次端到端**，确认没退化成「只思考不产出」
5. P0-2 放在最后，因为它依赖 P0-1 的召回结果做校验基线
6. 每步都 `git commit`，粒度小一点，便于回退
