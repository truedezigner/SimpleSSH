# SFTP Sync App Plan (Electron + React + TypeScript)

## Goal
Build a Panic-quality, cross-platform (macOS + Windows) desktop SFTP app with a local workspace mirror, file browsing, auto-upload on save, and upload verification (size + hash).

## Scope (MVP)
- Electron + React + TypeScript desktop app.
- Connections UI: add/edit/delete connections, show password, test connection.
- Secure secrets: store passwords in OS keychain.
- Workspace mirror: download a remote folder into a local workspace.
- File browser UI for local workspace.
- Right-click actions: open in VS Code, reveal in Finder/Explorer, copy paths.
- Auto-upload on save with a transfer queue and clear status.
- Upload verification: size check + SHA-256 (remote exec preferred; download-back fallback).

## Milestones

### Milestone 1 — App Shell + Connections
- Electron app shell with React + TypeScript renderer.
- Connections list + editor form.
- Keychain-backed password storage (read/write).
- “Test Connection” flow (SSH connect + SFTP list).

### Milestone 2 — Workspace Mirror + File Browser
- Choose local workspace folder per connection.
- Initial sync: remote → local (download).
- Local file tree + list UI.
- Context menu actions (open in VS Code, reveal in OS, copy path).

### Milestone 3 — Auto-Upload + Queue
- File watcher on local workspace.
- Debounced uploads on save.
- Transfer queue with progress and error states.
- Temp upload + atomic rename to avoid partial files.

### Milestone 4 — Upload Verification
- Size check after upload.
- SHA-256 verification via remote exec when available.
- Fallback: download-back hashing when remote hash is unavailable.
- UI state: Uploading → Verifying → ✅ Complete / ❌ Failed.

## Tech Stack
- **Electron**: cross-platform desktop runtime.
- **React + TypeScript**: UI, state management, context menus.
- **ssh2**: SSH + SFTP + remote exec.
- **chokidar**: file watching for save events.
- **p-queue**: transfer concurrency and retry handling.
- **keytar**: secure password storage.

## Default Behaviors (NameHero / cPanel)
- Use SSH + SFTP with the same credentials.
- Default remote root: `/home/<user>/public_html`.
- Verify mode default: SHA-256 remote exec; fallback to download-back.
- Restrict paths within the user home directory (shared hosting safe).

## Deliverables (Docs)
- Architecture overview and folder layout.
- Connection storage schema.
- Upload verification strategy.
- Build and packaging steps for Windows and macOS.
