/**
 * artifact-hub — mock workspace 产物托管服务（零依赖，Node >= 18）
 *
 * 职责：
 *   1. 扫描 mock 根 runs/<batchId>/ 下的产物：
 *      - 目录含 index.html              → 静态产物（Hub 直接伺服 /preview/<id>/）
 *      - 目录含 package.json + scripts   → Node 产物（spawn 子进程，分配独立端口）
 *      - 目录含 artifact.json            → 显式声明（自定义 kind/command，见 README）
 *   2. 托管生命周期：start（自动 npm install → 起进程 → 等端口就绪）/ stop / 日志
 *   3. 轨迹：走 dsh apiproxy HTTP API（session.list 按 cwd 前缀关联批次会话，
 *      session.history 拉事件流），服务端滤掉 assistant/chunk 后返回简化时间线
 *   4. 自带管理页：左产物渲染（iframe）+ 右会话轨迹
 *
 * 配置：
 *   ARTIFACT_HUB_PORT  Hub 端口（默认 4780，只绑 127.0.0.1）
 *   DSH_API            dsh apiproxy 基址（默认 http://127.0.0.1:62274）
 *   MOCK_ROOT          mock 根（默认读 ~/.dsh/mock-workspace.json，退回 process.cwd()）
 */

import http from 'node:http'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'

const HUB_PORT = Number(process.env.ARTIFACT_HUB_PORT || 4780)
const DSH_API = (process.env.DSH_API || 'http://127.0.0.1:62274').replace(/[/]+$/, '')
const HUB_BASE = `http://127.0.0.1:${HUB_PORT}`
const HERE = path.dirname(fileURLToPath(import.meta.url))
const PUBLIC_DIR = path.join(HERE, 'public')

// 动态产物端口分配区间
const PORT_BASE = 49100
const PORT_MAX = 49900
// 产物扫描深度与跳过目录
const SCAN_MAX_DEPTH = 5
const SKIP_DIRS = new Set(['node_modules', '.git', '.next', '.turbo', '.cache'])
// 子进程日志环形缓冲行数
const LOG_RING_MAX = 800
// 等端口就绪超时
const READY_TIMEOUT_MS = 60000

// ---------------------------------------------------------------- 配置解析

async function resolveMockRoot() {
  if (process.env.MOCK_ROOT) return process.env.MOCK_ROOT.replace(/[/\\]+$/, '')
  try {
    const text = await fsp.readFile(path.join(os.homedir(), '.dsh', 'mock-workspace.json'), 'utf8')
    const parsed = JSON.parse(text)
    if (parsed && typeof parsed.root === 'string' && parsed.root !== '') {
      return parsed.root.replace(/[/\\]+$/, '')
    }
  } catch { /* 配置不存在或损坏时用 cwd */ }
  return process.cwd()
}

const MOCK_ROOT = await resolveMockRoot()
const RUNS_DIR = path.join(MOCK_ROOT, 'runs')
// 会话归档存储：<mock根>/case-library/archives/<batchId>/<ts>/（record.json + 快照）。
// 由 dsh mock 插件归档会话时写入（Host 只写文件，不依赖 Hub 在线）；Hub 启动后
// 扫描此处出「用例迭代」时间线。case-library 与用例库 DB 同根，语义一致。
const ARCHIVES_DIR = path.join(MOCK_ROOT, 'case-library', 'archives')

// ---------------------------------------------------------------- node/npm 解析
// Hub 进程的 PATH 可能极简（如 launchd/裸 sh 环境没有 /usr/local/bin），
// 不能直接 spawn('npm')。改为：npm = 当前 node + 同安装的 npm-cli.js；
// 子进程 PATH 补上 node 真实目录与常见 bin 目录，npm 生命周期脚本里的
// `node server.js` / vite shebang 才能解析。
const NODE_BIN = process.execPath

