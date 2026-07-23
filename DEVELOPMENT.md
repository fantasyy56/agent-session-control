# 多源会话监视台 - 开发进展

## 项目概述

多源会话监视台（Agent Session Control）是一个本地 Web 工具，用于统一监视、聚合管理多个 AI coding 会话。

支持的数据源：

- **Claude Code CLI**：监视 `~/.claude/projects/` 下的本地 JSONL 会话
- **CodeBuddy IDE**：监视 `~/Library/Application Support/CodeBuddyExtension/Data/` 下的本地对话数据
- **WorkBuddy CLI**：监视 `~/.workbuddy/projects/` 下的 JSONL 会话（Claude Code 的 Codex/OpenAI-Responses 风格衍生版）
- **Cursor**：读取 `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb`（SQLite）中的会话

> 每个 Phase 均包含两部分：**① 做了什么 & 怎么做的**；**② 遇到的问题 / 踩过的坑 / 如何解决**。

---

## Phase 进度

### Phase 1：基础监视（已完成）

**做了什么 & 怎么做的**
- 自动发现 Claude Code CLI 会话（扫描 `~/.claude/projects/`）
- 按项目 cwd 分组展示
- 统一时间线渲染（text / thinking / tool_use / tool_result）
- 实时跟随最新消息（chokidar 监听 + 按字节 offset 读增量）

**问题与踩坑**
- **坑：JSONL 是逐行追加，监听到 change 时若整文件重读会重复渲染且开销大。**
  - 解决：记录已消费字节 `offset`，每次只 `readSync` 新增部分；用 `leftover` 缓存不完整的末行，等下次补齐再解析。
- **坑：文件可能被截断或重写（`size < offset`），继续按旧 offset 读会错位。**
  - 解决：检测到 `size < offset` 判定为 `__RESET__`，从头重新全量解析并重置 offset。

### Phase 2：双模型评审（已完成）

**做了什么 & 怎么做的**
- 主模型（持全量上下文）↔ 异构评审模型（只看简报）乒乓讨论
- 自动收敛 + 结论编排
- 默认配置：DeepSeek v3.2（执行方）+ Qwen 3.5-35b（评审方）

**问题与踩坑**
- **坑：评审模型若也灌入全量上下文，token 成本高且容易被执行方视角带偏，失去"异构审视"意义。**
  - 解决：评审方只接收执行方产出的**简报**而非原始上下文，强制其从独立视角提问。
- **坑：两个模型来回讨论可能不收敛、无限对话。**
  - 解决：加入自动收敛判定 + 轮次上限，达到条件后编排最终结论。

### Phase 3：多源集成（2026-06-23 完成）

**做了什么 & 怎么做的**
- 发现 CodeBuddy IDE 本地数据存储位置（完全本地，非云端）
- 实现 CodeBuddy 数据源解析（`src/codebuddy/store.ts`，约 300 行）
- 创建 `AggregateStore` 聚合 Claude + CodeBuddy，统一归一化消息模型
- 前端 Tab 切换器（全部 / Claude CLI / CodeBuddy IDE）
- 会话项与详情页数据源徽标标注
- 实时监听两个数据源的变更

**问题与踩坑**
- **坑：CodeBuddy 的会话文件里没有工作区路径，无法直接按 cwd 分组。**
  - 解决：从 IDE 日志 `Logs/*` 第 1 行的 `Workspace Path` 反推原始 cwd 完成工作区映射。
- **坑：CodeBuddy 消息结构（`index.json` 索引 + `messages/<id>.json` 单条）与 Claude 的 role+blocks 完全不同。**
  - 解决：在 store 内做统一归一化：`tool-call → tool_use`、`reasoning → thinking`，对齐 Claude 的消息模型，前端只需一套渲染。
- **坑：两个源的事件类型、生命周期各异，server 里散落 if/else 难维护。**
  - 解决：抽象 `AggregateStore`，统一 `scan/getProjects/getSession/startWatching/on` 接口并 fanout 事件，server 只面向聚合器。

### Phase 3.1：观感优化 - 简洁视图（2026-06-23 完成）

