import { useEffect, useMemo, useState } from 'react'
import './App.css'

type VerifyMode = 'sha256-remote' | 'download-back'
type AuthType = 'password' | 'key'

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
  codeCommand: string
}

interface FileNode {
  name: string
  path: string
  type: 'file' | 'dir'
  size?: number
  children?: FileNode[]
}

interface RemoteNode extends FileNode {
  loaded?: boolean
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

interface QueueItem {
  id: string
  path: string
  action: 'upload' | 'delete'
  phase: 'queued' | 'uploading' | 'verifying' | 'deleting' | 'complete' | 'failed'
  error?: string
  updatedAt: number
  bytesSent?: number
  bytesTotal?: number
}

const emptyForm = {
  name: '',
  host: '',
  port: 22,
  username: '',
  authType: 'password' as AuthType,
  keyName: '',
  remoteRoot: '/home/youruser/public_html',
  localRoot: '',
  verifyMode: 'sha256-remote' as VerifyMode,
  codeCommand: 'code',
}

function App() {
  const [connections, setConnections] = useState<Connection[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [form, setForm] = useState({ ...emptyForm })
  const [editorSection, setEditorSection] = useState<'basics' | 'auth' | 'paths' | 'actions'>('basics')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [privateKey, setPrivateKey] = useState('')
  const [showPrivateKey, setShowPrivateKey] = useState(false)
  const [passphrase, setPassphrase] = useState('')
  const [showPassphrase, setShowPassphrase] = useState(false)
  const [publicKey, setPublicKey] = useState('')
  const [publicKeyFingerprint, setPublicKeyFingerprint] = useState('')
  const [publicKeyError, setPublicKeyError] = useState('')
  const [publicKeyRandomart, setPublicKeyRandomart] = useState('')
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [status, setStatus] = useState<{ type: 'idle' | 'ok' | 'error'; message: string }>({
    type: 'idle',
    message: '',
  })
  const [workspaceTree, setWorkspaceTree] = useState<FileNode[]>([])
  const [localExpanded, setLocalExpanded] = useState<string[]>([])
  const [workspaceView, setWorkspaceView] = useState<'local' | 'remote'>('local')
  const [remoteTree, setRemoteTree] = useState<RemoteNode[]>([])
  const [remoteExpanded, setRemoteExpanded] = useState<string[]>([])
  const [workspaceFocus, setWorkspaceFocus] = useState(false)
  const [queueStatus, setQueueStatus] = useState<QueueStatus | null>(null)
  const [syncStatus, setSyncStatus] = useState<{ type: 'idle' | 'ok' | 'error'; message: string }>({
    type: 'idle',
    message: '',
  })

  const localIndex = useMemo(() => buildLocalIndex(workspaceTree), [workspaceTree])
  const localExpandedSet = useMemo(() => new Set(localExpanded), [localExpanded])
  const localEntries = useMemo(
    () => flattenLocalTree(localIndex, localExpandedSet),
    [localIndex, localExpandedSet],
  )

  const loadConnections = async () => {
    const list = (await window.simpleSSH.connections.list()) as Connection[]
    setConnections(list)
    if (list.length === 0) {
      setSelectedId(null)
    }
  }

  useEffect(() => {
    void loadConnections()
  }, [])

  useEffect(() => {
    if (workspaceView !== 'remote') return
    if (!selectedId || !form.remoteRoot) {
      setRemoteTree([])
      return
    }
    void loadRemoteRoot()
  }, [workspaceView, selectedId, form.remoteRoot])

  useEffect(() => {
    if (!selectedId) {
      setQueueStatus(null)
      return
    }
    void window.simpleSSH.workspace.getQueueStatus({ connectionId: selectedId }).then((status) => {
      setQueueStatus((status as QueueStatus | null) ?? null)
    })
  }, [selectedId])

  useEffect(() => {
    const unsubscribe = window.simpleSSH.workspace.onQueueStatus((status) => {
      const next = status as QueueStatus
      if (next?.connectionId === selectedId) {
        setQueueStatus(next)
      }
    })
    return () => {
      unsubscribe?.()
    }
  }, [selectedId])

  const validateForm = () => {
    const nextErrors: Record<string, string> = {}
    if (!form.name.trim()) nextErrors.name = 'Name is required.'
    if (!form.host.trim()) nextErrors.host = 'Host is required.'
    if (!form.username.trim()) nextErrors.username = 'Username is required.'
    if (!form.remoteRoot.trim()) nextErrors.remoteRoot = 'Remote root is required.'
    if (form.port < 1 || form.port > 65535) nextErrors.port = 'Port must be between 1 and 65535.'
    setErrors(nextErrors)
    return Object.keys(nextErrors).length === 0
  }

  const resetForm = () => {
    setSelectedId(null)
    setForm({ ...emptyForm })
    setEditorSection('basics')
    setPassword('')
    setShowPassword(false)
    setPrivateKey('')
    setShowPrivateKey(false)
    setPassphrase('')
    setShowPassphrase(false)
    setPublicKey('')
    setPublicKeyFingerprint('')
    setPublicKeyError('')
    setPublicKeyRandomart('')
    setPublicKeyRandomart('')
    setErrors({})
    setStatus({ type: 'idle', message: '' })
    setWorkspaceTree([])
    setLocalExpanded([])
    setWorkspaceFocus(false)
    setSyncStatus({ type: 'idle', message: '' })
  }

  const handleEdit = (connection: Connection) => {
    setSelectedId(connection.id)
    setEditorSection('basics')
    setForm({
      name: connection.name,
      host: connection.host,
      port: connection.port,
      username: connection.username,
      authType: connection.authType ?? 'password',
      keyName: connection.keyName ?? '',
      remoteRoot: connection.remoteRoot,
      localRoot: connection.localRoot,
      verifyMode: connection.verifyMode,
      codeCommand: connection.codeCommand,
    })
    setPassword('')
    setShowPassword(false)
    setPrivateKey('')
    setShowPrivateKey(false)
    setPassphrase('')
    setShowPassphrase(false)
    setPublicKey('')
    setPublicKeyFingerprint('')
    setPublicKeyError('')
    setErrors({})
    setStatus({ type: 'idle', message: '' })
    setWorkspaceTree([])
    setLocalExpanded([])
    setSyncStatus({ type: 'idle', message: '' })
  }

  const handleSave = async () => {
    if (!validateForm()) return
    const payload = {
      connection: {
        ...form,
        id: selectedId ? selectedId : undefined,
        authType: form.authType,
        port: Number(form.port) || 22,
      },
      password: password || undefined,
      privateKey: privateKey || undefined,
      passphrase: passphrase || undefined,
    }
    await window.simpleSSH.connections.upsert(payload)
    await loadConnections()
    setPassword('')
    setPrivateKey('')
    setPassphrase('')
    setStatus({ type: 'ok', message: 'Connection saved.' })
  }

  const handleDelete = async () => {
    if (!selectedId) return
    await window.simpleSSH.connections.delete(selectedId)
    await loadConnections()
    resetForm()
  }

  const handleTogglePassword = async () => {
    if (!selectedId || password) {
      setShowPassword((prev) => !prev)
      return
    }
    const stored = await window.simpleSSH.connections.getPassword(selectedId)
    if (stored) {
      setPassword(stored)
      setShowPassword(true)
    }
  }

  const handleTogglePrivateKey = async () => {
    if (!selectedId || privateKey) {
      setShowPrivateKey((prev) => !prev)
      return
    }
    const stored = await window.simpleSSH.connections.getPrivateKey(selectedId)
    if (stored) {
      setPrivateKey(stored)
      setShowPrivateKey(true)
    }
  }

  const handleTogglePassphrase = async () => {
    if (!selectedId || passphrase) {
      setShowPassphrase((prev) => !prev)
      return
    }
    const stored = await window.simpleSSH.connections.getPassphrase(selectedId)
    if (stored) {
      setPassphrase(stored)
      setShowPassphrase(true)
    }
  }

  const handleCopyPublicKey = async () => {
    if (!publicKey.trim()) {
      setPublicKeyError('Paste a public key first.')
      return
    }
    await navigator.clipboard.writeText(publicKey.trim())
  }

  const handleFingerprintPublicKey = async () => {
    setPublicKeyError('')
    setPublicKeyFingerprint('')
    setPublicKeyRandomart('')
    try {
      const { fingerprint, randomart } = await computePublicKeyArtifacts(publicKey)
      setPublicKeyFingerprint(fingerprint)
      setPublicKeyRandomart(randomart)
    } catch (error) {
      setPublicKeyError(error instanceof Error ? error.message : 'Unable to parse public key.')
    }
  }

  const handleGenerateKeyPair = async () => {
    setPublicKeyError('')
    if (!form.keyName.trim()) {
      setPublicKeyError('Key name is required to generate a key pair.')
      return
    }
    if (!passphrase.trim()) {
      setPublicKeyError('Key passphrase is required to generate a key pair.')
      return
    }
    const comment = form.name ? `${form.name}` : `${form.username || 'user'}@${form.host || 'host'}`
    const result = await window.simpleSSH.connections.generateKeyPair({
      keyName: form.keyName.trim(),
      passphrase,
      comment,
    })
    setStatus({ type: result.ok ? 'ok' : 'error', message: result.message })
    if (result.ok) {
      if (result.privateKey) {
        setPrivateKey(result.privateKey)
        setShowPrivateKey(true)
      }
      if (result.publicKey) {
        setPublicKey(result.publicKey)
      }
      if (result.publicKey) {
        const { fingerprint, randomart } = await computePublicKeyArtifacts(result.publicKey)
        setPublicKeyFingerprint(fingerprint)
        setPublicKeyRandomart(randomart)
      }
    }
  }

  const handleTest = async () => {
    if (!validateForm()) return
    let effectivePassword = password
    let effectivePrivateKey = privateKey
    let effectivePassphrase = passphrase
    if (form.authType === 'password' && !effectivePassword && selectedId) {
      const stored = await window.simpleSSH.connections.getPassword(selectedId)
      effectivePassword = stored ?? ''
    }
    if (form.authType === 'key' && !effectivePrivateKey && selectedId) {
      const stored = await window.simpleSSH.connections.getPrivateKey(selectedId)
      effectivePrivateKey = stored ?? ''
    }
    if (form.authType === 'key' && !effectivePassphrase && selectedId) {
      const stored = await window.simpleSSH.connections.getPassphrase(selectedId)
      effectivePassphrase = stored ?? ''
    }
    const result = await window.simpleSSH.connections.test({
      host: form.host,
      port: Number(form.port) || 22,
      username: form.username,
      authType: form.authType,
      password: effectivePassword || undefined,
      privateKey: effectivePrivateKey || undefined,
      passphrase: effectivePassphrase || undefined,
      remoteRoot: form.remoteRoot,
    })
    setStatus({
      type: result.ok ? 'ok' : 'error',
      message: result.message,
    })
  }

  const handlePickWorkspace = async () => {
    const picked = await window.simpleSSH.workspace.pickFolder()
    if (picked) {
      setForm({ ...form, localRoot: picked })
    }
  }

  const handleLoadWorkspace = async () => {
    if (!form.localRoot) {
      setSyncStatus({ type: 'error', message: 'Select a local workspace first.' })
      return
    }
    const tree = (await window.simpleSSH.workspace.list({ root: form.localRoot, depth: 6 })) as FileNode[]
    setWorkspaceTree(tree)
    setLocalExpanded(tree.filter((node) => node.type === 'dir').map((node) => node.path))
  }

  const loadRemoteRoot = async () => {
    if (!selectedId) {
      setSyncStatus({ type: 'error', message: 'Save the connection before browsing.' })
      return
    }
    const result = await window.simpleSSH.workspace.remoteList({
      connectionId: selectedId,
      path: form.remoteRoot,
    })
    setSyncStatus({ type: result.ok ? 'ok' : 'error', message: result.message })
    if (result.ok && result.nodes) {
      setRemoteTree(decorateRemoteNodes(result.nodes as FileNode[]))
      setRemoteExpanded([])
    }
  }

  const handleSyncWorkspace = async () => {
    if (!selectedId) {
      setSyncStatus({ type: 'error', message: 'Save the connection before syncing.' })
      return
    }
    const result = await window.simpleSSH.workspace.sync({ connectionId: selectedId })
    setSyncStatus({ type: result.ok ? 'ok' : 'error', message: result.message })
    if (result.ok) await handleLoadWorkspace()
  }

  const handleToggleWatch = async () => {
    if (!selectedId) {
      setSyncStatus({ type: 'error', message: 'Save the connection before watching.' })
      return
    }
    const result = queueStatus?.watching
      ? await window.simpleSSH.workspace.stopWatch({ connectionId: selectedId })
      : await window.simpleSSH.workspace.startWatch({ connectionId: selectedId })
    setSyncStatus({ type: result.ok ? 'ok' : 'error', message: result.message })
    if (result.ok && result.status) {
      setQueueStatus(result.status as QueueStatus)
    }
  }

  const handleRemoteToggle = async (node: RemoteNode) => {
    if (node.type !== 'dir') return
    setWorkspaceFocus(true)
    const isExpanded = remoteExpanded.includes(node.path)
    if (isExpanded) {
      setRemoteExpanded(remoteExpanded.filter((item) => item !== node.path))
      return
    }
    setRemoteExpanded([...remoteExpanded, node.path])
    if (node.loaded) return
    if (!selectedId) return
    const result = await window.simpleSSH.workspace.remoteList({
      connectionId: selectedId,
      path: node.path,
    })
    setSyncStatus({ type: result.ok ? 'ok' : 'error', message: result.message })
    if (result.ok && result.nodes) {
      const children = decorateRemoteNodes(result.nodes as FileNode[])
      setRemoteTree((current) => updateRemoteNode(current, node.path, (target) => ({
        ...target,
        loaded: true,
        children,
      })))
    }
  }

  const handleRemoteOpenFile = async (node: RemoteNode) => {
    if (node.type !== 'file') return
    setWorkspaceFocus(true)
    if (!selectedId) {
      setSyncStatus({ type: 'error', message: 'Save the connection before downloading.' })
      return
    }
    const result = await window.simpleSSH.workspace.downloadRemoteFile({
      connectionId: selectedId,
      remotePath: node.path,
    })
    setSyncStatus({ type: result.ok ? 'ok' : 'error', message: result.message })
    if (result.ok) {
      await handleLoadWorkspace()
      if (result.localPath) {
        const openResult = await window.simpleSSH.workspace.openInEditor({
          path: result.localPath,
          codeCommand: form.codeCommand,
        })
        if (!openResult.ok) {
          setSyncStatus({ type: 'error', message: openResult.message })
        }
      }
    }
  }

  const handleImport = async () => {
    const result = await window.simpleSSH.connections.import()
    setStatus({ type: result.ok ? 'ok' : 'error', message: result.message })
    if (result.ok) await loadConnections()
  }

  const handleExport = async () => {
    const result = await window.simpleSSH.connections.export()
    setStatus({ type: result.ok ? 'ok' : 'error', message: result.message })
  }

  const handleTreeContextMenu = (node: FileNode) => {
    void window.simpleSSH.workspace.showContextMenu({
      path: node.path,
      type: node.type,
      codeCommand: form.codeCommand,
    })
  }

  const handleLocalToggle = (node: FileNode) => {
    if (node.type !== 'dir') return
    setWorkspaceFocus(true)
    setLocalExpanded((current) =>
      current.includes(node.path) ? current.filter((item) => item !== node.path) : [...current, node.path],
    )
  }

  const handleLocalOpenFile = async (node: FileNode) => {
    if (node.type !== 'file') return
    setWorkspaceFocus(true)
    const result = await window.simpleSSH.workspace.openInEditor({
      path: node.path,
      codeCommand: form.codeCommand,
    })
    if (!result.ok) {
      setSyncStatus({ type: 'error', message: result.message })
    }
  }

  return (
    <div className='app-shell'>
      <header className='topbar'>
        <div className='brand'>
          <div className='brand-mark'>S</div>
          <div>
            <div className='brand-name'>SimpleSSH</div>
            <div className='brand-tag'>Remote sync, clean and calm.</div>
          </div>
        </div>
        <div className='top-status'>
          <div className='status-pill'>Ready</div>
          <div className='status-meta'>
            Queue: {queueStatus ? queueStatus.pending + queueStatus.active : 0} | Active: {queueStatus?.active ?? 0} | Failed: {queueStatus?.failed ?? 0} | Watch: {queueStatus?.watching ? 'on' : 'off'} | Mode: {form.verifyMode}
          </div>
        </div>
        <div className='top-actions'>
          <button className='ghost' onClick={handleImport}>Import</button>
          <button className='ghost' onClick={handleExport}>Export</button>
          <button className='ghost' onClick={resetForm}>New</button>
          <button className='primary' onClick={handleSave}>Save</button>
        </div>
      </header>
      <div className='status-strip'>
        <div className={`status-chip ${status.type}`}>Connection: {status.type === 'idle' ? 'Idle' : status.message}</div>
        <div className={`status-chip ${syncStatus.type}`}>Sync: {syncStatus.type === 'idle' ? 'Idle' : syncStatus.message}</div>
      </div>

      <main className={`stage ${workspaceFocus ? 'workspace-focus' : ''}`}>
        <aside className='panel sidebar'>
          <div className='panel-title'>Connections</div>
          <div className='connection-list'>
            {connections.length === 0 && (
              <div className='empty'>
                <div>No connections yet.</div>
              </div>
            )}
            {connections.map((connection) => (
              <button
                key={connection.id}
                className={`connection-card ${connection.id === selectedId ? 'active' : ''}`}
                onClick={() => handleEdit(connection)}
              >
                <div className='card-title'>{connection.name || 'Untitled connection'}</div>
                <div className='card-sub'>{connection.username}@{connection.host}:{connection.port}</div>
                <div className='card-meta'>{connection.remoteRoot}</div>
              </button>
            ))}
          </div>
          {connections.length === 0 && (
            <div className='sidebar-hint'>
              Add a connection to unlock workspace sync and file previews.
            </div>
          )}
        </aside>

        <section className='panel editor'>
          <div className='panel-title'>Connection editor</div>
          <div className='section-tabs'>
            <button
              className={`section-tab ${editorSection === 'basics' ? 'active' : ''}`}
              onClick={() => setEditorSection('basics')}
            >
              Basics
            </button>
            <button
              className={`section-tab ${editorSection === 'auth' ? 'active' : ''}`}
              onClick={() => setEditorSection('auth')}
            >
              Auth
            </button>
            <button
              className={`section-tab ${editorSection === 'paths' ? 'active' : ''}`}
              onClick={() => setEditorSection('paths')}
            >
              Paths
            </button>
            <button
              className={`section-tab ${editorSection === 'actions' ? 'active' : ''}`}
              onClick={() => setEditorSection('actions')}
            >
              Actions
            </button>
          </div>

          {editorSection === 'basics' && (
            <div className='grid'>
              <label>
                Name
                <input
                  value={form.name}
                  onChange={(event) => setForm({ ...form, name: event.target.value })}
                  placeholder='NameHero - Site A'
                />
                {errors.name && <span className='error'>{errors.name}</span>}
              </label>
              <label>
                Host
                <input
                  value={form.host}
                  onChange={(event) => setForm({ ...form, host: event.target.value })}
                  placeholder='server.namehero.net'
                />
                {errors.host && <span className='error'>{errors.host}</span>}
              </label>
              <label>
                Port
                <input
                  value={form.port}
                  onChange={(event) => setForm({ ...form, port: Number(event.target.value) })}
                  type='number'
                />
                {errors.port && <span className='error'>{errors.port}</span>}
              </label>
              <label>
                Username
                <input
                  value={form.username}
                  onChange={(event) => {
                    const nextUsername = event.target.value
                    const currentDefault = form.username
                      ? `/home/${form.username}/public_html`
                      : '/home/youruser/public_html'
                    const shouldAuto =
                      form.remoteRoot === currentDefault || form.remoteRoot === '' || form.remoteRoot === '/home/youruser/public_html'
                    const nextRemoteRoot = shouldAuto
                      ? nextUsername
                        ? `/home/${nextUsername}/public_html`
                        : '/home/youruser/public_html'
                      : form.remoteRoot
                    setForm({ ...form, username: nextUsername, remoteRoot: nextRemoteRoot })
                  }}
                  placeholder='cpaneluser'
                />
                {errors.username && <span className='error'>{errors.username}</span>}
              </label>
              <label>
                Auth type
                <select
                  value={form.authType}
                  onChange={(event) => {
                    const nextAuth = event.target.value as AuthType
                    setForm({ ...form, authType: nextAuth })
                    if (nextAuth === 'password') {
                      setPrivateKey('')
                      setPassphrase('')
                      setShowPrivateKey(false)
                      setShowPassphrase(false)
                      setPublicKey('')
                      setPublicKeyFingerprint('')
                      setPublicKeyError('')
                      setPublicKeyRandomart('')
                    } else {
                      setPassword('')
                      setShowPassword(false)
                    }
                  }}
                >
                  <option value='password'>Password</option>
                  <option value='key'>SSH key</option>
                </select>
              </label>
            </div>
          )}

          {editorSection === 'auth' && (
            <div className='grid'>
              {form.authType === 'password' && (
                <label className='password-row'>
                  Password
                  <div className='password-wrap'>
                    <input
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                      type={showPassword ? 'text' : 'password'}
                      placeholder='Stored in keychain'
                    />
                    <button className='ghost small' type='button' onClick={handleTogglePassword}>
                      {showPassword ? 'Hide' : 'Show'}
                    </button>
                  </div>
                </label>
              )}
              {form.authType === 'key' && (
                <label>
                  Key name
                  <input
                    value={form.keyName}
                    onChange={(event) => setForm({ ...form, keyName: event.target.value })}
                    placeholder='alca'
                  />
                </label>
              )}
              {form.authType === 'key' && (
                <label className='password-row'>
                  Private key
                  <div className='password-wrap'>
                    <textarea
                      value={privateKey}
                      onChange={(event) => setPrivateKey(event.target.value)}
                      placeholder='Paste your private key (BEGIN OPENSSH PRIVATE KEY...)'
                      style={{ WebkitTextSecurity: showPrivateKey ? 'none' : 'disc' }}
                    />
                    <button className='ghost small' type='button' onClick={handleTogglePrivateKey}>
                      {showPrivateKey ? 'Hide' : 'Show'}
                    </button>
                  </div>
                </label>
              )}
              {form.authType === 'key' && (
                <label className='password-row'>
                  Passphrase (optional)
                  <div className='password-wrap'>
                    <input
                      value={passphrase}
                      onChange={(event) => setPassphrase(event.target.value)}
                      type={showPassphrase ? 'text' : 'password'}
                      placeholder='Required for key generation'
                    />
                    <button className='ghost small' type='button' onClick={handleTogglePassphrase}>
                      {showPassphrase ? 'Hide' : 'Show'}
                    </button>
                  </div>
                </label>
              )}
              {form.authType === 'key' && (
                <div className='key-actions'>
                  <button className='ghost' type='button' onClick={handleGenerateKeyPair}>
                    Generate key pair in .ssh
                  </button>
                </div>
              )}
              {form.authType === 'key' && (
                <label className='password-row'>
                  Public key (for NameHero/cPanel)
                  <div className='password-wrap'>
                    <textarea
                      value={publicKey}
                      onChange={(event) => setPublicKey(event.target.value)}
                      placeholder='ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQ...'
                    />
                    <div className='stack-actions'>
                      <button className='ghost small' type='button' onClick={handleCopyPublicKey}>
                        Copy
                      </button>
                      <button className='ghost small' type='button' onClick={handleFingerprintPublicKey}>
                        Fingerprint
                      </button>
                    </div>
                  </div>
                  {publicKeyFingerprint && (
                    <span className='hint'>Fingerprint: {publicKeyFingerprint}</span>
                  )}
                  {publicKeyRandomart && (
                    <pre className='randomart'>{publicKeyRandomart}</pre>
                  )}
                  {publicKeyError && <span className='error'>{publicKeyError}</span>}
                </label>
              )}
            </div>
          )}

          {editorSection === 'paths' && (
            <div className='grid'>
              <label>
                Remote root
                <input
                  value={form.remoteRoot}
                  onChange={(event) => setForm({ ...form, remoteRoot: event.target.value })}
                />
                {errors.remoteRoot && <span className='error'>{errors.remoteRoot}</span>}
              </label>
              <label>
                Local workspace
                <div className='workspace-row'>
                  <input
                    value={form.localRoot}
                    onChange={(event) => setForm({ ...form, localRoot: event.target.value })}
                    placeholder='C:\\Users\\you\\SFTPSync\\SiteA'
                  />
                  <button className='ghost small' type='button' onClick={handlePickWorkspace}>
                    Pick
                  </button>
                </div>
              </label>
              <label>
                Verify mode
                <select
                  value={form.verifyMode}
                  onChange={(event) => setForm({ ...form, verifyMode: event.target.value as VerifyMode })}
                >
                  <option value='sha256-remote'>SHA-256 (remote)</option>
                  <option value='download-back'>Download-back</option>
                </select>
              </label>
              <label>
                Code command
                <input
                  value={form.codeCommand}
                  onChange={(event) => setForm({ ...form, codeCommand: event.target.value })}
                  placeholder='code'
                />
                <div className='editor-picks'>
                  <button
                    className='ghost small'
                    type='button'
                    onClick={() => setForm((prev) => ({ ...prev, codeCommand: 'code' }))}
                  >
                    VS Code
                  </button>
                  <button
                    className='ghost small'
                    type='button'
                    onClick={() => setForm((prev) => ({ ...prev, codeCommand: 'code-insiders' }))}
                  >
                    Code Insiders
                  </button>
                  <button
                    className='ghost small'
                    type='button'
                    onClick={() => setForm((prev) => ({ ...prev, codeCommand: 'cursor' }))}
                  >
                    Cursor
                  </button>
                </div>
              </label>
            </div>
          )}

          {editorSection === 'actions' && (
            <>
              <div className='form-actions'>
                <button className='ghost' onClick={handleTest}>Test</button>
                <button className='ghost' onClick={handleSyncWorkspace}>Sync</button>
                <button className='ghost' onClick={handleLoadWorkspace}>Refresh</button>
                <button className='ghost' onClick={handleToggleWatch}>
                  {queueStatus?.watching ? 'Stop watch' : 'Watch'}
                </button>
                <button className='ghost' onClick={handleDelete} disabled={!selectedId}>Delete</button>
              </div>
            </>
          )}
        </section>

        <aside className='panel workspace' onClick={() => setWorkspaceFocus(true)}>
          <div className='panel-title'>Workspace</div>
          <div className='section-tabs'>
            <button
              className={`section-tab ${workspaceView === 'local' ? 'active' : ''}`}
              onClick={() => setWorkspaceView('local')}
            >
              Local
            </button>
            <button
              className={`section-tab ${workspaceView === 'remote' ? 'active' : ''}`}
              onClick={() => setWorkspaceView('remote')}
            >
              Remote
            </button>
          </div>
          <div className='workspace-actions'>
            <button className='ghost' onClick={() => setWorkspaceFocus((prev) => !prev)}>
              {workspaceFocus ? 'Unfocus' : 'Focus'}
            </button>
            {workspaceView === 'local' && (
              <>
                <button className='ghost' onClick={handleLoadWorkspace}>Scan</button>
                <button className='ghost' onClick={handleSyncWorkspace}>Sync</button>
                <button className='ghost' onClick={handleToggleWatch}>
                  {queueStatus?.watching ? 'Stop' : 'Watch'}
                </button>
              </>
            )}
            {workspaceView === 'remote' && (
              <button className='ghost' onClick={loadRemoteRoot}>Refresh</button>
            )}
          </div>
          <div className='workspace-summary'>
            <div>
              <span className='summary-label'>Local root</span>
              <span className='summary-value'>{form.localRoot || 'Not set'}</span>
            </div>
            <div>
              <span className='summary-label'>Remote root</span>
              <span className='summary-value'>{form.remoteRoot || 'Not set'}</span>
            </div>
            <div>
              <span className='summary-label'>Mode</span>
              <span className='summary-value'>{form.verifyMode}</span>
            </div>
            <div>
              <span className='summary-label'>Last activity</span>
              <span className='summary-value'>
                {queueStatus?.lastPhase ?? 'idle'}{queueStatus?.lastPath ? ` | ${queueStatus.lastPath}` : ''}
              </span>
            </div>
          </div>
          {queueStatus?.lastError && (
            <div className='status error'>{queueStatus.lastError}</div>
          )}
          {queueStatus?.recent && queueStatus.recent.length > 0 && (
            <div className='workspace-queue'>
              <div className='panel-title'>Recent activity</div>
              {queueStatus.recent.map((item) => {
                const total = typeof item.bytesTotal === 'number' ? item.bytesTotal : null
                const percent = total ? Math.min(100, Math.round(((item.bytesSent ?? 0) / Math.max(total, 1)) * 100)) : null
                return (
                  <div key={item.id} className={`queue-item ${item.phase}`}>
                    <div className='queue-main'>
                      <span className='queue-action'>{item.action}</span>
                      <span className='queue-path'>{item.path}</span>
                    </div>
                    {percent !== null && (
                      <div className='queue-progress' aria-label={`Upload progress ${percent}%`}>
                        <div className='queue-progress-bar' style={{ width: `${percent}%` }} />
                        <span className='queue-progress-label'>{percent}%</span>
                      </div>
                    )}
                    <div className='queue-meta'>
                      <span>{item.phase}</span>
                      {item.error && <span className='queue-error'>{item.error}</span>}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
          <div className='workspace-tree'>
            {workspaceView === 'local' && workspaceTree.length === 0 && (
              <div className='empty'>No workspace loaded yet.</div>
            )}
            {workspaceView === 'local' && workspaceTree.length > 0 && (
              <LocalTree
                entries={localEntries}
                onToggle={handleLocalToggle}
                onOpen={handleLocalOpenFile}
                onContextMenu={handleTreeContextMenu}
              />
            )}
            {workspaceView === 'remote' && remoteTree.length === 0 && (
              <div className='empty'>No remote files loaded yet.</div>
            )}
            {workspaceView === 'remote' && remoteTree.length > 0 && (
              <RemoteTree
                nodes={remoteTree}
                depth={0}
                expanded={remoteExpanded}
                onToggle={handleRemoteToggle}
                onOpen={handleRemoteOpenFile}
              />
            )}
          </div>
        </aside>
      </main>
    </div>
  )
}

export default App

interface LocalTreeEntry {
  node: FileNode
  depth: number
  isExpanded: boolean
  hasChildren: boolean
}

function LocalTree({
  entries,
  onToggle,
  onOpen,
  onContextMenu,
}: {
  entries: LocalTreeEntry[]
  onToggle: (node: FileNode) => void
  onOpen: (node: FileNode) => void
  onContextMenu: (node: FileNode) => void
}) {
  return (
    <div className='tree-level'>
      {entries.map((entry) => {
        const badge = getFileBadge(entry.node)
        const toggle = entry.node.type === 'dir' ? (entry.isExpanded ? 'v' : '>') : ''
        return (
          <div key={entry.node.path} className='tree-item'>
            <div
              className={`tree-node ${entry.node.type}`}
              style={{ paddingLeft: 8 + entry.depth * 14 }}
              onClick={() => entry.node.type === 'dir' && onToggle(entry.node)}
              onDoubleClick={() => entry.node.type === 'file' && onOpen(entry.node)}
              onContextMenu={(event) => {
                event.preventDefault()
                onContextMenu(entry.node)
              }}
            >
              <span className={`tree-toggle ${entry.node.type}`}>
                {entry.node.type === 'dir' && entry.hasChildren ? toggle : ''}
              </span>
              <span className={`file-badge ${badge.className}`}>{badge.label}</span>
              <span className='tree-name'>{entry.node.name}</span>
              {entry.node.type === 'file' && typeof entry.node.size === 'number' && (
                <span className='tree-size'>{(entry.node.size / 1024).toFixed(1)} KB</span>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function RemoteTree({
  nodes,
  depth,
  expanded,
  onToggle,
  onOpen,
}: {
  nodes: RemoteNode[]
  depth: number
  expanded: string[]
  onToggle: (node: RemoteNode) => void
  onOpen: (node: RemoteNode) => void
}) {
  return (
    <div className='tree-level'>
      {nodes.map((node) => {
        const isExpanded = expanded.includes(node.path)
        const badge = getFileBadge(node)
        const hasChildren = node.type === 'dir' && node.children && node.children.length > 0
        const toggle = node.type === 'dir' ? (isExpanded ? 'v' : '>') : ''
        return (
          <div key={node.path} className='tree-item'>
            <div
              className={`tree-node ${node.type}`}
              style={{ paddingLeft: 8 + depth * 14 }}
              onClick={() => node.type === 'dir' && onToggle(node)}
              onDoubleClick={() => node.type === 'file' && onOpen(node)}
            >
              <span className={`tree-toggle ${node.type}`}>
                {hasChildren ? toggle : ''}
              </span>
              <span className={`file-badge ${badge.className}`}>{badge.label}</span>
              <span className='tree-name'>{node.name}</span>
              {node.type === 'file' && typeof node.size === 'number' && (
                <span className='tree-size'>{(node.size / 1024).toFixed(1)} KB</span>
              )}
            </div>
            {node.type === 'dir' && isExpanded && node.children && node.children.length > 0 && (
              <RemoteTree
                nodes={node.children as RemoteNode[]}
                depth={depth + 1}
                expanded={expanded}
                onToggle={onToggle}
                onOpen={onOpen}
              />
            )}
          </div>
        )
      })}
    </div>
  )
}

function decorateRemoteNodes(nodes: FileNode[]): RemoteNode[] {
  return nodes.map((node) => ({
    ...node,
    loaded: node.type === 'dir' ? false : true,
    children: node.type === 'dir' ? [] : undefined,
  }))
}

function updateRemoteNode(
  nodes: RemoteNode[],
  targetPath: string,
  update: (node: RemoteNode) => RemoteNode,
): RemoteNode[] {
  return nodes.map((node) => {
    if (node.path === targetPath) return update(node)
    if (node.type === 'dir' && node.children && node.children.length > 0) {
      return { ...node, children: updateRemoteNode(node.children as RemoteNode[], targetPath, update) }
    }
    return node
  })
}

interface LocalIndexNode {
  node: FileNode
  children: LocalIndexNode[]
}

function buildLocalIndex(nodes: FileNode[]): LocalIndexNode[] {
  return nodes.map((node) => ({
    node,
    children: node.children ? buildLocalIndex(node.children) : [],
  }))
}

function flattenLocalTree(index: LocalIndexNode[], expanded: Set<string>) {
  const entries: LocalTreeEntry[] = []
  const stack: { item: LocalIndexNode; depth: number }[] = [...index].reverse().map((item) => ({ item, depth: 0 }))
  while (stack.length > 0) {
    const { item, depth } = stack.pop() as { item: LocalIndexNode; depth: number }
    const isExpanded = expanded.has(item.node.path)
    const hasChildren = item.node.type === 'dir' && item.children.length > 0
    entries.push({ node: item.node, depth, isExpanded, hasChildren })
    if (item.node.type === 'dir' && isExpanded && item.children.length > 0) {
      for (let i = item.children.length - 1; i >= 0; i -= 1) {
        stack.push({ item: item.children[i], depth: depth + 1 })
      }
    }
  }
  return entries
}

function getFileBadge(node: FileNode) {
  if (node.type === 'dir') return { label: 'DIR', className: 'type-dir' }
  const ext = getFileExtension(node.name)
  if (!ext) return { label: 'FILE', className: 'type-file' }
  const map: Record<string, { label: string; className: string }> = {
    js: { label: 'JS', className: 'type-js' },
    jsx: { label: 'JSX', className: 'type-jsx' },
    ts: { label: 'TS', className: 'type-ts' },
    tsx: { label: 'TSX', className: 'type-tsx' },
    php: { label: 'PHP', className: 'type-php' },
    css: { label: 'CSS', className: 'type-css' },
    html: { label: 'HTML', className: 'type-html' },
    json: { label: 'JSON', className: 'type-json' },
    md: { label: 'MD', className: 'type-md' },
    env: { label: 'ENV', className: 'type-env' },
    yml: { label: 'YML', className: 'type-yml' },
    yaml: { label: 'YML', className: 'type-yml' },
    sh: { label: 'SH', className: 'type-sh' },
    py: { label: 'PY', className: 'type-py' },
    rb: { label: 'RB', className: 'type-rb' },
    go: { label: 'GO', className: 'type-go' },
    java: { label: 'JAVA', className: 'type-java' },
    c: { label: 'C', className: 'type-c' },
    cpp: { label: 'CPP', className: 'type-cpp' },
  }
  return map[ext] ?? { label: ext.toUpperCase(), className: 'type-file' }
}

function getFileExtension(name: string) {
  const lastDot = name.lastIndexOf('.')
  if (lastDot <= 0 || lastDot === name.length - 1) return ''
  return name.slice(lastDot + 1).toLowerCase()
}

async function computePublicKeyArtifacts(publicKey: string) {
  const trimmed = publicKey.trim()
  if (!trimmed) {
    throw new Error('Paste a public key first.')
  }
  const parts = trimmed.split(/\s+/)
  if (parts.length < 2) {
    throw new Error('Public key format should be: type base64 comment.')
  }
  const keyType = parts[0]
  const base64 = parts[1]
  const raw = atob(base64)
  const bytes = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i += 1) {
    bytes[i] = raw.charCodeAt(i)
  }
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  const hashBytes = new Uint8Array(digest)
  const hashBase64 = btoa(String.fromCharCode(...hashBytes)).replace(/=+$/, '')
  const fingerprint = `SHA256:${hashBase64}`
  const keyBits = keyType === 'ssh-rsa' ? parseRsaBits(bytes) : null
  const label = keyBits ? `${keyType.replace('ssh-', '').toUpperCase()} ${keyBits}` : 'SHA256'
  const randomart = renderRandomart(hashBytes, label)
  return { fingerprint, randomart }
}

function parseRsaBits(publicKeyBytes: Uint8Array) {
  try {
    let offset = 0
    const readUint32 = () => {
      if (offset + 4 > publicKeyBytes.length) throw new Error('Invalid key data.')
      const value =
        (publicKeyBytes[offset] << 24) |
        (publicKeyBytes[offset + 1] << 16) |
        (publicKeyBytes[offset + 2] << 8) |
        publicKeyBytes[offset + 3]
      offset += 4
      return value >>> 0
    }
    const readBytes = () => {
      const length = readUint32()
      if (offset + length > publicKeyBytes.length) throw new Error('Invalid key data.')
      const slice = publicKeyBytes.slice(offset, offset + length)
      offset += length
      return slice
    }
    const typeBytes = readBytes()
    const type = new TextDecoder().decode(typeBytes)
    if (type !== 'ssh-rsa') return null
    readBytes()
    const n = readBytes()
    let i = 0
    while (i < n.length && n[i] === 0) i += 1
    if (i === n.length) return 0
    const first = n[i]
    const msb = Math.floor(Math.log2(first)) + 1
    return (n.length - i - 1) * 8 + msb
  } catch {
    return null
  }
}

function renderRandomart(hashBytes: Uint8Array, label: string) {
  const width = 17
  const height = 9
  const maxX = width - 1
  const maxY = height - 1
  const board: number[][] = Array.from({ length: height }, () => Array(width).fill(0))
  let x = Math.floor(width / 2)
  let y = Math.floor(height / 2)
  const startX = x
  const startY = y

  for (const byte of hashBytes) {
    let value = byte
    for (let i = 0; i < 4; i += 1) {
      const dx = value & 1 ? 1 : -1
      const dy = value & 2 ? 1 : -1
      x = Math.max(0, Math.min(maxX, x + dx))
      y = Math.max(0, Math.min(maxY, y + dy))
      board[y][x] += 1
      value >>= 2
    }
  }

  const symbols = ' .o+=*BOX@%&#/^'
  const lines = board.map((row, rowIndex) =>
    row
      .map((count, colIndex) => {
        if (rowIndex === startY && colIndex === startX) return 'S'
        if (rowIndex === y && colIndex === x) return 'E'
        return symbols[Math.min(count, symbols.length - 1)]
      })
      .join(''),
  )

  const topPadding = Math.max(0, width - label.length - 2)
  const left = Math.floor(topPadding / 2)
  const right = topPadding - left
  const top = `+${'-'.repeat(left)}[${label}]${'-'.repeat(right)}+`
  const bottom = `+${'-'.repeat(width)}+`
  const body = lines.map((line) => `|${line}|`).join('\n')
  return `${top}\n${body}\n${bottom}`
}