async function resolveNpmCli() {
  const realNode = await fsp.realpath(NODE_BIN).catch(() => NODE_BIN)
  const candidates = [
    path.join(path.dirname(realNode), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    '/usr/local/lib/node_modules/npm/bin/npm-cli.js',
    '/opt/homebrew/lib/node_modules/npm/bin/npm-cli.js',
  ]
  for (const c of candidates) {
    if (await pathExists(c)) return c
  }
  return null
}

const NPM_CLI = await resolveNpmCli()

async function enrichedEnv(extra) {
  const realNode = await fsp.realpath(NODE_BIN).catch(() => NODE_BIN)
  const extraDirs = [path.dirname(realNode), '/usr/local/bin', '/opt/homebrew/bin']
  const PATH = [...extraDirs, ...String(process.env.PATH || '').split(':')].filter(Boolean).join(':')
  return { ...process.env, PATH, ...(extra || {}) }
}
const BASE_ENV = await enrichedEnv()

// ---------------------------------------------------------------- 小工具

const errorText = (err) => (err && err.message ? String(err.message) : String(err))

async function pathExists(p) {
  try { await fsp.stat(p); return true } catch { return false }
}

async function readJson(p) {
  try {
    const text = await fsp.readFile(p, 'utf8')
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch { return null }
}

/** 安全地把 url 路径段 decode 成相对路径，拒绝越界（.. / 绝对路径）。 */
function safeRelPath(segments) {
  const parts = []
  for (const seg of segments) {
    let dec
    try { dec = decodeURIComponent(seg) } catch { return null }
    if (dec === '' || dec === '.' ) continue
    if (dec === '..' || dec.includes('/') || dec.includes('\\') || dec.includes('\0')) return null
    parts.push(dec)
  }
  return parts
}

// ---------------------------------------------------------------- 产物扫描

/**
 * 返回 [{ id, batchId, batchName, name, kind, relDir, absDir, entry, command, meta }]
 * id = 相对 runs/ 的 posix 路径（含批次目录），保证跨批次唯一。
 */
async function scanArtifacts() {
  const artifacts = []
  let batchDirs = []
  try { batchDirs = await fsp.readdir(RUNS_DIR, { withFileTypes: true }) } catch { return artifacts }

  for (const be of batchDirs) {
    if (!be.isDirectory()) continue
    const batchDir = path.join(RUNS_DIR, be.name)
    const meta = await readJson(path.join(batchDir, 'meta.json'))
    if (meta === null) continue // 只认插件建的批次目录
    const batchName = typeof meta.name === 'string' ? meta.name : be.name

    const walk = async (dir, depth) => {
      if (depth > SCAN_MAX_DEPTH) return
      let entries
      try { entries = await fsp.readdir(dir, { withFileTypes: true }) } catch { return }
      const names = new Set(entries.filter((e) => e.isFile()).map((e) => e.name))

      // 1) artifact.json 显式声明优先
      const decl = names.has('artifact.json') ? await readJson(path.join(dir, 'artifact.json')) : null
      // 2) package.json + scripts
      const pkg = names.has('package.json') ? await readJson(path.join(dir, 'package.json')) : null
      const pkgScripts = pkg && pkg.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : null
      const hasNodeScripts = pkgScripts !== null && (typeof pkgScripts.dev === 'string' || typeof pkgScripts.start === 'string')
      // 3) index.html
      const hasIndexHtml = names.has('index.html')

      let detected = null
      if (decl !== null) {
        detected = {
          name: typeof decl.name === 'string' && decl.name !== '' ? decl.name : path.basename(dir),
          kind: decl.kind === 'command' ? 'command' : 'static',
          command: typeof decl.command === 'string' ? decl.command : undefined,
          readyPath: typeof decl.readyPath === 'string' ? decl.readyPath : '/',
        }
      } else if (hasNodeScripts) {
        detected = {
          name: typeof pkg.name === 'string' && pkg.name !== '' ? pkg.name : path.basename(dir),
          kind: 'node',
          pkg,
        }
      } else if (hasIndexHtml) {
        detected = { name: path.basename(dir), kind: 'static' }
      }

      if (detected !== null) {
        const relDir = path.relative(RUNS_DIR, dir).split(path.sep).join('/')
        artifacts.push({
          id: relDir,
          batchId: be.name,
          batchName,
          name: detected.name,
          kind: detected.kind,
          relDir,
          absDir: dir,
          command: detected.command,
          readyPath: detected.readyPath || '/',
          hasLock: names.has('package-lock.json') || names.has('pnpm-lock.yaml') || names.has('yarn.lock'),
          deps: detected.pkg ? Object.keys({ ...detected.pkg.dependencies, ...detected.pkg.devDependencies }) : [],
          scripts: pkgScripts ? Object.keys(pkgScripts) : [],
        })
        return // 检出即产物根，不再向下递归
      }

      for (const e of entries) {
        if (!e.isDirectory()) continue
        if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue
        await walk(path.join(dir, e.name), depth + 1)
      }
    }
    await walk(batchDir, 1)
  }
  artifacts.sort((a, b) => (a.batchId < b.batchId ? 1 : a.batchId > b.batchId ? -1 : a.id < b.id ? -1 : 1))
  return artifacts
}

// 扫描结果短缓存，避免 preview 每个静态文件请求都重扫
let scanCache = { at: 0, items: [] }
async function scanArtifactsCached(maxAgeMs = 3000) {
  if (Date.now() - scanCache.at < maxAgeMs) return scanCache.items
  const items = await scanArtifacts()
  scanCache = { at: Date.now(), items }
  return items
}

// ---------------------------------------------------------------- 用例迭代（会话归档时间线）

/**
 * 扫描归档目录 archives/<batchId>/<ts>/record.json，返回按时间倒序的归档条目。
 * 条目 = 一次「归档会话」动作：产物快照 + 会话记录（含 caseId/日期）。
 */
async function scanArchives() {
  const entries = []
  let batchDirs = []
  try { batchDirs = await fsp.readdir(ARCHIVES_DIR, { withFileTypes: true }) } catch (err) { return entries }
  for (const be of batchDirs) {
    if (!be.isDirectory()) continue
    const batchDir = path.join(ARCHIVES_DIR, be.name)
    let tsDirs = []
    try { tsDirs = await fsp.readdir(batchDir, { withFileTypes: true }) } catch (err) { continue }
    for (const te of tsDirs) {
      if (!te.isDirectory()) continue
      const rec = await readJson(path.join(batchDir, te.name, 'record.json'))
      if (rec === null) continue
      // 批次可能已删除：batchName 从 runs/ 补，缺失则退回 batchId
      let batchName = typeof rec.batchName === 'string' && rec.batchName !== '' ? rec.batchName : ''
      if (batchName === '') {
        const meta = await readJson(path.join(RUNS_DIR, be.name, 'meta.json'))
        batchName = (meta && typeof meta.name === 'string' && meta.name !== '') ? meta.name : be.name
      }
      entries.push({
        archiveId: (typeof rec.archiveId === 'string' && rec.archiveId !== '') ? rec.archiveId : `${be.name}/${te.name}`,
        batchId: be.name,
        batchName,
        sessionId: typeof rec.sessionId === 'string' ? rec.sessionId : '',
        caseId: typeof rec.caseId === 'string' ? rec.caseId : '',
        caseSetId: typeof rec.caseSetId === 'string' ? rec.caseSetId : '',
        promptHash: typeof rec.promptHash === 'string' ? rec.promptHash : '',
        archivedAt: typeof rec.archivedAt === 'string' ? rec.archivedAt : '',
        artifacts: Array.isArray(rec.artifacts) ? rec.artifacts : [],
      })
    }
  }
  entries.sort((a, b) => (a.archivedAt < b.archivedAt ? 1 : a.archivedAt > b.archivedAt ? -1 : 0))
  return entries
}

// ---------------------------------------------------------------- dsh apiproxy

async function dshRpc(method, payload) {
  const res = await fetch(`${DSH_API}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: `hub-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      method,
      payload: payload || {},
    }),
  })
  const msg = await res.json().catch(() => null)
  if (!msg || !msg.result) throw new Error(`apiproxy ${method} 响应异常（HTTP ${res.status}）`)
  if (msg.result.ok !== true) {
    const e = msg.result.error
    throw new Error(`apiproxy ${method} 失败: ${(e && e.message) || 'unknown'}`)
  }
  return msg.result.value
}

/** 批次目录 → 关联会话（cwd 前缀匹配，与 mock 插件同一规则）。 */
async function sessionsForBatch(batchId) {
  const batchPath = path.join(RUNS_DIR, batchId).replace(/[/\\]+$/, '')
  const value = await dshRpc('session.list', {})
  const items = Array.isArray(value.items) ? value.items : []
  const matched = items.filter((s) => {
    const cwd = typeof s.cwd === 'string' ? s.cwd.replace(/[/\\]+$/, '') : ''
    return cwd === batchPath || cwd.startsWith(batchPath + '/')
  })
  return matched.map((s) => {
    const values = s.projections && s.projections.values ? s.projections.values : {}
    const title = typeof values.title === 'string' ? values.title
      : (values.title && typeof values.title.title === 'string' ? values.title.title : '')
    return {
      sessionId: s.sessionId,
      title,
      updatedAt: s.updatedAt,
      running: s.running === true,
      blank: s.blank === true,
      cwd: s.cwd || '',
    }
  })
}

