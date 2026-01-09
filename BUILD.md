# Build & Packaging

## Goals
- Produce a click-to-launch Windows `.exe` (portable build).
- Produce a macOS `.app` bundle.

## Tooling
- **electron-builder** for packaging.
- **npm scripts** for consistent builds.

## Example Build Scripts (Planned)
```json
{
  "scripts": {
    "start": "electron .",
    "dev": "electronmon .",
    "build:win": "electron-builder --win portable",
    "build:mac": "electron-builder --mac"
  }
}
```

## Windows (Portable EXE)
1. `npm install`
2. `npm run build:win`
3. Output appears in `dist/` as a portable `.exe`.

## macOS (.app)
1. `npm install`
2. `npm run build:mac`
3. Output appears in `dist/` as a `.app` bundle.

## Icons
- Windows: `icon.ico` (recommended 256x256)
- macOS: `icon.icns`

## Notes
- Code signing can be added later for distribution.
- For initial testing, unsigned builds are acceptable.
