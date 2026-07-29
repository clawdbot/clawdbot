---
summary: "Voice wake and push-to-talk modes plus routing details in the mac app"
read_when:
  - Working on voice wake or PTT pathways
title: "Voice wake (macOS)"
---

# Voice Wake & Push-to-Talk

## Requirements

Voice Wake and push-to-talk require macOS 26 or newer. On older macOS the controls are hidden from the Voice settings page, which shows the macOS 26 requirement instead.

Voice Wake requires Apple Speech to support on-device recognition for the selected language. The app refuses to start passive wake-word listening when that local-only contract is unavailable; it never falls back to network recognition. Push-to-talk, Talk Mode, and Quick Chat dictation are explicit user actions and may use Apple Speech network services for broader language coverage.

## Modes

- **Wake-word mode** (default): an always-on, on-device Speech recognizer waits for trigger tokens (`swabbleTriggerWords`). On match it starts capture, shows the overlay with partial text, and auto-sends after silence.
- **Push-to-talk (hold Right Option)**: hold the right Option key to capture immediately, no trigger needed. The overlay appears while held; releasing finalizes and forwards after a short delay so you can edit the text.

## Runtime behavior (wake-word)

- The recognizer lives in `VoiceWakeRuntime`.
- Trigger fires only when there is a meaningful pause between the wake word and the next word (`triggerPauseWindow` = 0.55s). The overlay/chime can start on the pause even before the command begins.
- Silence windows: 2.0s (`silenceWindow`) when speech is flowing, 5.0s (`triggerOnlySilenceWindow`) if only the trigger was heard.
- Hard stop: 120s (`captureHardStop`) to prevent runaway sessions.
- Debounce between sessions: 350ms (`debounceAfterSend`) after a send.
- The overlay is driven via `VoiceWakeOverlayController`, with committed/volatile text coloring.
- After send, the recognizer restarts cleanly to listen for the next trigger.

## Lifecycle invariants

- If Voice Wake is enabled and permissions are granted, the wake-word recognizer stays listening, except during an active push-to-talk capture.
- Overlay dismissal, including manual dismiss via the X button, always resumes the recognizer: `VoiceSessionCoordinator.overlayDidDismiss` calls `VoiceWakeRuntime.refresh(state:)` on every dismiss path. See [Voice overlay](/platforms/mac/voice-overlay) for the session/token model.

## Push-to-talk specifics

- Hotkey detection uses a global `.flagsChanged` monitor for right Option (`keyCode 61` + `.option`). It only observes events, never swallows them.
- Capture lives in `VoicePushToTalk`: starts Speech immediately, streams partials to the overlay, and calls `VoiceWakeForwarder` on release.
- Starting push-to-talk pauses the wake-word runtime to avoid dueling audio taps; it restarts automatically after release.
- Permissions: requires Microphone + Speech; receiving key events needs Accessibility/Input Monitoring approval.
- External keyboards: some do not expose right Option as expected. Offer a fallback shortcut if users report misses.

## User-facing settings

- **Voice Wake** toggle: enables the wake-word runtime.
- **Hold Right Option to talk**: enables the push-to-talk monitor.
- If the selected language lacks on-device recognition on this Mac, Voice Wake stays disabled while push-to-talk and Talk Mode remain available.
- Language and mic pickers, a live level meter, a trigger-word table, and a tester (local-only, never forwards).
- The mic picker preserves the last selection if a device disconnects, shows a disconnected hint, and temporarily falls back to the system default until it returns.
- **Sounds**: chimes on trigger detect and on send, defaulting to the macOS "Glass" system sound. Pick any `NSSound`-loadable file (e.g. MP3/WAV/AIFF) per event, or choose **No Sound**.

## Forwarding behavior

- On forward, `VoiceWakeForwarder.selectedSessionOptions` picks the active WebChat session key if one is set, otherwise the gateway's main session key.
- It looks up that session via `sessions.list` and derives the delivery channel and target from the session's delivery context (falling back to its last channel/target, then to a parsed session key), defaulting to WebChat if nothing resolves.
- If delivery fails, the error is logged (`voicewake.forward` category) and the run is still visible via WebChat/session logs.

## Forwarding payload

- `VoiceWakeForwarder.prefixedTranscript(_:)` prepends a machine-hint line (resolved host name, falling back to "this Mac") before the transcript, shared between wake-word and push-to-talk paths.

## Quick verification

- Toggle push-to-talk on, hold Right Option, speak, release: overlay should show partials then send.
- While holding, the menu-bar ears should stay enlarged (`triggerVoiceEars(ttl: nil)`); they drop after release.

## Related

- [Voice wake](/nodes/voicewake)
- [Voice overlay](/platforms/mac/voice-overlay)
- [macOS app](/platforms/macos)
