# artifact-hub — Mock 实验场产物托管服务

在 mock workspace 里起一个**独立零依赖 Node 服务**，把会话产出的前端实验
（纯 HTML / React(Vite) / Node 全栈 / 自定义命令）托管成可访问的 URL，
并自带管理页：**左边渲染产物，右边看生成它的会话轨迹**。

## 启动

```sh
node artifact-hub/server.mjs
# 管理页 → http://127.0.0.1:4780/
```

| 环境变量 | 默认 | 说明 |
| --- | --- | --- |
| `ARTIFACT_HUB_PORT` | `4780` | Hub 端口（只绑 127.0.0.1） |
| `DSH_API` | `http://127.0.0.1:62274` | dsh apiproxy 基址（轨迹数据源） |
| `MOCK_ROOT` | `~/.dsh/mock-workspace.json` 的 `root`，退回 cwd | mock 根目录 |

## 产物发现

扫描 `<mock 根>/runs/<batchId>/`（只认带 `meta.json` 的批次目录，即 Mock 实验场
插件创建的批次），每个**产物根目录**命中以下任一规则：

| 规则 | kind | 托管方式 |
| --- | --- | --- |
| 含 `index.html` | `static` | Hub 直接伺服：`http://127.0.0.1:4780/preview/<id>/`（含 SPA 回退） |
| 含 `package.json` + `scripts.dev/start` | `node` | 分配独立端口（49100+）spawn 子进程；缺 `node_modules` 先自动 `npm install`；等端口就绪后标 running |
| 含 `artifact.json` | 声明为准 | 自定义，见下 |

产物 id = 相对 `runs/` 的路径（跨批次唯一）。检出产物根后不再向下递归；
`node_modules`、`.git` 等目录跳过。

### artifact.json（显式声明，覆盖自动检测）

放在产物根目录：

```json
{
  "name": "道路反馈后端",
  "kind": "command",
  "command": "python3 -m uvicorn app.main:app --host 127.0.0.1 --port {port}",
  "readyPath": "/"
}
```

- `kind: "static"`：按静态目录伺服（可不带 command）
- `kind: "command"`：Hub 用 shell 执行 `command`，`{port}` 替换为分配端口
  （同时注入 `PORT` / `HOST` 环境变量），轮询 `readyPath` 判定就绪
- 适合 Python/Go/Rust 后端、或 npm 之外的任何起服务方式

### Node 产物启动命令推断

| 依赖特征 | 命令 |
| --- | --- |
| `vite` / `@vitejs/plugin-react` | `npm run dev -- --port <port> --host 127.0.0.1 --strictPort` |
| `next` | `npm run dev -- -p <port> -H 127.0.0.1` |
| 其他（express/koa 等） | `npm run dev` 或 `npm start`，注入 `PORT=<port> HOST=127.0.0.1` |

动态产物直接用 `http://127.0.0.1:<port>/` 作为 URL（iframe 渲染、新标签打开
都走直连），避免 Vite HMR / WebSocket 经路径前缀代理的问题。

## 轨迹关联

产物 → 批次目录 → 会话：调 dsh apiproxy `session.list`，按 **cwd 前缀匹配**
批次目录（与 Mock 实验场插件同一规则）；轨迹内容走 `session.history`，
服务端滤掉 `assistant/chunk` 等噪音事件后映射成时间线：

- `user/message` → 用户消息
- `assistant/message` → 助手回复（reasoning 折叠）
- `tool/call` + `tool/result`（按 callId 配对）→ 工具卡片（可展开参数/结果）
- `turn/start` / `turn/end` → 轮次分隔

会话处于 running 时管理页每 4s 自动增量刷新轨迹。

## 用例库（benchmark prompts）

全局 prompt 用例库，**不属于任何批次**（批次是用例的运行结果）。语义层三层
抽象：**CaseSet（用例集）→ Case（用例）**，**Importer（导入器）= parser +
字段映射**——只在导入时存在，落库即规范形态，之后所有消费方只认一种 schema；
支持新 benchmark = 新增一个字段映射，不动存储与消费侧。

