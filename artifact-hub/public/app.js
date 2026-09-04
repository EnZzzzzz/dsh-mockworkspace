/* artifact-hub 管理页：左产物渲染 + 右会话轨迹 */
'use strict'

const $ = (sel) => document.querySelector(sel)

const state = {
  root: '',
  dshApi: '',
  batches: [],          // [{ batchId, name, artifacts: [...] }]
  selectedId: null,     // 当前产物 id
  sessions: [],         // 当前批次的会话
  sessionId: null,      // 当前轨迹会话
  showLog: false,
  iterations: [],       // 归档时间线条目（scanArchives）
  iterCaseFilter: '',   // 按用例筛选
  forked: {},           // `${batchId}|${sessionId}` → 分叉出的新会话 id
}

// ---------------------------------------------------------------- 工具

async function api(path, opts) {
  const res = await fetch(path, opts)
  const msg = await res.json().catch(() => null)
  if (!msg) throw new Error('响应异常 HTTP ' + res.status)
  if (msg.ok !== true) throw new Error(msg.error || '请求失败')
  return msg.value
}

const esc = (s) => String(s)
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')

const fmtTime = (t) => {
  if (!t) return ''
  const d = new Date(t)
  const pad = (n) => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function findArtifact(id) {
  for (const b of state.batches) {
    const hit = b.artifacts.find((a) => a.id === id)
    if (hit) return { artifact: hit, batch: b }
  }
  return null
}

// ---------------------------------------------------------------- 产物栏

function renderRail() {
  const box = $('#artifact-list')
  if (state.batches.length === 0) {
    box.innerHTML = '<div class="empty dim">runs/ 下未扫描到产物</div>'
    return
  }
  const html = state.batches.map((b) => {
    const items = b.artifacts.map((a) => {
      const st = a.runtime.status
      const sel = a.id === state.selectedId ? ' selected' : ''
      return `<div class="artifact-item${sel}" data-id="${esc(a.id)}" title="${esc(a.id)}">
        <span class="status-dot ${esc(st)}"></span>
        <span class="a-name">${esc(a.name)}</span>
        <span class="badge ${esc(a.kind)}">${esc(a.kind)}</span>
      </div>`
    }).join('')
    return `<div class="batch-group">
      <div class="batch-name" title="${esc(b.batchId)}">${esc(b.name || b.batchId)}</div>
      ${items}
    </div>`
  }).join('')
  box.innerHTML = html
  box.querySelectorAll('.artifact-item').forEach((el) => {
    el.addEventListener('click', () => selectArtifact(el.dataset.id))
  })
}

// ---------------------------------------------------------------- 预览区

function renderPreviewPane() {
  const found = state.selectedId ? findArtifact(state.selectedId) : null
  const art = found ? found.artifact : null
  const rt = art ? art.runtime : null

  $('#pv-name').textContent = art ? art.name : '未选择产物'
  const kind = $('#pv-kind')
  kind.textContent = art ? art.kind : ''
  kind.className = 'badge' + (art ? ' ' + art.kind : '')

  const dot = $('#pv-status')
  dot.className = 'status-dot ' + (rt ? rt.status : 'stopped')
  dot.title = rt ? rt.status + (rt.error ? '：' + rt.error : '') : ''

  const running = rt && rt.status === 'running'
  const busy = rt && (rt.status === 'starting' || rt.status === 'installing')
  $('#btn-start').disabled = !art || art.kind === 'static' || running || busy
  $('#btn-start').textContent = busy ? (rt.status === 'installing' ? '安装依赖…' : '启动中…') : '启动'
  $('#btn-stop').disabled = !art || art.kind === 'static' || (!running && !busy)
  $('#btn-reload').disabled = !running
  $('#btn-log').disabled = !art || art.kind === 'static'

  const openBtn = $('#btn-open')
  if (running && rt.url) {
    openBtn.style.display = ''
    openBtn.href = rt.url
  } else {
    openBtn.style.display = 'none'
  }

  $('#pv-url').textContent = rt && rt.url ? rt.url : (art ? art.id : '')

  const frame = $('#preview-frame')
  const empty = $('#preview-empty')
  const log = $('#preview-log')

  if (state.showLog && art && art.kind !== 'static') {
    frame.style.display = 'none'
    empty.style.display = 'none'
    log.style.display = 'block'
    loadLog(art.id)
  } else if (running && rt.url) {
    empty.style.display = 'none'
    log.style.display = 'none'
    frame.style.display = 'block'
    if (frame.dataset.src !== rt.url) {
      frame.src = rt.url
      frame.dataset.src = rt.url
    }
  } else {
    frame.style.display = 'none'
    log.style.display = 'none'
    empty.style.display = 'flex'
    frame.dataset.src = ''
    if (art) {
      const failMsg = rt && rt.status === 'failed'
        ? `<p class="trace-error trace-item">启动失败：${esc(rt.error || '')}</p>`
        : ''
      empty.innerHTML = `<p>${esc(art.name)}</p>${failMsg}<p class="hint">${
        art.kind === 'static' ? '静态产物异常' : '点「启动」分配端口并拉起服务'
      }</p>`
    } else {
      empty.innerHTML = '<p>从左侧选择一个产物</p><p class="hint">静态产物由 Hub 直接伺服；Node / 自定义命令产物点「启动」分配端口起服务。</p>'
    }
  }
}

async function loadLog(id) {
  try {
    const v = await api('/api/artifacts/log?id=' + encodeURIComponent(id))
    const log = $('#preview-log')
    const stick = log.scrollTop + log.clientHeight >= log.scrollHeight - 30
    log.textContent = v.log.map((l) => `[${fmtTime(l.time)}] ${l.line}`).join('\n')
    if (stick) log.scrollTop = log.scrollHeight
  } catch { /* 日志拉取失败静默 */ }
}

// ---------------------------------------------------------------- 轨迹区

async function loadSessions(batchId) {
  const sel = $('#session-select')
  try {
    const v = await api('/api/trajectory?batchId=' + encodeURIComponent(batchId))
    state.sessions = v.sessions
  } catch (err) {
    state.sessions = []
    $('#trace-body').innerHTML = `<div class="trace-item trace-error">轨迹加载失败：${esc(err.message)}</div>`
  }
  if (state.sessions.length === 0) {
    sel.innerHTML = '<option value="">（批次无会话）</option>'
    sel.disabled = true
    $('#btn-trace-refresh').disabled = true
    state.sessionId = null
    return
  }
  sel.disabled = false
  $('#btn-trace-refresh').disabled = false
  sel.innerHTML = state.sessions.map((s) => {
    const label = `${s.running ? '● ' : ''}${s.title || s.sessionId.slice(8, 20)} · ${fmtTime(s.updatedAt)}`
    return `<option value="${esc(s.sessionId)}">${esc(label)}</option>`
  }).join('')
  // 默认选最近更新的会话
  if (!state.sessions.some((s) => s.sessionId === state.sessionId)) {
    state.sessionId = state.sessions[0].sessionId
  }
  sel.value = state.sessionId
}

function renderTrace(entries) {
  const body = $('#trace-body')
  if (entries.length === 0) {
    body.innerHTML = '<div class="empty dim">会话暂无轨迹事件</div>'
    return
  }
  const html = entries.map((e) => {
    const time = `<span class="t-time">${fmtTime(e.time)}</span>`
    switch (e.kind) {
      case 'turn-start':
        return `<div class="trace-turn">Turn ${e.turn ?? '?'} 开始</div>`
      case 'turn-end':
        return `<div class="trace-turn">Turn ${e.turn ?? '?'} 结束${e.reason ? ' · ' + esc(e.reason) : ''}</div>`
      case 'user':
        return `<div class="trace-item trace-user">
          <div class="t-meta">👤 用户 ${time}</div>
          <div class="trace-text">${esc(e.text)}</div>
        </div>`
      case 'assistant': {
        const reasoning = e.reasoning
          ? `<details class="trace-reasoning"><summary>思考过程</summary><div class="inner">${esc(e.reasoning)}</div></details>`
          : ''
        const text = e.text ? `<div class="trace-text">${esc(e.text)}</div>` : ''
        return `<div class="trace-item trace-assistant">
          <div class="t-meta">🤖 Assistant ${time}</div>
          ${text}${reasoning}
        </div>`
      }
      case 'tool': {
        const stateClass = e.done ? (e.resultError ? 'err' : 'ok') : 'pending'
        const stateText = e.done ? (e.resultError ? '✗ 失败' : '✓') : '…'
        const title = e.title || e.argsSummary || ''
        return `<div class="trace-item trace-tool" data-call="${esc(e.callId || '')}">
          <div class="t-head" data-toggle>
            <span class="t-name">${esc(e.name)}</span>
            <span class="t-title" title="${esc(title)}">${esc(title)}</span>
            <span class="t-state ${stateClass}">${stateText}</span>
            ${time}
          </div>
          <div class="t-detail" style="display:none">
            ${e.args ? `<div><span class="label">参数</span>\n${esc(e.args)}</div>` : ''}
            ${e.resultText ? `<div style="margin-top:6px"><span class="label">结果</span>\n${esc(e.resultText)}</div>` : ''}
          </div>
        </div>`
      }
      default:
        return ''
    }
  }).join('')
  body.innerHTML = html
  body.querySelectorAll('[data-toggle]').forEach((el) => {
    el.addEventListener('click', () => {
      const detail = el.parentElement.querySelector('.t-detail')
      detail.style.display = detail.style.display === 'none' ? 'block' : 'none'
    })
  })
}

async function loadTrace() {
  if (!state.sessionId) return
  const body = $('#trace-body')
  const stick = body.scrollTop + body.clientHeight >= body.scrollHeight - 40
  try {
    const v = await api('/api/trajectory/events?sessionId=' + encodeURIComponent(state.sessionId))
    renderTrace(v.entries)
    if (stick) body.scrollTop = body.scrollHeight
  } catch (err) {
    body.innerHTML = `<div class="trace-item trace-error">轨迹加载失败：${esc(err.message)}</div>`
  }
}

// ---------------------------------------------------------------- 用例迭代（归档时间线）

async function loadIterations(rebuildFilter = false) {
  try {
    const q = state.iterCaseFilter ? '?caseId=' + encodeURIComponent(state.iterCaseFilter) : ''
    const v = await api('/api/iterations' + q)
    state.iterations = v.entries
    renderIterations(rebuildFilter)
  } catch (err) {
    $('#iter-body').innerHTML = `<div class="trace-item trace-error">迭代时间线加载失败：${esc(err.message)}</div>`
  }
}

function iterTs(e) {
  return String(e.archiveId || '').split('/')[1] || ''
}

function renderIterations(rebuildFilter = false) {
  const body = $('#iter-body')
  if (state.iterations.length === 0) {
    body.innerHTML = '<div class="empty dim">还没有归档记录。<br><span class="hint">在 dsh Mock 实验场的批次会话上点「归档」按钮，即归档产物快照 + 会话记录（含用例 ID / 日期）。</span></div>'
    if (rebuildFilter) rebuildIterFilter()
    return
  }
  // 按用例分组；未关联用例的归档按批次聚合到「未关联用例」
  const groups = new Map()
  for (const e of state.iterations) {
    const key = e.caseId || '未关联用例'
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(e)
  }
  const html = [...groups.entries()].map(([key, list]) => `
    <div class="iter-group">
      <div class="iter-group-title" title="${esc(key)}">${esc(key)} <span class="dim">· ${list.length} 条记录</span></div>
      ${list.map(renderIterRow).join('')}
    </div>`).join('')
  body.innerHTML = html
  body.querySelectorAll('[data-act="trace"]').forEach((el) => {
    el.addEventListener('click', () => jumpToTrace(el.dataset.batch, el.dataset.session))
  })
  body.querySelectorAll('[data-act="fork"]').forEach((el) => {
    el.addEventListener('click', () => forkIteration(el))
  })
  if (rebuildFilter) rebuildIterFilter()
}

function renderIterRow(e) {
  const ts = iterTs(e)
  const isSnapshot = e.kind === 'snapshot'
  const snapLinks = (e.artifacts || []).filter((a) => a.snapshotDir).map((a) => {
    const url = `/archive/${encodeURIComponent(e.batchId)}/${encodeURIComponent(ts)}/${encodeURIComponent(a.snapshotDir)}/`
    return `<a class="iter-link" href="${url}" target="_blank" rel="noopener" title="${esc(url)}">预览·${esc(a.name)}</a>`
  }).join(' ')
  const fk = state.forked[e.batchId + '|' + e.sessionId]
  const forkCell = fk
    ? `<span class="iter-forked" title="新会话 ${esc(fk)}：到 dsh Mock 实验场批次下刷新并打开，继续提改进意见">已分叉 → ${esc(String(fk).slice(0, 12))}…</span>`
    : `<button type="button" class="iter-btn" data-act="fork" data-batch="${esc(e.batchId)}" data-session="${esc(e.sessionId)}" title="${isSnapshot ? '从快照分叉新会话继续迭代（快照本身保持不变）' : '分叉该会话（继承全部上下文），在新会话里继续迭代'}">继续对话</button>`
  const date = e.archivedAt ? new Date(e.archivedAt).toLocaleString('zh-CN', { hour12: false }) : ''
  const badge = isSnapshot ? '<span class="iter-badge-snap">快照</span>' : ''
  const note = isSnapshot && e.note ? `<span class="iter-note" title="${esc(e.note)}">${esc(e.note)}</span>` : ''
  return `<div class="iter-row">
    <span class="iter-date" title="${esc(e.archivedAt || '')}">${esc(date)}</span>
    ${badge}
    <span class="iter-meta" title="批次 ${esc(e.batchId)}">${esc(e.batchName)}</span>
    ${note}
    <span class="iter-sess mono" title="会话 ${esc(e.sessionId)}${isSnapshot && e.sourceSessionId ? '（快照自 ' + esc(e.sourceSessionId) + '）' : ''}">${esc(String(e.sessionId || '').slice(0, 12))}</span>
    <span class="iter-art">${snapLinks || '<span class="dim">无快照</span>'}</span>
    <span class="iter-acts">
      <button type="button" class="iter-btn" data-act="trace" data-batch="${esc(e.batchId)}" data-session="${esc(e.sessionId)}" title="查看该会话执行轨迹">轨迹</button>
      ${forkCell}
    </span>
  </div>`
}

function rebuildIterFilter() {
  const sel = $('#iter-case-filter')
  const ids = [...new Set(state.iterations.map((e) => e.caseId || '').filter(Boolean))]
  sel.innerHTML = '<option value="">全部用例</option>' + ids.map((id) =>
    `<option value="${esc(id)}"${id === state.iterCaseFilter ? ' selected' : ''}>${esc(id)}</option>`).join('')
}

function jumpToTrace(batchId, sessionId) {
  state.sessionId = sessionId
  $('#trace-body').innerHTML = '<div class="empty dim">加载会话…</div>'
  loadSessions(batchId).then(() => {
    const sel = $('#session-select')
    if (sel.value !== sessionId) {
      sel.value = sessionId
      state.sessionId = sessionId
    }
    loadTrace()
  })
}

async function forkIteration(el) {
  const batchId = el.dataset.batch
  const sessionId = el.dataset.session
  el.disabled = true
  el.textContent = '分叉中…'
  try {
    const v = await api('/api/iterations/fork', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    })
    state.forked[batchId + '|' + sessionId] = v.sessionId
    renderIterations()
  } catch (err) {
    el.disabled = false
    el.textContent = '继续对话'
    alert('分叉失败：' + err.message)
  }
}