**做了什么 & 怎么做的**
- 顶栏新增「💬 简洁 / 🔧 完整」视图切换器（默认简洁）
- 简洁模式下：
  - 连续 tool_use + tool_result 合并成紧凑徽标条（如 `🔧 Read 🔧 Edit · 3 次调用 · 1 个结果`），点击展开完整明细
  - thinking 块默认折叠，summary 显示前 60 字预览
  - 隐藏纯 tool_result 的 user 消息和 system 消息（页底提示隐藏条数）
  - 空文本块自动过滤
- 工具结果 summary 显示首行预览 + 字符数提示
- 长 tool_result（默认 `max-height: 400px`）滚动查看，展开后无限制

**问题与踩坑**
- **坑：复杂会话里 tool_use/tool_result 刷屏，正文淹没在工具噪声中。**
  - 解决：把连续工具块折叠为一条紧凑徽标条，默认只展示统计，点开才看明细。
- **坑：折叠 thinking/长结果后用户不知道里面有什么。**
  - 解决：summary 给出前 60 字预览 + 字符数，兼顾"降噪"与"可发现性"。

### Phase 3.2：视图模式会话级化 + 用户消息注入解析（2026-06-23 完成）

**做了什么 & 怎么做的**
- **简洁/完整切换从顶栏移到会话头**：每个会话独立记忆视图模式（`sessionConciseMode[sessionId]`）
- **用户消息注入数据可视化**：
  - 用正则 `^<tag>...</tag>$`（行首到行末跨行）解析顶层 XML-like 标签块
  - 主 prompt 文本正常显示，注入块独立折叠展示
  - 按标签语义分类着色：
    - `📜 规则注入`（橙色）：reminder/rule/policy/security
    - `📎 上下文`（蓝色）：context/data/additional/environment/open_*/recently_*
    - `⚙ 命令产物`（灰色）：command/tool/output/stdout
    - `🧠 记忆/历史`（紫色）：memory/history/summary/previous
    - `🏷 注入`（默认）：其他
  - summary 显示 `<tag>` 名 + 分类标签 + 行数/字数
  - 简洁模式默认折叠，完整模式默认展开
  - 等宽字体 + max-height 滚动 + 左侧色条标识类别

**问题与踩坑**
- **坑：全局视图模式无法满足"这个会话想看细节、那个只想看正文"的需求。**
  - 解决：视图模式下沉到会话级，用 `sessionConciseMode[sessionId]` 分别记忆。
- **坑：用户 prompt 里混入大量 `<xxx>` 注入块（规则/上下文/记忆），和真实提问混在一起难以阅读。**
  - 解决：用行首到行末的跨行正则提取顶层标签块，与主 prompt 分离，并按标签语义分类着色折叠。

### Phase 4：WorkBuddy 源接入（已完成）

**做了什么 & 怎么做的**
- 新增第三数据源 `src/workbuddy/store.ts`，监视 `~/.workbuddy/projects/`
- WorkBuddy 是 Claude Code 的 Codex/OpenAI-Responses 风格衍生版：**存储结构与 Claude 一致**（`baseDir/<编码cwd>/<sessionId>.jsonl`），仅每行 JSON 的字段格式不同
- 复用 Claude 的 Store 模式：完整解析读列表/详情、按字节 offset 只读增量、chokidar 实时监听
- 标题优先级：AI 生成标题 > 首条消息摘要 > 首条消息派生
- 接入 `AggregateStore`（第三源）+ 前端 Tab / 徽标（WB）

**问题与踩坑**
- **坑：结构像 Claude 但每行 JSON 格式不同，直接复用 Claude parser 解析不出消息。**
  - 解决：Store 复用（扫描/监听/offset 增量逻辑一致），单独实现 `workbuddy/parser` 解析行格式，做到"骨架复用、解析分离"。
- **坑：文件被截断/重写时 offset 失效。**
  - 解决：沿用 `size < offset → __RESET__` 检测，从头重解析并只推 `session_meta_updated`。
- **坑：环境不一定装了 WorkBuddy，目录不存在会报错。**
  - 解决：构造时探测目录，不存在则 `baseDir=''`，`available` 据此为 false，聚合器优雅跳过。

### Phase 5：Cursor 源接入（2026-07-23 完成）

**做了什么 & 怎么做的**
- 新增第四数据源 `src/cursor/store.ts`，读取 Cursor（基于 VSCode 的 AI IDE）会话
- 与前三源的**根本差异**：会话存在 **SQLite（`state.vscdb`）** 而非 jsonl 文件
  - `cursorDiskKV` 表：`composerData:<id>`（会话元信息 + 消息顺序 `fullConversationHeadersOnly`）、`bubbleId:<composerId>:<bubbleId>`（单条气泡，type 1=user / 2=assistant）
