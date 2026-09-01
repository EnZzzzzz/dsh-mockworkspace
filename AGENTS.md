# AGENTS.md — dsh 插件开发指南

本文件面向在本仓库工作的 Agent 与开发者，详细说明 **dsh（DeepSeek Harness）动态插件**（Dynamic Cordis Plugin）的开发方法：核心概念、开发工作流、Host/Client 平台选择、编码约束、生命周期管理、调试与修复。

> 本仓库是 dsh 插件实验场：`runtime-plugin/host.js` 与 `runtime-plugin/client.js` 是直接交给 `cordis_define` 的插件源码原文，`packaged/` 是正式打包版本，可对照阅读作为参考实现。

---

## 1. dsh 插件是什么

dsh 的运行时（Host）基于 Cordis 组合（composition）构建：**每个能力都是一个插件行**。插件有两类：

- **静态插件**：写在 `cordis.yml` 组合文件里，随宿主启动加载（服务注册表、沙箱、模型路由、子代理后端等共享能力都属此类）。修改它需要遵循 `editing-cordis-compositions` 技能。
- **动态插件（Dynamic Cordis Plugin）**：通过会话内的 `cordis_define` + `cordis_run` 临时挂载到当前运行进程，**不修改仓库源码、不落盘、进程重启即消失**。本指南专讲这一类。

动态插件适合：临时扩展当前运行的 harness —— 注册 Host 服务/事件/动态 Tool、在浏览器页面（Client）注入 UI、实现 Client→Host 的私有 RPC 等。

### 关键身份

| 术语 | 含义 |
| --- | --- |
| `pluginId` | 插件实例的稳定 ID（新插件只提交 3–6 个小写英文字母前缀，Host 分配最终 ID）。 |
| `packageId` | 某一个**不可变**代码版本。改代码必须追加新 Package，绝不覆盖旧版本。 |
| `pluginRunId` | 一次激活尝试的 ID，关联审批、加载、错误与 Run 卡片。 |
| `currentPackageId` | 最近一次**完整成功**的版本。 |
| `nextPackageId` | 待审批 / 正在激活 / 激活失败的目标版本。 |

---

## 2. 标准开发工作流

每次开发或修改插件，按以下顺序执行（前两步是硬性要求，先查证真实接口再写代码，**绝不凭名字猜 API**）：

1. **`cordis_inspect_list`** —— 列出当前 Host 与 Client 上已注册的所有 Inspect Provider（`Service` / `Event` / `Builtin` / `Slots` / `Theme` / `Tool`），拿到方法签名与输入输出 schema。
2. **`cordis_inspect_query`** —— 用上一步返回的精确 provider/method，查证实现将要使用的具体 Service 方法、Event 模式、Builtin 签名、Slot 注册协议、主题 token 或 Tool schema。Provider 名与方法名必须以 list 结果为准，不要硬编码。
   - `Service.listService` 不带参数查全部服务的紧凑签名目录，再带 `service` 查精确契约。
   - `Event.listEvents` 同理；查精确事件时注意其分发模式与监听器签名（Waterfall 必须调用 `next()`）。
   - `Slots.listSubTree` 不带 `root` 查紧凑的 Slot 用途/拓扑树，再带精确 `root` 查该 Slot 的完整注册契约（协议是 `single` / `list` / `keyed` / `chain`、注册选项、标准 props、占用者与替换风险）。
   - `Tool.listTools` 查当前 Agent 实际可见的 Tool schema，注册动态 Tool 前先查重。
3. **设计第一个 Package**：确定 Host 半边、Client 半边或两者都要，写纯 JavaScript。
4. **`cordis_define`** 提交代码（只定义、不运行；返回 `pluginId` 和 `packageId`）。新插件用 `kind: "new"` 只给语义前缀；修改已有插件用 `kind: "existing"` 带原 `pluginId`。
5. **`cordis_run`** 激活。首次激活/重启当前/回滚用 `run`；从当前版本切换到另一版本用 `update`。
6. 处理审批、等待、Client 渲染失败：状态来自 Run 卡片、steering 消息或 `cordis_inspect_self`。
7. 临时停用用 `cordis_stop`（保留定义、授权、版本指针）；彻底删除只在确认不再需要时用 `cordis_undefine`。

**不要在同一个回合内等待用户审批或异步浏览器结果。** `cordis_run` 返回 `awaiting-approval` 或 `starting` 后立即结束当前 Tool 流程，等系统通过状态更新与 steering 报告最终结果。

---

## 3. 平台选择：Host 还是 Client

