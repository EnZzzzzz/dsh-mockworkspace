# dsh 后端 API 参考（apiproxy）

dsh（DeepSeek Harness）是前后端分离设计：Web GUI（浏览器）与 Host（Node 进程）
通过 HTTP API 通信。本文件固化后端公开接口，供 mock workspace 插件及后续开发
参考。**以源码为准**：仓库根 `/Volumes/DataDrive/proj/public/deepseek-harness`，
目录 `packages/host/apiproxy/src/api/`。

## 1. Wire 格式（HTTP 载体）

所有客户端发起的调用：

```
POST /api/<method>
Content-Type: application/json

{ "type": "client-request", "rpcId": "<任意字符串>", "method": "<method>", "payload": { ... } }
```

响应：

```json
{ "type": "server-response", "rpcId": "<与请求一致>", "result": { "ok": true, "value": { ... } } }
```

- 失败时 `result` 为 `{ "ok": false, "error": { "code", "message", "details" } }`
- HTTP 状态只表达载体层：404 未知路径 / 415 非 JSON / 400 非 JSON body / 500 处理器崩溃；
  业务错误一律 200 + `ok:false`
- `rpcId` 由调用方生成（`RpcId(randomUuid())`），响应必须回显同一个值
- 流式接口（`events.mux` / `events.host`）是 **GET**，见 §4
- 服务端发起的交互（审批/提问）走 `POST /api/respond`（`type: 'client-response'`）

消息类型（`rpc.ts` 的 `RpcMessage` 联合）：

| type | 方向 | 载体 |
| --- | --- | --- |
| `client-request` | 客户端 → 服务端 | POST `/api/<method>` body |
| `server-response` | 服务端 → 客户端 | 该 POST 的响应 body |
| `server-request` | 服务端 → 客户端（流帧） | events 流帧 |
| `client-response` | 客户端 → 服务端 | POST `/api/respond` body |

## 2. 会话域（`session.*`）

源码：`api/sessions.ts`（`SessionsApi`）、`api/rpc-map.ts`。

| method | payload | 返回 value | 说明 |
| --- | --- | --- | --- |
| `session.list` | `{ cursor? }` | `{ items: SessionSummary[] }` | 列出持久化会话（updatedAt 倒序）；cursor 预留 |
| `session.search` | `{ query }` | `{ items: SessionSearchItem[]; hasMore }` | 跨会话搜索消息 |
| `session.create` | `{ workspaceId?; cwd?; sessionId?; agentPreset? }` | `{ sessionId; agentPreset? }` | **创建真实会话**。`workspaceId`/`cwd` 至多传一个；省略用 Host cwd。预分配 `sessionId` 可重试（同 id+cwd 返回同会话，不同 cwd 报 `session-conflict`） |
| `session.history` | `{ sessionId; beforeSeq?; maxMessages? }` | `{ events: HistoryEntry[]; hasMore; projections? }` | 分页读历史事件；尾部页带 projections 基线 |
| `session.models` | `{ sessionId }` | `SessionModels` | 会话可用模型目录 |
| `session.selectModel` | `{ sessionId; provider; model; reasoningEffort? }` | `{ selected: ModelSelection }` | 选择会话模型 |
| `session.rename` | `{ sessionId; title }` | `{ title; seq }` | 重命名（追加 `session/title` 事件，pin 住标题） |
| `session.fork` | `{ sessionId; atSeq? }` | `{ sessionId }` | 分叉（继承 cwd/模型/lineage） |
| `session.prompt` | `{ sessionId; mode: 'queue'\|'steer'; content: PromptContentPart[]; clientTimeZone? }` | `{ accepted: true; command? }` | 发送消息；`/` 开头走命令注册表 |
| `session.attachment` | `{ sessionId; attachmentId }` | `{ attachment; data }` | 读会话引用的图片 |
| `session.updateQueue` | `{ sessionId; itemId; action }` | `{ accepted: true }` | 编辑/删除/严格 steer 待发消息 |
| `session.cancel` | `{ sessionId }` | `{ accepted: true }` | 停止当前轮（保留 pending inbox） |

**mock 插件用到的关键路径**：`session.create({ workspaceId })` 原子创建 cwd 指向
批次目录的会话，不依赖 client 投影同步（相比 `connectWorkspace` 更可靠）。

## 3. 工作区域（`workspace.*`）

源码：`api/workspace.ts`（`WorkspaceApi`）。

| method | payload | 返回 value | 说明 |
| --- | --- | --- | --- |
| `workspace.list` | `{}` | `{ items: WorkspaceView[]; archivedSessionIds: SessionId[] }` | 全部工作区 + 归档集合 |
| `workspace.create` | `{ path }` | `{ workspace: WorkspaceView; created: boolean }` | 注册已有目录为工作区（不 mkdir）；已拥有则幂等返回 |
| `workspace.rename` | `{ workspaceId; title }` | `{ workspace }` | 重命名 |
| `workspace.delete` | `{ workspaceId }` | `{ deleted: true }` | 删注册（目录/文件/会话日志保留，会话变未分组） |
| `workspace.insertBefore` | `{ workspaceId; beforeWorkspaceId? }` | `{ workspaceIds }` | 工作区排序 |
| `workspace.insertSessionBefore` | `{ workspaceId; sessionId; beforeSessionId? }` | `{ workspace }` | 会话在工作区内排序 |
| `workspace.archiveSession` | `{ sessionId }` | `{ archivedSessionIds }` | 归档会话（保留日志与归属槽位） |

