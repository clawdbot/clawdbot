---
title: "Linux companion app - Voice, Media, and Always-on Desktop Sensing Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Linux companion app - Voice, Media, and Always-on Desktop Sensing Maturity Note

## Summary

OpenClaw supports native Talk and media capture on macOS/iOS/Android and browser Talk through the Gateway, but Linux has no supported native companion app for microphone, screen, camera, voice wake, or always-on desktop sensing. Archive support threads explicitly route Linux users to watcher scripts or other bridges for these flows.

## Category Scope

- Linux native Talk, push-to-talk, voice wake, and transcription.
- Microphone capture, screen/camera capture, desktop context sensing, and local media attachment flows.
- Native media permissions and foreground/background behavior.
- Adjacent out-of-scope surfaces: browser Talk, Android/iOS/macOS native Talk, Linux Gateway text/chat path.

## Features

- Linux native Talk: Linux native Talk, push-to-talk, voice wake, and transcription
- Microphone capture: Microphone capture, screen/camera capture, desktop context sensing, and local media attachment flows
- Native media permissions: Native media permissions and foreground/background behavior

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Experimental (0%)`
- Positive signals: Talk and media contracts exist on other native app platforms and browser surfaces.
- Negative signals: no Linux native app media capture, voice, wake, screen, camera, or always-on sensing source exists in current checkout.
- Integration gaps: no Linux native app voice/media/sensing proof exists.

## Quality Score

- Score: `Experimental (20%)`
- Gitcrawl reports: Linux voice/mic/screen companion queries returned no direct hits.
- Discrawl reports: support guidance for Linux desktop assistant use says no native OpenClaw companion app exists for full always-on desktop sensing and recommends watcher scripts for mic/screen capture.
- Good qualities: docs avoid promising Linux native voice/media behavior and existing app docs make the supported platforms explicit.
- Bad qualities: there is no Linux permission model, media capture contract, foreground/background policy, wake loop design, or native settings UX.
- Excluded from quality: unit, integration, e2e, live, and real runtime-flow test evidence is excluded from this Quality score.

## Completeness Score

- Score: `Experimental (0%)`
- Surface instructions: evaluated against `references/completeness/linux-companion-app.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Linux native Talk, Microphone capture, Native media permissions.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Define whether Linux native media capture is in scope for the first app release.
- Decide desktop-environment APIs for screen/mic/camera access and voice wake.
- Document fallback patterns for users who need always-on Linux sensing before a native app exists.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/nodes/talk.md:9`: native Talk currently names macOS/iOS/Android, plus browser Talk.
- `/Users/kevinlin/code/openclaw/docs/nodes/talk.md:126`: macOS and Android UI behavior is documented; no Linux native Talk UI is documented.
- `/Users/kevinlin/code/openclaw/docs/nodes/camera.md:9`: camera capture is supported for iOS, Android, and macOS app nodes.
- `/Users/kevinlin/code/openclaw/docs/platforms/linux.md:13`: Linux companion apps are planned.

### Source

- No Linux native Talk, media capture, microphone, screen capture, or camera source exists under `apps/`.
- `/Users/kevinlin/code/openclaw/apps/macos/Sources/OpenClaw/TalkModeRuntime.swift`, `/Users/kevinlin/code/openclaw/apps/ios/Sources/Voice`, and `/Users/kevinlin/code/openclaw/apps/android/app/src/main/java/ai/openclaw/app/voice` are adjacent supported native voice implementations, not Linux.

### Integration tests

- No Linux native voice/media/sensing integration test was found.
- Existing Android voice E2E and Apple/mobile native voice tests are adjacent, not Linux app proof.

### Unit tests

- No Linux native voice/media unit tests were found.
- Existing Talk/media tests target macOS, iOS, Android, shared OpenClawKit, and Gateway/browser code.

### Gitcrawl queries

Query:

- `gitcrawl search openclaw/openclaw --query "Linux companion voice wake microphone screen capture" --mode keyword --limit 8 --json`
- `gitcrawl search openclaw/openclaw --query "Linux no native companion app mic screen watcher scripts" --mode keyword --limit 8 --json`

Results:

- Both feature-specific gitcrawl queries returned no hits.
- Absence of gitcrawl hits is neutral after freshness checks, but it provides no positive signal for supported Linux native voice/media behavior.

### Discrawl queries

Query:

- `DISCRAWL_NO_AUTO_UPDATE=1 /Users/kevinlin/.local/bin/discrawl search --mode hybrid --limit 6 "Linux companion voice wake microphone screen capture"`
- `DISCRAWL_NO_AUTO_UPDATE=1 /Users/kevinlin/.local/bin/discrawl search --mode hybrid --limit 6 "Linux no native companion app mic screen watcher scripts"`

Results:

- The voice/wake/mic/screen query returned no direct results.
- The watcher-scripts query returned an April 10 support thread for Arch/Hyprland explaining that because Linux has no native OpenClaw companion app yet, the user should use local watcher scripts for screen and mic capture and bridge through OpenClaw/Discord.
