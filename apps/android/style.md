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

The onboarding flow defines the current visual baseline.
New screens should match that language unless there is a strong product reason not to.

Baseline traits:

- Light neutral background with subtle depth.
- Clear blue accent for active/primary states.
- Strong border hierarchy for structure.
- Medium/semibold typography (no thin text).
- Divider-and-spacing layout over heavy card nesting.

## 3. Core Tokens

Use these as shared design tokens for new Compose UI.

- Background gradient: `#FFFFFF`, `#F7F8FA`, `#EFF1F5`
- Surface: `#F6F7FA`
- Border: `#E5E7EC`
- Border strong: `#D6DAE2`
- Text primary: `#17181C`
- Text secondary: `#4D5563`
- Text tertiary: `#8A92A2`
- Accent primary: `#1D5DD8`
- Accent soft: `#ECF3FF`
- Success: `#2F8C5A`
- Warning: `#C8841A`

Rule: do not introduce random per-screen colors when an existing token fits.

## 4. Typography

Primary type family: Manrope (`400/500/600/700`).

Recommended scale:

- Display: `34sp / 40sp`, bold
- Section title: `24sp / 30sp`, semibold
- Headline/action: `16sp / 22sp`, semibold
- Body: `15sp / 22sp`, medium
- Callout/helper: `14sp / 20sp`, medium
- Caption 1: `12sp / 16sp`, medium
- Caption 2: `11sp / 14sp`, medium

Use monospace only for commands, setup codes, endpoint-like values.
Hard rule: avoid ultra-thin weights on light backgrounds.

## 5. Layout And Spacing

- Respect safe drawing insets.
- Keep content hierarchy mostly via spacing + dividers.
- Prefer vertical rhythm from `8/10/12/14/20dp`.
- Use pinned bottom actions for multi-step or high-importance flows.
- Avoid unnecessary container nesting.

## 6. Buttons And Actions

- Primary action: filled accent button, visually dominant.
- Secondary action: lower emphasis (outlined/text/surface button).
- Icon-only buttons must remain legible and >=44dp target.
- Back buttons in action rows use rounded-square shape, not circular by default.

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

- Minimum practical touch target: `44dp`.
- Do not rely on color alone for status.
- Preserve high contrast for all text tiers.
- Add meaningful `contentDescription` for icon-only controls.

## 10. Architecture Rules

- Durable UI state in `MainViewModel`.
- Composables: state in, callbacks out.
- No business/network logic in composables.
- Keep side effects explicit (`LaunchedEffect`, activity result APIs).

## 11. Source Of Truth

- `app/src/main/java/ai/openclaw/app/ui/OpenClawTheme.kt`
- `app/src/main/java/ai/openclaw/app/ui/OnboardingFlow.kt`
- `app/src/main/java/ai/openclaw/app/ui/RootScreen.kt`
- `app/src/main/java/ai/openclaw/app/ui/SettingsScreens.kt`
- `app/src/main/java/ai/openclaw/app/MainViewModel.kt`

If style and implementation diverge, update both in the same change.