`WorkspaceView`：`{ workspaceId, path, title, sessionIds, createdAt, updatedAt }`。
**注意**：Host 侧 `workspaceRegistry.create()` 返回的实体字段是 `id`（不是
`workspaceId`）；wire 层的 `WorkspaceView` 才是 `workspaceId`。mock 插件 Host 半边
读 `ws.id`，wire 层回 `workspaceId`。

## 4. 事件流（`events.*`）—— 流式响应

源码：`api/events.ts`（`EventsApi`）。GET 长连接，`AsyncIterable` 帧。

| method | 说明 |
| --- | --- |
| `events.mux` | 全会话聚合 mux 流；打开时先发每个会话的 `session/subscribed`，再重放 pending 审批/提问帧 |
| `events.host` | Host 级流：会话创建/销毁、运行状态翻转、agent 失败 |

`MuxFrame`（判别联合，`type` 字段区分）：

| type | 载荷要点 | 说明 |
| --- | --- | --- |
| `session/event` | `{ sessionId; event; view? }` | 原始会话事件流（chunk/tool/用户消息等） |
| `session/subscribed` | `{ sessionId; lastSeq }` | 订阅基线（当前最后 seq） |
| `approval/requested` / `approval/resolved` | 审批请求/结果 | 可答复交互 |
| `question/requested` / `question/resolved` | 提问/回答 | 可答复交互 |
| `session/queue` | `{ sessionId; items }` | 待发 inbox 全量快照 |
| `session/jobs` | `{ sessionId; jobs }` | 后台任务全量快照 |
| `session/projection` | `{ sessionId; key; value; seq }` | 投影单元变更（higher-seq-wins） |
| `stream/error` | `{ error }` | 流错误 |

`HostFrame`：`host/session-added`（含 cwd/blank/lineage）、`host/session-status`
（running 翻转）、`host/agent-error`、`host/workspace-changed`、`host/workspace-removed`、
`host/workspace-order-changed`、`host/archived-sessions-changed` 等。

## 5. Host 域（`host.*`）

源码：`api/host.ts`（`HostApi`）。

| method | payload | 返回 value | 说明 |
| --- | --- | --- | --- |
| `host.describe` | `{}` | `{ version; cwd; provider?; model?; attachedSessions; canOpenPath }` | Host 快照 |
| `host.pickDirectory` | `{}` | `{ path: string \| null }` | 系统目录选择器（native 能力） |
| `host.listDirectory` | `{ path? }` | `DirectoryListing` | 列目录（browse 能力；缺省列 home） |
| `host.createDirectory` | `{ path; name }` | `{ path }` | 建子目录（browse 能力） |
| `host.openPath` | `{ path }` | `{ opened: true }` | 系统默认程序打开 |

## 6. 其他域

| method | payload | 返回 value |
| --- | --- | --- |
| `subagent.list` / `subagent.history` / `subagent.prompt` / `subagent.interrupt` | 子代理相关 | 见 `api/subagents.ts` |
| `skill.list` | `{ sessionId }` | `{ skills: SkillEntry[] }` |
| `agentPreset.list` / `select` / `read` / `copy` / `openDocument` / `remove` | 预设管理 | 见 `api/agent-presets.ts` |
| `goal.create` / `edit` / `pause` / `resume` / `complete` / `clear` | `{ sessionId; ref; ... }` | 见 `api/goals.ts` |
| `settings.describe` / `openDocument` / `update` / `replace` / `mutate` | 设置 | 见 `api/settings.ts` |
| `credentials.describe` / `set` / `unset` | 凭据 | 见 `api/credentials.ts` |
| `llm.providers` / `models` / `discoverModels` | LLM 目录 | 见 `api/llm.ts` |

## 7. mock 插件使用要点（实战结论）

- **创建批次会话（落「未分组」）**：`POST /api/session.create { cwd: <批次目录> }`
  原子创建 cwd 指向批次目录、但**无 workspace 归属**的会话 → 默认会话面板归入
  「未分组」。返回 `sessionId` 后调客户端 `sessions.open(sessionId)` 打开。
  不要用 `connectWorkspace`（有 client 投影同步时序窗口，刚注册的 workspace 会
  找不到）；不需要 workspace 注册。
- **会话历史（轨迹）**：`POST /api/session.history { sessionId }`，事件流含
  `permission/preset`、用户/assistant 消息、工具调用等；也可订阅 `events.mux` 拿实时流。
- **实时进度**：流 `events.mux` 监听 `session/event` 的 `turn/end`；轮询兜底用
  `session.history`，状态概览用 `session.list`（session 是否 running）。
- **目录（产物）**：`POST /api/host.listDirectory { path }`（或插件自带
  `/mock/list-directory` 走 `fs.listDir`，二者等价）。
- **方法名是单数**：`session.*`（不是 `sessions.*`）、`workspace.*`、`host.*`。
- **prompt 附件限制**：`session.prompt` 的 `content` 只支持 `{type:'text'}` 与
  `{type:'image', data: base64}`（仅 png/jpeg/webp/gif，需模型声明 image 模态）；
  没有文件/PDF 上传 API。要让 agent 读 PDF 等文件：把文件复制进会话 cwd
  （mock 场景 = 批次目录），在 prompt 文本里引用相对路径，agent 用自己的
  shell 工具（如 `pdftotext`）提取——mock 插件的 `mock.prepare-case-assets`
  走的就是这条路。
- **Host 侧实体字段**：`workspaceRegistry.create()` 返回 `{ id, path, title, sessionIds }`；
  wire 层 `WorkspaceView` 用 `workspaceId`。
