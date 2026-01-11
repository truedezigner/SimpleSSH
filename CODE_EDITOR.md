# Code Editor Panel

## Goal
Add a built-in code editor panel while preserving the ability to open files in an external editor.

## Core Requirements
- Provide a toggle to open files in the built-in editor or the external editor.
- Preserve the existing per-connection `codeCommand` for external editor launches.
- Support per-connection defaults (built-in vs external).
- Support editor-specific preferences (font size, tab size, soft tabs, word wrap).
- Let users set the built-in editor layout (full vs 50/50 split) per connection.

## UX Notes
- The connection editor should contain a dedicated "Code Editor" section.
- The section should group boolean toggles at the top of the editor form.
- External editor launch remains available from file context actions.

## Data Model
- Add per-connection fields for:
  - `editorPreference`: `built-in` or `external`
  - `editorLayout`: `full` or `split`
  - `editorFontSize`: number
  - `editorTabSize`: number
  - `editorSoftTabs`: boolean
  - `editorWordWrap`: boolean
- Keep defaults sensible and backwards compatible.

## File Behavior
- If the built-in editor is enabled, double-click opens the embedded editor.
- If external is preferred, double-click opens the external editor as it does today.
- Offer a quick action to open in the other editor (built-in vs external) from the context menu.

## Non-Goals (for now)
- Collaboration or multi-user editing.
- Syntax-aware project indexing.
- Deep git integration beyond basic file editing.
