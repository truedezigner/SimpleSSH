import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import path from 'node:path'
import { Client, SFTPWrapper } from 'ssh2'
import { Connection } from './connectionsStore'

export interface FileNode {
  name: string
  path: string
  type: 'file' | 'dir'
  size?: number
  children?: FileNode[]
}

interface RemoteCacheEntry {
  nodes: FileNode[]
  fetchedAt: number
  lastAccess: number
}

const REMOTE_CACHE_MAX_ENTRIES = 800
const DEFAULT_PIN_THRESHOLD = 3
const DEFAULT_PINNED_MAX_ENTRIES = 200
const remoteCache = new Map<string, RemoteCacheEntry>()
const remoteAccessCounts = new Map<string, number>()
const remotePinned = new Set<string>()
const remoteIndexState = new Map<string, Promise<void>>()
const remoteIndexedConnections = new Set<string>()

function clearRemoteCache(connection: Connection) {
  const prefix = `${connection.id}:`
  for (const key of remoteCache.keys()) {
    if (key.startsWith(prefix)) remoteCache.delete(key)
  }
  for (const key of remoteAccessCounts.keys()) {
    if (key.startsWith(prefix)) remoteAccessCounts.delete(key)
  }
  for (const key of remotePinned) {
    if (key.startsWith(prefix)) remotePinned.delete(key)
  }
}

export async function listLocalTree(root: string, depth = 2): Promise<FileNode[]> {
  if (!root) return []
  try {
    const entries = await fs.readdir(root, { withFileTypes: true })
    const nodes = await Promise.all(entries.map(async (entry) => {
      const fullPath = path.join(root, entry.name)
      if (entry.isDirectory()) {
        const children = depth > 1 ? await listLocalTree(fullPath, depth - 1) : []
        return { name: entry.name, path: fullPath, type: 'dir', children }
      }
      if (entry.isFile()) {
        const stat = await fs.stat(fullPath)
        return { name: entry.name, path: fullPath, type: 'file', size: stat.size }
      }
      return null
    }))
    return nodes.filter((node): node is FileNode => Boolean(node))
  } catch {
    return []
  }
}

async function ensureDir(target: string) {
  await fs.mkdir(target, { recursive: true })
}

function remoteJoin(...parts: string[]) {
  return path.posix.join(...parts)
}

function cacheKey(connection: Connection, remotePath: string) {
  return `${connection.id}:${remotePath}`
}

function getCachedDir(connection: Connection, remotePath: string) {
  const entry = remoteCache.get(cacheKey(connection, remotePath))
  if (!entry) return null
  return { entry }
}

function setCachedDir(connection: Connection, remotePath: string, nodes: FileNode[]) {
  const key = cacheKey(connection, remotePath)
  const now = Date.now()
  const existing = remoteCache.get(key)
  remoteCache.set(key, {
    nodes,
    fetchedAt: now,
    lastAccess: existing?.lastAccess ?? now,
  })
  evictCacheEntries()
}

function updateCachedDirByDiff(connection: Connection, remotePath: string, nodes: FileNode[]) {
  const key = cacheKey(connection, remotePath)
  const existing = remoteCache.get(key)
  if (!existing) {
    setCachedDir(connection, remotePath, nodes)
    return
  }
  const currentByPath = new Map(existing.nodes.map((node) => [node.path, node]))
  const merged: FileNode[] = nodes.map((next) => {
    const prior = currentByPath.get(next.path)
    if (prior && prior.type === next.type && prior.size === next.size) {
      return prior
    }
    return next
  })
  remoteCache.set(key, {
    nodes: merged,
    fetchedAt: Date.now(),
    lastAccess: existing.lastAccess,
  })
  evictCacheEntries()
}

