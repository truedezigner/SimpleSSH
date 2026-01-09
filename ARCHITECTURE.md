# Architecture Overview

## High-Level Design
The app uses Electron with a React + TypeScript renderer and a Node-powered main process. The main process owns SFTP/SSH connections, file watching, and transfer logic. The renderer provides UI for connections, browsing, and transfer status.

```
Renderer (React UI)
  ├─ Connections list + editor
  ├─ Workspace file browser
  └─ Transfer queue and status
        ↑ IPC
Main (Electron/Node)
  ├─ Connections store (JSON)
  ├─ Secrets store (Keychain via keytar)
  ├─ SSH + SFTP client (ssh2)
  ├─ Sync engine (upload/download)
  ├─ Watcher (chokidar)
  └─ Verification (size + hash)
```

## Responsibilities

### Main Process
- Establish SSH and SFTP connections.
- Provide IPC handlers for:
  - Connection CRUD and password access.
  - Test connection.
  - Open workspace (initial download + watcher start).
  - Transfer queue operations.
- Manage file watchers and debounce/coalesce saves.
- Perform upload verification (size + SHA-256).

### Renderer
- Connection list and editor (including “show password”).
- Workspace file browser (tree + list).
- Context menu actions (open in VS Code, reveal in OS, copy paths).
- Transfer queue UI with states and errors.

## Key Modules (Planned)
- `main/sshClient.ts`: SSH connect + SFTP + exec wrappers.
- `main/connectionsStore.ts`: JSON metadata storage.
- `main/secretsStore.ts`: keytar wrappers for passwords.
- `main/sync/queue.ts`: p-queue transfer scheduling.
- `main/sync/watcher.ts`: chokidar watcher and event normalization.
- `main/sync/verify.ts`: local + remote hash logic.
- `renderer/views/ConnectionsView.tsx`: connections UI.
- `renderer/views/FileBrowserView.tsx`: local file browser.
- `renderer/views/TransfersView.tsx`: queue status UI.