/** session.history 原始事件 → 简化时间线条目（滤 chunk，配对 tool result）。 */
async function trajectoryEvents(sessionId) {
  const value = await dshRpc('session.history', { sessionId, maxMessages: 2000 })
  const raw = Array.isArray(value.events) ? value.events : []
  const toolById = new Map()
  const entries = []

  const textOfBlocks = (content) => {
    if (!Array.isArray(content)) return ''
    return content
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n')
  }

  for (const entry of raw) {
    const ev = entry.event
    if (!ev || typeof ev.type !== 'string') continue
    const d = ev.data || {}
    const base = { seq: ev.seq, time: ev.time }
    switch (ev.type) {
      case 'turn/start':
        entries.push({ ...base, kind: 'turn-start', turn: d.turn })
        break
      case 'turn/end':
        entries.push({ ...base, kind: 'turn-end', turn: d.turn, reason: d.reason && d.reason.kind })
        break
      case 'user/message': {
        const text = textOfBlocks(d.content)
        if (text !== '') entries.push({ ...base, kind: 'user', text })
        break
      }
      case 'assistant/message': {
        const msg = d.message || {}
        const text = textOfBlocks(msg.content)
        const reasoning = Array.isArray(msg.content)
          ? msg.content.filter((b) => b && b.type === 'reasoning').map((b) => b.text || '').join('\n')
          : ''
        if (text !== '' || reasoning !== '') {
          entries.push({ ...base, kind: 'assistant', text, reasoning })
        }
        break
      }
      case 'tool/call': {
        const view = entry.view && entry.view.view ? entry.view.view : {}
        let argsSummary = ''
        try {
          const parsed = typeof d.arguments === 'string' ? JSON.parse(d.arguments) : d.arguments
          if (parsed && typeof parsed === 'object') {
            argsSummary = parsed.command || parsed.file_path || parsed.pattern || parsed.path
              || parsed.query || parsed.prompt || JSON.stringify(parsed).slice(0, 200) || ''
          }
        } catch { argsSummary = String(d.arguments || '').slice(0, 200) }
        const item = {
          ...base,
          kind: 'tool',
          callId: d.callId,
          name: d.name || 'tool',
          title: typeof view.title === 'string' ? view.title : '',
          card: typeof view.card === 'string' ? view.card : '',
          args: String(d.arguments || '').slice(0, 2000),
          argsSummary: String(argsSummary).slice(0, 300),
          resultText: '',
          resultError: false,
          done: false,
        }
        toolById.set(d.callId, item)
        entries.push(item)
        break
      }
      case 'tool/result': {
        const msg = d.message || {}
        const blocks = Array.isArray(msg.content) ? msg.content : []
        for (const b of blocks) {
          if (!b || b.type !== 'tool-result') continue
          const target = toolById.get(b.toolCallId)
          if (!target) continue
          const inner = Array.isArray(b.content) ? b.content : []
          const text = inner
            .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
            .map((c) => c.text)
            .join('\n')
          target.resultText = text.slice(0, 2000)
          target.resultError = b.isError === true
          target.done = true
        }
        break
      }
      default:
        break // chunk / step / request / permission 等噪音事件不进时间线
    }
  }
  return { entries, hasMore: value.hasMore === true }
}


// ---------------------------------------------------------------- 用例库（benchmark prompts）
// 全局 prompt 用例库，不属于任何批次（批次是用例的运行结果）。
//   Case（导入时归一化，之后所有消费方只认这一种形态）:
//     { id, setId, sourceRef, prompt, language, tags[], meta{}, createdAt }
//     - prompt     唯一必填的一等公民
//     - sourceRef  源数据集原始 id（去重 + 回溯纽带），缺失时退回 prompt 哈希
//     - tags       扁平筛选维度（从指定列抽取）
//     - meta       不透明袋子：原始行其余列原样保留，schema 不解释
// Importer 抽象 = parser(csv|jsonl|json) + 字段映射；公开 benchmark 支持即
// 「预设字段映射」，不需要为每个 benchmark 写代码。
//
// 存储：SQLite（node:sqlite 内置，零依赖，需 Node ≥22.5），
// 单文件 <MOCK_ROOT>/case-library/library.db（WAL），重启不丢。
//   sets(id, name, source_json, created_at, updated_at)
//   cases(set_id, source_ref, id, prompt, language, tags_json, meta_json, created_at)
//         PRIMARY KEY (set_id, source_ref) ← 去重约束
//   case_tags(set_id, tag, case_id)       ← 标签筛选/计数的连接表
// 旧版 JSONL 存储（<setId>/{set.json,cases.jsonl}）在首次打开 DB 时自动迁移
// 入库（按主键 OR IGNORE，幂等），原文件保留作历史备份。

const LIBRARY_DIR = path.join(MOCK_ROOT, 'case-library')
const LIBRARY_DB = path.join(LIBRARY_DIR, 'library.db')
const LIBRARY_MAX_BYTES = 128 * 1024 * 1024
const UPLOAD_MAX_BYTES = 64 * 1024 * 1024

let libDb = null

/** 打开（并初始化/迁移）用例库 DB。同步：DB 操作均为微秒级。 */
function libOpen() {
  if (libDb !== null) return libDb
  fs.mkdirSync(LIBRARY_DIR, { recursive: true })
  const db = new DatabaseSync(LIBRARY_DB)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec(`CREATE TABLE IF NOT EXISTS sets (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`)
  db.exec(`CREATE TABLE IF NOT EXISTS cases (
    set_id TEXT NOT NULL,
    source_ref TEXT NOT NULL,
    id TEXT NOT NULL,
    prompt TEXT NOT NULL,
    language TEXT NOT NULL DEFAULT '',
    tags TEXT NOT NULL DEFAULT '[]',
    meta TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    PRIMARY KEY (set_id, source_ref)
  )`)
  db.exec(`CREATE TABLE IF NOT EXISTS case_tags (
    set_id TEXT NOT NULL,
    tag TEXT NOT NULL,
    case_id TEXT NOT NULL,
    PRIMARY KEY (set_id, tag, case_id)
  )`)
  db.exec('CREATE INDEX IF NOT EXISTS idx_case_tags_set ON case_tags(set_id, tag)')
  migrateLegacyLibrary(db)
  libDb = db
  return db
}

/** 旧 JSONL 目录 → SQLite 一次性迁移（幂等，按主键去重）。 */
function migrateLegacyLibrary(db) {
  let entries = []
  try { entries = fs.readdirSync(LIBRARY_DIR, { withFileTypes: true }) } catch { return }
  const hasSet = db.prepare('SELECT 1 FROM sets WHERE id = ?')
  const insSet = db.prepare('INSERT OR IGNORE INTO sets (id, name, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
  const insCase = db.prepare('INSERT OR IGNORE INTO cases (set_id, source_ref, id, prompt, language, tags, meta, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
  const insTag = db.prepare('INSERT OR IGNORE INTO case_tags (set_id, tag, case_id) VALUES (?, ?, ?)')
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const dir = path.join(LIBRARY_DIR, e.name)
    let meta = null
    try { meta = JSON.parse(fs.readFileSync(path.join(dir, 'set.json'), 'utf8')) } catch { continue }
    let text = ''
    try { text = fs.readFileSync(path.join(dir, 'cases.jsonl'), 'utf8') } catch { continue }
    db.exec('BEGIN')
    try {
      insSet.run(e.name, String(meta.name || e.name), JSON.stringify(meta.source || {}),
        Number(meta.createdAt) || Date.now(), Number(meta.updatedAt) || Date.now())
      for (const line of text.split('\n')) {
        const t = line.trim()
        if (t === '') continue
        let c
        try { c = JSON.parse(t) } catch { continue }
        if (!c || typeof c.prompt !== 'string' || c.prompt === '') continue
        const ref = String(c.sourceRef || c.id || promptHash(c.prompt))
        const r = insCase.run(e.name, ref, String(c.id || 'c-' + ref), c.prompt,
          String(c.language || ''), JSON.stringify(Array.isArray(c.tags) ? c.tags : []),
          JSON.stringify(c.meta && typeof c.meta === 'object' ? c.meta : {}),
          Number(c.createdAt) || Date.now())
        if (r.changes > 0) {
          for (const tag of Array.isArray(c.tags) ? c.tags : []) insTag.run(e.name, String(tag), String(c.id || 'c-' + ref))
        }
      }
      db.exec('COMMIT')
      console.log(`[artifact-hub] 用例库迁移：${e.name} 入库完成`)
    } catch (err) {
      db.exec('ROLLBACK')
      console.error(`[artifact-hub] 用例库迁移失败（${e.name}）:`, err.message)
    }
  }
}

function jsonParse(s, fallback) {
  try { return JSON.parse(s) } catch { return fallback }
}

/** 集元信息视图（含实时 count / tagCounts）。 */
function libSetView(db, row) {
  const count = db.prepare('SELECT COUNT(*) AS n FROM cases WHERE set_id = ?').get(row.id).n
  const tagCounts = {}
  for (const r of db.prepare('SELECT tag, COUNT(*) AS n FROM case_tags WHERE set_id = ? GROUP BY tag').all(row.id)) {
    tagCounts[r.tag] = r.n
  }
  return {
    id: row.id,
    name: row.name,
    source: jsonParse(row.source, {}),
    count,
    tagCounts,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/** setId 校验 + 取集；不存在返回 null。 */
function libResolveSet(db, setId) {
  if (typeof setId !== 'string' || !/^[\w.-]+$/.test(setId)) return null
  const row = db.prepare('SELECT * FROM sets WHERE id = ?').get(setId)
  return row || null
}

/** RFC-4180 CSV 解析（引号、转义引号、字段内换行、\r\n）。返回 string[][]。 */
function parseCsv(text) {
  const rows = []
  let row = []
  let field = ''
  let inQuotes = false
  let i = 0
  const n = text.length
  // 跳过 BOM
  if (text.charCodeAt(0) === 0xfeff) i = 1
  while (i < n) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue }
        inQuotes = false; i++; continue
      }
      field += ch; i++; continue
    }
    if (ch === '"') { inQuotes = true; i++; continue }
    if (ch === ',') { row.push(field); field = ''; i++; continue }
    if (ch === '\r') { i++; continue }
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue }
    field += ch; i++
  }
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row) }
  // 丢弃全空行
  return rows.filter((r) => r.some((c) => c !== ''))
}

