import * as fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { collectArchiveArtifacts } from '../packaged/src/archive.js'

const required = (value, name) => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} 必填`)
  return value
}
const write = (file, value) => fs.writeFile(file, JSON.stringify(value, null, 2))

export function createOperations({ root, rpc, getCase, hash, collect = collectArchiveArtifacts }) {
  async function batch(id) {
    required(id, 'batchId')
    if (!/^[\w-][\w.-]*$/.test(id)) throw new Error('batchId 无效')
    const runs = await fs.realpath(path.join(root, 'runs'))
    const dir = await fs.realpath(path.join(runs, id))
    if (path.dirname(dir) !== runs) throw new Error('批次路径越界')
    return { dir, meta: JSON.parse(await fs.readFile(path.join(dir, 'meta.json'), 'utf8')) }
  }
  return {
    async createTask(args) {
      const item = args.caseId ? await getCase(required(args.setId, 'setId'), args.caseId) : null
      const prompt = required(args.prompt ?? item?.prompt, 'prompt')
      if (args.model && !args.provider) throw new Error('指定 model 时必须提供 provider')
      const batchId = randomUUID()
      const dir = path.join(root, 'runs', batchId)
      await fs.mkdir(dir, { recursive: true })
      const meta = { batchId, name: args.name || item?.sourceRef || 'CLI task', createdAt: Date.now(), status: 'active', promptHash: hash(prompt), assets: [] }
      if (item) Object.assign(meta, { caseId: item.id, caseSetId: item.setId, sourceRef: item.sourceRef })
      meta.gen = { ...(args.model ? { model: args.model } : {}), ...(args.agentPreset ? { agent: args.agentPreset } : {}) }
      let sessionId
      try {
        for (const [i, attachment] of (item?.attachments || []).entries()) {
          const base = await fs.realpath(path.join(root, 'case-library', 'attachments'))
          const src = await fs.realpath(path.resolve(root, 'case-library', attachment.stored))
          if (!src.startsWith(base + path.sep)) throw new Error('附件路径越界')
          const rel = `assets/${i + 1}-${path.basename(attachment.name)}`
          await fs.mkdir(path.join(dir, 'assets'), { recursive: true })
          await fs.copyFile(src, path.join(dir, rel))
          meta.assets.push(rel)
        }
        await write(path.join(dir, 'meta.json'), meta)
        const session = await rpc('session.create', { cwd: dir, ...(args.agentPreset ? { agentPreset: args.agentPreset } : {}) })
        sessionId = session.sessionId
        meta.sessionId = sessionId
        await write(path.join(dir, 'meta.json'), meta)
        await rpc('session.rename', { sessionId, title: meta.name })
        if (args.model) await rpc('session.selectModel', { sessionId, provider: args.provider, model: args.model, ...(args.reasoningEffort ? { reasoningEffort: args.reasoningEffort } : {}) })
        const text = prompt + (meta.assets.length ? '\n\n附件（相对当前工作目录）：\n' + meta.assets.join('\n') : '')
        await rpc('session.prompt', { sessionId, mode: 'queue', content: [{ type: 'text', text }] })
        return { batchId, batchPath: dir, sessionId, accepted: true }
      } catch (err) {
        meta.status = 'failed'; meta.error = err.message
        await write(path.join(dir, 'meta.json'), meta)
        throw new Error(`${err.message}; batchId=${batchId}${sessionId ? '; sessionId=' + sessionId : ''}（保留现场，请勿盲目重试）`)
      }
    },
    async archive(args, kind) {
      const source = required(args.sessionId, 'sessionId')
      const { dir, meta } = await batch(args.batchId)
      const sessions = await rpc('session.list', {})
      const session = sessions.items.find((s) => s.sessionId === source)
      const sessionDir = session?.cwd ? await fs.realpath(session.cwd).catch(() => '') : ''
      if (!sessionDir || !(sessionDir === dir || sessionDir.startsWith(dir + path.sep))) throw new Error('会话不属于该批次')
      if (session.running) throw new Error('请等待会话停止运行后再归档或创建快照')
      const ts = new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8)
      const dest = path.join(root, 'case-library', 'archives', args.batchId, ts)
      await fs.mkdir(dest, { recursive: true })
      let record, sessionId = source
      try {
        const result = await collect(dir, dest)
        if (result.builds.some((b) => !b.ok)) throw new Error('产物构建失败: ' + JSON.stringify(result.builds))
        if (kind === 'snapshot') sessionId = (await rpc('session.fork', { sessionId: source })).sessionId
        record = { archiveId: args.batchId + '/' + ts, batchId: args.batchId, batchName: meta.name || args.batchId, sessionId, caseId: meta.caseId || '', caseSetId: meta.caseSetId || '', promptHash: meta.promptHash || '', archivedAt: new Date().toISOString(), kind, ...result, gen: meta.gen || {}, assets: meta.assets || [], ...(kind === 'snapshot' ? { sourceSessionId: source } : {}), note: args.note || '' }
        await write(path.join(dest, 'record.json'), record)
      } catch (err) {
        await fs.rm(dest, { recursive: true, force: true })
        throw new Error(err.message + (sessionId !== source ? `; 已分叉 sessionId=${sessionId}` : ''))
      }
      // 保存记录后才隐藏会话；隐藏失败不丢失已生成的快照。
      try { await rpc('workspace.archiveSession', { sessionId }) }
      catch (err) { return { record, warning: '归档已保存，但隐藏会话失败: ' + err.message } }
      return { record }
    },
  }
}