// ---------------------------------------------------------------- 选择 & 刷新

async function selectArtifact(id) {
  state.selectedId = id
  state.showLog = false
  state.sessionId = null
  state.sessions = []
  renderRail()
  renderPreviewPane()
  const found = findArtifact(id)
  $('#trace-body').innerHTML = '<div class="empty dim">加载会话…</div>'
  if (found) {
    await loadSessions(found.batch.batchId)
    await loadTrace()
  }
}

async function refreshState(keepSelection = true) {
  try {
    const v = await api('/api/state')
    state.root = v.root
    state.dshApi = v.dshApi
    state.batches = v.batches
    $('#root-label').textContent = v.root
    $('#dsh-label').textContent = 'dsh: ' + v.dshApi
  } catch (err) {
    $('#artifact-list').innerHTML = `<div class="empty dim">状态加载失败：${esc(err.message)}</div>`
    return
  }
  if (!keepSelection || !findArtifact(state.selectedId)) {
    // 深链：?select=<artifactId>（Mock 面板产物行点入）优先；否则默认最新批次第一个产物
    const qs = new URLSearchParams(location.search).get('select')
    const first = state.batches[0] && state.batches[0].artifacts[0]
    const pick = (qs && findArtifact(qs)) ? qs : (first ? first.id : null)
    if (pick) {
      await selectArtifact(pick)
      return
    }
    state.selectedId = null
  }
  renderRail()
  renderPreviewPane()
}

