# dsh-mock-workspace — 正式安装包（持久化，重启后自动生效）

把 `runtime-plugin/`（动态插件）包装成**正式安装的 dsh 插件包**：通过 profile
bundle 机制装进 web profile，重启 dsh 后自动加载，不再依赖会话内的
`cordis_define`/`cordis_run`。侧边栏出现第三个 tab **「Mock 实验场」**。

## 与动态插件（runtime-plugin）的差异

| 项 | 动态插件 | 本包 |
| --- | --- | --- |
| Host RPC | `harness.handle` + `host.call` | `connection.rpc.handle('/mock', …)` + `fetch('/mock/<endpoint>')`（loopback channel，消息形状同 createWebConnectionRpc） |
| 样式 | `styles.insert(CSS)` | 手动 `<style data-plugin="dsh-mock-workspace">` 注入（`insertCss`） |
| React | runner 闭包 `React` | 闭包工厂内 `require('react')`（loader 模块表） |
| 持久化 | 无（重启即失） | **写入 web profile，重启后仍在** |
| 注册 | 动态 guard 自动排序 | 显式 `priority: -1`（纯增量，等 dsh-sidebar-live 的 shell 声明槽位后注册） |

本包**只做纯增量**：不重绘 `sidebar`，只往 `sidebar.activity` / `sidebar.panel`
各注册一个 `mock` entry（order 3）。shell（活动栏 + 面板切换）由
`dsh-sidebar-live` 提供，两者并存无冲突。

## 结构

- `src/index.js` — Host 半边：`/mock` loopback RPC 通道（ensure-root /
  create-batch / list-batches / archive-batch / delete-batch / list-directory），
  数据走 `fs` + `shell` + `workspaceRegistry`，所有目录操作限 mock 根内。
- `src/client/index.js` — Client 半边：Mock 实验场面板（新建（一个名字）表单 / 批次
  列表 / 会话轨迹入口 / 产物目录树 / 归档删除），纯 JS，无 import/TS/JSX。
- `build.mjs` — 无工具链构建：把 client 源码包进
  `window.__ModuleLoader__.load({id, factory})` 闭包工厂（`React` 由
  `require('react')` 解析），产出 `lib/client.js`；`lib/index.js` 为 ESM host。
- `cordis.patch.yml` — bundle 层：把本包插入 web-app client roster。
- `package.json` — `dsh.client` + `dsh.bundle.patch` 声明。

## 构建与安装

```sh
cd packaged
/usr/local/bin/node build.mjs     # 产出 lib/index.js + lib/client.js
/usr/local/bin/node --check lib/index.js && /usr/local/bin/node --check lib/client.js

# 安装到 web profile（= dsh plugin add link: 的等价手工步骤）
# 1. ~/.dsh/profiles/web/package.json：
#    dependencies 加  "dsh-mock-workspace": "link:/…/dsh-mockworkspace/packaged"
#    dsh.profile.bundles 追加 "dsh-mock-workspace"
# 2. 建立软链（nodeLinker: hoisted）：
#    ln -sfn ../../../../../../Volumes/DataDrive/proj/my/dsh-mockworkspace/packaged \
#            ~/.dsh/profiles/web/node_modules/dsh-mock-workspace
# 3. 重启 dsh —— 之后每次启动自动加载
```

## 官方 composer 解锁（host 内存补丁，不落盘）

官方 ConversationRoot 把「有会话但无 workspace 归属的空白会话」判为 inert
（composer 退化成只读 workspace 选择器）——正常 UI 建不出这种状态，只有本
插件的批次会话会命中。host 半边注册了一条 exact 路由
`/plugins/@deepseek-ai/dsh-client-ui-conversation/client.js`（webServer 的
路由匹配 exact 优先于 client-modules 的 `/plugins` 前缀路由），把 bundle 响应
**在内存里**去掉 inert 的 `hero && chipTitle === void 0` 臂并留下
`dsh-mock-workspace:composer-unlocked` marker，mock 空白会话因此获得
**完整官方 InputBar**（模型/模式选择、@ 文件、/ 命令、图片附件）。

- 不改磁盘上的任何 dsh 文件；bundle 路径经 clientModules 惰性解析，
  **dsh 升级后自动跟随新 bundle，无需任何手工步骤**。
- 锚点表达式漂移（官方改了 inert 计算）时原样透传官方 bundle；client 半边
  探测不到 marker 会自动回退手写简易输入框兜底，首发消息永远可用。

## 验证

重启后：
- 侧边栏出现第三个烧杯 tab「Mock 实验场」。
- `cordis_inspect_query`（client / Slots / listSubTree，root 分别传
  `sidebar.activity`、`sidebar.panel`）确认新增 `mock` entry `active: true`。
- 点「+ 新建」输入名字 → 创建 `<mock 根>/runs/<id>/`
  （meta.json）并打开普通对话会话。
- 展开批次 → 「+ 新会话」可在该批次目录再开会话。

## 会话归属（重要设计）

**批次目录不注册为 workspace**：mock 会话由后端 `POST /api/session.create
{ cwd: <批次目录> }` 创建，cwd 指向批次目录但**没有 workspace 归属**，因此：

- 默认「会话」面板把 mock 会话归入**「未分组」**，不污染正常工作区列表
- 对话框（composer）正常工作，cwd 语义正确

开会话走**后端公开 API**（dsh `SessionsApi`）：`session.create({ cwd })` 原子创建
（不依赖 client 投影同步），返回 sessionId 后 `sessions.open` 打开。批次→会话的
关联由 `sessionQuery.listSessions()` 按 **cwd 前缀匹配**。

## 根目录设置

