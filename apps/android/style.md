# OpenClaw Android UI Style Guide

Scope: all native Android UI in `apps/android` (Jetpack Compose).
Goal: one coherent visual system across onboarding, settings, and future screens.

## 1. Design Direction

- Clean, quiet surfaces.
- Strong readability first.
- One clear primary action per screen state.
- Progressive disclosure for advanced controls.
- Deterministic flows: validate early, fail clearly.

## 2. Style Baseline

The Android app shares the Control UI theme families, color modes, and accent colors,
but keeps native geometry: compact spacing, phone-sized touch targets, and the
existing sidebar shell. Do not copy the Control UI web layout.

Baseline traits for the Claw family:

- Dark canvas with a slight blue cast; panels barely lighter than the canvas.
- Red accent for the current page, the selected state, and the primary action.
- Hairline borders and layered surfaces for structure; near-zero shadow.
- Medium/semibold typography (no thin text).
- Divider-and-spacing layout over card nesting.

## 3. Core Tokens

These are the Claw family's shared Control UI tokens. Other families and custom
accents use the same semantic roles; components must not hardcode Claw colors.

New local settings start in Dark mode. Gateway appearance settings can select Light
or System mode; System follows the device. Keep geometry consistent across modes
and families.

Dark:

- Canvas: `#0E1015`
- Card surface: `#161920`
- Elevated surface: `#191C24`
- Pressed/hover surface: `#1F2330`
- Border: `#1E2028`
- Border strong: `#2E3040`
- Text strong: `#F4F4F5`
- Text body: `#BCBCC0`
- Text muted: `#8B8B94`
- Accent: `#FF5C5C`
- Accent soft: accent at about 10 percent opacity
- Primary button: `#D13C3C`
- Secondary accent: `#14B8A6`
- Success `#22C55E`, warning `#F59E0B`, danger `#F87171`

Light:

- Canvas `#F7F7F9`, surface `#FFFFFF`, pressed `#EFEFF3`
- Border `#E4E4EA`, border strong `#CFCFD8`
- Text `#101014` / `#52525B` / `#787885`
- Accent and primary button `#C23434`, secondary accent `#0F8F81`
- Success `#15803D`, warning `#B45309`, danger `#B91C1C`

Rules:

- Do not introduce per-screen colors when a theme token fits.
- Soft status and accent fills are alpha-based so one token composites over canvas,
  card, and row surfaces.
- Do not rely on the Material default color roles. `ClawTheme.kt` maps every token
  into `MaterialTheme`, including the container roles Material uses for selection.

## 4. Typography

Primary type family: Manrope (`400/500/600/700`).

Scale (`ClawTheme.type`):

- `display`: `22sp / 28sp`, bold — the page name, once per screen
- `title`: `17sp / 22sp`, semibold — panel and sheet titles
- `section`: `14sp / 18sp`, semibold — group headings and row titles
- `body`: `14sp / 19sp`, medium
- `label`: `14sp / 18sp`, semibold — buttons and chips
- `caption`: `12sp / 16sp`, medium — secondary and helper copy
- `captionSmall`: `11sp / 14sp`, medium, `0.4sp` tracking — eyebrows and status text
- `mono`: `13sp / 18sp` — commands, setup codes, endpoint-like values

Use the shared scale for screen typography. The compact chat composer is a deliberate
exception: its input uses `16sp / 22sp` for readable editing without expanding the
toolbar. Add other recurring sizes to the scale instead of overriding each screen.
Hard rule: avoid ultra-thin weights on light backgrounds.

## 5. Layout And Spacing

- Respect safe drawing insets.
- Keep content hierarchy mostly via spacing + dividers.
- Spacing scale (`ClawTheme.spacing`), all multiples of 4:
  `xxxs 4`, `xxs 8`, `xs 12`, `sm 16`, `md 20`, `lg 24`, `xl 32`, `xxl 40`.
- Page gutter on phones is `sm` (16dp) horizontally and `xxs` (8dp) vertically. Use a
  wider gutter only when a screen has a stronger local constraint.
- Touch target and visible shape are separate sizes. Every control keeps a `touchTarget`
  (48dp) hit area and ripple; what it paints inside is smaller: `control` 36dp for
  capsules and segments, `iconSlot` 32dp for a bordered icon circle, `icon` 18dp for a
  bare glyph. Never grow the painted shape to reach the target.
- `row` (48dp) is the minimum height for a full-width list or detail row.
- Radius scale (`ClawTheme.radii`): `row 6`, `control 10`, `button 10`, `panel 12`,
  `sheet 16`, `pill 18`. `pill` is full-round for a `control`-height capsule only;
  taller surfaces use `panel`.
- Panels are a flat surface plus a 1dp border. Do not add tonal or shadow elevation,
  and do not nest a panel inside a panel.
- One emphasis zone per screen. Prefer a divider or whitespace over another card.
- Prefer one bordered list over a grid of cards for status and reference data.

## 6. Buttons And Actions

- Primary action: filled accent button, visually dominant.
- Secondary action: lower emphasis (outlined/text/surface button).
- Icon-only buttons must remain legible and keep a 48dp target. `ClawIconButton` paints
  a 32dp bordered circle inside it; `ClawPlainIconButton` paints only the 18dp glyph.
- `ClawDesignTheme` holds Material's own minimum interactive size at 48dp so Material
  controls and Claw controls agree on one floor.
- Back buttons in action rows use the shared icon-button primitives and retain the
  same 48dp target.

## 7. Inputs And Forms

- Always show explicit label or clear context title.
- Keep helper copy short and actionable.
- Validate before advancing steps.
- Prefer immediate inline errors over hidden failure states.
- Keep optional advanced fields explicit (`Manual`, `Advanced`, etc.).

## 8. Progress And Multi-Step Flows

- Use clear step count (`Step X of N`).
- Use labeled progress rail/indicator when steps are discrete.
- Keep navigation predictable: back/next behavior should never surprise.

## 9. Accessibility

- Minimum practical touch target: `48dp`, even where the painted shape is smaller.
- Do not rely on color alone for status.
- Preserve high contrast for all text tiers.
- Add meaningful `contentDescription` for icon-only controls.

## 10. Architecture Rules

- Durable UI state in `MainViewModel`.
- Composables: state in, callbacks out.
- No business/network logic in composables.
- Keep side effects explicit (`LaunchedEffect`, activity result APIs).

## 11. Source Of Truth

Tokens and shared components:

- `app/src/main/java/ai/openclaw/app/ui/design/ClawTheme.kt` (palette, spacing, radii,
  type, and the Material color-scheme bridge)
- `app/src/main/java/ai/openclaw/app/ui/design/ClawSurfaces.kt`
- `app/src/main/java/ai/openclaw/app/ui/design/ClawComponents.kt`
- `app/src/main/java/ai/openclaw/app/ui/design/ClawNavigation.kt`

Shell and screens:

- `app/src/main/java/ai/openclaw/app/ui/SidebarShell.kt`
- `app/src/main/java/ai/openclaw/app/ui/SidebarContent.kt`
- `app/src/main/java/ai/openclaw/app/ui/ShellScreen.kt`
- `app/src/main/java/ai/openclaw/app/ui/SettingsScreens.kt`
- `app/src/main/java/ai/openclaw/app/ui/OnboardingFlow.kt`
- `app/src/main/java/ai/openclaw/app/MainViewModel.kt`

If style and implementation diverge, update both in the same change.
