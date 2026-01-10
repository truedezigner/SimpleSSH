import { ipcRenderer, contextBridge } from 'electron'

// --------- Expose some API to the Renderer process ---------
contextBridge.exposeInMainWorld('simpleSSH', {
  connections: {
    list: () => ipcRenderer.invoke('connections:list'),
    upsert: (payload: { connection: unknown; password?: string; privateKey?: string; passphrase?: string }) =>
      ipcRenderer.invoke('connections:upsert', payload),
    delete: (id: string) => ipcRenderer.invoke('connections:delete', id),
    getPassword: (id: string) => ipcRenderer.invoke('connections:getPassword', id),
    clearPassword: (id: string) => ipcRenderer.invoke('connections:clearPassword', id),
    getPrivateKey: (id: string) => ipcRenderer.invoke('connections:getPrivateKey', id),
    clearPrivateKey: (id: string) => ipcRenderer.invoke('connections:clearPrivateKey', id),
    getPassphrase: (id: string) => ipcRenderer.invoke('connections:getPassphrase', id),
    clearPassphrase: (id: string) => ipcRenderer.invoke('connections:clearPassphrase', id),
    test: (payload: unknown) => ipcRenderer.invoke('connections:test', payload),
    generateKeyPair: (payload: { keyName: string; passphrase: string; comment?: string }) =>
      ipcRenderer.invoke('connections:generateKeyPair', payload),
    export: () => ipcRenderer.invoke('connections:export'),
    import: () => ipcRenderer.invoke('connections:import'),
  },
  workspace: {
    pickFolder: () => ipcRenderer.invoke('workspace:pickFolder'),
    list: (payload: { root: string; depth?: number }) => ipcRenderer.invoke('workspace:list', payload),
    openFolder: (payload: { root: string }) => ipcRenderer.invoke('workspace:openFolder', payload),
    sync: (payload: { connectionId: string }) => ipcRenderer.invoke('workspace:sync', payload),
    remoteList: (payload: { connectionId: string; path: string; force?: boolean; skipIndex?: boolean }) =>
      ipcRenderer.invoke('workspace:remoteList', payload),
    rebuildRemoteIndex: (payload: { connectionId: string }) =>
      ipcRenderer.invoke('workspace:rebuildRemoteIndex', payload),
    createLocalItem: (payload: { connectionId: string; parentPath: string; name: string; type: 'file' | 'dir' }) =>
      ipcRenderer.invoke('workspace:createLocalItem', payload),
    createRemoteItem: (payload: { connectionId: string; parentPath: string; name: string; type: 'file' | 'dir' }) =>
      ipcRenderer.invoke('workspace:createRemoteItem', payload),
    renameLocalItem: (payload: { connectionId: string; path: string; name: string }) =>
      ipcRenderer.invoke('workspace:renameLocalItem', payload),
    renameRemoteItem: (payload: { connectionId: string; path: string; name: string }) =>
      ipcRenderer.invoke('workspace:renameRemoteItem', payload),
    deleteLocalItem: (payload: { connectionId: string; path: string; type?: 'file' | 'dir' }) =>
      ipcRenderer.invoke('workspace:deleteLocalItem', payload),
    deleteRemoteItem: (payload: { connectionId: string; path: string }) =>
      ipcRenderer.invoke('workspace:deleteRemoteItem', payload),
    downloadRemoteFile: (payload: { connectionId: string; remotePath: string }) =>
      ipcRenderer.invoke('workspace:downloadRemoteFile', payload),
    downloadRemoteFileToCache: (payload: { connectionId: string; remotePath: string }) =>
      ipcRenderer.invoke('workspace:downloadRemoteFileToCache', payload),
    startWatch: (payload: { connectionId: string }) => ipcRenderer.invoke('workspace:startWatch', payload),
    stopWatch: (payload: { connectionId: string }) => ipcRenderer.invoke('workspace:stopWatch', payload),
    clearQueueHistory: (payload: { connectionId: string }) =>
      ipcRenderer.invoke('workspace:clearQueueHistory', payload),
    clearRemoteCache: (payload: { connectionId: string }) =>
      ipcRenderer.invoke('workspace:clearRemoteCache', payload),
    getQueueStatus: (payload: { connectionId: string }) =>
      ipcRenderer.invoke('workspace:getQueueStatus', payload),
    onStatus: (handler: (status: unknown) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, status: unknown) => handler(status)
      ipcRenderer.on('workspace:status', listener)
      return () => ipcRenderer.removeListener('workspace:status', listener)
    },
    forceUploadFile: (payload: { connectionId: string; path: string }) =>
      ipcRenderer.invoke('workspace:forceUploadFile', payload),
    openInEditor: (payload: { path: string; codeCommand?: string }) =>
      ipcRenderer.invoke('workspace:openInEditor', payload),
    onQueueStatus: (handler: (status: unknown) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, status: unknown) => handler(status)
      ipcRenderer.on('workspace:queueStatus', listener)
      return () => ipcRenderer.removeListener('workspace:queueStatus', listener)
    },
    showContextMenu: (payload: {
      connectionId?: string
      path: string
      type: 'file' | 'dir'
      codeCommand?: string
    }) =>
      ipcRenderer.invoke('workspace:showContextMenu', payload),
    showRemoteContextMenu: (payload: { connectionId: string; path: string; type: 'file' | 'dir' }) =>
      ipcRenderer.invoke('workspace:showRemoteContextMenu', payload),
    onCreateItemPrompt: (
      handler: (payload: { scope: 'local' | 'remote'; parentPath: string; type: 'file' | 'dir' }) => void,
    ) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        payload: { scope: 'local' | 'remote'; parentPath: string; type: 'file' | 'dir' },
      ) => handler(payload)
      ipcRenderer.on('workspace:createItemPrompt', listener)
      return () => ipcRenderer.removeListener('workspace:createItemPrompt', listener)
    },
    onRenameItemPrompt: (handler: (payload: { scope: 'local' | 'remote'; path: string }) => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        payload: { scope: 'local' | 'remote'; path: string },
      ) => handler(payload)
      ipcRenderer.on('workspace:renameItemPrompt', listener)
      return () => ipcRenderer.removeListener('workspace:renameItemPrompt', listener)
    },
    onDeleteItemPrompt: (
      handler: (payload: { scope: 'local' | 'remote'; path: string; type?: 'file' | 'dir' }) => void,
    ) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        payload: { scope: 'local' | 'remote'; path: string; type?: 'file' | 'dir' },
      ) => handler(payload)
      ipcRenderer.on('workspace:deleteItemPrompt', listener)
      return () => ipcRenderer.removeListener('workspace:deleteItemPrompt', listener)
    },
    onRemoteRefresh: (handler: (payload: { connectionId: string; remotePath: string }) => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        payload: { connectionId: string; remotePath: string },
      ) => handler(payload)
      ipcRenderer.on('workspace:remoteRefresh', listener)
      return () => ipcRenderer.removeListener('workspace:remoteRefresh', listener)
    },
  },
})

