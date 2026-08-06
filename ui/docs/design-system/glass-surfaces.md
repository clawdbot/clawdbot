# Glass Surfaces

OpenClaw uses two glass tiers to establish visual hierarchy. **Never use flat, fully-opaque backgrounds** in the main chrome — glass creates the lived-in depth that defines the visual language.

---

## Tier 1 — Navigation Chrome

Used for: top nav, sidebar, persistent chrome overlays.

```css
/* Exact values from ui/src/styles/layout.css — .topbar */
background: color-mix(in srgb, var(--bg) 82%, transparent);
backdrop-filter: blur(12px) saturate(1.6);
-webkit-backdrop-filter: blur(12px) saturate(1.6);
```

**Why these values:** the topbar mixes the root background with transparency so it stays readable while still refracting content behind it. `saturate(1.6)` brings out colour from blurred layers.

---

## Tier 2 — Card / Input Surfaces

Used for: chat composer input box, modals, popovers, settings cards, dropdowns.

```css
/* Exact values from ui/src/styles/chat/layout.css — .agent-chat__input */
background: var(--card); /* #161920 */
border: 1px solid var(--border); /* #1e2028 */
border-radius: var(--radius-lg); /* 14px */

@supports (backdrop-filter: blur(1px)) {
  backdrop-filter: blur(12px) saturate(1.6);
  -webkit-backdrop-filter: blur(12px) saturate(1.6);
}
```

Popovers and floating overlays reduce blur slightly:

```css
/* Exact values from source */
backdrop-filter: blur(
  8px
); /* components.css action menu, cron-quick-create.css modal backdrop, workboard.css modal backdrop */
backdrop-filter: blur(10px); /* skill-workshop.css revision dialog, dreams.css media lightbox */
backdrop-filter: blur(14px); /* components.css markdown preview dialog backdrop */
```

---

## The No-Solid-Panels Rule

> **Do not** add `background: var(--bg)` or any fully-opaque fill to a surface that appears above other content.

Use the `@supports` fallback pattern below instead. Browsers that lack `backdrop-filter` fall back gracefully to the semi-opaque base without breaking layout.

### `@supports` Fallback Pattern

```css
.my-surface {
  /* Fallback for older browsers / Firefox without backdrop-filter */
  background: rgba(14, 16, 21, 0.92);
}

@supports (backdrop-filter: blur(1px)) {
  .my-surface {
    background: rgba(14, 16, 21, 0.75);
    backdrop-filter: blur(12px) saturate(1.6);
    -webkit-backdrop-filter: blur(12px) saturate(1.6);
  }
}
```

---

## When to Use Each Tier

| Context                | Tier | Blur |
| ---------------------- | ---- | ---- |
| Top nav / sidebar rail | 1    | 12px |
| Chat composer          | 2    | 12px |
| Modal / dialog         | 2    | 10px |
| Dropdown / popover     | 2    | 8px  |
| Tooltip                | 2    | 14px |
| Workboard card         | 2    | 10px |

---

## Anti-Patterns

- ❌ `background: var(--bg)` on a surface element (use glass instead)
- ❌ `backdrop-filter` without `-webkit-backdrop-filter` (Safari still requires prefix)
- ❌ Nesting glass surfaces more than 2 levels (causes noticeable blur stacking on macOS)
- ❌ Using `blur(>16px)` outside of modal overlays (hurts performance on mid-tier devices)