Case 规范形态（导入时归一化）：

```
{ id, setId, sourceRef, prompt, language, tags[], meta{}, attachments[] }
```

- `prompt`：唯一必填的一等公民
- `sourceRef`：源数据集原始 id（去重 + 回溯纽带），缺失时取 prompt 的 FNV 哈希
- `tags`：扁平筛选维度（从映射指定列抽取）
- `meta`：**不透明袋子**——原始行其余列原样保留，schema 不解释（评测/分析时取数）
- `attachments`：配套资源文件（如产业报告 PDF），`[{name, size, mime, stored}]`；
  `stored` 是相对 case-library 目录的库内路径

存储：**SQLite**（`node:sqlite` 内置，零依赖，需 Node ≥22.5），单文件
`<mock 根>/case-library/library.db`（WAL 模式，重启不丢）。四张表：
`sets` / `cases`（`PRIMARY KEY (set_id, source_ref)` 即去重约束）/
`case_tags`（标签筛选与计数的连接表）/ `case_attachments`（附件登记，
`PRIMARY KEY (set_id, case_id, name)`）。旧版 `<setId>/{set.json, cases.jsonl}`
目录在首次打开 DB 时自动迁移入库（幂等），原文件保留作历史备份。

附件文件本体在 `<mock 根>/case-library/attachments/<setId>/<caseId>/<name>`——
挂载时**复制**进库（源文件移动/删除不影响用例）；同名同 size 复用不重复复制，
同名异 size 加 `-2` 后缀；删除用例集时连带删除 `attachments/<setId>/` 目录。

```
GET  /api/library/sets
POST /api/library/preview     { path|content, fileName?, format? } → 列名+样例行+猜测映射（不写盘）
POST /api/library/import      { path|content, name?, setId?, mapping{ promptColumn, refColumn?, languageColumn?, tagColumns?[], attachmentColumn? } }
                              → { set, imported, skipped, attached, missingFiles }
GET  /api/library/cases?setId=&tag=&q=&ids=&offset=&limit=   （limit ≤ 200；`ids` 为逗号分隔的用例 id 过滤，可省略 setId）
POST /api/library/delete-set  { setId }
POST /api/library/attach      { setId, caseId, paths: [绝对路径...] } → { attachments, errors }
POST /api/library/detach      { setId, caseId, name } → { attachments }
GET  /api/library/attachment-file?setId=&caseId=&name=   → 附件内容（inline 伺服，预览/下载）
```

- 解析器：CSV（RFC-4180：引号/转义/字段内换行）/ JSONL / JSON（数组或
  `{data|items|rows:[]}`）；格式省略时按扩展名猜，退回 csv
- 映射自动猜测：prompt 列认 `query_text/prompt/question/input/query/…`，
  标签列认 `l\d+_label/platform/category/domain/…`，附件列认
  `attachments/files/resources/assets/documents/…`，可在面板导入表单里改
- 附件列：单元格按 `;` 或换行分隔多个文件路径；path 导入时相对路径相对
  数据集文件所在目录解析，content 导入（粘贴文本）时仅接受绝对路径；
  单文件 ≤ 128MB，复制进库并登记 case_attachments
- 重复导入同一 `setId` 按 `sourceRef` 去重合并；不指定 `setId` 则按名称生成
  唯一 slug 建新集；附件登记对已存在用例同样执行（幂等，重复导入可补齐附件）
- 路径导入安全边界：仅允许 HOME、mock 根及其**父目录**（benchmark 数据集常与
  mock 根并列），拒绝 `.ssh/.aws/.gnupg` 等敏感目录与 `*.pem/*.key` 密钥文件；
  额外白名单用 `ARTIFACT_HUB_IMPORT_ROOTS`（冒号分隔）追加。
  `attach` 端点与导入附件列走同一套边界校验

