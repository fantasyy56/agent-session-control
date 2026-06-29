# 多源会话监视台 - 开发 Harness

这个文档记录**工作流程、持久化进展、决策存档、后续规划**，确保迭代的连贯性。

---

## 当前状态（Phase 3）

| 项 | 状态 |
|---|---|
| **运行地址** | http://localhost:3002 |
| **编译** | ✅ TSC 零错误 |
| **会话覆盖** | ✅ Claude CLI 9 个 + CodeBuddy IDE 11 个（20 总数） |
| **消息完整性** | ✅ 283 条复杂消息（thinking/tool_use/tool_result） |
| **数据源实时监听** | ✅ 双源 chokidar 正常 |
| **前端 Tab 切换** | ✅ 全部/CLI/IDE 过滤正常 |

---

## 工作流：快速迭代循环

### 开发启动

```bash
cd agent-session-control
npm install
npm run dev
```

默认配置自动探测：
- Claude 会话：`~/.claude/projects/` (回落 → 内置样例)
- CodeBuddy 会话：`~/Library/Application Support/CodeBuddyExtension/Data/`

### 新功能交付流程

1. **需求分析** → 在 `DEVELOPMENT.md` 对应 Phase 下开新 Todo
2. **编码实现** → 涉及的文件在 **文件变更清单** 中记录
3. **局部验证** → ESLint + TSC 编译检查
4. **E2E验证** → 访问前端，手动验证 UI/交互 / 实时推送
5. **推送完成** → 更新 `DEVELOPMENT.md` 的「后续任务」状态

### 常见任务模板

| 任务 | 命令 / 检查清单 |
|---|---|
| **新增数据源支持** | `src/<source>/store.ts` → 继承 `ISessionStore` → 在 `AggregateStore` 注册 |
| **改进前端渲染** | `public/index.html` → 含 CSS + 事件绑定 → 刷新验证 |
| **新增模型配置** | `.env` 中追加环参数 → `src/agents.ts` 读取逻辑 → 重启服务 |
| **调试数据源** | `src/claude/store.ts` 或 `src/codebuddy/store.ts` → 加 console.log → 查浏览器控制台或服务日志 |
| **修复会话解析错误** | `src/claude/parser.ts` 或 `src/codebuddy/store.ts` → Parser 单元测试（暂无，可加） |

---

## 文件责任地图

### 核心数据流

```
Claude ~/.claude/projects/ ──→ src/claude/store.ts ───┐
                                                        ├─→ aggregate-store.ts ──→ server.ts ──→ WS ──→ index.html
CodeBuddy ~/Library/.../Data ──→ src/codebuddy/store.ts ┘
```

