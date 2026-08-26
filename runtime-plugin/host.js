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
  },
}