Mock 根目录**可配置**，持久化在 `~/.dsh/mock-workspace.json`（`{"root": "/abs/path"}`）：

- 面板头部齿轮按钮 → 设置表单：手输绝对路径或「浏览…」调系统目录选择器 → 保存。
- 未配置时默认根 = 当前会话工作区根（`sandboxPolicy.workspaceRoot`），退回
  `/Volumes/DataDrive/proj/my/dsh-mockworkspace`。
- 批次保存在 `<根>/runs/<batchId>/`；切换根后旧批次保留在原目录，面板只显示
  新根下的批次。

## 用例库（benchmark prompts）

面板第二张卡片「用例库」：benchmark 测试用例（prompt）的导入与管理。
**导入**按钮打开两步表单：① 数据集绝对路径（推荐大文件）或文件上传 →
「解析」；② 确认字段映射（prompt 列必选，id/语言列可空，标签列勾选，其余
列自动进 meta 不透明保留）+ 样例预览 → 「确认导入」。列表区按用例集 +
标签筛选浏览（sourceRef + prompt 预览，点击展开全文），集可删除（二次确认）。

语义层：CaseSet / Case / Importer，导入时归一化、meta 不透明保留；存储与
API 由 artifact-hub 承载（SQLite：`<mock 根>/case-library/library.db`，详见
`../artifact-hub/README.md` 用例库一节）。自定义 CSV（如
`playground/tubiao_pg/queries.csv`）与公开 benchmark 都走同一个通用结构化
导入器——支持新 benchmark = 一组字段映射。

## 产物托管入口（artifact-hub）

面板「产物托管」卡片的**地球图标按钮**：打开**「用例结果」悬浮窗**（注册在
`shell.overlay`，id `mock-cases`，order 20）——**任何界面可用**（新建会话页 /
对话中都能打开），标题栏可拖动、右上角关闭。窗口内是**静态用例结果展示，
只显示有归档结果的用例**：卡片列表由归档记录（`/api/iterations`）驱动、按
最近归档时间倒序；每个用例一张卡片（原始信息：sourceRef / 用例集徽标 /
标签 / prompt），点开卡片展开该用例的历史会话记录（归档时间线）——点
「预览·xxx」在内置浏览器打开快照（复用同一预览 Tab，不多开），点「轨迹」
在窗口内展开该会话的执行时间线。数据直连 Hub JSON API（用例库
`/api/library/cases?ids=…` 按归档 id 取原始信息），**不加载 Hub 管理页前端、
不弹独立窗口**。Hub 离线时窗口内显示「启动 Hub」按钮。

Hub 离线时该 Tab 显示「启动 Hub」按钮：走 `/mock` 通道的
`start-hub` 端点，Host 以 `process.execPath` + `ELECTRON_RUN_AS_NODE=1`
detached 拉起 `artifact-hub/server.mjs`（独立于 dsh 常驻，日志追加到
`artifact-hub/hub.log`），并把面板页的 `location.origin` 作为 `DSH_API`
传入（apiproxy 端口随 dsh 启动变化，server.mjs 默认值会过期）；启动后
Host 轮询 `GET /api/state` 最长 10s 等待就绪。Hub 的启动与产物发现规则见
`../artifact-hub/README.md`。

## 会话归档 → 用例迭代（追踪用例效果变化）

批次会话行悬停的**「归档」按钮现在是三合一**：

1. **产物归档**：扫批次目录 HTML 产物（构建产物目录认 `dist/`（Vite 等）与
   `out/`（Next.js `output:'export'`），入口优先 `index.html`，否则取字典序首个
   `.html` 静态根），快照复制到 `<mock 根>/case-library/archives/<batchId>/<时间戳>/`
   （跳过 node_modules/.git；批次目录即使删除，归档快照仍在）。
   **扫描无果时自动构建**：找含 `scripts.build` 的前端项目根（lockfile 判定
   pnpm/npm/yarn，缺 node_modules 先 install），跑 `<pm> run build` 后重扫；
   构建诊断（每步命令 + 输出尾部）记入 `record.json` 的 `builds` 字段，
   构建失败不阻断归档（仍落 record，artifacts 为空）
2. **会话记录归档**：写 `record.json`（archiveId / batchId / sessionId /
   caseId / caseSetId / promptHash / archivedAt / 产物清单）——**只写文件，
   不依赖 Hub 在线**，Hub 启动后扫 archives/ 目录即出时间线
3. **原有会话归档**：`workspace.archiveSession` 照旧（日志保留，可恢复）

Hub 管理页新增**「用例迭代 · 归档时间线」**：按用例聚合归档记录，每条带
日期 / 会话 ID / 产物快照，可 **[预览]** 归档快照、**[轨迹]** 看执行历史、
**[继续对话]** 分叉该会话（`session.fork` 继承全部上下文 + cwd，新会话在
Mock 实验场批次下刷新可见）——多轮调优 + 恢复现场的入口。

**用例关联**：用例库右键菜单「用该用例开跑」→ 建批次时 `meta` 写入
`caseId/caseSetId/sourceRef/promptHash`，并开会话 + prompt 预填输入框；
这样归档记录按用例聚合，形成迭代链。普通新建批次照常归档，归入
「未关联用例」。

> 注意：Host 半边改动需**重启 dsh** 生效（client bundle 刷新页面即可）。

## 已知限制（MVP）

- 批次下的会话数来自 `sessionQuery.listSessions()` 的 cwd 匹配，仅统计 live
  或已持久化的会话。
- 暂无 TTL 自动清理、对比视图、统计/磁盘占用。
- 修改源码后重新 `node build.mjs` 并重启 dsh 生效。