- 依赖：安装 `better-sqlite3` + `@types/better-sqlite3`
- 归一化 bubble → ContentBlock（thinking → text → tool_use → tool_result），`toolFormerData` 映射工具调用
- 接入 `AggregateStore`（第四源）+ server 日志标签 + 前端 Tab / chip 样式 / 标签（CUR）
- 端到端验证：`tsc --noEmit` 零错误，启动日志 `[Cursor] 已接入`，真实会话正确映射工作区、user/assistant 正确交替、四类块解析正确

**问题与踩坑**
- **坑（最大）：先前那轮 Cursor 集成代码整个丢失了（疑似环境重置/回滚）——`src/cursor/` 目录、`SourceType` 里的 `cursor`、`better-sqlite3` 依赖全都不在。**
  - 现象：用户看不到 Cursor 会话，第一反应是"重启一下"；但重启后启动日志仍只有三个源。
  - 排查：读 `aggregate-store.ts`/`server.ts` 发现根本没有 cursor 引用，`ls src/cursor` 目录不存在，`SourceType` 也无 cursor。
  - 结论 & 解决：**不是重启能解决的，代码里压根没有 Cursor**——重新完整实现整套集成。
- **坑：`state.vscdb` 是 Cursor 正在写入的活动库（WAL 模式），直接打开读会 `SQLITE_BUSY` 锁冲突。**
  - 解决：每次读取先把 `db` + `-wal` + `-shm` 复制成临时快照（`mkdtemp`），在**副本**上查询（副本可读写，SQLite 自动合并 WAL），用完删除整个临时目录。
- **坑：`composerData` 里存在值为字面 `null` 的记录，`JSON.parse` 后直接 `Object.keys` 会抛错。**
  - 解决：解析后统一做 `!raw || typeof raw !== 'object'` 防御跳过；headers 里的元素同样判空。
- **坑：原以为要遍历 `workspaceStorage/<hash>/state.vscdb` 才能拿到会话所属工作区，实测映射全部失败（`WS_MAPPED_TOTAL 0`）。**
  - 解决：探测发现 `composerData.workspaceIdentifier.uri.fsPath` **直接给出工作区绝对路径**，无需遍历 workspaceStorage，大幅简化。
- **坑：`better-sqlite3` 是原生模块，`npm install` 的编译脚本被 allow-scripts 拦截，可能加载失败。**
  - 解决：实测其自带 prebuilt binary，可直接 `require` 加载读库；若失败则需手动编译。
- **坑：Cursor 实时性依赖它把 WAL 数据落盘，通常有几秒延迟，且 WAL 写入频繁易抖动。**
  - 解决：只监听 `globalStorage` 顶层的 `state.vscdb*`（`depth:0`），变化后做 **600ms 防抖** 全量重扫 + diff 推增量。

当前状态：运行于 http://localhost:3002，四个源全部接入。

---

## 技术亮点

### 数据源结构对比