| 需求 | 首选平台 | 先查证 |
| --- | --- | --- |
| 文件、命令、进程、网络 | Host | Host `Service.listService` 中的 `fs` / `shell` / `subprocess` / `pty` / `web` |
| Agent、会话持久数据、Host 生命周期 | Host | 相关 Service + `Event.listEvents` |
| 注册下一个模型步骤可调用的动态 Tool | Host | Host `Builtin.listBuiltins` 中的 `harness` + `Tool.listTools` |
| 页面主题、布局、当前页面状态 | Client | `Theme.listTokens` + Client `Service.listService` |
| 会话快照、会话/工作区列表 | Client | 目标 Slot 的标准 props 与 owner props |
| 设置页、侧边栏、输入区、覆盖层、Tool 卡片 | Client | `Slots.listSubTree` |
| Host 取数、Client 展示 | 两者 | Host Service + `harness.handle`；Client Slot + `host.call` |

原则：**选择离数据所有者最近的平台**。Slot props 已提供的数据（如会话快照）就不要再到 Host 重复取；只改自己包内样式就别覆盖全局主题；只需要一个小入口就别替换整个产品 UI 区域。

---

## 4. 编码约束（重要）

`code.host` 与 `code.client` 都是**返回 Cordis Plugin 的纯 JavaScript 函数体**，不经过 TypeScript / JSX / bundler 转译。

**禁止使用：**

- `import`、`require`、TypeScript 类型、`as`、装饰器、JSX；
- 未在 `Builtin.listBuiltins` 中确认的全局变量 —— 不要假设 `process`、`Buffer`、`window`、`document`、`fetch`、原生定时器存在；
- Client 的 React 代码必须用 `React.createElement(...)`，**绝不能写 `<Component />`**。

```js
// 正确
return {
  apply(ctx) {
    const slots = ctx.get('slots')
    if (slots === undefined) return
    slots.inject('tool.view.cordis', () => slots.register(
      { name: 'tool.view.cordis', key: 'self' },
      () => React.createElement('div', null, 'Hello'),
    ))
  },
}

// 错误：JSX 不可用；且 apply() 不能把 React Element 作为插件返回值 ——
// UI 必须注册在查证过的 Slot 里
return {
  apply(ctx) {
    return <div>Hello</div>
  },
}
```

---

## 5. 访问服务（Service）

默认用 `ctx.get(name)` 读取可选能力并处理 `undefined`：

```js
return {
  apply(ctx) {
    const service = ctx.get('serviceName')
    if (service === undefined) return
    service.someMethod()
  },
}
```

只有该服务是**硬依赖**（插件必须进入 waiting，等服务出现后由 Cordis 重新激活）时才声明 `inject`：

```js
return {
  inject: ['requiredService'],
  apply(ctx) {
    ctx.requiredService.someMethod()
  },
}
```

**两个高频错误：**

- 没声明 `inject` 就访问 `ctx.xxx` → Guard 报 `service "x" is not declared`。改成 `ctx.get('x')` 加判空，或声明真正的硬依赖。
- 为了省一个判空就滥用 `inject`。可选能力一律 `ctx.get`。

---

## 6. 副作用与生命周期

插件的每个副作用必须能在 stop / update / undefine 时被移除。**优先使用 Cordis 生命周期 API：**

- 事件监听用 `ctx.on()`；
- 外部订阅用 `ctx.effect()`（回调返回 disposer）；
- Cordis 的 Service / Tool / Slot / timer / theme API 返回的 disposer 必须保留；
- 绝不在 `apply()` 之外、模块作用域创建进程级/页面级副作用。

```js
return {
  apply(ctx) {
    const service = ctx.get('serviceName')
    if (service === undefined) return
    ctx.effect(() => service.subscribe((value) => {
      console.log(value)
    }))
  },
}
```

若 `subscribe()` 不返回 disposer，先查证该 Service 是否提供官方清理机制，不要假设 unload 会自动移除第三方回调。

---

## 7. 定时器（Timer）

两个平台上的定时器都是名为 `timer` 的 **Service**（不是 Builtin），接口相同。使用前先通过对应平台的 `Service.listService` 查询 `{ "service": "timer" }`，并在 `inject` 中声明。

```js
// 一次性延时
return {
  inject: ['timer'],
  apply(ctx) {
    const onClick = () => {
      ctx.timeout(() => console.log('done'), 300)
    }
    // 把 onClick 传给查证过的 Slot UI
  },
}

// React 组件里的周期任务
return {
  inject: ['timer'],
  apply(ctx) {
    function Clock() {
      React.useEffect(() => ctx.interval(() => console.log('tick'), 1000), [])
      return React.createElement('div', null, 'Running')
    }
    // 把 Clock 注册进查证过的 Slot
  },
}
```

错误示范：没声明 timer 依赖就调用 `ctx.timeout(...)`；或直接用不存在的全局 `setTimeout(...)`。

