# Color Tokens

All tokens are defined in `ui/src/styles/base.css` under `:root` (dark mode default) and `:root[data-theme-mode="light"]` (light override). Values in this doc are the default claw family; the knot (`data-theme="openknot"`/`openknot-light`) and dash (`dash`/`dash-light`) families override surface, accent, and status tokens in their own `base.css` blocks, each with its own WCAG audit comment.

> Contrast ratios are measured against `--bg` (`#0e1015`) in dark mode using WCAG relative luminance formula. AA requires ≥4.5:1 for normal text, ≥3:1 for large text and UI components.

---

## Background Scale

| Token           | Dark Value | Light Value | Use                           | Don't                          |
| --------------- | ---------- | ----------- | ----------------------------- | ------------------------------ |
| `--bg`          | `#0e1015`  | `#faf9f7`   | Page root, deepest layer      | Never use on elevated surfaces |
| `--bg-accent`   | `#13151b`  | `#f4f1ec`   | Sidebar, secondary panels     | Not for interactive card hover |
| `--bg-elevated` | `#191c24`  | `#ffffff`   | Raised panels, modals         | Not for inline elements        |
| `--bg-hover`    | `#1f2330`  | `#efebe4`   | List item hover state         | Not for default state          |
| `--bg-muted`    | `#1f2330`  | `#efebe4`   | Subtle fills, disabled states | Not for focus states           |

Light mode uses a warm paper palette: ivory backgrounds, warm gray borders (`#e8e4dc`), and a terracotta accent (`#bd4531`, ≈4.9:1 on `--bg`). Dark mode keeps the signature coral red.

## Surface / Card

| Token                  | Dark Value               | Light Value           | Use                           | Don't           |
| ---------------------- | ------------------------ | --------------------- | ----------------------------- | --------------- |
| `--card`               | `#161920`                | `#ffffff`             | Card backgrounds, composer    | Avoid as border |
| `--card-foreground`    | `#f0f0f2`                | `#211e1a`             | Text on cards                 | —               |
| `--card-highlight`     | `rgba(255,255,255,0.04)` | `rgba(60,42,24,0.03)` | Inner highlight on hover      | Not for text    |
| `--popover`            | `#191c24`                | `#ffffff`             | Dropdown, tooltip backgrounds | —               |
| `--popover-foreground` | `#f0f0f2`                | `#211e1a`             | Text inside popovers          | —               |

## Text

| Token            | Dark Value | Contrast on `--bg` | Use                                                |
| ---------------- | ---------- | ------------------ | -------------------------------------------------- |
| `--text`         | `#bcbcc0`  | ~10.1:1 ✅         | Body copy, labels                                  |
| `--text-strong`  | `#f4f4f5`  | ~17.3:1 ✅         | Headings, emphasis                                 |
| `--muted`        | `#8b8b94`  | ~5.6:1 ✅          | Placeholder, metadata                              |
| `--muted-strong` | `#898990`  | ~5.5:1 ✅          | Secondary text, captions; prefer `--text` for body |

## Accent (Primary — Red)

| Token             | Value                 | Use                                            | Don't                                    |
| ----------------- | --------------------- | ---------------------------------------------- | ---------------------------------------- |
| `--accent`        | `#ff5c5c`             | Primary CTA, send button, active tab indicator | Don't use for large filled backgrounds   |
| `--accent-hover`  | `#ff7070`             | Hover state of accent elements                 | —                                        |
| `--accent-muted`  | `#ff5c5c`             | Same as accent (aliased)                       | —                                        |
| `--accent-subtle` | `rgba(255,92,92,0.1)` | Badge backgrounds, tinted fills                | Not for text on dark bg (fails contrast) |
| `--accent-glow`   | `rgba(255,92,92,0.2)` | Focus rings, glow effects                      | Not as background                        |
| `--primary`       | `#d13c3c`             | Filled primary buttons (white text, ~4.8:1 AA) | Not interchangeable with `--accent`      |

## Accent 2 (Teal)

| Token               | Value                  | Use                                       |
| ------------------- | ---------------------- | ----------------------------------------- |
| `--accent-2`        | `#14b8a6`              | Success-adjacent status, secondary badges |
| `--accent-2-muted`  | `rgba(20,184,166,0.7)` | Subtle teal fills                         |
| `--accent-2-subtle` | `rgba(20,184,166,0.1)` | Tinted teal background                    |

## Semantic

| Token           | Dark Value | Light Value | Contrast on dark `--bg` | Use                                            |
| --------------- | ---------- | ----------- | ----------------------- | ---------------------------------------------- |
| `--ok`          | `#22c55e`  | `#166534`   | ~8.4:1 ✅               | Success states, token meter low                |
| `--warn`        | `#f59e0b`  | `#92400e`   | ~8.9:1 ✅               | Warnings, degraded states                      |
| `--danger`      | `#f87171`  | `#b91c1c`   | ~6.9:1 ✅               | Errors, destructive text, token meter high     |
| `--info`        | `#60a5fa`  | `#1d4ed8`   | ~7.5:1 ✅               | Informational, token meter mid                 |
| `--destructive` | `#d32f2f`  | `#dc2626`   | ~3.8:1 (fill only)      | Destructive button fills (with `#fafafa` text) |

Each `--x` has `-muted` (0.75 alpha) and `-subtle` (0.08 alpha) rgba siblings that must stay in sync with the base hex — the base doubles as label text on its own subtle tint, and re-tinting one without the other silently drops the pair below AA. Bases stay literal hex because `widget-theme.ts` publishes them to MCP app guest documents where `color-mix()` would not resolve. See the audit comments in `base.css` for the per-theme measurements.

The dark `--destructive` value is the claw-family override (`:root[data-theme="dark"]`); the shared `:root` fallback is `#ef4444`.

## Border

| Token             | Value     | Use                              |
| ----------------- | --------- | -------------------------------- |
| `--border`        | `#1e2028` | Default subtle borders, dividers |
| `--border-strong` | `#2e3040` | Active/focused borders           |
| `--border-hover`  | `#3e4050` | Hover-state borders              |

## Focus

| Token          | Value                                                                             | Use                            |
| -------------- | --------------------------------------------------------------------------------- | ------------------------------ |
| `--ring`       | `#ff5c5c`                                                                         | Focus ring colour              |
| `--focus-ring` | `0 0 0 2px var(--bg), 0 0 0 3px color-mix(in srgb, var(--ring) 80%, transparent)` | Standard focus ring box-shadow |
| `--focus-glow` | `0 0 0 2px var(--bg), 0 0 0 3px var(--ring), 0 0 16px var(--accent-glow)`         | Elevated interactive elements  |

---

## Anti-Patterns

- ❌ Hardcoded hex colours in component CSS — always use tokens
- ❌ `--accent-subtle` as text colour — fails contrast on dark backgrounds
- ❌ Mixing `--ok` and `--accent-2` for "green success" — use `--ok` only
- ❌ Using `--danger` for non-error states (e.g. "hot feature") — reserve for errors and destructive actions
- ❌ `--muted-strong` for normal body text — passes AA on `--bg` but not on every hover/input surface; use `--text` instead