/**
 * 解析数据集文本为统一的对象行：{ columns, rows }。
 * format: 'csv' | 'jsonl' | 'json'；省略时按 fileName 扩展名猜，退回 csv。
 */
function parseDataset(text, format, fileName) {
  let kind = format
  if (kind !== 'csv' && kind !== 'jsonl' && kind !== 'json') {
    const ext = String(fileName || '').toLowerCase()
    kind = ext.endsWith('.jsonl') || ext.endsWith('.ndjson') ? 'jsonl'
      : ext.endsWith('.json') ? 'json' : 'csv'
  }
  if (kind === 'csv') {
    const table = parseCsv(text)
    if (table.length === 0) return { kind, columns: [], rows: [] }
    const columns = table[0].map((c, i) => (c === '' ? 'col_' + i : c))
    const rows = []
    for (let r = 1; r < table.length; r++) {
      const obj = {}
      for (let c = 0; c < columns.length; c++) obj[columns[c]] = table[r][c] !== undefined ? table[r][c] : ''
      rows.push(obj)
    }
    return { kind, columns, rows }
  }
  if (kind === 'jsonl') {
    const rows = []
    const cols = []
    const seen = new Set()
    for (const line of text.split('\n')) {
      const t = line.trim()
      if (t === '') continue
      let obj
      try { obj = JSON.parse(t) } catch { continue }
      if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) continue
      for (const k of Object.keys(obj)) {
        if (!seen.has(k)) { seen.add(k); cols.push(k) }
      }
      rows.push(obj)
    }
    return { kind, columns: cols, rows }
  }
  // json：数组，或 { data|items|rows: [...] }
  let parsed
  try { parsed = JSON.parse(text) } catch { return { kind, columns: [], rows: [] } }
  const arr = Array.isArray(parsed) ? parsed
    : (parsed && Array.isArray(parsed.data) ? parsed.data
      : (parsed && Array.isArray(parsed.items) ? parsed.items
        : (parsed && Array.isArray(parsed.rows) ? parsed.rows : [])))
  const rows = arr.filter((o) => o !== null && typeof o === 'object' && !Array.isArray(o))
  const cols = []
  const seen = new Set()
  for (const obj of rows.slice(0, 200)) {
    for (const k of Object.keys(obj)) {
      if (!seen.has(k)) { seen.add(k); cols.push(k) }
    }
  }
  return { kind, columns: cols, rows }
}

/** 根据列名自动猜字段映射（prompt / sourceRef / language / tags）。 */
function guessMapping(columns) {
  const lower = new Map(columns.map((c) => [String(c).toLowerCase(), c]))
  const pick = (candidates) => {
    for (const c of candidates) if (lower.has(c)) return lower.get(c)
    return ''
  }
  const promptColumn = pick(['query_text', 'prompt', 'question', 'input', 'query', 'instruction', 'task_description', 'text', 'content', 'problem'])
  const refColumn = pick(['id', 'uid', 'case_id', 'source_id', 'qid', 'idx', 'name'])
  const languageColumn = pick(['language', 'lang', 'locale'])
  const tagColumns = columns.filter((c) => /^(l\d+_label|platform|category|domain|task|type|split|subject|source)$/i.test(String(c)))
  return { promptColumn, refColumn, languageColumn, tagColumns }
}

function promptHash(prompt) {
  // 稳定短哈希（FNV-1a 32bit），用于无 sourceRef 时去重。
  let h = 0x811c9dc5
  for (let i = 0; i < prompt.length; i++) {
    h ^= prompt.charCodeAt(i)
    h = (h * 0x01000193) >>> 0
  }
  return 'h' + h.toString(36)
}

/**
 * 按映射把一条原始行归一化为 Case；prompt 为空返回 null（跳过）。
 * mapping: { promptColumn, refColumn?, languageColumn?, tagColumns?[] }
 */
function normalizeLibraryCase(obj, mapping, setId) {
  const raw = (k) => {
    const v = obj[k]
    if (v === undefined || v === null) return ''
    return typeof v === 'string' ? v : String(v)
  }
  const prompt = raw(mapping.promptColumn).trim()
  if (prompt === '') return null
  const sourceRef = raw(mapping.refColumn).trim()
  const language = raw(mapping.languageColumn).trim()
  const tags = []
  for (const col of mapping.tagColumns || []) {
    const v = raw(col).trim()
    if (v !== '' && !tags.includes(v)) tags.push(v)
  }
  const mapped = new Set([mapping.promptColumn, mapping.refColumn, mapping.languageColumn].concat(mapping.tagColumns || []))
  const meta = {}
  for (const k of Object.keys(obj)) {
    if (mapped.has(k)) continue
    const v = obj[k]
    if (v === undefined || v === null || v === '') continue
    meta[k] = v
  }
  const ref = sourceRef !== '' ? sourceRef : promptHash(prompt)
  return {
    id: 'c-' + ref.replace(/[^\w.-]+/g, '_').slice(0, 60),
    setId,
    sourceRef: ref,
    prompt,
    language,
    tags,
    meta,
    createdAt: Date.now(),
  }
}

