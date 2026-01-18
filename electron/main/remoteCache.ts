import { app } from 'electron'
import path from 'node:path'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'

interface CacheEntry {
  connectionId: string
  remotePath: string
  localPath: string
  updatedAt: number
}

const CACHE_DIR = 'remote-cache'
const CACHE_MAP_FILE = 'remote-cache-map.json'

let cacheLoaded = false
const cacheMap = new Map<string, CacheEntry>()
let writeQueue: Promise<void> = Promise.resolve()

function cacheMapPath() {
  return path.join(app.getPath('userData'), CACHE_MAP_FILE)
}

function normalizeLocalPath(localPath: string) {
  return path.resolve(localPath)
}

function ensureLoaded() {
  if (cacheLoaded) return
  cacheLoaded = true
  try {
    const raw = fsSync.readFileSync(cacheMapPath(), 'utf8')
    const parsed = JSON.parse(raw)
    const entries = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.entries) ? parsed.entries : []
    for (const entry of entries) {
      if (!entry?.localPath || !entry?.remotePath || !entry?.connectionId) continue
      const normalized = normalizeLocalPath(entry.localPath)
      cacheMap.set(normalized, {
        connectionId: String(entry.connectionId),
        remotePath: String(entry.remotePath),
        localPath: normalized,
        updatedAt: Number(entry.updatedAt) || Date.now(),
      })
    }
  } catch {
    // ignore cache load errors
  }
}

async function persistCache() {
  const entries = Array.from(cacheMap.values())
  const payload = JSON.stringify({ entries }, null, 2)
  await fs.mkdir(path.dirname(cacheMapPath()), { recursive: true })
  await fs.writeFile(cacheMapPath(), payload, 'utf8')
}

function queuePersist() {
  writeQueue = writeQueue.then(() => persistCache()).catch(() => undefined)
  return writeQueue
}

export async function initRemoteCache() {
  ensureLoaded()
}

export function getCacheRoot(connectionId: string) {
  return path.join(app.getPath('userData'), CACHE_DIR, connectionId)
}

export async function ensureCacheRoot(connectionId: string) {
  await fs.mkdir(getCacheRoot(connectionId), { recursive: true })
}

export function getCachedLocalPath(connectionId: string, remoteRoot: string, remotePath: string) {
  const normalizedRemote = remotePath.replace(/\\/g, '/')
  const relative = path.posix.relative(remoteRoot, normalizedRemote)
  const cacheRoot = getCacheRoot(connectionId)
  if (!relative || relative.startsWith('..')) {
    const safeName = normalizedRemote.replace(/[\\/]/g, '_')
    return path.join(cacheRoot, '_outside', safeName)
  }
  return path.join(cacheRoot, ...relative.split('/'))
}

export function recordCacheEntry(connectionId: string, remotePath: string, localPath: string) {
  ensureLoaded()
  const normalized = normalizeLocalPath(localPath)
  cacheMap.set(normalized, {
    connectionId,
    remotePath,
    localPath: normalized,
    updatedAt: Date.now(),
  })
  void queuePersist()
}

export function getCacheEntry(localPath: string) {
  ensureLoaded()
  return cacheMap.get(normalizeLocalPath(localPath)) ?? null
}

export function resolveRemotePathFromCache(connectionId: string, localPath: string) {
  const entry = getCacheEntry(localPath)
  if (!entry) return null
  if (entry.connectionId !== connectionId) return null
  return entry.remotePath
}

export async function clearRemoteCache(connectionId: string) {
  ensureLoaded()
  const normalizedEntries = Array.from(cacheMap.entries())
  for (const [localPath, entry] of normalizedEntries) {
    if (entry.connectionId === connectionId) {
      cacheMap.delete(localPath)
    }
  }
  const root = getCacheRoot(connectionId)
  try {
    await fs.rm(root, { recursive: true, force: true })
  } catch {
    // ignore cache deletion errors
  }
  await queuePersist()
}
