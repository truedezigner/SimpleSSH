# SimpleSSH

SimpleSSH is a Panic-inspired SFTP sync client built with Electron, React, and
TypeScript. It manages SSH connections, mirrors a remote folder locally, and
previews the local workspace tree. Upload queue and verification are built in.

## Current Features
- Connections list and editor.
- Per-connection options (remote index on connect, remote-first editing, folders-first sorting).
- Keychain-backed password storage.
- SSH key auth (paste private key, optional passphrase).
- Generate RSA key pair in `~/.ssh` with a required passphrase.
- Test connection (SSH + SFTP readdir).
- Workspace folder selection.
- Initial sync (remote -> local download).
- Remote file browser (column view + double-click download).
- Remote-first editing (download to cache + auto-upload on save, with superseded-save handling).
- Local workspace column view (lazy folder expansion).
- Inline create/rename for local and remote items in the column view.
- Context menu actions: new file/folder, rename, delete (local + remote).
- Auto-upload watcher with queued uploads (includes deletes + verification).
- Live sync mode (polls remote + last-write-wins resolution).
- Force push to upload local workspace in bulk.
- Bottom status bar with connection, roots, sync mode, and queue state.
- Status-strip popup with transfer history, filtering, and clear.
- Right-click actions (open in VS Code, reveal in OS, copy paths).
- Import/export of connection metadata.
- Frameless window with in-app window controls.
- Breadcrumb bar search placeholder (expand-on-click).
- Column view horizontal scrolling restored with sticky breadcrumb search.

## Planned Features
- Built-in code editor panel with per-connection preferences.
- Keep external editor support alongside the built-in editor.

## Quick Start
```
npm install
npm run dev
```

## Dev Launchers
Windows: double-click `simpleSSH-dev.cmd` in the repo root.

macOS:
```
chmod +x simpleSSH-dev.command
./simpleSSH-dev.command
```

## Windows Dev Shortcut
```
npm run make:dev-shortcut
```
Then right-click the Desktop shortcut "SimpleSSH (Dev)" and choose Pin to taskbar.
If the icon does not update, unpin and re-pin, then restart the dev server.
If the running app still shows the old icon, clear the Windows icon cache and restart.
If you add `assets/icons/app-256.png`, run `npm run make:ico` to regenerate `assets/icons/app.ico`.
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
- Column view filters/sorting (name/size/modified).
