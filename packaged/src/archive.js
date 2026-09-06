import { cp, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { basename, dirname, join, relative, sep } from 'node:path'
import { homedir, tmpdir } from 'node:os'

export const ARCHIVE_SKIP_DIRS = new Set(['node_modules', '.git', '.next', '.turbo', '.cache', 'npm-cache'])
const htmlEntry = (names) => names.includes('index.html') ? 'index.html' : names.filter((n) => /\.html?$/i.test(n)).sort()[0]

export function buildEnvironment(env = process.env) {
  const home = env.HOME || homedir()
  return { ...env, ELECTRON_RUN_AS_NODE: '1', PATH: [
    dirname(process.execPath), join(home, '.local/bin'), join(home, '.bun/bin'),
    join(home, 'Library/pnpm'), join(home, '.local/share/pnpm'),
    '/usr/local/bin', '/opt/homebrew/bin', env.PATH || '',
  ].join(':') }
}

// HTML alone is insufficient: webpack's public path and CSS url() also contain
// root URLs. Only relocate paths belonging to files in this snapshot.
export async function relocateArchiveAssets(root, prefix) {
  const roots = new Set(await readdir(root))
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const file = join(dir, entry.name)
      if (entry.isDirectory()) { await walk(file); continue }
      if (!entry.isFile() || !/\.(html?|css|js|json|txt)$/i.test(entry.name)) continue
      const source = await readFile(file, 'utf8')
      const rewritten = source.replace(/(["'`(=\\])\/(?!\/)([^/\s"'`<>?#)\\]+)/g,
        (match, before, first) => roots.has(first) ? before + prefix + '/' + first : match)
      if (source !== rewritten) await writeFile(file, rewritten)
    }
  }
  await walk(root)
}

function run(command, cwd) {
  return new Promise((resolve) => {
    const child = spawn(command, { cwd, shell: true, env: buildEnvironment(), detached: true })
    let output = ''
    const timer = setTimeout(() => {
      try { process.kill(-child.pid, 'SIGKILL') } catch {}
    }, 10 * 60 * 1000)
    const append = (data) => { output = (output + data).slice(-4000) }
    child.stdout.on('data', append)
    child.stderr.on('data', append)
    child.on('error', (err) => { clearTimeout(timer); resolve({ ok: false, output: err.message }) })
    child.on('close', (code) => { clearTimeout(timer); resolve({ ok: code === 0, output }) })
  })
}

// A buildable project is a boundary: never mistake source index.html or work/page.html
// for the finished site. Build in a disposable copy so a running dev server is untouched.
export async function collectArchiveArtifacts(batchDir, destination) {
  const artifacts = [], builds = []
  async function snapshot(root, name, kind, entryFile) {
    const stem = String(name).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'site'
    let snapshotDir = stem + '-' + kind
    for (let n = 2; artifacts.some((a) => a.snapshotDir === snapshotDir); n++) snapshotDir = stem + '-' + kind + '-' + n
    await cp(root, join(destination, snapshotDir), {
      recursive: true, filter: (src) => !relative(root, src).split(sep).some((p) => ARCHIVE_SKIP_DIRS.has(p)),
    })
    artifacts.push({ name, kind, snapshotDir, entryFile })
  }
  async function build(dir, pkg) {
    const stage = await mkdtemp(join(tmpdir(), 'dsh-archive-'))
    const diagnostic = { dir, pm: 'npm', ok: false, steps: [] }
    builds.push(diagnostic)
    try {
      await cp(dir, stage, { recursive: true, filter: (src) => {
        const parts = relative(dir, src).split(sep)
        return !parts.some((p) => ARCHIVE_SKIP_DIRS.has(p) || p === 'out' || p === 'dist')
      } })
      if (existsSync(join(dir, 'node_modules'))) await symlink(join(dir, 'node_modules'), join(stage, 'node_modules'), 'dir')
      else {
        const pm = existsSync(join(dir, 'pnpm-lock.yaml')) ? 'pnpm' : existsSync(join(dir, 'yarn.lock')) ? 'yarn' : 'npm'
        diagnostic.pm = pm
        const result = await run(pm + ' install', stage)
        diagnostic.steps.push({ step: 'install', command: pm + ' install', ...result })
        if (!result.ok) return
      }
      const isNext = Boolean(pkg.dependencies?.next || pkg.devDependencies?.next)
      if (isNext) {
        // Preserve project configuration, including async/function exports, in the copy.
        const configName = (await readdir(stage)).find((n) => /^next\.config\.(mjs|js|ts)$/.test(n))
        let configImport = 'const original = {}'
        if (configName) {
          const saved = 'archive-original-config.' + configName.split('.').pop()
          await cp(join(stage, configName), join(stage, saved))
          await rm(join(stage, configName))
          configImport = 'import original from ' + JSON.stringify('./' + saved)
        }
        await writeFile(join(stage, configName?.endsWith('.ts') ? 'next.config.ts' : 'next.config.mjs'), configImport + `
export default async (phase, context) => {
  const config = await (typeof original === 'function' ? original(phase, context) : original)
  return { ...config, output: 'export', distDir: '.next', images: { ...config.images, unoptimized: true } }
}
`)
      }
      // npm can run the installed build script regardless of the install lockfile.
      // Next 16's Turbopack cannot follow node_modules outside the disposable root.
      let command = 'npm run build'
      if (isNext && /^next build\s*$/.test(pkg.scripts.build)) {
        const version = JSON.parse(await readFile(join(stage, 'node_modules/next/package.json'), 'utf8')).version
        if (Number(version.split('.')[0]) >= 16) command += ' -- --webpack'
      }
      const result = await run(command, stage)
      diagnostic.steps.push({ step: 'build', command, ...result })
      if (!result.ok) return
      for (const sub of ['out', 'dist']) {
        const root = join(stage, sub)
        const entry = htmlEntry(await readdir(root).catch(() => []))
        if (!entry) continue
        await snapshot(root, basename(dir), 'dist', entry)
        diagnostic.ok = true
        return
      }
      diagnostic.steps.push({ step: 'collect', ok: false, output: '构建完成但未找到 out/dist HTML；该项目可能需要服务端运行。' })
    } finally { await rm(stage, { recursive: true, force: true }) }
  }
  async function walk(dir, depth) {
    if (depth > 5) return
    const entries = await readdir(dir, { withFileTypes: true })
    const pkg = await readFile(join(dir, 'package.json'), 'utf8').then(JSON.parse).catch(() => null)
    if (typeof pkg?.scripts?.build === 'string' && pkg.scripts.build.trim()) {
      await build(dir, pkg)
      return
    }
    for (const sub of ['dist', 'out']) {
      const root = join(dir, sub)
      const entry = htmlEntry(await readdir(root).catch(() => []))
      if (entry) { await snapshot(root, basename(dir), 'dist', entry); return }
    }
    const entry = htmlEntry(entries.filter((e) => e.isFile()).map((e) => e.name))
    if (entry) { await snapshot(dir, basename(dir), 'static', entry); return }
    for (const sub of entries.filter((e) => e.isDirectory())) {
      if (!ARCHIVE_SKIP_DIRS.has(sub.name)) await walk(join(dir, sub.name), depth + 1)
    }
  }
  await walk(batchDir, 0)
  return { artifacts, builds }
}
