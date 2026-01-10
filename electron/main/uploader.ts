import path from 'node:path'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import crypto from 'node:crypto'
import { Client, SFTPWrapper } from 'ssh2'
import chokidar from 'chokidar'
import PQueue from 'p-queue'
import { Connection, SyncMode } from './connectionsStore'
import { ensureCacheRoot, getCacheRoot, resolveRemotePathFromCache } from './remoteCache'

export interface QueueStatus {
  connectionId: string
  watching: boolean
  pending: number
  active: number
  processed: number
  failed: number
  lastPath?: string
  lastError?: string
  lastPhase?: 'idle' | 'uploading' | 'verifying' | 'deleting' | 'complete' | 'failed'
  recent?: QueueItem[]
}

export interface QueueItem {
  id: string
  path: string
  action: 'upload' | 'delete'
  phase: 'queued' | 'uploading' | 'verifying' | 'deleting' | 'complete' | 'failed'
  error?: string
  note?: string
  updatedAt: number
  bytesSent?: number
  bytesTotal?: number
}

interface WatchEntry {
  connection: Connection
  auth: { password?: string; privateKey?: string; passphrase?: string }
  watcher?: chokidar.FSWatcher
  cacheWatcher?: chokidar.FSWatcher
  queue: PQueue
  status: QueueStatus
  syncMode: SyncMode
  pollIntervalMs: number
  pollTimer?: NodeJS.Timeout
  pollActive: boolean
  remoteIndex: Map<string, { mtime: number; size: number }>
  suppressed: Map<string, number>
  pendingPaths: Set<string>
  recentLocalChanges: Map<string, number>
}

type StatusEmitter = (status: QueueStatus) => void

const watchers = new Map<string, WatchEntry>()
let emitStatus: StatusEmitter = () => {}
let itemCounter = 0
const SUPPRESS_TTL_MS = 2000
const LOCAL_CHANGE_TTL_MS = 20000
const DEFAULT_POLL_INTERVAL_MS = 5000
const MTIME_SKEW_MS = 1500
const QUEUE_HISTORY_MAX = 200

export function setQueueStatusEmitter(emitter: StatusEmitter) {
  emitStatus = emitter
}

function remoteJoin(...parts: string[]) {
  return path.posix.join(...parts)
}

function resolveRemoteTarget(connection: Connection, localPath: string) {
  const cachedRemote = resolveRemotePathFromCache(connection.id, localPath)
  if (cachedRemote) {
    return { remotePath: cachedRemote, source: 'cache' as const }
  }
  const relative = path.relative(connection.localRoot, localPath)
  if (!relative || relative.startsWith('..')) {
    return { remotePath: null, source: 'none' as const }
  }
  return {
    remotePath: remoteJoin(connection.remoteRoot, ...relative.split(path.sep)),
    source: 'local' as const,
  }
}

function localPathFromRemote(connection: Connection, remotePath: string) {
  const relative = path.posix.relative(connection.remoteRoot, remotePath)
  if (!relative || relative.startsWith('..')) return null
  return path.join(connection.localRoot, ...relative.split('/'))
}

function markSuppressed(entry: WatchEntry, localPath: string) {
  entry.suppressed.set(localPath, Date.now())
}

function shouldSuppress(entry: WatchEntry, localPath: string) {
  const since = entry.suppressed.get(localPath)
  if (!since) return false
  if (Date.now() - since > SUPPRESS_TTL_MS) {
    entry.suppressed.delete(localPath)
    return false
  }
  return true
}

function markLocalChange(entry: WatchEntry, localPath: string) {
  entry.recentLocalChanges.set(localPath, Date.now())
}

function hasRecentLocalChange(entry: WatchEntry, localPath: string) {
  const since = entry.recentLocalChanges.get(localPath)
  if (!since) return false
  if (Date.now() - since > LOCAL_CHANGE_TTL_MS) {
    entry.recentLocalChanges.delete(localPath)
    return false
  }
  return true
}

