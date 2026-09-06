# Mock Workspace CLI

供 Agent 和脚本调用的零依赖 HTTP 客户端。Node ≥22.5。所有数据操作由 Artifact Hub 完成，CLI 不直接修改数据库，也不需要浏览器或动态插件。

## 启动与安装

在仓库根运行（已有 Hub 需要重启以加载新增接口）：

```sh
MOCK_ROOT=/absolute/path/to/mock node artifact-hub/server.mjs
```

Hub 使用 `DSH_API` 指向 dsh 后端，默认 `http://127.0.0.1:62274`；用例管理不依赖 dsh，任务创建和归档/快照需要 dsh 在线。保留仓库的 `artifact-hub/` 与 `packaged/src/archive.js` 相对位置，Hub 复用正式插件的产物构建与收集实现。

另一个终端：

```sh
npm install -g ./cli
mock-workspace --help
mock-workspace schema
```

也可直接 `node cli/index.mjs ...`。默认连接 `http://127.0.0.1:4780`，可用 `MOCK_WORKSPACE_URL` 或 `--url` 覆盖。无需发布 npm 包。

## Agent 调用约定

- 成功：stdout 输出 `{ "ok": true, "value": ... }`，退出码 0。
- 失败：stderr 输出 `{ "ok": false, "error": "..." }`，退出码 1。
- `schema` 输出命令、HTTP 方法、路径、必填/可选参数，适合运行前发现能力。
- CLI 参数使用 kebab-case，如 `--case-id`；JSON 使用 camelCase，如 `caseId`。
- `--data '{...}'`、`--data @request.json`、`--data -` 分别读取内联 JSON、文件、标准输入。显式选项覆盖 JSON 同名字段。长提示词推荐文件/标准输入。
- `--tags`、`--paths`、`--mapping` 的选项值是 JSON；分页使用 `--offset`、`--limit`（每页最多 200）。
- 默认请求超时 1800000 毫秒，可用 `--timeout` 修改。CLI 不自动重试写操作。超时/断线可能发生在服务已经写入后，先查询任务/归档状态再决定是否重试。
- `value.warning` 表示记录已保存但会话隐藏失败。任务创建中途失败会保留批次元数据和已创建的 sessionId，错误文本包含恢复所需 ID。

## 用例管理

```sh
mock-workspace set list
# 不指定 setId 时创建新集；返回 value.set.id，后续使用该 ID
mock-workspace case add --name smoke --prompt '创建一个待办应用' --tags '["web","smoke"]'
mock-workspace case add --set-id smoke --source-ref todo-2 --prompt '增加暗色主题'
mock-workspace case list --set-id smoke --q 暗色 --limit 50 --offset 0
mock-workspace case attach --set-id smoke --case-id CASE_ID --paths '["/absolute/path/spec.pdf"]'
mock-workspace case detach --set-id smoke --case-id CASE_ID --name spec.pdf
mock-workspace case preview --path /absolute/path/cases.csv
mock-workspace case import --path /absolute/path/cases.csv --name benchmark --mapping '{"promptColumn":"prompt","refColumn":"id","tagColumns":["category"]}'
mock-workspace set delete --set-id smoke
```

`case add` 复用导入接口，同集按 sourceRef 去重，省略 sourceRef 则按 prompt 哈希去重；重复添加不会覆盖原用例。`case import` 必须提供 `path` 或 `content`，以及含 `promptColumn` 的 `mapping`。路径属于 Hub 所在机器，受 Hub 导入目录白名单约束。`set delete` 删除整集及附件。当前接口不提供单条用例编辑/删除。

## 创建任务

这里的任务与现有 UI 开跑流程一致：一个新批次目录 + 一个 dsh 会话 + 首条提示词，不是独立的后台调度器。

```sh
mock-workspace task create --name todo --prompt '创建一个待办应用'
mock-workspace task create --set-id smoke --case-id CASE_ID --name experiment --provider PROVIDER --model MODEL --agent-preset PRESET
mock-workspace task list
mock-workspace task sessions --batch-id BATCH_ID
mock-workspace task events --session-id SESSION_ID
```

