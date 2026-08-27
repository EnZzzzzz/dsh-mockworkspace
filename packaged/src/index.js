/**
 * dsh-mock-workspace host half (formal installable package).
 *
 * 批次管理 RPC 通道 `/mock`：与 dsh-sidebar-live 的 `/preview-fs` 相同的
 * package-private loopback channel（connection.rpc.handle），浏览器半边用
 * plain fetch 以 createWebConnectionRpc 的消息形状调用，无需 typert 代码生成。
 *
 * 职责：
 *   - get-config / set-config：mock 根目录的持久化配置（~/.dsh/mock-workspace.json）
 *   - ensure-root：确保 mock 根 + runs/ 存在
 *   - create-batch：mkdir + meta.json + workspaceRegistry.create
 *   - list-batches：runs 下各批次 meta.json + workspace 关联
 *   - archive-batch / delete-batch / list-directory
 *
 * 服务均为可选读取（ctx.get + undefined 检查）；mkdir/rm 走 shell 服务，
 * 元数据读写走 fs 服务，注册走 workspaceRegistry。所有目录操作限 mock 根内。
 */

import { readFile } from 'node:fs/promises'

export function apply(ctx) {
  const errorText = (err) => (err && err.message ? String(err.message) : String(err))

  // 默认 mock 根：优先当前会话工作区根，退回 mock 仓库常量。
  const FALLBACK_ROOT = '/Volumes/DataDrive/proj/my/dsh-mockworkspace'
  // 配置持久化路径（用户级）：~/.dsh/mock-workspace.json → { root: "/abs/path" }
  const CONFIG_PATH = (typeof process !== 'undefined' && process.env && process.env.HOME)
    ? process.env.HOME.replace(/[/\\]+$/, '') + '/.dsh/mock-workspace.json'
    : null

  // ---- 路径工具 ----
  function workspaceRootFallback() {
    const sandboxPolicy = ctx.get('sandboxPolicy')
    if (sandboxPolicy && typeof sandboxPolicy.workspaceRoot === 'string' && sandboxPolicy.workspaceRoot !== '') {
      return sandboxPolicy.workspaceRoot
    }
    return FALLBACK_ROOT
  }

  // 内存缓存 + 文件配置读写。mockRoot() 同步返回缓存或默认值；配置的加载/保存
  // 在 apply 时异步预热（失败静默，退回默认），set-config 时同步写缓存再落盘。
  let cachedRoot = null
  let configReady = false

  function mockRoot() {
    if (cachedRoot !== null && cachedRoot !== '') return cachedRoot
    return workspaceRootFallback()
  }

  async function loadConfig() {
    if (configReady) return
    configReady = true
    if (CONFIG_PATH === null) return
    const fs = ctx.get('fs')
    if (fs === undefined) return
    try {
      const target = await fs.resolve(CONFIG_PATH)
      const info = await fs.stat(target)
      if (info === undefined) return
      const text = await fs.readText(target)
      const parsed = JSON.parse(text)
      if (parsed && typeof parsed.root === 'string' && parsed.root !== '') {
        cachedRoot = parsed.root.replace(/[/\\]+$/, '')
      }
    } catch (err) {
      // 配置读取失败静默：使用默认根
    }
  }

  async function saveConfig(root) {
    if (CONFIG_PATH === null) throw new Error('无法定位用户配置目录（HOME 不可用）')
    const fs = ctx.get('fs')
    if (fs === undefined) throw new Error('fs 服务不可用，无法保存配置')
    cachedRoot = root.replace(/[/\\]+$/, '')
    configReady = true
    const target = await fs.resolve(CONFIG_PATH)
    await fs.writeText(target, JSON.stringify({ root: cachedRoot }, null, 2))
  }

  function joinPath(base, name) {
    return base.replace(/[/\\]+$/, '') + '/' + String(name)
  }
  function insideMockRoot(targetPath) {
    const root = mockRoot().replace(/[/\\]+$/, '')
    if (typeof targetPath !== 'string') return false
    const t = targetPath.replace(/[/\\]+$/, '')
    return t === root || t.startsWith(root + '/')
  }

  // ---- mkdir（shell 服务跑 mkdir -p） ----
  async function mkdirp(dirPath) {
    const shell = ctx.get('shell')
    if (shell === undefined) throw new Error('shell 服务不可用，无法创建目录')
    const request = { command: 'mkdir -p "' + dirPath.replace(/"/g, '\\"') + '"' }
    let spec
    try {
      spec = shell.resolve(request)
    } catch (err) {
      spec = request
    }
    const result = await shell.run(spec)
    if (result.exitCode !== 0) {
      throw new Error('创建目录失败: ' + errorText(result.stderr || result.stdout || 'unknown'))
    }
  }

  // ---- fs 目标工具（按需读取，避免 apply 时 fs 未挂载被冻结为 undefined） ----
  async function resolveTarget(path) {
    const fs = ctx.get('fs')
    if (fs === undefined) throw new Error('fs 服务不可用')
    return fs.resolve(path)
  }
  async function statExists(path) {
    try {
      const fs = ctx.get('fs')
      if (fs === undefined) return false
      const target = await resolveTarget(path)
      const info = await fs.stat(target)
      return info !== undefined
    } catch (err) {
      return false
    }
  }

  // ---- 批次元数据 ----
  function metaPath(batchDir) {
    return joinPath(batchDir, 'meta.json')
  }
  async function writeMeta(batchDir, meta) {
    const fs = ctx.get('fs')
    if (fs === undefined) throw new Error('fs 服务不可用')
    const target = await resolveTarget(metaPath(batchDir))
    await fs.writeText(target, JSON.stringify(meta, null, 2))
  }
  async function readMeta(batchDir) {
    try {
      const fs = ctx.get('fs')
      if (fs === undefined) return null
      const target = await resolveTarget(metaPath(batchDir))
      const info = await fs.stat(target)
      if (info === undefined) return null
      const text = await fs.readText(target)
      const parsed = JSON.parse(text)
      return parsed && typeof parsed === 'object' ? parsed : null
    } catch (err) {
      return null
    }
  }

  // ---- 目录列取（产物树） ----
  const MAX_ENTRIES = 500
  async function listDirectory(path) {
    const fs = ctx.get('fs')
    if (fs === undefined) return { ok: false, error: '文件系统服务不可用' }
    if (typeof path !== 'string' || path === '') return { ok: false, error: '未提供目录路径' }
    let target
    try {
      target = await fs.resolve(path)
    } catch (err) {
      return { ok: false, error: errorText(err) }
    }
    let raw
    try {
      raw = await fs.listDir(target)
    } catch (err) {
      return { ok: false, error: errorText(err) }
    }
    const entries = []
    for (const e of raw) {
      if (e.type !== 'file' && e.type !== 'directory') continue
      entries.push({
        name: e.name,
        path: (e.target && e.target.displayPath) || e.name,
        kind: e.type,
        hidden: e.name.charAt(0) === '.',
      })
    }
    entries.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1
      if (a.name < b.name) return -1
      if (a.name > b.name) return 1
      return 0
    })
    const truncated = entries.length > MAX_ENTRIES
    return {
      ok: true,
      path: (target && target.displayPath) || path,
      entries: truncated ? entries.slice(0, MAX_ENTRIES) : entries,
      truncated,
    }
  }

  // ---- RPC 通道 ----
  ctx.inject(['connection'], (apiCtx) => {
    return apiCtx.connection.rpc.handle('/mock', async (endpoint, payload, _signal) => {
      const args = payload || {}
      try {
        switch (endpoint) {
          case 'get-config': {
            return {
              ok: true,
              rootPath: mockRoot(),
              configPath: CONFIG_PATH,
              configured: cachedRoot !== null,
            }
          }
          case 'set-config': {
            const root = typeof args.root === 'string' ? args.root.trim() : ''
            if (root === '') return { ok: false, error: '请输入目录路径' }
            // 目录不存在则先创建（用户级 mock 根允许自动建目录）
            if (!(await statExists(root))) await mkdirp(root)
            await saveConfig(root)
            return { ok: true, rootPath: mockRoot(), configPath: CONFIG_PATH }
          }
          case 'ensure-root': {
            const root = mockRoot()
            const runs = joinPath(root, 'runs')
            if (!(await statExists(runs))) await mkdirp(runs)
            return { ok: true, rootPath: root, runsPath: runs }
          }
          case 'create-batch': {
            const name = typeof args.name === 'string' ? args.name.trim() : ''
            if (name === '') return { ok: false, error: '请输入名称' }

            const now = new Date()
            const pad = (n, w) => String(n).padStart(w, '0')
            const stamp = pad(now.getFullYear(), 4) + pad(now.getMonth() + 1, 2) + pad(now.getDate(), 2)
              + '-' + pad(now.getHours(), 2) + pad(now.getMinutes(), 2) + pad(now.getSeconds(), 2)
            const rand = Array.from({ length: 5 }, () => 'abcdefghijklmnopqrstuvwxyz0123456789'.charAt(Math.floor(Math.random() * 36))).join('')
            const batchId = stamp + '-' + rand
            const batchPath = joinPath(joinPath(mockRoot(), 'runs'), batchId)

            await mkdirp(batchPath)

            const meta = {
              batchId,
              name,
              createdAt: Date.now(),
              status: 'active',
            }
            await writeMeta(batchPath, meta)

            // 不注册 workspace：会话由后端 session.create({ cwd }) 创建，cwd 指向
            // 批次目录但没有 workspace 归属，默认会话面板把它们归入「未分组」。
            return { ok: true, batchId, batchPath, meta }
          }
          case 'list-batches': {
            const runs = joinPath(mockRoot(), 'runs')
            const batches = []
            if (await statExists(runs)) {
              const target = await resolveTarget(runs)
              const fs = ctx.get('fs')
              const raw = await fs.listDir(target)
              for (const e of raw) {
                if (e.type !== 'directory') continue
                const dirPath = (e.target && e.target.displayPath) || e.name
                const meta = await readMeta(dirPath)
                if (meta === null) continue
                batches.push({
                  batchId: meta.batchId || e.name,
                  path: dirPath,
                  meta,
                  sessionIds: [],
                })
              }
            }
            // 按 cwd 前缀匹配批次下的会话（live-preferred，含持久化会话）。
            // 会话由后端 session.create({ cwd }) 创建，无 workspace 归属，
            // 归入「未分组」；本面板按 cwd 关联到批次。
            const sessionQuery = ctx.get('sessionQuery')
            if (sessionQuery !== undefined) {
              try {
                const records = await sessionQuery.listSessions()
                for (const batch of batches) {
                  const prefix = batch.path.replace(/[/\\]+$/, '')
                  batch.sessionIds = records
                    .filter((r) => {
                      const cwd = r && r.header && r.header.cwd
                      return typeof cwd === 'string' && (cwd === prefix || cwd.startsWith(prefix + '/'))
                    })
                    .map((r) => r.header.id)
                }
              } catch (err) {
                // 会话匹配失败不阻断：批次仍列出，仅会话数为空
              }
            }
            batches.sort((a, b) => ((b.meta && b.meta.createdAt) || 0) - ((a.meta && a.meta.createdAt) || 0))
            return { ok: true, rootPath: mockRoot(), runsPath: runs, batches }
          }
          case 'archive-batch': {
            const path = typeof args.path === 'string' ? args.path : ''
            if (!insideMockRoot(path)) return { ok: false, error: '路径不在 mock 工作区内' }
            const meta = await readMeta(path)
            if (meta === null) return { ok: false, error: '未找到批次元数据' }
            meta.status = 'archived'
            await writeMeta(path, meta)
            return { ok: true, path, meta }
          }
          case 'delete-batch': {
            const path = typeof args.path === 'string' ? args.path : ''
            if (!insideMockRoot(path)) return { ok: false, error: '路径不在 mock 工作区内' }
            const shell = ctx.get('shell')
            if (shell === undefined) return { ok: false, error: 'shell 服务不可用，无法删除目录' }
            // 会话由 session.create({ cwd }) 创建，无 workspace 注册，无需清理注册表。
            const request = { command: 'rm -rf "' + path.replace(/"/g, '\\"') + '"' }
            let spec
            try {
              spec = shell.resolve(request)
            } catch (err) {
              spec = request
            }
            const result = await shell.run(spec)
            if (result.exitCode !== 0) {
              return { ok: false, error: '删除目录失败: ' + (result.stderr || result.stdout || 'unknown') }
            }
            return { ok: true, path }
          }
          case 'list-directory': {
            const path = typeof args.path === 'string' ? args.path : ''
            if (!insideMockRoot(path)) return { ok: false, error: '路径不在 mock 工作区内' }
            return listDirectory(path)
          }
          default:
            return { ok: false, error: 'unknown mock endpoint: ' + String(endpoint) }
        }
      } catch (err) {
        return { ok: false, error: errorText(err) }
      }
    }, { authority: 'loopback' })
  })

  // ---- 官方 composer 解锁：内存补丁 conversation bundle（不落盘） ----
  // 官方 ConversationRoot 把「有会话但无 workspace 归属」的空白会话判为
  // inert（composer 退化成只读 workspace 选择器）。正常 UI 建不出这种状态，
  // 只有本插件 session.create({ cwd }) 的批次会话会命中；bar 的发送链路全部
  // 挂在 session 上，不碰 workspace。
  // 这里注册 exact 路由（webServer 路由匹配 exact 优先于 client-modules 的
  // /plugins 前缀路由），把 bundle 响应在内存里去掉 inert 的
  // `hero && chipTitle === void 0` 臂并留下 marker。浏览器半边探测该 marker：
  // 有则不注册手写接管框（官方 composer 已可用）；锚点漂移（dsh 升级后表达式
  // 变了）时此处原样透传、探测不到 marker，自动回退手写接管框兜底。
  const COMPOSER_PKG = '@deepseek-ai/dsh-client-ui-conversation'
  const INERT_ANCHOR = 'sessionId === void 0 || hero && chipTitle === void 0'
  const INERT_MARKER = 'dsh-mock-workspace:composer-unlocked'
  const INERT_REPLACEMENT = `sessionId === void 0 /* ${INERT_MARKER} */`
  // 工作区 chip 置灰：mock 空白会话（有 cwd、无 workspace 归属）不允许再选
  // 工作区——选择会把会话 attach 进工作区、脱离「未分组」，与 mock 设计冲突。
  // 官方 UI 建不出「有 cwd 但无 workspace 归属」的会话，该条件即 mock 会话。
  // 三处锚点缺一不可（原子替换）；任一漂移则整组跳过，chip 恢复原行为。
  const CHIP_MARKER = 'dsh-mock-workspace:workspace-chip-locked'
  const CHIP_SIG_ANCHOR = 'function WorkspaceChip({ buttonRef, label, menuOpen = false, onClick, t }) {'
  const CHIP_SIG_REPLACEMENT = `function WorkspaceChip({ buttonRef, label, menuOpen = false, onClick, t, disabled = false }) { /* ${CHIP_MARKER} */`
  const CHIP_PROP_ANCHOR = '"aria-expanded": menuOpen,'
  const CHIP_PROP_REPLACEMENT = '"aria-expanded": menuOpen, disabled, title: disabled ? "Mock 会话固定使用批次目录，不可更换工作区" : void 0, style: disabled ? { opacity: 0.45 } : void 0,'
  const CHIP_CALL_ANCHOR = 'label: chipTitle,'
  const CHIP_CALL_REPLACEMENT = 'label: chipTitle, disabled: sessionWorkspace === void 0 && cwd !== void 0 && cwd !== "",'
  ctx.inject(['webServer'], (webCtx) => {
    return webCtx.webServer.register({
      kind: 'exact',
      path: '/plugins/' + COMPOSER_PKG + '/client.js',
      handler: async (req, res) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.writeHead(405)
          res.end()
          return
        }
        try {
          // 惰性解析：clientModules 启动顺序无关，且升级后自动跟随新 bundle。
          const modules = ctx.get('clientModules')
          const bundlePath = modules && typeof modules.clientPath === 'function'
            ? modules.clientPath(COMPOSER_PKG)
            : undefined
          if (bundlePath === undefined) throw new Error('clientModules 未解析到 ' + COMPOSER_PKG)
          let src = await readFile(bundlePath, 'utf8')
          if (!src.includes(INERT_MARKER) && src.includes(INERT_ANCHOR)) {
            src = src.replace(INERT_ANCHOR, INERT_REPLACEMENT)
          }
          if (!src.includes(CHIP_MARKER)
            && src.includes(CHIP_SIG_ANCHOR)
            && src.includes(CHIP_PROP_ANCHOR)
            && src.includes(CHIP_CALL_ANCHOR)) {
            src = src
              .replace(CHIP_SIG_ANCHOR, CHIP_SIG_REPLACEMENT)
              .replace(CHIP_PROP_ANCHOR, CHIP_PROP_REPLACEMENT)
              .replace(CHIP_CALL_ANCHOR, CHIP_CALL_REPLACEMENT)
          }
          res.writeHead(200, {
            'content-type': 'text/javascript; charset=utf-8',
            'cache-control': 'no-cache',
          })
          res.end(req.method === 'HEAD' ? undefined : src)
        } catch (err) {
          res.writeHead(500)
          res.end('// dsh-mock-workspace: conversation bundle 补丁伺服失败: ' + errorText(err))
        }
      },
    })
  })

  // 预热持久化配置（失败静默，退回默认根）。
  void loadConfig()
}
