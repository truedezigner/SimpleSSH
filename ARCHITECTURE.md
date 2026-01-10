# SimpleSSH Architecture

## High-Level Design
SimpleSSH is an Electron app with a React + TypeScript renderer and a Node-powered
main process. The main process owns SSH/SFTP connections, secrets, and workspace
sync. The renderer provides connection management UI, workspace overview, and
status feedback.

```
Renderer (React UI)
  - Connections list + editor
  - Workspace column file explorer with badges
  - Top bar actions (sync, force push, auto sync, reload)
  - Bottom status bar (connection, roots, sync, queue)
        |
        +-- IPC
Main (Electron/Node)
  - Connections store (JSON)
  - Secrets store (keytar)
  - SSH + SFTP client (ssh2)
  - Workspace sync (remote -> local + live polling)
  - Remote browser (lazy SFTP list + download)
  - Local file tree scan
```

## Responsibilities

### Main Process
- Store connection metadata in a JSON file under app userData.
- Store secrets (passwords/private keys) in OS keychain via keytar.
- Provide IPC handlers for:
  - Connection CRUD + password access.
  - Test connection (SSH + SFTP readdir).
  - Workspace selection, sync, remote list/download, and local scan.
  - Auto-upload watcher with queue + verification, plus live sync polling.
  - Import/export connections (metadata only).

### Renderer
- List, add, edit, and delete connections.
- Validate inputs and auto-derive remote root from username.
- Pick a local workspace folder.
- Trigger remote sync and reload the active tree view.
- Show status for test and sync operations.

## Key Modules (Current)
- `electron/main/connectionsStore.ts`: JSON metadata storage.
- `electron/main/secretsStore.ts`: keytar wrappers for passwords.
- `electron/main/sshClient.ts`: SSH connect + SFTP readdir for testing.
- `electron/main/workspace.ts`: remote browser + download + local tree scan.
- `electron/main/uploader.ts`: watcher + upload queue + verification + live sync polling.
- `electron/main/ipc.ts`: IPC handlers.
- `electron/preload/index.ts`: secure API exposed to renderer.
- `src/App.tsx`: connections UI, workspace preview, actions.

## Gaps / Not Implemented Yet
- Transfer queue has no dedicated history panel (status bar summary only).
- Live sync uses mtime comparisons rather than content merging.
