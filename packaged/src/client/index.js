// dsh-mock-workspace — client half (formal installable package).
//
// 在左侧边栏注册第三个 tab「Mock 实验场」（id: mock，order: 3），纯增量：
// 通过 slots.inject 等待 dsh-sidebar-live 的 shell 声明 `sidebar.activity` /
// `sidebar.panel` 后注册 activity entry + panel entry。
//
// 与动态版（runtime-plugin/client.js）的差异：
//   - 无 `host.call` / `styles` 闭包：Host RPC 走 `fetch('/mock/<endpoint>')`
//     （connection.rpc.handle 的 loopback channel，消息形状同
//     createWebConnectionRpc，见 dsh-sidebar-live）；CSS 用 insertCss 注入
//     <style data-plugin>。
//   - React 由 build.mjs 的闭包工厂 `require('react')` 绑定，本文件不引用
//     动态 Builtin。
//   - 注册优先级显式 -1（正式包无动态 guard 的自动 shadowing 排序）。
//
// 面板职责：新建批次（query + skill 版本 → 独立目录 + 普通对话会话）、
// 批次列表、会话（轨迹）入口。产物文件经由侧边栏「资源管理器」查看。

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
  } catch (e) {
    /* persistence is best-effort */
  }
}

function insertCss(cssText) {
  try {
    if (typeof document === 'undefined') return () => {}
    const style = document.createElement('style')
    style.setAttribute('data-plugin', 'dsh-mock-workspace')
    style.textContent = cssText
    document.head.appendChild(style)
    return () => { if (style.parentNode) style.parentNode.removeChild(style) }
  } catch (e) {
    return () => {}
  }
}

const errorText = (err) => (err && err.message ? String(err.message) : String(err))

// Cordis context captured by apply(); module-level helpers read it through
// this reference (mirrors dsh-sidebar-live's pluginCtx pattern).
let ctxRef = null

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
  globe: 'M8 2 A6 6 0 1 0 8 14 A6 6 0 1 0 8 2 Z M2 8 H14 M8 2 C9.8 3.8 10.5 5.8 10.5 8 C10.5 10.2 9.8 12.2 8 14 C6.2 12.2 5.5 10.2 5.5 8 C5.5 5.8 6.2 3.8 8 2 Z',
  list: 'M2.5 4 H13.5 M2.5 8 H13.5 M2.5 12 H13.5',
  pencil: 'M2 14 L2.9 10.6 L10.6 2.9 A1.4 1.4 0 0 1 12.6 4.9 L4.9 12.6 Z M9.6 3.9 L11.6 5.9',
  book: 'M4 2.5 H12.5 A1 1 0 0 1 13.5 3.5 V12.5 A1 1 0 0 1 12.5 13.5 H4 A1.5 1.5 0 0 1 2.5 12 V4 A1.5 1.5 0 0 1 4 2.5 Z M2.5 11 A1.5 1.5 0 0 1 4 9.5 H13.5',
  upload: 'M8 10.5 V2.5 M5 5.5 L8 2.5 L11 5.5 M3 12.5 H13',
  chevron: 'M3 6 L8 11 L13 6',
  chevL: 'M10 3 L5 8 L10 13',
  chevR: 'M6 3 L11 8 L6 13',
}

// 产物托管 Hub（artifact-hub/server.mjs）管理页地址；改端口需与
// Hub 的 ARTIFACT_HUB_PORT 环境变量一致。Hub 的 /api/* 带 CORS * 头，
// 面板可直接 fetch 探测在线状态。
const HUB_URL = 'http://127.0.0.1:4780/'

