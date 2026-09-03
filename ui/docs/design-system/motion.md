# Motion

OpenClaw uses a three-step duration scale with purpose-matched easing functions. Every animation should serve a functional goal — transitions that exist only for aesthetics add cognitive load without benefit.

---

## Duration Scale

Defined in `ui/src/styles/base.css`:

| Token               | Value   | Use                                                       |
| ------------------- | ------- | --------------------------------------------------------- |
| `--duration-fast`   | `100ms` | Micro-interactions: hover color, focus ring, icon swap    |
| `--duration-normal` | `180ms` | Standard transitions: menu open, tab switch, input expand |
| `--duration-slow`   | `300ms` | Page-level: sheet slide-in, modal fade, skeleton reveal   |

Non-token durations in use (document when adding new ones):

| Context                 | Value                          | File              |
| ----------------------- | ------------------------------ | ----------------- |
| Theme circle transition | `400ms`                        | `base.css`        |
| Shimmer animation       | `1500ms`                       | `base.css`        |
| Composer border/shadow  | `var(--duration-fast)` = 100ms | `chat/layout.css` |

---

## Easing Functions

Defined in `ui/src/styles/base.css`:

| Token           | Curve                               | Use                                                     |
| --------------- | ----------------------------------- | ------------------------------------------------------- |
| `--ease-out`    | `cubic-bezier(0.16, 1, 0.3, 1)`     | Most enter/expand transitions — fast start, smooth land |
| `--ease-in-out` | `cubic-bezier(0.4, 0, 0.2, 1)`      | Elements that travel across screen (slides, drawers)    |
| `--ease-spring` | `cubic-bezier(0.34, 1.56, 0.64, 1)` | Playful/tactile: button press, badge pop, icon bounce   |

**Default rule of thumb:** Use `--ease-out` unless the element explicitly moves from point A to point B (use `--ease-in-out`) or needs a bouncy feel (use `--ease-spring`).

---

## `prefers-reduced-motion` Pattern

Every animation or transition **must** be suppressed when the user has requested reduced motion. Use the global reset already present in `base.css` for light DOM. Shadow roots need a local guard because the global reset cannot reach them. Otherwise, add per-component overrides only to preserve a non-animated state change (e.g. instant opacity change is acceptable, instant position snap is acceptable).

```css
/* Already in base.css — covers animations and transitions in light DOM */
@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
}
```

Light-DOM components get the `.skeleton` primitive and reduced-motion gate from `base.css`. A component rendered inside shadow roots, such as the panel loading skeleton hosted by the terminal, desktop, and browser panels, carries a declaration-identical copy of the primitive plus its own reduced-motion guard. `ui/src/components/panel-loading-skeleton.test.ts` guards the primitive against drift.

Opt-in decorative motion that should vanish entirely, such as text shimmers, belongs inside `@media (prefers-reduced-motion: no-preference)`. Reduced-motion users keep plain static text.

---

## Animation Inventory

| Name                      | File                       | Duration                              | Purpose                                                                                                          |
| ------------------------- | -------------------------- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `shimmer`                 | `base.css`                 | 1500ms, infinite                      | `.skeleton::after` transform; compositor-only, locked by `ui/src/styles/shimmer.browser.test.ts`                 |
| `text-shimmer`            | `base.css`                 | 2.2s tool row; 2s dictation, infinite | Background-position sweep on a text-clipped gradient: running tool-row verb/command and dictation listening text |
| `compaction-shimmer`      | `chat/composer-status.css` | 3.2s, infinite                        | Text-clipped gradient sweep with hold frames                                                                     |
| `theme-circle-transition` | `base.css`                 | 400ms, `--ease-out`                   | Dark/light mode circle wipe                                                                                      |
| Composer border/shadow    | `chat/layout.css`          | 100ms (`--duration-fast`)             | Focus ring on input area                                                                                         |
| Workboard card glass      | `workboard.css`            | —                                     | Static (no animation)                                                                                            |
| Dreams diary reveal       | `dreams.css`               | 1.4s, cubic-bezier                    | Entry reveal keyframe with blur-to-clear effect                                                                  |

---

## Anti-Patterns

- ❌ Adding new keyframe animations without a `prefers-reduced-motion` suppression
- ❌ Using `animation-iteration-count: infinite` outside of active loading or listening indicators
- ❌ Duration > 500ms for UI chrome elements (feels sluggish)
- ❌ `linear` easing for enter/exit — always use a curve from the token set
- ❌ CSS transitions on `transform` and `opacity` simultaneously with `filter` — causes GPU layer explosion on mobile