function markAccess(connection: Connection, remotePath: string) {
  const key = cacheKey(connection, remotePath)
  const next = (remoteAccessCounts.get(key) ?? 0) + 1
  remoteAccessCounts.set(key, next)
  const threshold =
    typeof connection.remotePinThreshold === 'number' && !Number.isNaN(connection.remotePinThreshold)
      ? Math.max(1, connection.remotePinThreshold)
      : DEFAULT_PIN_THRESHOLD
  if (next >= threshold) {
    remotePinned.add(key)
    enforcePinnedLimit(connection)
  }
}

function enforcePinnedLimit(connection: Connection) {
  const maxEntries =
    typeof connection.remotePinnedMaxEntries === 'number' && !Number.isNaN(connection.remotePinnedMaxEntries)
      ? Math.max(0, connection.remotePinnedMaxEntries)
      : DEFAULT_PINNED_MAX_ENTRIES
  if (maxEntries <= 0) return
  const prefix = `${connection.id}:`
  const pinnedForConnection = Array.from(remotePinned).filter((key) => key.startsWith(prefix))
  while (pinnedForConnection.length > maxEntries) {
    let candidateIndex = -1
    let candidateAccess = Infinity
    for (let i = 0; i < pinnedForConnection.length; i += 1) {
      const key = pinnedForConnection[i]
      const entry = remoteCache.get(key)
      const lastAccess = entry?.lastAccess ?? 0
      if (lastAccess < candidateAccess) {
        candidateAccess = lastAccess
        candidateIndex = i
      }
    }
    if (candidateIndex < 0) break
    const [candidateKey] = pinnedForConnection.splice(candidateIndex, 1)
    if (candidateKey) remotePinned.delete(candidateKey)
  }
}

function evictCacheEntries() {
  while (remoteCache.size > REMOTE_CACHE_MAX_ENTRIES) {
    let candidateKey: string | null = null
    let candidateAccess = Infinity
    for (const [key, entry] of remoteCache.entries()) {
      if (remotePinned.has(key)) continue
      if (entry.lastAccess < candidateAccess) {
        candidateAccess = entry.lastAccess
        candidateKey = key
      }
    }
    if (!candidateKey) {
      for (const [key, entry] of remoteCache.entries()) {
        if (entry.lastAccess < candidateAccess) {
          candidateAccess = entry.lastAccess
          candidateKey = key
        }
      }
      if (!candidateKey) break
      remotePinned.delete(candidateKey)
    }
    const timer = remoteRefreshTimers.get(candidateKey)
    if (timer) {
      clearTimeout(timer)
      remoteRefreshTimers.delete(candidateKey)
    }
    remoteCache.delete(candidateKey)
  }
}

function readDir(sftp: SFTPWrapper, remotePath: string) {
  return new Promise<SFTPWrapper.FileEntry[]>((resolve, reject) => {
    sftp.readdir(remotePath, (err, list) => {
      if (err) reject(err)
      else resolve(list)
    })
  })
}

async function fetchRemoteDir(
  connection: Connection,
  auth: { password?: string; privateKey?: string; passphrase?: string },
  remotePath: string,
) {
  return withSftp(connection, auth, async (sftp) => {
    const entries = await readDir(sftp, remotePath)
    return entries.map((entry) => ({
      name: entry.filename,
      path: remoteJoin(remotePath, entry.filename),
      type: entry.attrs.isDirectory() ? 'dir' : 'file',
      size: entry.attrs.size,
    })) as FileNode[]
  })
}