const CSS = `
.dshmw-root{flex:1;min-height:0;display:flex;flex-direction:column;gap:8px;box-sizing:border-box;padding:4px 8px 8px;overflow-y:auto;overflow-x:hidden}
.dshmw-header{flex:none;display:flex;align-items:center;justify-content:space-between;gap:4px;height:28px;padding:0 2px 0 6px;box-sizing:border-box;color:var(--dsw-alias-label-secondary)}
.dshmw-title{overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font-size:13px;font-weight:600}
.dshmw-headbtn{flex:none;display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border:none;border-radius:6px;padding:0;background:transparent;cursor:pointer;color:var(--dsw-alias-label-secondary)}
.dshmw-headbtn:hover{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}
.dshmw-card{flex:none;border:1px solid var(--dsw-alias-border-l1);border-radius:10px}
.dshmw-cardhead{display:flex;align-items:center;gap:6px;padding:6px 8px 6px 6px;border-bottom:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary)}
.dshmw-collapse{flex:none;display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;border:none;border-radius:5px;padding:0;background:transparent;cursor:pointer;color:var(--dsw-alias-label-secondary)}
.dshmw-collapse:hover{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}
.dshmw-chev{transition:transform .15s ease}
.dshmw-card-closed .dshmw-chev{transform:rotate(-90deg)}
.dshmw-card-closed .dshmw-cardhead{border-bottom:none}
.dshmw-cardicon{flex:none;display:inline-flex;cursor:pointer}
.dshmw-cardtitle{flex:1;min-width:0;font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary);overflow:hidden;white-space:nowrap;text-overflow:ellipsis;cursor:pointer}
.dshmw-cardbtn{flex:none;display:inline-flex;align-items:center;gap:4px;height:22px;padding:0 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:transparent;cursor:pointer;color:var(--dsw-alias-label-secondary);font-size:11px;font-family:inherit}
.dshmw-cardbtn:hover{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}
.dshmw-cardbody{padding:4px}
.dshmw-form{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;margin:2px 4px 4px;padding:8px;display:flex;flex-direction:column;gap:6px;box-sizing:border-box}
.dshmw-input{width:100%;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:12px;padding:5px 8px;font-family:inherit}
.dshmw-input:focus{outline:none;border-color:var(--dsw-alias-border-l2)}
.dshmw-formrow{display:flex;gap:6px}
.dshmw-formrow .dshmw-input{flex:1}
.dshmw-submit{flex:none;border:none;border-radius:6px;padding:5px 10px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);cursor:pointer;font-size:12px}
.dshmw-submit:hover{background:var(--dsw-alias-bg-layer-2)}
.dshmw-submit:disabled{opacity:.5;cursor:default}
.dshmw-error{flex:none;font-size:11px;color:var(--dsw-alias-state-error-primary);overflow-wrap:break-word}
.dshmw-batchrow{position:relative;display:flex;align-items:center}
.dshmw-batchrow .dshmw-batch{flex:1;min-width:0}
.dshmw-batchacts{position:absolute;right:4px;display:none;align-items:center;gap:2px}
.dshmw-batchrow:hover .dshmw-batchacts{display:inline-flex}
.dshmw-batchact{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border:none;border-radius:5px;padding:0;background:var(--dsw-alias-bg-layer-1);cursor:pointer;color:var(--dsw-alias-label-secondary)}
.dshmw-batchact:hover{color:var(--dsw-alias-label-primary)}
.dshmw-batchact-danger{color:var(--dsw-alias-state-error-primary)}
.dshmw-batch{width:100%;display:flex;align-items:center;gap:6px;min-height:30px;padding:0 6px;box-sizing:border-box;border:none;background:transparent;cursor:pointer;color:var(--dsw-alias-label-secondary);font-size:13px;text-align:left;border-radius:7px}
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
.dshmw-sessact{position:absolute;right:4px;display:none;align-items:center;justify-content:center;width:20px;height:20px;border:none;border-radius:5px;padding:0;background:var(--dsw-alias-bg-layer-1);cursor:pointer;color:var(--dsw-alias-label-secondary)}
.dshmw-sessact:hover{color:var(--dsw-alias-label-primary)}
.dshmw-sessrow:hover .dshmw-sessact{display:inline-flex}
.dshmw-sessrow:hover .dshmw-sessmeta{visibility:hidden}
.dshmw-sess{display:flex;align-items:center;gap:6px;width:100%;height:28px;border:none;border-radius:6px;padding:0 6px;box-sizing:border-box;background:transparent;cursor:pointer;color:var(--dsw-alias-label-secondary);font-size:12px;text-align:left}
.dshmw-sess:hover{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}
.dshmw-sessdot{flex:none;width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-state-success-primary)}
.dshmw-sessname{flex:1;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.dshmw-sessmeta{flex:none;font-size:11px;opacity:.7;max-width:40%;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.dshmw-status{display:flex;align-items:center;gap:8px;min-height:26px;padding:4px 8px;box-sizing:border-box;color:var(--dsw-alias-label-secondary);font-size:12px}
.dshmw-err{flex:1;min-width:0;color:var(--dsw-alias-state-error-primary);overflow-wrap:break-word}
.dshmw-retry{flex:none;border:none;border-radius:6px;padding:2px 8px;background:transparent;cursor:pointer;color:var(--dsw-alias-label-secondary);font-size:12px}
.dshmw-retry:hover{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}
.dshmw-empty{padding:12px 10px;color:var(--dsw-alias-label-secondary);font-size:13px}
.dshmw-hint{margin-top:4px;font-size:12px;opacity:.75}
.dshmw-rootpath{flex:none;padding:0 6px;font-size:11px;opacity:.55;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;color:var(--dsw-alias-label-secondary)}
.dshmw-hubrow{display:flex;align-items:center;gap:7px;padding:5px 6px;font-size:12px;color:var(--dsw-alias-label-secondary)}
.dshmw-huburl{flex:1;min-width:0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.dshmw-hubdot{flex:none;width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-label-tertiary,#8a919d)}
.dshmw-hubdot.online{background:var(--dsw-alias-state-success-primary);box-shadow:0 0 4px rgba(63,185,105,.7)}
.dshmw-artgrouplabel{padding:3px 6px 1px;font-size:11px;color:var(--dsw-alias-label-secondary);opacity:.7;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.dshmw-art{display:flex;align-items:center;gap:7px;width:100%;min-height:26px;padding:0 6px;box-sizing:border-box;border:none;border-radius:6px;background:transparent;cursor:pointer;color:var(--dsw-alias-label-secondary);font-size:12px;text-align:left}
.dshmw-art:hover{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}
.dshmw-artname{flex:1;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.dshmw-kind{flex:none;border-radius:4px;padding:0 5px;font-size:10px;line-height:15px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.dshmw-dot{flex:none;width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-label-tertiary,#9aa0a6)}
.dshmw-dot.running{background:var(--dsw-alias-state-success-primary)}
.dshmw-dot.starting,.dshmw-dot.installing{background:#d9a13b;animation:dshmw-pulse 1.1s infinite}
.dshmw-dot.failed{background:var(--dsw-alias-state-error-primary)}
@keyframes dshmw-pulse{50%{opacity:.35}}
.dshmw-select{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:11px;padding:2px 4px;font-family:inherit;max-width:100%}
.dshmw-textarea{width:100%;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:11px;padding:5px 8px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;resize:vertical;min-height:56px}
.dshmw-textarea:focus{outline:none;border-color:var(--dsw-alias-border-l2)}
.dshmw-fieldlabel{font-size:10px;color:var(--dsw-alias-label-secondary);opacity:.8}
.dshmw-librow{display:flex;flex-direction:column;gap:4px;margin:2px 2px 6px;padding:6px 8px;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1)}
.dshmw-libhead{display:flex;align-items:center;gap:6px;min-width:0}
.dshmw-libref{flex:1;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10px;color:var(--dsw-alias-label-secondary);opacity:.85}
.dshmw-liblang{flex:none;border-radius:4px;padding:0 5px;font-size:10px;line-height:15px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary)}
.dshmw-libprompt{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);cursor:pointer;border-radius:4px}
.dshmw-libprompt:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1)}
.dshmw-libprompt.open{display:block;overflow:visible;white-space:pre-wrap;overflow-wrap:break-word;color:var(--dsw-alias-label-primary)}
.dshmw-tags{display:flex;flex-wrap:wrap;gap:4px}
.dshmw-tag{flex:none;border-radius:4px;padding:0 6px;font-size:10px;line-height:16px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);overflow:hidden;white-space:nowrap;text-overflow:ellipsis;max-width:120px}
.dshmw-libpager{display:flex;align-items:center;gap:4px;padding:2px 4px 4px;box-sizing:border-box}
.dshmw-pgbtn{flex:none;display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:transparent;cursor:pointer;color:var(--dsw-alias-label-secondary)}
.dshmw-pgbtn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}
.dshmw-pgbtn:disabled{opacity:.35;cursor:default}
.dshmw-pginfo{flex:1;min-width:0;text-align:center;font-size:11px;color:var(--dsw-alias-label-secondary);overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.dshmw-libscroll{max-height:min(42vh,380px);overflow-y:auto;overflow-x:hidden;display:flex;flex-direction:column;padding:2px;box-sizing:border-box}
.dshmw-libscroll .dshmw-librow{flex:none}
.dshmw-libscroll::-webkit-scrollbar{width:6px}
.dshmw-libscroll::-webkit-scrollbar-thumb{background:var(--dsw-alias-border-l2,#d0d5dc);border-radius:3px}
.dshmw-libscroll::-webkit-scrollbar-track{background:transparent}
.dshmw-setrow{border-bottom:1px solid var(--dsw-alias-border-l2);padding:16px 0;display:flex;flex-direction:column;gap:8px}
.dshmw-setrow-head{display:flex;align-items:center;gap:8px}
.dshmw-setrow-text{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px;padding-right:12px}
.dshmw-setrow-title{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:400;line-height:22px}
.dshmw-setrow-desc{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.dshmw-setrow-controls{display:flex;align-items:center;gap:6px}
.dshmw-setinput{flex:1;min-width:0;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:13px;padding:7px 10px;font-family:inherit}
.dshmw-setinput:focus{outline:none;border-color:var(--dsw-alias-border-l2)}
.dshmw-setbtn{flex:none;border:none;border-radius:8px;padding:7px 12px;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary);cursor:pointer;font-size:13px;font-family:inherit}
.dshmw-setbtn:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dshmw-setbtn:disabled{opacity:.5;cursor:default}
.dshmw-seterror{font-size:12px;color:var(--dsw-alias-state-error-primary);overflow-wrap:break-word}
.dshmw-composer{box-sizing:border-box;width:100%;max-width:var(--dsh-composer-card-max-width,720px);margin:0 auto;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);border-radius:16px;padding:10px 12px;display:flex;flex-direction:column;gap:8px;box-shadow:var(--dsw-shadow-lv2)}
.dshmw-composerinput{width:100%;box-sizing:border-box;border:none;background:transparent;color:var(--dsw-alias-label-primary);font-size:14px;line-height:20px;font-family:inherit;resize:none;outline:none;min-height:60px}
.dshmw-composerrow{display:flex;align-items:center;gap:8px}
.dshmw-composerhint{flex:1;min-width:0;font-size:11px;color:var(--dsw-alias-label-secondary);overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.dshmw-composerrow .dshmw-submit{flex:none}
`

