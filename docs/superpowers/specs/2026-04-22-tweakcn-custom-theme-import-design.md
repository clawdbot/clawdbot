# Tweakcn Custom Theme Import Design

Status: approved in terminal on 2026-04-22

## Summary

Add exactly one browser-local custom Control UI theme slot that can be imported from a tweakcn share link. The existing built-in theme families remain `claw`, `knot`, and `dash`. The new `custom` family behaves like a normal OpenClaw theme family and supports `light`, `dark`, and `system` mode when the imported tweakcn payload includes both light and dark token sets.

The imported theme is stored only in the current browser profile with the rest of the Control UI settings. It is not written to gateway config and does not sync across devices or browsers.

## Problem

The Control UI theme system is currently closed over three hard-coded theme families:

- `ui/src/ui/theme.ts`
- `ui/src/ui/views/config.ts`
- `ui/src/styles/base.css`

Users can switch among built-in families and mode variants, but they cannot bring in a theme from tweakcn without editing repo CSS. The requested outcome is smaller than a general theming system: keep the three built-ins and add one user-controlled imported slot that can be replaced from a tweakcn link.

## Goals

- Keep the existing built-in theme families unchanged.
- Add exactly one imported custom slot, not a theme library.
- Accept a tweakcn share link or a direct `https://tweakcn.com/r/themes/{id}` URL.
- Persist the imported theme in browser local storage only.
- Make the imported slot work with existing `light`, `dark`, and `system` mode controls.
- Keep failure behavior safe: a bad import never breaks the active UI theme.

## Non goals

- No multi-theme library or browser-local list of imports.
- No gateway-side persistence or cross-device sync.
- No arbitrary CSS editor or raw theme JSON editor.
- No automatic loading of remote font assets from tweakcn.
- No attempt to support tweakcn payloads that only expose one mode.
- No repo-wide theming refactor beyond the seams required for the Control UI.

## User decisions already made

- Keep the three built-in themes.
- Add one tweakcn-powered import slot.
- Store the imported theme in the browser, not gateway config.
- Support `light`, `dark`, and `system` for the imported slot.
- Overwriting the custom slot with the next import is the intended behavior.

## Recommended approach

Add a fourth theme family id, `custom`, to the Control UI theme model. The `custom` family becomes selectable only when a valid tweakcn import is present. The imported payload is normalized into an OpenClaw-specific custom theme record and stored in browser local storage with the rest of the UI settings.

At runtime, OpenClaw renders a managed `<style>` tag that defines the resolved custom CSS variable blocks:

```css
:root[data-theme="custom"] { ... }
:root[data-theme="custom-light"] { ... }
```

This keeps custom theme variables scoped to the `custom` family and avoids leaking inline CSS variables into the built-in families.

## Architecture

### Theme model

Update `ui/src/ui/theme.ts`:

- Extend `ThemeName` to include `custom`.
- Extend `ResolvedTheme` to include `custom` and `custom-light`.
- Extend `VALID_THEME_NAMES`.
- Update `resolveTheme()` so `custom` mirrors the existing family behavior:
  - `custom + dark` -> `custom`
  - `custom + light` -> `custom-light`
  - `custom + system` -> `custom` or `custom-light` based on OS preference

No legacy aliases are added for `custom`.

### Persistence model

Extend `UiSettings` persistence in `ui/src/ui/storage.ts` with one optional custom-theme payload:

- `customTheme?: ImportedCustomTheme`

Recommended stored shape:

```ts
type ImportedCustomTheme = {
  sourceUrl: string;
  themeId: string;
  label: string;
  importedAt: string;
  light: Record<string, string>;
  dark: Record<string, string>;
};
```

Notes:

- `sourceUrl` stores the original user input after normalization.
- `themeId` is the tweakcn theme id extracted from the URL.
- `label` is the tweakcn `name` field when present, else `Custom`.
- `light` and `dark` are already normalized OpenClaw token maps, not raw tweakcn payloads.
- The imported payload lives beside other browser-local settings and is serialized in the same local-storage document.
- If stored custom-theme data is missing or invalid on load, ignore the payload and fall back to `theme: "claw"` when the persisted family was `custom`.

### Runtime application

Add a narrow custom-theme stylesheet manager in the Control UI runtime, owned near `ui/src/ui/app-settings.ts` and `ui/src/ui/theme.ts`.

Responsibilities:

- Create or update one stable `<style id="openclaw-custom-theme">` tag in `document.head`.
- Emit CSS only when a valid custom theme payload exists.
- Remove the style tag content when the payload is cleared.
- Keep built-in family CSS in `ui/src/styles/base.css`; do not splice imported tokens into the checked-in stylesheet.

This manager runs whenever settings are loaded, saved, imported, or cleared.

### Light-mode selectors

Implementation should prefer `data-theme-mode="light"` for cross-family light styling rather than special-casing `custom-light`. If an existing selector is pinned to `data-theme="light"` and needs to apply to every light family, broaden it as part of this work.

## Import UX

Update `ui/src/ui/views/config.ts` in the `Appearance` section:

- Add a `Custom` theme card beside `Claw`, `Knot`, and `Dash`.
- Show the card as disabled when no imported custom theme exists.
- Add an import panel under the theme grid with:
  - one text input for a tweakcn share link or `/r/themes/{id}` URL
  - one `Import` button
  - one `Replace` path when a custom payload already exists
  - one `Clear` action when a custom payload already exists
