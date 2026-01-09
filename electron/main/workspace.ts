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
) {
  return withSftp(connection, auth, async (sftp) => {
    const entries = await new Promise<SFTPWrapper.FileEntry[]>((resolve, reject) => {
      sftp.readdir(remotePath, (err, list) => {
        if (err) reject(err)
        else resolve(list)
      })
    })
    return entries.map((entry) => ({
      name: entry.filename,
      path: remoteJoin(remotePath, entry.filename),
      type: entry.attrs.isDirectory() ? 'dir' : 'file',
      size: entry.attrs.size,
    })) as FileNode[]
  })
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