// ---- host RPC（/mock loopback channel，消息形状同 createWebConnectionRpc） ----
let rpcSeq = 0
function rpcCall(endpoint, payload) {
  const rpcId = 'mock' + (++rpcSeq) + '-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
  return fetch('/mock/' + endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload: payload || {} }),
  }).then((res) => {
    if (!res.ok) throw new Error('mock rpc transport: HTTP ' + res.status)
    return res.json()
  }).then((full) => {
    if (!full || full.rpcId !== rpcId) throw new Error('mock rpc id mismatch')
    if (!full.result || full.result.ok !== true) {
      throw new Error(full.result && full.result.error ? full.result.error : '操作失败')
    }
    return full.result
  })
}
const listBatches = () => rpcCall('list-batches')
const createBatch = (name) => rpcCall('create-batch', { name })
const archiveBatch = (path) => rpcCall('archive-batch', { path })
const deleteBatch = (path) => rpcCall('delete-batch', { path })
const getConfig = () => rpcCall('get-config')
const setConfig = (root) => rpcCall('set-config', { root })

// 后端公开 API 调用（与 rpcCall 相同的 wire 格式，channel 固定 /api）。
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

// ---- artifact-hub 直连 API（Hub 带 CORS * 头，面板直接读写用例） ----
function hubApi(pathname, opts) {
  return fetch(HUB_URL + 'api/' + pathname, opts).then((res) => {
    if (!res.ok) throw new Error('hub transport: HTTP ' + res.status)
    return res.json()
  }).then((msg) => {
    if (!msg || msg.ok !== true) throw new Error(msg && msg.error ? msg.error : 'Hub 请求失败')
    return msg.value
  })
}
// ---- 用例库（benchmark prompts）直连 API；语义层：CaseSet / Case / Importer ----
// Case 规范形态（导入时归一化）：{ id, setId, sourceRef, prompt, language,
// tags[], meta{} }。prompt 唯一必填；meta 是不透明袋子（原始行其余列原样保留）。
const listLibSets = () => hubApi('library/sets')
const previewLib = (payload) => hubApi('library/preview', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify(payload),
})
const importLib = (payload) => hubApi('library/import', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify(payload),
})
// 用例库每页条数（一页最多 20 条，支持翻页）
const LIB_PAGE_SIZE = 20
const listLibCases = (setId, opts) => {
  const o = opts || {}
  const qs = 'setId=' + encodeURIComponent(setId)
    + '&offset=' + (o.offset || 0) + '&limit=' + (o.limit || 50)
    + (o.tag ? '&tag=' + encodeURIComponent(o.tag) : '')
  return hubApi('library/cases?' + qs)
}
const deleteLibSet = (setId) => hubApi('library/delete-set', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ setId }),
})

