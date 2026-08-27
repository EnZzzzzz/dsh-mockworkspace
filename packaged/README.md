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
API 由 artifact-hub 承载（`<mock 根>/case-library/`，详见
`../artifact-hub/README.md` 用例库一节）。自定义 CSV（如
`playground/tubiao_pg/queries.csv`）与公开 benchmark 都走同一个通用结构化
导入器——支持新 benchmark = 一组字段映射。

## 接口 Mock（接口级 Mock）

面板第三张卡片「接口 Mock」：批次选择器 + 用例列表（开/关切换、METHOD 徽章、
路径、悬停编辑/删除）+ 内联新建/编辑表单（方法、路径、状态码、延迟、期望
响应体、自定义响应头）。数据由 artifact-hub 承载：存批次目录
`mock-cases.json`，启用用例即被伺服为 `http://127.0.0.1:4780/m/<batchId>/<path>`
可调用的 Mock 接口（面板直连 Hub CORS API，不走 Host RPC）。

## 产物托管入口（artifact-hub）

面板头部新增**地球图标按钮**：打开产物托管页（artifact-hub，默认
`http://127.0.0.1:4780/`）。按钮右侧状态点实时反映 Hub 在线状态（15s 轮询
`GET /api/state`，Hub API 带 CORS `*` 头）；点击优先走 Host `/mock` 通道的
`open-hub` 端点（macOS `open` → 系统默认浏览器），失败退回 `window.open`。
Hub 的启动与产物发现规则见 `../artifact-hub/README.md`。

「产物托管」卡片在 Hub 离线时提供**「启动」按钮**：走 `/mock` 通道的
`start-hub` 端点，Host 以 `process.execPath` + `ELECTRON_RUN_AS_NODE=1`
detached 拉起 `artifact-hub/server.mjs`（独立于 dsh 常驻，日志追加到
`artifact-hub/hub.log`），并把面板页的 `location.origin` 作为 `DSH_API`
传入（apiproxy 端口随 dsh 启动变化，server.mjs 默认值会过期）；启动后
Host 轮询 `GET /api/state` 最长 10s 等待就绪。

## 已知限制（MVP）

- 批次下的会话数来自 `sessionQuery.listSessions()` 的 cwd 匹配，仅统计 live
  或已持久化的会话。
- 暂无 TTL 自动清理、对比视图、统计/磁盘占用。
- 修改源码后重新 `node build.mjs` 并重启 dsh 生效。
