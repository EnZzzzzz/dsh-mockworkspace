---
name: mock-workspace
description: 使用 Mock Workspace CLI 管理测试用例和附件、创建 dsh 实验任务、查询执行结果并创建归档或会话快照。适用于试用 Mock Workspace 或自动化已有实验流程；不用于开发 Cordis 插件或泛指创建代码工作区。
---

# Mock Workspace

通过 `mock-workspace` CLI 调用 Artifact Hub。任务对应一个批次目录、一个 dsh 会话及首次提示词。遵循用户指定的用例、模型和操作范围；仅安装或查看能力时不启动实验。

## 连接与发现

先运行：

```sh
mock-workspace schema
mock-workspace state --timeout 10000
```

`schema` 是命令与参数的实际目录；`state` 验证 Hub 可达。默认 Hub 地址为 `http://127.0.0.1:4780`，可通过 `MOCK_WORKSPACE_URL` 或 `--url` 指定。连接成功不代表 dsh 后端可用。

CLI 需要 Node ≥22.5。如果命令不存在，在已知的仓库路径运行 `node /path/to/dsh-mockworkspace/cli/index.mjs ...`；需要安装时从仓库运行 `npm install -g ./cli`。Skill 本身不包含 CLI 或服务。缺少仓库/服务地址时说明缺失项，不猜测本机目录，也不安装同名的未知 npm 包。

已有 Hub 无法识别新增任务/快照接口时，检查部署版本。启动 Hub 的命令是 `MOCK_ROOT=/absolute/mock/root DSH_API=http://127.0.0.1:62274 node artifact-hub/server.mjs`（在仓库根执行）；使用已有的实际配置，不擅自切换数据根或重启用户服务。

## 输入与结果

- CLI 选项用 kebab-case；`--data` 中的 JSON 用 camelCase。长提示词使用 `--data @request.json` 或 `--data -`，避免 shell 插值改变正文。
- 成功 stdout 为 `{ok:true,value:...}`；失败 stderr 为 `{ok:false,error:...}` 且退出码为 1。`schema` 直接返回 `{commands:...}`。
- 保存返回的真实 ID，不根据名称拼接 setId、caseId、batchId、sessionId 或 archiveId。
- `value.warning`、附件的 `value.errors`、导入的 `missingFiles` 需要一并检查；退出码 0 可能包含部分失败。
- 写操作超时或断线时，服务可能已完成写入。先查 `task list`、`task sessions` 或 `archive list`；任务失败信息中的 batchId/sessionId 是恢复线索，不盲目重建任务。

## 用例和附件

```sh
mock-workspace set list
mock-workspace case list --set-id SET_ID --limit 50 --offset 0
mock-workspace case add --name cli-trial --source-ref trial-001 --prompt '创建一个纯 HTML 计数器页面，保存为 index.html' --tags '["trial"]'
```

首次添加省略 setId 会新建用例集，读取返回的 `value.set.id`。然后 `case list --set-id SET_ID --q trial-001`，从 `value.cases` 中按 sourceRef 精确选中并取得 `id`。已有集追加用例时传 `--set-id`。同集按 sourceRef 去重；未指定时按 prompt 哈希去重。重复导入不会更新旧用例。

查询按 `value.total`、`offset`、`limit` 分页，每页最多 200；搜索 q 是 prompt/sourceRef 的子串匹配，并非唯一键查询。

批量导入先 `case preview --path /absolute/cases.csv` 查看列名，再 `case import --data @import.json`；JSON 至少包含 `path` 或 `content`，以及 `mapping.promptColumn`。按实际列填写 `refColumn`、`tagColumns`、`attachmentColumn`。

```sh
mock-workspace case attach --set-id SET_ID --case-id CASE_ID --paths '["/absolute/spec.pdf"]'
mock-workspace case detach --set-id SET_ID --case-id CASE_ID --name spec.pdf
```

这些路径属于 Hub 所在机器，需符合服务导入目录白名单。附件复制进库后不依赖源文件；任务启动时再复制到批次 `assets/`。当前没有单条用例编辑/删除命令；`set delete` 删除整集及附件，仅在用户要求删除对应集时使用。

## 开跑与观察

用已有用例创建任务：

```sh
mock-workspace task create --set-id SET_ID --case-id CASE_ID --name cli-trial
```

或直接 `task create --data @task.json`，文件如：

```json
{"name":"cli-trial","prompt":"创建一个纯 HTML 计数器页面，保存为 index.html"}
```

指定模型时同时传 `--provider` 和 `--model`；Agent 预设使用 `--agent-preset`，推理强度使用 `--reasoning-effort`。仅使用用户提供或已查证的标识；未指定则采用 dsh 默认值。

记录 `value.batchId`、`batchPath`、`sessionId`。`accepted:true` 只是已提交提示词，不表示任务完成。

```sh
mock-workspace task sessions --batch-id BATCH_ID
mock-workspace task events --session-id SESSION_ID
mock-workspace task list
```

结合会话 running 状态和轨迹确认本次提示词已执行、轮次结束及是否有错误。提交后短暂 `running:false` 可能尚未开始，不可单凭这个值宣布完成。运行较久时适度轮询并报告进度；出现等待审批/提问时向用户说明实际状态，不代替用户作未授权的选择。`task list` 返回含 batches/artifacts 的 Hub 全量状态，不是单独的任务列表。

## 快照、归档和继续

轮次结束、会话不运行且产物不再写入时：

```sh
mock-workspace snapshot create --batch-id BATCH_ID --session-id SESSION_ID --note '试用结果'
mock-workspace archive list --case-id CASE_ID
```

快照构建/复制产物、分叉会话冻结轨迹、保存记录并隐藏分叉会话；源会话可继续使用。读取返回 `value.record.archiveId` 和快照 `sessionId`，在 archive list 中核对记录。

用户要求终点归档时用 `archive create --batch-id BATCH_ID --session-id SESSION_ID`：它保存记录并隐藏原会话。构建失败不生成成功记录；非网页任务允许 artifacts 为空。默认构建请求超时为 30 分钟。

`archive fork --session-id FROZEN_SESSION_ID` 创建可继续对话的会话，但不会发送提示词；不要把它报告为已重新开跑。`archive delete` 只允许删除无页面快照的记录，不能用作通用清理手段。

需要预览时，从 `state` 获取真实 artifact id，再 `artifact start --id ARTIFACT_ID`；用 `artifact log` 排查失败，用 `artifact stop` 停止对应进程。

## 试用交付

用户要求完整试用且未指定内容时，可采用上面的纯 HTML 计数器用例：新建专用试用集、添加用例、创建一个任务、确认执行结果、创建一个快照并查询验证。用户指定的范围优先，例如仅测试用例管理时无需开跑。不要自动删除试用数据或额外归档源会话。

报告实际完成的操作、相关 ID、产物/快照结果以及未完成原因。区分“已提交”“已完成”“已保存快照”；不能用 CLI 成功返回代替产物质量检查。
