# OpenClaw Design System

OpenClaw's visual language is a **dark-first, glass-surface system** built around a deep charcoal base (`#0e1015`), a punchy signature red accent (`#ff5c5c`), and layered frosted-glass surfaces that create depth without solid panels. Motion is crisp and purposeful — fast micro-interactions (100ms) with spring-loaded expansions. All interactive elements meet WCAG 2.1 AA contrast requirements on dark backgrounds.

## Contents

| File                                       | What it covers                                                                          |
| ------------------------------------------ | --------------------------------------------------------------------------------------- |
| [glass-surfaces.md](./glass-surfaces.md)   | Two glass tiers, exact CSS values, no-solid-panels rule, `@supports` fallback           |
| [color-tokens.md](./color-tokens.md)       | All design tokens with values, usage, contrast ratios, and anti-patterns                |
| [motion.md](./motion.md)                   | Duration scale, easing functions, `prefers-reduced-motion` pattern, animation inventory |
| [accessibility.md](./accessibility.md)     | WCAG checklist: contrast, focus, tap targets, ARIA, skip link, focus trap               |
| [settings-design.md](./settings-design.md) | Settings page anatomy: sections, groups, rows, controls, status dots, migration rules   |

## Guiding Principles

1. **Glass, not solid** — Surfaces use `backdrop-filter` blur + semi-transparent backgrounds. No flat opaque panels in the main chrome.
2. **Depth through layering** — The background scale (`--bg`, `--bg-accent`, `--bg-elevated`, `--bg-hover`, `--bg-muted`) communicates hierarchy without heavy borders.
3. **Accent with restraint** — Signature red (`--accent: #ff5c5c`) for primary actions only; teal (`--accent-2`) for secondary/status.
4. **Motion serves meaning** — Animations telegraph state changes; they never play for decoration alone.
5. **Accessible by default** — Every component ships with focus-visible styles, correct ARIA roles, and ≥4.5:1 contrast on text.
