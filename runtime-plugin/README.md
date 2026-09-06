# dsh-mock-workspace — Mock 实验场运行时插件

在 dsh 左侧边栏新增第三个 tab **「Mock 实验场」**（图标：烧杯），用于管理
「命名工作区」实验场：每个实验是一个**批次 batch**（`runs/<batchId>/`
独立目录），打开**普通对话会话**（轨迹 = DSH 会话日志，产物 = 会话生成的文件）。

## 核心概念

```
dsh-mockworkspace/                       ← Mock 根（当前会话工作区）
└── runs/
    ├── 20250825-143000-abc12/           ← 批次 batch（= 一个实验）
    │   ├── meta.json                    ← { batchId, name, createdAt, status }
    │   └── …会话产物（前端工程、页面）…
    └── 20250825-150200-def34/
```

| 层 | 是什么 | 怎么产生 |
| --- | --- | --- |
 批次 batch | 命名的工作区 | 面板「+ 新建」输入名字 → Host 建目录 + 写 meta.json + 注册 workspace 
| 会话 | 普通 DSH 会话，cwd = 批次目录 | 复用 `connectWorkspace`，对话框/多 Agent/日志全免费 |
| 轨迹 | DSH 会话日志 | 原生，「打开会话」即达 |
| 产物 | 会话在批次目录里生成的文件 | 面板内目录树懒加载 |

## 交互方式

面板**只做入口与组织，不做自动执行**：点「+ 新建」输入名字，
会创建独立目录并打开一个 cwd 指向它的空白对话会话，然后就是正常的对话框，
你和 Agent 自由对话干活。

## 面板功能

- 头部：刷新 + 「+ 新建」
- 批次列表：名字 / 会话数，按时间倒序
- 展开批次：
  - **会话（轨迹）**：点击打开；右键分叉
  - **存快照**（相机按钮）：会话中途冻结当前效果 —— fork 出快照会话
    （轨迹冻结副本，改名「快照 · …」后归档隐藏）+ Host 复制当前产物快照 +
    写 record.json（`kind:'snapshot'`）；原会话不受打扰继续对话。
    会话 running 时禁用（产物是瞬态）
  - **产物**：懒加载目录树，点文件用系统默认程序打开
  - 操作：**归档**（meta.status → archived，目录保留）、**删除**（workspace 注册
    + 目录 + meta 全部移除，需二次确认）

## Host RPC

| method | args | 作用 |
| --- | --- | --- |
| `mock.ensure-root` | – | 确保 mock 根 + `runs/` 存在 |
 `mock.create-batch` | `{ name }` | 建目录 + meta.json + 注册 workspace 
| `mock.list-batches` | – | 列出全部批次（含 meta、workspaceId、sessionIds） |
| `mock.archive-batch` | `{ path }` | 批次置为 archived |
| `mock.prepare-case-assets` | `{ batchPath, files: [{stored, name}] }` | 用例附件落盘：把库内附件（`case-library/attachments/`，防越界）复制进批次 `assets/`（重名加后缀），落盘相对路径并入 meta.json `assets`（幂等），随归档 record.json 冻结 |
| `mock.archive-session` | `{ sessionId, batchPath }` | 扫产物快照 + 写 record.json；扫描无果时自动找含 `scripts.build` 的前端项目 install + build 后重扫（诊断记入 record.json `builds`，失败不阻断） |
| `mock.snapshot-session` | `{ sessionId, sourceSessionId, batchPath, note? }` | 会话中途快照：与归档共用产物管线，record 带 `kind:'snapshot'` / `sourceSessionId` / `note`；sessionId 是 Client fork 出的快照会话，原会话不归档 |
| `mock.delete-batch` | `{ path, workspaceId }` | 删注册 + rm -rf 目录（仅限 mock 根内） |
| `mock.list-directory` | `{ path }` | 列目录（产物树） |
| `mock.open-hub` | – | 回退：打开产物托管页（artifact-hub，macOS `open`） |
| `mock.start-hub` | `{ dshApi }` | nohup 后台拉起 artifact-hub/server.mjs（日志 `artifact-hub/hub.log`），`DSH_API` 取面板 `location.origin`，curl 轮询就绪 |

面板「产物托管」卡片另有**地球图标按钮**：打开**「用例结果」悬浮窗**
（`shell.overlay`，id `mock-cases`，order 20，任何界面可用、标题栏可拖动）。
窗口内是静态用例卡片视图，**只显示有归档结果的用例**（归档驱动、按最近归档
倒序）：每用例一张卡片（sourceRef/用例集徽标/标签/prompt），点开展开历史会话
记录（归档时间线）——「预览」在内置浏览器打开快照（复用同一预览 Tab），
「轨迹」在窗口内展开执行时间线。数据直连 Hub JSON API（`/api/library/
cases?ids=…` 按归档 id 取原始信息），不加载 Hub 管理页前端。

面板另有「用例库」卡片：benchmark prompt 用例集导入（CSV/JSONL/JSON，两步
字段映射表单，支持附件列）+ 标签筛选浏览，数据存 mock 根 `case-library/library.db`
（SQLite）。用例行展开可手动挂载/移除配套资源文件（如 PDF），「用该用例
开跑」时附件复制进批次 `assets/` 并在 prompt 末尾追加材料清单。

安全边界：所有目录操作经 `insideMockRoot()` 校验，只允许 mock 根（含 `runs/`）内
的路径；删除前二次确认。

## 运行与验证

```sh
# 定义（code.host / code.client 分别取 host.js / client.js 内容）
#   cordis_define  idPrefix: mock  → mock-1/pkg-N
# 运行（需 GUI 审批）
#   cordis_run mock-1 pkg-N run
# 验证槽位注册（权威）
#   cordis_inspect_query client / Slots / listSubTree root=sidebar.activity
#   cordis_inspect_query client / Slots / listSubTree root=sidebar.panel
```

## 已知限制（MVP）

- 批次下会话按 `workspaceRegistry` 的 `sessionIds` 归组；若 workspace 注册失败，
  会话仍可 cwd 指向批次目录，但列表不显示（后续版本用 cwd 前缀兜底）。
- 暂无 TTL 自动清理（V2）、暂无对比视图（V2）、暂无统计/磁盘占用。
- 动态插件仅注入当前会话页面，进程重启后消失；需要常驻时迁移到
  dsh-slide-bar 的 `plugin/` 或 `packaged/` 形态。
