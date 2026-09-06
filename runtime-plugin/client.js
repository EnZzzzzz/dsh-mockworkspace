// dsh-mock-workspace — runtime plugin Client half.
// 在页面右上角全局视图入口旁注册「Mock 实验场」：大尺寸、Tab 式工作台。
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

    const errorText = (err) => (err && err.message ? String(err.message) : String(err))

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

    // 产物缩略图：运行中渲染活页面 iframe；未运行优先 Hub 截图（静态 PNG，
    // 加载失败退回快照 iframe）；再退回占位图标。
    function ArtThumb(props) {
      const [imgFailed, setImgFailed] = React.useState(false)
      if (!props.live && props.thumbUrl !== '' && !imgFailed) {
        return React.createElement('img', {
          className: 'dshmw-artimg',
          src: props.thumbUrl,
          alt: '',
          loading: 'lazy',
          onError: () => setImgFailed(true),
        })
      }
      if (props.url !== '') {
        return React.createElement('iframe', {
          className: 'dshmw-artframe',
          src: props.url,
          loading: 'lazy',
          scrolling: 'no',
          tabIndex: -1,
          'aria-hidden': true,
        })
      }
      return React.createElement('span', { className: 'dshmw-artplaceholder' },
        React.createElement(SvgIcon, { d: ICONS.globe, size: 18 }))
    }
    const ICONS = {
      beaker: 'M8 2.5 C6 4 5 6 5 9 V11.5 A1.5 1.5 0 0 0 6.5 13 H9.5 A1.5 1.5 0 0 0 11 11.5 V9 C11 6 10 4 8 2.5 Z M6.5 8.5 H9.5',
      plus: 'M8 3 V13 M3 8 H13',
      refresh: 'M13.5 8 A5.5 5.5 0 1 1 11 4.3 M13.5 3 V5.5 H11',
      gear: 'M7 2.5 H9 L9.5 4.2 A4.5 4.5 0 0 1 11 5.1 L12.6 4.6 L13.6 6.4 L12.2 7.4 A4.5 4.5 0 0 1 12.2 8.6 L13.6 9.6 L12.6 11.4 L11 10.9 A4.5 4.5 0 0 1 9.5 11.8 L9 13.5 H7 L6.5 11.8 A4.5 4.5 0 0 1 5 10.9 L3.4 11.4 L2.4 9.6 L3.8 8.6 A4.5 4.5 0 0 1 3.8 7.4 L2.4 6.4 L3.4 4.6 L5 5.1 A4.5 4.5 0 0 1 6.5 4.2 Z M8 6 A2 2 0 1 0 8 10 A2 2 0 0 0 8 6 Z',
      folder: 'M2 4.5 A1.5 1.5 0 0 1 3.5 3 H5.8 L7.3 4.5 H12.5 A1.5 1.5 0 0 1 14 6 V11.5 A1.5 1.5 0 0 1 12.5 13 H3.5 A1.5 1.5 0 0 1 2 11.5 Z',
      archive: 'M3 4.5 H13 L12.5 12.5 A1 1 0 0 1 11.5 13.5 H4.5 A1 1 0 0 1 3.5 12.5 Z M4.5 7.5 H11.5',
      camera: 'M2 5.5 A1.5 1.5 0 0 1 3.5 4 H5.6 L6.6 2.5 H9.4 L10.4 4 H12.5 A1.5 1.5 0 0 1 14 5.5 V11.5 A1.5 1.5 0 0 1 12.5 13 H3.5 A1.5 1.5 0 0 1 2 11.5 Z M8 6.4 A2.2 2.2 0 1 0 8 10.8 A2.2 2.2 0 0 0 8 6.4 Z',
      trash: 'M3 4.5 H13 M6 4.5 V3.5 A1 1 0 0 1 7 2.5 H9 A1 1 0 0 1 10 3.5 V4.5 M4.5 4.5 L5.2 12.5 A1 1 0 0 0 6.2 13.5 H9.8 A1 1 0 0 0 10.8 12.5 L11.5 4.5',
      globe: 'M8 2 A6 6 0 1 0 8 14 A6 6 0 1 0 8 2 Z M2 8 H14 M8 2 C9.8 3.8 10.5 5.8 10.5 8 C10.5 10.2 9.8 12.2 8 14 C6.2 12.2 5.5 10.2 5.5 8 C5.5 5.8 6.2 3.8 8 2 Z',
      list: 'M2.5 4 H13.5 M2.5 8 H13.5 M2.5 12 H13.5',
      pencil: 'M2 14 L2.9 10.6 L10.6 2.9 A1.4 1.4 0 0 1 12.6 4.9 L4.9 12.6 Z M9.6 3.9 L11.6 5.9',
      book: 'M4 2.5 H12.5 A1 1 0 0 1 13.5 3.5 V12.5 A1 1 0 0 1 12.5 13.5 H4 A1.5 1.5 0 0 1 2.5 12 V4 A1.5 1.5 0 0 1 4 2.5 Z M2.5 11 A1.5 1.5 0 0 1 4 9.5 H13.5',
      upload: 'M8 10.5 V2.5 M5 5.5 L8 2.5 L11 5.5 M3 12.5 H13',
      chevron: 'M3 6 L8 11 L13 6',
      chevL: 'M10 3 L5 8 L10 13',
      chevR: 'M6 3 L11 8 L6 13',
      share: 'M8 9.5 V2.5 M5.5 5 L8 2.5 L10.5 5 M3.5 8 V12.5 A1 1 0 0 0 4.5 13.5 H11.5 A1 1 0 0 0 12.5 12.5 V8',
    }

    // 产物托管 Hub（artifact-hub/server.mjs）管理页地址；Hub API 带 CORS * 头。
    const HUB_URL = 'http://127.0.0.1:4780/'

    // ---- styles (own prefix dshmw-, theme tokens only) ----
    const CSS = `
.dshmw-root{flex:1;min-height:0;display:flex;flex-direction:column;gap:8px;box-sizing:border-box;padding:4px 8px 8px;overflow-y:auto;overflow-x:hidden}
.dshmw-root-workspace{padding:14px 16px 18px;gap:12px}
.dshmw-root-workspace .dshmw-card{max-width:none}
.dshmw-root-workspace .dshmw-cardbody{padding:10px}
.dshmw-root-workspace .dshmw-libscroll{max-height:none;flex:1;min-height:0}
.dshmw-root-workspace .dshmw-artgrid{grid-template-columns:repeat(auto-fill,minmax(210px,1fr))}
.dshmw-header{flex:none;display:flex;align-items:center;justify-content:space-between;gap:4px;height:28px;padding:0 2px 0 6px;box-sizing:border-box;color:var(--dsw-alias-label-secondary)}
.dshmw-title{overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font-size:13px;font-weight:600}
.dshmw-headbtn{flex:none;display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border:none;border-radius:6px;padding:0;background:transparent;cursor:pointer;color:var(--dsw-alias-label-secondary)}
.dshmw-headbtn:hover{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}
.dshmw-headbtn:disabled{opacity:.45;cursor:default}
.dshmw-headbtn:disabled:hover{background:transparent;color:var(--dsw-alias-label-secondary)}
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
/* 会话行多动作容器：sessact 是绝对定位单按钮，多按钮需容器排开，否则互相叠住 */
.dshmw-sessacts{position:absolute;right:4px;display:none;align-items:center;gap:2px}
.dshmw-sessrow:hover .dshmw-sessacts{display:inline-flex}
.dshmw-sessacts .dshmw-sessact{position:static;display:inline-flex}
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
.dshmw-hubstatus{flex:none;display:inline-flex;align-items:center;gap:5px;border:none;border-radius:6px;padding:3px 6px;background:transparent;cursor:pointer;color:var(--dsw-alias-label-tertiary,#8a919d);font-size:11px;font-family:inherit}
.dshmw-hubstatus:hover{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary)}
.dshmw-hubdot{flex:none;width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-label-tertiary,#8a919d)}
.dshmw-hubdot.online{background:var(--dsw-alias-state-success-primary);box-shadow:0 0 4px rgba(63,185,105,.7)}
.dshmw-hubdot.offline{background:var(--dsw-alias-state-error-primary);box-shadow:0 0 4px rgba(240,84,84,.6)}
.dshmw-hubdot.starting{background:#d9a13b;animation:dshmw-pulse 1.1s infinite}
.dshmw-artgroup{display:flex;align-items:center;gap:4px;width:100%;box-sizing:border-box;padding:3px 6px 1px;border:none;background:transparent;cursor:pointer;font-family:inherit;font-size:11px;color:var(--dsw-alias-label-secondary);opacity:.75;text-align:left}
.dshmw-artgroup:hover{opacity:1;color:var(--dsw-alias-label-primary)}
.dshmw-artgroup .dshmw-chev{flex:none;display:inline-flex;transition:transform .15s ease}
.dshmw-artgroup-closed .dshmw-chev{transform:rotate(-90deg)}
.dshmw-artgrouptitle{flex:1;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.dshmw-artgrid{display:grid;grid-template-columns:1fr 1fr;gap:6px;padding:2px 6px 6px}
.dshmw-artcard{display:flex;flex-direction:column;min-width:0;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;overflow:hidden;background:transparent;cursor:pointer;padding:0;text-align:left;color:var(--dsw-alias-label-secondary);font-family:inherit}
.dshmw-artcard:hover{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary)}
.dshmw-artthumb{position:relative;width:100%;aspect-ratio:4/3;background:var(--dsw-alias-bg-layer-1);overflow:hidden}
.dshmw-artframe{position:absolute;top:0;left:0;width:500%;height:500%;border:none;transform:scale(.2);transform-origin:0 0;pointer-events:none;background:#fff}
.dshmw-artimg{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;object-position:top center;border:0;display:block;background:#fff}
.dshmw-artplaceholder{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-tertiary,#8a919d);opacity:.6}
.dshmw-artmeta{display:flex;align-items:center;gap:6px;padding:4px 6px;min-width:0;font-size:11px}
.dshmw-artfilter{display:flex;flex-wrap:wrap;gap:6px;padding:2px 6px 6px}
.dshmw-artfilter .dshmw-select{flex:1 1 96px;min-width:0}
.dshmw-artpop{position:fixed;z-index:80;width:230px;box-sizing:border-box;pointer-events:none;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:8px 10px;box-shadow:0 6px 24px rgba(0,0,0,.18);color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px;text-align:left}
.dshmw-artpopname{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary);overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.dshmw-artpoprow{display:flex;gap:6px;margin-top:3px;min-width:0}
.dshmw-artpopk{flex:none;color:var(--dsw-alias-label-tertiary,#8a919d)}
.dshmw-artpopv{flex:1;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;color:var(--dsw-alias-label-primary)}
.dshmw-artpophint{margin-top:5px;color:var(--dsw-alias-label-tertiary,#8a919d)}
.dshmw-artname{flex:1;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.dshmw-kind{flex:none;border-radius:4px;padding:0 5px;font-size:10px;line-height:15px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.dshmw-dot{flex:none;width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-label-tertiary,#9aa0a6)}
.dshmw-dot.running{background:var(--dsw-alias-state-success-primary)}
.dshmw-dot.starting,.dshmw-dot.installing{background:#d9a13b;animation:dshmw-pulse 1.1s infinite}
.dshmw-dot.failed{background:var(--dsw-alias-state-error-primary)}
@keyframes dshmw-pulse{50%{opacity:.35}}
.dshmw-select{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:11px;padding:2px 4px;font-family:inherit;max-width:100%}
.dshmw-libset-select{min-width:0;max-width:160px}
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
.dshmw-atts{display:flex;flex-wrap:wrap;gap:4px}
.dshmw-attchip{flex:none;display:inline-flex;align-items:center;gap:3px;max-width:100%;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l1);border-radius:4px;padding:0 6px;font-size:10px;line-height:16px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;overflow:hidden}
.dshmw-attchip:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2)}
.dshmw-attname{min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;max-width:140px}
.dshmw-attsize{flex:none;opacity:.7}
.dshmw-attdel{flex:none;padding:0 0 0 2px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#8a919d);cursor:pointer}
.dshmw-attdel:hover{color:var(--dsw-alias-state-error-primary)}
.dshmw-attform{display:flex;align-items:center;gap:4px}
.dshmw-attinput{flex:1;min-width:0;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:11px;padding:2px 6px;font-family:inherit}
.dshmw-attbtn{flex:none;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);font-size:11px;padding:2px 8px;cursor:pointer;font-family:inherit}
.dshmw-attbtn:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.dshmw-attbtn:disabled{opacity:.5;cursor:default}
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
.dshmw-ctxmenu{position:fixed;z-index:9999;min-width:150px;padding:4px;box-sizing:border-box;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.14);display:flex;flex-direction:column;gap:1px}
.dshmw-ctxitem{display:block;width:100%;text-align:left;border:none;background:transparent;border-radius:5px;padding:6px 10px;font-size:12px;font-family:inherit;color:var(--dsw-alias-label-primary);cursor:pointer}
.dshmw-ctxitem:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.dshmw-ctxsep{height:1px;margin:2px 4px;background:var(--dsw-alias-border-l1)}
.dshmw-toast{position:fixed;left:50%;bottom:32px;transform:translate(-50%,8px);opacity:0;pointer-events:none;transition:opacity .2s,transform .2s;z-index:10000;max-width:70vw;padding:7px 12px;border-radius:8px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);box-shadow:0 4px 16px rgba(0,0,0,.14);font-size:12px;color:var(--dsw-alias-label-primary)}
.dshmw-toast.show{opacity:1;transform:translate(-50%,0)}
.dshmw-settings{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;margin:0 4px;padding:8px;display:flex;flex-direction:column;gap:6px;box-sizing:border-box}
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
.dshmw-cases{box-sizing:border-box;flex:1;min-height:0;overflow-y:auto;overflow-x:hidden;padding:12px 16px 20px;display:flex;flex-direction:column;gap:10px}
.dshmw-launcher{position:absolute;top:54px;right:72px;z-index:20001;display:flex;align-items:center;padding:2px;border-radius:999px;background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l1);box-shadow:0 2px 10px rgba(0,0,0,.08);pointer-events:auto}
.dshmw-launcherbtn{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;border:none;border-radius:50%;padding:0;background:transparent;cursor:pointer;color:var(--dsw-alias-label-secondary)}
.dshmw-launcherbtn:hover{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}
.dshmw-launcherbtn.active,.dshmw-launcherbtn.active:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.dshmw-workspacebackdrop{position:fixed;inset:0;z-index:20000;background:rgba(0,0,0,.35);pointer-events:auto}
.dshmw-casesoverlay{position:fixed;top:24px;left:50%;transform:translateX(-50%);z-index:20002;width:min(1180px,calc(100% - 64px));height:min(840px,calc(100% - 48px));box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);border-radius:14px;background:var(--dsw-alias-bg-base);box-shadow:0 12px 40px rgba(0,0,0,.25);display:flex;flex-direction:column;overflow:hidden;pointer-events:auto}
.dshmw-casesoverlay-bar{flex:none;display:flex;align-items:center;gap:14px;min-height:52px;padding:0 12px 0 18px;box-sizing:border-box;border-bottom:1px solid var(--dsw-alias-border-l1);user-select:none;color:var(--dsw-alias-label-primary)}
.dshmw-casesoverlay-title{flex:none;font-size:14px;font-weight:600;white-space:nowrap}
.dshmw-workspacetabs{flex:1;min-width:0;align-self:stretch;display:flex;align-items:stretch;gap:4px}
.dshmw-workspacetab{position:relative;display:inline-flex;align-items:center;justify-content:center;min-width:88px;padding:0 14px;border:none;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;cursor:pointer}
.dshmw-workspacetab:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1)}
.dshmw-workspacetab.active{color:var(--dsw-alias-label-primary);font-weight:600}
.dshmw-workspacetab.active:after{content:'';position:absolute;left:16px;right:16px;bottom:0;height:2px;border-radius:2px;background:var(--dsw-alias-state-business-primary)}
.dshmw-casesoverlay-body{flex:1;min-height:0;display:flex;flex-direction:column}
@media(max-width:760px){.dshmw-launcher{right:72px}.dshmw-casesoverlay{top:12px;width:calc(100% - 24px);height:calc(100% - 24px)}.dshmw-casesoverlay-bar{gap:6px;padding-left:10px}.dshmw-casesoverlay-title{display:none}.dshmw-workspacetab{min-width:0;flex:1;padding:0 6px}.dshmw-cases-cols{flex-direction:column}.dshmw-cases-left{width:100%;max-height:36%}}
.dshmw-caseshead{flex:none;display:flex;align-items:center;gap:8px;min-height:28px;flex-wrap:wrap}
.dshmw-casestitle{flex:none;font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary)}
.dshmw-casesstatus{flex:none;font-size:11px;color:var(--dsw-alias-label-secondary)}
.dshmw-casesfilter{flex:none;max-width:220px;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:12px;padding:3px 6px;font-family:inherit}
.dshmw-casesfilterbar{flex:none;display:flex;align-items:center;gap:6px;margin:6px 0 2px}
.dshmw-casesfilterbar .dshmw-casesfilter{flex:1;min-width:0;max-width:none}
.dshmw-casesfilterbar .dshmw-select{flex:none;max-width:200px}
.dshmw-casespag{flex:none;display:flex;align-items:center;gap:6px;font-size:11px;color:var(--dsw-alias-label-secondary)}
.dshmw-casegrid{flex:none;display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:10px}
.dshmw-casecard{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);display:flex;flex-direction:column;overflow:hidden}
.dshmw-casecard.open{border-color:var(--dsw-alias-border-l2)}
.dshmw-casehead{display:flex;align-items:center;gap:8px;width:100%;box-sizing:border-box;padding:8px 10px;cursor:pointer;border:none;background:transparent;text-align:left;font-family:inherit;color:var(--dsw-alias-label-primary)}
.dshmw-casehead:hover{background:var(--dsw-alias-bg-layer-2)}
.dshmw-caseref{flex:1;min-width:0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;font-weight:600;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.dshmw-casebadge{flex:none;border-radius:4px;padding:0 5px;font-size:10px;line-height:16px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary)}
.dshmw-casechev{flex:none;color:var(--dsw-alias-label-tertiary);transition:transform .15s ease}
.dshmw-casecard.open .dshmw-casechev{transform:rotate(90deg)}
.dshmw-casebody{display:flex;flex-direction:column;gap:8px;padding:0 10px 10px}
.dshmw-casetags{display:flex;flex-wrap:wrap;gap:4px}
.dshmw-casetag{flex:none;border-radius:4px;padding:0 5px;font-size:10px;line-height:16px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);opacity:.85}
.dshmw-caseprompt{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);cursor:pointer;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;white-space:pre-wrap;overflow-wrap:break-word;border-radius:6px;padding:2px}
.dshmw-caseprompt:hover{background:var(--dsw-alias-bg-layer-2)}
.dshmw-caseprompt.open{display:block;white-space:pre-wrap}
.dshmw-casehits{flex:none;display:flex;flex-direction:column;gap:6px;border-top:1px dashed var(--dsw-alias-border-l1);padding-top:8px}
.dshmw-casehits-title{flex:none;font-size:11px;font-weight:600;color:var(--dsw-alias-label-secondary)}
.dshmw-hit-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:5px 8px;box-sizing:border-box;font-size:12px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-base)}
.dshmw-hit-date{flex:none;font-size:11px;color:var(--dsw-alias-label-tertiary)}
.dshmw-hit-batch{flex:none;max-width:180px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.dshmw-hit-sess{flex:none;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;color:var(--dsw-alias-label-tertiary)}
.dshmw-hit-links{flex:none;display:flex;align-items:center;gap:6px;margin-left:auto}
.dshmw-iter-link{flex:none;border:none;background:transparent;padding:0;font-family:inherit;font-size:11px;color:var(--dsw-alias-state-business-primary);cursor:pointer}
.dshmw-iter-link:hover{text-decoration:underline}
.dshmw-iter-link-danger{color:var(--dsw-alias-state-error-primary)}
.dshmw-hit{display:flex;flex-direction:column;gap:6px}
.dshmw-hit-card{flex:none;overflow:hidden;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);transition:border-color .15s ease,box-shadow .15s ease,transform .15s ease}
.dshmw-hit-card.clickable{cursor:pointer}
.dshmw-hit-card.clickable:hover{border-color:var(--dsw-alias-state-business-primary);box-shadow:var(--dsw-shadow-lv1);transform:translateY(-1px)}
.dshmw-hit-preview{position:relative;height:190px;overflow:hidden;background:var(--dsw-alias-bg-base);border-bottom:1px solid var(--dsw-alias-border-l1)}
.dshmw-hit-preview iframe{display:block;width:100%;height:100%;border:0;pointer-events:none;background:#fff}
.dshmw-hit-preview-empty{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:5px;color:var(--dsw-alias-label-tertiary);font-size:11px;background:linear-gradient(135deg,var(--dsw-alias-bg-base),var(--dsw-alias-bg-layer-2))}
.dshmw-hit-preview-icon{font-size:24px;line-height:1;opacity:.55}
.dshmw-hit-preview-badge{position:absolute;right:8px;bottom:8px;border-radius:999px;padding:3px 8px;font-size:10px;color:#fff;background:rgba(15,17,21,.72);backdrop-filter:blur(6px)}
.dshmw-hit-cardbody{display:flex;flex-direction:column;gap:7px;padding:9px 10px 10px}
.dshmw-hit-cardtop{display:flex;align-items:center;gap:8px;min-width:0}
.dshmw-hit-cardtitle{flex:1;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary)}
.dshmw-hit-cardmeta{display:flex;align-items:center;gap:8px;min-width:0;color:var(--dsw-alias-label-tertiary);font-size:11px}
.dshmw-hit-cardmeta .dshmw-hit-sess{margin-left:auto}
.dshmw-hit-panel{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:8px;box-sizing:border-box;background:var(--dsw-alias-bg-base)}
.dshmw-traj{display:flex;flex-direction:column;gap:6px;max-height:440px;overflow-y:auto}
.dshmw-traj-full{max-height:none;flex:1;min-height:0}
.dshmw-trajbar{flex:none;display:flex;align-items:center;gap:8px;min-height:28px}
.dshmw-trajtitle{flex:none;font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}
.dshmw-cases-right-inner{flex:1;min-height:0;display:flex;flex-direction:column}
.dshmw-traj-turn{font-size:11px;color:var(--dsw-alias-label-tertiary);padding:2px 0}
.dshmw-traj-item{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:6px 8px;box-sizing:border-box;font-size:12px;color:var(--dsw-alias-label-secondary)}
.dshmw-traj-meta{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--dsw-alias-label-tertiary)}
.dshmw-traj-name{font-weight:600;color:var(--dsw-alias-label-primary)}
.dshmw-traj-text{white-space:pre-wrap;overflow-wrap:break-word;font-size:12px;line-height:18px;margin-top:4px}
.dshmw-traj-detail{white-space:pre-wrap;overflow-wrap:break-word;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;line-height:16px;margin-top:4px;color:var(--dsw-alias-label-secondary)}
.dshmw-traj-details{font-size:11px;margin-top:4px;color:var(--dsw-alias-state-business-primary)}
.dshmw-traj-toggle{border:none;background:transparent;padding:0;font-family:inherit;font-size:11px;color:var(--dsw-alias-state-business-primary);cursor:pointer;margin-top:4px}
.dshmw-snapform{display:flex;align-items:center;gap:6px;padding:3px 4px 3px 26px;box-sizing:border-box}
.dshmw-snapinput{flex:1;min-width:0;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:12px;padding:3px 6px;font-family:inherit}
.dshmw-snapbtn{flex:none;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:11px;padding:3px 8px;cursor:pointer;font-family:inherit}
.dshmw-snapbtn:hover{background:var(--dsw-alias-bg-layer-2)}
.dshmw-snapbtn:disabled{opacity:.5;cursor:default}
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

    // ---- 会话快照：fork 冻结轨迹 + Host 冻结产物 ----
    // fork 出的子会话即「冻结到这一刻」的轨迹副本（继承 cwd/上下文/lineage）；
    // fork 不冻结文件，产物快照由 Host mock.snapshot-session 此刻复制。
    // 快照会话改名「快照 · …」后归档隐藏（日志保留可恢复），原会话继续对话。
    function snapshotSession(sessionId, batchPath, note) {
      const s = ctx.get('sessions')
      if (!s || typeof s.fork !== 'function') return Promise.reject(new Error('sessions 服务不支持分叉'))
      return s.fork({ sessionId, increaseTitle: false }).then((childId) => {
        if (typeof childId !== 'string' || childId === '') throw new Error('分叉未返回新会话')
        const stamp = new Date().toLocaleString('zh-CN', { hour12: false })
        const title = '快照 · ' + (note !== '' ? note : stamp)
        // 改名尽力而为：sessions 服务无 rename 时保留 fork 默认标题。
        const renamed = typeof s.rename === 'function'
          ? Promise.resolve(s.rename({ sessionId: childId, title })).catch(() => {})
          : Promise.resolve()
        return renamed
          .then(() => snapshotSessionRun(childId, sessionId, batchPath, note))
          .then((res) => archiveSession(childId).then(() => res))
      })
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
    const createBatch = (name, opts) => callHost('mock.create-batch', Object.assign({ name }, opts || {}))
    const archiveBatch = (path) => callHost('mock.archive-batch', { path })
    const archiveSessionRun = (sessionId, batchPath) => callHost('mock.archive-session', { sessionId, batchPath })
    const snapshotSessionRun = (sessionId, sourceSessionId, batchPath, note) =>
      callHost('mock.snapshot-session', { sessionId, sourceSessionId, batchPath, note })
    const deleteBatch = (path) => callHost('mock.delete-batch', { path })
    const getConfig = () => callHost('mock.get-config')
    const setConfig = (root) => callHost('mock.set-config', { root })
    const setBatchGen = (path, gen) => callHost('mock.set-gen', { path, gen })
    const prepareCaseAssets = (batchPath, files) => callHost('mock.prepare-case-assets', { batchPath, files })

    // 记录批次生成参数（尽力而为，失败静默）：Agent 模式取 session.create
    // 返回的 agentPreset；模型取 Host 当前默认（host.describe 的 model）。
    // 只记拿到的字段，任一缺失不阻断。产物级精确值可用 artifact.json 的
    // gen 字段覆盖批次默认。
    function recordBatchGen(batchPath, agentPreset) {
      const gen = {}
      if (typeof agentPreset === 'string' && agentPreset !== '') gen.agent = agentPreset
      const flush = () => {
        if (Object.keys(gen).length > 0) setBatchGen(batchPath, gen).catch(() => {})
      }
      // 预设版本不是 dsh 的一等字段（agentPreset.list/read 均无 version）；
      // dsh-design-harness 的 sync.py 约定会把
      // `# preset version: X | git: Y (branch: Z)` 写进部署文件
      // agent.cordis.yml 头部，尽力解析，无此约定则跳过。
      const readPresetVersion = gen.agent === undefined
        ? Promise.resolve()
        : apiCall('agentPreset.read', { agentPreset: gen.agent }).then((p) => {
            const head = p && typeof p.content === 'string' ? p.content.slice(0, 600) : ''
            const m = head.match(/^#\s*preset version:\s*([^\s|]+)\s*(?:\|\s*git:\s*([^\s(]+))?/m)
            if (m !== null) gen.agentVersion = m[1] + (m[2] ? ' · ' + m[2] : '')
          }).catch(() => {})
      Promise.all([
        apiCall('host.describe', {}).then((d) => {
          if (d && typeof d.model === 'string' && d.model !== '') gen.model = d.model
        }).catch(() => {}),
        readPresetVersion,
      ]).then(flush)
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
    // 用例附件：attach 收绝对路径列表（返回 { attachments, errors }），detach 按名移除。
    const attachLibFiles = (setId, caseId, paths) => hubApi('library/attach', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ setId, caseId, paths }),
    })
    const detachLibFile = (setId, caseId, name) => hubApi('library/detach', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ setId, caseId, name }),
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
    const deleteIteration = (archiveId) => hubApi('iterations/delete', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ archiveId }),
    })

    // ---- 会话头部 view ring（conversation.view）切换助手 ----
    // 活跃 view 存在 chat store 内部的 `view` 字段，无公开 setter；用模拟头部
    // Tab 点击切换（与 dsh-slide-bar 同一模式，官方头部 Tab 的 onClick 会调
    // actions.setView）。「内置浏览器」由 dsh-builtin-browser 提供。
    function activateViewByLabel(label) {
      try {
        const tabs = document.querySelectorAll('[role="tablist"] button[role="tab"]')
        for (const b of tabs) {
          if ((b.textContent || '').trim() === label) { b.click(); return true }
        }
      } catch (e) { /* ignore */ }
      return false
    }
    // 在内置浏览器视图里打开 URL（面板内展示，不弹独立窗口）。复用同一个专用
    // 预览 Tab：tab 的 `current` 只在 surface 真正加载后才更新，按 URL 匹配不可靠
    // （排队中的导航不会更新 → 每次点击都会新建 Tab，越开越多）。这里维护一个
    // 稳定的 Tab id 优先复用，丢了再按 Hub URL 前缀找，都没有才新建。
    let browserPreviewTabId = null
    function openInBuiltinBrowser(url) {
      const ctrl = typeof window !== 'undefined' ? window.__dshBrowser : undefined
      if (!ctrl || typeof ctrl.command !== 'function') {
        try { window.open(url, '_blank', 'noopener') } catch (e) { /* ignore */ }
        return false
      }
      const done = () => { try { activateViewByLabel('内置浏览器') } catch (e) { /* ignore */ } }
      ctrl.command({ op: 'tab-list' }).then((res) => {
        const tabs = res && Array.isArray(res.tabs) ? res.tabs : []
        let tab = tabs.find((t) => t.id === browserPreviewTabId)
          || tabs.find((t) => typeof t.url === 'string' && t.url.startsWith(HUB_URL))
        if (tab) {
          browserPreviewTabId = tab.id
          return ctrl.command({ op: 'tab-activate', id: tab.id }).then(() => ctrl.command({ op: 'navigate', url }))
        }
        return ctrl.command({ op: 'tab-new' }).then((r) => {
          if (r && typeof r.id === 'number') browserPreviewTabId = r.id
          return ctrl.command({ op: 'navigate', url })
        })
      }).then(() => done())
        .catch(() => { try { window.open(url, '_blank', 'noopener') } catch (e) { /* ignore */ } })
      return true
    }
    function fmtDateTime(iso) {
      if (!iso) return ''
      try { return new Date(iso).toLocaleString('zh-CN', { hour12: false }) } catch (e) { return String(iso) }
    }
    function fmtTime(iso) {
      if (!iso) return ''
      try {
        const d = new Date(iso)
        const pad = (n) => String(n).padStart(2, '0')
        return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds())
      } catch (e) { return '' }
    }
    // 产物可访问 URL：运行中取 runtime.url；静态产物走 Hub /preview/ 伺服；
    // node 类产物未运行时回退到该批次最新归档快照（Hub /api/state 带 archiveUrl）。
    function artifactUrl(a) {
      const rt = a.runtime || {}
      if (rt.url) return rt.url
      if (a.kind === 'static') return HUB_URL + 'preview/' + a.id.replace(/^\//, '') + '/'
      if (typeof a.archiveUrl === 'string' && a.archiveUrl !== '') return HUB_URL + a.archiveUrl.replace(/^\//, '')
      return ''
    }

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
        recordBatchGen(batchPath, value && value.agentPreset)
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

    // ---- 用例库：用例行（sourceRef + prompt 预览 + 标签 + 附件；点击展开全文，右键菜单） ----
    // 附件大小：人类可读（KB/MB）。
    function fmtAttSize(n) {
      const size = typeof n === 'number' && isFinite(n) && n >= 0 ? n : 0
      if (size >= 1024 * 1024) return (size / (1024 * 1024)).toFixed(1) + ' MB'
      if (size >= 1024) return Math.round(size / 1024) + ' KB'
      return size + ' B'
    }
    function LibCaseRow(props) {
      const c = props.c
      const onMenu = props.onMenu
      const [open, setOpen] = React.useState(false)
      // 附件管理后的局部覆盖：attach/detach 只刷新本条，不整页重载。
      const [attsOverride, setAttsOverride] = React.useState(null)
      const [attInput, setAttInput] = React.useState('')
      const [attBusy, setAttBusy] = React.useState(false)
      const atts = attsOverride !== null ? attsOverride : (Array.isArray(c.attachments) ? c.attachments : [])
      const openAtt = (a) => {
        const url = HUB_URL + 'api/library/attachment-file?setId=' + encodeURIComponent(c.setId || '')
          + '&caseId=' + encodeURIComponent(c.id || '')
          + '&name=' + encodeURIComponent(a && typeof a.name === 'string' ? a.name : '')
        try { window.open(url, '_blank', 'noopener') } catch (err) { /* ignore */ }
      }
      const detachAtt = (a) => {
        if (attBusy) return
        setAttBusy(true)
        detachLibFile(c.setId, c.id, a.name).then((v) => {
          setAttsOverride(Array.isArray(v && v.attachments) ? v.attachments : atts.filter((x) => x.name !== a.name))
        }).catch((err) => showCtxToast('移除附件失败：' + errorText(err)))
          .finally(() => setAttBusy(false))
      }
      const attachAtts = () => {
        if (attBusy) return
        const paths = attInput.split(';').map((s) => s.trim()).filter((s) => s !== '')
        if (paths.length === 0) return
        setAttBusy(true)
        attachLibFiles(c.setId, c.id, paths).then((v) => {
          setAttsOverride(Array.isArray(v && v.attachments) ? v.attachments : atts)
          setAttInput('')
          const errs = v && Array.isArray(v.errors) ? v.errors : []
          if (errs.length > 0) showCtxToast('部分附件添加失败：' + errorText(errs[0]))
        }).catch((err) => showCtxToast('添加附件失败：' + errorText(err)))
          .finally(() => setAttBusy(false))
      }
      return React.createElement('div', {
        className: 'dshmw-librow',
        onContextMenu: onMenu ? (e) => onMenu(c, e) : undefined,
      },
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
          : null,
        atts.length > 0
          ? React.createElement('div', { className: 'dshmw-atts' },
              atts.map((a) => React.createElement('span', {
                key: a.name,
                className: 'dshmw-attchip',
                title: '在新标签页预览附件' + (a.mime ? '（' + a.mime + '）' : ''),
                onClick: (e) => { e.stopPropagation(); openAtt(a) },
              },
                '📎',
                React.createElement('span', { className: 'dshmw-attname' }, a.name),
                React.createElement('span', { className: 'dshmw-attsize' }, fmtAttSize(a.size)),
                open ? React.createElement('span', {
                  className: 'dshmw-attdel',
                  title: '从该用例移除该附件',
                  onClick: (e) => { e.stopPropagation(); detachAtt(a) },
                }, '×') : null)))
          : null,
        open ? React.createElement('div', { className: 'dshmw-attform' },
            React.createElement('input', {
              className: 'dshmw-attinput',
              placeholder: '文件绝对路径，多个用 ; 分隔',
              value: attInput,
              disabled: attBusy,
              onChange: (e) => setAttInput(e.target.value),
              onKeyDown: (e) => { if (e.key === 'Enter' && !attBusy) attachAtts() },
            }),
            React.createElement('button', {
              type: 'button',
              className: 'dshmw-attbtn',
              disabled: attBusy,
              onClick: attachAtts,
            }, attBusy ? '…' : '添加附件')) : null)
    }

    // ---- 用例右键菜单：发送 prompt 到聊天输入框 / 复制（DOM 注入官方 composer） ----
    let ctxMenuEl = null
    function closeCaseMenu() {
      if (ctxMenuEl) { ctxMenuEl.remove(); ctxMenuEl = null }
      window.removeEventListener('mousedown', onCtxMenuDocDown, true)
      window.removeEventListener('contextmenu', onCtxMenuDocCtx, true)
      window.removeEventListener('keydown', onCtxMenuDocKey, true)
      window.removeEventListener('scroll', closeCaseMenu, true)
    }
    function onCtxMenuDocDown(e) {
      if (ctxMenuEl && !ctxMenuEl.contains(e.target)) closeCaseMenu()
    }
    function onCtxMenuDocCtx() { closeCaseMenu() }
    function onCtxMenuDocKey(e) { if (e.key === 'Escape') closeCaseMenu() }
    function openCaseMenu(c, e) {
      if (!c) return
      e.preventDefault()
      e.stopPropagation()
      closeCaseMenu()
      const menu = document.createElement('div')
      menu.className = 'dshmw-ctxmenu'
      const pad = 8
      menu.style.left = Math.max(pad, Math.min(e.clientX, window.innerWidth - 170)) + 'px'
      menu.style.top = Math.max(pad, Math.min(e.clientY, window.innerHeight - 110)) + 'px'
      const itemRun = document.createElement('button')
      itemRun.type = 'button'
      itemRun.className = 'dshmw-ctxitem'
      itemRun.textContent = '用该用例开跑'
      itemRun.title = '新建批次 + 会话（meta 带用例 ID），prompt 预填进输入框'
      itemRun.onclick = () => { closeCaseMenu(); startCaseRun(c) }
      const itemSend = document.createElement('button')
      itemSend.type = 'button'
      itemSend.className = 'dshmw-ctxitem'
      itemSend.textContent = '发送到聊天对话框'
      itemSend.title = '把该用例的 prompt 填入当前聊天输入框'
      itemSend.onclick = () => { closeCaseMenu(); sendCaseToChat(c) }
      const itemCopy = document.createElement('button')
      itemCopy.type = 'button'
      itemCopy.className = 'dshmw-ctxitem'
      itemCopy.textContent = '复制 prompt'
      itemCopy.onclick = () => { closeCaseMenu(); copyCasePrompt(c, true) }
      menu.appendChild(itemRun)
      const sepRun = document.createElement('div')
      sepRun.className = 'dshmw-ctxsep'
      menu.appendChild(sepRun)
      menu.appendChild(itemSend)
      menu.appendChild(itemCopy)
      document.body.appendChild(menu)
      ctxMenuEl = menu
      window.addEventListener('mousedown', onCtxMenuDocDown, true)
      window.addEventListener('contextmenu', onCtxMenuDocCtx, true)
      window.addEventListener('keydown', onCtxMenuDocKey, true)
      window.addEventListener('scroll', closeCaseMenu, true)
    }

    // ---- 头部「打开后台服务页面」菜单：系统浏览器 / 内置浏览器 ----
    // 复用用例菜单的 ctxmenu 样式与全局关闭监听（closeCaseMenu 一并关闭本菜单）。
    function openHubPageMenu(e) {
      e.preventDefault()
      e.stopPropagation()
      closeCaseMenu()
      const anchor = e.currentTarget
      const menu = document.createElement('div')
      menu.className = 'dshmw-ctxmenu'
      const itemSys = document.createElement('button')
      itemSys.type = 'button'
      itemSys.className = 'dshmw-ctxitem'
      itemSys.textContent = '在系统浏览器打开'
      itemSys.title = HUB_URL
      itemSys.onclick = () => {
        closeCaseMenu()
        try { window.open(HUB_URL, '_blank', 'noopener') } catch (err) { /* ignore */ }
      }
      const itemBuiltin = document.createElement('button')
      itemBuiltin.type = 'button'
      itemBuiltin.className = 'dshmw-ctxitem'
      itemBuiltin.textContent = '在内置浏览器打开'
      itemBuiltin.title = HUB_URL
      itemBuiltin.onclick = () => { closeCaseMenu(); openInBuiltinBrowser(HUB_URL) }
      menu.appendChild(itemSys)
      menu.appendChild(itemBuiltin)
      document.body.appendChild(menu)
      const rect = anchor && typeof anchor.getBoundingClientRect === 'function' ? anchor.getBoundingClientRect() : null
      const pad = 8
      menu.style.left = Math.max(pad, Math.min(rect ? rect.left : e.clientX, window.innerWidth - menu.offsetWidth - pad)) + 'px'
      menu.style.top = Math.max(pad, Math.min(rect ? rect.bottom + 4 : e.clientY, window.innerHeight - menu.offsetHeight - pad)) + 'px'
      ctxMenuEl = menu
      window.addEventListener('mousedown', onCtxMenuDocDown, true)
      window.addEventListener('contextmenu', onCtxMenuDocCtx, true)
      window.addEventListener('keydown', onCtxMenuDocKey, true)
      window.addEventListener('scroll', closeCaseMenu, true)
    }

    // 找当前可见的聊天输入框：优先主对话区最底部的 textarea / contenteditable，
    // 排除本插件面板自身的元素。
    function findComposerInput() {
      let best = null
      let bestBottom = -1
      const els = document.querySelectorAll('textarea, input[type="text"], [contenteditable]:not([contenteditable="false"])')
      for (const el of els) {
        if (!(el.offsetWidth || el.offsetHeight)) continue
        if (el.closest('.dshmw-root')) continue
        if (el.closest('[aria-hidden="true"]')) continue
        if (el.disabled) continue
        const r = el.getBoundingClientRect()
        if (r.bottom > bestBottom) { bestBottom = r.bottom; best = el }
      }
      return best
    }
    // React 受控输入框用原生 setter + input 事件写入，触发组件状态更新。
    function setInputText(el, text) {
      if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
        const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
        const desc = Object.getOwnPropertyDescriptor(proto, 'value')
        if (desc && desc.set) desc.set.call(el, text)
        else el.value = text
        el.dispatchEvent(new Event('input', { bubbles: true }))
      } else {
        el.textContent = text
        el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }))
      }
      el.focus()
      if (typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    }
    function sendCaseToChat(c) {
      const prompt = c && typeof c.prompt === 'string' ? c.prompt : ''
      if (!prompt) return
      const el = findComposerInput()
      if (!el) {
        copyCasePrompt(c, true)
        showCtxToast('未找到聊天输入框，已复制 prompt')
        return
      }
      setInputText(el, prompt)
      showCtxToast('已发送到聊天输入框')
    }
    function copyCasePrompt(c, notify) {
      const prompt = c && typeof c.prompt === 'string' ? c.prompt : ''
      if (!prompt) return
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        navigator.clipboard.writeText(prompt).then(
          () => { if (notify) showCtxToast('已复制 prompt') },
          () => { if (notify) showCtxToast('复制失败') })
      } else {
        const ta = document.createElement('textarea')
        ta.value = prompt
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.select()
        try { document.execCommand('copy') } catch (err) { /* noop */ }
        ta.remove()
        if (notify) showCtxToast('已复制 prompt')
      }
    }
    let ctxToastTimer = null
    function showCtxToast(text) {
      if (ctxToastTimer) { clearTimeout(ctxToastTimer); ctxToastTimer = null }
      let t = document.getElementById('dshmw-ctx-toast')
      if (!t) {
        t = document.createElement('div')
        t.id = 'dshmw-ctx-toast'
        t.className = 'dshmw-toast'
        document.body.appendChild(t)
      }
      t.textContent = text
      t.classList.add('show')
      ctxToastTimer = setTimeout(() => { t.classList.remove('show') }, 2200)
    }
    function disposeCtxUI() {
      closeCaseMenu()
      const t = document.getElementById('dshmw-ctx-toast')
      if (t) t.remove()
    }

    // ---- 右键用例「用该用例开跑」：建批次(meta 带用例 ID) + 开会话 + prompt 预填 ----
    function fnvHash(s) {
      let h = 0x811c9dc5
      for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i)
        h = Math.imul(h, 0x01000193)
      }
      return (h >>> 0).toString(36)
    }
    // 会话打开后 composer 可能尚未挂载，最多重试几拍再放弃。
    function fillComposerWith(text, tries) {
      const el = findComposerInput()
      if (el) { setInputText(el, text); return }
      if ((tries || 0) < 6) setTimeout(() => fillComposerWith(text, (tries || 0) + 1), 600)
    }
    function startCaseRun(c) {
      if (!c || !c.prompt) return
      const name = (((c.setId || '') + ' · ' + (c.sourceRef || c.id || '用例')).replace(/^ · /, ''))
      createBatch(name, {
        caseId: c.id || '',
        caseSetId: c.setId || '',
        sourceRef: c.sourceRef || '',
        promptHash: c.prompt ? fnvHash(c.prompt) : '',
      })
        .then((res) => {
          const batchPath = res && typeof res.batchPath === 'string' ? res.batchPath : ''
          if (batchPath === '') throw new Error('未返回批次目录')
          return startBatchSession(batchPath).then(() => batchPath)
        })
        .then((batchPath) => {
          const atts = Array.isArray(c.attachments) ? c.attachments : []
          const files = atts
            .filter((a) => a && typeof a.stored === 'string' && a.stored !== '')
            .map((a) => ({ stored: a.stored, name: typeof a.name === 'string' ? a.name : '' }))
          if (files.length === 0) {
            fillComposerWith(c.prompt, 0)
            showCtxToast('已开跑：新建批次 + 会话，prompt 已填入输入框')
            return
          }
          // 有附件：先让 Host 把库内附件复制进批次 assets/ 并写入 meta.json，
          // 再按复制结果决定 prompt 是否追加随附材料清单。复制失败不阻塞开跑。
          prepareCaseAssets(batchPath, files)
            .then((res) => {
              const assets = res && Array.isArray(res.assets) ? res.assets : []
              const errors = res && Array.isArray(res.errors) ? res.errors : []
              if (errors.length > 0 || assets.length === 0) {
                fillComposerWith(c.prompt, 0)
                showCtxToast(errors.length > 0
                  ? '附件复制失败：' + errorText(errors[0])
                  : '已开跑：新建批次 + 会话，prompt 已填入输入框')
                return
              }
              const prompt = c.prompt + '\n\n---\n随附材料（已放入本会话工作目录 assets/ 下）：\n'
                + assets.map((a) => '- ' + a).join('\n')
                + '\n读取 PDF 等二进制材料时，请先用命令行工具（如 pdftotext）提取文本。'
              fillComposerWith(prompt, 0)
              showCtxToast('已开跑：新建批次 + 会话，prompt（含 ' + assets.length + ' 个附件）已填入输入框')
            })
            .catch((err) => {
              fillComposerWith(c.prompt, 0)
              showCtxToast('附件复制失败：' + errorText(err))
            })
        })
        .catch((err) => showCtxToast('开跑失败：' + errorText(err)))
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
      const [attCol, setAttCol] = React.useState('')

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
          setAttCol(g.attachmentColumn || '')
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
        const mapping = { promptColumn: promptCol, refColumn: refCol, languageColumn: langCol, tagColumns: tagCols }
        if (attCol !== '') mapping.attachmentColumn = attCol
        importLib(Object.assign(base, {
          name: name.trim(),
          mapping,
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
              React.createElement('div', { key: 'map3', className: 'dshmw-formrow' },
                React.createElement('span', { className: 'dshmw-fieldlabel', style: { width: 52, flex: 'none', paddingTop: 5 } }, '附件列'),
                colSelect(attCol, setAttCol, '（无）'),
                React.createElement('span', { className: 'dshmw-fieldlabel', style: { flex: 'none', paddingTop: 5, opacity: .6 } }, '列值 = 附件文件绝对路径，多个用 ; 分隔')),
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

    // ---- 批次行（点标题折叠/展开会话列表；首行「新会话」入口） ----
    function BatchRow(props) {
      const batch = props.batch
      const sessionsById = props.sessionsById

      const meta = batch.meta || {}
      const title = batch.title || meta.name || batch.batchId || '批次'
      // 归档集合：归档后的会话从批次列表里消失（日志保留，可从归档恢复）。
      const w = ctx.get('workspaces')
      const wsList = w && w.list && typeof w.list.getSnapshot === 'function' ? w.list.getSnapshot() : null
      const sessionIds = props.sessionIds
      const [open, setOpen] = React.useState(false)
      const [confirmDelete, setConfirmDelete] = React.useState(false)
      // 会话快照内联表单：snapId = 正在存快照的会话 id（null 关闭）
      const [snapId, setSnapId] = React.useState(null)
      const [snapNote, setSnapNote] = React.useState('')
      const [snapBusy, setSnapBusy] = React.useState(false)
      const confirmSnapshot = (id) => {
        if (snapBusy) return
        setSnapBusy(true)
        snapshotSession(id, batch.path, snapNote.trim())
          .then((res) => {
            const rec = res && res.record
            const hasSnap = rec && Array.isArray(rec.artifacts) && rec.artifacts.length > 0
            showCtxToast(hasSnap
              ? '已存快照（轨迹 + 产物），原会话可继续'
              : '已存快照（仅轨迹；未发现可快照 HTML 产物）')
            setSnapId(null)
            setSnapNote('')
            props.onChanged()
          })
          .catch((err) => { showCtxToast('快照失败：' + errorText(err)); console.warn(err) })
          .finally(() => setSnapBusy(false))
      }

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
            const sum = sessionsById[id] || { title: '会话 ' + String(id).slice(0, 12), updatedAt: null, blank: false }
            const running = sum && sum.running === true
            return React.createElement('div', { key: id },
              React.createElement('div', { className: 'dshmw-sessrow' },
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
                React.createElement('div', { className: 'dshmw-sessacts' },
                  React.createElement('button', {
                    type: 'button',
                    className: 'dshmw-sessact',
                    disabled: running,
                    title: running
                      ? '会话进行中：产物可能是瞬态，等回合结束再存快照'
                      : '存快照：fork 冻结当前轨迹 + 复制当前产物，原会话继续',
                    onClick: (e) => {
                      e.stopPropagation()
                      if (running) return
                      setSnapNote('')
                      setSnapId(snapId === id ? null : id)
                    },
                  }, React.createElement(SvgIcon, { d: ICONS.camera, size: 12 })),
                  React.createElement('button', {
                    type: 'button',
                    className: 'dshmw-sessact',
                    title: '归档该会话（产物快照 + 会话记录 + 日志保留）',
                    onClick: (e) => {
                      e.stopPropagation()
                      archiveSessionRun(id, batch.path)
                        .then((res) => {
                          const rec = res && res.record
                          const hasSnap = rec && Array.isArray(rec.artifacts) && rec.artifacts.length > 0
                          return archiveSession(id).then(() => {
                            showCtxToast(hasSnap
                              ? '已归档（产物 + 会话记录）'
                              : '已归档（未发现可快照 HTML 产物，产物生成后可再归档一次）')
                            props.onChanged()
                          })
                        })
                        .catch((err) => { showCtxToast('归档失败：' + errorText(err)); console.warn(err) })
                    },
                  }, React.createElement(SvgIcon, { d: ICONS.archive, size: 12 })))),
              snapId === id ? React.createElement('div', { className: 'dshmw-snapform' },
                React.createElement('input', {
                  className: 'dshmw-snapinput',
                  type: 'text',
                  placeholder: '快照备注（可留空）',
                  value: snapNote,
                  autoFocus: true,
                  disabled: snapBusy,
                  onChange: (e) => setSnapNote(e.target.value),
                  onKeyDown: (e) => {
                    if (e.key === 'Enter') confirmSnapshot(id)
                    if (e.key === 'Escape') setSnapId(null)
                  },
                }),
                React.createElement('button', {
                  type: 'button', className: 'dshmw-snapbtn', disabled: snapBusy,
                  onClick: () => confirmSnapshot(id),
                }, snapBusy ? '快照中…' : '存快照'),
                React.createElement('button', {
                  type: 'button', className: 'dshmw-snapbtn', disabled: snapBusy,
                  onClick: () => setSnapId(null),
                }, '取消')) : null)
          })) : null)
    }

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

    // ---- panel entry ----
    function MockPanel(props) {
      if (props.panelId && props.activePanelId !== props.panelId) return null

      const sessions = props.useSessions ? props.useSessions((s) => s) : undefined
      const [showForm, setShowForm] = React.useState(false)
      const [showSettings, setShowSettings] = React.useState(false)
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

      // 启动 Hub：走 Host mock.start-hub（nohup 后台拉起，独立于 dsh 常驻）。
      // 由面板打开时的自动拉起与头部「后台服务」状态灯点击共同触发。
      const [hubStarting, setHubStarting] = React.useState(false)
      const [hubStartError, setHubStartError] = React.useState(null)
      const startHub = React.useCallback(() => {
        if (hubStarting) return
        setHubStarting(true)
        setHubStartError(null)
        callHost('mock.start-hub', { dshApi: location.origin })
          .then(() => { pingHub(); setTimeout(pingHub, 2000) })
          .catch((err) => setHubStartError(err && err.message ? String(err.message) : String(err)))
          .finally(() => setHubStarting(false))
      }, [hubStarting, pingHub])

      const hubOnline = hub !== null && hub.online === true
      // 打开面板即自动拉起后台服务：探测到离线时启动一次，失败不循环
      // （点头部「后台服务」状态灯可手动重试）；恢复在线后允许再次自动拉起。
      const hubAutoStarted = React.useRef(false)
      React.useEffect(() => {
        if (hubOnline) { hubAutoStarted.current = false; return }
        if (hubAutoStarted.current || hub === null || hubStarting) return
        hubAutoStarted.current = true
        startHub()
      }, [hub, hubOnline, hubStarting, startHub])

      const openHub = React.useCallback(() => {
        // 打开「用例结果」悬浮窗（shell.overlay）：任何界面可用（含新建会话页，
        // 那里没有会话头部 Tab）。数据直连 Hub JSON API，不加载 Hub 管理页前端。
        toggleCasesPanel()
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
        // 翻页时保留旧页，避免列表瞬间收缩导致外层侧栏滚回顶部。
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

      const sessionsById = (sessions && sessions.byId) || {}
      const current = sessions && sessions.current
      const workspaceService = ctx.get('workspaces')
      const workspaceSnapshot = workspaceService && workspaceService.list && typeof workspaceService.list.getSnapshot === 'function'
        ? workspaceService.list.getSnapshot()
        : null
      const archivedSessionIds = new Set((workspaceSnapshot && workspaceSnapshot.archivedSessionIds) || [])
      const visibleBatches = batches === null ? null : batches.flatMap((batch) => {
        if (batch.meta && batch.meta.status === 'archived') return []
        const sessionIds = (batch.sessionIds || []).filter((id) => {
          if (!sessions) return !archivedSessionIds.has(id)
          const session = sessionsById[id]
          return session !== undefined && session.blank !== true && !archivedSessionIds.has(id)
        })
        return sessionIds.length > 0 ? [{ batch, sessionIds }] : []
      })

      const header = React.createElement('div', { className: 'dshmw-header' },
        React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 } },
          React.createElement('span', { className: 'dshmw-title' }, 'Mock 实验场'),
          // 后台服务状态灯：绿=在线 / 红=离线（点击启动）/ 琥珀=启动中 / 灰=探测中。
          React.createElement('button', {
            type: 'button',
            className: 'dshmw-hubstatus',
            title: '后台服务 ' + (hub === null ? '探测中…'
              : hubOnline ? '在线 · ' + HUB_URL
              : hubStarting ? '启动中…'
              : (hubStartError ? '启动失败：' + hubStartError + ' · 点击重试' : '未在线 · 点击启动')),
            onClick: () => { if (!hubOnline && !hubStarting) startHub() },
          },
            React.createElement('span', {
              className: 'dshmw-hubdot' + (hubOnline ? ' online' : hubStarting ? ' starting' : hub !== null ? ' offline' : ''),
            }),
            '后台服务')),
        React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 2 } },
          React.createElement('button', {
            type: 'button',
            className: 'dshmw-headbtn',
            disabled: !hubOnline,
            title: hubOnline ? '打开后台服务页面' : '后台服务未在线',
            'aria-label': '打开后台服务页面',
            onClick: (e) => openHubPageMenu(e),
          }, React.createElement(SvgIcon, { d: ICONS.share, size: 15 })),
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
          }, React.createElement(SvgIcon, { d: ICONS.refresh, size: 15 }))))

      // ---- 卡片② 实验批次（批次 = 会话分组，轨迹 = 会话日志） ----
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
      } else if (visibleBatches !== null && visibleBatches.length === 0 && !error) {
        batchBody.push(React.createElement('div', { key: 'empty', className: 'dshmw-empty' },
          React.createElement('div', null, '还没有包含会话的批次'),
          React.createElement('div', { className: 'dshmw-hint' },
            '点卡片右上角「+ 新建」：输入一个名字，会创建独立的工作区目录并打开一个普通对话会话，轨迹与产物都会留在这个实验场里。')))
      } else if (visibleBatches !== null) {
        visibleBatches.forEach(({ batch, sessionIds }) => {
          batchBody.push(React.createElement(BatchRow, {
            key: batch.batchId || batch.path,
            batch,
            sessionIds,
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

      // ---- 卡片③ 用例库（benchmark prompts：导入 / 标签筛选 / 浏览） ----
      const libBody = []
      const currentSet = Array.isArray(libSets) ? libSets.find((s) => s.id === libSetId) : null
      if (!hubOnlineForLib) {
        libBody.push(React.createElement('div', { key: 'offline', className: 'dshmw-hint', style: { padding: '2px 6px 6px', marginTop: 0 } },
          '用例库由后台服务承载，等待服务上线（也可点顶部「后台服务」状态灯手动启动）'))
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
            let msg = '导入完成'
            const attN = v && typeof v.attached === 'number' ? v.attached : 0
            const missN = v && typeof v.missingFiles === 'number' ? v.missingFiles : 0
            if (attN > 0 || missN > 0) msg += '：附件 ' + attN + ' 个' + (missN > 0 ? '，缺失 ' + missN + ' 个' : '')
            showCtxToast(msg)
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
            className: 'dshmw-select dshmw-libset-select',
            style: { flex: '1 1 0' },
            value: libSetId,
            onChange: (e) => { setLibSetId(e.target.value); setLibTag(''); setLibConfirmDelete(false); setLibPage(1) },
          }, libSets.map((s) => {
            const name = String(s.name || s.id)
            const shortName = name.length > 12 ? name.slice(0, 10) + '…' : name
            return React.createElement('option', { key: s.id, value: s.id, title: name }, shortName + ' · ' + s.count)
          })),
          topTags.length > 0
            ? React.createElement('select', {
                className: 'dshmw-select',
                style: { flex: '1 1 0', minWidth: 0 },
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
            libData.cases.map((c) => React.createElement(LibCaseRow, { key: c.id, c, onMenu: openCaseMenu }))))
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

      // ---- 卡片① 产物托管（artifact-hub 产物清单，点击直达） ----
      // 服务状态收敛到面板头部的「后台服务」状态灯，卡片内只保留产物内容。
      const hubBody = []
      const [collapsedArts, setCollapsedArts] = React.useState({})
      // 产物点击的本地态：artPending 启动中（防重复点击），artError 启动失败原因。
      const [artPending, setArtPending] = React.useState({})
      const [artError, setArtError] = React.useState({})
      // 生成参数筛选（模型 / Agent / Skill 版本 / 测试集 / 用例）与悬浮窗锚点。
      const [artFilter, setArtFilter] = React.useState({ model: '', agent: '', skill: '', set: '', case: '' })
      const [artPop, setArtPop] = React.useState(null)
      // 点产物卡片：有 URL 直接打开；无 URL（未运行的 dev 产物）交给 Hub 启动
      // （install + dev server，Hub 同步等就绪），拿到 runtime.url 后打开。
      const openArtifact = (a) => {
        const direct = artifactUrl(a)
        if (direct) { openInBuiltinBrowser(direct); return }
        if (artPending[a.id]) return
        setArtPending((prev) => ({ ...prev, [a.id]: true }))
        setArtError((prev) => ({ ...prev, [a.id]: null }))
        fetch(HUB_URL + 'api/artifacts/start', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: a.id }),
        })
          .then((res) => (res.ok ? res.json() : Promise.reject(new Error('HTTP ' + res.status))))
          .then((msg) => {
            const v = msg && msg.value
            if (msg && msg.ok === true && v && v.url) {
              openInBuiltinBrowser(v.url)
              pingHub()
            } else {
              setArtError((prev) => ({ ...prev, [a.id]: (v && v.error) || '启动失败' }))
            }
          })
          .catch((err) => setArtError((prev) => ({ ...prev, [a.id]: err && err.message ? String(err.message) : String(err) })))
          .finally(() => setArtPending((prev) => ({ ...prev, [a.id]: false })))
      }
      if (!hubOnline) {
        hubBody.push(React.createElement('div', { key: 'hint', className: 'dshmw-hint', style: { padding: '2px 6px 6px', marginTop: 0 } },
          hubStartError !== null
            ? '后台服务启动失败：' + hubStartError + '（点顶部「后台服务」状态灯重试，或手动：node artifact-hub/server.mjs）'
            : hub === null ? '正在探测后台服务…' : '正在启动后台服务…'))
      } else {
        const hubBatches = hub.batches || []
        const total = hubBatches.reduce((n, b) => n + ((b.artifacts || []).length), 0)
        if (total === 0) {
          hubBody.push(React.createElement('div', { key: 'none', className: 'dshmw-hint', style: { padding: '0 6px 6px', marginTop: 0 } },
            'runs/ 下未扫描到产物（index.html / package.json / artifact.json）'))
        } else {
          // 生成参数：Hub 已合并产物级 artifact.json gen 与批次 meta.gen。
          const artGenOf = (a) => (a && a.gen && typeof a.gen === 'object' ? a.gen : {})
          const artMetaOf = (a) => (a && a.meta && typeof a.meta === 'object' ? a.meta : {})
          const allArts = hubBatches.flatMap((b) => b.artifacts || [])
          const genValues = (key) => [...new Set(allArts.map((a) => artGenOf(a)[key])
            .filter((v) => typeof v === 'string' && v !== ''))].sort()
          const setNameOf = (id) => {
            const s = Array.isArray(libSets) ? libSets.find((x) => x && x.id === id) : null
            return s && typeof s.name === 'string' && s.name !== '' ? s.name : id
          }
          // 五个筛选维度：模型 / Agent / Skill 版本（预设版本戳）/ 测试集 / 用例。
          // 用例值取 caseId（缺失退回 sourceRef），标签带测试集名便于辨认。
          const dimOptions = {
            model: genValues('model'),
            agent: genValues('agent'),
            skill: genValues('agentVersion'),
            set: [...new Set(allArts.map((a) => artMetaOf(a).caseSetId)
              .filter((v) => typeof v === 'string' && v !== ''))].sort(),
            case: [...new Set(allArts.map((a) => {
              const m = artMetaOf(a)
              const cid = typeof m.caseId === 'string' ? m.caseId : ''
              const ref = typeof m.sourceRef === 'string' ? m.sourceRef : ''
              return cid !== '' ? cid : ref
            }).filter((v) => v !== ''))].sort(),
          }
          const dimLabel = (k, v) => {
            if (k === 'set') return setNameOf(v)
            if (k === 'case') {
              const a = allArts.find((x) => {
                const m = artMetaOf(x)
                return (typeof m.caseId === 'string' && m.caseId !== '' ? m.caseId
                  : (typeof m.sourceRef === 'string' ? m.sourceRef : '')) === v
              })
              const m = artMetaOf(a || {})
              const ref = typeof m.sourceRef === 'string' && m.sourceRef !== '' ? m.sourceRef : v
              const setId = typeof m.caseSetId === 'string' ? m.caseSetId : ''
              return (setId !== '' ? setNameOf(setId) + ' · ' : '') + ref
            }
            return v
          }
          const artFiltering = Object.keys(dimOptions).some((k) => (artFilter[k] || '') !== '')
          const matchArt = (a) => {
            const g = artGenOf(a)
            const m = artMetaOf(a)
            if (artFilter.model !== '' && g.model !== artFilter.model) return false
            if (artFilter.agent !== '' && g.agent !== artFilter.agent) return false
            if ((artFilter.skill || '') !== '' && g.agentVersion !== artFilter.skill) return false
            if ((artFilter.set || '') !== '' && m.caseSetId !== artFilter.set) return false
            if ((artFilter.case || '') !== '') {
              const cid = typeof m.caseId === 'string' ? m.caseId : ''
              const ref = typeof m.sourceRef === 'string' ? m.sourceRef : ''
              if ((cid !== '' ? cid : ref) !== artFilter.case) return false
            }
            return true
          }
          // 筛选条：任一维度有可选值即出现；未记录的产物在任何
          // 具体筛选值下都不匹配。
          const dims = [
            ['model', '全部模型'], ['agent', '全部 Agent'], ['skill', '全部 Skill 版本'],
            ['set', '全部测试集'], ['case', '全部用例'],
          ]
          if (dims.some(([k]) => dimOptions[k].length > 0)) {
            hubBody.push(React.createElement('div', { key: 'artfilter', className: 'dshmw-artfilter' },
              dims.map(([k, placeholder]) => dimOptions[k].length === 0 ? null :
                React.createElement('select', {
                  key: k,
                  className: 'dshmw-select',
                  value: artFilter[k] || '',
                  title: placeholder,
                  onChange: (e) => setArtFilter((prev) => ({ ...prev, [k]: e.target.value })),
                }, [React.createElement('option', { key: '', value: '' }, placeholder)].concat(
                  dimOptions[k].map((v) => React.createElement('option', { key: v, value: v }, dimLabel(k, v))))))))
          }
          // 相同用例的产物合并成一组：按批次 meta 的 caseSetId+sourceRef/caseId
          // （缺失退回批次名）归并；组标题可点击折叠/展开。
          const artGroups = []
          const artGroupIndex = new Map()
          hubBatches.forEach((b) => {
            const arts = (b.artifacts || []).filter((a) => !artFiltering || matchArt(a))
            if (arts.length === 0) return
            const m = (arts[0] && arts[0].meta) || {}
            const key = (m.caseSetId || m.caseId)
              ? String(m.caseSetId || '') + '·' + String(m.sourceRef || m.caseId)
              : String(b.name || b.batchId)
            let g = artGroupIndex.get(key)
            if (!g) {
              g = { key, name: b.name || b.batchId, arts: [] }
              artGroupIndex.set(key, g)
              artGroups.push(g)
            }
            arts.forEach((a) => g.arts.push(a))
          })
          if (artGroups.length === 0) {
            hubBody.push(React.createElement('div', { key: 'nomatch', className: 'dshmw-hint', style: { padding: '0 6px 6px', marginTop: 0 } },
              '没有符合筛选条件的产物'))
          }
          artGroups.forEach((g) => {
            const closed = collapsedArts[g.key] === true
            hubBody.push(React.createElement('button', {
              key: 'g-' + g.key,
              type: 'button',
              className: 'dshmw-artgroup' + (closed ? ' dshmw-artgroup-closed' : ''),
              title: g.name,
              onClick: () => setCollapsedArts((prev) => ({ ...prev, [g.key]: !prev[g.key] })),
            },
              React.createElement('span', { className: 'dshmw-chev' },
                React.createElement(SvgIcon, { d: ICONS.chevron, size: 9 })),
              React.createElement('span', { className: 'dshmw-artgrouptitle' },
                g.name + ' · ' + g.arts.length + ' 产物')))
            if (closed) return
            // 产物卡片：缩略预览直接渲染页面（缩放 iframe，指针穿透，点击卡片打开）。
            hubBody.push(React.createElement('div', { key: 'grid-' + g.key, className: 'dshmw-artgrid' },
              g.arts.map((a) => {
                const st = a.runtime && typeof a.runtime.status === 'string' ? a.runtime.status : 'stopped'
                const url = artifactUrl(a)
                const pending = artPending[a.id] === true
                const err = artError[a.id]
                const dot = pending ? 'starting' : (err ? 'failed' : st)
                const live = Boolean(a.runtime && a.runtime.url)
                const thumbUrl = typeof a.thumbUrl === 'string' && a.thumbUrl !== '' ? HUB_URL + a.thumbUrl.replace(/^\//, '') : ''
                return React.createElement('button', {
                  key: a.id,
                  type: 'button',
                  className: 'dshmw-artcard',
                  onMouseEnter: (e) => {
                    const r = e.currentTarget.getBoundingClientRect()
                    setArtPop({ id: a.id, left: r.left, top: r.top, width: r.width, height: r.height })
                  },
                  onMouseLeave: () => setArtPop((prev) => (prev !== null && prev.id === a.id ? null : prev)),
                  onClick: () => openArtifact(a),
                },
                  React.createElement('div', { className: 'dshmw-artthumb' },
                    React.createElement(ArtThumb, { live, url, thumbUrl })),
                  React.createElement('div', { className: 'dshmw-artmeta' },
                    React.createElement('span', { className: 'dshmw-dot ' + dot }),
                    React.createElement('span', { className: 'dshmw-artname' }, a.name || a.id),
                    React.createElement('span', { className: 'dshmw-kind' }, a.kind)))
                })))
          })
          // 生成参数悬浮窗：fixed 定位（卡片 overflow:hidden 会裁剪内部绝对
          // 定位元素），pointer-events:none 随鼠标移出即消失。
          if (artPop !== null) {
            const pa = allArts.find((x) => x.id === artPop.id)
            if (pa) {
              const pgen = artGenOf(pa)
              const purl = artifactUrl(pa)
              const ppending = artPending[pa.id] === true
              const perr = artError[pa.id]
              const popRow = (k, v) => React.createElement('div', { key: k, className: 'dshmw-artpoprow' },
                React.createElement('span', { className: 'dshmw-artpopk' }, k),
                React.createElement('span', { className: 'dshmw-artpopv', title: v }, v))
              const vw = typeof window !== 'undefined' ? window.innerWidth : 1200
              const vh = typeof window !== 'undefined' ? window.innerHeight : 800
              // 优先放卡片右侧；右侧空间不足（面板贴右边缘）时翻到左侧。
              // 垂直方向顶对齐卡片，底边不出视口。
              const popStyle = { top: Math.max(8, Math.min(artPop.top, vh - 170)) }
              if (artPop.left + artPop.width + 6 + 230 <= vw - 8) popStyle.left = artPop.left + artPop.width + 6
              else popStyle.left = Math.max(8, artPop.left - 236)
              hubBody.push(React.createElement('div', { key: 'artpop', className: 'dshmw-artpop', style: popStyle },
                React.createElement('div', { className: 'dshmw-artpopname' }, pa.name || pa.id),
                popRow('模型', typeof pgen.model === 'string' && pgen.model !== '' ? pgen.model : '未记录'),
                popRow('Agent', typeof pgen.agent === 'string' && pgen.agent !== '' ? pgen.agent : '未记录'),
                typeof pgen.agentVersion === 'string' && pgen.agentVersion !== ''
                  ? popRow('Skill 版本', pgen.agentVersion) : null,
                popRow('类型', String(pa.kind || '')),
                pa.runtime && pa.runtime.url ? popRow('地址', String(pa.runtime.url)) : null,
                React.createElement('div', { className: 'dshmw-artpophint' },
                  ppending ? '正在启动…'
                    : perr ? '启动失败：' + perr
                    : purl === '' ? '点击启动并打开'
                    : pa.id)))
            }
          }
        }
      }

      const hubCard = React.createElement(MockCard, {
        icon: ICONS.globe,
        title: '产物托管',
        actions: React.createElement('button', {
          type: 'button',
          className: 'dshmw-cardbtn',
          title: hubOnline ? '打开「用例结果」悬浮窗（任何界面可用，可拖动）' : '后台服务未在线，上线后可打开「用例结果」',
          onClick: () => openHub(),
        },
          React.createElement(SvgIcon, { d: ICONS.globe, size: 11 }),
          '打开'),
      }, hubBody)

      const workspaceView = props.workspaceView || 'all'
      return React.createElement('div', { className: 'dshmw-root' + (workspaceView === 'all' ? '' : ' dshmw-root-workspace') }, header,
        showSettings ? React.createElement(SettingsForm, {
          key: 'settings',
          rootPath,
          onSaved: (res) => {
            setShowSettings(false)
            if (res && typeof res.rootPath === 'string') setRootPath(res.rootPath)
            setReloadKey((k) => k + 1)
          },
        }) : null,
        workspaceView === 'all' ? hubCard : null,
        workspaceView === 'all' || workspaceView === 'sessions' ? batchCard : null,
        workspaceView === 'all' || workspaceView === 'cases' ? libCard : null,
        (workspaceView === 'all' || workspaceView === 'sessions') && rootPath
          ? React.createElement('div', { className: 'dshmw-rootpath', title: rootPath }, '根: ' + rootPath)
          : null)
    }

    // ---- 「用例结果」视图（悬浮窗内容）：双栏布局 ----
    // 左栏：有归档结果的用例列表（垂直滚动，按最近归档倒序）；点用例 → 右栏
    // 展示该用例的归档历史（一条历史一行）；点某一条 → 在内置浏览器弹出那次归档
    // 的具体页面并收起悬浮窗。「轨迹」在右栏行内展开执行时间线。数据直连 Hub
    // JSON API（/api/iterations 驱动 + /api/library/cases?ids=… 取原始信息）。
    function CasesResultView(props) {
      const [hub, setHub] = React.useState(null)             // null 探测中 | { online, batches }
      const [sets, setSets] = React.useState([])             // 用例集（取名称用）
      const [iterations, setIterations] = React.useState([])
      const [archived, setArchived] = React.useState(null)   // null 未算 | { ids[], map<id,{count,latest,caseSetId}> }
      const [caseIndex, setCaseIndex] = React.useState(null) // null 加载中 | Map<id, case>
      const [selectedId, setSelectedId] = React.useState(null)
      const [openPrompt, setOpenPrompt] = React.useState({}) // caseId → true（展开 prompt）
      const [trajSessionId, setTrajSessionId] = React.useState(null) // 非空 → 右栏全屏展示该会话的轨迹
      const [trajCache, setTrajCache] = React.useState({})    // sessionId → { status, entries?, error? }
      const [openTool, setOpenTool] = React.useState({})      // `${sessionId}|${callId}` → true（工具参数/结果）
      const [starting, setStarting] = React.useState(false)
      const [startError, setStartError] = React.useState(null)
      const [confirmDeleteArchiveId, setConfirmDeleteArchiveId] = React.useState(null)
      // 左栏筛选：搜索串（prompt/编号/标签/测试集名）+ 测试集 + Skill 版本
      const [caseQuery, setCaseQuery] = React.useState('')
      const [caseSetFilter, setCaseSetFilter] = React.useState('')
      const [caseVerFilter, setCaseVerFilter] = React.useState('')

      const errMsg = (err) => (err && err.message ? String(err.message) : String(err))

      const refresh = React.useCallback(() => {
        hubApi('state', { cache: 'no-store' })
          .then((v) => setHub({ online: true, batches: Array.isArray(v.batches) ? v.batches : [] }))
          .catch(() => setHub({ online: false, batches: [] }))
        hubApi('iterations', { cache: 'no-store' })
          .then((v) => setIterations(Array.isArray(v.entries) ? v.entries : []))
          .catch(() => setIterations([]))
      }, [])

      React.useEffect(() => {
        refresh()
        const timer = setInterval(refresh, 5000)
        return () => clearInterval(timer)
      }, [refresh])

      // 用例集名称（卡片 set 徽标用）；库为空时给出导入提示
      React.useEffect(() => {
        if (hub === null || hub.online !== true) { setSets([]); return }
        hubApi('library/sets', { cache: 'no-store' })
          .then((v) => setSets(Array.isArray(v.sets) ? v.sets : []))
          .catch(() => setSets([]))
      }, [hub])

      // 归档 → 按 caseId 聚合（计数 + 最近归档时间），ids 按最近倒序
      React.useEffect(() => {
        const map = new Map()
        for (const e of iterations) {
          const id = e.caseId || ''
          if (!id) continue
          const cur = map.get(id)
          if (!cur) map.set(id, { count: 1, latest: e.archivedAt || '', caseSetId: e.caseSetId || '' })
          else {
            cur.count += 1
            if (e.archivedAt && e.archivedAt > cur.latest) cur.latest = e.archivedAt
          }
        }
        const ids = [...map.keys()].sort((a, b) => {
          const la = map.get(a).latest
          const lb = map.get(b).latest
          return la < lb ? 1 : la > lb ? -1 : 0
        })
        setArchived({ ids, map })
      }, [iterations])

      // 按归档 id 集从用例库拉取用例（仅 id 集合变化时重拉）
      const archivedKey = archived ? archived.ids.join('\u0001') : ''
      React.useEffect(() => {
        if (hub === null || hub.online !== true || archived === null) { setCaseIndex(null); return }
        if (archived.ids.length === 0) { setCaseIndex(new Map()); return }
        let alive = true
        const load = async () => {
          const out = []
          for (let i = 0; i < archived.ids.length; i += 200) {
            const chunk = archived.ids.slice(i, i + 200)
            try {
              const v = await hubApi('library/cases?ids=' + chunk.map(encodeURIComponent).join(',') + '&limit=200', { cache: 'no-store' })
              if (Array.isArray(v.cases)) out.push(...v.cases)
            } catch (e) { /* 单批失败跳过 */ }
          }
          if (alive) setCaseIndex(new Map(out.map((c) => [c.id, c])))
        }
        load()
        return () => { alive = false }
      }, [hub, archivedKey])

      const startHub = () => {
        if (starting) return
        setStarting(true)
        setStartError(null)
        callHost('mock.start-hub', { dshApi: location.origin })
          .then(() => { refresh(); setTimeout(refresh, 2000) })
          .catch((err) => setStartError(errMsg(err)))
          .finally(() => setStarting(false))
      }

      const online = hub !== null && hub.online === true
      const setNames = new Map(sets.map((s) => [s.id, s.name || s.id]))

      // 用例列表：归档驱动，按最近倒序；库中缺失的归档计为孤儿
      let orphanCount = 0
      const cards = []
      if (archived && caseIndex) {
        for (const id of archived.ids) {
          const c = caseIndex.get(id)
          const a = archived.map.get(id)
          if (!c) { orphanCount += a ? a.count : 0; continue }
          cards.push({ case: c, count: a ? a.count : 0, latest: a ? a.latest : '', caseSetId: a ? a.caseSetId : '' })
        }
      }
      const cardsKey = cards.map((c) => c.case.id).join('\u0001')
      // 筛选维度：搜索（prompt / 编号 / 标签 / 测试集名）+ 测试集 + Skill 版本。
      // 版本来自归档 record.json 冻结的 gen.agentVersion（仅功能上线后的新归档有，
      // 旧归档无 gen，选中具体版本时不匹配）。
      const versByCase = new Map()
      for (const e of iterations) {
        const v = e.gen && typeof e.gen.agentVersion === 'string' ? e.gen.agentVersion : ''
        if (v === '' || typeof e.caseId !== 'string' || e.caseId === '') continue
        if (!versByCase.has(e.caseId)) versByCase.set(e.caseId, new Set())
        versByCase.get(e.caseId).add(v)
      }
      const verOptions = [...new Set([...versByCase.values()].flatMap((s) => [...s]))].sort()
      const setOptions = [...new Set(cards.map((c) => c.caseSetId)
        .filter((v) => typeof v === 'string' && v !== ''))].sort()
      const caseQueryNorm = caseQuery.trim().toLowerCase()
      const caseFiltering = caseQueryNorm !== '' || caseSetFilter !== '' || caseVerFilter !== ''
      const matchCaseCard = ({ case: c, caseSetId }) => {
        if (caseSetFilter !== '' && caseSetId !== caseSetFilter) return false
        if (caseVerFilter !== '' && !(versByCase.get(c.id) || new Set()).has(caseVerFilter)) return false
        if (caseQueryNorm !== '') {
          const hay = [c.prompt, c.sourceRef, c.id, setNames.get(caseSetId) || caseSetId]
            .concat(Array.isArray(c.tags) ? c.tags : []).join('\n').toLowerCase()
          if (!hay.includes(caseQueryNorm)) return false
        }
        return true
      }
      const viewCards = caseFiltering ? cards.filter(matchCaseCard) : cards
      const viewKey = viewCards.map((c) => c.case.id).join('\u0001')
      // 默认选中筛选后最近归档的用例
      React.useEffect(() => {
        if (viewCards.length === 0) { setSelectedId(null); return }
        setSelectedId((cur) => (viewCards.some((c) => c.case.id === cur) ? cur : viewCards[0].case.id))
      }, [viewKey])

      const selCard = viewCards.find((c) => c.case.id === selectedId) || viewCards[0] || null

      // 归档按 caseId 聚合（时间倒序，供右栏历史记录）
      const iterByCase = new Map()
      for (const e of iterations) {
        const key = e.caseId || ''
        if (!iterByCase.has(key)) iterByCase.set(key, [])
        iterByCase.get(key).push(e)
      }

      const togglePrompt = (id) => setOpenPrompt((o) => { const n = { ...o }; n[id] = !o[id]; return n })
      const toggleTool = (key) => setOpenTool((o) => { const n = { ...o }; n[key] = !o[key]; return n })
      // 打开轨迹：右栏全屏展示该会话的执行轨迹；未缓存则拉取。
      const openTrajectory = (sessionId) => {
        setTrajSessionId(sessionId)
        if (trajCache[sessionId]) return
        setTrajCache((c) => ({ ...c, [sessionId]: { status: 'loading' } }))
        hubApi('trajectory/events?sessionId=' + encodeURIComponent(sessionId), { cache: 'no-store' })
          .then((v) => setTrajCache((c) => ({ ...c, [sessionId]: { status: 'ok', entries: Array.isArray(v.entries) ? v.entries : [] } })))
          .catch((err) => setTrajCache((c) => ({ ...c, [sessionId]: { status: 'err', error: errMsg(err) } })))
      }
      // 打开快照：内置浏览器（复用同一预览 Tab）+ 收起悬浮窗
      const openSnapshot = (url) => { setCasesPanelOpen(false); openInBuiltinBrowser(url) }

      // 内联轨迹时间线（复用 Hub /api/trajectory/events 的简化条目）
      const trajItem = (sessionId, e, idx) => {
        const time = fmtTime(e.time)
        switch (e.kind) {
          case 'turn-start':
            return React.createElement('div', { key: 't' + idx, className: 'dshmw-traj-turn' }, 'Turn ' + (e.turn ?? '?') + ' 开始')
          case 'turn-end':
            return React.createElement('div', { key: 't' + idx, className: 'dshmw-traj-turn' }, 'Turn ' + (e.turn ?? '?') + ' 结束' + (e.reason ? ' · ' + e.reason : ''))
          case 'user':
            return React.createElement('div', { key: 't' + idx, className: 'dshmw-traj-item' },
              React.createElement('div', { className: 'dshmw-traj-meta' }, '👤 用户', React.createElement('span', null, time)),
              React.createElement('div', { className: 'dshmw-traj-text' }, e.text || ''))
          case 'assistant': {
            const kids = [React.createElement('div', { key: 'm', className: 'dshmw-traj-meta' }, '🤖 Assistant', React.createElement('span', null, time))]
            if (e.text) kids.push(React.createElement('div', { key: 't', className: 'dshmw-traj-text' }, e.text))
            if (e.reasoning) kids.push(React.createElement('details', { key: 'r', className: 'dshmw-traj-details' },
              React.createElement('summary', null, '思考过程'),
              React.createElement('div', { className: 'dshmw-traj-detail' }, e.reasoning)))
            return React.createElement('div', { key: 't' + idx, className: 'dshmw-traj-item' }, kids)
          }
          case 'tool': {
            const dkey = sessionId + '|' + (e.callId || idx)
            const open = openTool[dkey] === true
            const stateText = e.done ? (e.resultError ? '✗ 失败' : '✓') : '…'
            return React.createElement('div', { key: 't' + idx, className: 'dshmw-traj-item' },
              React.createElement('div', { className: 'dshmw-traj-meta' },
                React.createElement('span', { className: 'dshmw-traj-name' }, e.name || 'tool'),
                e.title ? React.createElement('span', null, e.title) : null,
                React.createElement('span', null, stateText),
                React.createElement('span', null, time)),
              React.createElement('button', { type: 'button', className: 'dshmw-traj-toggle', onClick: () => toggleTool(dkey) },
                open ? '收起' : '参数 / 结果'),
              open ? React.createElement('div', { className: 'dshmw-traj-detail' },
                (e.args ? '参数：\n' + e.args + '\n' : '') + (e.resultText ? '结果：\n' + e.resultText : '')) : null)
          }
          default:
            return null
        }
      }
      const trajPanel = (sessionId) => {
        const t = trajCache[sessionId]
        if (!t || t.status === 'loading') return React.createElement('div', { className: 'dshmw-hint', style: { margin: 0 } }, '加载轨迹…')
        if (t.status === 'err') return React.createElement('div', { className: 'dshmw-hint', style: { margin: 0 } }, '轨迹加载失败：' + t.error)
        if (t.entries.length === 0) return React.createElement('div', { className: 'dshmw-hint', style: { margin: 0 } }, '会话暂无轨迹事件')
        return React.createElement('div', { className: 'dshmw-traj dshmw-traj-full' }, t.entries.map((e, i) => trajItem(sessionId, e, i)))
      }

      // 左栏：用例列表（筛选后）
      const leftItems = viewCards.map(({ case: c, count, latest, caseSetId }) => {
        const sel = selCard !== null && c.id === selCard.case.id
        const tags = Array.isArray(c.tags) ? c.tags : []
        return React.createElement('button', {
          key: c.id,
          type: 'button',
          className: 'dshmw-caseitem' + (sel ? ' sel' : ''),
          title: c.prompt || '',
          onClick: () => { setSelectedId(c.id); setTrajSessionId(null) },
        },
          React.createElement('span', { className: 'dshmw-caseitem-ref' }, c.sourceRef || c.id),
          React.createElement('span', { className: 'dshmw-caseitem-badges' },
            React.createElement('span', { className: 'dshmw-casebadge', title: caseSetId }, setNames.get(caseSetId) || caseSetId || '—'),
            React.createElement('span', { className: 'dshmw-casebadge', title: latest ? '最近归档 ' + fmtDateTime(latest) : '' }, count + ' 次归档'),
            tags.slice(0, 3).map((t) => React.createElement('span', { key: t, className: 'dshmw-casetag' }, t))),
          React.createElement('span', { className: 'dshmw-caseitem-prompt' }, c.prompt || '（无 prompt）'))
      })

      // 右栏：历史记录，或选中会话的轨迹全屏视图（带「← 返回」）
      let rightBody = null
      if (trajSessionId && selCard) {
        rightBody = [
          React.createElement('div', { key: 'bar', className: 'dshmw-trajbar' },
            React.createElement('button', {
              type: 'button',
              className: 'dshmw-iter-link',
              title: '返回历史记录',
              onClick: () => setTrajSessionId(null),
            }, '← 返回'),
            React.createElement('span', { className: 'dshmw-trajtitle' }, '执行轨迹'),
            React.createElement('span', { className: 'dshmw-hint', style: { margin: 0 } }, '会话 ' + String(trajSessionId).slice(0, 12))),
          React.createElement('div', { key: 'panel', className: 'dshmw-cases-right-inner' }, trajPanel(trajSessionId)),
        ]
      } else if (selCard) {
        const c = selCard.case
        const hits = iterByCase.get(c.id) || []
        const tags = Array.isArray(c.tags) ? c.tags : []
        const promptOpen = openPrompt[c.id] === true
        const rows = hits.map((e) => {
          const ts = String(e.archiveId || '').split('/')[1] || ''
          const snaps = (e.artifacts || []).filter((a) => a.snapshotDir).map((a) => {
            const entry = a.entryFile && a.entryFile !== 'index.html' ? encodeURIComponent(a.entryFile) : ''
            const url = HUB_URL + 'archive/' + encodeURIComponent(e.batchId) + '/' + encodeURIComponent(ts) + '/' + encodeURIComponent(a.snapshotDir) + '/' + entry
            return { url, label: a.name || a.snapshotDir }
          })
          const primary = snaps[0] || null
          const archiveKey = e.archiveId || (e.batchId + '|' + e.sessionId)
          const confirmingDelete = confirmDeleteArchiveId === archiveKey
          return React.createElement('article', {
            key: archiveKey,
            className: 'dshmw-hit-card' + (primary ? ' clickable' : ''),
          },
            React.createElement('div', {
              className: 'dshmw-hit-preview',
              role: primary ? 'button' : undefined,
              tabIndex: primary ? 0 : undefined,
              title: primary ? '点击打开完整页面' : '该次归档无快照',
              onClick: () => { if (primary) openSnapshot(primary.url) },
              onKeyDown: (ev) => { if (primary && (ev.key === 'Enter' || ev.key === ' ')) { ev.preventDefault(); openSnapshot(primary.url) } },
            },
              primary
                ? React.createElement('iframe', { src: primary.url, title: '归档页面预览：' + primary.label, loading: 'lazy', tabIndex: -1 })
                : React.createElement('div', { className: 'dshmw-hit-preview-empty' },
                    React.createElement('span', { className: 'dshmw-hit-preview-icon' }, '◇'),
                    React.createElement('span', null, '本次归档没有页面快照')),
              primary ? React.createElement('span', { className: 'dshmw-hit-preview-badge' }, '点击查看完整页面') : null),
            React.createElement('div', { className: 'dshmw-hit-cardbody' },
              React.createElement('div', { className: 'dshmw-hit-cardtop' },
                React.createElement('span', { className: 'dshmw-hit-cardtitle', title: e.batchId }, e.batchName || e.batchId),
                React.createElement('span', { className: 'dshmw-hit-links' },
                snaps.length
                  ? snaps.map((s) => React.createElement('button', {
                      key: s.label,
                      type: 'button',
                      className: 'dshmw-iter-link',
                      title: s.url,
                      onClick: (ev) => { ev.stopPropagation(); openSnapshot(s.url) },
                    }, '预览·' + s.label))
                  : React.createElement('span', { className: 'dshmw-hint', style: { margin: 0 } }, '无快照'),
                React.createElement('button', {
                  type: 'button',
                  className: 'dshmw-iter-link',
                  title: '右栏全屏展示该会话的执行轨迹',
                  onClick: (ev) => { ev.stopPropagation(); openTrajectory(e.sessionId) },
                }, '轨迹'),
                !primary ? React.createElement('button', {
                  type: 'button',
                  className: confirmingDelete ? 'dshmw-iter-link dshmw-iter-link-danger' : 'dshmw-iter-link',
                  title: confirmingDelete ? '再次点击确认删除这条无快照归档' : '删除这条无快照归档记录',
                  onClick: (ev) => {
                    ev.stopPropagation()
                    if (!confirmingDelete) { setConfirmDeleteArchiveId(archiveKey); return }
                    deleteIteration(e.archiveId).then(() => {
                      setConfirmDeleteArchiveId(null)
                      setIterations((items) => items.filter((item) => item.archiveId !== e.archiveId))
                    }).catch((err) => showCtxToast('删除失败：' + errMsg(err)))
                  },
                }, confirmingDelete ? '确认删除' : '删除') : null)),
              React.createElement('div', { className: 'dshmw-hit-cardmeta' },
                e.kind === 'snapshot'
                  ? React.createElement('span', { className: 'dshmw-casebadge', title: e.sourceSessionId ? '快照自会话 ' + e.sourceSessionId : '会话快照' }, '快照')
                  : null,
                e.kind === 'snapshot' && e.note
                  ? React.createElement('span', { className: 'dshmw-hit-date', title: e.note }, e.note)
                  : null,
                React.createElement('span', { className: 'dshmw-hit-date', title: e.archivedAt || '' }, fmtDateTime(e.archivedAt)),
                React.createElement('span', { className: 'dshmw-hit-sess', title: '会话 ' + e.sessionId }, String(e.sessionId || '').slice(0, 12)))))
        })
        rightBody = [
          React.createElement('div', { key: 'head', className: 'dshmw-case-detailhead' },
            React.createElement('div', { className: 'dshmw-case-detailtitle' },
              React.createElement('span', { className: 'dshmw-case-detailref', title: c.id }, c.sourceRef || c.id),
              React.createElement('span', { className: 'dshmw-casebadge', title: selCard.caseSetId }, setNames.get(selCard.caseSetId) || selCard.caseSetId || '—'),
              React.createElement('span', { className: 'dshmw-casebadge' }, selCard.count + ' 次归档')),
            tags.length > 0
              ? React.createElement('div', { className: 'dshmw-casetags' },
                  tags.map((t) => React.createElement('span', { key: t, className: 'dshmw-casetag' }, t)))
              : null,
            React.createElement('div', {
              className: 'dshmw-caseprompt' + (promptOpen ? ' open' : ''),
              title: promptOpen ? '收起' : '展开 prompt 全文',
              onClick: () => togglePrompt(c.id),
            }, c.prompt || '（无 prompt）')),
          React.createElement('div', { key: 'sec', className: 'dshmw-case-detailsec' }, '历史会话记录',
            React.createElement('span', { className: 'dshmw-casessec-count' }, '· ' + hits.length + ' 条')),
          ...(rows.length > 0 ? rows : [React.createElement('div', { key: 'empty', className: 'dshmw-hint', style: { margin: 0 } }, '该用例暂无归档记录。')])]
      }

      const archivedCount = archived ? archived.ids.length : 0
      const loadingCases = archived !== null && archived.ids.length > 0 && caseIndex === null

      return React.createElement('div', { className: 'dshmw-cases' },
        React.createElement('div', { className: 'dshmw-caseshead' },
          React.createElement('span', { className: 'dshmw-hubdot' + (online ? ' online' : '') }),
          React.createElement('span', { className: 'dshmw-casestitle' }, '用例结果'),
          React.createElement('span', { className: 'dshmw-casesstatus' }, hub === null ? '探测中' : online ? 'Hub 在线' : 'Hub 未启动'),
          React.createElement('span', { className: 'dshmw-casespag', style: { marginLeft: 'auto' } },
            archivedCount > 0 ? '有归档结果：' + (caseFiltering ? viewCards.length + '/' : '') + cards.length + ' 个用例' : ''),
          !online && hub !== null
            ? React.createElement('button', {
                type: 'button', className: 'dshmw-cardbtn', disabled: starting,
                title: '拉起 artifact-hub/server.mjs（后台进程，独立于 dsh 常驻）',
                onClick: startHub,
              }, starting ? '启动中…' : '启动 Hub')
            : React.createElement('button', {
                type: 'button', className: 'dshmw-cardbtn', title: '刷新', onClick: refresh,
              }, '刷新'),
        ),
        startError !== null ? React.createElement('div', { className: 'dshmw-error' }, '启动失败：' + startError) : null,
        !online && hub !== null
          ? React.createElement('div', { className: 'dshmw-hint', style: { marginTop: 0 } },
              '产物托管 Hub 未启动，用例结果不可用。点「启动 Hub」一键拉起，或手动：node artifact-hub/server.mjs（日志 artifact-hub/hub.log）。')
          : null,
        online && sets.length === 0 && archivedCount === 0
          ? React.createElement('div', { className: 'dshmw-hint', style: { marginTop: 0 } },
              '还没有用例集。到 Mock 实验场「用例库」卡片点「导入」，把 benchmark 数据集（CSV / JSONL / JSON）归一化为 prompt 用例集。')
          : null,
        online && archived !== null && archivedCount === 0
          ? React.createElement('div', { className: 'dshmw-hint', style: { marginTop: 0 } },
              '还没有归档结果。在 dsh Mock 实验场的批次会话上点「归档」按钮（产物快照 + 会话记录，含用例 ID / 日期），归档后这里会出现对应用例卡片。')
          : null,
        online && loadingCases
          ? React.createElement('div', { className: 'dshmw-hint', style: { marginTop: 0 } }, '加载用例…')
          : null,
        online && archived !== null && caseIndex !== null && cards.length === 0 && archivedCount > 0
          ? React.createElement('div', { className: 'dshmw-hint', style: { marginTop: 0 } },
              orphanCount > 0
                ? '归档记录未匹配到用例库用例（' + orphanCount + ' 条，对应用例可能已从用例集删除）。'
                : '没有可显示的归档用例。')
          : null,
        online && cards.length > 0
          ? React.createElement('div', { key: 'casefilter', className: 'dshmw-casesfilterbar' },
              React.createElement('input', {
                className: 'dshmw-casesfilter',
                value: caseQuery,
                placeholder: '搜索用例：prompt / 编号 / 标签…',
                title: '按 prompt 全文、用例编号、测试集名、标签过滤左栏用例',
                onChange: (e) => setCaseQuery(e.target.value),
              }),
              setOptions.length > 0
                ? React.createElement('select', {
                    className: 'dshmw-select', value: caseSetFilter, title: '按测试集筛选',
                    onChange: (e) => setCaseSetFilter(e.target.value),
                  }, [React.createElement('option', { key: '', value: '' }, '全部测试集')].concat(
                    setOptions.map((v) => React.createElement('option', { key: v, value: v }, setNames.get(v) || v))))
                : null,
              verOptions.length > 0
                ? React.createElement('select', {
                    className: 'dshmw-select', value: caseVerFilter, title: '按 Skill 版本筛选（仅功能上线后的新归档记录了版本）',
                    onChange: (e) => setCaseVerFilter(e.target.value),
                  }, [React.createElement('option', { key: '', value: '' }, '全部 Skill 版本')].concat(
                    verOptions.map((v) => React.createElement('option', { key: v, value: v }, v))))
                : null)
          : null,
        online && cards.length > 0 && viewCards.length === 0
          ? React.createElement('div', { key: 'nocasematch', className: 'dshmw-hint', style: { marginTop: 0 } },
              '没有符合筛选条件的用例')
          : null,
        online && viewCards.length > 0
          ? React.createElement('div', { key: 'cols', className: 'dshmw-cases-cols' },
              React.createElement('div', { className: 'dshmw-cases-left' }, leftItems),
              React.createElement('div', { className: 'dshmw-cases-right' }, rightBody))
          : null,
        online && cards.length > 0 && orphanCount > 0
          ? React.createElement('div', { className: 'dshmw-hint', style: { marginTop: 0 } },
              '另有 ' + orphanCount + ' 条归档记录未匹配用例库（对应用例可能已删除）。')
          : null)
    }

    // ---- Mock 工作台（shell.overlay）：用例 / 会话记录 / 结果 ----
    let casesPanelOpen = false
    const casesPanelListeners = new Set()
    function setCasesPanelOpen(open) {
      casesPanelOpen = !!open
      for (const l of casesPanelListeners) { try { l() } catch (e) { /* ignore */ } }
    }
    function toggleCasesPanel() { setCasesPanelOpen(!casesPanelOpen) }

    function CasesOverlayPanel(props) {
      const [open, setOpen] = React.useState(casesPanelOpen)
      const [tab, setTab] = React.useState('results')
      React.useEffect(() => {
        const l = () => setOpen(casesPanelOpen)
        casesPanelListeners.add(l)
        return () => casesPanelListeners.delete(l)
      }, [])
      React.useEffect(() => {
        if (!open || typeof document === 'undefined') return
        const onKey = (e) => { if (e.key === 'Escape') setCasesPanelOpen(false) }
        document.addEventListener('keydown', onKey)
        return () => document.removeEventListener('keydown', onKey)
      }, [open])
      const launcher = React.createElement('div', { className: 'dshmw-launcher' },
        React.createElement('button', {
          type: 'button',
          className: 'dshmw-launcherbtn' + (open ? ' active' : ''),
          title: 'Mock 实验场',
          'aria-label': 'Mock 实验场',
          'aria-pressed': open,
          onClick: toggleCasesPanel,
        }, React.createElement(SvgIcon, { d: ICONS.beaker, size: 16 })))
      if (!open) return launcher
      const tabs = [['cases', '用例'], ['sessions', '会话记录'], ['results', '结果']]
      return React.createElement(React.Fragment, null,
        React.createElement('div', {
          className: 'dshmw-workspacebackdrop',
          onMouseDown: (e) => { if (e.target === e.currentTarget) setCasesPanelOpen(false) },
        }),
        React.createElement('div', { className: 'dshmw-casesoverlay', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Mock 实验场' },
        React.createElement('div', { className: 'dshmw-casesoverlay-bar' },
          React.createElement('span', { className: 'dshmw-casesoverlay-title' }, 'Mock 实验场'),
          React.createElement('div', { className: 'dshmw-workspacetabs', role: 'tablist', 'aria-label': '实验场视图' },
            tabs.map((item) => React.createElement('button', {
              key: item[0],
              type: 'button',
              role: 'tab',
              className: 'dshmw-workspacetab' + (tab === item[0] ? ' active' : ''),
              'aria-selected': tab === item[0],
              onClick: () => setTab(item[0]),
            }, item[1]))),
          React.createElement('button', {
            type: 'button',
            className: 'dshmw-headbtn',
            title: '关闭',
            'aria-label': '关闭 Mock 实验场',
            onClick: () => setCasesPanelOpen(false),
          }, '✕')),
        React.createElement('div', { className: 'dshmw-casesoverlay-body' },
          tab === 'results'
            ? React.createElement(CasesResultView, null)
            : React.createElement(MockPanel, { workspaceView: tab, useSessions: props.useSessions }))),
        launcher)
    }

    // ---- registrations: 等 shell 声明槽位后纯增量注册 ----
    ctx.effect(() => {
      const disposers = [disposeCss, disposeCtxUI]
      // 右上角入口 + 大尺寸 Tab 工作台，任何界面可用。
      disposers.push(slots.inject('shell.overlay', () => slots.register(
        { name: 'shell.overlay', id: 'mock-cases', order: 20, label: () => 'Mock 实验场' },
        CasesOverlayPanel,
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