`task create` 必须提供非空 `prompt`，或同时提供 `setId` 和 `caseId`。用例模式会复制附件到批次 `assets/`，在提示词中追加相对路径；可通过 `prompt` 覆盖用例提示词。指定 `model` 时必须提供 `provider`；不指定则采用 dsh 默认配置。返回 `accepted: true` 仅代表提示词已提交，不代表任务完成；通过 sessions/events 查询进展。`task list` 当前返回 Hub 全量状态（含 batches 和 artifacts）。

## 归档、快照与产物

```sh
mock-workspace archive create --batch-id BATCH_ID --session-id SESSION_ID
mock-workspace snapshot create --batch-id BATCH_ID --session-id SESSION_ID --note '第一轮结果'
mock-workspace archive list --case-id CASE_ID
mock-workspace archive fork --session-id FROZEN_SESSION_ID
mock-workspace artifact start --id ARTIFACT_ID
mock-workspace artifact log --id ARTIFACT_ID
mock-workspace artifact stop --id ARTIFACT_ID
```

归档和快照都检查会话属于该批次，并拒绝正在运行的会话。应在轮次结束后调用，保存期间不要继续修改批次产物。

- `archive create` 构建/复制产物、保存 record.json，然后隐藏原会话。
- `snapshot create` 构建/复制产物、分叉会话以冻结轨迹、保存 record.json，然后隐藏分叉会话；原会话可继续使用。
- 构建失败不生成成功记录、不隐藏源会话。非网页任务可以产生 artifacts 为空的记录。
- `archive fork` 从给定会话创建可继续对话的新会话；不自动提交提示词。
- `archive delete --archive-id BATCH_ID/ARCHIVE_STAMP` 沿用现有约束，仅删除没有页面快照的记录。

## 新增 HTTP 接口

请求/响应与 Hub 原接口一致，POST JSON，成功 `{ok:true,value}`，失败 `{ok:false,error}`。

| 路径 | 请求 |
| --- | --- |
| `/api/tasks/create` | `{prompt?, setId?, caseId?, name?, agentPreset?, provider?, model?, reasoningEffort?}` |
| `/api/iterations/create` | `{batchId, sessionId, note?}` |
| `/api/iterations/snapshot` | `{batchId, sessionId, note?}` |

服务仍只监听本机 127.0.0.1。CLI 其余命令映射见 `mock-workspace schema`，已有端点见 [Hub 文档](../artifact-hub/README.md)。

验证：`node --test cli/*.test.mjs` 使用真实 Hub、临时 SQLite/文件目录和模拟 dsh RPC，覆盖用例添加/标签/附件、任务提交、静态归档、快照分叉、运行中拒绝、路径校验与构建失败。不会调用真实模型。

## 安装试用 Skill

仓库提供 [mock-workspace Skill](../skills/mock-workspace/SKILL.md)，用于让试用 Agent 学会命令发现、用例管理、任务运行、结果检查与快照。Skill 是使用说明，CLI 和 Hub 仍需按上文安装、启动。无需将整个仓库 AGENTS.md 复制给试用 Agent。

Codex 首次安装，在仓库根执行：

```sh
npm install -g ./cli
# 在子 shell 中安装；已有同名 Skill 时退出，避免覆盖本地定制。
(
  skill_parent="${CODEX_HOME:-$HOME/.codex}/skills"
  mkdir -p "$skill_parent"
  if [ -e "$skill_parent/mock-workspace" ]; then
    echo "已有 mock-workspace Skill，请比较后更新：$skill_parent/mock-workspace" >&2
    exit 1
  fi
  cp -R skills/mock-workspace "$skill_parent/mock-workspace"
)
```

安装后在新的 Agent 会话中选择或显式引用 `$mock-workspace`。其他支持 SKILL.md 的 Agent 可将 `skills/mock-workspace/` 整个目录放进各自的技能目录；目录中不含开发者机器的绝对路径。

只检查安装和服务，不开跑任务：

```text
使用 $mock-workspace 检查 CLI 命令和 Hub 连接，列出已有用例集，暂不创建任务。
```

完整试用（会启动一个真实 dsh 任务）：

```text
使用 $mock-workspace 做一次试用：新建专用试用集，添加一个纯 HTML 计数器页面用例，
创建任务，检查执行结果，完成后保存一个快照。保留试用数据，报告真实 ID 和结果。
```

服务地址不为默认值时，先设置 `MOCK_WORKSPACE_URL`，或在请求中提供实际 Hub 地址。安装本身不会启动服务、模型任务或修改用例数据。