// ---- mock 会话集合：conversation.composer 接管选择器的认领依据 ----
// 只认本插件创建（或历史批次 cwd 关联）的会话；其他会话（包括其他
// 未分组会话）完全不受影响。apply 时用 list-batches 回填历史，之后
// startBatchSession 逐个加入。
const mockSessionIds = new Set()

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
  const w = ctxRef.get('workspaces')
  if (w && typeof w.pickDirectory === 'function') return w.pickDirectory()
  return Promise.resolve(null)
}
function openSession(id) {
  const s = ctxRef.get('sessions')
  if (s && typeof s.open === 'function') s.open(id)
}
function forkSession(sessionId) {
  const s = ctxRef.get('sessions')
  if (!s || typeof s.fork !== 'function') return Promise.resolve()
  return s.fork({ sessionId, increaseTitle: true }).then((childId) => {
    if (s && typeof s.open === 'function') s.open(childId)
  }).catch(() => {})
}
function archiveSessionById(sessionId) {
  const w = ctxRef.get('workspaces')
  if (!w || typeof w.archiveSession !== 'function') return Promise.resolve()
  return w.archiveSession(sessionId)
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
// 首选路径是 host 半边的 bundle 内存补丁（src/index.js 的 exact 路由）：打过
// 补丁后官方 composer 对无 workspace 空白会话直接可用，本接管不再注册。仅当
// 探测不到补丁 marker 时（锚点漂移 / 路由未生效）才启用本兜底：
// 官方 hero 输入框对「无工作区归属的空白会话」会退化成只读的工作区选择器
// （选择即 attach，会话立刻脱离未分组，与 mock 的设计冲突）。这里通过官方
// chain 槽接管：selector 命中（ConversationSnapshot.blank + 本插件认领）时
// 渲染自己的简易输入框；首条消息发出后 turn/start 使 blank=false，selector
// 停止匹配，官方 composer 自动回来。priority 10 排在官方 entry（-10/0/1，
// 如 approval 等待）之后，交互类接管始终优先。
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
      setError(errorText(err))
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

// ---- 根目录变更通知（设置对话框保存后，侧边栏面板同步刷新） ----
// 模块级监听集合：MockRootSettingsRow 保存成功后调用 notifyRootChanged()，
// MockPanel 在 mount 时注册一个 load 重跑，两边不共享 state。
const rootListeners = new Set()
function onRootChanged(fn) { rootListeners.add(fn); return () => { rootListeners.delete(fn) } }
function notifyRootChanged(rootPath) {
  for (const fn of rootListeners) { try { fn(rootPath) } catch (e) { /* noop */ } }
}

// ---- 根目录设置行（注册进系统设置对话框「通用」页，settings.general.item） ----
function MockRootSettingsRow() {
  const [root, setRoot] = React.useState('')
  const [current, setCurrent] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState(null)

  React.useEffect(() => {
    let alive = true
    getConfig().then((cfg) => {
      if (!alive) return
      const rp = cfg && typeof cfg.rootPath === 'string' ? cfg.rootPath : ''
      setCurrent(rp)
      setRoot(rp)
    }).catch(() => {})
    return () => { alive = false }
  }, [])

  const save = (target) => {
    if (busy) return
    setBusy(true)
    setError(null)
    setConfig(target).then((res) => {
      setBusy(false)
      const rp = res && typeof res.rootPath === 'string' ? res.rootPath : target
      setCurrent(rp)
      notifyRootChanged(rp)
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

  return React.createElement('div', { className: 'dshmw-setrow' },
    React.createElement('div', { className: 'dshmw-setrow-head' },
      React.createElement('div', { className: 'dshmw-setrow-text' },
        React.createElement('div', { className: 'dshmw-setrow-title' }, 'Mock 根目录'),
        React.createElement('div', { className: 'dshmw-setrow-desc', title: current },
          current ? ('批次保存在 ' + current + '/runs/ 下') : '尚未配置（默认使用当前会话工作区）'))),
    React.createElement('div', { className: 'dshmw-setrow-controls' },
      React.createElement('input', {
        className: 'dshmw-setinput',
        placeholder: '/绝对/路径/到/mock-工作区',
        value: root,
        onChange: (e) => { setRoot(e.target.value) },
        onKeyDown: (e) => { if (e.key === 'Enter' && !busy) save(root) },
      }),
      React.createElement('button', { type: 'button', className: 'dshmw-setbtn', onClick: browse }, '浏览…'),
      React.createElement('button', {
        type: 'button',
        className: 'dshmw-setbtn',
        disabled: busy,
        onClick: () => { save(root) },
      }, busy ? '保存中…' : '保存')),
    error ? React.createElement('div', { className: 'dshmw-seterror', role: 'alert' }, error) : null)
}

// ---- 用例库：用例行（sourceRef + prompt 预览 + 标签；点击展开全文） ----
function LibCaseRow(props) {
  const c = props.c
  const [open, setOpen] = React.useState(false)
  return React.createElement('div', { className: 'dshmw-librow' },
    React.createElement('div', { className: 'dshmw-libhead' },
      React.createElement('span', { className: 'dshmw-libref', title: c.sourceRef }, c.sourceRef),
      c.language ? React.createElement('span', { className: 'dshmw-liblang' }, c.language) : null),
    React.createElement('div', {
      className: 'dshmw-libprompt' + (open ? ' open' : ''),
      title: open ? '' : '点击展开完整 prompt',
      onClick: () => setOpen(!open),
    }, c.prompt),
    (c.tags && c.tags.length > 0)
      ? React.createElement('div', { className: 'dshmw-tags' },
          c.tags.slice(0, 4).map((t) => React.createElement('span', { key: t, className: 'dshmw-tag' }, t)))
      : null)
}

// ---- 用例库：导入表单（两步：解析 → 字段映射 + 样例预览 → 确认导入） ----
// 通用结构化导入器：CSV/JSONL/JSON 通吃；具名 benchmark 预设 = 预填映射。
function LibraryImportForm(props) {
  const [name, setName] = React.useState('')
  const [pathVal, setPathVal] = React.useState('')
  const [fileObj, setFileObj] = React.useState(null) // { name, content }
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState(null)
  // 解析结果：{ kind, fileName, columns, totalRows, sampleRows }
  const [parsed, setParsed] = React.useState(null)
  // 字段映射
  const [promptCol, setPromptCol] = React.useState('')
  const [refCol, setRefCol] = React.useState('')
  const [langCol, setLangCol] = React.useState('')
  const [tagCols, setTagCols] = React.useState([])

  const doParse = () => {
    if (busy) return
    setBusy(true)
    setError(null)
    const payload = fileObj !== null
      ? { content: fileObj.content, fileName: fileObj.name }
      : { path: pathVal.trim() }
    previewLib(payload).then((v) => {
      setParsed(v)
      const g = v.guessed || {}
      setPromptCol(g.promptColumn || '')
      setRefCol(g.refColumn || '')
      setLangCol(g.languageColumn || '')
      setTagCols(Array.isArray(g.tagColumns) ? g.tagColumns : [])
      if (name === '') setName(String(v.fileName || '').replace(/\.[^.]+$/, ''))
    }).catch((err) => setError(errorText(err)))
      .finally(() => setBusy(false))
  }

  const doImport = () => {
    if (busy) return
    if (promptCol === '') { setError('请选择 prompt 列'); return }
    setBusy(true)
    setError(null)
    const base = fileObj !== null
      ? { content: fileObj.content, fileName: fileObj.name }
      : { path: pathVal.trim() }
    importLib(Object.assign(base, {
      name: name.trim(),
      mapping: { promptColumn: promptCol, refColumn: refCol, languageColumn: langCol, tagColumns: tagCols },
    })).then((v) => {
      props.onImported(v)
    }).catch((err) => { setBusy(false); setError(errorText(err)) })
  }

  const colSelect = (value, setter, placeholder) =>
    React.createElement('select', {
      className: 'dshmw-select', style: { flex: 1 }, value,
      onChange: (e) => setter(e.target.value),
    }, [React.createElement('option', { key: '', value: '' }, placeholder)].concat(
      (parsed ? parsed.columns : []).map((c) => React.createElement('option', { key: c, value: c }, c))))

  return React.createElement('div', { className: 'dshmw-form' },
    React.createElement('input', {
      className: 'dshmw-input',
      placeholder: '数据集绝对路径（推荐，大文件），如 /…/queries.csv',
      value: pathVal,
      disabled: fileObj !== null,
      onChange: (e) => setPathVal(e.target.value),
    }),
    React.createElement('div', { className: 'dshmw-formrow' },
      React.createElement('input', {
        key: fileObj ? fileObj.name : 'nofile',
        type: 'file', accept: '.csv,.jsonl,.ndjson,.json,text/csv,application/json',
        style: { flex: 1, fontSize: 11, color: 'var(--dsw-alias-label-secondary)' },
        onChange: (e) => {
          const f = e.target.files && e.target.files[0]
          if (!f) { setFileObj(null); return }
          if (f.size > 64 * 1024 * 1024) { setError('文件超过 64MB，请改用绝对路径导入'); return }
          const reader = new FileReader()
          reader.onload = () => { setFileObj({ name: f.name, content: String(reader.result || '') }); setError(null) }
          reader.onerror = () => setError('读取文件失败')
          reader.readAsText(f)
        },
      })),
    fileObj ? React.createElement('div', { className: 'dshmw-hint', style: { marginTop: 0 } },
      '已选文件：' + fileObj.name + '（' + Math.round(fileObj.content.length / 1024) + ' KB）') : null,
    parsed === null
      ? React.createElement('div', { className: 'dshmw-formrow' },
          React.createElement('button', {
            type: 'button', className: 'dshmw-submit',
            disabled: busy || (fileObj === null && pathVal.trim() === ''),
            onClick: doParse,
          }, busy ? '解析中…' : '解析'),
          React.createElement('button', {
            type: 'button', className: 'dshmw-retry', onClick: props.onCancel,
          }, '取消'))
      : [
          React.createElement('div', { key: 'info', className: 'dshmw-hint', style: { marginTop: 0 } },
            parsed.fileName + ' · ' + parsed.kind.toUpperCase() + ' · ' + parsed.totalRows + ' 行 · ' + parsed.columns.length + ' 列'),
          React.createElement('input', {
            key: 'name', className: 'dshmw-input',
            placeholder: '用例集名称',
            value: name, onChange: (e) => setName(e.target.value),
          }),
          React.createElement('div', { key: 'map1', className: 'dshmw-formrow' },
            React.createElement('span', { className: 'dshmw-fieldlabel', style: { width: 52, flex: 'none', paddingTop: 5 } }, 'prompt'),
            colSelect(promptCol, setPromptCol, '（必选）prompt 列')),
          React.createElement('div', { key: 'map2', className: 'dshmw-formrow' },
            React.createElement('span', { className: 'dshmw-fieldlabel', style: { width: 52, flex: 'none', paddingTop: 5 } }, 'id 列'),
            colSelect(refCol, setRefCol, '（可空）sourceRef 列'),
            React.createElement('span', { className: 'dshmw-fieldlabel', style: { flex: 'none', paddingTop: 5 } }, '语言'),
            colSelect(langCol, setLangCol, '（可空）')),
          React.createElement('div', { key: 'taglabel', className: 'dshmw-fieldlabel' },
            '标签列（选中值进入 tags，用于筛选；其余列自动进 meta）'),
          React.createElement('div', { key: 'tags', className: 'dshmw-checkgrid' },
            parsed.columns.map((c) => React.createElement('label', { key: c, className: 'dshmw-check' },
              React.createElement('input', {
                type: 'checkbox',
                checked: tagCols.includes(c),
                onChange: (e) => {
                  setTagCols(e.target.checked ? tagCols.concat([c]) : tagCols.filter((t) => t !== c))
                },
              }),
              c))),
          parsed.sampleRows && parsed.sampleRows.length > 0 && promptCol !== ''
            ? React.createElement('div', { key: 'sample', className: 'dshmw-sample' },
                '样例 prompt：' + String(parsed.sampleRows[0][promptCol] || ''))
            : null,
          React.createElement('div', { key: 'acts', className: 'dshmw-formrow' },
            React.createElement('button', {
              type: 'button', className: 'dshmw-submit', disabled: busy || promptCol === '',
              onClick: doImport,
            }, busy ? '导入中…' : '确认导入'),
            React.createElement('button', {
              type: 'button', className: 'dshmw-retry', disabled: busy,
              onClick: () => setParsed(null),
            }, '重选文件'),
            React.createElement('button', {
              type: 'button', className: 'dshmw-retry', onClick: props.onCancel,
            }, '取消')),
        ],
    error ? React.createElement('div', { className: 'dshmw-error', role: 'alert' }, error) : null)
}

// ---- 批次行（固定展开：会话列表 + 末尾「新会话」入口） ----
function BatchRow(props) {
  const batch = props.batch
  const sessionsById = props.sessionsById

  const meta = batch.meta || {}
  const title = batch.title || meta.name || batch.batchId || '批次'
  // 归档集合：归档后的会话从批次列表里消失（日志保留，可从归档恢复）。
  const w = ctxRef.get('workspaces')
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
              archiveSessionById(id)
                .then(() => props.onChanged())
                .catch((err) => console.warn(err))
            },
          }, React.createElement(SvgIcon, { d: ICONS.archive, size: 12 })))
      })) : null)
}