function slugifySetId(name) {
  const s = String(name || '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
  return s === '' ? 'set' : s
}

/** 读取数据集文本：path（服务器本地文件）或 content（上传文本）二选一。 */
async function readDatasetText(body) {
  const content = body.content
  if (typeof content === 'string' && content !== '') {
    if (Buffer.byteLength(content, 'utf8') > UPLOAD_MAX_BYTES) return { error: '上传内容超过 64MB 上限' }
    return { text: content, fileName: String(body.fileName || 'upload') }
  }
  const p = String(body.path || '')
  if (p === '') return { error: '缺 path 或 content' }
  if (!path.isAbsolute(p)) return { error: 'path 必须是绝对路径' }
  // 安全边界：仅允许白名单根下的普通数据文件，拒绝敏感目录/密钥文件
  // （Hub API 带 CORS *，任意外网页面都能调用，本地文件读取必须收口）。
  // 白名单：HOME、mock 根、mock 根的父目录（benchmark 数据集常与其并列，
  // 如 playground/tubiao_pg），另可用 ARTIFACT_HUB_IMPORT_ROOTS（冒号分隔）追加。
  const roots = [os.homedir(), MOCK_ROOT, path.dirname(MOCK_ROOT)]
  for (const extra of String(process.env.ARTIFACT_HUB_IMPORT_ROOTS || '').split(':')) {
    if (extra !== '') roots.push(extra)
  }
  const allowed = roots.some((root) => p === root || p.startsWith(root.replace(/[/\\]+$/, '') + path.sep))
  if (!allowed) return { error: '路径不在允许范围内（HOME / mock 根及其父目录，可用 ARTIFACT_HUB_IMPORT_ROOTS 追加）' }
  if (/(^|[/\\])\.(ssh|aws|gnupg|config[/\\]gcloud)([/\\]|$)/.test(p)) return { error: '拒绝读取敏感目录' }
  if (/(^|[/\\])[^\s]*\.(pem|key|p12|pfx)$/.test(p)) return { error: '拒绝读取密钥文件' }
  try {
    const stat = await fsp.stat(p)
    if (!stat.isFile()) return { error: '不是文件: ' + p }
    if (stat.size > LIBRARY_MAX_BYTES) return { error: '文件超过 128MB 上限' }
    const text = await fsp.readFile(p, 'utf8')
    return { text, fileName: path.basename(p), sourcePath: p }
  } catch (err) {
    return { error: '读取失败: ' + errorText(err) }
  }
}

function libCaseView(row) {
  return {
    id: row.id,
    setId: row.set_id,
    sourceRef: row.source_ref,
    prompt: row.prompt,
    language: row.language,
    tags: jsonParse(row.tags, []),
    meta: jsonParse(row.meta, {}),
    createdAt: row.created_at,
  }
}

/** 用例库 API 路由；命中返回 true。 */
async function apiLibrary(req, res, u) {
  const urlPath = u.pathname
  const db = libOpen()
  // 用例集列表
  if (urlPath === '/api/library/sets' && req.method === 'GET') {
    const rows = db.prepare('SELECT * FROM sets ORDER BY updated_at DESC').all()
    sendJson(res, 200, { ok: true, value: { sets: rows.map((r) => libSetView(db, r)) } })
    return true
  }
  // 解析预览：返回列名 + 样例行 + 猜测映射（不写库）
  if (urlPath === '/api/library/preview' && req.method === 'POST') {
    const body = await readBody(req)
    const src = await readDatasetText(body)
    if (src.error) { sendJson(res, 400, { ok: false, error: src.error }); return true }
    const data = parseDataset(src.text, body.format, src.fileName)
    if (data.columns.length === 0) { sendJson(res, 400, { ok: false, error: '未解析到任何数据行' }); return true }
    const trim = (v) => {
      const s = v === undefined || v === null ? '' : (typeof v === 'string' ? v : String(v))
      return s.length > 160 ? s.slice(0, 160) + '…' : s
    }
    const sampleRows = data.rows.slice(0, 3).map((obj) => {
      const out = {}
      for (const k of data.columns) out[k] = trim(obj[k])
      return out
    })
    sendJson(res, 200, {
      ok: true,
      value: {
        kind: data.kind,
        fileName: src.fileName,
        columns: data.columns,
        totalRows: data.rows.length,
        sampleRows,
        guessed: guessMapping(data.columns),
      },
    })
    return true
  }
  // 导入：归一化落库（setId 已存在则按 (set_id, source_ref) 主键去重合并）
  if (urlPath === '/api/library/import' && req.method === 'POST') {
    const body = await readBody(req)
    const mapping = body.mapping && typeof body.mapping === 'object' ? body.mapping : {}
    if (typeof mapping.promptColumn !== 'string' || mapping.promptColumn === '') {
      sendJson(res, 400, { ok: false, error: 'mapping.promptColumn 不能为空' }); return true
    }
    mapping.tagColumns = Array.isArray(mapping.tagColumns) ? mapping.tagColumns.filter((c) => typeof c === 'string' && c !== '') : []
    const src = await readDatasetText(body)
    if (src.error) { sendJson(res, 400, { ok: false, error: src.error }); return true }
    const data = parseDataset(src.text, body.format, src.fileName)
    if (data.rows.length === 0) { sendJson(res, 400, { ok: false, error: '未解析到任何数据行' }); return true }
    if (!data.columns.includes(mapping.promptColumn)) {
      sendJson(res, 400, { ok: false, error: 'prompt 列不存在: ' + mapping.promptColumn }); return true
    }
    // 目标集：显式 setId 合并导入，否则按名称生成唯一 slug
    let setId = typeof body.setId === 'string' && /^[\w.-]+$/.test(body.setId) ? body.setId : ''
    let setRow = null
    if (setId !== '') {
      setRow = libResolveSet(db, setId)
      if (setRow === null) { sendJson(res, 404, { ok: false, error: '用例集不存在: ' + setId }); return true }
    } else {
      const base = slugifySetId(body.name || src.fileName.replace(/\.[^.]+$/, ''))
      setId = base
      const exists = db.prepare('SELECT 1 FROM sets WHERE id = ?')
      for (let i = 2; ; i++) {
        if (exists.get(setId) === undefined) break
        setId = base + '-' + i
      }
    }
    const now = Date.now()
    const insSet = db.prepare('INSERT OR IGNORE INTO sets (id, name, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    const insCase = db.prepare('INSERT OR IGNORE INTO cases (set_id, source_ref, id, prompt, language, tags, meta, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    const insTag = db.prepare('INSERT OR IGNORE INTO case_tags (set_id, tag, case_id) VALUES (?, ?, ?)')
    let imported = 0
    let skipped = 0
    db.exec('BEGIN')
    try {
      insSet.run(setId, String(body.name || setId), JSON.stringify({
        kind: data.kind, path: src.sourcePath, fileName: src.fileName, mapping,
      }), now, now)
      for (const obj of data.rows) {
        const c = normalizeLibraryCase(obj, mapping, setId)
        if (c === null) { skipped++; continue }
        const r = insCase.run(c.setId, c.sourceRef, c.id, c.prompt, c.language,
          JSON.stringify(c.tags), JSON.stringify(c.meta), c.createdAt)
        if (r.changes > 0) {
          for (const t of c.tags) insTag.run(c.setId, t, c.id)
          imported++
        } else {
          skipped++
        }
      }
      // 合并导入时更新名称/映射快照与 updated_at
      db.prepare('UPDATE sets SET name = ?, source = ?, updated_at = ? WHERE id = ?').run(
        String(body.name || (setRow && setRow.name) || setId),
        JSON.stringify({ kind: data.kind, path: src.sourcePath, fileName: src.fileName, mapping }),
        now, setId)
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      sendJson(res, 500, { ok: false, error: '导入失败: ' + errorText(err) })
      return true
    }
    const meta = libSetView(db, db.prepare('SELECT * FROM sets WHERE id = ?').get(setId))
    sendJson(res, 200, { ok: true, value: { set: meta, imported, skipped } })
    return true
  }
  // 用例查询：tag / q（prompt、sourceRef 子串）筛选 + 分页
  if (urlPath === '/api/library/cases' && req.method === 'GET') {
    const setParam = (u.searchParams.get('setId') || '').trim()
    const setRow = setParam !== '' ? libResolveSet(db, setParam) : null
    if (setParam !== '' && setRow === null) { sendJson(res, 404, { ok: false, error: '用例集不存在' }); return true }
    const tag = (u.searchParams.get('tag') || '').trim()
    const q = (u.searchParams.get('q') || '').trim().toLowerCase()
    const idsRaw = (u.searchParams.get('ids') || '').trim()
    const offset = Math.max(0, Number(u.searchParams.get('offset')) || 0)
    const limit = Math.min(200, Math.max(1, Number(u.searchParams.get('limit')) || 50))
    const where = []
    const params = []
    if (setRow !== null) { where.push('set_id = ?'); params.push(setRow.id) }
    if (idsRaw !== '') {
      const ids = idsRaw.split(',').map((s) => s.trim()).filter((s) => s !== '')
      if (ids.length > 0) {
        where.push('cases.id IN (' + ids.map(() => '?').join(',') + ')')
        for (const id of ids) params.push(id)
      }
    }
    if (tag !== '') {
      where.push('EXISTS (SELECT 1 FROM case_tags t WHERE t.set_id = cases.set_id AND t.case_id = cases.id AND t.tag = ?)')
      params.push(tag)
    }
    if (q !== '') {
      where.push('(instr(lower(prompt), ?) > 0 OR instr(lower(source_ref), ?) > 0)')
      params.push(q, q)
    }
    const cond = where.length > 0 ? ' WHERE ' + where.join(' AND ') : ''
    const total = db.prepare('SELECT COUNT(*) AS n FROM cases' + cond).get(...params).n
    const rows = db.prepare('SELECT * FROM cases' + cond + ' ORDER BY created_at, source_ref LIMIT ? OFFSET ?')
      .all(...params, limit, offset)
    sendJson(res, 200, {
      ok: true,
      value: { total, offset, limit, cases: rows.map(libCaseView), set: setRow ? libSetView(db, setRow) : null },
    })
    return true
  }
  // 删除用例集
  if (urlPath === '/api/library/delete-set' && req.method === 'POST') {
    const body = await readBody(req)
    const setRow = libResolveSet(db, String(body.setId || ''))
    if (setRow === null) { sendJson(res, 404, { ok: false, error: '用例集不存在' }); return true }
    db.exec('BEGIN')
    try {
      db.prepare('DELETE FROM case_tags WHERE set_id = ?').run(setRow.id)
      db.prepare('DELETE FROM cases WHERE set_id = ?').run(setRow.id)
      db.prepare('DELETE FROM sets WHERE id = ?').run(setRow.id)
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      sendJson(res, 500, { ok: false, error: '删除失败: ' + errorText(err) })
      return true
    }
    sendJson(res, 200, { ok: true, value: { deleted: setRow.id } })
    return true
  }
  return false
}

// ---------------------------------------------------------------- 进程托管

/** id → runtime */
const runtimes = new Map()

function runtimeOf(id) {
  let rt = runtimes.get(id)
  if (!rt) {
    rt = {
      status: 'stopped', // stopped | installing | starting | running | failed
      port: null,
      url: null,
      pid: null,
      child: null,
      error: null,
      log: [],
      startedAt: null,
    }
    runtimes.set(id, rt)
  }
  return rt
}

function rtLog(rt, line) {
  rt.log.push({ time: Date.now(), line: String(line) })
  if (rt.log.length > LOG_RING_MAX) rt.log.splice(0, rt.log.length - LOG_RING_MAX)
}

async function allocPort() {
  const used = new Set([...runtimes.values()].map((r) => r.port).filter(Boolean))
  for (let port = PORT_BASE; port < PORT_MAX; port++) {
    if (used.has(port)) continue
    const free = await new Promise((resolve) => {
      const srv = http.createServer()
      srv.once('error', () => resolve(false))
      srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)))
    })
    if (free) return port
  }
  throw new Error('没有可用端口（49100-49900 全被占用）')
}

