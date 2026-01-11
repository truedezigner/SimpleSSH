
import { useEffect, useMemo, useRef, useState, type UIEvent } from 'react'
import Editor, { loader, type OnMount } from '@monaco-editor/react'
import type { editor as MonacoEditor } from 'monaco-editor'

loader.config({ paths: { vs: '/node_modules/monaco-editor/min/vs' } })
import './App.css'

type VerifyMode = 'sha256-remote' | 'download-back'
type AuthType = 'password' | 'key'
type SyncMode = 'manual' | 'upload' | 'live'
type EditorPreference = 'built-in' | 'external'
type EditorLayout = 'full' | 'split'

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
  editorPreference: EditorPreference
  editorLayout: EditorLayout
  editorLayoutShortcut: string
  editorFontSize: number
  editorTabSize: number
  editorSoftTabs: boolean
  editorWordWrap: boolean
  remoteIndexOnConnect: boolean
  remotePinThreshold: number
  remotePinnedMaxEntries: number
  remoteFirstEditing: boolean
  foldersFirst: boolean
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

interface CreateDraft {
  scope: 'local' | 'remote'
  parentPath: string
  columnIndex: number
  type: 'file' | 'dir'
  name: string
}

interface RenameDraft {
  scope: 'local' | 'remote'
  path: string
  columnIndex: number
  type: 'file' | 'dir'
  name: string
  originalName: string
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
  editorPreference: 'external',
  editorLayout: 'full',
  editorLayoutShortcut: 'Ctrl+Shift+L',
  editorFontSize: 14,
  editorTabSize: 2,
  editorSoftTabs: true,
  editorWordWrap: false,
  remoteIndexOnConnect: true,
  remotePinThreshold: 3,
  remotePinnedMaxEntries: 200,
  remoteFirstEditing: false,
  foldersFirst: true,
})