// ---- panel entry ----
// ---- 可折叠卡片（实验批次 / 用例库 / 产物托管通用）：箭头 / 图标 / 标题点击折叠 ----
function MockCard(props) {
  const [open, setOpen] = React.useState(true)
  const toggle = () => setOpen((v) => !v)
  const headTip = open ? '折叠卡片' : '展开卡片'
  return React.createElement('section', { className: 'dshmw-card' + (open ? '' : ' dshmw-card-closed') },
    React.createElement('div', { className: 'dshmw-cardhead' },
      React.createElement('button', {
        type: 'button',
        className: 'dshmw-collapse',
        title: headTip,
        'aria-expanded': open,
        onClick: toggle,
      }, React.createElement(SvgIcon, { d: ICONS.chevron, size: 10, className: 'dshmw-chev' })),
      React.createElement('span', { className: 'dshmw-cardicon', title: headTip, onClick: toggle },
        React.createElement(SvgIcon, { d: props.icon, size: 13 })),
      React.createElement('span', { className: 'dshmw-cardtitle', title: headTip, onClick: toggle }, props.title),
      props.actions || null),
    open ? React.createElement('div', { className: 'dshmw-cardbody' }, props.children) : null)
}

function MockPanel(props) {
  if (props.activePanelId !== props.panelId) return null

  const sessions = props.useSessions ? props.useSessions((s) => s) : undefined
  const [showForm, setShowForm] = React.useState(false)
  const [rootPath, setRootPath] = React.useState('')
  const [batches, setBatches] = React.useState(null)
  const [error, setError] = React.useState(null)
  const [reloadKey, setReloadKey] = React.useState(0)
  // 产物托管 Hub 状态：null（未知）| { online:false } | { online:true, batches:[…] }
  const [hub, setHub] = React.useState(null)

  // 探测产物托管 Hub（15s 轮询；Hub API 带 CORS * 头，顺带取产物清单做总览）。
  const hubMounted = React.useRef(true)
  React.useEffect(() => {
    hubMounted.current = true
    return () => { hubMounted.current = false }
  }, [])
  const pingHub = React.useCallback(() => {
    fetch(HUB_URL + 'api/state', { cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error('HTTP ' + res.status))))
      .then((msg) => {
        if (!hubMounted.current) return
        const value = msg && msg.ok === true && msg.value ? msg.value : {}
        setHub({ online: true, batches: Array.isArray(value.batches) ? value.batches : [] })
      })
      .catch(() => { if (hubMounted.current) setHub({ online: false, batches: [] }) })
  }, [])
  React.useEffect(() => {
    pingHub()
    const timer = setInterval(pingHub, 15000)
    return () => clearInterval(timer)
  }, [pingHub])

  // 手动启动 Hub：走 Host start-hub（detached spawn，进程独立于 dsh 常驻）。
  // starting 期间按钮置灰；Host 已等待就绪，这里回来后再补两次探测覆盖慢启动。
  const [hubStarting, setHubStarting] = React.useState(false)
  const [hubStartError, setHubStartError] = React.useState(null)
  const startHub = React.useCallback(() => {
    if (hubStarting) return
    setHubStarting(true)
    setHubStartError(null)
    // 面板与 apiproxy 同源，把 location.origin 传给 Host 作为 Hub 的 DSH_API。
    rpcCall('start-hub', { dshApi: location.origin })
      .then(() => { pingHub(); setTimeout(pingHub, 2000) })
      .catch((err) => setHubStartError(err && err.message ? String(err.message) : String(err)))
      .finally(() => setHubStarting(false))
  }, [hubStarting, pingHub])

  const openHub = React.useCallback((selectId) => {
    const url = selectId ? HUB_URL + '?select=' + encodeURIComponent(selectId) : HUB_URL
    // 打开顺序：① 内置浏览器（dsh-builtin-browser 发布在 window.__dshBrowser
    // 的页面控制器；已有 Hub 页签则激活并刷新到目标深链，否则新建页签）
    // ② Host `open`（系统默认浏览器） ③ window.open。
    const fallback = () => {
      rpcCall('open-hub', selectId ? { select: selectId } : {}).catch(() => {
        try { window.open(url, '_blank', 'noopener') } catch (err) { console.warn(err) }
      })
    }
    const ctrl = typeof window !== 'undefined' ? window.__dshBrowser : undefined
    if (!ctrl || typeof ctrl.command !== 'function') { fallback(); return }
    const navigate = () => ctrl.command({ op: 'navigate', url })
    ctrl.command({ op: 'tab-list' }).then((res) => {
      const tabs = res && Array.isArray(res.tabs) ? res.tabs : []
      const existing = tabs.find((t) => typeof t.url === 'string' && t.url.startsWith(HUB_URL))
      if (existing) {
        return ctrl.command({ op: 'tab-activate', id: existing.id }).then(navigate)
      }
      return ctrl.command({ op: 'tab-new' }).then(navigate)
    }).then((res) => {
      if (res && res.ok === false) throw new Error(res.error || 'navigate failed')
    }).catch(fallback)
  }, [])

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

  // ---- 用例库状态（benchmark prompts，全局库，存 mock 根 case-library/） ----
  const [libSets, setLibSets] = React.useState(null) // null 加载中 | []
  const [libSetId, setLibSetId] = React.useState('')
  const [libTag, setLibTag] = React.useState('')
  const [libData, setLibData] = React.useState(null) // null 加载中 | { total, cases }
  const [libImporting, setLibImporting] = React.useState(false)
  const [libReloadKey, setLibReloadKey] = React.useState(0)
  const [libConfirmDelete, setLibConfirmDelete] = React.useState(false)
  const [libPage, setLibPage] = React.useState(1) // 用例列表当前页（从 1 起）

  const hubOnlineForLib = hub !== null && hub.online === true
  // 用例集列表：Hub 在线时加载。
  React.useEffect(() => {
    if (!hubOnlineForLib) { setLibSets(null); return }
    let disposed = false
    listLibSets()
      .then((v) => { if (!disposed) setLibSets(v.sets || []) })
      .catch(() => { if (!disposed) setLibSets([]) })
    return () => { disposed = true }
  }, [hubOnlineForLib, libReloadKey])

  // 默认选中第一个集；当前集被删后回退。
  React.useEffect(() => {
    if (!Array.isArray(libSets)) return
    if (libSets.length === 0) { if (libSetId !== '') setLibSetId(''); return }
    if (libSetId === '' || !libSets.some((s) => s.id === libSetId)) setLibSetId(libSets[0].id)
  }, [libSets]) // eslint-disable-line react-hooks/exhaustive-deps

  // 用例列表：选定集时按标签筛选分页加载（一页最多 20 条）。
  React.useEffect(() => {
    if (!hubOnlineForLib || libSetId === '') { setLibData(null); return }
    let disposed = false
    setLibData(null)
    listLibCases(libSetId, { tag: libTag, offset: (libPage - 1) * LIB_PAGE_SIZE, limit: LIB_PAGE_SIZE })
      .then((v) => { if (!disposed) setLibData({ total: v.total, cases: v.cases || [] }) })
      .catch(() => { if (!disposed) setLibData({ total: 0, cases: [] }) })
    return () => { disposed = true }
  }, [hubOnlineForLib, libSetId, libTag, libPage, libReloadKey])

  // 页码越界自动回退（切换集/标签/删除集后总页数可能变少）。
  const libTotalPages = libData ? Math.max(1, Math.ceil(libData.total / LIB_PAGE_SIZE)) : 1
  React.useEffect(() => {
    if (libPage < 1) { setLibPage(1); return }
    if (libPage > libTotalPages) setLibPage(libTotalPages)
  }, [libPage, libTotalPages])

  // 设置对话框里保存根目录后同步本面板（根路径显示 + 批次列表）。
  React.useEffect(() => onRootChanged((rp) => {
    if (typeof rp === 'string' && rp !== '') setRootPath(rp)
    setReloadKey((k) => k + 1)
  }), [])

  const sessionsById = (sessions && sessions.byId) || {}
  const current = sessions && sessions.current

  const header = React.createElement('div', { className: 'dshmw-header' },
    React.createElement('span', { className: 'dshmw-title' }, 'Mock 实验场'),
    React.createElement('button', {
      type: 'button',
      className: 'dshmw-headbtn',
      title: '刷新',
      'aria-label': '刷新',
      onClick: () => { setReloadKey((k) => k + 1) },
    }, React.createElement(SvgIcon, { d: ICONS.refresh, size: 15 })))

  // ---- 卡片① 实验批次（批次 = 会话分组，轨迹 = 会话日志） ----
  const batchBody = []
  if (showForm) {
    batchBody.push(React.createElement(NewBatchForm, {
      key: 'form',
      onCreated: () => { setShowForm(false); setReloadKey((k) => k + 1) },
    }))
  }
  if (error) {
    batchBody.push(React.createElement('div', { key: 'err', className: 'dshmw-status' },
      React.createElement('span', { className: 'dshmw-err', role: 'alert' }, error),
      React.createElement('button', { type: 'button', className: 'dshmw-retry', onClick: load }, '重试')))
  }
  if (batches === null && !error) {
    batchBody.push(React.createElement('div', { key: 'loading', className: 'dshmw-status' }, '加载中…'))
  } else if (batches !== null && batches.length === 0 && !error) {
    batchBody.push(React.createElement('div', { key: 'empty', className: 'dshmw-empty' },
      React.createElement('div', null, '还没有批次'),
      React.createElement('div', { className: 'dshmw-hint' },
        '点卡片右上角「+ 新建」：输入一个名字，会创建独立的工作区目录并打开一个普通对话会话，轨迹与产物都会留在这个实验场里。')))
  } else if (batches !== null) {
    batches.forEach((batch) => {
      // 归档批次从列表隐藏（目录与 meta 保留在 runs/ 下）。
      if (batch.meta && batch.meta.status === 'archived') return
      batchBody.push(React.createElement(BatchRow, {
        key: batch.batchId || batch.path,
        batch,
        sessionsById,
        current,
        onChanged: () => { setReloadKey((k) => k + 1) },
      }))
    })
  }

  const batchCard = React.createElement(MockCard, {
    icon: ICONS.folder,
    title: '实验批次',
    actions: React.createElement('button', {
      type: 'button',
      className: 'dshmw-cardbtn',
      title: '新建批次（独立目录 + 对话会话）',
      onClick: () => { setShowForm(!showForm) },
    },
      React.createElement(SvgIcon, { d: ICONS.plus, size: 11 }),
      '新建'),
  }, batchBody)

  // ---- 卡片② 用例库（benchmark prompts：导入 / 标签筛选 / 浏览） ----
  const libBody = []
  const currentSet = Array.isArray(libSets) ? libSets.find((s) => s.id === libSetId) : null
  if (!hubOnlineForLib) {
    libBody.push(React.createElement('div', { key: 'offline', className: 'dshmw-hint', style: { padding: '2px 6px 6px', marginTop: 0 } },
      '用例库由产物托管 Hub 承载，先在「产物托管」卡片点「启动」'))
  } else if (libImporting) {
    libBody.push(React.createElement(LibraryImportForm, {
      key: 'import',
      onCancel: () => setLibImporting(false),
      onImported: (v) => {
        setLibImporting(false)
        setLibTag('')
        setLibPage(1)
        setLibReloadKey((k) => k + 1)
        if (v && v.set && typeof v.set.id === 'string') setLibSetId(v.set.id)
      },
    }))
  } else if (libSets === null) {
    libBody.push(React.createElement('div', { key: 'loading', className: 'dshmw-status' }, '加载中…'))
  } else if (libSets.length === 0) {
    libBody.push(React.createElement('div', { key: 'empty', className: 'dshmw-hint', style: { padding: '2px 6px 6px', marginTop: 0 } },
      '还没有用例集。点右上角「导入」把 benchmark 数据集（CSV / JSONL / JSON）归一化为 prompt 用例。'))
  } else {
    // 集选择 + 标签筛选
    const tagCounts = currentSet && currentSet.tagCounts ? currentSet.tagCounts : {}
    const topTags = Object.keys(tagCounts).sort((a, b) => tagCounts[b] - tagCounts[a]).slice(0, 30)
    libBody.push(React.createElement('div', { key: 'sel', className: 'dshmw-formrow', style: { padding: '2px 6px 4px' } },
      React.createElement('select', {
        className: 'dshmw-select',
        style: { flex: 1 },
        value: libSetId,
        onChange: (e) => { setLibSetId(e.target.value); setLibTag(''); setLibConfirmDelete(false); setLibPage(1) },
      }, libSets.map((s) =>
        React.createElement('option', { key: s.id, value: s.id },
          s.name + ' · ' + s.count))),
      topTags.length > 0
        ? React.createElement('select', {
            className: 'dshmw-select',
            style: { flex: 1 },
            value: libTag,
            title: '按标签筛选',
            onChange: (e) => { setLibTag(e.target.value); setLibPage(1) },
          }, [React.createElement('option', { key: '', value: '' }, '全部标签')].concat(
            topTags.map((t) => React.createElement('option', { key: t, value: t }, t + ' · ' + tagCounts[t]))))
        : null,
      React.createElement('button', {
        type: 'button',
        className: libConfirmDelete ? 'dshmw-batchact dshmw-batchact-danger' : 'dshmw-sessact',
        title: libConfirmDelete ? '再次点击确认删除该用例集' : '删除该用例集',
        onClick: () => {
          if (!libConfirmDelete) { setLibConfirmDelete(true); return }
          deleteLibSet(libSetId)
            .then(() => { setLibConfirmDelete(false); setLibPage(1); setLibReloadKey((k) => k + 1) })
            .catch((err) => console.warn(err))
        },
      }, React.createElement(SvgIcon, { d: ICONS.trash, size: 12 }))))
    // 用例列表
    if (libData === null) {
      libBody.push(React.createElement('div', { key: 'cases-loading', className: 'dshmw-status' }, '加载中…'))
    } else if (libData.cases.length === 0) {
      libBody.push(React.createElement('div', { key: 'cases-empty', className: 'dshmw-hint', style: { padding: '2px 6px 6px', marginTop: 0 } },
        libTag !== '' ? '该标签下没有用例' : '该集为空'))
    } else {
      libBody.push(React.createElement('div', { key: 'scroll', className: 'dshmw-libscroll' },
        libData.cases.map((c) => React.createElement(LibCaseRow, { key: c.id, c }))))
      libBody.push(React.createElement('div', { key: 'pager', className: 'dshmw-libpager' },
        React.createElement('button', {
          type: 'button',
          className: 'dshmw-pgbtn',
          disabled: libPage <= 1,
          title: '上一页',
          onClick: () => setLibPage((p) => Math.max(1, p - 1)),
        }, React.createElement(SvgIcon, { d: ICONS.chevL, size: 10 })),
        React.createElement('span', {
          className: 'dshmw-pginfo',
          title: '共 ' + libData.total + ' 条 · 每页 ' + LIB_PAGE_SIZE + ' 条',
        }, '第 ' + libPage + ' / ' + libTotalPages + ' 页 · ' + libData.total + ' 条'),
        React.createElement('button', {
          type: 'button',
          className: 'dshmw-pgbtn',
          disabled: libPage >= libTotalPages,
          title: '下一页',
          onClick: () => setLibPage((p) => Math.min(libTotalPages, p + 1)),
        }, React.createElement(SvgIcon, { d: ICONS.chevR, size: 10 }))))
    }
  }

  const libCard = React.createElement(MockCard, {
    icon: ICONS.book,
    title: '用例库',
    actions: React.createElement('button', {
      type: 'button',
      className: 'dshmw-cardbtn',
      disabled: !hubOnlineForLib,
      title: '导入 benchmark 数据集（CSV / JSONL / JSON），归一化为 prompt 用例集',
      onClick: () => setLibImporting(!libImporting),
    },
      React.createElement(SvgIcon, { d: ICONS.upload, size: 11 }),
      '导入'),
  }, libBody)

  // ---- 卡片③ 产物托管（artifact-hub 总览：状态 + 产物清单，点击直达） ----
  const hubBody = []
  const hubOnline = hub !== null && hub.online === true
  hubBody.push(React.createElement('div', { key: 'hub', className: 'dshmw-hubrow' },
    React.createElement('span', { className: 'dshmw-hubdot' + (hubOnline ? ' online' : '') }),
    React.createElement('span', { className: 'dshmw-huburl', title: HUB_URL }, HUB_URL.replace(/\/$/, '')),
    React.createElement('span', null, hub === null ? '探测中' : hubOnline ? '在线' : '未启动'),
    (!hubOnline && hub !== null)
      ? React.createElement('button', {
          type: 'button',
          className: 'dshmw-cardbtn',
          style: { marginLeft: 'auto' },
          disabled: hubStarting,
          title: '拉起 artifact-hub/server.mjs（detached 进程，独立于 dsh 常驻）',
          onClick: startHub,
        }, hubStarting ? '启动中…' : '启动')
      : null))
  if (!hubOnline) {
    hubBody.push(React.createElement('div', { key: 'hint', className: 'dshmw-hint', style: { padding: '0 6px 6px', marginTop: 0 } },
      hubStartError !== null
        ? '启动失败：' + hubStartError + '（可手动运行：node artifact-hub/server.mjs，日志见 artifact-hub/hub.log）'
        : '点「启动」一键拉起，或手动：node artifact-hub/server.mjs'))
  } else {
    const hubBatches = hub.batches || []
    const total = hubBatches.reduce((n, b) => n + ((b.artifacts || []).length), 0)
    if (total === 0) {
      hubBody.push(React.createElement('div', { key: 'none', className: 'dshmw-hint', style: { padding: '0 6px 6px', marginTop: 0 } },
        'runs/ 下未扫描到产物（index.html / package.json / artifact.json）'))
    } else {
      hubBatches.forEach((b) => {
        const arts = b.artifacts || []
        if (arts.length === 0) return
        hubBody.push(React.createElement('div', { key: 'g-' + b.batchId, className: 'dshmw-artgrouplabel', title: b.batchId },
          (b.name || b.batchId) + ' · ' + arts.length + ' 产物'))
        arts.forEach((a) => {
          const st = a.runtime && typeof a.runtime.status === 'string' ? a.runtime.status : 'stopped'
          hubBody.push(React.createElement('button', {
            key: a.id,
            type: 'button',
            className: 'dshmw-art',
            title: a.id + (a.runtime && a.runtime.url ? '\n' + a.runtime.url : ''),
            onClick: () => openHub(a.id),
          },
            React.createElement('span', { className: 'dshmw-dot ' + st }),
            React.createElement('span', { className: 'dshmw-artname' }, a.name || a.id),
            React.createElement('span', { className: 'dshmw-kind' }, a.kind)))
        })
      })
    }
  }

  const hubCard = React.createElement(MockCard, {
    icon: ICONS.globe,
    title: '产物托管',
    actions: React.createElement('button', {
      type: 'button',
      className: 'dshmw-cardbtn',
      title: hubOnline ? '在内置浏览器打开托管页（左预览 · 右轨迹）' : 'Hub 未启动 · 先运行 node artifact-hub/server.mjs',
      onClick: () => openHub(null),
    },
      React.createElement(SvgIcon, { d: ICONS.globe, size: 11 }),
      '打开'),
  }, hubBody)

  return React.createElement('div', { className: 'dshmw-root' }, header,
    batchCard,
    libCard,
    hubCard,
    rootPath ? React.createElement('div', { className: 'dshmw-rootpath', title: rootPath }, '根: ' + rootPath) : null)
}

