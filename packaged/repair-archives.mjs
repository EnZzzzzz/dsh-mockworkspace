// Rebuild explicitly selected failed archives, preserving the original record and snapshots.
// Usage: node packaged/repair-archives.mjs /absolute/path/to/record.json [...]
import { readFile, writeFile, copyFile, rename, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { collectArchiveArtifacts, relocateArchiveAssets } from './src/archive.js'

for (const arg of process.argv.slice(2)) {
  const recordPath = resolve(arg)
  const record = JSON.parse(await readFile(recordPath, 'utf8'))
  const archiveDir = dirname(recordPath)
  const mockRoot = resolve(archiveDir, '../../../..')
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const staging = join(archiveDir, '.repair-' + stamp)
  console.log('Repairing', record.caseId, record.archiveId)
  try {
    const result = await collectArchiveArtifacts(join(mockRoot, 'runs', record.batchId), staging)
    if (!result.artifacts.length || result.builds.some((b) => !b.ok)) {
      await writeFile(join(archiveDir, 'repair-failure-' + stamp + '.json'), JSON.stringify(result, null, 2))
      console.log('FAILED', JSON.stringify(result.builds))
      process.exitCode = 1
      continue
    }
    // New directory names keep existing previews and thumbnails intact until record commit.
    for (const artifact of result.artifacts) {
      const newName = artifact.snapshotDir + '-repair-' + stamp
      await rename(join(staging, artifact.snapshotDir), join(archiveDir, newName))
      artifact.snapshotDir = newName
      await relocateArchiveAssets(join(archiveDir, newName),
        '/archive/' + [...record.archiveId.split('/'), newName].map(encodeURIComponent).join('/'))
    }
    await copyFile(recordPath, join(archiveDir, 'record.before-repair-' + stamp + '.json'))
    const repaired = { ...record, ...result, repairedAt: new Date().toISOString(),
      repair: { source: 'current-batch-files', previousArtifacts: record.artifacts, previousBuilds: record.builds } }
    await writeFile(join(archiveDir, 'record.repair.tmp'), JSON.stringify(repaired, null, 2))
    await rename(join(archiveDir, 'record.repair.tmp'), recordPath)
    console.log('REPAIRED', record.caseId, JSON.stringify(result.artifacts))
  } catch (err) {
    console.error('FAILED', record.caseId, err)
    process.exitCode = 1
  } finally { await rm(staging, { recursive: true, force: true }) }
}
