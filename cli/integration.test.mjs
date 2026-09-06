import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createOperations } from '../artifact-hub/operations.mjs'

const repo = fileURLToPath(new URL('../', import.meta.url))
const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))

test('CLI → real Hub: cases, attachments, tasks, archive and snapshot', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-cli-test-'))
  const calls = [], sessions = []
  const dsh = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk
    const { method, payload, rpcId } = JSON.parse(body)
    calls.push({ method, payload })
    let value = { accepted: true }
    if (method === 'session.create') { value = { sessionId: 'session-1' }; sessions.push({ ...value, cwd: payload.cwd, running: false }) }
    if (method === 'session.list') value = { items: sessions }
    if (method === 'session.fork') value = { sessionId: 'frozen-1' }
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ type: 'server-response', rpcId, result: { ok: true, value } }))
  })
  const dshPort = await listen(dsh)
  const probe = http.createServer(); const port = await listen(probe); await new Promise((r) => probe.close(r))
  const hub = spawn(process.execPath, ['artifact-hub/server.mjs'], { cwd: repo, env: { ...process.env, MOCK_ROOT: root, DSH_API: `http://127.0.0.1:${dshPort}`, ARTIFACT_HUB_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] })
  t.after(async () => { hub.kill(); await new Promise((r) => hub.exitCode !== null ? r() : hub.once('exit', r)); await new Promise((r) => dsh.close(r)); await rm(root, { recursive: true, force: true }) })
  await new Promise((resolve, reject) => { hub.stdout.on('data', resolve); hub.once('exit', () => reject(new Error('Hub exited'))); hub.stderr.on('data', () => {}) })
  async function cli(args, input) {
    const child = spawn(process.execPath, ['cli/index.mjs', ...args, '--url', `http://127.0.0.1:${port}`], { cwd: repo })
    let out = '', err = ''; child.stdout.on('data', (s) => out += s); child.stderr.on('data', (s) => err += s)
    child.stdin.end(input)
    const code = await new Promise((r) => child.on('close', r))
    return { code, result: JSON.parse(code ? err : out) }
  }
  const added = await cli(['case', 'add', '--data', '-'], JSON.stringify({ name: 'test', prompt: 'Create page', tags: ['one', 'two'] }))
  assert.equal(added.code, 0, JSON.stringify(added)); const setId = added.result.value.set.id
  const listed = await cli(['case', 'list', '--set-id', setId, '--tag', 'two'])
  assert.equal(listed.result.value.total, 1)
  const item = listed.result.value.cases[0]
  assert.deepEqual(item.tags, ['one', 'two'])
  const attachment = path.join(root, 'material.txt'); await writeFile(attachment, 'material')
  assert.equal((await cli(['case', 'attach', '--data', JSON.stringify({ setId, caseId: item.id, paths: [attachment] })])).code, 0)
  const task = await cli(['task', 'create', '--set-id', setId, '--case-id', item.id, '--provider', 'test', '--model', 'test-model'])
  assert.equal(task.code, 0, JSON.stringify(task))
  const { batchId, batchPath, sessionId } = task.result.value
  assert.equal(await readFile(path.join(batchPath, 'assets/1-material.txt'), 'utf8'), 'material')
  assert.match(calls.find((c) => c.method === 'session.prompt').payload.content[0].text, /assets\/1-material.txt/)
  await writeFile(path.join(batchPath, 'index.html'), '<h1>Frozen</h1>')
  const args = ['--batch-id', batchId, '--session-id', sessionId]
  const snapshot = await cli(['snapshot', 'create', ...args, '--note', 'checkpoint'])
  assert.equal(snapshot.code, 0, JSON.stringify(snapshot))
  assert.equal(snapshot.result.value.record.sessionId, 'frozen-1')
  assert.equal(snapshot.result.value.record.sourceSessionId, sessionId)
  const record = snapshot.result.value.record
  const frozenFile = path.join(root, 'case-library/archives', record.archiveId, record.artifacts[0].snapshotDir, 'index.html')
  await writeFile(path.join(batchPath, 'index.html'), '<h1>Changed</h1>')
  assert.equal(await readFile(frozenFile, 'utf8'), '<h1>Frozen</h1>')
  assert.ok(calls.some((c) => c.method === 'workspace.archiveSession' && c.payload.sessionId === 'frozen-1'))
  assert.equal((await cli(['archive', 'create', ...args])).code, 0)
  assert.equal((await cli(['archive', 'list'])).result.value.entries.length, 2)
  assert.equal((await cli(['archive', 'create', '--batch-id', '../escape', '--session-id', sessionId])).code, 1)
  assert.equal((await cli(['case', 'list', '--typo', 'x'])).code, 1)
  assert.equal((await cli(['archive', 'delete', '--archive-id', snapshot.result.value.record.archiveId])).code, 1)
  sessions[0].running = true
  assert.equal((await cli(['snapshot', 'create', ...args])).code, 1)
  sessions[0].running = false
  const before = calls.length
  const ops = createOperations({ root, rpc: async () => ({ items: sessions }), collect: async () => ({ artifacts: [], builds: [{ ok: false }] }) })
  await assert.rejects(ops.archive({ batchId, sessionId }, 'snapshot'), /构建失败/)
  assert.equal(calls.length, before)
})