- Show the imported theme label and source host when a payload exists.
- If the active theme is `custom`, importing a replacement applies immediately.
- If the active theme is not `custom`, importing only stores the new payload until the user selects the `Custom` card.

The quick settings theme picker in `ui/src/ui/views/config-quick.ts` should also show `Custom` only when a payload exists.

## URL parsing and remote fetch

The browser import path accepts:

- `https://tweakcn.com/themes/{id}`
- `https://tweakcn.com/r/themes/{id}`

Implementation should normalize both forms to:

- `https://tweakcn.com/r/themes/{id}`

The browser then fetches the normalized `/r/themes/{id}` endpoint directly.

Use a narrow schema validator for the external payload. A zod schema is preferred because this is an untrusted external boundary.

Required remote fields:

- top-level `name` as optional string
- `cssVars.theme` as optional object
- `cssVars.light` as object
- `cssVars.dark` as object

If either `cssVars.light` or `cssVars.dark` is missing, reject the import. This is deliberate: the approved product behavior is full mode support, not best-effort synthesis of a missing side.

## Token mapping

Do not mirror tweakcn variables blindly. Normalize a bounded subset into OpenClaw tokens and derive the rest in a helper.

### Tokens imported directly

From each tweakcn mode block:

- `background`
- `foreground`
- `card`
- `card-foreground`
- `popover`
- `popover-foreground`
- `primary`
- `primary-foreground`
- `secondary`
- `secondary-foreground`
- `muted`
- `muted-foreground`
- `accent`
- `accent-foreground`
- `destructive`
- `destructive-foreground`
- `border`
- `input`
- `ring`
- `radius`

From shared `cssVars.theme` when present:

- `font-sans`
- `font-mono`

If a mode block overrides `font-sans`, `font-mono`, or `radius`, the mode-local value wins.

### Tokens derived for OpenClaw

The importer derives OpenClaw-only variables from the imported base colors:

- `--bg-accent`
- `--bg-elevated`
- `--bg-hover`
- `--panel`
- `--panel-strong`
- `--panel-hover`
- `--chrome`
- `--chrome-strong`
- `--text`
- `--text-strong`
- `--chat-text`
- `--muted`
- `--muted-strong`
- `--accent-hover`
- `--accent-muted`
- `--accent-subtle`
- `--accent-glow`
- `--focus`
- `--focus-ring`
- `--focus-glow`
- `--secondary`
- `--secondary-foreground`
- `--danger`
- `--danger-muted`
- `--danger-subtle`

Derivation rules live in a pure helper so they can be tested independently. Exact color-mixing formulas are an implementation detail, but the helper must satisfy two constraints:

- preserve readable contrast close to the imported theme intent
- produce stable output for the same imported payload

### Tokens ignored in v1

These tweakcn tokens are intentionally ignored in the first version:

- `chart-*`
- `sidebar-*`
- `font-serif`
- `shadow-*`
- `tracking-*`
- `letter-spacing`
- `spacing`

This keeps the scope on the tokens the current Control UI actually needs.

### Fonts

Font stack strings are imported if present, but OpenClaw does not load remote font assets in v1. If the imported stack references fonts that are unavailable in the browser, normal fallback behavior applies.

## Failure behavior

Bad imports must fail closed.

- Invalid URL format: show inline validation error, do not fetch.
- Unsupported host or path shape: show inline validation error, do not fetch.
- Network failure, non-OK response, or malformed JSON: show inline error, keep current stored payload untouched.
- Schema failure or missing light/dark blocks: show inline error, keep current stored payload untouched.
- Clear action:
  - removes the stored custom payload
  - removes the managed custom style tag content
  - if `custom` is active, switches theme family back to `claw`
- Invalid stored custom payload on first load:
  - ignore the stored payload
  - do not emit custom CSS
  - if persisted theme family was `custom`, fall back to `claw`

At no point should a failed import leave the active document with partial custom CSS variables applied.

## Files expected to change in implementation

Primary files:

- `ui/src/ui/theme.ts`
- `ui/src/ui/storage.ts`
- `ui/src/ui/app-settings.ts`
- `ui/src/ui/views/config.ts`
- `ui/src/ui/views/config-quick.ts`
- `ui/src/styles/base.css`

Likely new helpers:

- `ui/src/ui/custom-theme.ts`

Tests:

- `ui/src/ui/app-settings.test.ts`
- `ui/src/ui/storage.node.test.ts`
- `ui/src/ui/views/config.browser.test.ts`
- new focused tests for URL parsing and payload normalization

## Testing

Minimum implementation coverage:

- parse share-link URL into tweakcn theme id
- normalize `/themes/{id}` and `/r/themes/{id}` into the fetch URL
- reject unsupported hosts and malformed ids
- validate tweakcn payload shape
- map a valid tweakcn payload into normalized OpenClaw light and dark token maps
- load and save the custom payload in browser-local settings
- resolve `custom` for `light`, `dark`, and `system`
- disable `Custom` selection when no payload exists
- apply imported theme immediately when `custom` is already active
- fall back to `claw` when the active custom theme is cleared

Manual verification target:

- import a known tweakcn theme from Settings
- switch among `light`, `dark`, and `system`
- switch between `custom` and the built-in families
- reload the page and confirm the imported custom theme persists locally

## Rollout notes

This feature is intentionally small. If users later ask for multiple imported themes, rename, export, or cross-device sync, treat that as a follow-on design. Do not pre-build a theme library abstraction in this implementation.
