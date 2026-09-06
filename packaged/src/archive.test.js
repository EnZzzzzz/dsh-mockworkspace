import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { collectArchiveArtifacts, buildEnvironment, relocateArchiveAssets } from './archive.js'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'archive-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const batch = join(root, 'batch'), dest = join(root, 'archive')
  await mkdir(batch)
  return { batch, dest }
}

test('buildable root wins over temporary HTML; source and dev output remain unchanged', async (t) => {
  const { batch, dest } = await fixture(t)
  await mkdir(join(batch, 'work'))
  await mkdir(join(batch, 'node_modules'))
  await writeFile(join(batch, 'work/page.html'), 'incomplete dev capture')
  await writeFile(join(batch, 'index.html'), 'source entry')
  await writeFile(join(batch, 'pnpm-lock.yaml'), 'lockfileVersion: 9')
  await writeFile(join(batch, 'package.json'), JSON.stringify({ scripts: { build: 'node build.cjs' } }))
  await writeFile(join(batch, 'build.cjs'), `const fs = require('node:fs'); fs.mkdirSync('dist'); fs.writeFileSync('dist/index.html', '<link rel="stylesheet" href="style.css">ready'); fs.writeFileSync('dist/style.css', 'body{color:red}')`)
  const result = await collectArchiveArtifacts(batch, dest)
  assert.equal(result.artifacts.length, 1)
  assert.equal(result.artifacts[0].kind, 'dist')
  assert.equal(result.builds[0].ok, true)
  assert.equal(await readFile(join(dest, result.artifacts[0].snapshotDir, 'style.css'), 'utf8'), 'body{color:red}')
  assert.equal(await readFile(join(batch, 'index.html'), 'utf8'), 'source entry')
  await assert.rejects(readFile(join(batch, 'dist/index.html')), { code: 'ENOENT' })
})

test('failed build never archives stale dist or temporary HTML as success', async (t) => {
  const { batch, dest } = await fixture(t)
  await mkdir(join(batch, 'node_modules'))
  await mkdir(join(batch, 'dist'))
  await writeFile(join(batch, 'dist/index.html'), 'stale')
  await writeFile(join(batch, 'package.json'), JSON.stringify({ scripts: { build: 'node -e "process.exit(7)"' } }))
  const result = await collectArchiveArtifacts(batch, dest)
  assert.equal(result.artifacts.length, 0)
  assert.equal(result.builds[0].ok, false)
  assert.equal(await readFile(join(batch, 'dist/index.html'), 'utf8'), 'stale')
})

test('static non-index entry retains local CSS and duplicate names stay distinct', async (t) => {
  const { batch, dest } = await fixture(t)
  for (const parent of ['a', 'b']) {
    const dir = join(batch, parent, 'site')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'report.html'), '<link href="style.css" rel="stylesheet">')
    await writeFile(join(dir, 'style.css'), parent)
  }
  const result = await collectArchiveArtifacts(batch, dest)
  assert.equal(result.artifacts.length, 2)
  assert.notEqual(result.artifacts[0].snapshotDir, result.artifacts[1].snapshotDir)
  assert.ok(result.artifacts.every((a) => a.entryFile === 'report.html'))
})

test('desktop environment includes user package-manager paths', () => {
  const env = buildEnvironment({ HOME: '/test-home', PATH: '/usr/bin' })
  assert.ok(env.PATH.split(':').includes('/test-home/.bun/bin'))
  assert.ok(env.PATH.split(':').includes('/test-home/.local/bin'))
})

test('relocate HTML, webpack chunks, CSS fonts and icons without changing external URLs', async (t) => {
  const { batch } = await fixture(t)
  await mkdir(join(batch, '_next'))
  await writeFile(join(batch, 'icon.svg'), '<svg/>')
  await writeFile(join(batch, 'index.html'), '<link href="/icon.svg"><script src="/_next/app.js"></script><a href="https://example.com/a">link</a>')
  await writeFile(join(batch, '_next/app.js'), 'r.p="/_next/"; fetch("//example.com/api")')
  await writeFile(join(batch, '_next/style.css'), 'src:url(/_next/font.woff2)')
  const prefix = '/archive/batch/time/site'
  await relocateArchiveAssets(batch, prefix)
  assert.equal(await readFile(join(batch, '_next/app.js'), 'utf8'), 'r.p="' + prefix + '/_next/"; fetch("//example.com/api")')
  assert.equal(await readFile(join(batch, '_next/style.css'), 'utf8'), 'src:url(' + prefix + '/_next/font.woff2)')
  const html = await readFile(join(batch, 'index.html'), 'utf8')
  assert.ok(html.includes('href="' + prefix + '/icon.svg"'))
  assert.ok(html.includes('https://example.com/a'))
  await relocateArchiveAssets(batch, prefix)
  assert.equal(await readFile(join(batch, 'index.html'), 'utf8'), html)
})
