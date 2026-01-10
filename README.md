# SimpleSSH

SimpleSSH is a Panic-inspired SFTP sync client built with Electron, React, and
TypeScript. It manages SSH connections, mirrors a remote folder locally, and
previews the local workspace tree. Upload queue and verification are built in.

## Current Features
- Connections list and editor.
- Keychain-backed password storage.
- SSH key auth (paste private key, optional passphrase).
- Generate RSA key pair in `~/.ssh` with a required passphrase.
- Test connection (SSH + SFTP readdir).
- Workspace folder selection.
- Initial sync (remote -> local download).
- Remote file browser (column view + double-click download).
- Remote-first editing (download to cache + auto-upload on save).
- Local workspace column view (lazy folder expansion).
- Auto-upload watcher with queued uploads (includes deletes + verification).
- Live sync mode (polls remote + last-write-wins resolution).
- Force push to upload local workspace in bulk.
- Bottom status bar with connection, roots, sync mode, and queue state.
- Status-strip popup with transfer history, filtering, and clear.
- Right-click actions (open in VS Code, reveal in OS, copy paths).
- Import/export of connection metadata.

## Quick Start
```
npm install
npm run dev
```

## Build
```
npm run build:win
npm run build:mac
```

## Project Structure
- electron/main: main process (IPC, SSH, sync)
- electron/preload: safe renderer API
- src: renderer UI

## Known Gaps
- Live sync is mtime-based (no full content diff/merge).
