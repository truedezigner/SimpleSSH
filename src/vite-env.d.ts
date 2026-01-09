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
      remoteList: (payload: { connectionId: string; path: string }) => Promise<{ ok: boolean; message: string; nodes?: unknown[] }>
      downloadRemoteFile: (payload: { connectionId: string; remotePath: string }) => Promise<{ ok: boolean; message: string; localPath?: string }>
      startWatch: (payload: { connectionId: string }) => Promise<{ ok: boolean; message: string; status?: unknown }>
      stopWatch: (payload: { connectionId: string }) => Promise<{ ok: boolean; message: string; status?: unknown }>
      getQueueStatus: (payload: { connectionId: string }) => Promise<unknown | null>
      openInEditor: (payload: { path: string; codeCommand?: string }) => Promise<{ ok: boolean; message: string }>
      onQueueStatus: (handler: (status: unknown) => void) => () => void
      showContextMenu: (payload: { path: string; type: 'file' | 'dir'; codeCommand?: string }) => Promise<{ ok: boolean; message: string }>
    }
  }
}