| 文件 | 职责 | 维护人关注点 |
|---|---|---|
| `src/claude/types.ts` | 统一会话模型（sourceType + customTitle） | 新增字段需广播 WS 协议 |
| `src/claude/parser.ts` | JSONL 行解析 + custom-title 识别 | 容错能力（损坏行、未知块类型） |
| `src/claude/store.ts` | JSONL 扫描 + chokidar 监听 | 文件删除处理、并发更新 |
| `src/codebuddy/store.ts` | history 扫描 + 归一化 + 工作区映射 | IDE 日志格式变化（Logs/* 反推 cwd） |
| `src/aggregate-store.ts` | 两源合并 + 上报聚合元数据 | 源权重、优先级规则 |
| `src/server.ts` | Express + WS 路由 | 增量推送、订阅管理 |
| `src/review/*` | 双模型评审编排 | 非对称上下文、收敛策略 |
| `public/index.html` | 前端单页应用 | Tab 过滤、源徽标、实时渲染 |

---

## 决策存档

### Phase 3：多源集成理由

**目标**：同时监视 Claude Code CLI + CodeBuddy IDE 会话，统一时间线渲染。

**方案选择**：
- ✅ **聚合器模式** (`AggregateStore`) 优于条件编译  
  → 解耦两源、支持后续加第三源不需修改现有代码
- ✅ **WS 广播 sourceType** 优于前端推断  
  → 后端权威、前端无需反推数据来源
- ✅ **IDE 日志反推 cwd** 优于配置文件  
  → CodeBuddy 无 cwd 字段存储，本地 Logs 第一行可靠

### CodeBuddy 本地存储发现

| 发现 | 验证 |
|---|---|
| 真实存储非云端，完全本地（~/Library/Application Support/...） | ✅ 离线状态下新建会话仍保存 |
| 消息格式：index.json 索引 + messages/{id}.json 单条消息 | ✅ 解析20个会话成功 |
| 工作区映射从 Logs 反推 | ✅ 所有会话路径正确 |
| 统一归一化（tool-call→tool_use、reasoning→thinking） | ✅ UI 渲染一致 |

### 评审模型配置选择

- **执行方**：DeepSeek v3.2（推理强、长上下文）
- **评审方**：Qwen 3.5-35b（指令清晰、无冗余）  
原因：避免两个推理模型输出重复 reasoning，简报更干净

---

## 进展追踪（按 Phase）

### ✅ Phase 1：基础监视（完成）
- [x] Claude Code CLI 会话自动发现
- [x] JSONL 解析（含 custom-title 行识别）
- [x] 按项目 cwd 分组展示
- [x] 统一时间线渲染（text / thinking / tool_use / tool_result）
- [x] chokidar 实时监听

### ✅ Phase 2：双模型评审（完成）
- [x] 非对称上下文框架
- [x] 乒乓讨论编排 + 自动收敛
- [x] 结论编排展示
- [x] 暂停 / 继续 / 停止 / 主持人介入

### ✅ Phase 3：多源集成（完成，2026-06-23）
- [x] CodeBuddy 数据源发现
- [x] AggregateStore 聚合框架
- [x] 前端 Tab 切换（全部/CLI/IDE）
- [x] 会话项 + 详情页源徽标标注
- [x] 双源实时监听

### 📋 Phase 4：反向操作（规划中）
- [ ] `claude --resume <sessionId> -p "指令"` 命令执行
- [ ] 会话恢复后新消息同步回监视台
- [ ] CodeBuddy CLI 命令支持（如有）

---

## 已知限制与改进

| 项 | 当前状态 | 优先级 | 计划 |
|---|---|---|---|
| CodeBuddy 工具调用 UI 呈现 | ⚠️ 基础支持但样式不优 | 低 | Phase 4 |
| 会话命名持久化 | ❌ 暂未实现 | 中 | 加本地存储或 DB |
| CodeBuddy 评审稳定性 | ✅ 基本正常，需验证 | 中 | 大规模会话测试 |
| Phase 4 反向操作 | ❌ 未启动 | 低 | 需 claude CLI headless 支持 |
| 支持其他 IDE（Cursor / Windsurf） | ❌ 暂未规划 | 低 | 需数据源定位 + 格式调研 |

---

## 环境 & 依赖

### Node.js / npm

```bash
node --version   # 预期 >= 16
npm --version    # >= 8
```

### 关键依赖

| 包 | 版本 | 用途 |
|---|---|---|
| express | ^4.x | HTTP 服务 |
| ws | ^8.x | WebSocket |
| chokidar | ^3.x | 文件监听 |
| axios | ^1.x | HTTP 请求 |

### API 依赖（.env 配置）

```bash
API_BASE_URL=https://api.together.xyz/v1   # any OpenAI-compatible endpoint
API_KEY=...                                   # Bearer token

REVIEW_EXECUTOR_MODEL=deepseek-v3.2
REVIEW_REVIEWER_MODEL=qwen3.5-35b-a3b
REVIEW_MAX_ROUNDS=6
REVIEW_CONTEXT_ROUNDS=5
MAX_TOKENS=4096

PORT=3002
CLAUDE_PROJECTS_DIR=~/.claude/projects
CODEBUDDY_DATA_DIR=~/Library/Application\ Support/CodeBuddyExtension/Data
```

---

## 调试技巧

### 服务端日志

```bash
# 终端中会看到
[server] Listening on http://localhost:3002
[store] Scanning Claude projects at ~/.claude/projects/...
[store] Found 9 projects
[codebuddy] Scanning CodeBuddy history...
[codebuddy] Found 11 conversations
```

### 浏览器控制台

```javascript
// 打开 DevTools (F12)
// Console 标签查看实时 WS 消息
// 例：{ type: 'session_appended', sessionId: '...', messages: [...] }
```

### 手动触发刷新

点击前端右上角「🔄 刷新」按钮，重新扫描两个数据源。日志会显示新增 / 删除的会话数。

### 模拟会话更新

在 Claude CLI 侧终端续接某会话：
```bash
cd ~/.claude/projects/<cwd>/
# 查看最新会话 ID
ls -lt | head -1
```
监视台前端应自动收到增量消息（若启用「实时」跟随）。

---

## 质量检查清单

新功能 / 修复上线前必须验证：

- [ ] `npm run build` 编译成功（无 TS 错误）
- [ ] 浏览器控制台无红色错误
- [ ] 前端列表 / 详情页功能正常
- [ ] WS 连接正常（DevTools Network 标签看 ws:// 连接状态）
- [ ] 手动刷新能发现新会话 / 消息
- [ ] 两个数据源的会话能正常切换显示
- [ ] 如改动评审模块，验证双模型评审流程完整

---

## 后续启动指南

### 如何快速恢复项目

1. 读 `DEVELOPMENT.md` 查当前完成状态
2. 读本文件的「进展追踪」确认 Phase
3. 查 `.env` 确认 API 配置
4. `npm install && npm run dev` 启动开发服务
5. 打开 http://localhost:3002 验证前端可用

### 新需求流程

1. 在 `DEVELOPMENT.md` 对应 Phase 部分添加 Todo
2. 在本文件「进展追踪」中标记 `[ ]` 待办
3. 完成后同时更新两个文件，标记 `[x]` 完成
4. 如有新发现（架构、数据结构、限制），在「决策存档」中记录

---

最新更新：2026-06-23  
文档版本：1.0（Phase 3 完成后首版）
