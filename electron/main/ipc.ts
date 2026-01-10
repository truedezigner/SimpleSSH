import { ipcMain, dialog, BrowserWindow, shell, Menu, clipboard } from 'electron'
import { deleteConnection, listConnections, upsertConnection } from './connectionsStore'
import {
  deletePassphrase,
  deletePassword,
  deletePrivateKey,
  getPassphrase,
  getPassword,
  getPrivateKey,
  setPassphrase,
  setPassword,
  setPrivateKey,
} from './secretsStore'
import { testConnection } from './sshClient'
import {
  downloadRemoteFile,
  downloadRemoteFileToCache,
  listLocalTree,
  listRemoteDir,
  rebuildRemoteIndex,
  createRemoteItem,
  renameRemoteItem,
  deleteRemoteItem,
  refreshRemoteTree,
  syncRemoteToLocal,
} from './workspace'
import {
  clearQueueHistory,
  forceUploadFile,
  getQueueStatus,
  setQueueStatusEmitter,
  suppressPath,
  startCacheWatcher,
  startWatcher,
  stopWatcher,
  updateWatchEntry,
} from './uploader'
import { clearRemoteCache, initRemoteCache } from './remoteCache'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import os from 'node:os'
import { execFile } from 'node:child_process'

function revealLabel() {
  return process.platform === 'darwin' ? 'Reveal in Finder' : 'Reveal in Explorer'
}

