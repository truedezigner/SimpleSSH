# SimpleSSH UI Style Guide (Panic-inspired)

This UI borrows the calm, luminous, and high-contrast language seen in Panic apps
like Nova and Prompt 3. The core idea is a dark, cinematic canvas with glassy panels,
precise type, and focused color accents.

## Design Principles
- Dark, saturated backgrounds with layered gradients.
- Translucent panels with soft borders and blur for depth.
- Precise, minimal typography. Prefer Space Grotesk for UI.
- Accents are neon-tinted: violet, cyan, and pink, never flat.
- Controls feel tactile: soft glow, subtle lift on hover.

## Color System
- Background: #0a071c to #1c1142 (deep indigo)
- Panel fill: rgba(20, 18, 45, 0.78)
- Panel border: rgba(124, 110, 255, 0.2)
- Text primary: #e8e5ff
- Text muted: rgba(232, 229, 255, 0.6)
- Accent gradient: #6f65ff to #ff8ed2
- Success: #8cf6c4
- Error: #ff9aad

## Typography
- UI: Space Grotesk, 12-18px range
- Code/paths: JetBrains Mono when needed
- Uppercase micro labels with tracking for panels

## Layout
- Top bar with centered Remote/Local tabs and action buttons on the right
- Connections drawer overlay for list + editor
- Column explorer with inline file badges
- Bottom status bar with text dividers
- Rounded panels (18-22px) and tight 12-16px spacing

## Motion
- Subtle lift on hover (1px) and shadow deepen
- Slow drifting background grid (ambient motion)
