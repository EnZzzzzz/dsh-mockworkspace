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
 *   - archive-session / snapshot-session：会话归档与会话中途快照（产物快照 + record.json）
 *
 * 服务均为可选读取（ctx.get + undefined 检查）；mkdir/rm 走 shell 服务，
 * 元数据读写走 fs 服务，注册走 workspaceRegistry。所有目录操作限 mock 根内。
 */

import { readFile, cp as fscp, mkdir as fsmkdir, readdir as fsReaddir, writeFile as fswriteFile } from 'node:fs/promises'
import { existsSync, openSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { dirname, basename, join as pathJoin, sep as pathSep } from 'node:path'

export function apply(ctx) {
  const errorText = (err) => (err && err.message ? String(err.message) : String(err))

  // 默认 mock 根：优先当前会话工作区根，退回 mock 仓库常量。
  const FALLBACK_ROOT = '/Volumes/DataDrive/proj/my/dsh-mockworkspace'
  // 配置持久化路径（用户级）：~/.dsh/mock-workspace.json → { root: "/abs/path" }
  const CONFIG_PATH = (typeof process !== 'undefined' && process.env && process.env.HOME)
    ? process.env.HOME.replace(/[/\\]+$/, '') + '/.dsh/mock-workspace.json'
    : null
  // 产物托管 Hub（artifact-hub/server.mjs）管理页地址；改端口需与
  // ARTIFACT_HUB_PORT 环境变量保持一致。
  const HUB_URL = 'http://127.0.0.1:4780/'

  // 归档会话时跳过的重目录（node_modules 等，快照只保留可预览产物）。
  const ARCHIVE_SKIP_DIRS = new Set(['node_modules', '.git', '.next', '.turbo', '.cache'])
  const safeSnapName = (s) => String(s || 'dist').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'dist'

  // ---- 自动构建：归档扫描无果时找含 build 脚本的前端项目，install + build 后重扫 ----
  // 包管理器按 lockfile 判定，默认 npm；构建失败不阻断归档（诊断记录进 record.json）。
  const BUILD_PM_LOCKS = [['pnpm-lock.yaml', 'pnpm'], ['package-lock.json', 'npm'], ['yarn.lock', 'yarn']]
  const BUILD_TIMEOUT_MS = 10 * 60 * 1000
  // PATH 补常见 node/npm 目录（同 start-hub：Electron 壳下 process.env.PATH 可能缺）。
  function runBuildCommand(command, cwd) {
    return new Promise((resolve) => {
      const extraPaths = [dirname(process.execPath), '/usr/local/bin', '/opt/homebrew/bin']
      const env = Object.assign({}, process.env, {
        PATH: extraPaths.concat(String(process.env.PATH || '')).join(':'),
      })
      const child = spawn(command, [], { cwd, shell: true, env })
      let output = ''
      const timer = setTimeout(() => { child.kill('SIGKILL') }, BUILD_TIMEOUT_MS)
      child.stdout.on('data', (d) => { output = (output + d).slice(-4000) })
      child.stderr.on('data', (d) => { output = (output + d).slice(-4000) })
      child.on('error', (err) => { clearTimeout(timer); resolve({ code: -1, output: errorText(err) }) })
      child.on('close', (code) => { clearTimeout(timer); resolve({ code: code === null ? -1 : code, output: output.slice(-2000) }) })
    })
  }
  // 找含 scripts.build 的 package.json 所在目录（项目根），命中即停下钻，避免子包重复构建。
  async function findBuildProjects(batchDir) {
    const projects = []
    const walk = async (dir, depth) => {
      if (depth > 3 || projects.length >= 8) return
      let entries
      try { entries = await fsReaddir(dir, { withFileTypes: true }) } catch (err) { return }
      if (entries.some((e) => e.isFile() && e.name === 'package.json')) {
        try {
          const pkg = JSON.parse(await readFile(pathJoin(dir, 'package.json'), 'utf8'))
          if (pkg && pkg.scripts && typeof pkg.scripts.build === 'string' && pkg.scripts.build !== '') {
            projects.push(dir)
            return
          }
        } catch (err) { /* package.json 解析失败按非项目处理，继续下钻 */ }
      }
      for (const d of entries.filter((e) => e.isDirectory())) {
        if (ARCHIVE_SKIP_DIRS.has(d.name) || d.name === 'dist' || d.name === 'out') continue
        await walk(pathJoin(dir, d.name), depth + 1)
      }
    }
    await walk(batchDir, 0)
    return projects
  }
  // 缺 node_modules 时先 install；随后 <pm> run build，输出只留尾部 2000 字符做诊断。
  async function buildProject(dir) {
    let pm = 'npm'
    for (const pair of BUILD_PM_LOCKS) {
      if (existsSync(pathJoin(dir, pair[0]))) { pm = pair[1]; break }
    }
    const steps = []
    if (!existsSync(pathJoin(dir, 'node_modules'))) {
      const inst = await runBuildCommand(pm + ' install', dir)
      steps.push({ step: 'install', command: pm + ' install', ok: inst.code === 0, output: inst.output })
      if (inst.code !== 0) return { dir, pm, ok: false, steps }
    }
    const build = await runBuildCommand(pm + ' run build', dir)
    steps.push({ step: 'build', command: pm + ' run build', ok: build.code === 0, output: build.output })
    return { dir, pm, ok: build.code === 0, steps }
  }

  // ---- 路径工具 ----
  function workspaceRootFallback() {
    const sandboxPolicy = ctx.get('sandboxPolicy')
    // host 平面无会话时 sandboxPolicy.workspaceRoot 是 process.cwd()（Electron
    // 拉起时常为 '/'），对 mock 根无意义且有害（ensure-root 会 mkdir /runs），
    // 只接受非根目录的路径，否则退回 FALLBACK_ROOT。
    const wr = sandboxPolicy && typeof sandboxPolicy.workspaceRoot === 'string'
      ? sandboxPolicy.workspaceRoot.replace(/[/\\]+$/, '')
      : ''
    if (wr !== '' && wr !== '/') return wr
    return FALLBACK_ROOT
  }

  // 内存缓存 + 文件配置读写。mockRoot() 同步返回缓存或默认值；配置的加载/保存
  // 在 apply 时异步预热（失败静默，退回默认），set-config 时同步写缓存再落盘。
  // configLoaded 只在「读到确定结果」（文件存在并已解析，或确认文件不存在）后
  // 置位：fs 未挂载、读取异常等瞬时失败不闩锁，下次 loadConfig 重试——否则
  // 启动瞬间 fs 未就绪会把进程永久卡在默认根上（重启必现「根目录变 /」）。
  let cachedRoot = null
  let configLoaded = false

  function mockRoot() {
    if (cachedRoot !== null && cachedRoot !== '') return cachedRoot
    return workspaceRootFallback()
  }

  async function loadConfig() {
    if (configLoaded) return
    if (CONFIG_PATH === null) return
    const fs = ctx.get('fs')
    if (fs === undefined) return
    try {
      const target = await fs.resolve(CONFIG_PATH)
      const info = await fs.stat(target)
      if (info === undefined) { configLoaded = true; return }
      const text = await fs.readText(target)
      const parsed = JSON.parse(text)
      if (parsed && typeof parsed.root === 'string' && parsed.root !== '') {
        cachedRoot = parsed.root.replace(/[/\\]+$/, '')
      }
      configLoaded = true
    } catch (err) {
      // 配置读取失败静默且不闩锁：使用默认根，下次调用重试
    }
  }

  async function saveConfig(root) {
    if (CONFIG_PATH === null) throw new Error('无法定位用户配置目录（HOME 不可用）')
    const fs = ctx.get('fs')
    if (fs === undefined) throw new Error('fs 服务不可用，无法保存配置')
    cachedRoot = root.replace(/[/\\]+$/, '')
    configLoaded = true
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

  // ---- 归档/快照共用管线：扫批次目录产物 → 快照复制到
  // <mock根>/case-library/archives/<batchId>/<ts>/ → 写 record.json。
  // extra 合并进 record：归档传 { kind:'archive' }；快照传
  // { kind:'snapshot', sourceSessionId, note }（轨迹由 Client fork 冻结，
  // 本管线只冻结产物与记录；fork 不冻结文件，故产物必须此刻复制）。
  async function writeSessionArchive(sessionId, batchPath, extra) {
    const meta = await readMeta(batchPath)
    if (meta === null) return { ok: false, error: '未找到批次元数据' }

    const batchId = (meta && meta.batchId) || basename(batchPath)
    const now = new Date()
    const pad = (n, w) => String(n).padStart(w, '0')
    const ts = pad(now.getFullYear(), 4) + pad(now.getMonth() + 1, 2) + pad(now.getDate(), 2)
      + '-' + pad(now.getHours(), 2) + pad(now.getMinutes(), 2) + pad(now.getSeconds(), 2)
    const archivesRoot = pathJoin(pathJoin(mockRoot(), 'case-library'), 'archives')
    const archiveDir = pathJoin(pathJoin(archivesRoot, batchId), ts)
    await fsmkdir(archiveDir, { recursive: true })

    // 扫描产物根。HTML 入口优先 index.html，否则取字典序首个 .html。
    // 构建产物目录认 dist/（Vite 等）与 out/（Next.js output:'export'）。
    const found = []
    const walk = async (dir, depth) => {
      if (depth > 3) return
      let entries
      try { entries = await fsReaddir(dir, { withFileTypes: true }) } catch (err) { return }
      const files = entries.filter((e) => e.isFile()).map((e) => e.name)
      const htmlEntry = (names) => {
        const html = names.filter((name) => /\.html?$/i.test(name)).sort()
        return html.includes('index.html') ? 'index.html' : (html[0] || '')
      }
      const dirs = entries.filter((e) => e.isDirectory())
      for (const d of dirs) {
        if (d.name !== 'dist' && d.name !== 'out') continue
        const distRoot = pathJoin(dir, d.name)
        let distEntries
        try { distEntries = await fsReaddir(distRoot, { withFileTypes: true }) } catch (err) { distEntries = [] }
        const entryFile = htmlEntry(distEntries.filter((e) => e.isFile()).map((e) => e.name))
        if (entryFile !== '') {
          found.push({ name: basename(dir) || 'dist', kind: 'dist', root: distRoot, entryFile })
          return
        }
      }
      const entryFile = htmlEntry(files)
      if (entryFile !== '') {
        found.push({ name: basename(dir) || 'site', kind: 'static', root: dir, entryFile })
        return
      }
      for (const d of dirs) {
        if (ARCHIVE_SKIP_DIRS.has(d.name)) continue
        await walk(pathJoin(dir, d.name), depth + 1)
      }
    }
    await walk(batchPath, 0)
    // 扫描无果：可能是未构建的前端项目（无 index.html / dist），自动 install + build 后重扫。
    const builds = []
    if (found.length === 0) {
      for (const dir of await findBuildProjects(batchPath)) {
        builds.push(await buildProject(dir))
      }
      if (builds.some((b) => b.ok)) await walk(batchPath, 0)
    }

    const snapshots = []
    for (const a of found) {
      const snapName = a.kind === 'dist' ? safeSnapName(a.name) + '-dist' : safeSnapName(a.name) + '-site'
      const dest = pathJoin(archiveDir, snapName)
      await fscp(a.root, dest, {
        recursive: true,
        filter: (src) => !src.split(pathSep).some((p) => ARCHIVE_SKIP_DIRS.has(p)),
      })
      snapshots.push({ name: a.name, kind: a.kind, snapshotDir: snapName, entryFile: a.entryFile })
    }

    const record = {
      archiveId: batchId + '/' + ts,
      batchId,
      batchName: (meta && meta.name) || batchId,
      sessionId,
      caseId: (meta && meta.caseId) || '',
      caseSetId: (meta && meta.caseSetId) || '',
      promptHash: (meta && meta.promptHash) || '',
      archivedAt: now.toISOString(),
      artifacts: snapshots,
      builds,
    }
    if (extra && typeof extra === 'object') Object.assign(record, extra)
    await fswriteFile(pathJoin(archiveDir, 'record.json'), JSON.stringify(record, null, 2), 'utf8')
    return { ok: true, record }
  }

  // ---- RPC 通道 ----
  ctx.inject(['connection'], (apiCtx) => {
    return apiCtx.connection.rpc.handle('/mock', async (endpoint, payload, _signal) => {
      const args = payload || {}
      // 自愈：apply 预热时 fs 可能未挂载（启动早期），首次真实调用再补一次加载。
      await loadConfig()
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
            // 可选：用例关联（右键用例「用该用例开跑」时写入，供归档时间线按用例聚合）
            if (typeof args.caseId === 'string' && args.caseId !== '') meta.caseId = args.caseId
            if (typeof args.caseSetId === 'string' && args.caseSetId !== '') meta.caseSetId = args.caseSetId
            if (typeof args.sourceRef === 'string' && args.sourceRef !== '') meta.sourceRef = args.sourceRef
            if (typeof args.promptHash === 'string' && args.promptHash !== '') meta.promptHash = args.promptHash
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
          case 'archive-session': {
            // 归档会话（终点归档）：产物快照 + 会话记录（供 Hub「用例迭代」时间线）。
            // 会话隐藏由 Client workspaces.archiveSession 做。
            const sessionId = typeof args.sessionId === 'string' ? args.sessionId : ''
            const batchPath = typeof args.batchPath === 'string' ? args.batchPath : ''
            if (sessionId === '' || batchPath === '') return { ok: false, error: '缺 sessionId / batchPath' }
            if (!insideMockRoot(batchPath)) return { ok: false, error: '路径不在 mock 工作区内' }
            return await writeSessionArchive(sessionId, batchPath, { kind: 'archive' })
          }
          case 'snapshot-session': {
            // 会话快照（会话中途冻结当前效果）：sessionId 是 Client fork 出的
            // 快照会话（轨迹冻结副本）；本端点只复制产物快照 + 写 record.json。
            // 原会话不归档、不受打扰，可继续对话。
            const sessionId = typeof args.sessionId === 'string' ? args.sessionId : ''
            const sourceSessionId = typeof args.sourceSessionId === 'string' ? args.sourceSessionId : ''
            const batchPath = typeof args.batchPath === 'string' ? args.batchPath : ''
            const note = typeof args.note === 'string' ? args.note.trim() : ''
            if (sessionId === '' || sourceSessionId === '' || batchPath === '') {
              return { ok: false, error: '缺 sessionId / sourceSessionId / batchPath' }
            }
            if (!insideMockRoot(batchPath)) return { ok: false, error: '路径不在 mock 工作区内' }
            return await writeSessionArchive(sessionId, batchPath, {
              kind: 'snapshot',
              sourceSessionId,
              note,
            })
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
          case 'start-hub': {
            // 从面板手动拉起产物托管 Hub（artifact-hub/server.mjs）。
            // detached + unref：Hub 脱离 dsh 进程生命周期独立常驻；stdout/stderr
            // 追加到 artifact-hub/hub.log 便于排查。process.execPath 在 Electron
            // 壳下是壳二进制，ELECTRON_RUN_AS_NODE=1 让它以纯 Node 运行；PATH 补
            // 常见 node/npm 目录（Hub 内部 spawn npm 装依赖依赖它）。
            const root = workspaceRootFallback()
            const serverPath = root + '/artifact-hub/server.mjs'
            if (!existsSync(serverPath)) return { ok: false, error: '未找到 ' + serverPath }
            const pingHub = async () => {
              try {
                const res = await fetch(HUB_URL + 'api/state', { cache: 'no-store' })
                return res.ok
              } catch (err) {
                return false
              }
            }
            if (await pingHub()) return { ok: true, already: true, url: HUB_URL }
            // 面板页与 apiproxy 同源，客户端传 location.origin 作为 Hub 的
            // DSH_API（端口随 dsh 启动变化，server.mjs 的默认值会过期）。
            const dshApi = typeof args.dshApi === 'string' && /^https?:\/\/127\.0\.0\.1:\d+$/.test(args.dshApi)
              ? args.dshApi : ''
            const extraPaths = [dirname(process.execPath), '/usr/local/bin', '/opt/homebrew/bin']
            const env = Object.assign({}, process.env, {
              ELECTRON_RUN_AS_NODE: '1',
              PATH: extraPaths.concat(String(process.env.PATH || '')).join(':'),
            })
            if (dshApi !== '') env.DSH_API = dshApi
            let stdio = 'ignore'
            try {
              const fd = openSync(root + '/artifact-hub/hub.log', 'a')
              stdio = ['ignore', fd, fd]
            } catch (err) { /* 日志打不开就丢弃输出，不阻塞启动 */ }
            const child = spawn(process.execPath, [serverPath], {
              cwd: root,
              detached: true,
              stdio,
              env,
            })
            child.on('error', () => {})
            child.unref()
            // 等就绪（最长 ~10s，Hub 首次扫描 runs/ 可能耗时）
            const deadline = Date.now() + 10000
            while (Date.now() < deadline) {
              await new Promise((resolve) => setTimeout(resolve, 400))
              if (await pingHub()) return { ok: true, url: HUB_URL, pid: child.pid, ready: true }
            }
            // 进程已拉起但还没应答：交给面板 15s 轮询发现，不算失败
            return { ok: true, url: HUB_URL, pid: child.pid, ready: false }
          }
          case 'open-hub': {
            // 打开产物托管页（artifact-hub）。走系统默认程序（macOS `open`），
            // 在 Electron / 浏览器壳下行为都确定；Hub 未启动时用户会看到连接
            // 错误页，面板侧的在线探测负责提示。args.select 为产物 id 时拼
            // ?select=<id> 深链，Hub 管理页加载后自动选中该产物。
            const shell = ctx.get('shell')
            if (shell === undefined) return { ok: false, error: 'shell 服务不可用' }
            const select = typeof args.select === 'string' && args.select !== '' ? args.select : ''
            const url = HUB_URL.replace(/"/g, '') + (select ? '?select=' + encodeURIComponent(select) : '')
            const request = { command: 'open "' + url + '"' }
            let spec
            try {
              spec = shell.resolve(request)
            } catch (err) {
              spec = request
            }
            const result = await shell.run(spec)
            if (result.exitCode !== 0) {
              return { ok: false, error: '打开失败: ' + (result.stderr || result.stdout || 'unknown') }
            }
            return { ok: true, url }
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
