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
- Create/rename/delete local + remote items from the column view. (Done)

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
- Live sync uses mtime comparisons rather than a full diff/merge engine.
- Column view filters/sorting (name/size/modified).
- Breadcrumb jump: clicking a parent segment can leave the column view empty even though the folder has contents.

## Upcoming Plan - Remote Cache Indexing
- Use incremental diff-merge during initial full index so existing cache entries are preserved. (Done)
- Ensure refresh only updates the current folder cache (add/remove/update) without touching other cached paths. (Done)
- Keep cache pinned by visit frequency and respect per-connection settings for pin thresholds and max pinned entries.
- Add a manual "Refresh this folder" action in the remote context menu (optional UX polish). (Done)
- Add a per-connection "Rebuild remote index" button in the connection editor. (Done)

## Notes for /new
- Implement the "Rebuild remote index" button in the connection editor and wire it to a full reindex. (Done)
- Add "Refresh this folder" to the remote context menu, using the force reload path. (Done)
- Convert initial index to diff-merge updates so existing cache entries are preserved. (Done)

## Next Milestone - Transfer Queue History Panel (Done)
- Add a dedicated history panel for transfer queue items. (Done)
- Include filtering for status (failed/complete/active). (Done)
- Support clearing the history list per connection. (Done)
- Show timestamps and error details for failed entries. (Done)

## Next Milestone - Code Editor Panel (Planned)
- Add a dedicated section in the connection editor for code editor settings.
- Support per-connection editor command and any editor-specific toggles.
- Keep boolean options grouped at the top for quick scanning.
- Build a built-in editor panel with a configurable editor preference (built-in vs external).
- Provide context menu actions to open in the other editor.
- Expose per-connection editor defaults (font size, tab size, soft tabs, word wrap).

## Plan - Default Local Mirror of Remote Paths (Planned)
- When setting a local root, create a default mapping that mirrors the remote folder hierarchy under that root.
- Example: remote `public_html/haasedesigns.com` lands at local `<localRoot>/public_html/haasedesigns.com`.
- Ensure remote downloads preserve parent folders without overwriting existing local files.

## Release Notes / Reminders
- Merge branch `test-feature-history` into `main` when ready and push to origin.

## Plan - Remote-First Editing + Safe Auto-Upload (Done)

### Goal
Enable a "remote-first" flow: open a remote file, edit locally, and have saves
auto-upload back to the original remote path even if the local root does not
mirror the remote tree. Preserve the existing ability to force-upload new local
files that do not exist remotely.

### Proposed UX
- Remote file double-click:
  - Downloads to a temp / managed local cache path.
  - Opens in the configured editor.
  - Associates local cache file with its original remote path.
- Local file list:
  - Show cached files in a dedicated "Remote Cache" section (or tag/label).
  - Context menu: "Force Upload Back to Original Path" for cached files.
- Existing force upload:
  - Continues to upload based on localRoot -> remoteRoot mapping for normal local files.

### Data Model / Storage
- Store mapping: localCachePath -> { connectionId, remotePath, mtime, size, lastSyncAt }.
- Persist in app data (per-connection) so local cache stays clean:
  - Windows: %APPDATA%\\SimpleSSH\\cache-map.json
  - macOS: ~/Library/Application Support/SimpleSSH/cache-map.json
- Cleanup policy:
  - Evict entries older than N days or when cache exceeds size limit.

### Sync Behavior
- When a cached file changes:
  - Use stored remotePath for upload (ignore localRoot mapping).
  - Verify upload (existing hash/size verification).
  - Update cache entry metadata on success.
- When remote changes are detected (live mode):
  - If a cached file exists for that remotePath, refresh the local cache file.

### Safety
- Confirmation prompt if the stored remotePath differs from the computed mapped path.
- Never delete remote files from cached file edits (uploads only).
- Keep auto-sync optional; remote-first flow works in manual or upload modes.

### Implementation Steps
1) Add cache directory per connection; implement download-into-cache. (Done)
2) Create cache mapping store + load/save helpers. (Done)
3) Extend uploader to detect cached file paths and route uploads to stored remotePath. (Done)
4) UI: remote-first toggle + clear cache action. (Done)
5) Verify uploads are resilient to rapid re-saves (superseded verification note). (Done)
6) Update docs (README / CONNECTIONS) to describe the remote-first flow. (Done)