---

## 8. 监听事件（Event）

先用 Event Provider 查证平台、参数顺序、返回值与 `mode`。

普通 emit 事件：

```js
return {
  apply(ctx) {
    ctx.on('some/event', (payload) => {
      console.log(payload)
    })
  },
}
```

Waterfall 事件的最后一个参数是 `next`，除非有意截断下游处理，**必须调用并返回它**：

```js
return {
  apply(ctx) {
    ctx.on('some/waterfall', (payload, next) => {
      console.log(payload)
      return next()
    })
  },
}
```

---

## 9. Client UI：注册到 Slot

1. 先 `Slots.listSubTree`（不带 `root`）从紧凑的用途/拓扑树里选目标 Slot，**再带 `root` 查精确契约**：注册协议、选项、props、占用者与替换风险。
2. 用 `ctx.get('slots')` 并判空，然后用 `slots.inject` 等待 Slot 声明、在其回调里 `slots.register`：

```js
return {
  apply(ctx) {
    const slots = ctx.get('slots')
    if (slots === undefined) return
    slots.inject('target.slot', () => slots.register(
      { name: 'target.slot', id: 'my-view' },
      (props) => React.createElement('div', null, String(props.someValue)),
    ))
  },
}
```

**不要乱猜** `id` / `key` / selector / props —— 必须按查证的 Slot 协议来。**不要默认替换**根级 `root` / `sidebar` / `conversation` / `details` 之类的大 Slot：替换整个占用者会连带移除它声明的所有子 Slot。

### 常见入口选择

| 想要的效果 | 注册到 | 注意 |
| --- | --- | --- |
| 在最新 `cordis_run` Run 卡片里放交互 UI | `tool.view.cordis`，`key: 'self'` | `self` 运行时会绑定到 `pluginId + packageId`，不要掺入 `pluginRunId`；同版本多次运行只显示在最新卡片 |
| 完整设置页 | `settings.section` | 拿到完整内容区；`settings.general.item` 只适合一条紧凑的通用偏好 |
| 普通 Tool 的调用卡片 | `tool.call.toolview` | key 是 Tool 名；注册已存在的 key 会替换产品默认卡片，先查 `Tool.listTools` 确认 |
| 小侧边栏动作 | 加性内层 Slot（如 `sidebar.footer.action`） | 不要替换整个 sidebar |
| 会话回合后的补充内容 | `conversation.chat.turnTail` | 按其返回的 chain selector 与降级规则注册 |
| toast、状态条、全框覆盖层 | `shell.overlay` | 先查其 pointer-events 与层级规则，再决定可拖拽性、显隐方式与层级 |

动态插件是临时、进程级的，其设置 UI **不需要持久化存储**，瞬态交互状态放内存即可。

---

## 10. 主题与样式

按作用范围决定方式：

1. **全局主题**：先 `Theme.listTokens` 查 token，再通过 Client `Service.listService` 查 `{ "service": "theme" }`；按查询要求提供明/暗两套值，保留返回的 disposer。
2. **只改本包组件**：用 `styles.insert(css)`，颜色优先用主题 CSS 变量。
3. **新增可见内容**：先选 Slot，再决定用局部 CSS 还是全局 token。

不要操作 `document.body`、`window` 或硬编码的产品 DOM 选择器。theme Service 只改 token 不建 UI，Slot 建 UI 但不替代主题系统。

---

## 11. Host ↔ Client 私有通信（RPC）

Host 用 `harness.handle(method, handler)` 注册 **Package 私有** JSON 方法，Client 用 `host.call(method, args)` 调用。方向是 Client→Host，**只允许无损 JSON** 穿越。

Host：

```js
return {
  apply(ctx) {
    harness.handle('read-state', async (args) => {
      return { value: args.key }
    })
  },
}
```

Client：

```js
return {
  async apply(ctx) {
    const result = await host.call('read-state', { key: 'demo' })
    console.log(result.value)
  },
}
```

禁止传递函数、React Element、类实例、Context、Service 等运行时对象；无返回数据时返回 `null`。**不要**为包内私有通信注册公开 Remote Service 或使用 `ctx.remote`。

---

## 12. 注册动态模型 Tool

Host 可用 `harness` 注册下一个模型步骤可调用的 Tool。先查 Host `Builtin.listBuiltins` 里的 `harness` 签名，再用 `Tool.listTools` 查现有 Tool 名与 schema 以避免冲突。Tool 参数与返回值必须 JSON 兼容；`execute` 负责业务结果，render/展示只管模型与原生 UI 能看到的东西。Tool 注册必须归属当前插件 Fiber，stop/update 后自动移除。

---

