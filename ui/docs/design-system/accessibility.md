# Accessibility

OpenClaw targets **WCAG 2.1 AA**. This checklist applies to every UI component — use it when building new components and during PR review.

---

## Contrast Minimums

| Context                                   | Minimum Ratio    | Notes                                              |
| ----------------------------------------- | ---------------- | -------------------------------------------------- |
| Normal body text (< 18px / < 14px bold)   | **4.5:1**        | Use `--text` (#d4d4d8) or stronger on `--bg`       |
| Large text (≥ 18px regular / ≥ 14px bold) | **3:1**          | Headings in chat thread                            |
| UI component boundaries (inputs, buttons) | **3:1**          | Border colours against adjacent background         |
| Focus indicators                          | **3:1** (AA)     | `--focus-ring` / `--focus-glow` already compliant  |
| Placeholder text                          | Best-effort ≥3:1 | `--muted` (#838387) is ~5:1 on `--bg` — acceptable |

> Verify with [WebAIM Contrast Checker](https://webaim.org/resources/contrastchecker/) or browser DevTools accessibility panel.

---

## Checklist

### 1. Focus Visible

- [ ] All interactive elements have a visible `:focus-visible` style
- [ ] Use `--focus-ring` box-shadow pattern from `base.css` — do not remove the outline without replacing it
- [ ] Never use `outline: none` alone; replace with `box-shadow: var(--focus-ring)` and `outline: none`

```css
/* Correct pattern */
.my-button:focus-visible {
  outline: none;
  box-shadow: var(--focus-ring);
}
```

### 2. Minimum Tap / Click Target Size

- [ ] All interactive controls are ≥ **44×44px** on mobile / touch targets
- [ ] Icon-only buttons add invisible padding to reach 44px (`min-width: 44px; min-height: 44px`)
- [ ] Verify on the mobile breakpoint (`@media (max-width: 768px)`)

### 3. Skip Link

- [ ] A visually-hidden skip link (`#skip-to-main`) is present in the document root
- [ ] The link becomes visible on focus
- [ ] Target element has `tabindex="-1"` to accept programmatic focus

```html
<a id="skip-to-main" href="#main-content" class="skip-link">Skip to main content</a>
```

```css
.skip-link {
  position: absolute;
  left: -9999px;
  top: 0;
  z-index: 9999;
}
.skip-link:focus {
  left: 1rem;
  top: 1rem;
  /* ... visible styles */
}
```

### 4. Focus Trap

- [ ] Modal dialogs trap focus inside while open (Tab/Shift+Tab cycle within the modal)
- [ ] Closing the modal returns focus to the trigger element
- [ ] Escape key closes the modal

### 5. ARIA Labels

- [ ] Icon-only buttons have `aria-label` describing the action (not the icon name)
- [ ] Progress bars use `role="progressbar"` with `aria-valuenow`, `aria-valuemin`, `aria-valuemax`
- [ ] Live regions updating async content use `aria-live="polite"` (or `"assertive"` for critical alerts)
- [ ] Decorative SVG icons have `aria-hidden="true"`

```html
<!-- Correct: icon button -->
<button aria-label="Send message">
  <svg aria-hidden="true"><!-- ... --></svg>
</button>

<!-- Correct: progress bar -->
<div
  role="progressbar"
  aria-valuenow="42"
  aria-valuemin="0"
  aria-valuemax="100"
  aria-label="Context window usage"
>
  <div style="width: 42%"></div>
</div>
```

### 6. Tab Role Pattern

When building a tab interface:

- [ ] Tab container: `role="tablist"`
- [ ] Each tab: `role="tab"`, `aria-selected="true|false"`, `aria-controls="panel-id"`
- [ ] Each panel: `role="tabpanel"`, `id` matching `aria-controls`, `aria-labelledby` pointing to its tab
- [ ] Keyboard: Arrow keys move between tabs; Tab moves into the panel; Shift+Tab exits

```html
<div role="tablist" aria-label="Main navigation">
  <button role="tab" aria-selected="true" aria-controls="chat-panel" id="chat-tab">Chat</button>
  <button role="tab" aria-selected="false" aria-controls="settings-panel" id="settings-tab">
    Settings
  </button>
</div>
<div role="tabpanel" id="chat-panel" aria-labelledby="chat-tab"><!-- ... --></div>
<div role="tabpanel" id="settings-panel" aria-labelledby="settings-tab" hidden><!-- ... --></div>
```

### 7. Reduced Motion

- [ ] No animation plays without being suppressible via `prefers-reduced-motion`
- [ ] The global reset in `base.css` covers transitions — test with "Reduce motion" enabled in OS settings
- [ ] Infinite loaders (`shimmer`, spinners) have explicit `animation: none` in reduced-motion context

### 8. Semantic HTML

- [ ] Use native elements (`<button>`, `<a>`, `<input>`) before adding ARIA to `<div>` / `<span>`
- [ ] Headings (`<h1>`–`<h6>`) reflect document hierarchy — do not skip levels
- [ ] Lists of items use `<ul>` / `<ol>` + `<li>`, not chains of `<div>`

---

## Testing Tools

| Tool                                                    | Purpose                             |
| ------------------------------------------------------- | ----------------------------------- |
| Chrome DevTools → Accessibility tab                     | Inspect ARIA tree, contrast         |
| axe DevTools (browser extension)                        | Automated WCAG audit                |
| macOS VoiceOver (`Cmd+F5`)                              | Screen reader smoke test            |
| `prefers-reduced-motion: reduce` (DevTools → Rendering) | Verify animation suppression        |
| Keyboard-only navigation                                | Tab through entire UI without mouse |
