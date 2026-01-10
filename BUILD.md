# Build & Packaging

## Goals
- Produce a click-to-launch Windows .exe (portable build).
- Produce a macOS .app bundle.

## Tooling
- electron-builder for packaging.
- npm scripts for consistent builds.

## Scripts (Current)
```
start      -> vite
dev        -> vite
build      -> tsc && vite build && electron-builder
build:win  -> tsc && vite build && electron-builder --win portable
build:mac  -> tsc && vite build && electron-builder --mac
```

## Windows (Portable EXE)
1. npm install
2. npm run build:win
3. Output appears in dist/ as a portable .exe.

## macOS (.app)
1. npm install
2. npm run build:mac
3. Output appears in dist/ as a .app bundle.

## Icons
- Windows: build/icon.ico
- macOS: build/icon.icns

## Notes
- Code signing can be added later for distribution.
- For initial testing, unsigned builds are acceptable.
- UI/feature notes live in README.md and are kept up to date with the app shell.