// --------- Preload scripts loading ---------
function domReady(condition: DocumentReadyState[] = ['complete', 'interactive']) {
  return new Promise(resolve => {
    if (condition.includes(document.readyState)) {
      resolve(true)
    } else {
      document.addEventListener('readystatechange', () => {
        if (condition.includes(document.readyState)) {
          resolve(true)
        }
      })
    }
  })
}

const safeDOM = {
  append(parent: HTMLElement, child: HTMLElement) {
    if (!Array.from(parent.children).find(e => e === child)) {
      return parent.appendChild(child)
    }
  },
  remove(parent: HTMLElement, child: HTMLElement) {
    if (Array.from(parent.children).find(e => e === child)) {
      return parent.removeChild(child)
    }
  },
}

/**
 * https://tobiasahlin.com/spinkit
 * https://connoratherton.com/loaders
 * https://projects.lukehaas.me/css-loaders
 * https://matejkustec.github.io/SpinThatShit
 */
function useLoading() {
  const className = `loaders-css__square-spin`
  const styleContent = `
@keyframes square-spin {
  25% { transform: perspective(100px) rotateX(180deg) rotateY(0); }
  50% { transform: perspective(100px) rotateX(180deg) rotateY(180deg); }
  75% { transform: perspective(100px) rotateX(0) rotateY(180deg); }
  100% { transform: perspective(100px) rotateX(0) rotateY(0); }
}
.${className} > div {
  animation-fill-mode: both;
  width: 50px;
  height: 50px;
  background: #fff;
  animation: square-spin 3s 0s cubic-bezier(0.09, 0.57, 0.49, 0.9) infinite;
}
.app-loading-wrap {
  position: fixed;
  top: 0;
  left: 0;
  width: 100vw;
  height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #282c34;
  z-index: 9;
}
    `
  const oStyle = document.createElement('style')
  const oDiv = document.createElement('div')

  oStyle.id = 'app-loading-style'
  oStyle.innerHTML = styleContent
  oDiv.className = 'app-loading-wrap'
  oDiv.innerHTML = `<div class="${className}"><div></div></div>`

  return {
    appendLoading() {
      safeDOM.append(document.head, oStyle)
      safeDOM.append(document.body, oDiv)
    },
    removeLoading() {
      safeDOM.remove(document.head, oStyle)
      safeDOM.remove(document.body, oDiv)
    },
  }
}

// ----------------------------------------------------------------------

const { appendLoading, removeLoading } = useLoading()
domReady().then(appendLoading)

window.onmessage = (ev) => {
  ev.data.payload === 'removeLoading' && removeLoading()
}

setTimeout(removeLoading, 4999)