function spawnLogged(rt, command, args, opts) {
  const child = spawn(command, args, {
    cwd: opts.cwd,
    env: opts.env,
    shell: opts.shell === true,
    detached: true, // 独立进程组，stop 时整组杀掉（npm → vite/express 孙进程）
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  rt.child = child
  rt.pid = child.pid
  child.stdout.on('data', (buf) => String(buf).split('\n').filter(Boolean).forEach((l) => rtLog(rt, l)))
  child.stderr.on('data', (buf) => String(buf).split('\n').filter(Boolean).forEach((l) => rtLog(rt, l)))
  child.on('exit', (code, signal) => {
    rtLog(rt, `[hub] 进程退出 code=${code} signal=${signal}`)
    if (rt.status !== 'stopped') {
      rt.status = 'failed'
      rt.error = `进程退出（code=${code} signal=${signal}）`
    }
    rt.child = null
    rt.pid = null
  })
  child.on('error', (err) => {
    rtLog(rt, `[hub] 进程启动失败: ${errorText(err)}`)
    rt.status = 'failed'
    rt.error = errorText(err)
    rt.child = null
    rt.pid = null
  })
  return child
}

function killTree(rt) {
  if (rt.pid === null) return
  try { process.kill(-rt.pid, 'SIGTERM') } catch { try { process.kill(rt.pid, 'SIGTERM') } catch { /* 已死 */ } }
  setTimeout(() => {
    if (rt.pid === null) return
    try { process.kill(-rt.pid, 'SIGKILL') } catch { /* 已死 */ }
  }, 3000).unref()
}

async function waitReady(rt, port, readyPath) {
  const deadline = Date.now() + READY_TIMEOUT_MS
  const url = `http://127.0.0.1:${port}${readyPath || '/'}`
  while (Date.now() < deadline) {
    if (rt.status === 'failed' || rt.child === null) return false
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1500) })
      if (res.status < 600) return true
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 600))
  }
  return false
}

/** 根据 package.json 猜启动方式：vite → --port；next → -p；其余 → 只给 env PORT。 */
function nodeStartSpec(artifact, port, env) {
  const deps = new Set(artifact.deps || [])
  const scripts = artifact.scripts || []
  const npmRun = (args) => ({ command: NODE_BIN, args: [NPM_CLI, ...args], env })
  if (scripts.includes('dev')) {
    if (deps.has('vite') || deps.has('@vitejs/plugin-react')) {
      return npmRun(['run', 'dev', '--', '--port', String(port), '--host', '127.0.0.1', '--strictPort'])
    }
    if (deps.has('next')) {
      return npmRun(['run', 'dev', '--', '-p', String(port), '-H', '127.0.0.1'])
    }
    return npmRun(['run', 'dev'])
  }
  return npmRun(['start'])
}

