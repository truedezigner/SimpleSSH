import path from 'node:path'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import crypto from 'node:crypto'
import { Client, SFTPWrapper } from 'ssh2'
import chokidar from 'chokidar'
import PQueue from 'p-queue'
import { Connection } from './connectionsStore'

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
  updatedAt: number
  bytesSent?: number
  bytesTotal?: number
}

interface WatchEntry {
  connection: Connection
  auth: { password?: string; privateKey?: string; passphrase?: string }
  watcher: chokidar.FSWatcher
  queue: PQueue
  status: QueueStatus
}

type StatusEmitter = (status: QueueStatus) => void

const watchers = new Map<string, WatchEntry>()
let emitStatus: StatusEmitter = () => {}
let itemCounter = 0

export function setQueueStatusEmitter(emitter: StatusEmitter) {
  emitStatus = emitter
}

function remoteJoin(...parts: string[]) {
  return path.posix.join(...parts)
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
  onProgress?: (bytesSent: number) => void,
) {
  const relative = path.relative(connection.localRoot, localPath)
  if (!relative || relative.startsWith('..')) {
    return null
  }
  const remotePath = remoteJoin(connection.remoteRoot, ...relative.split(path.sep))
  const remoteDir = path.posix.dirname(remotePath)
  const tempPath = `${remotePath}.simplessh_tmp_${Date.now()}`

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
          if (err) reject(err)
          else resolve()
        },
      )
    })
    try {
      await new Promise<void>((resolve, reject) => {
        sftp.rename(tempPath, remotePath, (err) => {
          if (err) reject(err)
          else resolve()
        })
      })
    } catch (error) {
      await new Promise<void>((resolve) => {
        sftp.unlink(tempPath, () => resolve())
      })
      throw error
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
    throw new Error('Upload verification failed (size mismatch).')
  }

  const localHash = await hashLocalFile(localPath)
  let remoteHash: string

  if (connection.verifyMode === 'download-back') {
    remoteHash = await hashRemoteDownload(connection, auth, remotePath)
  } else {
    try {
      remoteHash = await hashRemoteWithExec(connection, auth, remotePath)
    } catch {
      remoteHash = await hashRemoteDownload(connection, auth, remotePath)
    }
  }

  if (remoteHash !== localHash) {
    throw new Error('Upload verification failed (hash mismatch).')
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
    recent: recent.slice(0, 8),
  }
  emitStatus(entry.status)
}

function refreshQueueCounts(entry: WatchEntry) {
  updateStatus(entry, {
    pending: entry.queue.size,
    active: entry.queue.pending,
  })
}

export function getQueueStatus(connectionId: string) {
  return watchers.get(connectionId)?.status ?? null
}

export async function startWatcher(
  connection: Connection,
  auth: { password?: string; privateKey?: string; passphrase?: string },
) {
  const existing = watchers.get(connection.id)
  if (existing) {
    updateStatus(existing, { watching: true })
    return existing.status
  }

  const queue = new PQueue({ concurrency: 1 })
  const status: QueueStatus = {
    connectionId: connection.id,
    watching: true,
    pending: 0,
    active: 0,
    processed: 0,
    failed: 0,
    lastPhase: 'idle',
    recent: [],
  }

  const watcher = chokidar.watch(connection.localRoot, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 400, pollInterval: 100 },
    ignored: /(^|[\\/])\.(git|svn|hg)([\\/]|$)|node_modules/,
  })

  const entry: WatchEntry = {
    connection,
    auth,
    watcher,
    queue,
    status,
  }

  watcher
    .on('add', (localPath) => enqueueUpload(entry, localPath))
    .on('change', (localPath) => enqueueUpload(entry, localPath))
    .on('unlink', (localPath) => enqueueDelete(entry, localPath))
    .on('unlinkDir', (localPath) => enqueueDelete(entry, localPath))
    .on('error', (error) => {
      updateStatus(entry, { lastError: String(error) })
    })

  watchers.set(connection.id, entry)
  emitStatus(status)
  return status
}

export async function stopWatcher(connectionId: string) {
  const entry = watchers.get(connectionId)
  if (!entry) return null
  await entry.watcher.close()
  entry.queue.clear()
  entry.status = {
    ...entry.status,
    watching: false,
    pending: 0,
    active: 0,
  }
  emitStatus(entry.status)
  watchers.delete(connectionId)
  return entry.status
}

function enqueueUpload(entry: WatchEntry, localPath: string) {
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
      try {
        item.phase = 'uploading'
        item.updatedAt = Date.now()
        updateRecent(entry, item)
        updateStatus(entry, { lastPath: localPath, lastPhase: 'uploading', lastError: undefined })
        const stat = await fs.stat(localPath)
        if (!stat.isFile()) {
          return
        }
        item.bytesTotal = stat.size
        item.bytesSent = 0
        item.updatedAt = Date.now()
        updateRecent(entry, item)
        const remotePath = await uploadFile(
          entry.connection,
          entry.auth,
          localPath,
          stat.size,
          (bytesSent) => {
            item.bytesSent = bytesSent
            item.updatedAt = Date.now()
            updateRecent(entry, item)
          },
        )
        if (!remotePath) return
        item.phase = 'verifying'
        item.updatedAt = Date.now()
        updateRecent(entry, item)
        updateStatus(entry, { lastPhase: 'verifying' })
        await verifyUpload(entry.connection, entry.auth, localPath, remotePath)
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
        item.error = error instanceof Error ? error.message : String(error)
        item.updatedAt = Date.now()
        updateRecent(entry, item)
        updateStatus(entry, {
          failed: entry.status.failed + 1,
          lastPath: localPath,
          lastError: error instanceof Error ? error.message : String(error),
          lastPhase: 'failed',
        })
      } finally {
        refreshQueueCounts(entry)
      }
    })
    .catch((error) => {
      updateStatus(entry, { lastError: error instanceof Error ? error.message : String(error) })
    })

  refreshQueueCounts(entry)
}

function enqueueDelete(entry: WatchEntry, localPath: string) {
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
      try {
        item.phase = 'deleting'
        item.updatedAt = Date.now()
        updateRecent(entry, item)
        updateStatus(entry, { lastPath: localPath, lastPhase: 'deleting', lastError: undefined })
        const relative = path.relative(entry.connection.localRoot, localPath)
        if (!relative || relative.startsWith('..')) {
          return
        }
        const remotePath = remoteJoin(entry.connection.remoteRoot, ...relative.split(path.sep))
        await withSftp(entry.connection, entry.auth, async (sftp) => {
          await removeRemotePath(sftp, remotePath)
        })
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
        item.error = error instanceof Error ? error.message : String(error)
        item.updatedAt = Date.now()
        updateRecent(entry, item)
        updateStatus(entry, {
          failed: entry.status.failed + 1,
          lastPath: localPath,
          lastError: error instanceof Error ? error.message : String(error),
          lastPhase: 'failed',
        })
      } finally {
        refreshQueueCounts(entry)
      }
    })
    .catch((error) => {
      updateStatus(entry, { lastError: error instanceof Error ? error.message : String(error) })
    })

  refreshQueueCounts(entry)
}