export function registerIpcHandlers() {
  void initRemoteCache()
  const notifyStatus = (connectionId: string, message: string, kind: 'info' | 'ok' | 'error' = 'info') => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send('workspace:status', {
        connectionId,
        kind,
        message,
      })
    }
  }

  setQueueStatusEmitter((status) => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send('workspace:queueStatus', status)
    }
  })

  ipcMain.handle('connections:list', async () => {
    return listConnections()
  })

  ipcMain.handle(
    'connections:upsert',
    async (_event, payload: { connection: any; password?: string; privateKey?: string; passphrase?: string }) => {
      const { connection, password, privateKey, passphrase } = payload
    const saved = await upsertConnection(connection)
      if (saved.authType === 'password') {
        if (password) {
          await setPassword(saved.id, password)
        }
        await deletePrivateKey(saved.id)
        await deletePassphrase(saved.id)
      } else {
        if (privateKey) {
          await setPrivateKey(saved.id, privateKey)
        }
        if (passphrase) {
          await setPassphrase(saved.id, passphrase)
        } else {
          await deletePassphrase(saved.id)
        }
        await deletePassword(saved.id)
      }
      await updateWatchEntry(saved)
      return saved
    },
  )

  ipcMain.handle('connections:delete', async (_event, id: string) => {
    await deletePassword(id)
    await deletePrivateKey(id)
    await deletePassphrase(id)
    return deleteConnection(id)
  })

  ipcMain.handle('connections:getPassword', async (_event, id: string) => {
    return getPassword(id)
  })

  ipcMain.handle('connections:clearPassword', async (_event, id: string) => {
    await deletePassword(id)
    return true
  })

  ipcMain.handle('connections:getPrivateKey', async (_event, id: string) => {
    return getPrivateKey(id)
  })

  ipcMain.handle('connections:clearPrivateKey', async (_event, id: string) => {
    await deletePrivateKey(id)
    return true
  })

  ipcMain.handle('connections:getPassphrase', async (_event, id: string) => {
    return getPassphrase(id)
  })

  ipcMain.handle('connections:clearPassphrase', async (_event, id: string) => {
    await deletePassphrase(id)
    return true
  })

  ipcMain.handle('connections:test', async (_event, payload: any) => {
    return testConnection(payload)
  })

  ipcMain.handle(
    'connections:generateKeyPair',
    async (_event, payload: { keyName: string; passphrase: string; comment?: string }) => {
      const keyName = payload.keyName?.trim()
      const passphrase = payload.passphrase ?? ''
      if (!keyName) return { ok: false, message: 'Key name is required.' }
      if (!passphrase) return { ok: false, message: 'Key passphrase is required.' }
      if (/[\\/]/.test(keyName)) return { ok: false, message: 'Key name cannot include slashes.' }

      const sshDir = path.join(os.homedir(), '.ssh')
      const keyPath = path.join(sshDir, keyName)
      const pubPath = `${keyPath}.pub`

      if (fsSync.existsSync(keyPath) || fsSync.existsSync(pubPath)) {
        return { ok: false, message: 'Key already exists in .ssh.' }
      }

      try {
        await fs.mkdir(sshDir, { recursive: true })
        const args = ['-t', 'rsa', '-b', '2048', '-f', keyPath, '-N', passphrase]
        if (payload.comment?.trim()) {
          args.push('-C', payload.comment.trim())
        }
        await new Promise<void>((resolve, reject) => {
          execFile('ssh-keygen', args, (err) => {
            if (err) reject(err)
            else resolve()
          })
        })
        const [privateKey, publicKey] = await Promise.all([
          fs.readFile(keyPath, 'utf8'),
          fs.readFile(pubPath, 'utf8'),
        ])
        return {
          ok: true,
          message: 'Key pair generated.',
          privateKey,
          publicKey,
          keyPath,
          publicKeyPath: pubPath,
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to generate key pair.'
        return { ok: false, message }
      }
    },
  )

  ipcMain.handle('connections:export', async () => {
    const connections = await listConnections()
    const target = await dialog.showSaveDialog(BrowserWindow.getFocusedWindow() ?? undefined, {
      title: 'Export Connections',
      defaultPath: path.join(process.cwd(), 'simplessh-connections.json'),
      filters: [{ name: 'JSON', extensions: ['json'] }],
    })
    if (target.canceled || !target.filePath) return { ok: false, message: 'Export cancelled.' }
    await fs.writeFile(target.filePath, JSON.stringify(connections, null, 2), 'utf8')
    return { ok: true, message: 'Connections exported.' }
  })

  ipcMain.handle('connections:import', async () => {
    const source = await dialog.showOpenDialog(BrowserWindow.getFocusedWindow() ?? undefined, {
      title: 'Import Connections',
      filters: [{ name: 'JSON', extensions: ['json'] }],
      properties: ['openFile'],
    })
    if (source.canceled || source.filePaths.length === 0) {
      return { ok: false, message: 'Import cancelled.' }
    }
    const raw = await fs.readFile(source.filePaths[0], 'utf8')
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) {
      return { ok: false, message: 'Invalid connections file.' }
    }
    for (const item of parsed) {
      await upsertConnection(item)
    }
    return { ok: true, message: 'Connections imported.' }
  })

  ipcMain.handle('workspace:pickFolder', async () => {
    const result = await dialog.showOpenDialog(BrowserWindow.getFocusedWindow() ?? undefined, {
      title: 'Select Local Workspace',
      properties: ['openDirectory', 'createDirectory'],
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  ipcMain.handle('workspace:list', async (_event, payload: { root: string; depth?: number }) => {
    return listLocalTree(payload.root, payload.depth ?? 2)
  })

  ipcMain.handle('workspace:openFolder', async (_event, payload: { root: string }) => {
    if (!payload.root) return { ok: false, message: 'No folder path provided.' }
    try {
      await fs.mkdir(payload.root, { recursive: true })
      const result = await shell.openPath(payload.root)
      if (result) return { ok: false, message: result }
      return { ok: true, message: 'Opened workspace folder.' }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to open folder.'
      return { ok: false, message }
    }
  })

  ipcMain.handle('workspace:sync', async (_event, payload: { connectionId: string }) => {
    const connection = (await listConnections()).find((item) => item.id === payload.connectionId)
    if (!connection) return { ok: false, message: 'Connection not found.' }
    if (!connection.localRoot) return { ok: false, message: 'Local workspace is not set.' }
    if (!connection.remoteRoot) return { ok: false, message: 'Remote root is not set.' }
    let auth: { password?: string; privateKey?: string; passphrase?: string } = {}
    const authType = connection.authType ?? 'password'
    if (authType === 'password') {
      const password = await getPassword(connection.id)
      if (!password) return { ok: false, message: 'Missing password.' }
      auth = { password }
    } else {
      const privateKey = await getPrivateKey(connection.id)
      const passphrase = await getPassphrase(connection.id)
      if (!privateKey) return { ok: false, message: 'Missing private key.' }
      auth = { privateKey, passphrase: passphrase ?? undefined }
    }
    try {
      await syncRemoteToLocal(connection, auth)
      return { ok: true, message: 'Workspace synced.' }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Sync failed.'
      return { ok: false, message }
    }
  })

  ipcMain.handle(
    'workspace:remoteList',
    async (_event, payload: { connectionId: string; path: string; force?: boolean; skipIndex?: boolean }) => {
    const connection = (await listConnections()).find((item) => item.id === payload.connectionId)
    if (!connection) return { ok: false, message: 'Connection not found.' }
    if (!connection.remoteRoot) return { ok: false, message: 'Remote root is not set.' }
    let auth: { password?: string; privateKey?: string; passphrase?: string } = {}
    const authType = connection.authType ?? 'password'
    if (authType === 'password') {
      const password = await getPassword(connection.id)
      if (!password) return { ok: false, message: 'Missing password.' }
      auth = { password }
    } else {
      const privateKey = await getPrivateKey(connection.id)
      const passphrase = await getPassphrase(connection.id)
      if (!privateKey) return { ok: false, message: 'Missing private key.' }
      auth = { privateKey, passphrase: passphrase ?? undefined }
    }
    try {
      const nodes = await listRemoteDir(connection, auth, payload.path || connection.remoteRoot, {
        force: payload.force,
        skipIndex: payload.skipIndex,
      })
      return { ok: true, message: 'Remote list loaded.', nodes }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to load remote list.'
      return { ok: false, message }
    }
  },
  )

  ipcMain.handle('workspace:rebuildRemoteIndex', async (_event, payload: { connectionId: string }) => {
    const connection = (await listConnections()).find((item) => item.id === payload.connectionId)
    if (!connection) return { ok: false, message: 'Connection not found.' }
    if (!connection.remoteRoot) return { ok: false, message: 'Remote root is not set.' }
    let auth: { password?: string; privateKey?: string; passphrase?: string } = {}
    const authType = connection.authType ?? 'password'
    if (authType === 'password') {
      const password = await getPassword(connection.id)
      if (!password) return { ok: false, message: 'Missing password.' }
      auth = { password }
    } else {
      const privateKey = await getPrivateKey(connection.id)
      const passphrase = await getPassphrase(connection.id)
      if (!privateKey) return { ok: false, message: 'Missing private key.' }
      auth = { privateKey, passphrase: passphrase ?? undefined }
    }
    try {
      const toRelative = (value: string) => {
        const relative = path.posix.relative(connection.remoteRoot, value)
        if (!relative || relative === '.') return '.'
        if (relative.startsWith('..')) return value
        return relative
      }
      const notify = (message: string) => {
        console.log(`[remote-index] ${message}`)
        for (const window of BrowserWindow.getAllWindows()) {
          window.webContents.send('workspace:status', {
            connectionId: connection.id,
            kind: 'info',
            message,
          })
        }
      }
      notify('Rebuilding remote index: .')
      await rebuildRemoteIndex(connection, auth, {
        onProgress: (targetPath) => {
          notify(`Rebuilding remote index: ${toRelative(targetPath)}`)
        },
        onEmpty: (targetPath) => {
          notify(`Rebuilding remote index: ${toRelative(targetPath)} (empty)`)
        },
        onError: (targetPath, error) => {
          const detail = error instanceof Error ? error.message : 'unknown error'
          notify(`Rebuilding remote index: failed to list ${toRelative(targetPath)} (${detail})`)
        },
      })
      return { ok: true, message: 'Remote index rebuilt.' }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to rebuild remote index.'
      return { ok: false, message }
    }
  })

  ipcMain.handle(
    'workspace:downloadRemoteFile',
    async (_event, payload: { connectionId: string; remotePath: string }) => {
      const connection = (await listConnections()).find((item) => item.id === payload.connectionId)
      if (!connection) return { ok: false, message: 'Connection not found.' }
      if (!connection.localRoot) return { ok: false, message: 'Local workspace is not set.' }
      if (!connection.remoteRoot) return { ok: false, message: 'Remote root is not set.' }
      let auth: { password?: string; privateKey?: string; passphrase?: string } = {}
      const authType = connection.authType ?? 'password'
      if (authType === 'password') {
        const password = await getPassword(connection.id)
        if (!password) return { ok: false, message: 'Missing password.' }
        auth = { password }
      } else {
        const privateKey = await getPrivateKey(connection.id)
        const passphrase = await getPassphrase(connection.id)
        if (!privateKey) return { ok: false, message: 'Missing private key.' }
        auth = { privateKey, passphrase: passphrase ?? undefined }
      }
      try {
        const localPath = await downloadRemoteFile(connection, auth, payload.remotePath)
        return { ok: true, message: 'File downloaded.', localPath }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to download file.'
        return { ok: false, message }
      }
    },
  )

  ipcMain.handle(
    'workspace:downloadRemoteFileToCache',
    async (_event, payload: { connectionId: string; remotePath: string }) => {
      const connection = (await listConnections()).find((item) => item.id === payload.connectionId)
      if (!connection) return { ok: false, message: 'Connection not found.' }
      if (!connection.remoteRoot) return { ok: false, message: 'Remote root is not set.' }
      let auth: { password?: string; privateKey?: string; passphrase?: string } = {}
      const authType = connection.authType ?? 'password'
      if (authType === 'password') {
        const password = await getPassword(connection.id)
        if (!password) return { ok: false, message: 'Missing password.' }
        auth = { password }
      } else {
        const privateKey = await getPrivateKey(connection.id)
        const passphrase = await getPassphrase(connection.id)
        if (!privateKey) return { ok: false, message: 'Missing private key.' }
        auth = { privateKey, passphrase: passphrase ?? undefined }
      }
      try {
        const localPath = await downloadRemoteFileToCache(connection, auth, payload.remotePath)
        suppressPath(connection.id, localPath)
        if (connection.remoteFirstEditing) {
          await startCacheWatcher(connection, auth)
        }
        return { ok: true, message: 'File downloaded to cache.', localPath }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to download file.'
        return { ok: false, message }
      }
    },
  )

  ipcMain.handle('workspace:startWatch', async (_event, payload: { connectionId: string }) => {
    const connection = (await listConnections()).find((item) => item.id === payload.connectionId)
    if (!connection) return { ok: false, message: 'Connection not found.' }
    if (!connection.localRoot) return { ok: false, message: 'Local workspace is not set.' }
    if (!connection.remoteRoot) return { ok: false, message: 'Remote root is not set.' }
    let auth: { password?: string; privateKey?: string; passphrase?: string } = {}
    const authType = connection.authType ?? 'password'
    if (authType === 'password') {
      const password = await getPassword(connection.id)
      if (!password) return { ok: false, message: 'Missing password.' }
      auth = { password }
    } else {
      const privateKey = await getPrivateKey(connection.id)
      const passphrase = await getPassphrase(connection.id)
      if (!privateKey) return { ok: false, message: 'Missing private key.' }
      auth = { privateKey, passphrase: passphrase ?? undefined }
    }
    try {
      const status = await startWatcher(connection, auth)
      return { ok: true, message: 'Watcher started.', status }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to start watcher.'
      return { ok: false, message }
    }
  })

  ipcMain.handle('workspace:stopWatch', async (_event, payload: { connectionId: string }) => {
    try {
      const status = await stopWatcher(payload.connectionId)
      if (!status) return { ok: false, message: 'Watcher not running.' }
      return { ok: true, message: 'Watcher stopped.', status }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to stop watcher.'
      return { ok: false, message }
    }
  })

  ipcMain.handle('workspace:getQueueStatus', async (_event, payload: { connectionId: string }) => {
    return getQueueStatus(payload.connectionId)
  })

  ipcMain.handle('workspace:clearQueueHistory', async (_event, payload: { connectionId: string }) => {
    return clearQueueHistory(payload.connectionId)
  })

  ipcMain.handle('workspace:clearRemoteCache', async (_event, payload: { connectionId: string }) => {
    try {
      await clearRemoteCache(payload.connectionId)
      return { ok: true, message: 'Remote cache cleared.' }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to clear remote cache.'
      return { ok: false, message }
    }
  })

  ipcMain.handle(
    'workspace:createLocalItem',
    async (
      _event,
      payload: { connectionId: string; parentPath: string; name: string; type: 'file' | 'dir' },
    ) => {
      const connection = (await listConnections()).find((item) => item.id === payload.connectionId)
      if (!connection) return { ok: false, message: 'Connection not found.' }
      if (!connection.localRoot) return { ok: false, message: 'Local workspace is not set.' }
      const parentPath = payload.parentPath
      if (!parentPath) return { ok: false, message: 'No parent path provided.' }
      const relativeParent = path.relative(connection.localRoot, parentPath)
      if (relativeParent.startsWith('..') || path.isAbsolute(relativeParent)) {
        return { ok: false, message: 'Folder is outside the local workspace.' }
      }
      const trimmedName = payload.name?.trim()
      if (!trimmedName) return { ok: false, message: 'Name is required.' }
      if (/[/\\]/.test(trimmedName)) return { ok: false, message: 'Name cannot include slashes.' }
      if (trimmedName === '.' || trimmedName === '..') return { ok: false, message: 'Invalid name.' }
      const targetPath = path.join(parentPath, trimmedName)

      try {
        const parentStat = await fs.stat(parentPath)
        if (!parentStat.isDirectory()) return { ok: false, message: 'Parent path is not a directory.' }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Parent folder not found.'
        return { ok: false, message }
      }

      try {
        await fs.stat(targetPath)
        return { ok: false, message: 'Item already exists.' }
      } catch {
        // continue when not found
      }

      try {
        if (payload.type === 'dir') {
          await fs.mkdir(targetPath)
          return { ok: true, message: 'Folder created.', path: targetPath }
        }
        const handle = await fs.open(targetPath, 'wx')
        await handle.close()
        return { ok: true, message: 'File created.', path: targetPath }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to create item.'
        return { ok: false, message }
      }
    },
  )

  ipcMain.handle(
    'workspace:createRemoteItem',
    async (
      _event,
      payload: { connectionId: string; parentPath: string; name: string; type: 'file' | 'dir' },
    ) => {
      const connection = (await listConnections()).find((item) => item.id === payload.connectionId)
      if (!connection) return { ok: false, message: 'Connection not found.' }
      if (!connection.remoteRoot) return { ok: false, message: 'Remote root is not set.' }
      let auth: { password?: string; privateKey?: string; passphrase?: string } = {}
      const authType = connection.authType ?? 'password'
      if (authType === 'password') {
        const password = await getPassword(connection.id)
        if (!password) return { ok: false, message: 'Missing password.' }
        auth = { password }
      } else {
        const privateKey = await getPrivateKey(connection.id)
        const passphrase = await getPassphrase(connection.id)
        if (!privateKey) return { ok: false, message: 'Missing private key.' }
        auth = { privateKey, passphrase: passphrase ?? undefined }
      }
      try {
        const createdPath = await createRemoteItem(
          connection,
          auth,
          payload.parentPath,
          payload.name,
          payload.type,
        )
        const label = payload.type === 'dir' ? 'Folder created.' : 'File created.'
        return { ok: true, message: label, path: createdPath }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to create remote item.'
        return { ok: false, message }
      }
    },
  )

  ipcMain.handle(
    'workspace:renameLocalItem',
    async (_event, payload: { connectionId: string; path: string; name: string }) => {
      const connection = (await listConnections()).find((item) => item.id === payload.connectionId)
      if (!connection) return { ok: false, message: 'Connection not found.' }
      if (!connection.localRoot) return { ok: false, message: 'Local workspace is not set.' }
      if (!payload.path) return { ok: false, message: 'No path provided.' }
      const relative = path.relative(connection.localRoot, payload.path)
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
        return { ok: false, message: 'Item is outside the local workspace.' }
      }
      const trimmedName = payload.name?.trim()
      if (!trimmedName) return { ok: false, message: 'Name is required.' }
      if (/[/\\]/.test(trimmedName)) return { ok: false, message: 'Name cannot include slashes.' }
      if (trimmedName === '.' || trimmedName === '..') return { ok: false, message: 'Invalid name.' }
      const parentPath = path.dirname(payload.path)
      const nextPath = path.join(parentPath, trimmedName)

      try {
        await fs.stat(payload.path)
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Item not found.'
        return { ok: false, message }
      }

      try {
        await fs.stat(nextPath)
        return { ok: false, message: 'Item already exists.' }
      } catch {
        // continue when not found
      }

      try {
        await fs.rename(payload.path, nextPath)
        return { ok: true, message: 'Item renamed.', path: nextPath }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to rename item.'
        return { ok: false, message }
      }
    },
  )

  ipcMain.handle(
    'workspace:renameRemoteItem',
    async (_event, payload: { connectionId: string; path: string; name: string }) => {
      const connection = (await listConnections()).find((item) => item.id === payload.connectionId)
      if (!connection) return { ok: false, message: 'Connection not found.' }
      if (!connection.remoteRoot) return { ok: false, message: 'Remote root is not set.' }
      let auth: { password?: string; privateKey?: string; passphrase?: string } = {}
      const authType = connection.authType ?? 'password'
      if (authType === 'password') {
        const password = await getPassword(connection.id)
        if (!password) return { ok: false, message: 'Missing password.' }
        auth = { password }
      } else {
        const privateKey = await getPrivateKey(connection.id)
        const passphrase = await getPassphrase(connection.id)
        if (!privateKey) return { ok: false, message: 'Missing private key.' }
        auth = { privateKey, passphrase: passphrase ?? undefined }
      }
      try {
        const renamedPath = await renameRemoteItem(connection, auth, payload.path, payload.name)
        return { ok: true, message: 'Item renamed.', path: renamedPath }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to rename remote item.'
        return { ok: false, message }
      }
    },
  )

  ipcMain.handle(
    'workspace:deleteLocalItem',
    async (_event, payload: { connectionId: string; path: string; type?: 'file' | 'dir' }) => {
      const connection = (await listConnections()).find((item) => item.id === payload.connectionId)
      if (!connection) return { ok: false, message: 'Connection not found.' }
      if (!connection.localRoot) return { ok: false, message: 'Local workspace is not set.' }
      if (!payload.path) return { ok: false, message: 'No path provided.' }
      if (payload.path === connection.localRoot) {
        return { ok: false, message: 'Cannot delete the workspace root.' }
      }
      const relative = path.relative(connection.localRoot, payload.path)
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
        return { ok: false, message: 'Item is outside the local workspace.' }
      }
      try {
        const stats = await fs.stat(payload.path)
        if (stats.isDirectory()) {
          await fs.rm(payload.path, { recursive: true })
        } else {
          await fs.unlink(payload.path)
        }
        return { ok: true, message: 'Item deleted.' }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to delete item.'
        return { ok: false, message }
      }
    },
  )

  ipcMain.handle(
    'workspace:deleteRemoteItem',
    async (_event, payload: { connectionId: string; path: string }) => {
      const connection = (await listConnections()).find((item) => item.id === payload.connectionId)
      if (!connection) return { ok: false, message: 'Connection not found.' }
      if (!connection.remoteRoot) return { ok: false, message: 'Remote root is not set.' }
      let auth: { password?: string; privateKey?: string; passphrase?: string } = {}
      const authType = connection.authType ?? 'password'
      if (authType === 'password') {
        const password = await getPassword(connection.id)
        if (!password) return { ok: false, message: 'Missing password.' }
        auth = { password }
      } else {
        const privateKey = await getPrivateKey(connection.id)
        const passphrase = await getPassphrase(connection.id)
        if (!privateKey) return { ok: false, message: 'Missing private key.' }
        auth = { privateKey, passphrase: passphrase ?? undefined }
      }
      try {
        await deleteRemoteItem(connection, auth, payload.path)
        return { ok: true, message: 'Item deleted.' }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to delete remote item.'
        return { ok: false, message }
      }
    },
  )

  ipcMain.handle(
    'workspace:forceUploadFile',
    async (_event, payload: { connectionId: string; path: string }) => {
      const connection = (await listConnections()).find((item) => item.id === payload.connectionId)
      if (!connection) return { ok: false, message: 'Connection not found.' }
      if (!connection.localRoot) return { ok: false, message: 'Local workspace is not set.' }
      if (!connection.remoteRoot) return { ok: false, message: 'Remote root is not set.' }
      const relative = path.relative(connection.localRoot, payload.path)
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
        return { ok: false, message: 'File is outside the local workspace.' }
      }
      try {
        const stat = await fs.stat(payload.path)
        if (!stat.isFile()) return { ok: false, message: 'Only files can be force uploaded.' }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'File not found.'
        return { ok: false, message }
      }
      let auth: { password?: string; privateKey?: string; passphrase?: string } = {}
      const authType = connection.authType ?? 'password'
      if (authType === 'password') {
        const password = await getPassword(connection.id)
        if (!password) return { ok: false, message: 'Missing password.' }
        auth = { password }
      } else {
        const privateKey = await getPrivateKey(connection.id)
        const passphrase = await getPassphrase(connection.id)
        if (!privateKey) return { ok: false, message: 'Missing private key.' }
        auth = { privateKey, passphrase: passphrase ?? undefined }
      }
      try {
        const status = await forceUploadFile(connection, auth, payload.path)
        return { ok: true, message: 'Force upload queued.', status }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Force upload failed.'
        return { ok: false, message }
      }
    },
  )

  ipcMain.handle(
    'workspace:openInEditor',
    async (_event, payload: { path: string; codeCommand?: string }) => {
      if (!payload?.path) return { ok: false, message: 'No path provided.' }
      const codeCommand = payload.codeCommand?.trim() || 'code'
      try {
        const safePath = payload.path.replace(/\"/g, '\\"')
        const child = spawn(`${codeCommand} \"${safePath}\"`, {
          detached: true,
          stdio: 'ignore',
          shell: true,
        })
        child.unref()
        return { ok: true, message: 'Opened in editor.' }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to open editor.'
        return { ok: false, message }
      }
    },
  )

  ipcMain.handle(
    'workspace:showContextMenu',
    async (
      event,
      payload: { connectionId?: string; path: string; type: 'file' | 'dir'; codeCommand?: string },
    ) => {
      if (!payload?.path) return { ok: false, message: 'No path provided.' }
      const codeCommand = payload.codeCommand?.trim() || 'code'
      const window = BrowserWindow.fromWebContents(event.sender) ?? undefined
      const parentPath = payload.type === 'dir' ? payload.path : path.dirname(payload.path)
      const template = [
        {
          label: 'New File',
          click: () => {
            if (!window) return
            window.webContents.send('workspace:createItemPrompt', {
              scope: 'local',
              parentPath,
              type: 'file',
            })
          },
        },
        {
          label: 'New Folder',
          click: () => {
            if (!window) return
            window.webContents.send('workspace:createItemPrompt', {
              scope: 'local',
              parentPath,
              type: 'dir',
            })
          },
        },
        { type: 'separator' },
        {
          label: 'Rename',
          click: () => {
            if (!window) return
            window.webContents.send('workspace:renameItemPrompt', {
              scope: 'local',
              path: payload.path,
            })
          },
        },
        {
          label: 'Delete',
          click: () => {
            if (!window) return
            window.webContents.send('workspace:deleteItemPrompt', {
              scope: 'local',
              path: payload.path,
              type: payload.type,
            })
          },
        },
        { type: 'separator' },
        {
          label: `Open in ${codeCommand}`,
          click: () => {
            try {
              const safePath = payload.path.replace(/"/g, '\\"')
              const child = spawn(`${codeCommand} "${safePath}"`, {
                detached: true,
                stdio: 'ignore',
                shell: true,
              })
              child.unref()
            } catch {
              // ignore spawn errors; we only trigger the command
            }
          },
        },
        payload.type === 'dir'
          ? {
              label: 'Open Folder',
              click: () => {
                void shell.openPath(payload.path)
              },
            }
          : {
              label: revealLabel(),
              click: () => {
                shell.showItemInFolder(payload.path)
              },
            },
        {
          label: 'Copy Path',
          click: () => clipboard.writeText(payload.path),
        },
      ]

      if (payload.type === 'file' && payload.connectionId) {
        template.push({
          label: 'Force Upload File',
          click: async () => {
            const connection = (await listConnections()).find((item) => item.id === payload.connectionId)
            if (!connection) return
            if (!connection.localRoot || !connection.remoteRoot) return
            const relative = path.relative(connection.localRoot, payload.path)
            if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return
            let auth: { password?: string; privateKey?: string; passphrase?: string } = {}
            const authType = connection.authType ?? 'password'
            if (authType === 'password') {
              const password = await getPassword(connection.id)
              if (!password) return
              auth = { password }
            } else {
              const privateKey = await getPrivateKey(connection.id)
              const passphrase = await getPassphrase(connection.id)
              if (!privateKey) return
              auth = { privateKey, passphrase: passphrase ?? undefined }
            }
            void forceUploadFile(connection, auth, payload.path)
          },
        })
      }

      const menu = Menu.buildFromTemplate(template)
      menu.popup({ window })
      return { ok: true, message: 'Menu opened.' }
    },
  )

  ipcMain.handle(
    'workspace:showRemoteContextMenu',
    async (
      event,
      payload: { connectionId: string; path: string; type: 'file' | 'dir' },
    ) => {
      if (!payload?.path) return { ok: false, message: 'No path provided.' }
      const window = BrowserWindow.fromWebContents(event.sender) ?? undefined
      const normalizedPath = payload.path.replace(/\\/g, '/')
      const parentPath =
        payload.type === 'dir' ? normalizedPath : path.posix.dirname(normalizedPath)
      const refreshTarget =
        payload.type === 'dir' ? normalizedPath : path.posix.dirname(normalizedPath)
      const refreshLabel = payload.type === 'dir' ? 'Refresh this folder' : 'Refresh parent folder'
      const template = [
        {
          label: 'New File',
          click: () => {
            if (!window) return
            window.webContents.send('workspace:createItemPrompt', {
              scope: 'remote',
              parentPath,
              type: 'file',
            })
          },
        },
        {
          label: 'New Folder',
          click: () => {
            if (!window) return
            window.webContents.send('workspace:createItemPrompt', {
              scope: 'remote',
              parentPath,
              type: 'dir',
            })
          },
        },
        { type: 'separator' },
        {
          label: 'Rename',
          click: () => {
            if (!window) return
            window.webContents.send('workspace:renameItemPrompt', {
              scope: 'remote',
              path: normalizedPath,
            })
          },
        },
        {
          label: 'Delete',
          click: () => {
            if (!window) return
            window.webContents.send('workspace:deleteItemPrompt', {
              scope: 'remote',
              path: normalizedPath,
              type: payload.type,
            })
          },
        },
        { type: 'separator' },
        {
          label: refreshLabel,
          click: () => {
            if (!payload.connectionId) return
            void (async () => {
              const connection = (await listConnections()).find((item) => item.id === payload.connectionId)
              if (!connection) {
                notifyStatus(payload.connectionId, 'Connection not found.', 'error')
                return
              }
              if (!connection.remoteRoot) {
                notifyStatus(payload.connectionId, 'Remote root is not set.', 'error')
                return
              }
              const relative = path.posix.relative(connection.remoteRoot, refreshTarget)
              if (relative.startsWith('..')) {
                notifyStatus(payload.connectionId, 'Remote path is outside the connection root.', 'error')
                return
              }
              let auth: { password?: string; privateKey?: string; passphrase?: string } = {}
              const authType = connection.authType ?? 'password'
              if (authType === 'password') {
                const password = await getPassword(connection.id)
                if (!password) {
                  notifyStatus(payload.connectionId, 'Missing password.', 'error')
                  return
                }
                auth = { password }
              } else {
                const privateKey = await getPrivateKey(connection.id)
                const passphrase = await getPassphrase(connection.id)
                if (!privateKey) {
                  notifyStatus(payload.connectionId, 'Missing private key.', 'error')
                  return
                }
                auth = { privateKey, passphrase: passphrase ?? undefined }
              }
              const toRelative = (value: string) => {
                const resolved = value.replace(/\\/g, '/')
                const rel = path.posix.relative(connection.remoteRoot, resolved)
                if (!rel || rel === '.') return '.'
                if (rel.startsWith('..')) return resolved
                return rel
              }
              const notify = (message: string) => {
                console.log(`[remote-refresh] ${message}`)
                notifyStatus(connection.id, message, 'info')
              }
              notify(`Refreshing remote folder: ${toRelative(refreshTarget)}`)
              await refreshRemoteTree(connection, auth, refreshTarget, {
                onProgress: (targetPath) => {
                  notify(`Refreshing remote folder: ${toRelative(targetPath)}`)
                },
                onEmpty: (targetPath) => {
                  notify(`Refreshing remote folder: ${toRelative(targetPath)} (empty)`)
                },
                onError: (targetPath, error) => {
                  const detail = error instanceof Error ? error.message : 'unknown error'
                  notify(`Refreshing remote folder: failed to list ${toRelative(targetPath)} (${detail})`)
                },
              })
              notifyStatus(connection.id, 'Remote folder refreshed.', 'ok')
              event.sender.send('workspace:remoteRefresh', {
                connectionId: connection.id,
                remotePath: refreshTarget,
              })
            })()
          },
        },
        {
          label: 'Copy Remote Path',
          click: () => clipboard.writeText(normalizedPath),
        },
      ]
      const menu = Menu.buildFromTemplate(template)
      menu.popup({ window })
      return { ok: true, message: 'Menu opened.' }
    },
  )
}