async function indexRemoteTree(
  connection: Connection,
  auth: { password?: string; privateKey?: string; passphrase?: string },
  options?: {
    onProgress?: (path: string) => void
    onEmpty?: (path: string) => void
    onError?: (path: string, error: unknown) => void
  },
) {
  const shouldLog = Boolean(options?.onProgress || options?.onEmpty || options?.onError)
  if (shouldLog) {
    console.log(`[remote-index] indexing ${connection.remoteRoot}`)
  }
  const connectionKey = connection.id
  if (remoteIndexedConnections.has(connectionKey)) return
  if (remoteIndexState.has(connectionKey)) return
  const run = withSftp(connection, auth, async (sftp) => {
    const queue: string[] = [connection.remoteRoot]
    while (queue.length > 0) {
      const current = queue.shift()
      if (!current) continue
      try {
        options?.onProgress?.(current)
        const entries = await readDir(sftp, current)
        if (shouldLog) {
          console.log(`[remote-index] listed ${current} (${entries.length})`)
        }
        if (entries.length === 0) {
          options?.onEmpty?.(current)
        }
        const nodes = entries.map((entry) => ({
          name: entry.filename,
          path: remoteJoin(current, entry.filename),
          type: entry.attrs.isDirectory() ? 'dir' : 'file',
          size: entry.attrs.size,
        })) as FileNode[]
        setCachedDir(connection, current, nodes)
        for (const entry of entries) {
          const entryPath = remoteJoin(current, entry.filename)
          options?.onProgress?.(entryPath)
          if (entry.attrs.isDirectory()) {
            queue.push(entryPath)
          }
        }
      } catch (error) {
        if (shouldLog) {
          const detail = error instanceof Error ? error.message : 'unknown error'
          console.log(`[remote-index] error ${current} (${detail})`)
        }
        options?.onError?.(current, error)
        // skip paths that fail during initial index
      }
    }
  })
    .then(() => {
      remoteIndexState.delete(connectionKey)
      remoteIndexedConnections.add(connectionKey)
    })
    .catch(() => {
      remoteIndexState.delete(connectionKey)
    })
  remoteIndexState.set(connectionKey, run)
  await run
}

export async function rebuildRemoteIndex(
  connection: Connection,
  auth: { password?: string; privateKey?: string; passphrase?: string },
  options?: {
    onProgress?: (path: string) => void
    onEmpty?: (path: string) => void
    onError?: (path: string, error: unknown) => void
  },
) {
  const shouldLog = Boolean(options?.onProgress || options?.onEmpty || options?.onError)
  if (shouldLog) {
    console.log(`[remote-index] rebuild start ${connection.id}`)
  }
  const connectionKey = connection.id
  const current = remoteIndexState.get(connectionKey)
  if (current) {
    if (shouldLog) {
      console.log(`[remote-index] waiting on existing index ${connectionKey}`)
    }
    let timedOut = false
    try {
      await Promise.race([
        current.catch(() => undefined),
        new Promise<void>((resolve) => {
          setTimeout(() => {
            timedOut = true
            resolve()
          }, 2000)
        }),
      ])
    } catch {
      // ignore prior index errors
    }
    if (timedOut && shouldLog) {
      console.log(`[remote-index] existing index timeout, forcing rebuild ${connectionKey}`)
    }
  }
  remoteIndexState.delete(connectionKey)
  remoteIndexedConnections.delete(connectionKey)
  clearRemoteCache(connection)
  if (shouldLog) {
    console.log(`[remote-index] starting fresh index ${connection.remoteRoot}`)
  }
  await indexRemoteTree(connection, auth, options)
  if (shouldLog) {
    console.log(`[remote-index] rebuild complete ${connection.id}`)
  }
}


async function downloadFile(sftp: SFTPWrapper, remoteFile: string, localFile: string) {
  await ensureDir(path.dirname(localFile))
  return new Promise<void>((resolve, reject) => {
    const readStream = sftp.createReadStream(remoteFile)
    const writeStream = fsSync.createWriteStream(localFile)
    readStream.on('error', reject)
    writeStream.on('error', reject)
    writeStream.on('close', () => resolve())
    readStream.pipe(writeStream)
  })
}

async function downloadDirectory(sftp: SFTPWrapper, remoteDir: string, localDir: string) {
  await ensureDir(localDir)
  const entries = await new Promise<SFTPWrapper.FileEntry[]>((resolve, reject) => {
    sftp.readdir(remoteDir, (err, list) => {
      if (err) reject(err)
      else resolve(list)
    })
  })

  for (const entry of entries) {
    const remotePath = remoteJoin(remoteDir, entry.filename)
    const localPath = path.join(localDir, entry.filename)
    if (entry.attrs.isDirectory()) {
      await downloadDirectory(sftp, remotePath, localPath)
    } else {
      await downloadFile(sftp, remotePath, localPath)
    }
  }
}

