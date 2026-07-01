# Agent Session Control - 导出功能设计方案

## 📋 目录
1. [导出格式对比分析](#导出格式对比分析)
2. [推荐方案](#推荐方案)
3. [架构设计](#架构设计)
4. [实现路线图](#实现路线图)

---

## 导出格式对比分析

### 1️⃣ **JSON**（数据归档格式 ⭐⭐⭐⭐⭐）

#### 优点
- ✅ **数据完整性** — 保留所有元信息：UUID、时间戳、token 用量、工具调用、错误堆栈等
- ✅ **机器可读** — 易于 AI 系统再次摄入、进行数据分析、或导入其他平台
- ✅ **导入友好** — 可原样导入回 Claude CLI（`--resume` 功能预留）
- ✅ **版本化** — 支持 schema versioning，向前兼容
- ✅ **无损** — 无格式化损失，支持二次处理

#### 缺点
- ❌ 人类阅读不友好
- ❌ 文件体积较大（原始消息 1.5-2 倍）

#### 适用场景
- 长期数据归档
- 跨系统迁移
- 调试/审计
- AI 自动化处理

#### 示例结构
```json
{
  "export": {
    "version": "1.0",
    "exportedAt": "2026-06-29T08:00:00Z",
    "tool": "agent-session-control"
  },
  "session": {
    "sessionId": "sess_abc123",
    "sourceType": "claude",
    "cwd": "/path/to/project",
    "title": "Build REST API",
    "createdAt": 1719621600000,
    "lastActiveAt": 1719625200000,
    "messageCount": 42
  },
  "messages": [
    {
      "uuid": "msg_001",
      "role": "user",
      "timestamp": 1719621605000,
      "blocks": [
        {"type": "text", "text": "Build a REST API..."}
      ]
    },
    {
      "uuid": "msg_002",
      "role": "assistant",
      "timestamp": 1719621610000,
      "model": "claude-3.5-sonnet",
      "usage": {"input": 1250, "output": 450},
      "blocks": [
        {"type": "thinking", "text": "..."},
        {"type": "tool_use", "toolName": "bash", "toolInput": {...}, "toolUseId": "tool_001"}
      ]
    }
  ]
}
```

---

### 2️⃣ **Markdown**（可读导出格式 ⭐⭐⭐⭐）

#### 优点
- ✅ **易读易分享** — GitHub 原生支持、Notion 导入良好
- ✅ **代码块美化** — tool_result 自动转 ```bash/json/sql``` 代码块
- ✅ **基础信息保留** — 时间戳、角色、工具调用链清晰
- ✅ **轻量级** — 文件体积小，适合分享
- ✅ **多个变体** — 可生成简洁版（仅文本）和详细版（含 metadata）

#### 缺点
- ❌ 信息有损 — UUID、token 用量等丢失
- ❌ 不可导入回系统 — 只读
- ❌ 大会话易爆页面 — 常需分页或概览模式

#### 适用场景
- 与他人分享讨论
- 知识库/文档归档
- 代码审查
- 团队协作

#### 示例结构（简洁版）
```markdown
# Build REST API

**Source**: Claude CLI | **Created**: 2026-06-29 | **Messages**: 42

---

## User

Build a REST API with Node.js + Express...

## Assistant (claude-3.5-sonnet)

I'll help you build a REST API. Here's the plan:

### 🧠 Thinking
Analyzing requirements for a Node.js REST API...

### 🔧 Tool: bash
\`\`\`bash
mkdir api && cd api && npm init -y
\`\`\`

### ⚙️ Result
✅ Success
```

---

### 3️⃣ **PDF**（专业分发格式 ⭐⭐⭐）

#### 优点
- ✅ **专业外观** — 可被任何系统打开，格式确定
- ✅ **打印友好** — 适合内部存档或法务需要
- ✅ **元信息可视化** — 精细控制排版和样式

#### 缺点
- ❌ 大文件体积 — 同等信息量 3-5 倍于 JSON
- ❌ 复杂度高 — 需依赖库（如 pdfkit）
- ❌ 后期编辑困难 — 生成即定格

#### 适用场景
- 正式报告/演讲稿
- 审计文档
- 客户交付

---

### 4️⃣ **HTML**（自包含格式 ⭐⭐⭐⭐）

#### 优点
- ✅ **自包含** — 单个文件包含所有 CSS/JS，离线可览
- ✅ **交互式** — 可嵌入搜索、筛选、折叠等功能
- ✅ **现代外观** — 浏览器原生支持，样式灵活

#### 缺点
- ❌ 文件体积可能很大
- ❌ 搜索引擎不友好
- ❌ 版本管理困难

#### 适用场景
- 离线浏览查看
- 内部分享预览
- 动态交互式展示

---

### 5️⃣ **JSONL**（流式格式 ⭐⭐）

#### 优点
- ✅ 逐行解析，支持流式处理
- ✅ 每行独立，易于追加

#### 缺点
- ❌ 需自行编写解析器
- ❌ 人类阅读困难

#### 适用场景
- 实时流式导出
- 超大会话拆分

---

## 推荐方案

### **分层导出策略**（推荐 ✨）

不是二选一，而是**多格式并行**：

```
导出入口
  ├─ JSON（默认，完整保留）
  ├─ Markdown（简洁版 & 详细版）
  ├─ HTML（自包含交互式预览）
  └─ [可选] PDF（未来扩展）
```

#### Phase 1（MVP）: JSON + Markdown
- **JSON** — 完整归档，支持后续导入/分析
- **Markdown** — 可读分享，自动生成简洁版和详细版

#### Phase 2（增强）: HTML 动态预览
- 支持页面内搜索、筛选、折叠
- 可嵌入 review 评审结论

#### Phase 3（可选）: PDF 导出
- 依赖 pdfkit 或 puppeteer
- 支持自定义样式/页眉页脚

---

## 架构设计

### 导出流程图

```
Frontend (index.html)
  ↓
【导出按钮】
  ↓
GET /api/sessions/{id}/export?format=json|markdown|html
  ↓
ExportService.export(session, format)
  ├─ SessionFormatter.toJSON(session)
  ├─ SessionFormatter.toMarkdown(session, options)
  └─ SessionFormatter.toHTML(session)
  ↓
Content-Type: application/json | text/markdown | text/html
Content-Disposition: attachment; filename="session-uuid-date.{ext}"
  ↓
浏览器自动下载或预览
```

### 服务端实现架构

```
src/
├── export/
│   ├── service.ts          # 导出协调器
│   ├── formatters/
│   │   ├── json.ts         # JSON 格式化
│   │   ├── markdown.ts     # Markdown 格式化
│   │   ├── html.ts         # HTML 格式化
│   │   └── pdf.ts          # [Phase 2] PDF 格式化
│   └── styles/
│       └── markdown.css     # HTML 样式常量
└── server.ts               # 新增 /api/export 路由
```

### 核心接口设计

```typescript
// src/export/service.ts
export interface ExportOptions {
  format: 'json' | 'markdown' | 'html' | 'pdf'
  sessionId: string
  includeThinking?: boolean  // Markdown: 是否折叠 thinking
  includeMetadata?: boolean  // Markdown: 是否显示 token 用量
  variant?: 'concise' | 'detailed'  // Markdown: 简洁 vs 详细
}

export class ExportService {
  async export(session: SessionDetail, options: ExportOptions): Promise<ExportResult> {
    // 路由分发
  }
}

export interface ExportResult {
  content: string | Buffer
  mimeType: string
  filename: string
  size: number
}

// src/export/formatters/json.ts
export function formatJSON(session: SessionDetail): string {
  // 补充 metadata
  // 序列化为 JSON
}

// src/export/formatters/markdown.ts
export function formatMarkdown(
  session: SessionDetail,
  options: {
    variant: 'concise' | 'detailed'
    includeThinking: boolean
    includeMetadata: boolean
  }
): string {
  // 转换消息为 Markdown
  // 处理代码块、工具调用等
}

// src/export/formatters/html.ts
export function formatHTML(session: SessionDetail): string {
  // 生成自包含 HTML（含内联 CSS）
}
```

### 路由端点

```typescript
// GET /api/sessions/{id}/export?format=json&variant=detailed
// Content-Disposition: attachment; filename="session-uuid-date.json"
app.get('/api/sessions/:id/export', (req, res) => {
  const { id } = req.params
  const { format = 'json', variant = 'detailed' } = req.query
  
  const session = store.getSession(id)
  if (!session) {
    res.status(404).json({ error: 'Session not found' })
    return
  }
  
  const exporter = new ExportService()
  const result = await exporter.export(session, {
    format: format as ExportFormat,
    variant: variant as Variant,
    includeThinking: true,
    includeMetadata: true
  })
  
  res.setHeader('Content-Type', result.mimeType)
  res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`)
  res.send(result.content)
})
```

---

## 导出内容设计

### JSON 导出内容

```json
{
  "export": {
    "version": "1.0",
    "exportedAt": "2026-06-29T08:00:00Z",
    "tool": "agent-session-control",
    "toolVersion": "1.0.0"
  },
  "session": {
    "sessionId": "sess_abc123",
    "sourceType": "claude",
    "cwd": "/Users/user/project",
    "projectDir": "project",
    "title": "Build REST API with Express",
    "customTitle": null,
    "createdAt": 1719621600000,
    "lastActiveAt": 1719625200000,
    "messageCount": 42,
    "gitBranch": "feature/api",
    "filePath": "/Users/user/.claude/projects/project/sess_abc123.jsonl"
  },
  "messages": [ /* 完整消息数组 */ ],
  "stats": {
    "totalInputTokens": 12500,
    "totalOutputTokens": 8450,
    "toolCallCount": {
      "bash": 5,
      "file_edit": 3,
      "grep": 2
    },
    "messagesByRole": {
      "user": 15,
      "assistant": 27,
      "system": 0
    }
  }
}
```

### Markdown 导出示例

#### 简洁版（concise）
- 仅显示角色和文本内容
- Thinking 块折叠为「[💭 思维过程]」
- 工具调用链为「[🔧 执行: bash/file_edit/...]」
- 代码块保留，输出简化

#### 详细版（detailed）
- 显示时间戳、token 用量
- Thinking 块完整展开
- 工具调用链详细展开（输入参数、输出内容）
- 额外显示 git 分支、原始会话路径等

---

## 实现路线图

### Phase 1（V1.1）- MVP 导出 ⭐ 当前计划
- [ ] `ExportService` 核心框架
- [ ] JSON 导出器（完整保留）
- [ ] Markdown 导出器（简洁版 + 详细版）
- [ ] 前端导出按钮（UI）
- [ ] 文件自动下载
- [ ] 测试：多种会话类型的导出质量

**预计耗时**: 2-3 天

### Phase 2（V1.2）- 增强导出
- [ ] HTML 自包含导出
- [ ] HTML 内置搜索/筛选
- [ ] 评审结论嵌入导出
- [ ] 批量导出（多个会话）

**预计耗时**: 2-3 天

### Phase 3（V1.3+）- 高级功能
- [ ] PDF 导出（pdfkit）
- [ ] 自定义导出模板
- [ ] 导出预览（下载前浏览）
- [ ] 导出历史/版本管理

---

## 安全考虑

1. **敏感信息**
   - 导出的 JSON 包含完整 API key、数据库凭证等
   - 推荐：提示用户不要将导出文件分享给不信任的人
   - 可选：添加「脱敏模式」（自动掩盖 API key 等）

2. **文件体积限制**
   - 超大会话（10000+ 消息）可能内存溢出
   - 推荐：限制单次导出大小或实现分页导出

3. **速率限制**
   - 防止滥用导出接口
   - 推荐：按 IP 限流（如 10 req/min）

---

## 文件命名规范

```
session-{sessionId}-{timestamp}.{ext}

示例:
- session-sess_abc123-20260629_080000.json
- session-sess_abc123-20260629_080000.md
- session-sess_abc123-20260629_080000.html
```

---

## 对标分析

| 工具 | JSON | Markdown | HTML | PDF | 备注 |
|---|---|---|---|---|---|
| ChatGPT | ❌ | ✅ | ❌ | ✅ | PDF 需要浏览器插件 |
| Claude | ❌ | ✅ | ❌ | ❌ | 官方仅支持分享链接 |
| Cursor | ❌ | ❌ | ❌ | ❌ | 暂无官方导出 |
| **Agent Session Control（规划）** | ✅ | ✅ | ✅ | 🔜 | 最完整的多格式支持 |

---

## 总结

### 推荐实现顺序
1. **JSON**（数据完整性，支持未来扩展）
2. **Markdown 简洁版**（快速分享）
3. **Markdown 详细版**（深度归档）
4. **HTML**（离线浏览）
5. **PDF**（可选，企业级需求）

### 关键特性
- ✨ 多格式支持，满足不同场景
- 🎯 JSON 为核心，保留所有元数据
- 📄 Markdown 易分享，两个变体覆盖简洁和详细
- 🔒 安全考虑（敏感信息警告、速率限制）
- 📦 标准化命名和文件结构
