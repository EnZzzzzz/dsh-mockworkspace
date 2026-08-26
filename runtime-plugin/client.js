// dsh-mock-workspace — runtime plugin Client half.
// 在左侧边栏注册第三个 tab「Mock」（id: mock，order: 3）：临时实验场面板。
// 面板职责（只做入口与组织，不做自动执行）：
//   - 「+ 新建」：输入名字 → Host 建 runs/<batch>/ 目录 + meta.json →
//     session.create({ cwd }) 开一个 cwd 指向批次目录的普通对话会话
//     （轨迹 = 会话日志，产物 = 会话生成的文件；无 workspace 归属）
//   - 批次列表：名字 / 时间 / 会话数，按时间倒序
//   - 展开批次：会话列表（点击打开）+ 标题行末尾「+」新建会话；产物文件经由「资源管理器」查看
//
// 本文件是交给 cordis_define 的 `code.client` 原文。纯 JS，无 import/TS/JSX
// （React 用 React.createElement）。Builtins：ctx / React / host / styles / console。

return {
  apply(ctx) {
    const slots = ctx.get('slots')
    if (slots === undefined) return

    const PANEL_ID = 'mock'
    const ORDER = 3
    const STATE_KEY = 'dsh.mock.batches.v1'

    // ---- persistence（browser localStorage, guarded） ----
    function readJSON(key) {
      try {
        const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null
        return raw ? JSON.parse(raw) : null
      } catch (e) {
        return null
      }
    }
    function writeJSON(key, value) {
      try {
        if (typeof localStorage !== 'undefined') localStorage.setItem(key, JSON.stringify(value))
      } catch (e) { /* best-effort */ }
    }

    // ---- inline SVG icons ----
    function SvgIcon(props) {
      return React.createElement('svg', {
        width: props.size || 16,
        height: props.size || 16,
        viewBox: '0 0 16 16',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.3,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        className: props.className,
        'aria-hidden': true,
      }, React.createElement('path', { d: props.d }))
    }
    const ICONS = {
      beaker: 'M8 2.5 C6 4 5 6 5 9 V11.5 A1.5 1.5 0 0 0 6.5 13 H9.5 A1.5 1.5 0 0 0 11 11.5 V9 C11 6 10 4 8 2.5 Z M6.5 8.5 H9.5',
      plus: 'M8 3 V13 M3 8 H13',
      refresh: 'M13.5 8 A5.5 5.5 0 1 1 11 4.3 M13.5 3 V5.5 H11',
      gear: 'M7 2.5 H9 L9.5 4.2 A4.5 4.5 0 0 1 11 5.1 L12.6 4.6 L13.6 6.4 L12.2 7.4 A4.5 4.5 0 0 1 12.2 8.6 L13.6 9.6 L12.6 11.4 L11 10.9 A4.5 4.5 0 0 1 9.5 11.8 L9 13.5 H7 L6.5 11.8 A4.5 4.5 0 0 1 5 10.9 L3.4 11.4 L2.4 9.6 L3.8 8.6 A4.5 4.5 0 0 1 3.8 7.4 L2.4 6.4 L3.4 4.6 L5 5.1 A4.5 4.5 0 0 1 6.5 4.2 Z M8 6 A2 2 0 1 0 8 10 A2 2 0 0 0 8 6 Z',
      folder: 'M2 4.5 A1.5 1.5 0 0 1 3.5 3 H5.8 L7.3 4.5 H12.5 A1.5 1.5 0 0 1 14 6 V11.5 A1.5 1.5 0 0 1 12.5 13 H3.5 A1.5 1.5 0 0 1 2 11.5 Z',
      archive: 'M3 4.5 H13 L12.5 12.5 A1 1 0 0 1 11.5 13.5 H4.5 A1 1 0 0 1 3.5 12.5 Z M4.5 7.5 H11.5',
      trash: 'M3 4.5 H13 M6 4.5 V3.5 A1 1 0 0 1 7 2.5 H9 A1 1 0 0 1 10 3.5 V4.5 M4.5 4.5 L5.2 12.5 A1 1 0 0 0 6.2 13.5 H9.8 A1 1 0 0 0 10.8 12.5 L11.5 4.5',
    }

    // ---- styles (own prefix dshmw-, theme tokens only) ----
    const CSS = `
.dshmw-root{flex:1;min-height:0;display:flex;flex-direction:column;box-sizing:border-box;padding:2px 4px 6px 0}
.dshmw-header{flex:none;display:flex;align-items:center;justify-content:space-between;gap:4px;height:32px;padding-left:8px;box-sizing:border-box;color:var(--dsw-alias-label-secondary)}
.dshmw-title{overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font-size:13px;font-weight:600}
.dshmw-headbtn{flex:none;display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;border:none;border-radius:50%;padding:0;background:transparent;cursor:pointer;color:var(--dsw-alias-label-secondary)}
.dshmw-headbtn:hover{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}
.dshmw-new{flex:none;display:inline-flex;align-items:center;justify-content:center;gap:4px;height:26px;border:none;border-radius:8px;padding:0 8px;background:transparent;cursor:pointer;color:var(--dsw-alias-label-secondary);font-size:12px}
.dshmw-new:hover{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}
.dshmw-form{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;margin:0 8px 6px;padding:8px;display:flex;flex-direction:column;gap:6px;box-sizing:border-box}
.dshmw-input{width:100%;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:12px;padding:5px 8px;font-family:inherit}
.dshmw-input:focus{outline:none;border-color:var(--dsw-alias-border-l2)}
.dshmw-formrow{display:flex;gap:6px}
.dshmw-formrow .dshmw-input{flex:1}
.dshmw-submit{flex:none;border:none;border-radius:6px;padding:5px 10px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);cursor:pointer;font-size:12px}
.dshmw-submit:hover{background:var(--dsw-alias-bg-layer-2)}
.dshmw-submit:disabled{opacity:.5;cursor:default}
.dshmw-error{flex:none;font-size:11px;color:var(--dsw-alias-state-error-primary);overflow-wrap:break-word}
.dshmw-list{flex:1;min-height:0;overflow-y:auto;overflow-x:hidden}
.dshmw-batchrow{position:relative;display:flex;align-items:center}
.dshmw-batchrow .dshmw-batch{flex:1;min-width:0}
.dshmw-batchacts{position:absolute;right:6px;display:none;align-items:center;gap:2px}
.dshmw-batchrow:hover .dshmw-batchacts{display:inline-flex}
.dshmw-batchact{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border:none;border-radius:5px;padding:0;background:var(--dsw-alias-bg-layer-1);cursor:pointer;color:var(--dsw-alias-label-secondary)}
.dshmw-batchact:hover{color:var(--dsw-alias-label-primary)}
.dshmw-batchact-danger{color:var(--dsw-alias-state-error-primary)}
.dshmw-batch{width:100%;display:flex;align-items:center;gap:6px;min-height:30px;margin-top:4px;padding:0 8px;box-sizing:border-box;border:none;background:transparent;cursor:pointer;color:var(--dsw-alias-label-secondary);font-size:13px;text-align:left;border-radius:8px}
.dshmw-batch:hover{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}
.dshmw-batchicon{flex:none;align-self:flex-start;margin-top:2px;color:var(--dsw-alias-label-secondary)}
.dshmw-batchmain{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px}
.dshmw-batchtitle{overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font-size:13px}
.dshmw-batchmeta{display:flex;align-items:center;gap:6px;font-size:11px;opacity:.75;min-width:0}
.dshmw-badge{flex:none;border-radius:4px;padding:0 5px;font-size:10px;line-height:16px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);overflow:hidden;white-space:nowrap;text-overflow:ellipsis;max-width:120px}
.dshmw-badge-archived{opacity:.55}
.dshmw-count{flex:none;font-size:11px;opacity:.75}
.dshmw-batchbody{padding:0 0 4px 12px;box-sizing:border-box}
.dshmw-sessplus{flex:none;width:8px;height:8px;display:inline-flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-secondary)}
.dshmw-sessrow{position:relative;display:flex;align-items:center}
.dshmw-sessrow .dshmw-sess{flex:1;min-width:0}
.dshmw-sessact{position:absolute;right:6px;display:none;align-items:center;justify-content:center;width:20px;height:20px;border:none;border-radius:5px;padding:0;background:var(--dsw-alias-bg-layer-1);cursor:pointer;color:var(--dsw-alias-label-secondary)}
.dshmw-sessact:hover{color:var(--dsw-alias-label-primary)}
.dshmw-sessrow:hover .dshmw-sessact{display:inline-flex}
.dshmw-sessrow:hover .dshmw-sessmeta{visibility:hidden}
.dshmw-sess{display:flex;align-items:center;gap:6px;width:100%;height:28px;border:none;border-radius:6px;padding:0 8px;box-sizing:border-box;background:transparent;cursor:pointer;color:var(--dsw-alias-label-secondary);font-size:12px;text-align:left}
.dshmw-sess:hover{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}
.dshmw-sessdot{flex:none;width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-state-success-primary)}
.dshmw-sessname{flex:1;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.dshmw-sessmeta{flex:none;font-size:11px;opacity:.7;max-width:40%;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.dshmw-status{display:flex;align-items:center;gap:8px;min-height:26px;padding:4px 8px;box-sizing:border-box;color:var(--dsw-alias-label-secondary);font-size:12px}
.dshmw-err{flex:1;min-width:0;color:var(--dsw-alias-state-error-primary);overflow-wrap:break-word}
.dshmw-retry{flex:none;border:none;border-radius:6px;padding:2px 8px;background:transparent;cursor:pointer;color:var(--dsw-alias-label-secondary);font-size:12px}
.dshmw-retry:hover{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}
.dshmw-empty{padding:16px 12px;color:var(--dsw-alias-label-secondary);font-size:13px}
.dshmw-hint{margin-top:4px;font-size:12px;opacity:.75}
.dshmw-rootpath{flex:none;padding:0 8px 4px;font-size:11px;opacity:.6;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;color:var(--dsw-alias-label-secondary)}
.dshmw-settings{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;margin:0 8px 6px;padding:8px;display:flex;flex-direction:column;gap:6px;box-sizing:border-box}
.dshmw-settingslabel{font-size:11px;font-weight:600;color:var(--dsw-alias-label-secondary)}
.dshmw-settingsrow{display:flex;gap:6px}
.dshmw-settingsrow .dshmw-input{flex:1;min-width:0}
.dshmw-browse{flex:none;border:none;border-radius:6px;padding:5px 8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);cursor:pointer;font-size:12px}
.dshmw-browse:hover{background:var(--dsw-alias-bg-layer-2)}
.dshmw-composer{box-sizing:border-box;width:100%;max-width:var(--dsh-composer-card-max-width,720px);margin:0 auto;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);border-radius:16px;padding:10px 12px;display:flex;flex-direction:column;gap:8px;box-shadow:var(--dsw-shadow-lv2)}
.dshmw-composerinput{width:100%;box-sizing:border-box;border:none;background:transparent;color:var(--dsw-alias-label-primary);font-size:14px;line-height:20px;font-family:inherit;resize:none;outline:none;min-height:60px}
.dshmw-composerrow{display:flex;align-items:center;gap:8px}
.dshmw-composerhint{flex:1;min-width:0;font-size:11px;color:var(--dsw-alias-label-secondary);overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.dshmw-composerrow .dshmw-submit{flex:none}
`
    const disposeCss = styles.insert(CSS)

    // ---- client service verbs ----
    function openSession(id) {
      const s = ctx.get('sessions')
      if (s && typeof s.open === 'function') s.open(id)
    }
    function forkSession(sessionId) {
      const s = ctx.get('sessions')
      if (!s || typeof s.fork !== 'function') return Promise.resolve()
      return s.fork({ sessionId, increaseTitle: true }).then((childId) => {
        if (s && typeof s.open === 'function') s.open(childId)
      }).catch(() => {})
    }
    function archiveSession(sessionId) {
      const w = ctx.get('workspaces')
      if (!w || typeof w.archiveSession !== 'function') return Promise.resolve()
      return w.archiveSession(sessionId).catch((reason) => console.warn('session archive rejected:', reason))
    }

    // ---- host RPC verbs ----
    function callHost(method, args) {
      return host.call(method, args || {}).then((res) => {
        if (!res || res.ok !== true) {
          throw new Error(res && res.error ? res.error : '操作失败')
        }
        return res
      })
    }
    const listBatches = () => callHost('mock.list-batches')
    const createBatch = (name) => callHost('mock.create-batch', { name })
    const archiveBatch = (path) => callHost('mock.archive-batch', { path })
    const deleteBatch = (path) => callHost('mock.delete-batch', { path })
    const getConfig = () => callHost('mock.get-config')
    const setConfig = (root) => callHost('mock.set-config', { root })

    // 后端公开 API 调用（与 callHost 相同的 wire 格式，channel 固定 /api）。
    // dsh 后端 SessionsApi 提供 session.create / session.history / session.prompt
    // 等接口，原子且不依赖 client 投影同步，是创建会话的可靠路径。
    let apiSeq = 0
    function apiCall(method, payload) {
      const rpcId = 'api' + (++apiSeq) + '-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
      return fetch('/api/' + method, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId, method, payload: payload || {} }),
      }).then((res) => {
        if (!res.ok) throw new Error('api transport: HTTP ' + res.status)
        return res.json()
      }).then((full) => {
        if (!full || full.rpcId !== rpcId) throw new Error('api rpc id mismatch')
        if (!full.result || full.result.ok !== true) {
          const err = full.result && full.result.error
          throw new Error(err && err.message ? err.message : 'API 调用失败')
        }
        return full.result.value
      })
    }

    // ---- mock 会话集合：conversation.composer 接管选择器的认领依据 ----
    // 只认本插件创建（或历史批次 cwd 关联）的会话；其他会话完全不受影响。
    // 回填时顺带注销「workspace 归属」时期为批次目录注册的 workspace
    // （删注册不删目录/日志，会话回落未分组，由本插件接管输入框认领）。
    const mockSessionIds = new Set()
    listBatches().then((res) => {
      const batches = (res && res.batches) || []
      for (const b of batches) {
        const ids = b.sessionIds || []
        for (const id of ids) mockSessionIds.add(id)
      }
      const w = ctx.get('workspaces')
      const list = w && w.list && typeof w.list.getSnapshot === 'function' ? w.list.getSnapshot() : null
      const items = (list && list.items) || []
      if (w && typeof w.delete === 'function') {
        for (const b of batches) {
          const ws = items.find((it) => it.path === b.path)
          if (ws) w.delete(ws.workspaceId).catch(() => {})
        }
      }
    }).catch(() => {})

    // 在批次目录开一个普通对话会话：后端 session.create({ cwd }) 原子创建 cwd
    // 指向批次目录的会话（无 workspace 归属 → 会话面板归入「未分组」，空白期
    // 隐藏、首发消息后出现在未分组桶）→ sessions.open 打开。
    function startBatchSession(batchPath) {
      return apiCall('session.create', { cwd: batchPath }).then((value) => {
        const sessionId = value && value.sessionId
        if (sessionId) {
          mockSessionIds.add(sessionId)
          openSession(sessionId)
        }
        return sessionId
      })
    }

    // ---- client service verbs ----
    function pickDirectory() {
      const w = ctx.get('workspaces')
      if (w && typeof w.pickDirectory === 'function') return w.pickDirectory()
      return Promise.resolve(null)
    }

    // ---- time label ----
    function relativeTimeLabel(updatedAt) {
      const diff = Math.max(0, Date.now() - (typeof updatedAt === 'number' ? updatedAt : 0))
      const MIN = 60000, HOUR = 3600000, DAY = 86400000
      if (diff < MIN) return '刚刚'
      if (diff < HOUR) return Math.floor(diff / MIN) + ' 分钟前'
      if (diff < DAY) return Math.floor(diff / HOUR) + ' 小时前'
      if (diff < 30 * DAY) return Math.floor(diff / DAY) + ' 天前'
      return new Date(updatedAt).toLocaleDateString()
    }

    // ---- conversation.composer chain 接管（兜底）：mock 空白会话的简易输入框 ----
    // 首选路径是 packaged host 半边的 bundle 内存补丁：打过补丁后官方
    // composer 对无 workspace 空白会话直接可用，本接管不再注册。仅当探测不到
    // 补丁 marker 时（动态版单独运行 / 锚点漂移）才启用本兜底：
    // 官方 hero 输入框对「无工作区归属的空白会话」退化成只读工作区选择器；
    // 此处接管 mock 空白会话的 composer，首条消息发出后官方 composer 自动
    // 回来。priority 10 排在官方 entry（-10/0/1）之后。
    function selectMockBlankComposer(owner) {
      const session = owner && owner.session
      if (session === undefined || session === null) return null
      if (session.blank !== true) return null
      if (!mockSessionIds.has(session.sessionId)) return null
      return { sessionId: session.sessionId }
    }

    function MockBlankComposer(props) {
      const matched = props.matched || {}
      const sessionId = matched.sessionId
      const [draft, setDraft] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState(null)

      const submit = () => {
        const text = draft.trim()
        if (text === '' || busy || !sessionId) return
        setBusy(true)
        setError(null)
        apiCall('session.prompt', {
          sessionId: sessionId,
          mode: 'queue',
          content: [{ type: 'text', text: text }],
          clientTimeZone: 'Asia/Shanghai',
        }).then(() => {
          setBusy(false)
          setDraft('')
        }, (err) => {
          setBusy(false)
          setError(err && err.message ? err.message : String(err))
        })
      }

      return React.createElement('div', { className: 'dshmw-composer' },
        React.createElement('textarea', {
          className: 'dshmw-composerinput',
          placeholder: '给这个实验会话发消息…',
          value: draft,
          rows: 3,
          onChange: (e) => { setDraft(e.target.value) },
          onKeyDown: (e) => {
            if (e.key === 'Enter' && !e.shiftKey && !(e.nativeEvent && e.nativeEvent.isComposing)) {
              e.preventDefault()
              submit()
            }
          },
        }),
        React.createElement('div', { className: 'dshmw-composerrow' },
          React.createElement('span', { className: 'dshmw-composerhint' }, 'Mock 接管输入框 · Enter 发送，Shift+Enter 换行'),
          error ? React.createElement('span', { className: 'dshmw-error', role: 'alert' }, error) : null,
          React.createElement('button', {
            type: 'button',
            className: 'dshmw-submit',
            disabled: busy || draft.trim() === '',
            onClick: submit,
          }, busy ? '发送中…' : '发送')))
    }

    // ---- activity entry ----
    function MockIcon(props) {
      const active = props.activePanelId === props.panelId
      return React.createElement('button', {
        type: 'button',
        className: active ? 'dshsb-icon dshsb-icon-active' : 'dshsb-icon',
        title: 'Mock 实验场',
        'aria-label': 'Mock 实验场',
        'aria-pressed': active,
        onClick: () => { props.selectPanel(props.panelId) },
      }, React.createElement(SvgIcon, { d: ICONS.beaker, size: props.wide ? 16 : 18 }))
    }


    // ---- 新建批次表单（只需一个名字） ----
    function NewBatchForm(props) {
      const [name, setName] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState(null)

      const submit = () => {
        if (busy) return
        setBusy(true)
        setError(null)
        createBatch(name).then((res) => {
          setBusy(false)
          setName('')
          props.onCreated(res)
          // 新建批次后直接在批次目录开会话：session.create({ cwd }) → 未分组。
          if (res.batchPath) {
            startBatchSession(res.batchPath).catch((err) => {
              console.warn('start batch session failed:', err && err.message ? err.message : err)
            })
          }
        }, (err) => {
          setBusy(false)
          setError(err.message || String(err))
        })
      }

      return React.createElement('div', { className: 'dshmw-form' },
        React.createElement('input', {
          className: 'dshmw-input',
          placeholder: '名字（如：电商页 skill-qa v2）',
          value: name,
          onChange: (e) => { setName(e.target.value) },
          onKeyDown: (e) => { if (e.key === 'Enter' && !busy) submit() },
        }),
        React.createElement('div', { className: 'dshmw-formrow' },
          React.createElement('button', {
            type: 'button',
            className: 'dshmw-submit',
            disabled: busy,
            onClick: submit,
          }, busy ? '创建中…' : '创建')),
        error ? React.createElement('div', { className: 'dshmw-error', role: 'alert' }, error) : null)
    }

    // ---- 根目录设置表单 ----
    function SettingsForm(props) {
      const [root, setRoot] = React.useState(props.rootPath || '')
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState(null)

      const save = (target) => {
        if (busy) return
        setBusy(true)
        setError(null)
        setConfig(target).then((res) => {
          setBusy(false)
          props.onSaved(res)
        }, (err) => {
          setBusy(false)
          setError(err.message || String(err))
        })
      }
      const browse = () => {
        pickDirectory().then((dir) => {
          if (typeof dir === 'string' && dir !== '') setRoot(dir)
        }).catch(() => {})
      }

      return React.createElement('div', { className: 'dshmw-settings' },
        React.createElement('div', { className: 'dshmw-settingslabel' }, 'Mock 根目录（批次保存在 <根>/runs/ 下）'),
        React.createElement('div', { className: 'dshmw-settingsrow' },
          React.createElement('input', {
            className: 'dshmw-input',
            placeholder: '/绝对/路径/到/mock-工作区',
            value: root,
            onChange: (e) => { setRoot(e.target.value) },
            onKeyDown: (e) => { if (e.key === 'Enter' && !busy) save(root) },
          }),
          React.createElement('button', { type: 'button', className: 'dshmw-browse', onClick: browse }, '浏览…'),
          React.createElement('button', {
            type: 'button',
            className: 'dshmw-submit',
            disabled: busy,
            onClick: () => { save(root) },
          }, busy ? '保存中…' : '保存')),
        error ? React.createElement('div', { className: 'dshmw-error', role: 'alert' }, error) : null)
    }

    // ---- 批次行（点标题折叠/展开会话列表；首行「新会话」入口） ----
    function BatchRow(props) {
      const batch = props.batch
      const sessionsById = props.sessionsById

      const meta = batch.meta || {}
      const title = batch.title || meta.name || batch.batchId || '批次'
      // 归档集合：归档后的会话从批次列表里消失（日志保留，可从归档恢复）。
      const w = ctx.get('workspaces')
      const wsList = w && w.list && typeof w.list.getSnapshot === 'function' ? w.list.getSnapshot() : null
      const archivedIds = new Set((wsList && wsList.archivedSessionIds) || [])
      const sessionIds = (batch.sessionIds || []).filter((id) => sessionsById[id] !== undefined && !archivedIds.has(id))
      const [open, setOpen] = React.useState(true)
      const [confirmDelete, setConfirmDelete] = React.useState(false)

      // 删除批次目录后顺带注销对应 workspace 注册（目录没了，注册留着是死引用）。
      const removeBatchWorkspace = () => {
        const items = (wsList && wsList.items) || []
        const ws = items.find((it) => it.path === batch.path)
        if (ws && w && typeof w.delete === 'function') return w.delete(ws.workspaceId).catch(() => {})
        return Promise.resolve()
      }

      const newSessionRow = React.createElement('button', {
        type: 'button',
        className: 'dshmw-sess',
        title: '在该批次目录新建一个对话会话',
        onClick: () => {
          startBatchSession(batch.path)
            .then(() => props.onChanged())
            .catch((err) => console.warn(err))
        },
      },
        React.createElement('span', { className: 'dshmw-sessplus' },
          React.createElement(SvgIcon, { d: ICONS.plus, size: 11 })),
        React.createElement('span', { className: 'dshmw-sessname' }, '新会话'))

      return React.createElement('div', null,
        React.createElement('div', { className: 'dshmw-batchrow' },
          React.createElement('button', {
            type: 'button',
            className: 'dshmw-batch',
            'aria-expanded': open,
            title: open ? '折叠会话列表' : '展开会话列表',
            onClick: () => { setOpen(!open) },
          },
            React.createElement(SvgIcon, { className: 'dshmw-batchicon', d: ICONS.folder, size: 14 }),
            React.createElement('span', { className: 'dshmw-batchmain' },
              React.createElement('span', { className: 'dshmw-batchtitle' }, title),
              React.createElement('span', { className: 'dshmw-batchmeta' },
                React.createElement('span', { className: 'dshmw-count' }, sessionIds.length + ' 会话')))),
          React.createElement('div', { className: 'dshmw-batchacts' },
            React.createElement('button', {
              type: 'button',
              className: 'dshmw-batchact',
              title: '归档该批次（从列表隐藏，目录保留）',
              onClick: (e) => {
                e.stopPropagation()
                archiveBatch(batch.path)
                  .then(() => props.onChanged())
                  .catch((err) => console.warn(err))
              },
            }, React.createElement(SvgIcon, { d: ICONS.archive, size: 12 })),
            React.createElement('button', {
              type: 'button',
              className: confirmDelete ? 'dshmw-batchact dshmw-batchact-danger' : 'dshmw-batchact',
              title: confirmDelete ? '再次点击确认删除（批次目录将被移除）' : '删除该批次',
              onClick: (e) => {
                e.stopPropagation()
                if (!confirmDelete) { setConfirmDelete(true); return }
                deleteBatch(batch.path)
                  .then(() => removeBatchWorkspace())
                  .then(() => props.onChanged())
                  .catch((err) => console.warn(err))
                  .finally(() => setConfirmDelete(false))
              },
            }, React.createElement(SvgIcon, { d: ICONS.trash, size: 12 })))),
        open ? React.createElement('div', { className: 'dshmw-batchbody' },
          newSessionRow,
          sessionIds.map((id) => {
            const sum = sessionsById[id]
            return React.createElement('div', { key: id, className: 'dshmw-sessrow' },
              React.createElement('button', {
                type: 'button',
                className: 'dshmw-sess',
                onClick: () => { openSession(id) },
                onContextMenu: (e) => {
                  e.preventDefault()
                  // 简单右键：分叉
                  forkSession(id)
                },
              },
                sum.running === true || sum.completed === true
                  ? React.createElement('span', { className: 'dshmw-sessdot' })
                  : React.createElement('span', { className: 'dshmw-sessdot', style: { background: 'transparent' } }),
                React.createElement('span', { className: 'dshmw-sessname' }, sum.blank ? '新会话' : (sum.displayTitle || sum.title || id)),
                React.createElement('span', { className: 'dshmw-sessmeta' }, relativeTimeLabel(sum.updatedAt))),
              React.createElement('button', {
                type: 'button',
                className: 'dshmw-sessact',
                title: '归档该会话（日志保留，可从归档恢复）',
                onClick: (e) => {
                  e.stopPropagation()
                  archiveSession(id)
                    .then(() => props.onChanged())
                    .catch((err) => console.warn(err))
                },
              }, React.createElement(SvgIcon, { d: ICONS.archive, size: 12 })))
          })) : null)
    }

    // ---- panel entry ----
    function MockPanel(props) {
      if (props.activePanelId !== props.panelId) return null

      const sessions = props.useSessions ? props.useSessions((s) => s) : undefined
      const [showForm, setShowForm] = React.useState(false)
      const [showSettings, setShowSettings] = React.useState(false)
      const [rootPath, setRootPath] = React.useState('')
      const [batches, setBatches] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [reloadKey, setReloadKey] = React.useState(0)

      const load = React.useCallback(() => {
        setError(null)
        getConfig().then((cfg) => {
          if (cfg && typeof cfg.rootPath === 'string') setRootPath(cfg.rootPath)
        }).catch(() => {})
        listBatches().then((res) => {
          setBatches(res.batches || [])
          if (res.rootPath && typeof res.rootPath === 'string') setRootPath(res.rootPath)
        }, (err) => {
          setBatches([])
          setError(err.message || String(err))
        })
      }, [])

      React.useEffect(() => { load() }, [load, reloadKey])

      const sessionsById = (sessions && sessions.byId) || {}
      const current = sessions && sessions.current

      const header = React.createElement('div', { className: 'dshmw-header' },
        React.createElement('span', { className: 'dshmw-title' }, 'Mock 实验场'),
        React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 2 } },
          React.createElement('button', {
            type: 'button',
            className: 'dshmw-headbtn',
            title: '设置根目录',
            'aria-label': '设置根目录',
            onClick: () => { setShowSettings(!showSettings) },
          }, React.createElement(SvgIcon, { d: ICONS.gear, size: 15 })),
          React.createElement('button', {
            type: 'button',
            className: 'dshmw-headbtn',
            title: '刷新',
            'aria-label': '刷新',
            onClick: () => { setReloadKey((k) => k + 1) },
          }, React.createElement(SvgIcon, { d: ICONS.refresh, size: 15 })),
          React.createElement('button', {
            type: 'button',
            className: 'dshmw-new',
            title: '新建',
            'aria-label': '新建',
            onClick: () => { setShowForm(!showForm) },
          },
            React.createElement(SvgIcon, { d: ICONS.plus, size: 13 }),
            '新建')))

      const body = []
      if (showSettings) {
        body.push(React.createElement(SettingsForm, {
          key: 'settings',
          rootPath,
          onSaved: (res) => {
            setShowSettings(false)
            if (res && typeof res.rootPath === 'string') setRootPath(res.rootPath)
            setReloadKey((k) => k + 1)
          },
        }))
      }
      if (showForm) {
        body.push(React.createElement(NewBatchForm, {
          key: 'form',
          onCreated: () => { setShowForm(false); setReloadKey((k) => k + 1) },
        }))
      }
      if (error) {
        body.push(React.createElement('div', { key: 'err', className: 'dshmw-status' },
          React.createElement('span', { className: 'dshmw-err', role: 'alert' }, error),
          React.createElement('button', { type: 'button', className: 'dshmw-retry', onClick: load }, '重试')))
      }
      if (batches === null && !error) {
        body.push(React.createElement('div', { key: 'loading', className: 'dshmw-status' }, '加载中…'))
      } else if (batches !== null && batches.length === 0 && !error) {
        body.push(React.createElement('div', { key: 'empty', className: 'dshmw-empty' },
          React.createElement('div', null, '还没有批次'),
          React.createElement('div', { className: 'dshmw-hint' },
            '点右上角「+ 新建」：输入一个名字，会创建独立的工作区目录并打开一个普通对话会话，轨迹与产物都会留在这个实验场里。')))
      } else if (batches !== null) {
        batches.forEach((batch) => {
          // 归档批次从列表隐藏（目录与 meta 保留在 runs/ 下）。
          if (batch.meta && batch.meta.status === 'archived') return
          body.push(React.createElement(BatchRow, {
            key: batch.batchId || batch.path,
            batch,
            sessionsById,
            current,
            onChanged: () => { setReloadKey((k) => k + 1) },
          }))
        })
      }

      return React.createElement('div', { className: 'dshmw-root' }, header,
        rootPath ? React.createElement('div', { className: 'dshmw-rootpath', title: rootPath }, '根: ' + rootPath) : null,
        React.createElement('div', { className: 'dshmw-list' }, body))
    }

    // ---- registrations: 等 shell 声明槽位后纯增量注册 ----
    ctx.effect(() => {
      const disposers = [disposeCss]
      disposers.push(slots.inject('sidebar.activity', () => slots.register(
        { name: 'sidebar.activity', id: PANEL_ID, order: ORDER, priority: -1, inject: () => ({ panelId: PANEL_ID }) },
        MockIcon,
      )))
      disposers.push(slots.inject('sidebar.panel', () => slots.register(
        { name: 'sidebar.panel', id: PANEL_ID, order: ORDER, priority: -1, inject: () => ({ panelId: PANEL_ID }) },
        MockPanel,
      )))
      // chain 接管：mock 空白会话的 composer（详见 selectMockBlankComposer 注释）。
      // 仅作兜底：scripts/patch-composer-inert.mjs 打过的官方 bundle 带
      // 'dsh-mock-workspace:composer-unlocked' marker，此时官方 composer 对无
      // workspace 空白会话已解锁，不再注册手写接管框；探测不到 marker（未打
      // 补丁，或 dsh 升级覆盖了补丁文件）则回退手写接管框，保证首发消息可用。
      const registerFallbackComposer = () => {
        disposers.push(slots.inject('conversation.composer', () => slots.register(
          { name: 'conversation.composer', select: selectMockBlankComposer, priority: 10 },
          MockBlankComposer,
        )))
      }
      fetch('/plugins/@deepseek-ai/dsh-client-ui-conversation/client.js')
        .then((res) => (res.ok ? res.text() : ''))
        .then((src) => {
          if (typeof src === 'string' && src.includes('dsh-mock-workspace:composer-unlocked')) return
          registerFallbackComposer()
        })
        .catch(() => { registerFallbackComposer() })
      return () => {
        for (const d of disposers) {
          try { if (typeof d === 'function') d() } catch (e) { /* noop */ }
        }
      }
    })
  },
}
