# SimpleSSH

SimpleSSH is a Panic-inspired SFTP sync client built with Electron, React, and
TypeScript. It manages SSH connections, mirrors a remote folder locally, and
previews the local workspace tree. Upload queue and verification are planned.

## Current Features
- Connections list and editor.
- Keychain-backed password storage.
- SSH key auth (paste private key, optional passphrase).
- Generate RSA key pair in `~/.ssh` with a required passphrase.
- Test connection (SSH + SFTP readdir).
- Workspace folder selection.
- Initial sync (remote -> local download).
- Remote file browser (lazy expansion + double-click download).
- Local workspace tree preview (depth-limited).
- Auto-upload watcher with queued uploads (basic status, includes deletes + verification).
- Recent activity queue panel.
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
- Detailed transfer queue UI not implemented.
- Auto-open after remote download not implemented.