| 项 | Claude Code CLI | CodeBuddy IDE | WorkBuddy CLI | Cursor |
|---|---|---|---|---|
| 本地路径 | `~/.claude/projects/<cwd>/<sid>.jsonl` | `~/Library/.../CodeBuddyExtension/Data/.../history/<ws>/<conv>/` | `~/.workbuddy/projects/<cwd>/<sid>.jsonl` | `~/Library/.../Cursor/User/globalStorage/state.vscdb` |
| 格式 | JSONL 逐行追加 | 索引 JSON + 单条消息 JSON | JSONL 逐行追加（字段格式不同） | SQLite（cursorDiskKV 表 K-V） |
| 工作区映射 | 直接用文件路径 cwd | 从 IDE 日志 Logs/* 反推 | 直接用文件路径 cwd | `composerData.workspaceIdentifier.uri.fsPath` |
| 实时策略 | 字节 offset 增量 | 目录监听 | 字节 offset 增量 | 快照 + 600ms 防抖全量 diff |
| 消息模型 | role + blocks | 归一化到同上 | 归一化到同上 | 归一化到同上 |

### 关键发现

1. **CodeBuddy**：完全本地存储；工作区路径需从 IDE 日志反推；`index.json` 索引 + 单条消息 JSON；`tool-call → tool_use`、`reasoning → thinking`。
2. **WorkBuddy**：Codex/OpenAI-Responses 风格；结构同 Claude、仅行格式不同，故 Store 骨架复用、parser 分离。
3. **Cursor**：会话在 SQLite；活动库需快照避 WAL 锁；`workspaceIdentifier.uri.fsPath` 直接给出工作区；`bubbleId` type 1/2 区分 user/assistant，`toolFormerData` 承载工具调用。

### 代码架构

```
src/
├── aggregate-store.ts         # 聚合四个 Store，统一接口 + 事件 fanout
├── claude/
│   ├── types.ts              # 数据模型，SourceType 含 claude/codebuddy/workbuddy/cursor
│   ├── parser.ts             # JSONL + custom-title
│   └── store.ts              # 扫描 + chokidar 监听（字节 offset 增量）
├── codebuddy/
│   └── store.ts              # history 扫描 + 归一化
├── workbuddy/
│   ├── parser.ts             # WorkBuddy 行格式解析
│   └── store.ts              # 结构同 Claude、offset 增量
├── cursor/
│   └── store.ts              # SQLite 快照读取 + 归一化 + 防抖监听
└── server.ts                 # 使用 AggregateStore
```

---

## 当前配置（.env）

```
PORT=3002
REVIEW_EXECUTOR_MODEL=deepseek-v3.2
REVIEW_REVIEWER_MODEL=qwen3.5-35b-a3b
API_BASE_URL=...
API_KEY=...
# 可选：覆盖各源数据目录
# WORKBUDDY_PROJECTS_DIR=~/.workbuddy/projects
# CURSOR_GLOBAL_STORAGE=~/Library/Application Support/Cursor/User/globalStorage
```

---

## 前端特性

- Tab 切换：全部 / Claude CLI / CodeBuddy IDE / WorkBuddy CLI / Cursor
- 源徽标：CLI / IDE / WB / CUR 不同颜色
- 会话过滤：按 sourceType 自动过滤
- 视图模式：会话级简洁/完整切换、注入块分类可视化
- 手动命名：自动识别 Claude CLI 命名
- 评审发起：支持多源会话评审

---

## 文件变更清单

| 文件 | 变更类型 | 描述 |
|---|---|---|
| src/codebuddy/store.ts | 新建 | CodeBuddy 数据源（约 300 行） |
| src/workbuddy/store.ts | 新建 | WorkBuddy 数据源（结构同 Claude、offset 增量） |
| src/workbuddy/parser.ts | 新建 | WorkBuddy 行格式解析 |
| src/cursor/store.ts | 新建 | Cursor SQLite 快照读取 + 归一化 + 防抖监听 |
| src/aggregate-store.ts | 新建/修改 | 聚合 Store，逐步接入四个源 |
| src/claude/types.ts | 修改 | SourceType 扩展至四源；加 customTitle |
| src/claude/parser.ts | 修改 | 识别 custom-title 行 |
| src/claude/store.ts | 修改 | 打 sourceType:claude |
| src/server.ts | 修改 | 改用 AggregateStore；日志标签四源 |
| public/index.html | 修改 | Tab + 徽标 + 过滤；简洁/完整视图；注入可视化；cursor chip |
| package.json | 修改 | 新增 better-sqlite3 + @types/better-sqlite3 |
| README.md | 修改 | 更新多源版本 |

---

## 验证状态

- TSC 编译：零错误
- ESLint：零警告
- 四数据源自动发现：正常（缺失源优雅跳过）
- 会话解析：完整（含 thinking + tool_use + tool_result）
- 实时监听：正常（Cursor 走快照 + 防抖）
- 前端 Tab 切换：过滤正常

---

## 已知限制 & 后续

限制：
1. CodeBuddy 工具调用 UI 呈现待优化
2. Cursor 实时性受 WAL 落盘影响，有秒级延迟
3. 监视台命名持久化暂未实现
4. 反向操作（Phase 6）暂未实现

后续任务：
- [ ] CodeBuddy / Cursor 会话评审稳定性验证
- [ ] 在监视台里实现会话命名持久化
- [ ] Phase 6：反向操作支持
- [ ] 支持更多 AI IDE

---

最新更新：2026-07-23 Phase 5 完成（Cursor 源接入，SQLite 快照 + 防抖增量）
