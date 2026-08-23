# Settings Design Language

Every settings surface (the `/settings` takeover pages plus the Plugins/Skills hubs) uses one structural pattern. Styles live in `ui/src/styles/settings.css`; templates are built through the helpers in `ui/src/components/settings-ui.ts`.

## Anatomy

```
.settings-page                     ← single column, 760px (or --wide: 1120px)
  .settings-section                ← repeated per topic
    .settings-section__heading     ← plain uppercase text label, outside any surface
    .settings-group                ← the ONLY surface (card bg, border, radius-lg)
      .settings-row                ← title/description left, one control right
      .settings-row                ← hairline divider between rows
```

- **Sections are typography, not chrome.** Grouping comes from whitespace + a small uppercase heading — never a card header.
- **Exactly one level of elevation.** A group never contains another card, callout, or bordered box. Nested detail uses `.settings-subrows` (indented rows), a stacked row, or a drill-in nav row.
- **Row anatomy:** left is title (`--control-ui-text-md`, weight 500) over an optional one-line description (muted, sm). Right is exactly one control: toggle, select, segmented, button, plain value, or chevron (nav). Wide editors use the `stacked` variant.
- **Lists are rows too.** An entity list (plugin, device, session) is a group whose rows carry an action cluster in the control slot — same anatomy as a toggle row.

## Rules

- **No status pills.** Status is `renderSettingsStatus` — a dot + plain text (`● Connected`). Badges (`.settings-count`) exist only for genuine counts.
- **Spacing uses `--space-*` tokens** (`base.css`); no hardcoded paddings/gaps.
- **Motion budget:** color/background transitions only. No enter animations, staggered reveals, or hover glows.
- **Buttons:** default `.btn` (quiet). `--accent` primary at most once per view. Danger actions live in a `danger: true` section at the page bottom.
- **One control set.** Use `renderSettingsToggleRow` (preferred: label-wrapped, whole row clickable, accessible name for free) or `renderSettingsToggle` with a required `ariaLabel`, `renderSettingsSegmented`, `.settings-select`, `.settings-input`. Do not add another toggle or badge variant.
- **Every control needs an accessible name.** Row titles are plain text, not `<label>`s — selects/inputs in a control slot must carry `aria-label` (usually the row title string).
- **No new page CSS files for settings surfaces.** Page-specific styles belong in `settings.css` only when a primitive is genuinely missing — extend the system, don't fork it.

## Helpers

```ts
import {
  renderSettingsPage,
  renderSettingsSection,
  renderSettingsRow,
  renderSettingsNavRow,
  renderSettingsToggleRow,
  renderSettingsSegmented,
  renderSettingsStatus,
  renderSettingsValue,
  renderSettingsEmpty,
} from "../../components/settings-ui.ts";

renderSettingsPage([
  renderSettingsSection({ title: t("settings.notifications") }, [
    renderSettingsToggleRow({
      title: t("settings.systemNotifications"),
      description: t("settings.systemNotificationsDesc"),
      checked,
      onChange,
    }),
  ]),
]);
```

Custom content inside a group (tables, meters) is allowed as an escape hatch — keep it inside one `.settings-group` and match row paddings (`--space-3 --space-4`).
