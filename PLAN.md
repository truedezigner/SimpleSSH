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

### Milestone 2 - Workspace Mirror + File Browser (Done)
- Choose local workspace folder per connection. (Done)
- Initial sync: remote -> local (download). (Done)
- Local file explorer (column view). (Done)
- Context menu actions (open in VS Code, reveal in OS, copy path). (Done)
- Remote browser: lazy folder expansion + double-click download. (Done)

### Milestone 3 - Auto-Upload + Queue (Done)
- File watcher on local workspace. (Done)
- Debounced uploads on save. (Done)
- Transfer queue with status (pending/active/failed). (Done)
- Temp upload + atomic rename to avoid partial files. (Done)
- Upload progress (% bytes) in activity list. (Done)

### Milestone 4 - Upload Verification (Done)
- Size check after upload. (Done)
- SHA-256 verification via remote exec when available. (Done)
- Fallback: download-back hashing when remote hash is unavailable. (Done)
- UI state: Uploading -> Verifying -> Complete/Failed. (Done)

### Milestone 5 - Remote Explorer UX (Done)
- Remote browser in workspace panel. (Done)
- Always-visible status strip (connection, roots, sync, queue). (Done)
- Open downloaded files automatically. (Done)

## Tech Stack
- Electron
- React + TypeScript
- ssh2
- keytar
- chokidar
- p-queue

## Known Gaps / TODO
- Transfer queue has no dedicated history panel (status bar summary only).
- Live sync uses mtime comparisons rather than a full diff/merge engine.

## Upcoming Plan - Remote Cache Indexing
- Use incremental diff-merge during initial full index so existing cache entries are preserved.
- Ensure refresh only updates the current folder cache (add/remove/update) without touching other cached paths.
- Keep cache pinned by visit frequency and respect per-connection settings for pin thresholds and max pinned entries.
- Add a manual "Refresh this folder" action in the remote context menu (optional UX polish).
- Add a per-connection "Rebuild remote index" button in the connection editor. (Done)

## Notes for /new
- Implement the "Rebuild remote index" button in the connection editor and wire it to a full reindex. (Done)
- Add "Refresh this folder" to the remote context menu, using the force reload path.
- Convert initial index to diff-merge updates so existing cache entries are preserved.