管理入口：Mock 实验场侧边栏面板「用例库」卡片（集选择 + 标签筛选 + 两步
导入表单：解析 → 字段映射 + 样例预览 → 确认导入；用例行展开可手动挂载/移除
附件，点附件名新标签预览）。「用该用例开跑」时附件由插件 Host 复制进批次
目录 `assets/` 并在 prompt 末尾追加材料清单（dsh prompt API 只支持文本与
图片，文件走会话 cwd 传递）。

## 用例迭代（会话归档时间线）

会话归档（Mock 实验场批次会话行的「归档」按钮，Host 只写文件不依赖 Hub）
落在 `<mock 根>/case-library/archives/<batchId>/<时间戳>/`：

```
archives/<batchId>/<ts>/
├── record.json      ← { archiveId, batchId, batchName, sessionId, caseId,
│                        caseSetId, promptHash, archivedAt, artifacts[],
│                        kind, sourceSessionId?, note? }
├── <name>-dist/     ← React 构建产物快照（dist/ 复制）
└── <name>-site/     ← 静态产物快照（index.html 根复制）
```

`kind` 区分两类记录：`archive`（终点归档，sessionId 是原会话）与
`snapshot`（会话中途快照，sessionId 是 fork 出的快照会话，轨迹已冻结；
`note` 是用户备注）。快照条目的「继续对话」分叉的是快照会话
（fork-of-fork），快照本身保持不变。

- `GET /api/iterations?caseId=` → 归档条目（时间倒序），管理页按用例聚合
- `GET /archive/<batchId>/<ts>/<snapshotDir>/...` → 快照静态伺服（越界校验同 /preview）
- `POST /api/iterations/fork { sessionId }` → 调 dsh apiproxy `session.fork`
  分叉会话（继承上下文 + cwd），供「继续对话」恢复现场继续迭代

## 管理页布局

```
┌──────────────────────────────────────────────────────────┐
│ 🧪 Artifact Hub                    mock 根 · dsh api     │
├─────────┬───────────────────────────────┬────────────────┤
│ 产物栏   │ 工具栏：状态点 名称 启动/停止  │ 会话选择 +     │
│ (批次    │ URL 栏                        │ 轨迹时间线     │
│  分组)   │ iframe 渲染 / 进程日志        │ (自动刷新)     │
└─────────┴───────────────────────────────┴────────────────┘
```

## HTTP API

| 端点 | 说明 |
| --- | --- |
| `GET /api/state` | 全量状态：批次 + 产物 + 运行时（status/url/port/logTail） |
| `POST /api/artifacts/start` `{id}` | 启动（静态幂等返回 URL） |
| `POST /api/artifacts/stop` `{id}` | 停止（进程组 SIGTERM → SIGKILL） |
| `GET /api/artifacts/log?id=` | 子进程日志（环形缓冲尾部 200 行） |
| `GET /api/trajectory?batchId=` | 批次关联会话列表 |
| `GET /api/trajectory/events?sessionId=` | 简化轨迹时间线 |
| `GET /api/library/*` | 用例库（benchmark prompts），见上节 |
| `GET /preview/<id>/...` | 静态产物伺服 |

## 安全边界

- 只监听 `127.0.0.1`；只读 mock 根内文件；预览路径做 `..`/越界校验
- 子进程独立进程组，Hub 退出（SIGINT/SIGTERM）时全部清理
- Hub 重启后不接管旧进程（状态为内存态），原占用端口会被分配逻辑跳过

## 已知限制（MVP）

- 无鉴权（仅限本机 loopback 使用）
- 轨迹分页固定拉最近 2000 条消息；超长会话只显示尾部
- Node 产物非 vite/next 时只注入 `PORT`，不认 `PORT` 的老式服务需用
  `artifact.json` 显式声明 command

## Agent / CLI 调用

新增 `mock-workspace` CLI，安装与完整命令见 [CLI 文档](../cli/README.md)。
Hub 补充 `POST /api/tasks/create`、`POST /api/iterations/create`、
`POST /api/iterations/snapshot`，支持无需浏览器创建任务、归档和快照。
启动已有服务时需重启加载新接口；这些操作需要 dsh 后端在线。