// ---- apply（模块级；React 由 build.mjs 闭包工厂绑定） ----
async function apply(ctx) {
  ctxRef = ctx
  const slots = ctx.get('slots')
  if (slots === undefined) return
  const disposeCss = insertCss(CSS)

  const PANEL_ID = 'mock'
  const ORDER = 3

  // 回填历史批次的会话 id（composer 接管选择器的认领集合）；顺带注销
  // 「workspace 归属」时期为批次目录注册的 workspace（删注册不删目录/日志，
  // 会话回落未分组，由本插件接管输入框认领）。
  listBatches().then((res) => {
    const batches = (res && res.batches) || []
    for (const b of batches) {
      const ids = b.sessionIds || []
      for (const id of ids) mockSessionIds.add(id)
    }
    const w = ctxRef.get('workspaces')
    const list = w && w.list && typeof w.list.getSnapshot === 'function' ? w.list.getSnapshot() : null
    const items = (list && list.items) || []
    if (w && typeof w.delete === 'function') {
      for (const b of batches) {
        const ws = items.find((it) => it.path === b.path)
        if (ws) w.delete(ws.workspaceId).catch(() => {})
      }
    }
  }).catch(() => {})

  // 等 dsh-sidebar-live 的 shell 声明槽位后纯增量注册第三个 tab。
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
    // 系统设置对话框「通用」页里的「Mock 根目录」行（原侧边栏 gear 按钮的设置项挪到这里）。
    // order 20 排在 language(0) / appearance(10) 之后。
    disposers.push(slots.inject('settings.general.item', () => slots.register(
      { name: 'settings.general.item', id: 'mock-root', order: 20 },
      MockRootSettingsRow,
    )))
    // chain 接管：mock 空白会话的 composer（详见 selectMockBlankComposer 注释）。
    // 仅作兜底：host 半边对官方 bundle 做了内存补丁（exact 路由，见
    // src/index.js），打过补丁的响应带 'dsh-mock-workspace:composer-unlocked'
    // marker，此时官方 composer 对无 workspace 空白会话已解锁，不再注册手写
    // 接管框；探测不到 marker（锚点漂移 / 路由未生效）则回退手写接管框，
    // 保证首发消息可用。
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
}