const sortNodes = (nodes: FileNode[], options?: { foldersFirst?: boolean }) => {
  const foldersFirst = options?.foldersFirst ?? true
  return [...nodes].sort((a, b) => {
    if (foldersFirst && a.type !== b.type) return a.type === 'dir' ? -1 : 1
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

const normalizeLocalPath = (value: string) => value.replace(/\//g, '\\')
const normalizeRemotePath = (value: string) => value.replace(/\\/g, '/')

const ensureLocalRoot = (value: string) => (value.endsWith(':') ? `${value}\\` : value)

const trimLocalTrailing = (value: string) => value.replace(/[\\/]+$/, '')
const trimRemoteTrailing = (value: string) => value.replace(/\/+$/, '') || '/'

const getLocalRelativePath = (root: string, target: string) => {
  if (!root) return null
  const normalizedRoot = trimLocalTrailing(ensureLocalRoot(normalizeLocalPath(root)))
  const normalizedTarget = trimLocalTrailing(normalizeLocalPath(target))
  const rootLower = normalizedRoot.toLowerCase()
  const targetLower = normalizedTarget.toLowerCase()
  if (targetLower === rootLower) return ''
  if (targetLower.startsWith(`${rootLower}\\`)) {
    return normalizedTarget.slice(normalizedRoot.length).replace(/^[\\/]+/, '')
  }
  return null
}

const getRemoteRelativePath = (root: string, target: string) => {
  if (!root) return null
  const normalizedRoot = trimRemoteTrailing(normalizeRemotePath(root))
  const normalizedTarget = trimRemoteTrailing(normalizeRemotePath(target))
  if (normalizedRoot === '/') {
    if (normalizedTarget === '/') return ''
    return normalizedTarget.replace(/^\/+/, '')
  }
  if (normalizedTarget === normalizedRoot) return ''
  if (normalizedTarget.startsWith(`${normalizedRoot}/`)) {
    return normalizedTarget.slice(normalizedRoot.length).replace(/^\/+/, '')
  }
  return null
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

const fileNameFromPath = (value: string) => {
  const normalized = value.replace(/\\/g, '/')
  const parts = normalized.split('/').filter(Boolean)
  return parts[parts.length - 1] ?? value
}

const buildLocalBreadcrumbPaths = (value: string) => {
  const parts = splitLocalPath(value)
  if (parts.length === 0) return []
  let current = parts[0]
  if (current.endsWith(':')) {
    current = `${current}\\`
  }
  const paths = [current]
  for (let index = 1; index < parts.length; index += 1) {
    const next = parts[index]
    current = `${current.replace(/[\\/]+$/, '')}\\${next}`
    paths.push(current)
  }
  return paths
}

const buildRemoteBreadcrumbPaths = (value: string) => {
  const parts = splitRemotePath(value)
  if (parts.length === 0) return []
  let current = parts[0] === '/' ? '/' : parts[0]
  const paths = [current]
  for (let index = 1; index < parts.length; index += 1) {
    const next = parts[index]
    current = current === '/' ? `/${next}` : `${current}/${next}`
    paths.push(current)
  }
  return paths
}

const buildLocalBreadcrumbs = (root: string, value: string) => {
  if (!value) return { segments: [], paths: [] }
  if (!root) {
    return { segments: splitLocalPath(value), paths: buildLocalBreadcrumbPaths(value) }
  }
  const relative = getLocalRelativePath(root, value)
  if (relative === null) {
    return { segments: splitLocalPath(value), paths: buildLocalBreadcrumbPaths(value) }
  }
  const rootPath = ensureLocalRoot(normalizeLocalPath(root))
  const relativeParts = splitLocalPath(relative)
  const rootLabel = fileNameFromPath(rootPath) || rootPath
  const segments = [rootLabel, ...relativeParts]
  const paths = [rootPath]
  let current = rootPath
  for (const next of relativeParts) {
    current = `${current.replace(/[\\/]+$/, '')}\\${next}`
    paths.push(current)
  }
  return { segments, paths }
}

const buildRemoteBreadcrumbs = (root: string, value: string) => {
  if (!value) return { segments: [], paths: [] }
  if (!root) {
    return { segments: splitRemotePath(value), paths: buildRemoteBreadcrumbPaths(value) }
  }
  const relative = getRemoteRelativePath(root, value)
  if (relative === null) {
    return { segments: splitRemotePath(value), paths: buildRemoteBreadcrumbPaths(value) }
  }
  const rootPath = trimRemoteTrailing(normalizeRemotePath(root))
  const relativeParts = relative ? relative.split('/').filter(Boolean) : []
  const rootLabel = rootPath === '/' ? '/' : fileNameFromPath(rootPath)
  const segments = [rootLabel || rootPath, ...relativeParts]
  const paths = [rootPath]
  let current = rootPath
  for (const next of relativeParts) {
    current = current === '/' ? `/${next}` : `${current}/${next}`
    paths.push(current)
  }
  return { segments, paths }
}

const editorLanguageForName = (name: string) => {
  const ext = name.split('.').pop()?.toLowerCase()
  if (!ext || ext === name) return 'plaintext'
  const map: Record<string, string> = {
    js: 'javascript',
    jsx: 'javascript',
    ts: 'typescript',
    tsx: 'typescript',
    json: 'json',
    css: 'css',
    scss: 'scss',
    html: 'html',
    yml: 'yaml',
    yaml: 'yaml',
    md: 'markdown',
    sh: 'shell',
    bash: 'shell',
    zsh: 'shell',
    py: 'python',
    rb: 'ruby',
    go: 'go',
    java: 'java',
    c: 'c',
    cpp: 'cpp',
    rs: 'rust',
    php: 'php',
    xml: 'xml',
  }
  return map[ext] ?? 'plaintext'
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

const defaultEditorLayoutShortcut = 'Ctrl+Shift+L'

const parseShortcut = (value: string) => {
  const tokens = value
    .split('+')
    .map((part) => part.trim())
    .filter(Boolean)
  if (tokens.length === 0) return null

  const spec = {
    ctrl: false,
    meta: false,
    alt: false,
    shift: false,
    code: '',
    key: '',
  }

  const keyTokenToCode = (token: string) => {
    if (token.length === 1) {
      const upper = token.toUpperCase()
      if (upper >= 'A' && upper <= 'Z') return `Key${upper}`
      if (upper >= '0' && upper <= '9') return `Digit${upper}`
      return ''
    }
    const normalized = token.toLowerCase()
    const keyMap: Record<string, string> = {
      space: 'Space',
      spacebar: 'Space',
      enter: 'Enter',
      return: 'Enter',
      escape: 'Escape',
      esc: 'Escape',
      tab: 'Tab',
      backspace: 'Backspace',
    }
    if (keyMap[normalized]) return keyMap[normalized]
    if (normalized.startsWith('key') && normalized.length === 4) {
      return `Key${normalized.slice(3).toUpperCase()}`
    }
    return ''
  }

  for (const token of tokens) {
    const normalized = token.toLowerCase()
    if (normalized === 'ctrl' || normalized === 'control') {
      spec.ctrl = true
      continue
    }
    if (normalized === 'cmd' || normalized === 'command' || normalized === 'meta' || normalized === 'super') {
      spec.meta = true
      continue
    }
    if (normalized === 'alt' || normalized === 'option') {
      spec.alt = true
      continue
    }
    if (normalized === 'shift') {
      spec.shift = true
      continue
    }
    if (spec.code || spec.key) return null
    spec.code = keyTokenToCode(token)
    spec.key = normalized
  }

  if (!spec.code && !spec.key) return null
  return spec
}

const isEditableTarget = (target: EventTarget | null) => {
  if (!target || !(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  const tag = target.tagName.toLowerCase()
  return tag === 'input' || tag === 'textarea' || tag === 'select'
}

function App() {
  const [connections, setConnections] = useState<Connection[]>([])
  const [activeConnectionId, setActiveConnectionId] = useState<string | null>(null)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [editorOpen, setEditorOpen] = useState(false)
  const [workspaceView, setWorkspaceView] = useState<'local' | 'remote'>('remote')
  const [queuePanelOpen, setQueuePanelOpen] = useState(false)
  const [queueFilter, setQueueFilter] = useState<'all' | 'active' | 'failed' | 'complete'>('all')
  const [addMenuColumnIndex, setAddMenuColumnIndex] = useState<number | null>(null)
  const [createDraft, setCreateDraft] = useState<CreateDraft | null>(null)
  const [renameDraft, setRenameDraft] = useState<RenameDraft | null>(null)
  const [deleteConfirm, setDeleteConfirm] = useState<{
    scope: 'local' | 'remote'
    path: string
    type?: 'file' | 'dir'
  } | null>(null)

  const [connectionDraft, setConnectionDraft] = useState<ConnectionDraft>(defaultConnection())
  const [connectionErrors, setConnectionErrors] = useState<Record<string, string>>({})
  const [password, setPassword] = useState('')
  const [privateKey, setPrivateKey] = useState('')
  const [passphrase, setPassphrase] = useState('')
  const [statusMessage, setStatusMessage] = useState<StatusMessage | null>(null)
  const [builtInEditorPath, setBuiltInEditorPath] = useState<string | null>(null)
  const [builtInEditorName, setBuiltInEditorName] = useState('')
  const [builtInEditorContent, setBuiltInEditorContent] = useState('')
  const [builtInEditorSavedContent, setBuiltInEditorSavedContent] = useState('')
  const [builtInEditorLoading, setBuiltInEditorLoading] = useState(false)
  const [builtInEditorSaving, setBuiltInEditorSaving] = useState(false)
  const [builtInEditorError, setBuiltInEditorError] = useState<string | null>(null)

  const [queueStatusMap, setQueueStatusMap] = useState<Record<string, QueueStatus>>({})

  const [localColumns, setLocalColumns] = useState<FileNode[][]>([])
  const [localSelected, setLocalSelected] = useState<(FileNode | null)[]>([])
  const [remoteColumns, setRemoteColumns] = useState<FileNode[][]>([])
  const [remoteSelected, setRemoteSelected] = useState<(FileNode | null)[]>([])
  const [localBasePath, setLocalBasePath] = useState('')
  const [remoteBasePath, setRemoteBasePath] = useState('')

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

  const builtInEditorDirty = Boolean(
    builtInEditorPath && builtInEditorContent !== builtInEditorSavedContent,
  )

  const builtInEditorLanguage = useMemo(
    () => editorLanguageForName(builtInEditorName),
    [builtInEditorName],
  )

  const builtInEditorOptions = useMemo(
    () => ({
      fontSize: activeConnection?.editorFontSize ?? 14,
      tabSize: activeConnection?.editorTabSize ?? 2,
      insertSpaces: activeConnection?.editorSoftTabs ?? true,
      wordWrap: activeConnection?.editorWordWrap ? 'on' : 'off',
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      fontFamily: `'JetBrains Mono', 'Fira Code', 'SF Mono', monospace`,
    }),
    [
      activeConnection?.editorFontSize,
      activeConnection?.editorTabSize,
      activeConnection?.editorSoftTabs,
      activeConnection?.editorWordWrap,
    ],
  )

  const editorLayout = activeConnection?.editorLayout ?? 'full'
  const editorLayoutShortcut =
    activeConnection?.editorLayoutShortcut?.trim() || defaultEditorLayoutShortcut
  const editorLayoutLabel = editorLayout === 'full' ? 'Split 30/70' : 'Full width'
  const editorLayoutShortcutSpec = useMemo(
    () => parseShortcut(editorLayoutShortcut) ?? parseShortcut(defaultEditorLayoutShortcut),
    [editorLayoutShortcut],
  )

  const activeConnectionIdRef = useRef<string | null>(null)
  const activeConnectionRef = useRef<Connection | null>(null)
  const connectionDraftIdRef = useRef<string | null>(null)
  const remoteSelectedRef = useRef<(FileNode | null)[]>([])
  const addMenuRef = useRef<HTMLDivElement | null>(null)
  const createDraftInputRef = useRef<HTMLInputElement | null>(null)
  const renameDraftInputRef = useRef<HTMLInputElement | null>(null)
  const builtInEditorRef = useRef<MonacoEditor.IStandaloneCodeEditor | null>(null)

  useEffect(() => {
    activeConnectionIdRef.current = activeConnectionId
  }, [activeConnectionId])

  useEffect(() => {
    activeConnectionRef.current = activeConnection
  }, [activeConnection])

  useEffect(() => {
    connectionDraftIdRef.current = connectionDraft.id ?? null
  }, [connectionDraft.id])

  useEffect(() => {
    remoteSelectedRef.current = remoteSelected
  }, [remoteSelected])

  useEffect(() => {
    if (addMenuColumnIndex === null) return
    const handleClick = (event: MouseEvent) => {
      if (!addMenuRef.current) return
      if (!addMenuRef.current.contains(event.target as Node)) {
        setAddMenuColumnIndex(null)
      }
    }
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setAddMenuColumnIndex(null)
    }
    document.addEventListener('mousedown', handleClick)
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('mousedown', handleClick)
      document.removeEventListener('keydown', handleKey)
    }
  }, [addMenuColumnIndex])

  useEffect(() => {
    setAddMenuColumnIndex(null)
  }, [workspaceView, activeConnectionId])

  useEffect(() => {
    setCreateDraft(null)
  }, [workspaceView, activeConnectionId])

  useEffect(() => {
    setRenameDraft(null)
  }, [workspaceView, activeConnectionId])

  useEffect(() => {
    setDeleteConfirm(null)
  }, [workspaceView, activeConnectionId])

  useEffect(() => {
    const unsubscribe = window.simpleSSH.workspace.onQueueStatus((status) => {
      if (!isQueueStatus(status)) return
      setQueueStatusMap((prev) => ({ ...prev, [status.connectionId]: status }))
    })

    const unsubscribeStatus = window.simpleSSH.workspace.onStatus((status) => {
      if (!status || typeof status !== 'object') return
      const update = status as { connectionId?: string; kind?: StatusKind; message?: string }
      if (!update.message) return
      const currentConnectionId = activeConnectionIdRef.current
      const draftConnectionId = connectionDraftIdRef.current
      if (
        update.connectionId &&
        currentConnectionId &&
        draftConnectionId &&
        update.connectionId !== currentConnectionId &&
        update.connectionId !== draftConnectionId
      ) {
        return
      }
      const kind = update.kind === 'ok' || update.kind === 'error' || update.kind === 'info' ? update.kind : 'info'
      setStatusMessage({ kind, message: update.message })
    })

    void loadConnections()

    return () => {
      unsubscribe()
      unsubscribeStatus()
    }
  }, [])

  useEffect(() => {
    if (!activeConnection) return
    if (activeConnection.localRoot) {
      void loadLocalRoot(activeConnection, activeConnection.localRoot)
    } else {
      setLocalColumns([])
      setLocalSelected([])
      setLocalBasePath('')
    }
    if (activeConnection.remoteRoot) {
      void loadRemoteRoot(activeConnection, { rootOverride: activeConnection.remoteRoot })
    } else {
      setRemoteColumns([])
      setRemoteSelected([])
      setRemoteBasePath('')
    }
    void refreshQueueStatus(activeConnection.id)
  }, [activeConnection?.id, activeConnection?.localRoot, activeConnection?.remoteRoot])

  const loadConnections = async () => {
    const raw = await window.simpleSSH.connections.list()
    const list = (Array.isArray(raw) ? raw : []) as Connection[]
    const normalized = list.map((item) => ({
      ...item,
      editorLayout: item.editorLayout ?? 'full',
      editorLayoutShortcut: item.editorLayoutShortcut ?? defaultEditorLayoutShortcut,
    }))
    setConnections(normalized)
    setActiveConnectionId((prev) => {
      if (prev && normalized.some((item) => item.id === prev)) return prev
      return normalized[0]?.id ?? null
    })
  }

  const refreshQueueStatus = async (connectionId: string) => {
    const status = await window.simpleSSH.workspace.getQueueStatus({ connectionId })
    if (status && isQueueStatus(status)) {
      setQueueStatusMap((prev) => ({ ...prev, [connectionId]: status }))
    }
  }

  const loadLocalRoot = async (connection: Connection, rootOverride?: string) => {
    const root = rootOverride ?? connection.localRoot
    if (!root) return
    const nodes = await window.simpleSSH.workspace.list({ root, depth: 1 })
    const sorted = sortNodes((nodes ?? []) as FileNode[], { foldersFirst: connection.foldersFirst })
    setLocalColumns([sorted])
    setLocalSelected([])
    setLocalBasePath(root)
  }

  const loadRemoteRoot = async (
    connection: Connection,
    options?: { path?: string; force?: boolean; rootOverride?: string },
  ) => {
    const root = options?.rootOverride ?? options?.path ?? connection.remoteRoot
    if (!root) return
    const response = await window.simpleSSH.workspace.remoteList({
      connectionId: connection.id,
      path: root,
      force: options?.force,
    })
    const nodes = (response?.nodes ?? []) as FileNode[]
    setRemoteColumns([sortNodes(nodes, { foldersFirst: connection.foldersFirst })])
    setRemoteSelected([])
    setRemoteBasePath(root)
  }

  const openEditor = async (connection?: Connection) => {
    setEditorOpen(true)
    setConnectionErrors({})
    setStatusMessage(null)
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
    const fontSize = Number(connectionDraft.editorFontSize)
    if (!Number.isFinite(fontSize) || fontSize < 8 || fontSize > 32) {
      errors.editorFontSize = 'Font size must be between 8 and 32.'
    }
    const tabSize = Number(connectionDraft.editorTabSize)
    if (!Number.isFinite(tabSize) || tabSize < 1 || tabSize > 8) {
      errors.editorTabSize = 'Tab size must be between 1 and 8.'
    }
    return errors
  }

  const handleSaveConnection = async () => {
    const errors = validateDraft()
    setConnectionErrors(errors)
    if (Object.keys(errors).length > 0) {
      setStatusMessage({ kind: 'error', message: 'Fix the highlighted fields first.' })
      return
    }

    const payload: ConnectionDraft = {
      ...connectionDraft,
      liveSyncIntervalSec: Number(connectionDraft.liveSyncIntervalSec),
      port: Number(connectionDraft.port),
      editorFontSize: Number(connectionDraft.editorFontSize),
      editorTabSize: Number(connectionDraft.editorTabSize),
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
      setStatusMessage({ kind: 'ok', message: 'Connection saved.' })
      if (queueStatusMap[(result as Connection).id]?.watching) {
        await window.simpleSSH.workspace.startWatch({ connectionId: (result as Connection).id })
      }
    } else {
      setStatusMessage({ kind: 'error', message: 'Failed to save connection.' })
    }
  }

  const handleDeleteConnection = async () => {
    if (!connectionDraft.id) return
    await window.simpleSSH.connections.delete(connectionDraft.id)
    await loadConnections()
    setEditorOpen(false)
    setStatusMessage({ kind: 'ok', message: 'Connection deleted.' })
  }

  const handleTestConnection = async () => {
    setStatusMessage({ kind: 'info', message: 'Testing connection...' })
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
      setStatusMessage({ kind: 'ok', message: response.message || 'Connection ok.' })
    } else {
      setStatusMessage({ kind: 'error', message: response?.message || 'Connection failed.' })
    }
  }

  const handleRebuildRemoteIndex = async () => {
    if (!connectionDraft.id) {
      setStatusMessage({ kind: 'error', message: 'Save the connection before rebuilding the index.' })
      return
    }
    setStatusMessage({ kind: 'info', message: 'Rebuilding remote index: .' })
    const result = await window.simpleSSH.workspace.rebuildRemoteIndex({ connectionId: connectionDraft.id })
    if (result?.ok) {
      setStatusMessage({ kind: 'ok', message: result.message || 'Remote index rebuilt.' })
    } else {
      setStatusMessage({ kind: 'error', message: result?.message || 'Failed to rebuild remote index.' })
    }
  }

  const handleGenerateKeyPair = async () => {
    setStatusMessage({ kind: 'info', message: 'Generating key pair...' })
    const response = await window.simpleSSH.connections.generateKeyPair({
      keyName: connectionDraft.keyName?.trim(),
      passphrase: passphrase,
      comment: connectionDraft.name?.trim() || undefined,
    })
    if (!response?.ok) {
      setStatusMessage({ kind: 'error', message: response?.message || 'Key generation failed.' })
      return
    }
    if (response.privateKey) {
      setPrivateKey(response.privateKey)
    }
    setStatusMessage({ kind: 'ok', message: response.message || 'Key generated.' })
  }

  const handleSync = async () => {
    if (!activeConnection) return
    setStatusMessage({ kind: 'info', message: 'Syncing remote to local...' })
    const result = await window.simpleSSH.workspace.sync({ connectionId: activeConnection.id })
    if (result?.ok) {
      setStatusMessage({ kind: 'ok', message: result.message || 'Sync complete.' })
      await loadLocalRoot(activeConnection, localBasePath || activeConnection.localRoot)
    } else {
      setStatusMessage({ kind: 'error', message: result?.message || 'Sync failed.' })
    }
  }

  const handleToggleWatcher = async () => {
    if (!activeConnection) return
    if (activeConnection.syncMode === 'manual') {
      setStatusMessage({ kind: 'error', message: 'Sync mode is manual. Switch to upload or live.' })
      return
    }
    if (queueStatus?.watching) {
      const result = await window.simpleSSH.workspace.stopWatch({ connectionId: activeConnection.id })
      if (result?.ok) {
        setStatusMessage({ kind: 'ok', message: result.message || 'Auto sync stopped.' })
      } else {
        setStatusMessage({ kind: 'error', message: result?.message || 'Failed to stop auto sync.' })
      }
    } else {
      const result = await window.simpleSSH.workspace.startWatch({ connectionId: activeConnection.id })
      if (result?.ok) {
        setStatusMessage({ kind: 'ok', message: result.message || 'Auto sync started.' })
        if (isQueueStatus(result.status)) {
          setQueueStatusMap((prev) => ({ ...prev, [activeConnection.id]: result.status }))
        }
      } else {
        setStatusMessage({ kind: 'error', message: result?.message || 'Failed to start auto sync.' })
      }
    }
  }

  const handleClearQueueHistory = async () => {
    if (!activeConnection) return
    const result = await window.simpleSSH.workspace.clearQueueHistory({ connectionId: activeConnection.id })
    if (result && isQueueStatus(result)) {
      setQueueStatusMap((prev) => ({ ...prev, [activeConnection.id]: result }))
    } else {
      setQueueStatusMap((prev) => {
        const existing = prev[activeConnection.id]
        if (!existing) return prev
        return {
          ...prev,
          [activeConnection.id]: {
            ...existing,
            recent: [],
          },
        }
      })
    }
  }

  const refreshRemoteFolder = async (targetPath: string, options?: { force?: boolean }) => {
    const connection = activeConnectionRef.current
    if (!connection) return
    const refreshPath = targetPath === '.' || !targetPath ? connection.remoteRoot : targetPath
    const force = Boolean(options?.force)
    const response = await window.simpleSSH.workspace.remoteList({
      connectionId: connection.id,
      path: refreshPath,
      force,
      skipIndex: force,
    })
    const nodes = sortNodes((response?.nodes ?? []) as FileNode[], { foldersFirst: connection.foldersFirst })
    if (refreshPath === connection.remoteRoot) {
      setRemoteColumns([nodes])
      setRemoteSelected([])
      return
    }
    const selectedSnapshot = remoteSelectedRef.current
    const selectedIndex = selectedSnapshot.findIndex((node) => node?.path === refreshPath)
    if (selectedIndex < 0) return
    setRemoteColumns((prev) => {
      const base = prev.slice(0, selectedIndex + 1)
      return [...base, nodes]
    })
    setRemoteSelected((prev) => prev.slice(0, selectedIndex + 1))
  }

  const refreshLocalFolder = async (targetPath: string, columnIndex: number) => {
    const children = await window.simpleSSH.workspace.list({ root: targetPath, depth: 1 })
    const sorted = sortNodes((children ?? []) as FileNode[], { foldersFirst: activeConnection?.foldersFirst })
    setLocalColumns((prev) => {
      const safeIndex = Math.max(0, Math.min(columnIndex, prev.length - 1))
      const base = prev.slice(0, safeIndex)
      return [...base, sorted]
    })
    setLocalSelected((prev) => prev.slice(0, Math.max(0, columnIndex)))
  }

  useEffect(() => {
    const unsubscribeRemoteRefresh = window.simpleSSH.workspace.onRemoteRefresh((payload) => {
      const connection = activeConnectionRef.current
      if (!connection || connection.id !== payload.connectionId) return
      void refreshRemoteFolder(payload.remotePath)
    })

    return () => {
      unsubscribeRemoteRefresh()
    }
  }, [])

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

  const confirmDiscardEditorChanges = () => {
    if (!builtInEditorDirty) return true
    return window.confirm('Discard unsaved changes?')
  }

  const openBuiltInEditorForPath = async (path: string) => {
    if (!path) return false
    if (!confirmDiscardEditorChanges()) return false
    setBuiltInEditorLoading(true)
    setBuiltInEditorError(null)
    setBuiltInEditorPath(path)
    setBuiltInEditorName(fileNameFromPath(path))
    console.info('[built-in-editor] load start', { path })
    const result = await window.simpleSSH.workspace.readFile({ path })
    console.info('[built-in-editor] load result', {
      path,
      ok: result?.ok,
      message: result?.message,
      contentLength: typeof result?.content === 'string' ? result.content.length : null,
    })
    if (result?.ok && typeof result.content === 'string') {
      setBuiltInEditorContent(result.content)
      setBuiltInEditorSavedContent(result.content)
      setBuiltInEditorError(null)
      setBuiltInEditorLoading(false)
      window.setTimeout(() => builtInEditorRef.current?.focus(), 0)
      return true
    }
    setBuiltInEditorContent('')
    setBuiltInEditorSavedContent('')
    setBuiltInEditorError(result?.message || 'Failed to load file.')
    setBuiltInEditorLoading(false)
    return false
  }

  const handleSaveBuiltInEditor = async () => {
    if (!builtInEditorPath) return
    setBuiltInEditorSaving(true)
    const result = await window.simpleSSH.workspace.writeFile({
      path: builtInEditorPath,
      content: builtInEditorContent,
    })
    if (result?.ok) {
      setBuiltInEditorSavedContent(builtInEditorContent)
      setStatusMessage({ kind: 'ok', message: result.message || 'File saved.' })
    } else {
      setStatusMessage({ kind: 'error', message: result?.message || 'Failed to save file.' })
    }
    setBuiltInEditorSaving(false)
  }

  const handleCloseBuiltInEditor = () => {
    if (!confirmDiscardEditorChanges()) return
    setBuiltInEditorPath(null)
    setBuiltInEditorName('')
    setBuiltInEditorContent('')
    setBuiltInEditorSavedContent('')
    setBuiltInEditorError(null)
  }

  const updateConnectionLayout = async (layout: EditorLayout) => {
    if (!activeConnection) return
    const updated = { ...activeConnection, editorLayout: layout }
    setConnections((prev) => prev.map((item) => (item.id === updated.id ? updated : item)))
    if (connectionDraft.id === updated.id) {
      setConnectionDraft((prev) => ({ ...prev, editorLayout: layout }))
    }

    let password: string | undefined
    let privateKey: string | undefined
    let passphrase: string | undefined
    if (updated.authType === 'password') {
      password = (await window.simpleSSH.connections.getPassword(updated.id)) ?? undefined
    } else {
      ;[privateKey, passphrase] = await Promise.all([
        window.simpleSSH.connections.getPrivateKey(updated.id),
        window.simpleSSH.connections.getPassphrase(updated.id),
      ])
    }

    const result = await window.simpleSSH.connections.upsert({
      connection: updated,
      password,
      privateKey,
      passphrase,
    })

    if (result && typeof result === 'object' && 'id' in result) {
      await loadConnections()
      setStatusMessage({ kind: 'ok', message: `Editor layout set to ${layout === 'full' ? 'full' : '30/70'}.` })
    } else {
      setStatusMessage({ kind: 'error', message: 'Failed to update editor layout.' })
    }
  }

  useEffect(() => {
    const handleLayoutShortcut = (event: KeyboardEvent) => {
      if (!builtInEditorPath) return
      if (event.repeat) return
      if (isEditableTarget(event.target)) return
      if (!editorLayoutShortcutSpec) return
      if (event.ctrlKey !== editorLayoutShortcutSpec.ctrl) return
      if (event.metaKey !== editorLayoutShortcutSpec.meta) return
      if (event.altKey !== editorLayoutShortcutSpec.alt) return
      if (event.shiftKey !== editorLayoutShortcutSpec.shift) return
      if (editorLayoutShortcutSpec.code && event.code !== editorLayoutShortcutSpec.code) return
      if (!editorLayoutShortcutSpec.code && event.key.toLowerCase() !== editorLayoutShortcutSpec.key) return
      event.preventDefault()
      void updateConnectionLayout(editorLayout === 'full' ? 'split' : 'full')
    }
    window.addEventListener('keydown', handleLayoutShortcut)
    return () => window.removeEventListener('keydown', handleLayoutShortcut)
  }, [builtInEditorPath, editorLayout, editorLayoutShortcutSpec, updateConnectionLayout])

  const handleBuiltInEditorMount: OnMount = (editor, monaco) => {
    builtInEditorRef.current = editor
    console.info('[built-in-editor] mounted')
    monaco.editor.defineTheme('simpleSSH-dark', {
      base: 'vs-dark',
      inherit: true,
      rules: [
        { token: 'comment', foreground: '6e6885' },
        { token: 'keyword', foreground: '9d8cff' },
        { token: 'string', foreground: '8cf6c4' },
        { token: 'number', foreground: 'ff9aad' },
      ],
      colors: {
        'editor.background': '#0b0a18',
        'editor.foreground': '#f2efff',
        'editor.lineHighlightBackground': '#141129',
        'editorLineNumber.foreground': '#534d6a',
        'editorLineNumber.activeForeground': '#c7c3dd',
        'editor.selectionBackground': '#3b2d6b',
        'editor.inactiveSelectionBackground': '#2a2346',
        'editorCursor.foreground': '#ff9edb',
        'editorIndentGuide.background': '#261f3f',
        'editorIndentGuide.activeBackground': '#3a3161',
        'editorWhitespace.foreground': '#241f3b',
        'editorGutter.background': '#0b0a18',
      },
    })
    monaco.editor.setTheme('simpleSSH-dark')
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      void handleSaveBuiltInEditor()
    })
  }

  const openLocalPathInEditor = async (
    path: string,
    target: 'auto' | 'built-in' | 'external' = 'auto',
    connectionOverride?: Connection | null,
  ) => {
    const connection = connectionOverride ?? activeConnectionRef.current
    if (!connection) return
    const preference = target === 'auto' ? connection.editorPreference : target
    if (preference === 'built-in') {
      const opened = await openBuiltInEditorForPath(path)
      if (opened) {
        setStatusMessage({ kind: 'ok', message: 'Opened in built-in editor.' })
      }
      return
    }
    const result = await window.simpleSSH.workspace.openInEditor({
      path,
      codeCommand: connection.codeCommand,
    })
    if (result?.ok) {
      setStatusMessage({ kind: 'ok', message: result.message || 'Opened in editor.' })
    } else {
      setStatusMessage({ kind: 'error', message: result?.message || 'Failed to open editor.' })
    }
  }

  const openRemotePathInEditor = async (
    remotePath: string,
    target: 'auto' | 'built-in' | 'external' = 'auto',
    connectionOverride?: Connection | null,
  ) => {
    const connection = connectionOverride ?? activeConnectionRef.current
    if (!connection) return
    const preference = target === 'auto' ? connection.editorPreference : target
    const useCache = Boolean(connection.remoteFirstEditing)
    const result = useCache
      ? await window.simpleSSH.workspace.downloadRemoteFileToCache({
          connectionId: connection.id,
          remotePath,
        })
      : await window.simpleSSH.workspace.downloadRemoteFile({
          connectionId: connection.id,
          remotePath,
        })
    if (!result?.ok || !result.localPath) {
      setStatusMessage({ kind: 'error', message: result?.message || 'Download failed.' })
      return
    }
    if (preference === 'built-in') {
      const opened = await openBuiltInEditorForPath(result.localPath)
      if (opened) {
        setStatusMessage({ kind: 'ok', message: 'Downloaded and opened in built-in editor.' })
      }
      return
    }
    const openResult = await window.simpleSSH.workspace.openInEditor({
      path: result.localPath,
      codeCommand: connection.codeCommand,
    })
    if (openResult?.ok) {
      setStatusMessage({ kind: 'ok', message: openResult.message || 'Downloaded and opened.' })
    } else {
      setStatusMessage({ kind: 'error', message: openResult?.message || 'Downloaded but failed to open.' })
    }
  }

  const handleOpenLocalFile = async (node: FileNode, target: 'auto' | 'built-in' | 'external' = 'auto') => {
    void openLocalPathInEditor(node.path, target)
  }

  const handleOpenRemoteFile = async (node: FileNode, target: 'auto' | 'built-in' | 'external' = 'auto') => {
    void openRemotePathInEditor(node.path, target)
  }

  const handleShowContext = async (node: FileNode) => {
    if (!activeConnection) return
    await window.simpleSSH.workspace.showContextMenu({
      connectionId: activeConnection.id,
      path: node.path,
      type: node.type,
      codeCommand: activeConnection.codeCommand,
      editorPreference: activeConnection.editorPreference,
    })
  }

  const handleShowRemoteContext = async (node: FileNode) => {
    if (!activeConnection) return
    await window.simpleSSH.workspace.showRemoteContextMenu({
      connectionId: activeConnection.id,
      path: node.path,
      type: node.type,
      editorPreference: activeConnection.editorPreference,
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
      const sorted = sortNodes((children ?? []) as FileNode[], { foldersFirst: activeConnection?.foldersFirst })
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
      const nodes = sortNodes((response?.nodes ?? []) as FileNode[], { foldersFirst: activeConnection.foldersFirst })
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
    return selected?.path ?? localBasePath ?? activeConnection?.localRoot ?? ''
  }, [localSelected, localBasePath, activeConnection?.localRoot])

  const remotePath = useMemo(() => {
    const selected = [...remoteSelected].reverse().find((node) => node)
    return selected?.path ?? remoteBasePath ?? activeConnection?.remoteRoot ?? ''
  }, [remoteSelected, remoteBasePath, activeConnection?.remoteRoot])

  const getActiveColumnIndex = (selected: (FileNode | null)[], columnsLength: number) => {
    if (columnsLength <= 0) return 0
    for (let index = selected.length - 1; index >= 0; index -= 1) {
      if (selected[index]) return Math.min(index, columnsLength - 1)
    }
    return Math.max(0, columnsLength - 1)
  }

  const navigateToLocalPath = async (targetPath: string) => {
    if (!activeConnection) return
    const root = localBasePath || activeConnection.localRoot
    if (!root) return
    const relative = getLocalRelativePath(root, targetPath)
    if (relative === null) return
    const parts = splitLocalPath(relative)
    const rootPath = ensureLocalRoot(normalizeLocalPath(root))

    const columns: FileNode[][] = []
    const selected: (FileNode | null)[] = []
    let currentPath = rootPath
    let nodes = await window.simpleSSH.workspace.list({ root: currentPath, depth: 1 })
    let sorted = sortNodes((nodes ?? []) as FileNode[], { foldersFirst: activeConnection.foldersFirst })
    columns.push(sorted)

    for (let index = 1; index < parts.length; index += 1) {
      const next = parts[index]
      const expectedPath = `${currentPath.replace(/[\\/]+$/, '')}\\${next}`
      const match =
        sorted.find((node) => node.path === expectedPath) ?? sorted.find((node) => node.name === next)
      if (!match) break
      selected.push(match)
      if (match.type !== 'dir') break
      currentPath = expectedPath
      nodes = await window.simpleSSH.workspace.list({ root: currentPath, depth: 1 })
      sorted = sortNodes((nodes ?? []) as FileNode[], { foldersFirst: activeConnection.foldersFirst })
      columns.push(sorted)
    }

    setLocalColumns(columns)
    setLocalSelected(selected)
    setLocalBasePath(rootPath)
  }

  const navigateToRemotePath = async (targetPath: string) => {
    if (!activeConnection) return
    const root = remoteBasePath || activeConnection.remoteRoot
    if (!root) return
    const relative = getRemoteRelativePath(root, targetPath)
    if (relative === null) return
    const parts = relative ? relative.split('/').filter(Boolean) : []
    const rootPath = trimRemoteTrailing(normalizeRemotePath(root))

    const columns: FileNode[][] = []
    const selected: (FileNode | null)[] = []
    let currentPath = rootPath
    let response = await window.simpleSSH.workspace.remoteList({
      connectionId: activeConnection.id,
      path: currentPath,
    })
    let sorted = sortNodes((response?.nodes ?? []) as FileNode[], { foldersFirst: activeConnection.foldersFirst })
    columns.push(sorted)

    for (let index = 1; index < parts.length; index += 1) {
      const next = parts[index]
      const expectedPath = currentPath === '/' ? `/${next}` : `${currentPath}/${next}`
      const match =
        sorted.find((node) => node.path === expectedPath) ?? sorted.find((node) => node.name === next)
      if (!match) break
      selected.push(match)
      if (match.type !== 'dir') break
      currentPath = expectedPath
      response = await window.simpleSSH.workspace.remoteList({
        connectionId: activeConnection.id,
        path: currentPath,
      })
      sorted = sortNodes((response?.nodes ?? []) as FileNode[], { foldersFirst: activeConnection.foldersFirst })
      columns.push(sorted)
    }

    setRemoteColumns(columns)
    setRemoteSelected(selected)
    setRemoteBasePath(rootPath)
  }

  const localActiveColumnIndex = useMemo(
    () => getActiveColumnIndex(localSelected, localColumns.length),
    [localSelected, localColumns.length],
  )

  const remoteActiveColumnIndex = useMemo(
    () => getActiveColumnIndex(remoteSelected, remoteColumns.length),
    [remoteSelected, remoteColumns.length],
  )

  const localContext = useMemo(() => {
    if (!activeConnection || localColumns.length === 0) return null
    const columnIndex = localActiveColumnIndex
    const parent = columnIndex > 0 ? localSelected[columnIndex - 1] : null
    const parentPath = parent?.type === 'dir' ? parent.path : localBasePath || activeConnection.localRoot
    return { path: parentPath, columnIndex }
  }, [activeConnection, localColumns.length, localActiveColumnIndex, localSelected, localBasePath])

  const remoteContext = useMemo(() => {
    if (!activeConnection || remoteColumns.length === 0) return null
    const columnIndex = remoteActiveColumnIndex
    const parent = columnIndex > 0 ? remoteSelected[columnIndex - 1] : null
    const parentPath = parent?.type === 'dir' ? parent.path : remoteBasePath || activeConnection.remoteRoot
    return { path: parentPath, columnIndex }
  }, [activeConnection, remoteColumns.length, remoteActiveColumnIndex, remoteSelected, remoteBasePath])

  const activeColumnIndex =
    workspaceView === 'local' ? localActiveColumnIndex : remoteActiveColumnIndex
  const canCreateItem =
    Boolean(activeConnection) &&
    ((workspaceView === 'local' && localContext) || (workspaceView === 'remote' && remoteContext))

  useEffect(() => {
    setAddMenuColumnIndex(null)
  }, [activeColumnIndex])

  useEffect(() => {
    setCreateDraft(null)
  }, [activeColumnIndex])

  useEffect(() => {
    if (!deleteConfirm) return
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setDeleteConfirm(null)
    }
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('keydown', handleKey)
    }
  }, [deleteConfirm])

  const createDraftKey = createDraft
    ? `${createDraft.scope}:${createDraft.parentPath}:${createDraft.columnIndex}:${createDraft.type}`
    : null

  useEffect(() => {
    if (createDraftKey) {
      window.requestAnimationFrame(() => {
        createDraftInputRef.current?.focus()
        createDraftInputRef.current?.select()
      })
    }
  }, [createDraftKey])

  const renameDraftKey = renameDraft ? `${renameDraft.scope}:${renameDraft.path}` : null

  useEffect(() => {
    if (renameDraftKey) {
      window.requestAnimationFrame(() => {
        renameDraftInputRef.current?.focus()
        renameDraftInputRef.current?.select()
      })
    }
  }, [renameDraftKey])

  const localBreadcrumb = useMemo(() => {
    const root = localBasePath || activeConnection?.localRoot || ''
    return buildLocalBreadcrumbs(root, localPath)
  }, [localBasePath, activeConnection?.localRoot, localPath])

  const remoteBreadcrumb = useMemo(() => {
    const root = remoteBasePath || activeConnection?.remoteRoot || ''
    return buildRemoteBreadcrumbs(root, remotePath)
  }, [remoteBasePath, activeConnection?.remoteRoot, remotePath])

  const breadcrumbSegments =
    workspaceView === 'remote' ? remoteBreadcrumb.segments : localBreadcrumb.segments
  const breadcrumbPaths =
    workspaceView === 'remote' ? remoteBreadcrumb.paths : localBreadcrumb.paths

  const queueItems = queueStatus?.recent ?? []
  const queueActiveCount = queueItems.filter((item) =>
    item.phase === 'queued' || item.phase === 'uploading' || item.phase === 'verifying' || item.phase === 'deleting',
  ).length
  const queueFailedCount = queueItems.filter((item) => item.phase === 'failed').length
  const queueCompleteCount = queueItems.filter((item) => item.phase === 'complete').length
  const queueFilteredItems = queueItems.filter((item) => {
    if (queueFilter === 'failed') return item.phase === 'failed'
    if (queueFilter === 'complete') return item.phase === 'complete'
    if (queueFilter === 'active') {
      return item.phase === 'queued' || item.phase === 'uploading' || item.phase === 'verifying' || item.phase === 'deleting'
    }
    return true
  })
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
  const queueDetailLabel = (() => {
    if (!queueStatus?.lastPath || !queueStatus?.lastPhase) return 'Last: idle'
    const normalized = queueStatus.lastPath.replace(/\\/g, '/')
    const fileName = normalized.split('/').pop() ?? normalized
    return `Last: ${queueStatus.lastPhase} ${fileName}`
  })()

  const createItemAtPath = async (
    scope: 'local' | 'remote',
    parentPath: string,
    type: 'file' | 'dir',
    name: string,
    columnIndex?: number,
  ) => {
    const connection = activeConnectionRef.current
    if (!connection) return
    const trimmedName = name.trim()
    if (!trimmedName) return

    if (scope === 'local') {
      const resolvedColumnIndex = (() => {
        if (typeof columnIndex === 'number') return columnIndex
        if (parentPath === connection.localRoot) return 0
        const parentIndex = localSelected.findIndex((node) => node?.path === parentPath)
        if (parentIndex >= 0) return parentIndex + 1
        return localActiveColumnIndex
      })()
      const result = await window.simpleSSH.workspace.createLocalItem({
        connectionId: connection.id,
        parentPath,
        name: trimmedName,
        type,
      })
      if (result?.ok) {
        setStatusMessage({ kind: 'ok', message: result.message || 'Item created.' })
        await refreshLocalFolder(parentPath, resolvedColumnIndex)
      } else {
        setStatusMessage({ kind: 'error', message: result?.message || 'Failed to create item.' })
      }
      setAddMenuColumnIndex(null)
      return
    }

    const result = await window.simpleSSH.workspace.createRemoteItem({
      connectionId: connection.id,
      parentPath,
      name: trimmedName,
      type,
    })
    if (result?.ok) {
      setStatusMessage({ kind: 'ok', message: result.message || 'Item created.' })
      await refreshRemoteFolder(parentPath, { force: true })
    } else {
      setStatusMessage({ kind: 'error', message: result?.message || 'Failed to create item.' })
    }
    setAddMenuColumnIndex(null)
  }

  const beginCreateDraft = (scope: 'local' | 'remote', type: 'file' | 'dir', parentPath: string, columnIndex: number) => {
    setAddMenuColumnIndex(null)
    setRenameDraft(null)
    setCreateDraft({ scope, type, parentPath, columnIndex, name: '' })
  }

  const commitCreateDraft = async (value?: string) => {
    if (!createDraft) return
    const { scope, parentPath, type, name, columnIndex } = createDraft
    setCreateDraft(null)
    const resolvedName = (value ?? name).trim()
    if (!resolvedName) return
    await createItemAtPath(scope, parentPath, type, resolvedName, columnIndex)
  }

  const findNodeInColumns = (columns: FileNode[][], targetPath: string) => {
    for (let columnIndex = 0; columnIndex < columns.length; columnIndex += 1) {
      const node = columns[columnIndex]?.find((entry) => entry.path === targetPath)
      if (node) return { node, columnIndex }
    }
    return null
  }

  const localParentPath = (value: string) => {
    const normalized = value.replace(/\//g, '\\')
    const index = normalized.lastIndexOf('\\')
    if (index <= 0) return normalized
    return normalized.slice(0, index)
  }

  const remoteParentPath = (value: string) => {
    const normalized = value.replace(/\\/g, '/')
    const index = normalized.lastIndexOf('/')
    if (index <= 0) return normalized || '/'
    return normalized.slice(0, index)
  }

  const beginRenameDraft = (scope: 'local' | 'remote', targetPath: string) => {
    const columns = scope === 'local' ? localColumns : remoteColumns
    const found = findNodeInColumns(columns, targetPath)
    if (!found) return
    setCreateDraft(null)
    setAddMenuColumnIndex(null)
    setRenameDraft({
      scope,
      path: found.node.path,
      columnIndex: found.columnIndex,
      type: found.node.type,
      name: found.node.name,
      originalName: found.node.name,
    })
  }

  const commitRenameDraft = async (value?: string) => {
    if (!renameDraft) return
    const connection = activeConnectionRef.current
    if (!connection) return
    const nextName = (value ?? renameDraft.name).trim()
    if (!nextName) {
      setRenameDraft(null)
      return
    }
    if (nextName === renameDraft.originalName) {
      setRenameDraft(null)
      return
    }
    if (renameDraft.scope === 'local') {
      const result = await window.simpleSSH.workspace.renameLocalItem({
        connectionId: connection.id,
        path: renameDraft.path,
        name: nextName,
      })
      if (result?.ok) {
        setStatusMessage({ kind: 'ok', message: result.message || 'Item renamed.' })
        await refreshLocalFolder(localParentPath(renameDraft.path), renameDraft.columnIndex)
      } else {
        setStatusMessage({ kind: 'error', message: result?.message || 'Failed to rename item.' })
      }
    } else {
      const result = await window.simpleSSH.workspace.renameRemoteItem({
        connectionId: connection.id,
        path: renameDraft.path,
        name: nextName,
      })
      if (result?.ok) {
        setStatusMessage({ kind: 'ok', message: result.message || 'Item renamed.' })
        await refreshRemoteFolder(remoteParentPath(renameDraft.path), { force: true })
      } else {
        setStatusMessage({ kind: 'error', message: result?.message || 'Failed to rename item.' })
      }
    }
    setRenameDraft(null)
  }

  const handleDeleteItem = async (payload: {
    scope: 'local' | 'remote'
    path: string
    type?: 'file' | 'dir'
  }) => {
    const connection = activeConnectionRef.current
    if (!connection) return
    if (payload.scope === 'local') {
      const result = await window.simpleSSH.workspace.deleteLocalItem({
        connectionId: connection.id,
        path: payload.path,
        type: payload.type,
      })
      if (result?.ok) {
        setStatusMessage({ kind: 'ok', message: result.message || 'Item deleted.' })
        const parent = localParentPath(payload.path)
        const found = findNodeInColumns(localColumns, payload.path)
        const columnIndex = found?.columnIndex ?? localActiveColumnIndex
        await refreshLocalFolder(parent, columnIndex)
      } else {
        setStatusMessage({ kind: 'error', message: result?.message || 'Failed to delete item.' })
      }
      return
    }

    const result = await window.simpleSSH.workspace.deleteRemoteItem({
      connectionId: connection.id,
      path: payload.path,
    })
    if (result?.ok) {
      setStatusMessage({ kind: 'ok', message: result.message || 'Item deleted.' })
      const parent = remoteParentPath(payload.path)
      await refreshRemoteFolder(parent, { force: true })
    } else {
      setStatusMessage({ kind: 'error', message: result?.message || 'Failed to delete item.' })
    }
  }

  useEffect(() => {
    const unsubscribe = window.simpleSSH.workspace.onCreateItemPrompt((payload) => {
      if (!payload?.parentPath || !payload.type || !payload.scope) return
      const columnIndex =
        payload.scope === 'local' ? localActiveColumnIndex : remoteActiveColumnIndex
      beginCreateDraft(payload.scope, payload.type, payload.parentPath, columnIndex)
    })
    return () => {
      unsubscribe()
    }
  }, [localActiveColumnIndex, remoteActiveColumnIndex])

  useEffect(() => {
    const unsubscribe = window.simpleSSH.workspace.onRenameItemPrompt((payload) => {
      if (!payload?.path || !payload.scope) return
      beginRenameDraft(payload.scope, payload.path)
    })
    return () => {
      unsubscribe()
    }
  }, [localColumns, remoteColumns])

  useEffect(() => {
    const unsubscribe = window.simpleSSH.workspace.onDeleteItemPrompt((payload) => {
      if (!payload?.path || !payload.scope) return
      setDeleteConfirm(payload)
    })
    return () => {
      unsubscribe()
    }
  }, [localColumns, localActiveColumnIndex])

  useEffect(() => {
    const unsubscribe = window.simpleSSH.workspace.onOpenEditorRequest((payload) => {
      if (!payload?.path) return
      const connection = activeConnectionRef.current
      if (payload.scope === 'local') {
        void openLocalPathInEditor(payload.path, payload.target, connection)
        return
      }
      if (!connection || payload.connectionId !== connection.id) return
      void openRemotePathInEditor(payload.path, payload.target, connection)
    })
    return () => {
      unsubscribe()
    }
  }, [openLocalPathInEditor, openRemotePathInEditor])

  return (
    <div className='app-shell'>
      <div className='topbar'>
        <div className='brand'>
          <div className='brand-mark'>
            {activeConnection?.name
              ? activeConnection.name.trim().slice(0, 2).toUpperCase()
              : 'S'}
          </div>
          <div>
            <div className='brand-title-row'>
              <div className='brand-name'>
                {activeConnection ? activeConnection.name || activeConnection.host : 'SimpleSSH'}
              </div>
              {activeConnection?.hostingProvider && activeConnection.hostingProvider !== 'none' && (
                <div className='provider-tag'>{activeConnection.hostingProvider}</div>
              )}
            </div>
            <div className='brand-tag'>Workspace</div>
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
          </div>
        </div>
        <div className='top-actions'>
          <button className='primary' onClick={handleSync} disabled={!activeConnection}>
            Sync
          </button>
          <button className='ghost' onClick={handleToggleWatcher} disabled={!activeConnection}>
            {queueStatus?.watching ? 'Auto Sync On' : 'Auto Sync Off'}
          </button>
          <button className='ghost' onClick={() => setDrawerOpen((prev) => !prev)}>
            Connections
          </button>
        </div>
      </div>

      <div className={`stage ${builtInEditorPath ? 'with-editor' : ''}`}>
        <div className='panel workspace'>
          <div
            className={`workspace-split ${builtInEditorPath ? 'with-editor' : ''} ${
              editorLayout === 'split' ? 'layout-split' : 'layout-full'
            }`}
          >
            <div className='workspace-explorer'>
              <div className='workspace-tree column-view'>
                <div className='column-shell'>
                  <div className='breadcrumb-bar'>
                  {breadcrumbSegments.length === 0 && <span className='breadcrumb-label'>No path selected</span>}
                  {breadcrumbSegments.map((segment, index) => {
                    const isCurrent = index === breadcrumbSegments.length - 1
                    return (
                      <button
                        type='button'
                        className='breadcrumb-seg'
                        key={`${segment}-${index}`}
                        onClick={() => {
                          const target = breadcrumbPaths[index]
                          if (!target || isCurrent) return
                          if (workspaceView === 'remote') {
                            void navigateToRemotePath(target)
                          } else {
                            void navigateToLocalPath(target)
                          }
                        }}
                        disabled={isCurrent}
                        aria-label={`Open ${segment}`}
                      >
                        <span className='breadcrumb-label'>{segment}</span>
                      </button>
                    )
                  })}
                  </div>
                  <div className='column-grid'>
                    {(workspaceView === 'local' ? localColumns : remoteColumns).map((column, columnIndex) => (
                      <div className={`column ${columnIndex > 0 ? 'linked' : ''}`} key={`col-${columnIndex}`}>
                        <div className='column-list scroll-hide' onScroll={handleScrollVisibility}>
                          {createDraft &&
                            createDraft.columnIndex === columnIndex &&
                            createDraft.scope === workspaceView &&
                            createDraft.parentPath && (
                              <div className='column-item draft'>
                                <span className={`file-badge ${createDraft.type === 'dir' ? 'type-dir' : ''}`}>
                                  {createDraft.type === 'dir' ? 'dir' : 'file'}
                                </span>
                                <input
                                  ref={createDraftInputRef}
                                  className='column-input'
                                  value={createDraft.name}
                                  placeholder={createDraft.type === 'dir' ? 'New folder' : 'New file'}
                                  onChange={(event) =>
                                    setCreateDraft((prev) =>
                                      prev ? { ...prev, name: event.target.value } : prev,
                                    )
                                  }
                                  onBlur={(event) => void commitCreateDraft(event.currentTarget.value)}
                                  onKeyDown={(event) => {
                                    if (event.key === 'Enter') {
                                      event.preventDefault()
                                      void commitCreateDraft(event.currentTarget.value)
                                    }
                                    if (event.key === 'Escape') {
                                      event.preventDefault()
                                      setCreateDraft(null)
                                    }
                                  }}
                                />
                              </div>
                            )}
                          {column.map((node) => {
                            const isActive =
                              workspaceView === 'local'
                                ? localSelected[columnIndex]?.path === node.path
                                : remoteSelected[columnIndex]?.path === node.path
                            const badge = fileBadge(node)
                            const isRenaming =
                              renameDraft?.scope === workspaceView &&
                              renameDraft?.path === node.path &&
                              renameDraft.columnIndex === columnIndex
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
                                    void handleOpenRemoteFile(node)
                                  }
                                }}
                                onContextMenu={() => {
                                  if (workspaceView === 'local') {
                                    void handleShowContext(node)
                                  } else {
                                    void handleShowRemoteContext(node)
                                  }
                                }}
                              >
                                <span className={badge.className}>{badge.label}</span>
                                {isRenaming ? (
                                  <input
                                    ref={renameDraftInputRef}
                                    className='column-input'
                                    value={renameDraft.name}
                                    onChange={(event) =>
                                      setRenameDraft((prev) =>
                                        prev ? { ...prev, name: event.target.value } : prev,
                                      )
                                    }
                                    onBlur={(event) => void commitRenameDraft(event.currentTarget.value)}
                                    onKeyDown={(event) => {
                                      if (event.key === 'Enter') {
                                        event.preventDefault()
                                        void commitRenameDraft(event.currentTarget.value)
                                      }
                                      if (event.key === 'Escape') {
                                        event.preventDefault()
                                        setRenameDraft(null)
                                      }
                                    }}
                                  />
                                ) : (
                                  <div className='column-name'>{node.name}</div>
                                )}
                                {node.type === 'file' && <div className='column-size'>{formatBytes(node.size)}</div>}
                              </div>
                            )
                          })}
                          {column.length === 0 && <div className='empty'>Empty</div>}
                        </div>
                        {columnIndex === activeColumnIndex && canCreateItem && (
                          <div className='column-actions' ref={addMenuRef}>
                            <button
                              className='ghost small column-action'
                              onClick={() =>
                                setAddMenuColumnIndex((prev) => (prev === columnIndex ? null : columnIndex))
                              }
                              aria-label='Add file or folder'
                            >
                              +
                            </button>
                            {addMenuColumnIndex === columnIndex && (
                              <div className='add-menu column-menu'>
                                <button
                                  className='ghost small'
                                  onClick={() => {
                                    if (!activeConnection) return
                                    if (workspaceView === 'local') {
                                      if (!localContext) return
                                      beginCreateDraft('local', 'file', localContext.path, localContext.columnIndex)
                                    } else {
                                      if (!remoteContext) return
                                      beginCreateDraft('remote', 'file', remoteContext.path, remoteContext.columnIndex)
                                    }
                                  }}
                                >
                                  New File
                                </button>
                                <button
                                  className='ghost small'
                                  onClick={() => {
                                    if (!activeConnection) return
                                    if (workspaceView === 'local') {
                                      if (!localContext) return
                                      beginCreateDraft('local', 'dir', localContext.path, localContext.columnIndex)
                                    } else {
                                      if (!remoteContext) return
                                      beginCreateDraft('remote', 'dir', remoteContext.path, remoteContext.columnIndex)
                                    }
                                  }}
                                >
                                  New Folder
                                </button>
                              </div>
                            )}
                          </div>
                        )}
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
            <div className={`workspace-editor ${builtInEditorPath ? 'open' : ''}`}>
              {builtInEditorPath && (
                <div className='panel code-editor-panel'>
                  <div className='code-editor-header'>
                    <div>
                      <div className='panel-title'>Code Editor</div>
                      <div className='code-editor-title-row'>
                        <div className='code-editor-name'>{builtInEditorName || 'Untitled'}</div>
                        {builtInEditorDirty && <div className='code-editor-dirty'>Unsaved</div>}
                      </div>
                      <div className='code-editor-path'>{builtInEditorPath}</div>
                    </div>
                    <div className='code-editor-actions'>
                      <button
                        className='ghost small'
                        onClick={() => void updateConnectionLayout(editorLayout === 'full' ? 'split' : 'full')}
                        title={`Toggle layout (${editorLayoutShortcut})`}
                      >
                        {editorLayoutLabel}
                      </button>
                      <button
                        className='ghost small'
                        onClick={() => {
                          if (!activeConnection || !builtInEditorPath) return
                          void window.simpleSSH.workspace.openInEditor({
                            path: builtInEditorPath,
                            codeCommand: activeConnection.codeCommand,
                          })
                        }}
                        disabled={!activeConnection}
                      >
                        Open External
                      </button>
                      <button className='ghost small' onClick={handleCloseBuiltInEditor}>
                        Close
                      </button>
                      <button
                        className='primary small'
                        onClick={() => void handleSaveBuiltInEditor()}
                        disabled={!builtInEditorDirty || builtInEditorSaving}
                      >
                        Save
                      </button>
                    </div>
                  </div>
                  <div className='code-editor-body'>
                    {builtInEditorLoading ? (
                      <div className='code-editor-empty'>Loading file...</div>
                    ) : (
                      <Editor
                        height='100%'
                        value={builtInEditorContent}
                        language={builtInEditorLanguage}
                        theme='simpleSSH-dark'
                        onMount={handleBuiltInEditorMount}
                        onChange={(value) => setBuiltInEditorContent(value ?? '')}
                        options={builtInEditorOptions}
                      />
                    )}
                  </div>
                  {builtInEditorError && <div className='status error'>{builtInEditorError}</div>}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {queuePanelOpen && (
        <div className='status-overlay' onClick={() => setQueuePanelOpen(false)} />
      )}
      {deleteConfirm && (
        <div className='status-overlay' onClick={() => setDeleteConfirm(null)} />
      )}
      {deleteConfirm && (
        <div className='confirm-modal'>
          <div className='confirm-title'>
            Delete {deleteConfirm.type === 'dir' ? 'folder' : 'file'}?
          </div>
          <div className='confirm-sub'>{deleteConfirm.path}</div>
          <div className='confirm-actions'>
            <button className='ghost small' onClick={() => setDeleteConfirm(null)}>
              Cancel
            </button>
            <button
              className='danger'
              onClick={() => {
                const payload = deleteConfirm
                setDeleteConfirm(null)
                void handleDeleteItem(payload)
              }}
            >
              Delete
            </button>
          </div>
        </div>
      )}
      <div
        className='status-strip status-bottom'
        onClick={() => setQueuePanelOpen((prev) => !prev)}
        role='button'
        tabIndex={0}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            setQueuePanelOpen((prev) => !prev)
          }
        }}
      >
        <div className='status-chip'>{connectionStatusLabel}</div>
        <div className='status-chip'>{syncStateLabel}</div>
        <div className='status-chip'>
          Queue: {queueStatus ? `${queueStatus.pending} pending, ${queueStatus.active} active` : 'Idle'}
        </div>
        <div className='status-chip'>{queueDetailLabel}</div>
        {statusMessage && (
          <div className={`status-chip ${statusMessage.kind}`}>{statusMessage.message}</div>
        )}
      </div>
      <div className={`status-popup ${queuePanelOpen ? 'open' : ''}`} onClick={(event) => event.stopPropagation()}>
        <div className='status-popup-header'>
          <div>
            <div className='panel-title'>Transfer History</div>
            <div className='status-popup-sub'>
              {activeConnection ? `Connection: ${activeConnection.name || activeConnection.host}` : 'No connection selected'}
            </div>
          </div>
          <div className='queue-history-actions'>
            <button className='ghost small' onClick={() => void handleClearQueueHistory()} disabled={!activeConnection}>
              Clear
            </button>
            <button className='ghost small' onClick={() => setQueuePanelOpen(false)}>
              Close
            </button>
          </div>
        </div>
        <div className='queue-filters'>
          <button
            className={`queue-filter ${queueFilter === 'all' ? 'active' : ''}`}
            onClick={() => setQueueFilter('all')}
          >
            All ({queueItems.length})
          </button>
          <button
            className={`queue-filter ${queueFilter === 'active' ? 'active' : ''}`}
            onClick={() => setQueueFilter('active')}
          >
            Active ({queueActiveCount})
          </button>
          <button
            className={`queue-filter ${queueFilter === 'failed' ? 'active' : ''}`}
            onClick={() => setQueueFilter('failed')}
          >
            Failed ({queueFailedCount})
          </button>
          <button
            className={`queue-filter ${queueFilter === 'complete' ? 'active' : ''}`}
            onClick={() => setQueueFilter('complete')}
          >
            Complete ({queueCompleteCount})
          </button>
        </div>
        <div className='queue-history-list scroll-hide' onScroll={handleScrollVisibility}>
          {queueFilteredItems.length === 0 && (
            <div className='queue-history-empty'>No history items for this filter.</div>
          )}
          {queueFilteredItems.map((item) => {
            const actionLabel = item.action === 'delete' ? 'delete' : 'upload'
            return (
              <div className='queue-item' key={item.id}>
                <div className='queue-main'>
                  <span className='queue-action'>{actionLabel}</span>
                  <span className='queue-path'>{item.path}</span>
                </div>
                <div className='queue-meta'>
                  <span>{item.phase}</span>
                  <span>{formatRelativeTime(item.updatedAt)}</span>
                  {item.bytesTotal ? (
                    <span>{`${formatBytes(item.bytesSent ?? 0)} / ${formatBytes(item.bytesTotal)}`}</span>
                  ) : null}
                </div>
                {item.note && <div className='queue-note'>{item.note}</div>}
                {item.phase === 'failed' && (
                  <div className='queue-error'>{item.error || queueStatus?.lastError || 'Upload failed.'}</div>
                )}
              </div>
            )
          })}
        </div>
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
                setStatusMessage({
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
                setStatusMessage({
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
          <div className='panel connection-editor'>
            <div className='panel-title'>Connection Editor</div>
            <div className='grid'>
              <label className='checkbox-row'>
                <input
                  type='checkbox'
                  checked={connectionDraft.remoteIndexOnConnect}
                  onChange={(event) =>
                    setConnectionDraft((prev) => ({ ...prev, remoteIndexOnConnect: event.target.checked }))
                  }
                />
                <span>Initial remote index on connect</span>
              </label>
              <label className='checkbox-row'>
                <input
                  type='checkbox'
                  checked={connectionDraft.remoteFirstEditing}
                  onChange={(event) =>
                    setConnectionDraft((prev) => ({ ...prev, remoteFirstEditing: event.target.checked }))
                  }
                />
                <span>Remote-first editing (beta)</span>
              </label>
              <label className='checkbox-row'>
                <input
                  type='checkbox'
                  checked={connectionDraft.foldersFirst}
                  onChange={(event) =>
                    setConnectionDraft((prev) => ({ ...prev, foldersFirst: event.target.checked }))
                  }
                />
                <span>Folders above files</span>
              </label>
              <label className='checkbox-row'>
                <input
                  type='checkbox'
                  checked={connectionDraft.editorSoftTabs}
                  onChange={(event) =>
                    setConnectionDraft((prev) => ({ ...prev, editorSoftTabs: event.target.checked }))
                  }
                />
                <span>Editor soft tabs</span>
              </label>
              <label className='checkbox-row'>
                <input
                  type='checkbox'
                  checked={connectionDraft.editorWordWrap}
                  onChange={(event) =>
                    setConnectionDraft((prev) => ({ ...prev, editorWordWrap: event.target.checked }))
                  }
                />
                <span>Editor word wrap</span>
              </label>
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
                Pin cache after N visits
                <input
                  type='number'
                  min={1}
                  max={50}
                  value={connectionDraft.remotePinThreshold}
                  onChange={(event) =>
                    setConnectionDraft((prev) => ({
                      ...prev,
                      remotePinThreshold: Number(event.target.value),
                    }))
                  }
                />
              </label>
              <label>
                Max pinned folders
                <input
                  type='number'
                  min={0}
                  max={1000}
                  value={connectionDraft.remotePinnedMaxEntries}
                  onChange={(event) =>
                    setConnectionDraft((prev) => ({
                      ...prev,
                      remotePinnedMaxEntries: Number(event.target.value),
                    }))
                  }
                />
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

              <div className='form-section'>
                <div className='form-section-title'>Code Editor</div>
                <div className='form-section-grid'>
                  <label>
                    Editor Preference
                    <select
                      value={connectionDraft.editorPreference}
                      onChange={(event) =>
                        setConnectionDraft((prev) => ({
                          ...prev,
                          editorPreference: event.target.value as EditorPreference,
                        }))
                      }
                    >
                      <option value='external'>External editor</option>
                      <option value='built-in'>Built-in editor</option>
                    </select>
                  </label>
                  <label>
                    Editor Layout
                    <select
                      value={connectionDraft.editorLayout}
                      onChange={(event) =>
                        setConnectionDraft((prev) => ({
                          ...prev,
                          editorLayout: event.target.value as EditorLayout,
                        }))
                      }
                    >
                      <option value='full'>Full editor</option>
                      <option value='split'>Split 30/70</option>
                    </select>
                  </label>
                  <label>
                    Layout Toggle Shortcut
                    <input
                      value={connectionDraft.editorLayoutShortcut}
                      onChange={(event) =>
                        setConnectionDraft((prev) => ({
                          ...prev,
                          editorLayoutShortcut: event.target.value,
                        }))
                      }
                      placeholder={defaultEditorLayoutShortcut}
                    />
                    <div className='hint'>Use format like Ctrl+Shift+L or Cmd+Shift+L.</div>
                  </label>
                  <label>
                    Editor Font Size
                    <input
                      type='number'
                      min={8}
                      max={32}
                      value={connectionDraft.editorFontSize}
                      onChange={(event) =>
                        setConnectionDraft((prev) => ({ ...prev, editorFontSize: Number(event.target.value) }))
                      }
                    />
                    {connectionErrors.editorFontSize && <div className='error'>{connectionErrors.editorFontSize}</div>}
                  </label>
                  <label>
                    Editor Tab Size
                    <input
                      type='number'
                      min={1}
                      max={8}
                      value={connectionDraft.editorTabSize}
                      onChange={(event) =>
                        setConnectionDraft((prev) => ({ ...prev, editorTabSize: Number(event.target.value) }))
                      }
                    />
                    {connectionErrors.editorTabSize && <div className='error'>{connectionErrors.editorTabSize}</div>}
                  </label>
                  <label>
                    External Editor Command
                    <input
                      value={connectionDraft.codeCommand}
                      onChange={(event) => setConnectionDraft((prev) => ({ ...prev, codeCommand: event.target.value }))}
                      placeholder='code'
                    />
                  </label>
                </div>
              </div>

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
              <button
                className='ghost'
                onClick={() => void handleRebuildRemoteIndex()}
                disabled={!connectionDraft.id || !connectionDraft.remoteRoot}
              >
                Rebuild Remote Index
              </button>
              <button
                className='ghost'
                onClick={async () => {
                  if (!connectionDraft.id) return
                  const result = await window.simpleSSH.workspace.clearRemoteCache({
                    connectionId: connectionDraft.id,
                  })
                  setStatusMessage({
                    kind: result?.ok ? 'ok' : 'error',
                    message: result?.message || 'Remote cache cleared.',
                  })
                }}
                disabled={!connectionDraft.id}
              >
                Clear Remote Cache
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

          </div>
        )}
        {!editorOpen && <div className='sidebar-hint'>Select a connection to edit.</div>}
      </div>
    </div>
  )
}

export default App

