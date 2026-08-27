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
| `mock.delete-batch` | `{ path, workspaceId }` | 删注册 + rm -rf 目录（仅限 mock 根内） |
| `mock.list-directory` | `{ path }` | 列目录（产物树） |
| `mock.open-hub` | – | 打开产物托管页（artifact-hub，macOS `open`） |
| `mock.start-hub` | `{ dshApi }` | nohup 后台拉起 artifact-hub/server.mjs（日志 `artifact-hub/hub.log`），`DSH_API` 取面板 `location.origin`，curl 轮询就绪 |

面板头部另有**地球图标按钮**：打开 artifact-hub 管理页，右侧状态点实时显示
Hub 在线状态（轮询 `http://127.0.0.1:4780/api/state`）。

面板另有「用例库」卡片：benchmark prompt 用例集导入（CSV/JSONL/JSON，两步
字段映射表单）+ 标签筛选浏览，数据存 mock 根 `case-library/`；以及「接口
Mock」卡片：接口级 Mock 用例 CRUD + 开关，数据存批次目录 `mock-cases.json`，
由 artifact-hub 伺服为 `/m/<batchId>/<path>` 真实接口。

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
