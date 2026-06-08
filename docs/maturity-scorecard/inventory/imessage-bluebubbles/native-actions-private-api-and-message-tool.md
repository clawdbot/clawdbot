---
title: "iMessage / BlueBubbles - Native Actions, Private Api, and Message Tool Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# iMessage / BlueBubbles - Native Actions, Private Api, and Message Tool Maturity Note

## Summary

Native actions, private API, and message-tool behavior are Beta. The action
surface is broad and explicitly gated: react, edit, unsend, reply, effects,
read/typing indicators, rich sends, and group management depend on the `imsg`
private API bridge and capability probes. The component is not Stable because
private API state is fragile, action support varies by `imsg`/macOS version, and
archive evidence shows active work around rich sends and action formatting.

## Category Scope

This note covers private API probing, action availability, action config gates,
tapback mapping, edit/unsend/reply/effects/group management, `send-rich --file`,
message-tool visibility/target grammar, and action dispatch errors.

## Features

- Native Actions: Covers Native Actions across private API probing, action availability, action config gates, tapback mapping, edit/unsend/reply/effects/group management, `send-rich --file`, message-tool visibility/target grammar, and action dispatch errors.
- Private API: Covers Private API across private API probing, action availability, action config gates, tapback mapping, edit/unsend/reply/effects/group management, `send-rich --file`, message-tool visibility/target grammar, and action dispatch errors.
- Message Tool: Covers Message Tool across private API probing, action availability, action config gates, tapback mapping, edit/unsend/reply/effects/group management, `send-rich --file`, message-tool visibility/target grammar, and action dispatch errors.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (73%)`
- Positive signals:
  - Docs list action capabilities and private API requirements.
  - Source gates actions by config and probe state, lazily reprobes unknown
    bridge state, resolves short ids and chat targets, and checks
    `send-rich --file` support.
  - Tests cover action advertisement, configured-off gates, tapback mapping,
    chat target resolution, db-path propagation, and rich reply attachments.
  - Message-tool tests cover iMessage target grammar and channel-scoped
    descriptions.
- Negative signals:
  - No live action lane was found for real Messages.app react/edit/unsend/reply
    and group-management operations.
  - Private API capability depends on `imsg launch`, SIP settings, macOS
    version, and the installed `imsg` build.
  - Archive issues show ongoing action/media/rich-send refinements.
- Integration gaps:
  - Add a gated Mac lane that performs one successful private API action of each
    class and one expected unavailable-gate result.
  - Add fake-imsg integration around `imsg status --json` selectors/rpc methods
    and message-tool action visibility.

## Quality Score

- Score: `Beta (71%)`
- Gitcrawl reports:
  - `iMessage private API` returned #84329 for configurable IMCore/private API
    transport preference, #79610 for stderr noise on the private API path, and
    adjacent beta release notes mentioning iMessage reaction/private API
    diagnostics.
  - `iMessage send-rich` returned #84329, #87597, and #85954.
  - `iMessage private API react edit unsend reply sendWithEffect group management`
    returned no direct hits in the latest pass.
- Discrawl reports:
  - `iMessage private API` returned beta release notes mentioning iMessage
    reaction/private API diagnostics.
  - `iMessage send-rich` returned maintainer snippets about iMessage reply
    attachments through `send-rich --file`.
- Good qualities:
  - Action availability is not hard-coded; it uses probe status and capability
    checks.
  - Unknown bridge status keeps actions visible but probes lazily on first use,
    avoiding stale false-negative UX.
  - Config gates are enforced at advertisement and execution time.
  - Rich reply attachments fail loudly when the installed `imsg` build lacks
    `send-rich --file`.
- Bad qualities:
  - The private API bridge is an inherently fragile external dependency.
  - Cached bridge status can drift after Messages restarts until reprobed.
  - The action surface is broad enough that every macOS/imsg version mismatch
    can create a user-visible edge case.
- Excluded from quality:
  - Unit, integration, e2e, live, and runtime-flow test evidence is recorded
    under Coverage only.

## Completeness Score

- Score: `Beta (73%)`
- Surface instructions: evaluated against `references/completeness/imessage-bluebubbles.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Native Actions, Private API, Message Tool.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Live advanced-action proof is missing.
- `imsg` capability drift and private API availability remain operator-facing.
- Rich media/actions have recent field churn.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/channels/imessage.md:499`: private API availability exposes iMessage-native actions through the message tool.
- `/Users/kevinlin/code/openclaw/docs/channels/imessage.md:525`: react action maps to supported tapbacks.
- `/Users/kevinlin/code/openclaw/docs/channels/imessage.md:528`: edit action is available on supported macOS/private API versions.
- `/Users/kevinlin/code/openclaw/docs/channels/imessage.md:529`: unsend action is available on supported macOS/private API versions.
- `/Users/kevinlin/code/openclaw/docs/channels/imessage.md:541`: unknown status leaves actions visible and probes lazily at dispatch.
- `/Users/kevinlin/code/openclaw/docs/channels/imessage.md:546`: read receipts and typing bubbles depend on the bridge.
- `/Users/kevinlin/code/openclaw/docs/channels/imessage-from-bluebubbles.md:218`: migration checklist tells operators to test react, edit, unsend, reply, media, and group actions.

### Source

- `/Users/kevinlin/code/openclaw/extensions/imessage/src/shared.ts:84`: plugin base declares media capability.
- `/Users/kevinlin/code/openclaw/extensions/imessage/src/shared.ts:85`: plugin base declares reactions capability.
- `/Users/kevinlin/code/openclaw/extensions/imessage/src/shared.ts:86`: plugin base declares edit capability.
- `/Users/kevinlin/code/openclaw/extensions/imessage/src/shared.ts:87`: plugin base declares unsend capability.
- `/Users/kevinlin/code/openclaw/extensions/imessage/src/shared.ts:88`: plugin base declares reply capability.
- `/Users/kevinlin/code/openclaw/extensions/imessage/src/shared.ts:89`: plugin base declares effects capability.
- `/Users/kevinlin/code/openclaw/extensions/imessage/src/shared.ts:90`: plugin base declares group-management capability.
- `/Users/kevinlin/code/openclaw/extensions/imessage/src/actions.ts:412`: action dispatch reads cached private API status.
- `/Users/kevinlin/code/openclaw/extensions/imessage/src/actions.ts:420`: action dispatch performs inline private API probe when needed.
- `/Users/kevinlin/code/openclaw/extensions/imessage/src/actions.ts:425`: unavailable bridge blocks private API actions.
- `/Users/kevinlin/code/openclaw/extensions/imessage/src/actions.ts:559`: reply-with-attachment requires `send-rich --file`.

### Integration tests

- `/Users/kevinlin/code/openclaw/src/agents/tools/message-tool.test.ts:1493`: message-tool tests create an iMessage channel plugin with docs path.
- `/Users/kevinlin/code/openclaw/src/agents/tools/message-tool.test.ts:1508`: message-tool descriptions include iMessage/SMS chat-guid target hints.
- No live private API action lane was found.

### Unit tests

- `/Users/kevinlin/code/openclaw/extensions/imessage/src/actions.test.ts:98`: private API actions are not advertised when the bridge is known unavailable.
- `/Users/kevinlin/code/openclaw/extensions/imessage/src/actions.test.ts:113`: private API actions remain advertised when bridge status is unknown.
- `/Users/kevinlin/code/openclaw/extensions/imessage/src/actions.test.ts:135`: BlueBubbles-parity actions are advertised when private API selectors are available.
- `/Users/kevinlin/code/openclaw/extensions/imessage/src/actions.test.ts:165`: configured action gates are respected.
- `/Users/kevinlin/code/openclaw/extensions/imessage/src/actions.test.ts:234`: message-tool reactions map to imsg tapback kinds.
- `/Users/kevinlin/code/openclaw/extensions/imessage/src/actions.test.ts:419`: hydrated buffer attachments thread through `sendRichMessage` when supported.
- `/Users/kevinlin/code/openclaw/extensions/imessage/src/actions.runtime.test.ts:33`: configured `dbPath` is passed to private API bridge commands.
- `/Users/kevinlin/code/openclaw/extensions/imessage/src/actions.runtime.test.ts:93`: synthesized direct chat targets resolve against `chats.list`.

### Gitcrawl queries

Query:

`gitcrawl search openclaw/openclaw --query "iMessage private API" --json --limit 6`

Results:

- Open issue #84329: outbound sends should prefer configurable IMCore transport
  when available.
- Open issue #79610: benign Apple AddressBook stderr logged at error level.
- Release/archive snippets mention iMessage reaction/private API diagnostics.

Query:

`gitcrawl search openclaw/openclaw --query "iMessage send-rich" --json --limit 6`

Results:

- Open issue #84329, open issue #87597, and open issue #85954.

### Discrawl queries

Query:

`/Users/kevinlin/.local/bin/discrawl search "iMessage private API" --limit 6`

Results:

- Beta release notes mentioned iMessage reaction/private API diagnostics.

Query:

`/Users/kevinlin/.local/bin/discrawl search "iMessage send-rich" --limit 6`

Results:

- Maintainer snippets referenced merged iMessage reply attachments through
  `send-rich --file`.
