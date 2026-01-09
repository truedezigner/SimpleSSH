# SimpleSSH Plan

## Goal
Build a Panic-quality, cross-platform (macOS + Windows) desktop SFTP app with a
local workspace mirror, file browsing, auto-upload on save, and upload
verification (size + hash).

## Scope (MVP)
- Electron + React + TypeScript desktop app.
- Connections UI: add/edit/delete connections, show password, test connection.
- Secure secrets: store passwords/private keys in OS keychain.
- Remote file browser with lazy folder expansion.
- Download-on-open: double-click remote files to pull into local workspace.
- Local file browser UI for workspace preview.
- Right-click actions: open in VS Code, reveal in Finder/Explorer, copy paths.
- Auto-upload on save with a transfer queue and clear status.
- Upload verification: size check + SHA-256 (remote exec preferred; download-back fallback).

## Milestones

### Milestone 1 - App Shell + Connections (Done)
- Electron app shell with React + TypeScript renderer.
- Connections list + editor form.
- Keychain-backed password/private key storage (read/write).
- Test Connection flow (SSH connect + SFTP readdir).

### Milestone 2 - Workspace Mirror + File Browser (Partial)
- Choose local workspace folder per connection. (Done)
- Initial sync: remote -> local (download). (Done)
- Local file tree preview (depth-limited). (Done)
- Context menu actions (open in VS Code, reveal in OS, copy path). (Done)
- Remote browser: lazy folder expansion + double-click download. (Done)

### Milestone 3 - Auto-Upload + Queue (Not done)
- File watcher on local workspace. (Done)
- Debounced uploads on save. (Done)
- Transfer queue with status (pending/active/failed). (Done)
- Temp upload + atomic rename to avoid partial files. (Done)
- Upload progress (% bytes) in activity list. (Done)

### Milestone 4 - Upload Verification (Not done)
- Size check after upload. (Done)
- SHA-256 verification via remote exec when available. (Done)
- Fallback: download-back hashing when remote hash is unavailable. (Done)
- UI state: Uploading -> Verifying -> Complete/Failed. (Done)

### Milestone 5 - Remote Explorer UX (Partial)
- Remote browser in workspace panel. (Done)
- Always-visible status strip (connection + sync). (Done)
- Open downloaded files automatically. (Not done)

## Tech Stack
- Electron
- React + TypeScript
- ssh2
- keytar
- chokidar (planned)
- p-queue (planned)

## Known Gaps / TODO
- No local -> remote sync yet (only remote -> local download).
- No watcher, queue, or verification yet.
- File actions (open in editor, reveal, copy path) are now available via right-click in the workspace tree.
- Example connection UI exists but does not open OS file explorer.
