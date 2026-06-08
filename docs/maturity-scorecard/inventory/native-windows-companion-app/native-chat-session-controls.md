---
title: "Native Windows companion app - Chat Sessions Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Native Windows companion app - Chat Sessions Maturity Note

## Summary

Windows users have supported browser Control UI/WebChat and CLI chat paths, but
current main does not ship a native Windows companion chat client. Searches for
Windows companion WebChat did not find relevant archive evidence. This component
is effectively unimplemented for the selected surface.

## Category Scope

Included in this category:

- Native Windows chat window: Native Windows chat window, transcript, composer, session picker, model/thinking controls, abort/follow-up actions, reconnect handling, and tool rendering
- Gateway chat transport: Gateway chat transport and session control from the native Windows app.

## Features

- Native Windows chat window: Native Windows chat window, transcript, composer, session picker, model/thinking controls, abort/follow-up actions, reconnect handling, and tool rendering
- Gateway chat transport: Gateway chat transport and session control from the native Windows app.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Experimental (0%)`
- Positive signals: reusable Gateway chat and browser WebChat surfaces exist outside this component.
- Negative signals: no native Windows chat window, transport, session UI, app state, or app-specific chat validation exists.
- Integration gaps: no Windows app chat lifecycle can be launched, sent through, reconnected, or validated.

Coverage labels:

- `Lovable`: 95-100
- `Stable`: 80-95
- `Beta`: 70-80
- `Alpha`: 50-70
- `Experimental`: 0-50

At shared boundaries, choose the higher maturity label.

Coverage measures integration, e2e, live, or real runtime-flow evidence across
the component. Unit tests can provide supporting context but never make a feature covered by
themselves.

## Quality Score

- Score: `Experimental (25%)`
- Gitcrawl reports: feature-specific `Windows companion chat WebChat` query returned no hits.
- Discrawl reports: feature-specific `Windows companion chat WebChat` query returned no messages.
- Good qualities: current docs do not claim a native Windows chat app exists; users are directed to supported Gateway and dashboard paths.
- Bad qualities: there is no app UX contract, implementation, session continuity design, or native rendering behavior for Windows.
- Excluded from quality: unit, integration, e2e, live, and runtime-flow proof were not used to raise or lower Quality.

Quality labels:

- `Lovable`: 95-100
- `Stable`: 80-95
- `Beta`: 70-80
- `Alpha`: 50-70
- `Experimental`: 0-50

At shared boundaries, choose the higher maturity label.

Quality must not use unit, integration, e2e, live, or real runtime test coverage
as a scoring input.

## Completeness Score

- Score: `Experimental (0%)`
- Surface instructions: evaluated against `references/completeness/native-windows-companion-app.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Native Windows chat window, Gateway chat transport.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- No native Windows chat client source or docs.
- No session picker, model controls, or native transcript rendering contract.
- No app-specific offline/reconnect or Gateway restart behavior.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/platforms/windows.md` directs users to Gateway runbook and Control UI paths, not a native app chat UI.
- `/Users/kevinlin/code/openclaw/docs/web/webchat.md` and `/Users/kevinlin/code/openclaw/docs/web/control-ui.md` cover browser surfaces, not Windows native app support.

### Source

- `/Users/kevinlin/code/openclaw/src/gateway/server-chat.ts` and `/Users/kevinlin/code/openclaw/src/gateway/server-methods/chat.ts` provide Gateway chat primitives.
- `/Users/kevinlin/code/openclaw/apps/shared/OpenClawKit/Sources/OpenClawChatUI/` provides Swift shared chat UI for Apple app surfaces.
- No Windows app chat source was found.

### Integration tests

- Gateway chat tests exist, but no native Windows app chat integration tests were found.

### Unit tests

- `/Users/kevinlin/code/openclaw/src/gateway/server.chat.gateway-server-chat.test.ts`
- `/Users/kevinlin/code/openclaw/apps/shared/OpenClawKit/Tests/OpenClawKitTests/ChatViewModelTests.swift`
- No Windows native chat unit tests were found.

### Gitcrawl queries

Query:

- `gitcrawl search openclaw/openclaw --query "Windows companion chat WebChat" --json`

Results:

- No hits.

### Discrawl queries

Query:

- `/Users/kevinlin/.local/bin/discrawl search --limit 6 "Windows companion chat WebChat"`

Results:

- No messages.