## 13. 内部活数据（live data）处理

Service 实例、Event payload、Slot props、Session/Conversation 快照、Tool 状态等都是**内部活数据**：

- 不要对其调用 `JSON.stringify` / `structuredClone`；
- 不要递归枚举、整体复制或整体展示；
- 不要把 Host 对象放进插件长期状态或 RPC 返回值。

只读取当前功能需要的叶子字段，取出最小标量集后再构造自己拥有的 JSON 对象。

---

## 14. 版本、审批与修复

### `cordis_run` 模式选择

| 当前状态 | 目标 | mode |
| --- | --- | --- |
| 无 current | 该插件下任意 Package | `run` |
| 有 current | 同一个 Package | `run` |
| 有 current | 另一个 Package | `update` |
| update 失败 | `nextPackageId` | `update` 重试 |
| update 失败 | `currentPackageId` | `run` 回滚 |

### 审批语义

- 未授权的 Client Package 返回 `awaiting-approval`；**不要等待、重试或声称它在运行**，向用户说明需要在 UI 里允许或拒绝。
- 单勾授权仅当前 Package；双勾授权该插件未来所有版本。技术失败后授权仍然有效。
- 已授权的 Package 返回 `starting` 并在浏览器异步完成；`starting` 不等于成功，等系统报告最终结果。
- 用户拒绝后**不要再请求审批**；技术失败则修同一个插件重试，不要另建同名替代。

### 技术失败后的修复流程

1. `cordis_inspect_self(pluginId, packageId)` 读失败版本的源码与精确诊断（message/stack）。
2. 若涉及未知能力，重新 list + query 对应 Provider。
3. 在**同一插件**下 define 新 Package（不覆盖失败版本）。
4. 用新 `packageId` 以正确模式 `run`/`update`。

注意：update 失败不会自动恢复旧版本运行，需要恢复时显式 `run currentPackageId` 回滚。

---

## 15. 修改已有插件（@pluginId 场景）

用户以 `@pluginId` 引用插件时，注入的上下文只有身份、版本指针和默认基础 Package，**没有源码**。修改步骤：

1. `cordis_inspect_self(pluginId, packageId)` 读基础 Package 源码。
2. 保留不需要改的 Host 或 Client 半边，只改目标代码。
3. `cordis_define` 用 `kind: "existing"` + 原 `pluginId` 追加新 Package。
4. 用返回的 `packageId`；存在 current 时通常用 `update` 激活。

若引用不可用（被删除、属于其他 Session、进程重启丢失），直接向用户说明，**不要**另建同名插件。

---

## 16. 常见错误速查表

| 报错 / 现象 | 先查什么 |
| --- | --- |
| `service "x" is not declared` | 是否没声明 `inject` 就访问 `ctx.x`；改用 `ctx.get('x')` 判空或声明硬依赖 |
| `cannot get property "timer" without inject` | 查 timer Service 并声明 `inject: ['timer']` |
| Client 解析失败 | 是否用了 JSX、TypeScript、import 或不可用全局 |
| Slot 注册失败 | 是否查过活子树、Slot 是否存在、选项/key/selector 是否符合返回的协议 |
| UI 加载了但页面报错 | 查 `client-render` 诊断与 stack；错误归属某个精确 Run，需 define 新 Package 修复 |
| `host.call` 失败 | Host handler 名、当前 `pluginRunId`、JSON 参数、handler 内部真实 Service 依赖 |
| update 失败 | 保持 current/next 语义：修 next 再 update，或 run current 回滚 |
| 插件想持久化配置 | 动态插件不落盘；用用户级配置文件（如 `~/.dsh/*.json`）经 `fs` 服务读写（参考本仓库 `runtime-plugin/host.js` 的 CONFIG_PATH 做法），或交给正式打包版 |

---

## 17. 本仓库参考实现

- `runtime-plugin/host.js` —— 插件 Host 半边源码（直接可作 `code.host` 提交）。示范了：`ctx.get` 判空取可选服务、`fs` 读写用户级配置文件、`shell` 执行命令、workspace 注册、纯 JS 无 import。
- `runtime-plugin/client.js` —— 插件 Client 半边源码（`code.client`）。示范了：`ctx.get('slots')` + `slots.inject`/`slots.register` 在侧边栏注册 tab、`React.createElement` 组件树、localStorage 守卫式读写、`host.call` 调 Host。
- `packaged/` —— 同一插件的正式打包版（有 `process.env` 等完整运行时能力），对比阅读可理解动态插件与正式包的差异。
- `docs/backend-api.md` —— 后端 API 说明。

开发新插件时，优先复用这两个文件里已验证的写法（判空模式、注册模式、RPC 模式），保持风格一致。