async function startArtifact(id) {
  const items = await scanArtifactsCached(0)
  const artifact = items.find((a) => a.id === id)
  if (!artifact) throw new Error(`产物不存在: ${id}`)
  const rt = runtimeOf(id)
  if (rt.status === 'running' || rt.status === 'starting' || rt.status === 'installing') {
    return rt
  }
  rt.status = 'stopped'
  rt.error = null
  rt.log = []

  if (artifact.kind === 'static') {
    rt.status = 'running'
    rt.port = null
    rt.url = `${HUB_BASE}/preview/${artifact.id}/`
    rt.startedAt = Date.now()
    rtLog(rt, '[hub] 静态产物，由 Hub 直接伺服')
    return rt
  }

  const port = await allocPort()
  rt.port = port
  const env = { ...BASE_ENV, PORT: String(port), HOST: '127.0.0.1', BROWSER: 'none' }

  if (artifact.kind === 'node') {
    if (NPM_CLI === null) {
      rt.status = 'failed'
      rt.error = '未找到 npm（npm-cli.js），无法启动 Node 产物'
      return rt
    }
    // node_modules 缺失且声明了依赖 → 先 npm install
    const hasDeps = (artifact.deps || []).length > 0
    if (hasDeps && !(await pathExists(path.join(artifact.absDir, 'node_modules')))) {
      rt.status = 'installing'
      rtLog(rt, '[hub] node_modules 缺失，执行 npm install …')
      const install = spawnLogged(rt, NODE_BIN, [NPM_CLI, 'install', '--no-audit', '--no-fund'], { cwd: artifact.absDir, env })
      const code = await new Promise((resolve) => install.once('exit', resolve))
      if (code !== 0) {
        rt.status = 'failed'
        rt.error = `npm install 失败（code=${code}）`
        return rt
      }
      rtLog(rt, '[hub] npm install 完成')
    }
    rt.status = 'starting'
    const spec = nodeStartSpec(artifact, port, env)
    rtLog(rt, `[hub] 启动: npm ${spec.args.slice(1).join(' ')}（PORT=${port}）`)
    spawnLogged(rt, spec.command, spec.args, { cwd: artifact.absDir, env: spec.env })
  } else {
    // kind === 'command'：artifact.json 声明的自定义命令，{port} 占位符替换
    rt.status = 'starting'
    const cmd = (artifact.command || '').replaceAll('{port}', String(port))
    if (cmd.trim() === '') {
      rt.status = 'failed'
      rt.error = 'artifact.json 未声明 command'
      return rt
    }
    rtLog(rt, `[hub] 启动: ${cmd}（PORT=${port}）`)
    spawnLogged(rt, cmd, [], { cwd: artifact.absDir, env, shell: true })
  }

  const ready = await waitReady(rt, port, artifact.readyPath)
  if (ready) {
    rt.status = 'running'
    rt.url = `http://127.0.0.1:${port}/`
    rt.startedAt = Date.now()
    rtLog(rt, '[hub] 端口就绪，产物上线')
  } else if (rt.status !== 'failed') {
    rt.status = 'failed'
    rt.error = `等待端口 ${port} 就绪超时（${READY_TIMEOUT_MS / 1000}s），见日志`
  }
  return rt
}

function stopArtifact(id) {
  const rt = runtimeOf(id)
  if (rt.child !== null || rt.pid !== null) {
    rtLog(rt, '[hub] 停止进程')
    killTree(rt)
  }
  rt.status = 'stopped'
  rt.child = null
  rt.pid = null
  rt.url = rt.url // 保留上次 URL 便于展示
  return rt
}

function runtimeView(id, artifact) {
  const rt = runtimeOf(id)
  // 静态产物的 URL 由 Hub 决定，无需启动
  const url = artifact && artifact.kind === 'static' ? `${HUB_BASE}/preview/${id}/` : rt.url
  return {
    status: artifact && artifact.kind === 'static' ? 'running' : rt.status,
    url,
    port: rt.port,
    pid: rt.pid,
    error: rt.error,
    startedAt: rt.startedAt,
    logTail: rt.log.slice(-40),
  }
}

// ---------------------------------------------------------------- 静态产物伺服

const MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webp': 'image/webp',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.map': 'application/json', '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8', '.wasm': 'application/wasm',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg',
}

async function servePreview(req, res, urlPath) {
  // urlPath = /preview/<id 段...>/<文件...>
  const segments = urlPath.slice('/preview/'.length).split('/').filter((s) => s !== '')
  const artifacts = await scanArtifactsCached()
  // 最长前缀匹配产物 id（id 本身是 posix 相对路径）
  const sorted = [...artifacts].filter((a) => a.kind === 'static').sort((a, b) => b.id.length - a.id.length)
  let artifact = null
  let rest = []
  for (const a of sorted) {
    const idSegs = a.id.split('/')
    if (segments.length < idSegs.length) continue
    const prefix = segments.slice(0, idSegs.length)
    let ok = true
    for (let i = 0; i < idSegs.length; i++) {
      let dec
      try { dec = decodeURIComponent(prefix[i]) } catch { ok = false; break }
      if (dec !== idSegs[i]) { ok = false; break }
    }
    if (ok) { artifact = a; rest = segments.slice(idSegs.length); break }
  }
  if (artifact === null) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('未找到对应静态产物')
    return
  }
  const relParts = safeRelPath(rest)
  if (relParts === null) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('非法路径')
    return
  }
  let filePath = path.join(artifact.absDir, ...relParts)
  // 目录 → index.html；不存在 → SPA 回退到产物根 index.html
  let stat = await fsp.stat(filePath).catch(() => null)
  if (stat && stat.isDirectory()) {
    filePath = path.join(filePath, 'index.html')
    stat = await fsp.stat(filePath).catch(() => null)
  }
  if (!stat || !stat.isFile()) {
    const wantsHtml = String(req.headers.accept || '').includes('text/html') || relParts.length === 0
    if (wantsHtml) {
      filePath = path.join(artifact.absDir, 'index.html')
      stat = await fsp.stat(filePath).catch(() => null)
    }
  }
  if (!stat || !stat.isFile()) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('文件不存在')
    return
  }
  //  containment 双保险
  if (!path.resolve(filePath).startsWith(path.resolve(artifact.absDir) + path.sep)
    && path.resolve(filePath) !== path.resolve(path.join(artifact.absDir, 'index.html'))) {
    res.writeHead(403)
    res.end('越界路径')
    return
  }
  const ext = path.extname(filePath).toLowerCase()
  res.writeHead(200, {
    'content-type': MIME[ext] || 'application/octet-stream',
    'cache-control': 'no-cache',
  })
  if (req.method === 'HEAD') { res.end(); return }
  res.end(await fsp.readFile(filePath))
}

