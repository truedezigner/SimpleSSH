/// <reference types="vite/client" />

interface Window {
  simpleSSH: {
    connections: {
      list: () => Promise<unknown[]>
      upsert: (payload: { connection: unknown; password?: string; privateKey?: string; passphrase?: string }) => Promise<unknown>
      delete: (id: string) => Promise<unknown>
      getPassword: (id: string) => Promise<string | null>
      clearPassword: (id: string) => Promise<boolean>
      getPrivateKey: (id: string) => Promise<string | null>
      clearPrivateKey: (id: string) => Promise<boolean>
      getPassphrase: (id: string) => Promise<string | null>
      clearPassphrase: (id: string) => Promise<boolean>
      test: (payload: unknown) => Promise<{ ok: boolean; message: string }>
      generateKeyPair: (payload: { keyName: string; passphrase: string; comment?: string }) => Promise<{ ok: boolean; message: string; privateKey?: string; publicKey?: string; keyPath?: string; publicKeyPath?: string }>
      export: () => Promise<{ ok: boolean; message: string }>
      import: () => Promise<{ ok: boolean; message: string }>
    }
    workspace: {
      pickFolder: () => Promise<string | null>
      list: (payload: { root: string; depth?: number }) => Promise<unknown[]>
      openFolder: (payload: { root: string }) => Promise<{ ok: boolean; message: string }>
      sync: (payload: { connectionId: string }) => Promise<{ ok: boolean; message: string }>
      remoteList: (payload: {
        connectionId: string
        path: string
        force?: boolean
        skipIndex?: boolean
      }) => Promise<{ ok: boolean; message: string; nodes?: unknown[] }>
      rebuildRemoteIndex: (payload: { connectionId: string }) => Promise<{ ok: boolean; message: string }>
      createLocalItem: (payload: {
        connectionId: string
        parentPath: string
        name: string
        type: 'file' | 'dir'
      }) => Promise<{ ok: boolean; message: string; path?: string }>
      createRemoteItem: (payload: {
        connectionId: string
        parentPath: string
        name: string
        type: 'file' | 'dir'
      }) => Promise<{ ok: boolean; message: string; path?: string }>
      renameLocalItem: (payload: { connectionId: string; path: string; name: string }) => Promise<{ ok: boolean; message: string; path?: string }>
      renameRemoteItem: (payload: { connectionId: string; path: string; name: string }) => Promise<{ ok: boolean; message: string; path?: string }>
      deleteLocalItem: (payload: { connectionId: string; path: string; type?: 'file' | 'dir' }) => Promise<{ ok: boolean; message: string }>
      deleteRemoteItem: (payload: { connectionId: string; path: string }) => Promise<{ ok: boolean; message: string }>
      downloadRemoteFile: (payload: { connectionId: string; remotePath: string }) => Promise<{ ok: boolean; message: string; localPath?: string }>
      downloadRemoteFileToCache: (payload: { connectionId: string; remotePath: string }) => Promise<{ ok: boolean; message: string; localPath?: string }>
      startWatch: (payload: { connectionId: string }) => Promise<{ ok: boolean; message: string; status?: unknown }>
      stopWatch: (payload: { connectionId: string }) => Promise<{ ok: boolean; message: string; status?: unknown }>
      forceUploadFile: (payload: { connectionId: string; path: string }) => Promise<{ ok: boolean; message: string; status?: unknown }>
      clearQueueHistory: (payload: { connectionId: string }) => Promise<unknown | null>
      clearRemoteCache: (payload: { connectionId: string }) => Promise<{ ok: boolean; message: string }>
      getQueueStatus: (payload: { connectionId: string }) => Promise<unknown | null>
      readFile: (payload: { path: string }) => Promise<{ ok: boolean; message: string; content?: string }>
      writeFile: (payload: { path: string; content: string }) => Promise<{ ok: boolean; message: string }>
      importLocalFiles: (payload: { targetDir: string; paths: string[] }) => Promise<{ ok: boolean; message: string }>
      importRemoteFiles: (payload: { connectionId: string; targetDir: string; paths: string[] }) => Promise<{ ok: boolean; message: string }>
      openInEditor: (payload: { path: string; codeCommand?: string }) => Promise<{ ok: boolean; message: string }>
      onQueueStatus: (handler: (status: unknown) => void) => () => void
      onStatus: (handler: (status: unknown) => void) => () => void
      showContextMenu: (payload: {
        connectionId?: string
        path: string
        type: 'file' | 'dir'
        codeCommand?: string
        editorPreference?: 'built-in' | 'external'
      }) => Promise<{ ok: boolean; message: string }>
      showRemoteContextMenu: (payload: {
        connectionId: string
        path: string
        type: 'file' | 'dir'
        editorPreference?: 'built-in' | 'external'
      }) => Promise<{ ok: boolean; message: string }>
      onOpenEditorRequest: (
        handler: (payload: {
          scope: 'local' | 'remote'
          path: string
          connectionId?: string
          target: 'built-in' | 'external'
        }) => void,
      ) => () => void
      onCreateItemPrompt: (
        handler: (payload: { scope: 'local' | 'remote'; parentPath: string; type: 'file' | 'dir' }) => void,
      ) => () => void
      onRenameItemPrompt: (handler: (payload: { scope: 'local' | 'remote'; path: string }) => void) => () => void
      onDeleteItemPrompt: (handler: (payload: { scope: 'local' | 'remote'; path: string; type?: 'file' | 'dir' }) => void) => () => void
      onRemoteRefresh: (handler: (payload: { connectionId: string; remotePath: string }) => void) => () => void
    }
  }
}
