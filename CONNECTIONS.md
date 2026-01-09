# Connections & Credentials

## Connection Metadata (JSON)
Stored in the app data directory (e.g., `%APPDATA%/SFTPSync` on Windows, `~/Library/Application Support` on macOS).

```json
[
  {
    "id": "conn_abc123",
    "name": "NameHero - Site A",
    "host": "server.namehero.net",
    "port": 22,
    "username": "cpaneluser",
    "authType": "password",
    "remoteRoot": "/home/cpaneluser/public_html",
    "localRoot": "C:\\Users\\you\\SFTPSync\\SiteA",
    "verifyMode": "sha256-remote",
    "codeCommand": "code"
  }
]
```

## Secrets (Passwords & Passphrases)
Passwords are stored in the OS keychain via `keytar` and are never written to JSON. The UI can show the password by reading it from the keychain.

**Key naming convention**
- Service: `sftp-sync`
- Account: `conn:<id>:password`

## Test Connection Flow
1. Open SSH session.
2. Open SFTP subsystem.
3. `readdir(remoteRoot)` (or `stat`) to verify access.
4. Return success or error with a user-friendly message.

## Recommended Defaults for NameHero/cPanel
- SSH/SFTP enabled in cPanel.
- Default remote root: `/home/<user>/public_html`.
- Verification mode: `sha256-remote`, fallback to download-back if remote hashing fails.