/** 伺服归档快照：/archive/<batchId>/<ts>/<snapshotDir>/<文件...>（路径越界校验同 /preview）。 */
async function serveArchive(req, res, urlPath) {
  const segments = urlPath.slice('/archive/'.length).split('/').filter((s) => s !== '')
  const dec = (s) => { try { return decodeURIComponent(s) } catch (err) { return null } }
  if (segments.length < 3) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('缺归档路径')
    return
  }
  const batchId = dec(segments[0])
  const ts = dec(segments[1])
  const snapDir = dec(segments[2])
  if (!batchId || !ts || !snapDir) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('非法归档路径')
    return
  }
  // 校验归档确实存在（防目录穿越：snapRoot 必须落在 ARCHIVES_DIR/<batchId>/<ts>）
  const snapRoot = path.join(ARCHIVES_DIR, batchId, ts, snapDir)
  if (!path.resolve(snapRoot).startsWith(path.resolve(path.join(ARCHIVES_DIR, batchId, ts)) + path.sep)) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('越界路径')
    return
  }
  const relParts = safeRelPath(segments.slice(3))
  if (relParts === null) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('非法路径')
    return
  }
  let filePath = path.join(snapRoot, ...relParts)
  let stat = await fsp.stat(filePath).catch(() => null)
  if (stat && stat.isDirectory()) {
    filePath = path.join(filePath, 'index.html')
    stat = await fsp.stat(filePath).catch(() => null)
  }
  if (!stat || !stat.isFile()) {
    const wantsHtml = String(req.headers.accept || '').includes('text/html') || relParts.length === 0
    if (wantsHtml) {
      filePath = path.join(snapRoot, 'index.html')
      stat = await fsp.stat(filePath).catch(() => null)
    }
  }
  if (!stat || !stat.isFile()) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('文件不存在')
    return
  }
  if (!path.resolve(filePath).startsWith(path.resolve(snapRoot) + path.sep)
    && path.resolve(filePath) !== path.resolve(path.join(snapRoot, 'index.html'))) {
    res.writeHead(403)
    res.end('越界路径')
    return
  }
  const ext = path.extname(filePath).toLowerCase()
  res.writeHead(200, {
    'content-type': MIME[ext] || 'application/octet-stream',
    'cache-control': 'no-cache',
  })
  if (req.method === 'HEAD') { res.end(); return }
  res.end(await fsp.readFile(filePath))
}

// ---------------------------------------------------------------- 管理页静态资源

async function servePublic(req, res, urlPath) {
  const rel = urlPath === '/' ? ['index.html'] : safeRelPath(urlPath.split('/').filter((s) => s !== ''))
  if (rel === null) { res.writeHead(403); res.end(); return }
  const filePath = path.join(PUBLIC_DIR, ...rel)
  if (!path.resolve(filePath).startsWith(path.resolve(PUBLIC_DIR) + path.sep)
    && path.resolve(filePath) !== path.resolve(path.join(PUBLIC_DIR, 'index.html'))) {
    res.writeHead(403); res.end(); return
  }
  const stat = await fsp.stat(filePath).catch(() => null)
  if (!stat || !stat.isFile()) { res.writeHead(404); res.end('not found'); return }
  const ext = path.extname(filePath).toLowerCase()
  res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream', 'cache-control': 'no-cache' })
  if (req.method === 'HEAD') { res.end(); return }
  res.end(await fsp.readFile(filePath))
}

// ---------------------------------------------------------------- HTTP API

async function readBody(req) {
  const chunks = []
  for await (const c of req) chunks.push(c)
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') } catch { return {} }
}

function sendJson(res, status, value) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-cache',
    // 允许 dsh GUI（不同端口）里的 Mock 面板直接探测/读取 Hub 状态（loopback 工具）
    'access-control-allow-origin': '*',
  })
  res.end(JSON.stringify(value))
}

async function apiState() {
  const items = await scanArtifactsCached(0)
  const batches = new Map()
  for (const a of items) {
    if (!batches.has(a.batchId)) batches.set(a.batchId, { batchId: a.batchId, name: a.batchName, artifacts: [] })
    batches.get(a.batchId).artifacts.push({ ...a, absDir: undefined, pkg: undefined, runtime: runtimeView(a.id, a) })
  }
  return {
    root: MOCK_ROOT,
    runsDir: RUNS_DIR,
    hubPort: HUB_PORT,
    dshApi: DSH_API,
    batches: [...batches.values()],
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, HUB_BASE)
    const urlPath = u.pathname

    if (urlPath === '/api/state' && req.method === 'GET') {
      sendJson(res, 200, { ok: true, value: await apiState() })
      return
    }
    if (urlPath.startsWith('/api/library')) {
      if (await apiLibrary(req, res, u)) return
    }
    if (urlPath === '/api/artifacts/start' && req.method === 'POST') {
      const body = await readBody(req)
      const rt = await startArtifact(String(body.id || ''))
      sendJson(res, 200, { ok: rt.status !== 'failed', value: { status: rt.status, url: rt.url, port: rt.port, error: rt.error } })
      return
    }
    if (urlPath === '/api/artifacts/stop' && req.method === 'POST') {
      const body = await readBody(req)
      const rt = stopArtifact(String(body.id || ''))
      sendJson(res, 200, { ok: true, value: { status: rt.status } })
      return
    }
    if (urlPath === '/api/artifacts/log' && req.method === 'GET') {
      const id = u.searchParams.get('id') || ''
      const rt = runtimes.get(id)
      sendJson(res, 200, { ok: true, value: { log: rt ? rt.log.slice(-200) : [] } })
      return
    }
    if (urlPath === '/api/trajectory' && req.method === 'GET') {
      const batchId = u.searchParams.get('batchId') || ''
      const sessions = await sessionsForBatch(batchId)
      sendJson(res, 200, { ok: true, value: { sessions } })
      return
    }
    if (urlPath === '/api/trajectory/events' && req.method === 'GET') {
      const sessionId = u.searchParams.get('sessionId') || ''
      if (sessionId === '') { sendJson(res, 400, { ok: false, error: '缺 sessionId' }); return }
      const value = await trajectoryEvents(sessionId)
      sendJson(res, 200, { ok: true, value })
      return
    }
    if (urlPath === '/api/iterations' && req.method === 'GET') {
      const caseId = u.searchParams.get('caseId') || ''
      const all = await scanArchives()
      sendJson(res, 200, { ok: true, value: { entries: caseId ? all.filter((e) => e.caseId === caseId) : all } })
      return
    }
    if (urlPath === '/api/iterations/fork' && req.method === 'POST') {
      // 「继续对话」：分叉归档记录的会话 → 继承上下文 + cwd 的新会话，
      // 在 dsh Mock 实验场批次下刷新可见并打开继续迭代。
      const body = await readBody(req)
      const sessionId = String(body.sessionId || '')
      if (sessionId === '') { sendJson(res, 400, { ok: false, error: '缺 sessionId' }); return }
      const value = await dshRpc('session.fork', { sessionId })
      sendJson(res, 200, { ok: true, value: { sessionId: value && value.sessionId ? value.sessionId : '' } })
      return
    }
    if (urlPath.startsWith('/archive/')) {
      await serveArchive(req, res, urlPath)
      return
    }
    if (urlPath.startsWith('/preview/')) {
      await servePreview(req, res, urlPath)
      return
    }
    if (req.method === 'GET' || req.method === 'HEAD') {
      await servePublic(req, res, urlPath)
      return
    }
    sendJson(res, 404, { ok: false, error: 'not found' })
  } catch (err) {
    sendJson(res, 500, { ok: false, error: errorText(err) })
  }
})

server.listen(HUB_PORT, '127.0.0.1', () => {
  console.log(`[artifact-hub] mock root: ${MOCK_ROOT}`)
  console.log(`[artifact-hub] dsh api:   ${DSH_API}`)
  console.log(`[artifact-hub] 管理页:    ${HUB_BASE}/`)
})

function shutdown() {
  console.log('[artifact-hub] 退出，清理子进程…')
  for (const rt of runtimes.values()) killTree(rt)
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
