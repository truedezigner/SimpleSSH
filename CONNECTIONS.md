# Connections & Credentials

## Connection Metadata (JSON)
Stored in the app data directory:
- Windows: %APPDATA%\SimpleSSH\connections.json
- macOS: ~/Library/Application Support/SimpleSSH/connections.json

UI note: the connections drawer and editor map 1:1 to this metadata.

Example:
```
[
  {
    "id": "conn_abc123",
    "name": "NameHero - Site A",
    "host": "server.namehero.net",
    "port": 22,
    "username": "cpaneluser",
    "authType": "key",
    "keyName": "alca",
    "remoteRoot": "/home/cpaneluser/public_html",
    "localRoot": "C:\\Users\\you\\SFTPSync\\SiteA",
    "verifyMode": "sha256-remote",
    "syncMode": "manual",
    "remoteFirstEditing": false,
    "foldersFirst": true,
    "codeCommand": "code"
  }
]
```

## Secrets (Passwords & Passphrases)
Passwords and private keys are stored in the OS keychain via keytar and are
never written to JSON.

Key naming convention:
- Service: sftp-sync
- Account: conn:<id>:password
- Account: conn:<id>:privateKey
- Account: conn:<id>:passphrase

## Test Connection Flow
1. Open SSH session.
2. Open SFTP subsystem.
3. readdir(remoteRoot) to verify access.
4. Return success or error with a user-friendly message.

## Import / Export
- Export writes connections metadata to a JSON file.
- Import reads JSON and upserts each connection.
- Passwords are not exported or imported.

## Remote-First Editing (Beta)
When enabled per connection, remote file downloads are stored in a managed cache
and auto-uploaded back to the original remote path on save. This avoids the need
for local root mirroring.
If a new local save happens during verification, the queue item is marked as
superseded and the newer save is uploaded next.

Cache location:
- Windows: %APPDATA%\SimpleSSH\remote-cache\<connectionId>\
- macOS: ~/Library/Application Support/SimpleSSH/remote-cache/<connectionId>/

Use "Clear Remote Cache" in the connection editor to delete cached files.

## Recommended Defaults (NameHero / cPanel)
- SSH/SFTP enabled in cPanel.
- Default remote root: /home/<user>/public_html.
- Verify mode default: sha256-remote, fallback to download-back.

## Sync Modes
- manual: only sync when you click Sync/Force Push.
- upload: auto-upload local changes.
- live: auto-upload local changes + poll remote for updates (mtime-based, last-write-wins).
