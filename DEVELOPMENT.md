# 多源会话监视台 - 开发进展

## 项目概述

多源会话监视台（Agent Session Control）是一个本地 Web 工具，用于统一监视、聚合管理多个 AI coding 会话。

- Claude Code CLI：监视 ~/.claude/projects/ 下的本地 JSONL 会话
- CodeBuddy IDE：监视 ~/Library/Application Support/CodeBuddyExtension/Data/ 下的本地对话数据

---

## Phase 进度

### Phase 1：基础监视（已完成）
- 自动发现 Claude Code CLI 会话
- 按项目 cwd 分组展示
- 统一时间线渲染（text / thinking / tool_use / tool_result）
- 实时跟随最新消息

### Phase 2：双模型评审（已完成）
- 主模型（持全量上下文）↔ 异构评审模型（只看简报）乒乓讨论
- 自动收敛 + 结论编排
- 默认配置：DeepSeek v3.2（执行方）+ Qwen 3.5-35b（评审方）

### Phase 3：多源集成（2026-06-23 完成）
- 发现 CodeBuddy IDE 本地数据存储位置
- 实现 CodeBuddy 数据源解析（src/codebuddy/store.ts）
- 创建 AggregateStore 聚合 Claude + CodeBuddy
- 前端 Tab 切换器（全部 / Claude CLI / CodeBuddy IDE）
- 会话项与详情页数据源徽标标注
- 实时监听两个数据源的变更

### Phase 3.1：观感优化 - 简洁视图（2026-06-23 完成）
- 顶栏新增「💬 简洁 / 🔧 完整」视图切换器（默认简洁）
- 简洁模式下：
  - 连续 tool_use + tool_result 合并成紧凑徽标条（如 `🔧 Read 🔧 Edit · 3 次调用 · 1 个结果`）
  - 点击徽标条展开完整工具明细
  - thinking 块默认折叠，summary 显示前 60 字预览
  - 隐藏纯 tool_result 的 user 消息和 system 消息（页底提示隐藏条数）
  - 空文本块自动过滤
- 工具结果 summary 显示首行预览 + 字符数提示
- 长 tool_result（默认 `max-height: 400px`）滚动查看，展开后无限制

### Phase 3.2：视图模式会话级化 + 用户消息注入解析（2026-06-23 完成）
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

当前状态：运行于 http://localhost:3002
- Claude 会话：9 个（6 个项目）
- CodeBuddy 会话：11 个（9 个项目）
- 支持原生手动命名显示（Claude CLI 的 custom-title 行）

---

## 技术亮点

### 数据源结构对比

| 项 | Claude Code CLI | CodeBuddy IDE |
|---|---|---|
| 本地路径 | ~/.claude/projects/<cwd>/<sessionId>.jsonl | ~/Library/Application Support/CodeBuddyExtension/Data/<userId>/CodeBuddyIDE/<userId>/history/<workspaceId>/<conversationId>/ |
| 格式 | JSONL 逐行追加 | 索引JSON+单条消息JSON |
| 工作区映射 | 直接用文件路径 cwd | 从IDE日志Logs/*反推 |
| 消息模型 | role+blocks | 同上归一化 |

### CodeBuddy 关键发现

1. 真实存储：非云端，完全本地
2. 工作区映射：IDE日志第1行Workspace Path反推原始cwd
3. 消息结构：index.json索引+messages/<id>.json单条消息
4. 统一归一化：tool-call→tool_use、reasoning→thinking

### 代码架构

src/
├── aggregate-store.ts         # 聚合两个Store
├── claude/
│   ├── types.ts              # 数据模型含sourceType
│   ├── parser.ts             # JSONL+custom-title
│   └── store.ts              # 扫描+chokidar监听
├── codebuddy/
│   └── store.ts              # history扫描+归一化
└── server.ts                 # 改用AggregateStore

---

## 当前配置（.env）

PORT=3002
REVIEW_EXECUTOR_MODEL=deepseek-v3.2
REVIEW_REVIEWER_MODEL=qwen3.5-35b-a3b
API_BASE_URL=...
API_KEY=...

---

## 前端特性（Phase 3）

- Tab切换：全部/Claude CLI/CodeBuddy IDE
- 源徽标：CLI/IDE不同颜色
- 会话过滤：按sourceType自动过滤
- 手动命名：自动识别Claude CLI命名
- 评审发起：支持多源会话评审

---

## 文件变更清单

| 文件 | 变更类型 | 描述 |
|---|---|---|
| src/codebuddy/store.ts | 新建 | CodeBuddy数据源300行 |
| src/aggregate-store.ts | 新建 | 聚合Store70行 |
| src/claude/types.ts | 修改 | 加sourceType+customTitle |
| src/claude/parser.ts | 修改 | 识别custom-title行 |
| src/claude/store.ts | 修改 | 打sourceType:claude |
| src/server.ts | 修改 | 改用AggregateStore |
| public/index.html | 修改 | Tab+徽标+过滤；Phase 3.1 加简洁/完整视图切换 |
| README.md | 修改 | 更新多源版本 |

---

## 验证状态

- TSC编译：零错误
- ESLint：零警告
- 两数据源自动发现：正常
- 会话解析：20个会话完整
- 复杂会话283条消息：含thinking+tool_use+tool_result
- 实时监听：正常
- 前端Tab切换：过滤正常

---

## 已知限制 & 后续

限制：
1. CodeBuddy工具调用UI呈现待优化
2. 反向操作（Phase 4）暂未实现
3. 监视台命名持久化暂未实现

后续任务：
- [ ] CodeBuddy会话评审稳定性验证
- [ ] 在监视台里实现会话命名功能
- [ ] Phase 4：反向操作支持
- [ ] 支持其他AI IDE

---

最新更新：2026-06-23 Phase 3.2 完成（视图模式会话级 + 注入数据可视化）
