import { promises as fs } from 'node:fs'
import path from 'node:path'

const assetsDir = path.resolve('dist/moltbot_sandbox/assets')

const OLD_WARMUP_TEXT = 'Your agent is warming up. Please try again in a moment.'
const NEW_WARMUP_TEXT =
  'Your agent is warming up (usually about 2 minutes). We will ping you here as soon as it is ready.'
const HIGH_USAGE_TEXT = 'We are seeing high usage right now. Please try again in a few minutes.'

async function listAssetFiles(prefix) {
  const entries = await fs.readdir(assetsDir, { withFileTypes: true })
  const candidates = entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => name.startsWith(prefix) && name.endsWith('.js'))

  if (candidates.length === 0) {
    return null
  }

  const withStats = await Promise.all(
    candidates.map(async (name) => {
      const fullPath = path.join(assetsDir, name)
      const stats = await fs.stat(fullPath)
      return { name, fullPath, mtimeMs: stats.mtimeMs }
    }),
  )

  withStats.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return withStats[0]
}

async function listAllJsAssets() {
  const entries = await fs.readdir(assetsDir, { withFileTypes: true })
  const candidates = entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => name.endsWith('.js'))

  if (candidates.length === 0) {
    throw new Error(`No JS bundle assets found in ${assetsDir}`)
  }

  const withStats = await Promise.all(
    candidates.map(async (name) => {
      const fullPath = path.join(assetsDir, name)
      const stats = await fs.stat(fullPath)
      return { name, fullPath, mtimeMs: stats.mtimeMs }
    }),
  )

  withStats.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return withStats
}

function fail(message) {
  console.error(`❌ ${message}`)
  process.exit(1)
}

async function main() {
  let workerEntryFile
  let allAssets

  try {
    workerEntryFile = await listAssetFiles('worker-entry-')
    allAssets = await listAllJsAssets()
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error))
  }

  console.log('Verifying warmup strings in built bundle artifacts:')
  if (workerEntryFile) {
    console.log(`- worker entry bundle: ${workerEntryFile.name}`)
  } else {
    console.log('- worker entry bundle: (not found; scanning all assets)')
  }
  console.log(`- assets scanned: ${allAssets.length}`)

  const combined = (await Promise.all(allAssets.map((asset) => fs.readFile(asset.fullPath, 'utf8')))).join(
    '\n',
  )

  if (combined.includes(OLD_WARMUP_TEXT)) {
    fail(`Found stale warmup text in built artifacts: "${OLD_WARMUP_TEXT}"`)
  }

  if (!combined.includes(NEW_WARMUP_TEXT)) {
    fail(`Missing required warmup text in built artifacts: "${NEW_WARMUP_TEXT}"`)
  }

  if (!combined.includes(HIGH_USAGE_TEXT)) {
    fail(`Missing required high-usage fallback text in built artifacts: "${HIGH_USAGE_TEXT}"`)
  }

  console.log('✅ Warmup bundle verification passed.')
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error))
})
