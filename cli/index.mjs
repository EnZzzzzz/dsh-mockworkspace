#!/usr/bin/env node
import { readFile } from 'node:fs/promises'

// Registry is also the machine-readable command discovery contract.
const commands = {
  'state': ['GET', '/api/state', []],
  'case list': ['GET', '/api/library/cases', [], ['setId', 'tag', 'q', 'ids', 'offset', 'limit']],
  'case add': ['POST', '/api/library/import', ['prompt'], ['setId', 'name', 'sourceRef', 'language', 'tags']],
  'case import': ['POST', '/api/library/import', [], ['path', 'content', 'fileName', 'format', 'name', 'setId', 'mapping']],
  'case preview': ['POST', '/api/library/preview', [], ['path', 'content', 'fileName', 'format']],
  'case attach': ['POST', '/api/library/attach', ['setId', 'caseId', 'paths']],
  'case detach': ['POST', '/api/library/detach', ['setId', 'caseId', 'name']],
  'set list': ['GET', '/api/library/sets', []],
  'set delete': ['POST', '/api/library/delete-set', ['setId']],
  'task create': ['POST', '/api/tasks/create', [], ['prompt', 'caseId', 'setId', 'name', 'agentPreset', 'provider', 'model', 'reasoningEffort']],
  'task list': ['GET', '/api/state', []],
  'task sessions': ['GET', '/api/trajectory', ['batchId']],
  'task events': ['GET', '/api/trajectory/events', ['sessionId']],
  'archive list': ['GET', '/api/iterations', [], ['caseId']],
  'archive create': ['POST', '/api/iterations/create', ['batchId', 'sessionId'], ['note']],
  'snapshot create': ['POST', '/api/iterations/snapshot', ['batchId', 'sessionId'], ['note']],
  'archive fork': ['POST', '/api/iterations/fork', ['sessionId']],
  'archive delete': ['POST', '/api/iterations/delete', ['archiveId']],
  'artifact start': ['POST', '/api/artifacts/start', ['id']],
  'artifact stop': ['POST', '/api/artifacts/stop', ['id']],
  'artifact log': ['GET', '/api/artifacts/log', ['id']],
}

async function main() {
  const argv = process.argv.slice(2), words = [], flags = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith('--')) { words.push(arg); continue }
    const [raw, ...rest] = arg.slice(2).split('=')
    const key = raw.replace(/-([a-z])/g, (_, c) => c.toUpperCase())
    if (Object.hasOwn(flags, key)) throw new Error('重复参数: ' + raw)
    if (key === 'help') { flags.help = true; continue }
    const value = rest.length ? rest.join('=') : argv[++i]
    if (value === undefined || value.startsWith('--')) throw new Error('参数缺少值: ' + raw)
    flags[key] = value
  }
  if (flags.help || !words.length || words[0] === 'help') {
    console.log('mock-workspace <command> [--kebab-case value] [--data JSON|@file|-]\n默认输出 JSON；错误写 stderr，退出码 1。\n全局参数: --url URL, --timeout 毫秒（默认 1800000）\n命令与参数 schema: mock-workspace schema\n\n' + Object.keys(commands).join('\n'))
    return
  }
  if (words.join(' ') === 'schema') {
    console.log(JSON.stringify({ commands: Object.fromEntries(Object.entries(commands).map(([name, [method, endpoint, required, optional = []]]) => [name, { method, endpoint, required, optional }])) }, null, 2))
    return
  }
  const command = words.join(' '), spec = commands[command]
  if (!spec) throw new Error('未知命令: ' + command)
  const url = flags.url || process.env.MOCK_WORKSPACE_URL || 'http://127.0.0.1:4780'
  const timeout = Number(flags.timeout || 1800000)
  if (!Number.isSafeInteger(timeout) || timeout < 1) throw new Error('timeout 必须为正整数')
  let data = {}
  if (flags.data) {
    const src = flags.data
    data = JSON.parse(src === '-' ? await (async () => { let text = ''; for await (const chunk of process.stdin) text += chunk; return text })() : src.startsWith('@') ? await readFile(src.slice(1), 'utf8') : src)
    if (!data || Array.isArray(data) || typeof data !== 'object') throw new Error('data 必须是 JSON 对象')
  }
  for (const key of ['url', 'timeout', 'data']) delete flags[key]
  for (const [key, value] of Object.entries(flags)) data[key] = ['mapping', 'paths', 'tags'].includes(key) ? JSON.parse(value) : value
  const [method, endpoint, required, optional = []] = spec
  for (const key of Object.keys(data)) if (![...required, ...optional].includes(key)) throw new Error('未知参数: ' + key)
  for (const key of required) if (data[key] === undefined || data[key] === '') throw new Error('缺少参数: ' + key)
  if (command === 'case add') {
    const { prompt, sourceRef, language, tags, setId, name } = data
    if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('prompt 不能为空')
    if (tags !== undefined && !Array.isArray(tags)) throw new Error('tags 必须是数组')
    data = { ...(setId ? { setId } : { name: name || 'CLI cases' }), format: 'json', fileName: 'cases.json', content: JSON.stringify([{ prompt, sourceRef, language, ...Object.fromEntries((tags || []).map((tag, i) => ['tag' + i, tag])) }]), mapping: { promptColumn: 'prompt', refColumn: 'sourceRef', languageColumn: 'language', tagColumns: (tags || []).map((_, i) => 'tag' + i) } }
  }
  const target = new URL(endpoint, url)
  if (method === 'GET') for (const [key, value] of Object.entries(data)) target.searchParams.set(key, String(value))
  const response = await fetch(target, { method, signal: AbortSignal.timeout(timeout), ...(method === 'POST' ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) } : {}) })
  const result = await response.json().catch(() => { throw new Error('服务未返回 JSON（请检查 Hub 地址和版本）') })
  if (!response.ok || result.ok !== true) throw new Error(typeof result.error === 'string' ? result.error : result.value?.error || JSON.stringify(result.error || result))
  console.log(JSON.stringify(result, null, 2))
}
main().catch((err) => {
  console.error(JSON.stringify({ ok: false, error: err.message, ...(err.cause?.code ? { code: err.cause.code } : {}) }))
  process.exitCode = 1
})