// ---------------------------------------------------------------- 事件绑定

$('#btn-refresh').addEventListener('click', () => refreshState(true))

$('#btn-start').addEventListener('click', async () => {
  if (!state.selectedId) return
  const found = findArtifact(state.selectedId)
  if (found) found.artifact.runtime.status = 'starting'
  renderPreviewPane()
  try {
    await api('/api/artifacts/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: state.selectedId }),
    })
  } catch (err) {
    alert('启动失败：' + err.message)
  }
  await refreshState(true)
})

$('#btn-stop').addEventListener('click', async () => {
  if (!state.selectedId) return
  try {
    await api('/api/artifacts/stop', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: state.selectedId }),
    })
  } catch (err) {
    alert('停止失败：' + err.message)
  }
  await refreshState(true)
})

$('#btn-reload').addEventListener('click', () => {
  const frame = $('#preview-frame')
  if (frame.dataset.src) {
    frame.src = frame.dataset.src + (frame.dataset.src.includes('?') ? '&' : '?') + '_r=' + Date.now()
    frame.dataset.src = frame.src
  }
})

$('#btn-log').addEventListener('click', () => {
  state.showLog = !state.showLog
  renderPreviewPane()
})

$('#session-select').addEventListener('change', (e) => {
  state.sessionId = e.target.value
  loadTrace()
})

$('#btn-trace-refresh').addEventListener('click', () => loadTrace())

$('#btn-iter-refresh').addEventListener('click', () => loadIterations(true))
$('#iter-case-filter').addEventListener('change', (e) => {
  state.iterCaseFilter = e.target.value
  loadIterations(true)
})

// ---------------------------------------------------------------- 轮询

setInterval(() => {
  refreshState(true)
  loadIterations()
}, 5000)
setInterval(() => {
  const cur = state.sessions.find((s) => s.sessionId === state.sessionId)
  if (cur && cur.running) loadTrace()
}, 4000)

refreshState(false)
loadIterations(true)
