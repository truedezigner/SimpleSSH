
import { useEffect, useMemo, useState, type UIEvent } from 'react'
import './App.css'

type VerifyMode = 'sha256-remote' | 'download-back'
type AuthType = 'password' | 'key'
type SyncMode = 'manual' | 'upload' | 'live'

interface Connection {
  id: string
  name: string
  host: string
  port: number
  username: string
  authType: AuthType
  keyName: string
  remoteRoot: string
  localRoot: string
  verifyMode: VerifyMode
  syncMode: SyncMode
  liveSyncIntervalSec: number
  hostingProvider: string
  codeCommand: string
}

interface ConnectionDraft extends Omit<Connection, 'id'> {
  id?: string
}

interface FileNode {
  name: string
  path: string
  type: 'file' | 'dir'
  size?: number
  children?: FileNode[]
}

interface QueueItem {
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

interface QueueStatus {
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

type StatusKind = 'ok' | 'error' | 'info'

interface StatusMessage {
  kind: StatusKind
  message: string
}

const defaultConnection = (): ConnectionDraft => ({
  name: '',
  host: '',
  port: 22,
  username: '',
  authType: 'password',
  keyName: '',
  remoteRoot: '',
  localRoot: '',
  verifyMode: 'sha256-remote',
  syncMode: 'manual',
  liveSyncIntervalSec: 5,
  hostingProvider: 'none',
  codeCommand: 'code',
})

const sortNodes = (nodes: FileNode[]) => {
  return [...nodes].sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
    return a.name.localeCompare(b.name)
  })
}

const formatBytes = (size?: number) => {
  if (!size && size !== 0) return ''
  if (size < 1024) return `${size} B`
  const kb = size / 1024
  if (kb < 1024) return `${kb.toFixed(1)} KB`
  const mb = kb / 1024
  if (mb < 1024) return `${mb.toFixed(1)} MB`
  const gb = mb / 1024
  return `${gb.toFixed(1)} GB`
}

const splitRemotePath = (value: string) => {
  const normalized = value.replace(/\\/g, '/')
  const parts = normalized.split('/').filter(Boolean)
  if (normalized.startsWith('/')) return ['/', ...parts]
  return parts
}

