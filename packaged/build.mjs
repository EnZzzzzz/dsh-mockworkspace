// dsh-mock-workspace build: produces lib/index.js (host, plain ESM) and
// lib/client.js (browser bundle in the dsh closure-factory format) without
// any toolchain — plain JS only.
//
// The client source (src/client/index.js) is a module-scope body that defines
// `apply` plus helpers and references the `React` closure symbol; the wrapper
// below binds React from the loader module table, then exports apply, exactly
// like the tsdown-built bundles (mirrors dsh-sidebar-live's build.mjs).
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const PACKAGE_ID = 'dsh-mock-workspace'

// Host half is source-verbatim (plain ESM): registers the /mock RPC channel
// over ctx.inject(['connection']).
const hostSrc = await readFile(new URL('src/index.js', import.meta.url), 'utf8')

const clientSrc = await readFile(new URL('src/client/index.js', import.meta.url), 'utf8')
const client = `window.__ModuleLoader__.load({
  id: ${JSON.stringify(PACKAGE_ID)},
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
    const React = require('react');
${clientSrc}
    // Declared service deps: the web frontend's ctx guard throws "cannot get
    // property ... without inject" on any service property access unless the
    // bundle declares them. 'slots' for slot registration; 'workspaces' /
    // 'sessions' for open/connect verbs.
    exports.inject = ['slots', 'workspaces', 'sessions'];
    exports.apply = apply;
    return module.exports;
  }
});
`

await mkdir(new URL('lib', import.meta.url), { recursive: true })
await writeFile(new URL('lib/index.js', import.meta.url), hostSrc)
await writeFile(new URL('lib/archive.js', import.meta.url), await readFile(new URL('src/archive.js', import.meta.url), 'utf8'))
await writeFile(new URL('lib/client.js', import.meta.url), client)
console.log('built lib/index.js + lib/client.js')
