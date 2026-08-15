---
summary: "Menu bar icon states and animations for OpenClaw on macOS"
read_when:
  - Changing menu bar icon behavior
title: "Menu bar icon"
---

# Menu Bar Icon States

Scope: macOS app (`apps/macos`). Rendering: `CritterIconRenderer.makeIcon(...)`. Animation/state wiring: `CritterStatusLabel` + `CritterStatusLabel+Behavior.swift`.

## States

| State                 | Trigger                                   | Visual                                                                                              |
| --------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Idle                  | Default                                   | Normal blink/wiggle animation; open eyes keep a glossy glint                                        |
| Paused                | `isPaused=true`                           | Antennae droop ("off duty") with open eyes; no motion                                               |
| Sleeping              | Gateway disconnected/unconfigured         | Antennae droop and eyes close into `⌣ ⌣` lids; no motion                                            |
| Celebrate             | Message sent (`sendCelebrationTick`)      | Eyes flash happy `∩ ∩` arcs for ~0.9s plus a leg kick                                               |
| Voice wake (big ears) | Wake word heard                           | Antennae perk up straight and taller (`earScale=1.9`); drops after silence                          |
| Working               | `isWorking=true` or an active `IconState` | Faster leg wiggle (`legWiggle` up to `1.0`) plus a small horizontal offset; additive to idle wiggle |

A tool-activity badge (SF Symbol puck, e.g. `chevron.left.slash.chevron.right` for exec) can render on top of the same critter icon when a session has an active job or tool. That badge comes from `IconState`/`ActivityKind`; see [Menu bar](/platforms/mac/menu-bar) for the full state model.

## Voice wake ears

- Trigger: `AppStateStore.shared.triggerVoiceEars(ttl: nil)`, called from the voice-wake capture pipeline (`VoiceWakeRuntime`) and from voice-wake debug/test tooling (`VoiceWakeTester`, `VoiceWakeOverlayController`).
- Stop: `stopVoiceEars()`, called when capture finalizes.
- Silence window before finalizing: `2.0s` normally, `5.0s` if only the trigger word was heard and no further speech followed (`VoiceWakeRuntime.silenceWindow` / `triggerOnlySilenceWindow`).
- While boosted, idle blink/wiggle/leg/ear timers are suspended (`earBoostActive` gates the animation task in `CritterStatusLabel+Behavior`).

## Shapes and sizes

- Canvas: 18x18pt template image, rendered into a 36x36px bitmap backing store (2x) so the icon stays crisp on Retina.
- Ear scale defaults to `1.0`; voice boost sets `earScale=1.9` without changing the overall frame.
- `antennaDroop` (0-1) folds the antennae down for the paused and sleeping poses.
- Leg scurry uses `legWiggle` up to `1.0` with a small horizontal jiggle.

## Behavioral notes

- No external CLI/broker toggle for ears or working state; both are driven internally by app signals (`AppState.setWorking`, `AppState.triggerVoiceEars`) to avoid accidental flapping.
- Keep any new TTL short (well under 10s) so the icon returns to baseline quickly if a job hangs.

## Related

- [Menu bar](/platforms/mac/menu-bar)
- [macOS app](/platforms/macos)