export async function syncRemoteToLocal(
  connection: Connection,
  auth: { password?: string; privateKey?: string; passphrase?: string },
) {
  return new Promise<void>((resolve, reject) => {
    const client = new Client()
    const cleanup = () => {
      client.removeAllListeners()
      client.end()
    }

    client
      .on('ready', () => {
        client.sftp(async (err, sftp) => {
          if (err) {
            cleanup()
            reject(err)
            return
          }
          try {
            await downloadDirectory(sftp, connection.remoteRoot, connection.localRoot)
            cleanup()
            resolve()
          } catch (error) {
            cleanup()
            reject(error)
          }
        })
      })
      .on('error', (error) => {
        cleanup()
        reject(error)
      })
      .connect({
        host: connection.host,
        port: connection.port,
        username: connection.username,
        password: auth.password,
        privateKey: auth.privateKey,
        passphrase: auth.passphrase,
        readyTimeout: 15000,
      })
  })
}

function withSftp<T>(
  connection: Connection,
  auth: { password?: string; privateKey?: string; passphrase?: string },
  run: (sftp: SFTPWrapper) => Promise<T>,
) {
  return new Promise<T>((resolve, reject) => {
    const client = new Client()
    const cleanup = () => {
      client.removeAllListeners()
      client.end()
    }

    client
      .on('ready', () => {
        client.sftp(async (err, sftp) => {
          if (err) {
            cleanup()
            reject(err)
            return
          }
          try {
            const result = await run(sftp)
            cleanup()
            resolve(result)
          } catch (error) {
            cleanup()
            reject(error)
          }
        })
      })
      .on('error', (error) => {
        cleanup()
        reject(error)
      })
      .connect({
        host: connection.host,
        port: connection.port,
        username: connection.username,
        password: auth.password,
        privateKey: auth.privateKey,
        passphrase: auth.passphrase,
        readyTimeout: 15000,
      })
  })
}

function remoteRelative(root: string, target: string) {
  const relative = path.posix.relative(root, target)
  if (!relative || relative.startsWith('..')) return null
  return relative
}

export async function listRemoteDir(
  connection: Connection,
  auth: { password?: string; privateKey?: string; passphrase?: string },
  remotePath: string,
  options?: { force?: boolean },
) {
  const cached = getCachedDir(connection, remotePath)
  markAccess(connection, remotePath)
  if (options?.force) {
    const nodes = await fetchRemoteDir(connection, auth, remotePath)
    updateCachedDirByDiff(connection, remotePath, nodes)
    if (connection.remoteIndexOnConnect) {
      void indexRemoteTree(connection, auth)
    }
    return nodes
  }
  if (cached) {
    cached.entry.lastAccess = Date.now()
    return cached.entry.nodes
  }

  const nodes = await fetchRemoteDir(connection, auth, remotePath)
  setCachedDir(connection, remotePath, nodes)
  if (connection.remoteIndexOnConnect) {
    void indexRemoteTree(connection, auth)
  }
  return nodes
}

export async function downloadRemoteFile(
  connection: Connection,
  auth: { password?: string; privateKey?: string; passphrase?: string },
  remotePath: string,
) {
  const relative = remoteRelative(connection.remoteRoot, remotePath)
  if (!relative) throw new Error('Remote path is outside the connection root.')
  const localPath = path.join(connection.localRoot, ...relative.split('/'))
  await ensureDir(path.dirname(localPath))

  return withSftp(connection, auth, async (sftp) => {
    return new Promise<string>((resolve, reject) => {
      sftp.fastGet(remotePath, localPath, (err) => {
        if (err) reject(err)
        else resolve(localPath)
      })
    })
  })
}