async function withSftp<T>(
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

async function withExec(connection: Connection, auth: { password?: string; privateKey?: string; passphrase?: string }, command: string) {
  return new Promise<string>((resolve, reject) => {
    const client = new Client()
    const cleanup = () => {
      client.removeAllListeners()
      client.end()
    }

    client
      .on('ready', () => {
        client.exec(command, (err, stream) => {
          if (err) {
            cleanup()
            reject(err)
            return
          }
          let stdout = ''
          let stderr = ''
          stream.on('data', (data: Buffer) => {
            stdout += data.toString()
          })
          stream.stderr.on('data', (data: Buffer) => {
            stderr += data.toString()
          })
          stream.on('close', (code: number | null) => {
            cleanup()
            if (code === 0) {
              resolve(stdout.trim())
            } else {
              reject(new Error(stderr.trim() || 'Remote command failed.'))
            }
          })
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

async function ensureRemoteDir(sftp: SFTPWrapper, remoteDir: string) {
  const normalized = remoteDir.replace(/\\/g, '/')
  const isAbsolute = normalized.startsWith('/')
  const parts = normalized.split('/').filter(Boolean)
  let current = isAbsolute ? '/' : ''

  for (const part of parts) {
    current = current === '/' ? `/${part}` : current ? `${current}/${part}` : part
    await new Promise<void>((resolve, reject) => {
      sftp.mkdir(current, (mkdirErr) => {
        if (!mkdirErr) {
          resolve()
          return
        }
        sftp.stat(current, (statErr, stats) => {
          if (!statErr && stats.isDirectory()) {
            resolve()
            return
          }
          reject(mkdirErr)
        })
      })
    })
  }
}

function sftpStat(sftp: SFTPWrapper, remotePath: string) {
  return new Promise<SFTPWrapper.Stats | null>((resolve) => {
    sftp.stat(remotePath, (err, stats) => {
      if (err) resolve(null)
      else resolve(stats)
    })
  })
}

async function removeRemotePath(sftp: SFTPWrapper, remotePath: string) {
  const stats = await sftpStat(sftp, remotePath)
  if (!stats) return
  if (stats.isDirectory()) {
    await removeRemoteDirectory(sftp, remotePath)
    return
  }
  await new Promise<void>((resolve, reject) => {
    sftp.unlink(remotePath, (err) => {
      if (err) reject(err)
      else resolve()
    })
  })
}

async function removeRemoteDirectory(sftp: SFTPWrapper, remoteDir: string) {
  const entries = await new Promise<SFTPWrapper.FileEntry[]>((resolve, reject) => {
    sftp.readdir(remoteDir, (err, list) => {
      if (err) reject(err)
      else resolve(list)
    })
  })

  for (const entry of entries) {
    const entryPath = remoteJoin(remoteDir, entry.filename)
    if (entry.attrs.isDirectory()) {
      await removeRemoteDirectory(sftp, entryPath)
    } else {
      await new Promise<void>((resolve, reject) => {
        sftp.unlink(entryPath, (err) => {
          if (err) reject(err)
          else resolve()
        })
      })
    }
  }

  await new Promise<void>((resolve, reject) => {
    sftp.rmdir(remoteDir, (err) => {
      if (err) reject(err)
      else resolve()
    })
  })
}

async function uploadFile(
  connection: Connection,
  auth: { password?: string; privateKey?: string; passphrase?: string },
  localPath: string,
  totalBytes: number,
  remotePath: string,
  tempPath: string,
  onProgress?: (bytesSent: number) => void,
) {
  const remoteDir = path.posix.dirname(remotePath)

  await withSftp(connection, auth, async (sftp) => {
    let lastEmit = 0
    await ensureRemoteDir(sftp, remoteDir)
    await new Promise<void>((resolve, reject) => {
      sftp.fastPut(
        localPath,
        tempPath,
        {
          step: (totalTransferred) => {
            if (!onProgress) return
            const now = Date.now()
            if (now - lastEmit < 200 && totalTransferred < totalBytes) return
            lastEmit = now
            onProgress(Math.min(totalTransferred, totalBytes))
          },
        },
        (err) => {
          if (err) {
            const detail =
              err && typeof err === 'object'
                ? JSON.stringify(err, Object.getOwnPropertyNames(err))
                : String(err)
            reject(new Error(`fastPut failed: ${detail}`))
            return
          }
          else resolve()
        },
      )
    })
    try {
      await new Promise<void>((resolve, reject) => {
        sftp.rename(tempPath, remotePath, (err) => {
          if (err) {
            const detail =
              err && typeof err === 'object'
                ? JSON.stringify(err, Object.getOwnPropertyNames(err))
                : String(err)
            reject(new Error(`rename failed: ${detail}`))
            return
          }
          else resolve()
        })
      })
    } catch (error) {
      const priorError = error instanceof Error ? error.message : String(error)
      try {
        await new Promise<void>((resolve) => {
          sftp.unlink(remotePath, () => resolve())
        })
        await new Promise<void>((resolve, reject) => {
          sftp.rename(tempPath, remotePath, (err) => {
            if (err) {
              const detail =
                err && typeof err === 'object'
                  ? JSON.stringify(err, Object.getOwnPropertyNames(err))
                  : String(err)
              reject(new Error(`rename failed after unlink: ${detail}`))
              return
            }
            else resolve()
          })
        })
        return
      } catch (retryError) {
        const detail = retryError instanceof Error ? retryError.message : String(retryError)
        try {
          await new Promise<void>((resolve, reject) => {
            sftp.fastPut(localPath, remotePath, (err) => {
              if (err) {
                const putDetail =
                  err && typeof err === 'object'
                    ? JSON.stringify(err, Object.getOwnPropertyNames(err))
                    : String(err)
                reject(new Error(`direct fastPut failed: ${putDetail}`))
                return
              }
              resolve()
            })
          })
          return
        } catch (finalError) {
          const finalDetail = finalError instanceof Error ? finalError.message : String(finalError)
          throw new Error(`${priorError}; retry failed: ${detail}; direct put failed: ${finalDetail}`)
        }
      } finally {
        await new Promise<void>((resolve) => {
          sftp.unlink(tempPath, () => resolve())
        })
      }
    }
  })
  return remotePath
}

function hashLocalFile(localPath: string) {
  return new Promise<string>((resolve, reject) => {
    const hash = crypto.createHash('sha256')
    const stream = fsSync.createReadStream(localPath)
    stream.on('error', reject)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

function hashStream(stream: NodeJS.ReadableStream) {
  return new Promise<string>((resolve, reject) => {
    const hash = crypto.createHash('sha256')
    stream.on('error', reject)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

function escapeRemotePath(remotePath: string) {
  return `'${remotePath.replace(/'/g, `'\"'\"'`)}'`
}

async function hashRemoteWithExec(
  connection: Connection,
  auth: { password?: string; privateKey?: string; passphrase?: string },
  remotePath: string,
) {
  const escaped = escapeRemotePath(remotePath)
  const candidates = [`sha256sum ${escaped}`, `shasum -a 256 ${escaped}`]
  let lastError: unknown = null

  for (const command of candidates) {
    try {
      const output = await withExec(connection, auth, command)
      const match = output.match(/[a-fA-F0-9]{64}/)
      if (!match) throw new Error('Unable to parse remote hash.')
      return match[0].toLowerCase()
    } catch (error) {
      lastError = error
    }
  }

  if (lastError) throw lastError
  throw new Error('Remote hash command unavailable.')
}

async function hashRemoteDownload(
  connection: Connection,
  auth: { password?: string; privateKey?: string; passphrase?: string },
  remotePath: string,
) {
  return withSftp(connection, auth, async (sftp) => {
    return new Promise<string>((resolve, reject) => {
      const stream = sftp.createReadStream(remotePath)
      hashStream(stream).then(resolve).catch(reject)
    })
  })
}

async function downloadRemoteFile(
  connection: Connection,
  auth: { password?: string; privateKey?: string; passphrase?: string },
  remotePath: string,
  remoteMtime?: number,
) {
  const localPath = localPathFromRemote(connection, remotePath)
  if (!localPath) return null
  await fs.mkdir(path.dirname(localPath), { recursive: true })
  await withSftp(connection, auth, async (sftp) => {
    await new Promise<void>((resolve, reject) => {
      sftp.fastGet(remotePath, localPath, (err) => {
        if (err) reject(err)
        else resolve()
      })
    })
  })
  if (typeof remoteMtime === 'number') {
    const mtime = new Date(remoteMtime * 1000)
    await fs.utimes(localPath, mtime, mtime)
  }
  return localPath
}

async function listRemoteFiles(
  sftp: SFTPWrapper,
  remoteDir: string,
  result: Map<string, { mtime: number; size: number }>,
) {
  const entries = await new Promise<SFTPWrapper.FileEntry[]>((resolve, reject) => {
    sftp.readdir(remoteDir, (err, list) => {
      if (err) reject(err)
      else resolve(list)
    })
  })

  for (const entry of entries) {
    const remotePath = remoteJoin(remoteDir, entry.filename)
    if (entry.attrs.isDirectory()) {
      await listRemoteFiles(sftp, remotePath, result)
    } else {
      result.set(remotePath, { mtime: entry.attrs.mtime, size: entry.attrs.size })
    }
  }
}

async function verifyUpload(
  connection: Connection,
  auth: { password?: string; privateKey?: string; passphrase?: string },
  localPath: string,
  remotePath: string,
) {
  const localStat = await fs.stat(localPath)
  const remoteStat = await withSftp(connection, auth, async (sftp) => {
    return new Promise<SFTPWrapper.Stats>((resolve, reject) => {
      sftp.stat(remotePath, (err, stats) => {
        if (err) reject(err)
        else resolve(stats)
      })
    })
  })

  if (remoteStat.size !== localStat.size) {
    throw new Error(`Upload verification failed (size mismatch: local ${localStat.size}B, remote ${remoteStat.size}B).`)
  }

  const localHash = await hashLocalFile(localPath)
  let remoteHash: string
  let verifyMethod: 'remote-exec' | 'download-back' = 'remote-exec'

  if (connection.verifyMode === 'download-back') {
    remoteHash = await hashRemoteDownload(connection, auth, remotePath)
    verifyMethod = 'download-back'
  } else {
    try {
      remoteHash = await hashRemoteWithExec(connection, auth, remotePath)
    } catch {
      remoteHash = await hashRemoteDownload(connection, auth, remotePath)
      verifyMethod = 'download-back'
    }
  }

  if (remoteHash !== localHash) {
    throw new Error(
      `Upload verification failed (hash mismatch: local ${localHash} remote ${remoteHash}, method ${verifyMethod}).`,
    )
  }
}

function updateStatus(entry: WatchEntry, updates: Partial<QueueStatus>) {
  entry.status = { ...entry.status, ...updates }
  emitStatus(entry.status)
}

function updateRecent(entry: WatchEntry, item: QueueItem) {
  const recent = entry.status.recent ? [...entry.status.recent] : []
  const index = recent.findIndex((existing) => existing.id === item.id)
  if (index >= 0) {
    recent[index] = item
  } else {
    recent.unshift(item)
  }
  entry.status = {
    ...entry.status,
    recent: recent.slice(0, QUEUE_HISTORY_MAX),
  }
  emitStatus(entry.status)
}

function refreshQueueCounts(entry: WatchEntry) {
  updateStatus(entry, {
    pending: entry.queue.size,
    active: entry.queue.pending,
  })
}

async function pollRemoteChanges(entry: WatchEntry) {
  if (entry.pollActive || entry.syncMode !== 'live') return
  entry.pollActive = true
  try {
    const nextIndex = new Map<string, { mtime: number; size: number }>()
    await withSftp(entry.connection, entry.auth, async (sftp) => {
      await listRemoteFiles(sftp, entry.connection.remoteRoot, nextIndex)
    })

    for (const [remotePath, info] of nextIndex.entries()) {
      const localPath = localPathFromRemote(entry.connection, remotePath)
      if (!localPath) continue
      let localStat: fsSync.Stats | null = null
      try {
        localStat = await fs.stat(localPath)
      } catch {
        localStat = null
      }

      const remoteMtimeMs = info.mtime * 1000
      if (!localStat) {
        markSuppressed(entry, localPath)
        await downloadRemoteFile(entry.connection, entry.auth, remotePath, info.mtime)
        entry.recentLocalChanges.delete(localPath)
        continue
      }

      const localMtime = localStat.mtimeMs
      const sizeMismatch = localStat.size !== info.size
      if (remoteMtimeMs > localMtime + MTIME_SKEW_MS || sizeMismatch) {
        markSuppressed(entry, localPath)
        await downloadRemoteFile(entry.connection, entry.auth, remotePath, info.mtime)
        entry.recentLocalChanges.delete(localPath)
      }
    }

    for (const remotePath of entry.remoteIndex.keys()) {
      if (nextIndex.has(remotePath)) continue
      const localPath = localPathFromRemote(entry.connection, remotePath)
      if (!localPath) continue
      if (hasRecentLocalChange(entry, localPath) || entry.pendingPaths.has(localPath)) {
        continue
      }
      try {
        markSuppressed(entry, localPath)
        await fs.rm(localPath, { force: true })
        entry.recentLocalChanges.delete(localPath)
      } catch {
        // ignore local delete errors
      }
    }

    entry.remoteIndex = nextIndex
  } catch (error) {
    updateStatus(entry, { lastError: error instanceof Error ? error.message : String(error) })
  } finally {
    entry.pollActive = false
  }
}

function startRemotePoll(entry: WatchEntry) {
  if (entry.pollTimer || entry.syncMode !== 'live') return
  entry.pollTimer = setInterval(() => {
    void pollRemoteChanges(entry)
  }, entry.pollIntervalMs)
  void pollRemoteChanges(entry)
}

function stopRemotePoll(entry: WatchEntry) {
  if (entry.pollTimer) {
    clearInterval(entry.pollTimer)
    entry.pollTimer = undefined
  }
  entry.pollActive = false
}

async function updateCacheWatcher(entry: WatchEntry) {
  if (!entry.connection.remoteFirstEditing) {
    if (entry.cacheWatcher) {
      await entry.cacheWatcher.close()
      entry.cacheWatcher = undefined
    }
    return
  }
  if (entry.cacheWatcher) return
  await ensureCacheRoot(entry.connection.id)
  const cacheRoot = getCacheRoot(entry.connection.id)
  const watcher = chokidar.watch(cacheRoot, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 250, pollInterval: 100 },
    ignored: /(^|[\\/])\.(git|svn|hg)([\\/]|$)|node_modules/,
  })
  watcher
    .on('add', (localPath) => {
      enqueueUpload(entry, localPath)
    })
    .on('change', (localPath) => {
      enqueueUpload(entry, localPath)
    })
    .on('error', (error) => {
      updateStatus(entry, { lastError: String(error) })
    })
  entry.cacheWatcher = watcher
}

async function ensureEntry(
  connection: Connection,
  auth: { password?: string; privateKey?: string; passphrase?: string },
  options: { watch: boolean; syncMode?: SyncMode; pollIntervalMs?: number },
) {
  const existing = watchers.get(connection.id)
  const syncMode = options.syncMode ?? connection.syncMode ?? 'manual'
  const intervalSec =
    typeof connection.liveSyncIntervalSec === 'number' && !Number.isNaN(connection.liveSyncIntervalSec)
      ? connection.liveSyncIntervalSec
      : null
  const pollIntervalMs = Math.max(
    1000,
    options.pollIntervalMs ?? (intervalSec ? intervalSec * 1000 : DEFAULT_POLL_INTERVAL_MS),
  )
  if (existing) {
    const previousInterval = existing.pollIntervalMs
    existing.connection = connection
    existing.auth = auth
    existing.syncMode = syncMode
    existing.pollIntervalMs = pollIntervalMs
    if (options.watch && !existing.watcher) {
      existing.status = { ...existing.status, watching: true }
      existing.watcher = chokidar.watch(connection.localRoot, {
        ignoreInitial: true,
        awaitWriteFinish: { stabilityThreshold: 250, pollInterval: 100 },
        ignored: /(^|[\\/])\.(git|svn|hg)([\\/]|$)|node_modules/,
      })
      existing.watcher
        .on('add', (localPath) => {
          if (!shouldSuppress(existing, localPath)) enqueueUpload(existing, localPath)
        })
        .on('change', (localPath) => {
          if (!shouldSuppress(existing, localPath)) enqueueUpload(existing, localPath)
        })
        .on('unlink', (localPath) => {
          if (!shouldSuppress(existing, localPath)) enqueueDelete(existing, localPath)
        })
        .on('unlinkDir', (localPath) => {
          if (!shouldSuppress(existing, localPath)) enqueueDelete(existing, localPath)
        })
        .on('error', (error) => {
          updateStatus(existing, { lastError: String(error) })
        })
    } else if (!options.watch && existing.watcher) {
      await existing.watcher.close()
      existing.watcher = undefined
      updateStatus(existing, { watching: false })
    }
    await updateCacheWatcher(existing)
    if (syncMode === 'live') {
      if (existing.pollTimer && previousInterval !== pollIntervalMs) {
        stopRemotePoll(existing)
      }
      startRemotePoll(existing)
    }
    else stopRemotePoll(existing)
    emitStatus(existing.status)
    return existing
  }

  const queue = new PQueue({ concurrency: 1 })
  const status: QueueStatus = {
    connectionId: connection.id,
    watching: options.watch,
    pending: 0,
    active: 0,
    processed: 0,
    failed: 0,
    lastPhase: 'idle',
    recent: [],
  }

  const entry: WatchEntry = {
    connection,
    auth,
    queue,
    status,
    syncMode,
    pollIntervalMs,
    pollActive: false,
    remoteIndex: new Map(),
    suppressed: new Map(),
    pendingPaths: new Set(),
    recentLocalChanges: new Map(),
  }

  await updateCacheWatcher(entry)
  if (options.watch) {
    const watcher = chokidar.watch(connection.localRoot, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 250, pollInterval: 100 },
      ignored: /(^|[\\/])\.(git|svn|hg)([\\/]|$)|node_modules/,
    })
    watcher
      .on('add', (localPath) => {
        if (!shouldSuppress(entry, localPath)) enqueueUpload(entry, localPath)
      })
      .on('change', (localPath) => {
        if (!shouldSuppress(entry, localPath)) enqueueUpload(entry, localPath)
      })
      .on('unlink', (localPath) => {
        if (!shouldSuppress(entry, localPath)) enqueueDelete(entry, localPath)
      })
      .on('unlinkDir', (localPath) => {
        if (!shouldSuppress(entry, localPath)) enqueueDelete(entry, localPath)
      })
      .on('error', (error) => {
        updateStatus(entry, { lastError: String(error) })
      })
    entry.watcher = watcher
  }

  watchers.set(connection.id, entry)
  if (syncMode === 'live') startRemotePoll(entry)
  emitStatus(status)
  return entry
}

export function getQueueStatus(connectionId: string) {
  return watchers.get(connectionId)?.status ?? null
}

export function clearQueueHistory(connectionId: string) {
  const entry = watchers.get(connectionId)
  if (!entry) return null
  entry.status = {
    ...entry.status,
    recent: [],
  }
  emitStatus(entry.status)
  return entry.status
}

export async function startWatcher(
  connection: Connection,
  auth: { password?: string; privateKey?: string; passphrase?: string },
) {
  const entry = await ensureEntry(connection, auth, { watch: true })
  return entry.status
}

export async function stopWatcher(connectionId: string) {
  const entry = watchers.get(connectionId)
  if (!entry) return null
  if (entry.watcher) {
    await entry.watcher.close()
  }
  entry.watcher = undefined
  stopRemotePoll(entry)
  if (!entry.connection.remoteFirstEditing) {
    entry.queue.clear()
    entry.status = {
      ...entry.status,
      watching: false,
      pending: 0,
      active: 0,
    }
    emitStatus(entry.status)
    if (entry.cacheWatcher) {
      await entry.cacheWatcher.close()
      entry.cacheWatcher = undefined
    }
    watchers.delete(connectionId)
  } else {
    updateStatus(entry, { watching: false })
  }
  return entry.status
}

export async function startCacheWatcher(
  connection: Connection,
  auth: { password?: string; privateKey?: string; passphrase?: string },
) {
  const entry = await ensureEntry(connection, auth, { watch: false })
  await updateCacheWatcher(entry)
  return entry.status
}

export async function updateWatchEntry(connection: Connection) {
  const entry = watchers.get(connection.id)
  if (!entry) return null
  entry.connection = connection
  await updateCacheWatcher(entry)
  return entry.status
}

export function suppressPath(connectionId: string, localPath: string) {
  const entry = watchers.get(connectionId)
  if (!entry) return false
  markSuppressed(entry, localPath)
  return true
}

export async function forceUploadFile(
  connection: Connection,
  auth: { password?: string; privateKey?: string; passphrase?: string },
  localPath: string,
) {
  const entry = await ensureEntry(connection, auth, { watch: false })
  enqueueUpload(entry, localPath, { force: true })
  refreshQueueCounts(entry)
  if (!entry.watcher) {
    void entry.queue.onIdle().then(() => {
      if (!entry.watcher) {
        watchers.delete(connection.id)
      }
    })
  }
  return entry.status
}

function enqueueUpload(entry: WatchEntry, localPath: string, options?: { force?: boolean }) {
  if (shouldSuppress(entry, localPath)) return
  markLocalChange(entry, localPath)
  entry.pendingPaths.add(localPath)
  const item: QueueItem = {
    id: `q_${Date.now()}_${itemCounter++}`,
    path: localPath,
    action: 'upload',
    phase: 'queued',
    updatedAt: Date.now(),
  }
  updateRecent(entry, item)

  entry.queue
    .add(async () => {
      refreshQueueCounts(entry)
      let stage = 'prepare'
      let debugNote = ''
      try {
        item.phase = 'uploading'
        item.updatedAt = Date.now()
        updateRecent(entry, item)
        updateStatus(entry, { lastPath: localPath, lastPhase: 'uploading', lastError: undefined })
        stage = 'stat'
        const stat = await fs.stat(localPath)
        const baseMtimeMs = stat.mtimeMs
        const baseSize = stat.size
        if (!stat.isFile()) {
          return
        }
        item.bytesTotal = stat.size
        item.bytesSent = 0
        item.updatedAt = Date.now()
        updateRecent(entry, item)
        const target = resolveRemoteTarget(entry.connection, localPath)
        const remotePath = target.remotePath
        const tempPath = remotePath ? `${remotePath}.simplessh_tmp_${Date.now()}` : null
        debugNote = remotePath
          ? `Target: ${remotePath} | Source: ${target.source} | Temp: ${tempPath}`
          : `Target: (none) | Source: ${target.source}`
        if (!remotePath) {
          item.phase = 'failed'
          item.error = 'No remote path mapping for file.'
          item.note = debugNote
          item.updatedAt = Date.now()
          updateRecent(entry, item)
          updateStatus(entry, {
            failed: entry.status.failed + 1,
            lastPath: localPath,
            lastError: item.error,
            lastPhase: 'failed',
          })
          return
        }
        if (!options?.force) {
          stage = 'remote-stat'
          const remoteStat = await withSftp(entry.connection, entry.auth, async (sftp) => {
            return sftpStat(sftp, remotePath)
          })
          if (remoteStat) {
            const remoteMtimeMs = remoteStat.mtime * 1000
            if (remoteMtimeMs > stat.mtimeMs + MTIME_SKEW_MS) {
              stage = 'pull-remote-newer'
              markSuppressed(entry, localPath)
              await downloadRemoteFile(entry.connection, entry.auth, remotePath, remoteStat.mtime)
              entry.recentLocalChanges.delete(localPath)
              item.phase = 'complete'
              item.note = 'Remote won: remote newer; pulled instead.'
              item.updatedAt = Date.now()
              updateRecent(entry, item)
              updateStatus(entry, {
                processed: entry.status.processed + 1,
                lastPath: localPath,
                lastError: undefined,
                lastPhase: 'complete',
              })
              return
            }
          }
        }
        stage = 'upload'
        const uploadedPath = await uploadFile(
          entry.connection,
          entry.auth,
          localPath,
          stat.size,
          remotePath,
          tempPath,
          (bytesSent) => {
            item.bytesSent = bytesSent
            item.updatedAt = Date.now()
            updateRecent(entry, item)
          },
        )
        if (!uploadedPath) return
        const latestStat = await fs.stat(localPath).catch(() => null)
        if (!latestStat || latestStat.size !== baseSize || latestStat.mtimeMs > baseMtimeMs + MTIME_SKEW_MS) {
          item.phase = 'complete'
          item.note = 'Superseded by newer local edit; verification skipped.'
          item.updatedAt = Date.now()
          updateRecent(entry, item)
          updateStatus(entry, {
            processed: entry.status.processed + 1,
            lastPath: localPath,
            lastError: undefined,
            lastPhase: 'complete',
          })
          return
        }
        item.phase = 'verifying'
        item.updatedAt = Date.now()
        updateRecent(entry, item)
        updateStatus(entry, { lastPhase: 'verifying' })
        stage = 'verify'
        await verifyUpload(entry.connection, entry.auth, localPath, uploadedPath)
        entry.recentLocalChanges.delete(localPath)
        item.phase = 'complete'
        item.updatedAt = Date.now()
        updateRecent(entry, item)
        updateStatus(entry, {
          processed: entry.status.processed + 1,
          lastPath: localPath,
          lastError: undefined,
          lastPhase: 'complete',
        })
      } catch (error) {
        item.phase = 'failed'
        const detail = error instanceof Error ? error.message : String(error)
        item.error = detail ? `${detail} (stage: ${stage})` : `Upload failed. (stage: ${stage})`
        if (!item.note && debugNote) {
          item.note = debugNote
        }
        item.updatedAt = Date.now()
        updateRecent(entry, item)
        updateStatus(entry, {
          failed: entry.status.failed + 1,
          lastPath: localPath,
          lastError: detail ? `${detail} (stage: ${stage})` : `Upload failed. (stage: ${stage})`,
          lastPhase: 'failed',
        })
      } finally {
        entry.pendingPaths.delete(localPath)
        refreshQueueCounts(entry)
      }
    })
    .catch((error) => {
      updateStatus(entry, { lastError: error instanceof Error ? error.message : String(error) })
    })

  refreshQueueCounts(entry)
}

function enqueueDelete(entry: WatchEntry, localPath: string) {
  if (shouldSuppress(entry, localPath)) return
  markLocalChange(entry, localPath)
  entry.pendingPaths.add(localPath)
  const deleteRequestedAt = Date.now()
  const item: QueueItem = {
    id: `q_${Date.now()}_${itemCounter++}`,
    path: localPath,
    action: 'delete',
    phase: 'queued',
    updatedAt: Date.now(),
  }
  updateRecent(entry, item)

  entry.queue
    .add(async () => {
      refreshQueueCounts(entry)
      let stage = 'prepare'
      let debugNote = ''
      try {
        item.phase = 'deleting'
        item.updatedAt = Date.now()
        updateRecent(entry, item)
        updateStatus(entry, { lastPath: localPath, lastPhase: 'deleting', lastError: undefined })
        const target = resolveRemoteTarget(entry.connection, localPath)
        const remotePath = target.remotePath
        debugNote = remotePath
          ? `Target: ${remotePath} | Source: ${target.source}`
          : `Target: (none) | Source: ${target.source}`
        if (!remotePath) {
          item.phase = 'failed'
          item.error = 'No remote path mapping for file.'
          item.note = debugNote
          item.updatedAt = Date.now()
          updateRecent(entry, item)
          updateStatus(entry, {
            failed: entry.status.failed + 1,
            lastPath: localPath,
            lastError: item.error,
            lastPhase: 'failed',
          })
          return
        }
        stage = 'remote-stat'
        const remoteStat = await withSftp(entry.connection, entry.auth, async (sftp) => {
          return sftpStat(sftp, remotePath)
        })
        if (remoteStat) {
          const remoteMtimeMs = remoteStat.mtime * 1000
          if (remoteMtimeMs > deleteRequestedAt + MTIME_SKEW_MS) {
            stage = 'restore-remote-newer'
            markSuppressed(entry, localPath)
            await downloadRemoteFile(entry.connection, entry.auth, remotePath, remoteStat.mtime)
            entry.recentLocalChanges.delete(localPath)
            item.phase = 'complete'
            item.note = 'Remote won: remote newer; restored instead of delete.'
            item.updatedAt = Date.now()
            updateRecent(entry, item)
            updateStatus(entry, {
              processed: entry.status.processed + 1,
              lastPath: localPath,
              lastError: undefined,
              lastPhase: 'complete',
            })
            return
          }
        }
        stage = 'delete'
        await withSftp(entry.connection, entry.auth, async (sftp) => {
          await removeRemotePath(sftp, remotePath)
        })
        entry.recentLocalChanges.delete(localPath)
        item.phase = 'complete'
        item.updatedAt = Date.now()
        updateRecent(entry, item)
        updateStatus(entry, {
          processed: entry.status.processed + 1,
          lastPath: localPath,
          lastError: undefined,
          lastPhase: 'complete',
        })
      } catch (error) {
        item.phase = 'failed'
        const detail = error instanceof Error ? error.message : String(error)
        item.error = detail ? `${detail} (stage: ${stage})` : `Delete failed. (stage: ${stage})`
        if (!item.note && debugNote) {
          item.note = debugNote
        }
        item.updatedAt = Date.now()
        updateRecent(entry, item)
        updateStatus(entry, {
          failed: entry.status.failed + 1,
          lastPath: localPath,
          lastError: detail ? `${detail} (stage: ${stage})` : `Delete failed. (stage: ${stage})`,
          lastPhase: 'failed',
        })
      } finally {
        entry.pendingPaths.delete(localPath)
        refreshQueueCounts(entry)
      }
    })
    .catch((error) => {
      updateStatus(entry, { lastError: error instanceof Error ? error.message : String(error) })
    })

  refreshQueueCounts(entry)
}
