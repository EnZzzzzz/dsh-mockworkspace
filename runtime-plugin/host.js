// dsh-mock-workspace — runtime plugin Host half.
// 临时实验场（mock workspace）的批次管理。每个「批次 batch」= mock 根下
// runs/<batchId>/ 一个真实目录：
//   - 目录由本插件用 `shell` 跑 `mkdir -p` 创建（fs 服务没有 mkdir）
//   - meta.json 记录 { batchId, name, createdAt, status }
//   - 目录注册为正式 workspace（workspaceRegistry.create），会话 cwd 指向
//     批次目录时自动归组（sessionIds 由 canonical-cwd 索引提供）
//   - 轨迹 = DSH 会话日志（打开会话即达）；产物 = 会话在批次目录里生成的文件
//
// 本文件是交给 cordis_define 的 `code.host` 原文。纯 JS：无 import/require。
// Builtins：ctx / harness / console。

return {
  apply(ctx) {
    // ---- optional services（先 undefined 检查，绝不 ctx.x 直取） ----
    const fs = ctx.get('fs')
    const shell = ctx.get('shell')
    const registry = ctx.get('workspaceRegistry')
    const sandboxPolicy = ctx.get('sandboxPolicy')

    // 兜底：当前会话工作区根不可用时，退回 mock 仓库常量。
    const FALLBACK_ROOT = '/Volumes/DataDrive/proj/my/dsh-mockworkspace'
    // 配置持久化路径（用户级）：~/.dsh/mock-workspace.json → { root: "/abs/path" }
    // 动态插件无 process 全局，用显式 HOME 兜底读取（正式包才有 process.env.HOME）。
    const CONFIG_PATH = '/Users/en/.dsh/mock-workspace.json'

    const errorText = (err) => (err && err.message ? String(err.message) : String(err))

    // 内存缓存 + 文件配置读写（与正式包 src/index.js 相同的语义）。
    let cachedRoot = null
    let configReady = false
    function workspaceRootFallback() {
      if (sandboxPolicy && typeof sandboxPolicy.workspaceRoot === 'string' && sandboxPolicy.workspaceRoot !== '') {
        return sandboxPolicy.workspaceRoot
      }
      return FALLBACK_ROOT
    }
    function mockRoot() {
      if (cachedRoot !== null && cachedRoot !== '') return cachedRoot
      return workspaceRootFallback()
    }
    async function loadConfig() {
      if (configReady) return
      configReady = true
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
      if (fs === undefined) throw new Error('fs 服务不可用，无法保存配置')
      cachedRoot = root.replace(/[/\\]+$/, '')
      configReady = true
      const target = await fs.resolve(CONFIG_PATH)
      await fs.writeText(target, JSON.stringify({ root: cachedRoot }, null, 2))
    }
    function joinPath(base, name) {
      return base.replace(/[/\\]+$/, '') + '/' + String(name)
    }
    // 只允许操作 mock 根（含 runs/ 子目录）内的路径，防误删其它目录。
    function insideMockRoot(targetPath) {
      const root = mockRoot().replace(/[/\\]+$/, '')
      if (typeof targetPath !== 'string') return false
      const t = targetPath.replace(/[/\\]+$/, '')
      return t === root || t.startsWith(root + '/')
    }

    // ---- mkdir（shell 跑 mkdir -p，命令字符串完整传入） ----
    async function mkdirp(dirPath) {
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
        const detail = result.stderr || result.stdout || 'unknown'
        throw new Error('创建目录失败: ' + errorText(detail))
      }
    }

    // ---- fs 目标工具 ----
    async function resolveTarget(path) {
      if (fs === undefined) throw new Error('fs 服务不可用')
      return fs.resolve(path)
    }
    async function statExists(path) {
      try {
        const target = await resolveTarget(path)
        const info = await fs.stat(target)
        return info !== undefined
      } catch (err) {
        return false
      }
    }

    // ---- 批次元数据（meta.json 读写） ----
    function metaPath(batchDir) {
      return joinPath(batchDir, 'meta.json')
    }
    async function writeMeta(batchDir, meta) {
      if (fs === undefined) throw new Error('fs 服务不可用')
      const target = await resolveTarget(metaPath(batchDir))
      await fs.writeText(target, JSON.stringify(meta, null, 2))
    }
    async function readMeta(batchDir) {
      try {
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

    // ---- 目录列取（产物树，复用 dsh-slide-bar 的 list-directory 逻辑） ----
    const MAX_ENTRIES = 500
    async function listDirectory(path) {
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

    // ---- RPC：读取/设置 mock 根目录配置 ----
    harness.handle('mock.get-config', async () => {
      try {
        await loadConfig()
        return {
          ok: true,
          rootPath: mockRoot(),
          configPath: CONFIG_PATH,
          configured: cachedRoot !== null,
        }
      } catch (err) {
        return { ok: false, error: errorText(err) }
      }
    })
    harness.handle('mock.set-config', async (args) => {
      try {
        const root = args && typeof args.root === 'string' ? args.root.trim() : ''
        if (root === '') return { ok: false, error: '请输入目录路径' }
        if (!(await statExists(root))) await mkdirp(root)
        await saveConfig(root)
        return { ok: true, rootPath: mockRoot(), configPath: CONFIG_PATH }
      } catch (err) {
        return { ok: false, error: errorText(err) }
      }
    })

    // ---- RPC：确保 mock 根 + runs 目录存在 ----
    harness.handle('mock.ensure-root', async () => {
      const root = mockRoot()
      const runs = joinPath(root, 'runs')
      try {
        await loadConfig()
        if (!(await statExists(runs))) await mkdirp(runs)
        return { ok: true, rootPath: root, runsPath: runs }
      } catch (err) {
        return { ok: false, error: errorText(err) }
      }
    })

    // ---- RPC：新建批次（mkdir + meta.json + workspace 注册） ----
    // args: { name }
    harness.handle('mock.create-batch', async (args) => {
      try {
        const name = args && typeof args.name === 'string' ? args.name.trim() : ''
        if (name === '') return { ok: false, error: '请输入名称' }

        // 批次目录名：runs/YYYYMMDD-HHmmss-xxxxx（5 位随机）
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
        if (args && typeof args.caseId === 'string' && args.caseId !== '') meta.caseId = args.caseId
        if (args && typeof args.caseSetId === 'string' && args.caseSetId !== '') meta.caseSetId = args.caseSetId
        if (args && typeof args.sourceRef === 'string' && args.sourceRef !== '') meta.sourceRef = args.sourceRef
        if (args && typeof args.promptHash === 'string' && args.promptHash !== '') meta.promptHash = args.promptHash
        await writeMeta(batchPath, meta)

        // 不注册 workspace：会话由后端 session.create({ cwd }) 创建，cwd 指向
        // 批次目录但没有 workspace 归属，默认会话面板把它们归入「未分组」。
        return { ok: true, batchId, batchPath, meta }
      } catch (err) {
        return { ok: false, error: errorText(err) }
      }
    })

    // ---- RPC：列出全部批次（runs/*/meta.json + cwd 前缀匹配会话） ----
    // 返回 [{ batchId, path, meta, sessionIds }]
    harness.handle('mock.list-batches', async () => {
      try {
        const runs = joinPath(mockRoot(), 'runs')
        const batches = []
        if (await statExists(runs)) {
          const target = await resolveTarget(runs)
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
        // 会话由后端 session.create({ cwd }) 创建，无 workspace 归属，归入
        // 「未分组」；本面板按 cwd 关联到批次。
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
        // 按创建时间倒序
        batches.sort((a, b) => ((b.meta && b.meta.createdAt) || 0) - ((a.meta && a.meta.createdAt) || 0))
        return { ok: true, rootPath: mockRoot(), runsPath: runs, batches }
      } catch (err) {
        return { ok: false, error: errorText(err) }
      }
    })

    // ---- RPC：归档批次（meta.status → archived，面板隐藏但目录保留） ----
    harness.handle('mock.archive-batch', async (args) => {
      try {
        const path = args && typeof args.path === 'string' ? args.path : ''
        if (!insideMockRoot(path)) return { ok: false, error: '路径不在 mock 工作区内' }
        const meta = await readMeta(path)
        if (meta === null) return { ok: false, error: '未找到批次元数据' }
        meta.status = 'archived'
        await writeMeta(path, meta)
        return { ok: true, path, meta }
      } catch (err) {
        return { ok: false, error: errorText(err) }
      }
    })

    // ---- 归档工具：扫描产物 + 快照复制 + record.json ----
    const ARCHIVE_SKIP_DIRS = new Set(['node_modules', '.git', '.next', '.turbo', '.cache'])
    const baseName = (p) => String(p || '').split('/').filter(Boolean).pop() || ''
    const safeName = (s) => String(s || 'dist').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'dist'
    // 递归复制目录（跳过 node_modules/.git 等重目录），shell cp 逐项执行。
    async function copyTree(srcDir, destDir, skip) {
      if (fs === undefined || shell === undefined) throw new Error('fs/shell 服务不可用')
      await mkdirp(destDir)
      const target = await resolveTarget(srcDir)
      const raw = await fs.listDir(target)
      const cpOne = async (srcEntry, destEntry) => {
        const request = { command: 'cp "' + srcEntry.replace(/"/g, '\\"') + '" "' + destEntry.replace(/"/g, '\\"') + '"' }
        let spec
        try { spec = shell.resolve(request) } catch (err) { spec = request }
        const result = await shell.run(spec)
        if (result.exitCode !== 0) {
          throw new Error('复制失败: ' + (result.stderr || result.stdout || 'unknown'))
        }
      }
      for (const e of raw) {
        if (e.type !== 'file' && e.type !== 'directory') continue
        if (skip && skip.has(e.name)) continue
        if (e.type === 'directory') {
          await copyTree(joinPath(srcDir, e.name), joinPath(destDir, e.name), skip)
        } else {
          await cpOne(joinPath(srcDir, e.name), joinPath(destDir, e.name))
        }
      }
    }
    // 扫描批次目录产物根。HTML 入口优先 index.html，否则取字典序首个 .html。
    async function scanBatchArtifacts(batchDir) {
      const found = []
      const walk = async (dir, depth) => {
        if (depth > 3) return
        let raw
        try {
          const target = await resolveTarget(dir)
          raw = await fs.listDir(target)
        } catch (err) { return }
        const fileNames = raw.filter((e) => e.type === 'file').map((e) => e.name)
        const htmlEntry = (names) => {
          const html = names.filter((name) => /\.html?$/i.test(name)).sort()
          return html.includes('index.html') ? 'index.html' : (html[0] || '')
        }
        const subdirs = raw.filter((e) => e.type === 'directory')
        for (const sd of subdirs) {
          if (sd.name !== 'dist') continue
          let distRaw
          try { distRaw = await fs.listDir(await resolveTarget(joinPath(dir, 'dist'))) } catch (err) { distRaw = [] }
          const entryFile = htmlEntry(distRaw.filter((e) => e.type === 'file').map((e) => e.name))
          if (entryFile !== '') {
            found.push({ name: baseName(dir) || 'dist', kind: 'dist', rootPath: joinPath(dir, 'dist'), entryFile })
            return // 命中即止，不再下钻
          }
        }
        const entryFile = htmlEntry(fileNames)
        if (entryFile !== '') {
          found.push({ name: baseName(dir) || 'site', kind: 'static', rootPath: dir, entryFile })
          return
        }
        for (const sd of subdirs) {
          if (ARCHIVE_SKIP_DIRS.has(sd.name)) continue
          await walk(joinPath(dir, sd.name), depth + 1)
        }
      }
      await walk(batchDir, 0)
      return found
    }

    // ---- RPC：归档会话（产物快照 + 会话记录，供 Hub「用例迭代」时间线） ----
    // args: { sessionId, batchPath } → 扫批次目录产物 → 快照复制到
    // <mock根>/case-library/archives/<batchId>/<ts>/ → 写 record.json。
    // 不依赖 Hub 在线：Hub 启动后扫 archives/ 目录即出迭代时间线。
    harness.handle('mock.archive-session', async (args) => {
      try {
        const sessionId = args && typeof args.sessionId === 'string' ? args.sessionId : ''
        const batchPath = args && typeof args.batchPath === 'string' ? args.batchPath : ''
        if (sessionId === '' || batchPath === '') return { ok: false, error: '缺 sessionId / batchPath' }
        if (!insideMockRoot(batchPath)) return { ok: false, error: '路径不在 mock 工作区内' }
        const meta = await readMeta(batchPath)
        if (meta === null) return { ok: false, error: '未找到批次元数据' }

        const batchId = (meta && meta.batchId) || baseName(batchPath)
        const now = new Date()
        const pad = (n, w) => String(n).padStart(w, '0')
        const ts = pad(now.getFullYear(), 4) + pad(now.getMonth() + 1, 2) + pad(now.getDate(), 2)
          + '-' + pad(now.getHours(), 2) + pad(now.getMinutes(), 2) + pad(now.getSeconds(), 2)
        const archivesRoot = joinPath(joinPath(mockRoot(), 'case-library'), 'archives')
        const archiveDir = joinPath(joinPath(archivesRoot, batchId), ts)
        await mkdirp(archiveDir)

        const artifacts = await scanBatchArtifacts(batchPath)
        const snapshots = []
        for (const a of artifacts) {
          const snapName = a.kind === 'dist' ? safeName(a.name) + '-dist' : safeName(a.name) + '-site'
          await copyTree(a.rootPath, joinPath(archiveDir, snapName), ARCHIVE_SKIP_DIRS)
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
        }
        const recordTarget = await resolveTarget(joinPath(archiveDir, 'record.json'))
        await fs.writeText(recordTarget, JSON.stringify(record, null, 2))
        return { ok: true, record }
      } catch (err) {
        return { ok: false, error: errorText(err) }
      }
    })

    // ---- RPC：删除批次（目录 + meta 全部移除） ----
    // args: { path }
    harness.handle('mock.delete-batch', async (args) => {
      try {
        const path = args && typeof args.path === 'string' ? args.path : ''
        if (!insideMockRoot(path)) return { ok: false, error: '路径不在 mock 工作区内' }
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
      } catch (err) {
        return { ok: false, error: errorText(err) }
      }
    })

    // ---- RPC：列目录（产物树，客户端懒加载） ----
    harness.handle('mock.list-directory', async (args) => {
      const path = args && typeof args.path === 'string' ? args.path : ''
      if (!insideMockRoot(path)) return { ok: false, error: '路径不在 mock 工作区内' }
      return listDirectory(path)
    })

    // 产物托管 Hub（artifact-hub/server.mjs）管理页地址。
    const HUB_URL = 'http://127.0.0.1:4780/'
    // ---- RPC：手动拉起产物托管 Hub ----
    // 动态插件沙箱无 process/child_process/fetch/定时器，用 shell 服务
    // nohup 后台拉起（PATH 无 node，用 /usr/local/bin/node 绝对路径，兜底
    // /opt/homebrew/bin/node），随后 curl 轮询就绪（最长 ~10s）。
    harness.handle('mock.start-hub', async (args) => {
      try {
        if (shell === undefined) return { ok: false, error: 'shell 服务不可用' }
        const root = workspaceRootFallback()
        // 面板页与 apiproxy 同源，客户端传 location.origin 作为 Hub 的
        // DSH_API（端口随 dsh 启动变化，server.mjs 的默认值会过期）。
        const dshApi = args && typeof args.dshApi === 'string' && /^https?:\/\/127\.0\.0\.1:\d+$/.test(args.dshApi)
          ? args.dshApi : ''
        const run = async (command) => {
          const request = { command }
          let spec
          try {
            spec = shell.resolve(request)
          } catch (err) {
            spec = request
          }
          return shell.run(spec)
        }
        const probe = 'curl -sf -o /dev/null --max-time 2 ' + HUB_URL + 'api/state'
        if ((await run(probe)).exitCode === 0) return { ok: true, already: true, url: HUB_URL }
        const q = (s) => '"' + s.replace(/"/g, '\\"') + '"'
        const log = q(root + '/artifact-hub/hub.log')
        const script = 'NODE=/usr/local/bin/node; [ -x "$NODE" ] || NODE=/opt/homebrew/bin/node; ' +
          (dshApi !== '' ? 'DSH_API=' + dshApi + ' ' : '') +
          'nohup "$NODE" ' + q(root + '/artifact-hub/server.mjs') + ' >> ' + log + ' 2>&1 &'
        const started = await run(script)
        if (started.exitCode !== 0) {
          return { ok: false, error: '拉起失败: ' + (started.stderr || started.stdout || 'unknown') }
        }
        for (let i = 0; i < 12; i++) {
          if ((await run(probe)).exitCode === 0) return { ok: true, url: HUB_URL, ready: true }
        }
        return { ok: true, url: HUB_URL, ready: false }
      } catch (err) {
        return { ok: false, error: errorText(err) }
      }
    })

    // ---- RPC：打开产物托管页（macOS `open` → 系统默认浏览器） ----
    // args.select 为产物 id 时拼 ?select=<id> 深链，Hub 管理页自动选中该产物。
    harness.handle('mock.open-hub', async (args) => {
      try {
        if (shell === undefined) return { ok: false, error: 'shell 服务不可用' }
        const select = args && typeof args.select === 'string' && args.select !== '' ? args.select : ''
        const url = HUB_URL + (select ? '?select=' + encodeURIComponent(select) : '')
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
      } catch (err) {
        return { ok: false, error: errorText(err) }
      }
    })
  },
}