const splitLocalPath = (value: string) => {
  const normalized = value.replace(/\//g, '\\')
  return normalized.split('\\').filter(Boolean)
}

const formatRelativeTime = (timestamp?: number) => {
  if (!timestamp) return ''
  const delta = Math.max(0, Date.now() - timestamp)
  if (delta < 1000) return 'now'
  const seconds = Math.floor(delta / 1000)
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

const fileBadge = (node: FileNode) => {
  if (node.type === 'dir') {
    return { label: 'dir', className: 'file-badge type-dir' }
  }
  const parts = node.name.split('.')
  const ext = parts.length > 1 ? parts.pop() ?? '' : ''
  const normalized = ext.toLowerCase()
  const map: Record<string, string> = {
    js: 'js',
    jsx: 'jsx',
    ts: 'ts',
    tsx: 'tsx',
    css: 'css',
    html: 'html',
    json: 'json',
    yml: 'yml',
    yaml: 'yml',
    md: 'md',
    env: 'env',
    sh: 'sh',
    py: 'py',
    rb: 'rb',
    go: 'go',
    java: 'java',
    c: 'c',
    cpp: 'cpp',
    php: 'php',
  }
  const typeClass = normalized && map[normalized] ? `type-${map[normalized]}` : ''
  return { label: normalized || 'file', className: `file-badge ${typeClass}`.trim() }
}

const isQueueStatus = (value: unknown): value is QueueStatus => {
  if (!value || typeof value !== 'object') return false
  return 'connectionId' in value && 'watching' in value
}

function App() {
  const [connections, setConnections] = useState<Connection[]>([])
  const [activeConnectionId, setActiveConnectionId] = useState<string | null>(null)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [editorOpen, setEditorOpen] = useState(false)
  const [workspaceView, setWorkspaceView] = useState<'local' | 'remote'>('remote')

  const [connectionDraft, setConnectionDraft] = useState<ConnectionDraft>(defaultConnection())
  const [connectionErrors, setConnectionErrors] = useState<Record<string, string>>({})
  const [password, setPassword] = useState('')
  const [privateKey, setPrivateKey] = useState('')
  const [passphrase, setPassphrase] = useState('')
  const [connectionStatus, setConnectionStatus] = useState<StatusMessage | null>(null)
  const [workspaceStatus, setWorkspaceStatus] = useState<StatusMessage | null>(null)

  const [queueStatusMap, setQueueStatusMap] = useState<Record<string, QueueStatus>>({})

  const [localColumns, setLocalColumns] = useState<FileNode[][]>([])
  const [localSelected, setLocalSelected] = useState<(FileNode | null)[]>([])
  const [remoteColumns, setRemoteColumns] = useState<FileNode[][]>([])
  const [remoteSelected, setRemoteSelected] = useState<(FileNode | null)[]>([])

  const activeConnection = useMemo(
    () => connections.find((conn) => conn.id === activeConnectionId) ?? null,
    [connections, activeConnectionId],
  )

  const queueStatus = useMemo(() => {
    if (!activeConnectionId) return null
    return queueStatusMap[activeConnectionId] ?? null
  }, [queueStatusMap, activeConnectionId])

  const conflictEntries = useMemo(() => {
    if (!queueStatus?.recent) return []
    return queueStatus.recent.filter((item) => item.note?.toLowerCase().includes('remote won'))
  }, [queueStatus])

  useEffect(() => {
    const unsubscribe = window.simpleSSH.workspace.onQueueStatus((status) => {
      if (!isQueueStatus(status)) return
      setQueueStatusMap((prev) => ({ ...prev, [status.connectionId]: status }))
    })

    void loadConnections()

    return () => {
      unsubscribe()
    }
  }, [])

  useEffect(() => {
    if (!activeConnection) return
    if (activeConnection.localRoot) {
      void loadLocalRoot(activeConnection)
    } else {
      setLocalColumns([])
      setLocalSelected([])
    }
    if (activeConnection.remoteRoot) {
      void loadRemoteRoot(activeConnection)
    } else {
      setRemoteColumns([])
      setRemoteSelected([])
    }
    void refreshQueueStatus(activeConnection.id)
  }, [activeConnection?.id, activeConnection?.localRoot, activeConnection?.remoteRoot])

  const loadConnections = async () => {
    const raw = await window.simpleSSH.connections.list()
    const list = (Array.isArray(raw) ? raw : []) as Connection[]
    setConnections(list)
    setActiveConnectionId((prev) => {
      if (prev && list.some((item) => item.id === prev)) return prev
      return list[0]?.id ?? null
    })
  }

  const refreshQueueStatus = async (connectionId: string) => {
    const status = await window.simpleSSH.workspace.getQueueStatus({ connectionId })
    if (status && isQueueStatus(status)) {
      setQueueStatusMap((prev) => ({ ...prev, [connectionId]: status }))
    }
  }

  const loadLocalRoot = async (connection: Connection) => {
    const nodes = await window.simpleSSH.workspace.list({ root: connection.localRoot, depth: 1 })
    const sorted = sortNodes((nodes ?? []) as FileNode[])
    setLocalColumns([sorted])
    setLocalSelected([])
  }

  const loadRemoteRoot = async (connection: Connection) => {
    const response = await window.simpleSSH.workspace.remoteList({
      connectionId: connection.id,
      path: connection.remoteRoot,
    })
    const nodes = (response?.nodes ?? []) as FileNode[]
    setRemoteColumns([sortNodes(nodes)])
    setRemoteSelected([])
  }

  const openEditor = async (connection?: Connection) => {
    setEditorOpen(true)
    setConnectionErrors({})
    setConnectionStatus(null)
    if (connection) {
      setConnectionDraft({ ...connection })
      if (connection.authType === 'password') {
        const stored = await window.simpleSSH.connections.getPassword(connection.id)
        setPassword(stored ?? '')
        setPrivateKey('')
        setPassphrase('')
      } else {
        const [storedKey, storedPassphrase] = await Promise.all([
          window.simpleSSH.connections.getPrivateKey(connection.id),
          window.simpleSSH.connections.getPassphrase(connection.id),
        ])
        setPrivateKey(storedKey ?? '')
        setPassphrase(storedPassphrase ?? '')
        setPassword('')
      }
    } else {
      setConnectionDraft(defaultConnection())
      setPassword('')
      setPrivateKey('')
      setPassphrase('')
    }
  }

  const validateDraft = () => {
    const errors: Record<string, string> = {}
    if (!connectionDraft.name.trim()) errors.name = 'Name is required.'
    if (!connectionDraft.host.trim()) errors.host = 'Host is required.'
    if (!connectionDraft.username.trim()) errors.username = 'Username is required.'
    if (!connectionDraft.port || connectionDraft.port <= 0) errors.port = 'Port must be a positive number.'
    if (connectionDraft.authType === 'password' && !password.trim()) {
      errors.password = 'Password is required.'
    }
    if (connectionDraft.authType === 'key' && !privateKey.trim()) {
      errors.privateKey = 'Private key is required.'
    }
    const interval = Number(connectionDraft.liveSyncIntervalSec)
    if (!Number.isFinite(interval) || interval < 1 || interval > 300) {
      errors.liveSyncIntervalSec = 'Interval must be between 1 and 300 seconds.'
    }
    return errors
  }

  const handleSaveConnection = async () => {
    const errors = validateDraft()
    setConnectionErrors(errors)
    if (Object.keys(errors).length > 0) {
      setConnectionStatus({ kind: 'error', message: 'Fix the highlighted fields first.' })
      return
    }

    const payload: ConnectionDraft = {
      ...connectionDraft,
      liveSyncIntervalSec: Number(connectionDraft.liveSyncIntervalSec),
      port: Number(connectionDraft.port),
    }
    const result = await window.simpleSSH.connections.upsert({
      connection: payload,
      password: connectionDraft.authType === 'password' ? password : undefined,
      privateKey: connectionDraft.authType === 'key' ? privateKey : undefined,
      passphrase: connectionDraft.authType === 'key' ? passphrase : undefined,
    })

    if (result && typeof result === 'object' && 'id' in result) {
      await loadConnections()
      setActiveConnectionId((result as Connection).id)
      setConnectionStatus({ kind: 'ok', message: 'Connection saved.' })
      if (queueStatusMap[(result as Connection).id]?.watching) {
        await window.simpleSSH.workspace.startWatch({ connectionId: (result as Connection).id })
      }
    } else {
      setConnectionStatus({ kind: 'error', message: 'Failed to save connection.' })
    }
  }

  const handleDeleteConnection = async () => {
    if (!connectionDraft.id) return
    await window.simpleSSH.connections.delete(connectionDraft.id)
    await loadConnections()
    setEditorOpen(false)
    setConnectionStatus({ kind: 'ok', message: 'Connection deleted.' })
  }

  const handleTestConnection = async () => {
    setConnectionStatus({ kind: 'info', message: 'Testing connection...' })
    const payload: ConnectionDraft = {
      ...connectionDraft,
      liveSyncIntervalSec: Number(connectionDraft.liveSyncIntervalSec),
      port: Number(connectionDraft.port),
    }
    const response = await window.simpleSSH.connections.test({
      ...payload,
      password: connectionDraft.authType === 'password' ? password : undefined,
      privateKey: connectionDraft.authType === 'key' ? privateKey : undefined,
      passphrase: connectionDraft.authType === 'key' ? passphrase : undefined,
    })
    if (response?.ok) {
      setConnectionStatus({ kind: 'ok', message: response.message || 'Connection ok.' })
    } else {
      setConnectionStatus({ kind: 'error', message: response?.message || 'Connection failed.' })
    }
  }

  const handleGenerateKeyPair = async () => {
    setConnectionStatus({ kind: 'info', message: 'Generating key pair...' })
    const response = await window.simpleSSH.connections.generateKeyPair({
      keyName: connectionDraft.keyName?.trim(),
      passphrase: passphrase,
      comment: connectionDraft.name?.trim() || undefined,
    })
    if (!response?.ok) {
      setConnectionStatus({ kind: 'error', message: response?.message || 'Key generation failed.' })
      return
    }
    if (response.privateKey) {
      setPrivateKey(response.privateKey)
    }
    setConnectionStatus({ kind: 'ok', message: response.message || 'Key generated.' })
  }

  const handleSync = async () => {
    if (!activeConnection) return
    setWorkspaceStatus({ kind: 'info', message: 'Syncing remote to local...' })
    const result = await window.simpleSSH.workspace.sync({ connectionId: activeConnection.id })
    if (result?.ok) {
      setWorkspaceStatus({ kind: 'ok', message: result.message || 'Sync complete.' })
      await loadLocalRoot(activeConnection)
    } else {
      setWorkspaceStatus({ kind: 'error', message: result?.message || 'Sync failed.' })
    }
  }

  const handleForcePush = async () => {
    if (!activeConnection) return
    setWorkspaceStatus({ kind: 'info', message: 'Force push queued...' })
    const result = await window.simpleSSH.workspace.forcePush({ connectionId: activeConnection.id })
    if (result?.ok) {
      setWorkspaceStatus({ kind: 'ok', message: result.message || 'Force push queued.' })
      if (isQueueStatus(result.status)) {
        setQueueStatusMap((prev) => ({ ...prev, [activeConnection.id]: result.status }))
      }
    } else {
      setWorkspaceStatus({ kind: 'error', message: result?.message || 'Force push failed.' })
    }
  }

  const handleToggleWatcher = async () => {
    if (!activeConnection) return
    if (activeConnection.syncMode === 'manual') {
      setWorkspaceStatus({ kind: 'error', message: 'Sync mode is manual. Switch to upload or live.' })
      return
    }
    if (queueStatus?.watching) {
      const result = await window.simpleSSH.workspace.stopWatch({ connectionId: activeConnection.id })
      if (result?.ok) {
        setWorkspaceStatus({ kind: 'ok', message: result.message || 'Auto sync stopped.' })
      } else {
        setWorkspaceStatus({ kind: 'error', message: result?.message || 'Failed to stop auto sync.' })
      }
    } else {
      const result = await window.simpleSSH.workspace.startWatch({ connectionId: activeConnection.id })
      if (result?.ok) {
        setWorkspaceStatus({ kind: 'ok', message: result.message || 'Auto sync started.' })
        if (isQueueStatus(result.status)) {
          setQueueStatusMap((prev) => ({ ...prev, [activeConnection.id]: result.status }))
        }
      } else {
        setWorkspaceStatus({ kind: 'error', message: result?.message || 'Failed to start auto sync.' })
      }
    }
  }

  const handleRefreshCurrent = async () => {
    if (!activeConnection) return
    if (workspaceView === 'local') {
      await loadLocalRoot(activeConnection)
    } else {
      await loadRemoteRoot(activeConnection)
    }
  }

  const handleScrollVisibility = (event: UIEvent<HTMLDivElement>) => {
    const target = event.currentTarget as HTMLDivElement & { _scrollTimeout?: number }
    target.classList.add('scrolling')
    if (target._scrollTimeout) {
      window.clearTimeout(target._scrollTimeout)
    }
    target._scrollTimeout = window.setTimeout(() => {
      target.classList.remove('scrolling')
    }, 700)
  }

  const handleDownloadRemoteFile = async (node: FileNode) => {
    if (!activeConnection) return
    const result = await window.simpleSSH.workspace.downloadRemoteFile({
      connectionId: activeConnection.id,
      remotePath: node.path,
    })
    if (result?.ok) {
      setWorkspaceStatus({ kind: 'ok', message: 'Downloaded remote file.' })
    } else {
      setWorkspaceStatus({ kind: 'error', message: result?.message || 'Download failed.' })
    }
  }

  const handleOpenLocalFile = async (node: FileNode) => {
    if (!activeConnection) return
    const result = await window.simpleSSH.workspace.openInEditor({
      path: node.path,
      codeCommand: activeConnection.codeCommand,
    })
    if (result?.ok) {
      setWorkspaceStatus({ kind: 'ok', message: result.message || 'Opened in editor.' })
    } else {
      setWorkspaceStatus({ kind: 'error', message: result?.message || 'Failed to open editor.' })
    }
  }

  const handleShowContext = async (node: FileNode) => {
    if (!activeConnection) return
    await window.simpleSSH.workspace.showContextMenu({
      path: node.path,
      type: node.type,
      codeCommand: activeConnection.codeCommand,
    })
  }

  const handleLocalSelect = async (node: FileNode, columnIndex: number) => {
    setLocalSelected((prev) => {
      const next = prev.slice(0, columnIndex)
      next[columnIndex] = node
      return next
    })

    if (node.type === 'dir') {
      const children = await window.simpleSSH.workspace.list({ root: node.path, depth: 1 })
      const sorted = sortNodes((children ?? []) as FileNode[])
      setLocalColumns((prev) => {
        const base = prev.slice(0, columnIndex + 1)
        return [...base, sorted]
      })
    } else {
      setLocalColumns((prev) => prev.slice(0, columnIndex + 1))
    }
  }

  const handleRemoteSelect = async (node: FileNode, columnIndex: number) => {
    setRemoteSelected((prev) => {
      const next = prev.slice(0, columnIndex)
      next[columnIndex] = node
      return next
    })

    if (!activeConnection) return
    if (node.type === 'dir') {
      const response = await window.simpleSSH.workspace.remoteList({
        connectionId: activeConnection.id,
        path: node.path,
      })
      const nodes = sortNodes((response?.nodes ?? []) as FileNode[])
      setRemoteColumns((prev) => {
        const base = prev.slice(0, columnIndex + 1)
        return [...base, nodes]
      })
    } else {
      setRemoteColumns((prev) => prev.slice(0, columnIndex + 1))
    }
  }

  const localPath = useMemo(() => {
    const selected = [...localSelected].reverse().find((node) => node)
    return selected?.path ?? activeConnection?.localRoot ?? ''
  }, [localSelected, activeConnection?.localRoot])

  const remotePath = useMemo(() => {
    const selected = [...remoteSelected].reverse().find((node) => node)
    return selected?.path ?? activeConnection?.remoteRoot ?? ''
  }, [remoteSelected, activeConnection?.remoteRoot])

  const breadcrumbSegments = useMemo(() => {
    if (workspaceView === 'remote') return splitRemotePath(remotePath)
    return splitLocalPath(localPath)
  }, [workspaceView, localPath, remotePath])

  const queueItems = queueStatus?.recent ?? []
  const connectionStatusLabel = !activeConnection
    ? 'Connection: disconnected'
    : `Connection: ${activeConnection.name || activeConnection.host}`
  const syncStateLabel = (() => {
    if (!activeConnection) return 'Sync: offline'
    if (queueStatus?.lastPhase) {
      switch (queueStatus.lastPhase) {
        case 'uploading':
          return 'Sync: transferring'
        case 'verifying':
          return 'Sync: verifying'
        case 'deleting':
          return 'Sync: deleting'
        case 'complete':
          return 'Sync: complete'
        case 'failed':
          return 'Sync: error'
        default:
          return 'Sync: active'
      }
    }
    return queueStatus?.watching ? 'Sync: watching' : 'Sync: idle'
  })()

  return (
    <div className='app-shell'>
      <div className='topbar'>
        <div className='brand'>
          <div className='brand-mark'>S</div>
          <div>
            <div className='brand-title-row'>
              <div className='brand-name'>
                {activeConnection ? activeConnection.name || activeConnection.host : 'SimpleSSH'}
              </div>
              {activeConnection?.hostingProvider && activeConnection.hostingProvider !== 'none' && (
                <div className='provider-tag'>{activeConnection.hostingProvider}</div>
              )}
            </div>
            <div className='brand-tag'>
              {activeConnection?.hostingProvider && activeConnection.hostingProvider !== 'none'
                ? activeConnection.hostingProvider
                : 'Remote-first sync workspace'}
            </div>
          </div>
        </div>
        <div className='topbar-center'>
          <div className='section-tabs'>
            <button
              className={`section-tab ${workspaceView === 'remote' ? 'active' : ''}`}
              onClick={() => setWorkspaceView('remote')}
            >
              Remote
            </button>
            <button
              className={`section-tab ${workspaceView === 'local' ? 'active' : ''}`}
              onClick={() => setWorkspaceView('local')}
            >
              Local
            </button>
            <button
              className='section-tab icon'
              onClick={handleRefreshCurrent}
              disabled={!activeConnection}
              aria-label='Reload workspace'
              title='Reload workspace'
            >
              ↻
            </button>
          </div>
        </div>
        <div className='top-actions'>
          <button className='primary' onClick={handleSync} disabled={!activeConnection}>
            Sync
          </button>
          <button className='ghost' onClick={handleForcePush} disabled={!activeConnection}>
            Force Push
          </button>
          <button className='ghost' onClick={handleToggleWatcher} disabled={!activeConnection}>
            {queueStatus?.watching ? 'Auto Sync On' : 'Auto Sync Off'}
          </button>
          <button className='ghost' onClick={() => setDrawerOpen((prev) => !prev)}>
            Connections
          </button>
        </div>
      </div>

      <div className='stage'>
        <div className='panel workspace'>
          <div className='workspace-tree column-view'>
            <div className='column-shell'>
              <div className='breadcrumb-bar'>
                {breadcrumbSegments.length === 0 && <span className='breadcrumb-label'>No path selected</span>}
                {breadcrumbSegments.map((segment, index) => (
                  <div className='breadcrumb-seg' key={`${segment}-${index}`}>
                    <span className='breadcrumb-label'>{segment}</span>
                  </div>
                ))}
              </div>
              <div className='column-grid'>
                {(workspaceView === 'local' ? localColumns : remoteColumns).map((column, columnIndex) => (
                    <div className={`column ${columnIndex > 0 ? 'linked' : ''}`} key={`col-${columnIndex}`}>
                      <div className='column-list scroll-hide' onScroll={handleScrollVisibility}>
                        {column.map((node) => {
                          const isActive =
                            workspaceView === 'local'
                              ? localSelected[columnIndex]?.path === node.path
                              : remoteSelected[columnIndex]?.path === node.path
                          const badge = fileBadge(node)
                          return (
                            <div
                              key={node.path}
                              className={`column-item ${node.type} ${isActive ? 'active' : ''}`}
                              onClick={() =>
                              workspaceView === 'local'
                                ? void handleLocalSelect(node, columnIndex)
                                : void handleRemoteSelect(node, columnIndex)
                            }
                            onDoubleClick={() => {
                              if (workspaceView === 'local' && node.type === 'file') {
                                void handleOpenLocalFile(node)
                              }
                              if (workspaceView === 'remote' && node.type === 'file') {
                                void handleDownloadRemoteFile(node)
                              }
                            }}
                            onContextMenu={() => {
                              if (workspaceView === 'local') void handleShowContext(node)
                            }}
                          >
                            <span className={badge.className}>{badge.label}</span>
                            <div className='column-name'>{node.name}</div>
                            {node.type === 'file' && <div className='column-size'>{formatBytes(node.size)}</div>}
                          </div>
                        )
                      })}
                      {column.length === 0 && <div className='empty'>Empty</div>}
                    </div>
                  </div>
                ))}
                {(workspaceView === 'local' ? localColumns : remoteColumns).length === 0 && (
                  <div className='empty'>
                    <div>No items loaded yet.</div>
                    <div>Select a connection and refresh the workspace.</div>
                  </div>
                )}
              </div>
            </div>
          </div>

        </div>
      </div>

      <div className='status-strip status-bottom'>
        <div className='status-chip'>{connectionStatusLabel}</div>
        <div className='status-chip'>{syncStateLabel}</div>
        <div className='status-chip'>
          Queue: {queueStatus ? `${queueStatus.pending} pending, ${queueStatus.active} active` : 'Idle'}
        </div>
        {workspaceStatus && (
          <div className={`status-chip ${workspaceStatus.kind}`}>{workspaceStatus.message}</div>
        )}
      </div>

        <div
          className={`connections-drawer scroll-hide ${drawerOpen ? 'open' : ''}`}
          onScroll={handleScrollVisibility}
        >
        <div className='connections-header'>
          <div className='panel-title'>Connections</div>
          <div className='connections-actions'>
            <button className='ghost' onClick={() => openEditor()}>
              New
            </button>
            <button
              className='ghost'
              onClick={async () => {
                const result = await window.simpleSSH.connections.import()
                setConnectionStatus({
                  kind: result?.ok ? 'ok' : 'error',
                  message: result?.message || 'Import completed.',
                })
                await loadConnections()
              }}
            >
              Import
            </button>
            <button
              className='ghost'
              onClick={async () => {
                const result = await window.simpleSSH.connections.export()
                setConnectionStatus({
                  kind: result?.ok ? 'ok' : 'error',
                  message: result?.message || 'Export completed.',
                })
              }}
            >
              Export
            </button>
            <button className='ghost' onClick={() => setDrawerOpen(false)}>
              Close
            </button>
          </div>
        </div>

        <div className='connection-list scroll-hide' onScroll={handleScrollVisibility}>
          {connections.length === 0 && <div className='empty'>No connections yet.</div>}
          {connections.map((connection) => (
            <div
              key={connection.id}
              className={`connection-card ${connection.id === activeConnectionId ? 'active' : ''}`}
              onClick={() => setActiveConnectionId(connection.id)}
            >
              <div>
                <div className='card-title'>{connection.name || connection.host}</div>
                <div className='card-sub'>
                  {connection.username}@{connection.host}:{connection.port}
                </div>
                <div className='card-meta'>
                  {connection.syncMode}
                  {connection.syncMode === 'live' && ` / ${connection.liveSyncIntervalSec}s`}
                </div>
              </div>
              <button
                className='icon-button'
                onClick={(event) => {
                  event.stopPropagation()
                  void openEditor(connection)
                }}
              >
                Edit
              </button>
            </div>
          ))}
        </div>

        {editorOpen && (
          <div className='panel'>
            <div className='panel-title'>Connection Editor</div>
            <div className='grid'>
              <label>
                Name
                <input
                  value={connectionDraft.name}
                  onChange={(event) => setConnectionDraft((prev) => ({ ...prev, name: event.target.value }))}
                  placeholder='NameHero - Site A'
                />
                {connectionErrors.name && <div className='error'>{connectionErrors.name}</div>}
              </label>
              <label>
                Host
                <input
                  value={connectionDraft.host}
                  onChange={(event) => setConnectionDraft((prev) => ({ ...prev, host: event.target.value }))}
                  placeholder='server.example.com'
                />
                {connectionErrors.host && <div className='error'>{connectionErrors.host}</div>}
              </label>
              <label>
                Port
                <input
                  type='number'
                  value={connectionDraft.port}
                  onChange={(event) =>
                    setConnectionDraft((prev) => ({ ...prev, port: Number(event.target.value) }))
                  }
                />
                {connectionErrors.port && <div className='error'>{connectionErrors.port}</div>}
              </label>
              <label>
                Username
                <input
                  value={connectionDraft.username}
                  onChange={(event) => setConnectionDraft((prev) => ({ ...prev, username: event.target.value }))}
                />
                {connectionErrors.username && <div className='error'>{connectionErrors.username}</div>}
              </label>
              <label>
                Auth Type
                <select
                  value={connectionDraft.authType}
                  onChange={(event) =>
                    setConnectionDraft((prev) => ({ ...prev, authType: event.target.value as AuthType }))
                  }
                >
                  <option value='password'>Password</option>
                  <option value='key'>SSH Key</option>
                </select>
              </label>
              <label>
                Key Name
                <input
                  value={connectionDraft.keyName}
                  onChange={(event) => setConnectionDraft((prev) => ({ ...prev, keyName: event.target.value }))}
                />
              </label>
              <label>
                Remote Root
                <input
                  value={connectionDraft.remoteRoot}
                  onChange={(event) => setConnectionDraft((prev) => ({ ...prev, remoteRoot: event.target.value }))}
                  placeholder='/home/user/public_html'
                />
              </label>
              <label>
                Local Root
                <div className='workspace-row'>
                  <input
                    value={connectionDraft.localRoot}
                    onChange={(event) => setConnectionDraft((prev) => ({ ...prev, localRoot: event.target.value }))}
                    placeholder='C:\\Users\\you\\SiteA'
                  />
                  <button
                    className='ghost small'
                    onClick={async () => {
                      const folder = await window.simpleSSH.workspace.pickFolder()
                      if (folder) {
                        setConnectionDraft((prev) => ({ ...prev, localRoot: folder }))
                      }
                    }}
                  >
                    Pick
                  </button>
                </div>
              </label>
              <label>
                Verify Mode
                <select
                  value={connectionDraft.verifyMode}
                  onChange={(event) =>
                    setConnectionDraft((prev) => ({ ...prev, verifyMode: event.target.value as VerifyMode }))
                  }
                >
                  <option value='sha256-remote'>sha256-remote</option>
                  <option value='download-back'>download-back</option>
                </select>
              </label>
              <label>
                Sync Mode
                <select
                  value={connectionDraft.syncMode}
                  onChange={(event) =>
                    setConnectionDraft((prev) => ({ ...prev, syncMode: event.target.value as SyncMode }))
                  }
                >
                  <option value='manual'>manual</option>
                  <option value='upload'>upload</option>
                  <option value='live'>live</option>
                </select>
              </label>
              <label>
                Live Interval (sec)
                <input
                  type='number'
                  min={1}
                  max={300}
                  value={connectionDraft.liveSyncIntervalSec}
                  onChange={(event) =>
                    setConnectionDraft((prev) => ({ ...prev, liveSyncIntervalSec: Number(event.target.value) }))
                  }
                />
                {connectionErrors.liveSyncIntervalSec && (
                  <div className='error'>{connectionErrors.liveSyncIntervalSec}</div>
                )}
              </label>
              <label>
                Hosting Provider
                <input
                  value={connectionDraft.hostingProvider}
                  onChange={(event) =>
                    setConnectionDraft((prev) => ({ ...prev, hostingProvider: event.target.value }))
                  }
                />
              </label>
              <label>
                Code Command
                <input
                  value={connectionDraft.codeCommand}
                  onChange={(event) => setConnectionDraft((prev) => ({ ...prev, codeCommand: event.target.value }))}
                  placeholder='code'
                />
              </label>

              {connectionDraft.authType === 'password' && (
                <label className='password-row'>
                  Password
                  <div className='password-wrap'>
                    <input
                      type='password'
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                      placeholder='Stored in keychain'
                    />
                    <button
                      className='ghost small'
                      onClick={async () => {
                        if (!connectionDraft.id) return
                        await window.simpleSSH.connections.clearPassword(connectionDraft.id)
                        setPassword('')
                      }}
                    >
                      Clear
                    </button>
                  </div>
                  {connectionErrors.password && <div className='error'>{connectionErrors.password}</div>}
                </label>
              )}

              {connectionDraft.authType === 'key' && (
                <label className='password-row'>
                  Private Key
                  <div className='password-wrap'>
                    <textarea
                      value={privateKey}
                      onChange={(event) => setPrivateKey(event.target.value)}
                      placeholder='Paste private key'
                    />
                    <div className='stack-actions'>
                      <button
                        className='ghost small'
                        onClick={() => void handleGenerateKeyPair()}
                        disabled={!connectionDraft.keyName || !passphrase}
                      >
                        Generate
                      </button>
                      <button
                        className='ghost small'
                        onClick={async () => {
                          if (!connectionDraft.id) return
                          await window.simpleSSH.connections.clearPrivateKey(connectionDraft.id)
                          setPrivateKey('')
                        }}
                      >
                        Clear Key
                      </button>
                    </div>
                  </div>
                  {connectionErrors.privateKey && <div className='error'>{connectionErrors.privateKey}</div>}
                </label>
              )}

              {connectionDraft.authType === 'key' && (
                <label className='password-row'>
                  Passphrase
                  <div className='password-wrap'>
                    <input
                      type='password'
                      value={passphrase}
                      onChange={(event) => setPassphrase(event.target.value)}
                      placeholder='Optional passphrase'
                    />
                    <button
                      className='ghost small'
                      onClick={async () => {
                        if (!connectionDraft.id) return
                        await window.simpleSSH.connections.clearPassphrase(connectionDraft.id)
                        setPassphrase('')
                      }}
                    >
                      Clear
                    </button>
                  </div>
                </label>
              )}
            </div>

            <div className='form-actions'>
              <button className='primary' onClick={() => void handleSaveConnection()}>
                Save
              </button>
              <button className='ghost' onClick={() => void handleTestConnection()}>
                Test
              </button>
              <button className='ghost' onClick={() => setEditorOpen(false)}>
                Close
              </button>
              {connectionDraft.id && (
                <button className='ghost' onClick={() => void handleDeleteConnection()}>
                  Delete
                </button>
              )}
            </div>

            {connectionStatus && (
              <div className={`status ${connectionStatus.kind}`}>{connectionStatus.message}</div>
            )}
          </div>
        )}
        {!editorOpen && <div className='sidebar-hint'>Select a connection to edit.</div>}
      </div>
    </div>
  )
}

export default App
