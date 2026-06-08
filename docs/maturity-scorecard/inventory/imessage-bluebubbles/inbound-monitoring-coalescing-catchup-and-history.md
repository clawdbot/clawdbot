---
title: "iMessage / BlueBubbles - Conversation Routing and Delivery Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# iMessage / BlueBubbles - Conversation Routing and Delivery Maturity Note

## Summary

Inbound monitoring, coalescing, catchup, and history are Beta. The component has
substantial runtime code and focused tests for `watch.subscribe`, startup retry,
debounce/coalescing, echo suppression, DM history, reaction events, and catchup
cursors. It is not Stable because live `watch.subscribe` is a recurring field
risk and because catchup correctness depends on real chat.db ordering, Gateway
sleep/restart timing, and Apple-client behavior.

## Normalization

Active category after channel taxonomy normalization.

- Normalized category: `Conversation Routing and Delivery`
- Merged from: `Message Intake and History`, `Conversation Routing and Access`
- Score carry-forward: conservative minimum of merged source category scores.

## Category Scope

Included in this category:

- Watch live messages: Covers Watch live messages across inbound `watch.subscribe`, notification parsing, echo and self-chat guards, sent-message cache, same-sender DM coalescing, DM history, reaction event routing, catchup cursor/replay, and live cursor advancement.
- Coalesce split-send DMs: Covers Coalesce split-send DMs across inbound `watch.subscribe`, notification parsing, echo and self-chat guards, sent-message cache, same-sender DM coalescing, DM history, reaction event routing, catchup cursor/replay, and live cursor advancement.
- Replay missed messages: Covers Replay missed messages across inbound `watch.subscribe`, notification parsing, echo and self-chat guards, sent-message cache, same-sender DM coalescing, DM history, reaction event routing, catchup cursor/replay, and live cursor advancement.
- Seed conversation history: Covers Seed conversation history across inbound `watch.subscribe`, notification parsing, echo and self-chat guards, sent-message cache, same-sender DM coalescing, DM history, reaction event routing, catchup cursor/replay, and live cursor advancement.
- Authorize direct senders: Covers Authorize direct senders across `dmPolicy`, `allowFrom`, pairing, sender identity normalization, and related dm pairing, access, and session routing behavior.
- Route direct conversations: Covers Route direct conversations across `dmPolicy`, `allowFrom`, pairing, sender identity normalization, and related dm pairing, access, and session routing behavior.
- Bind ACP sessions: Covers Bind ACP sessions across `dmPolicy`, `allowFrom`, pairing, sender identity normalization, and related dm pairing, access, and session routing behavior.
- Group Policy: Covers Group Policy across `groupPolicy`, `groupAllowFrom`, `groups`, wildcard registry entries, `requireMention`, mention patterns, per-group tools, per-group system prompts, group sessions, and warnings for allowlist misconfiguration.
- Mentions: Covers Mentions across `groupPolicy`, `groupAllowFrom`, `groups`, wildcard registry entries, `requireMention`, mention patterns, per-group tools, per-group system prompts, group sessions, and warnings for allowlist misconfiguration.
- System Prompts: Covers System Prompts across `groupPolicy`, `groupAllowFrom`, `groups`, wildcard registry entries, `requireMention`, mention patterns, per-group tools, per-group system prompts, group sessions, and warnings for allowlist misconfiguration.

## Features

- Watch live messages: Covers Watch live messages across inbound `watch.subscribe`, notification parsing, echo and self-chat guards, sent-message cache, same-sender DM coalescing, DM history, reaction event routing, catchup cursor/replay, and live cursor advancement.
- Coalesce split-send DMs: Covers Coalesce split-send DMs across inbound `watch.subscribe`, notification parsing, echo and self-chat guards, sent-message cache, same-sender DM coalescing, DM history, reaction event routing, catchup cursor/replay, and live cursor advancement.
- Replay missed messages: Covers Replay missed messages across inbound `watch.subscribe`, notification parsing, echo and self-chat guards, sent-message cache, same-sender DM coalescing, DM history, reaction event routing, catchup cursor/replay, and live cursor advancement.
- Seed conversation history: Covers Seed conversation history across inbound `watch.subscribe`, notification parsing, echo and self-chat guards, sent-message cache, same-sender DM coalescing, DM history, reaction event routing, catchup cursor/replay, and live cursor advancement.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (74%)`
- Positive signals:
  - Docs describe downtime catchup, watch ordering, cursor paths, coalescing,
    and troubleshooting.
  - Source implements startup retry, approval reaction shortcut, normal
    dispatch, coalescing keys, catchup replay, and cursor protection.
  - Tests cover retry exhaustion, coalescing edge cases, catchup cursor
    monotonicity, failure retry, echo cache persistence, and inbound reaction
    decisions.
  - MCP seeded channel e2e proves conversation metadata and transcript access
    for an iMessage channel, though not live `imsg`.
- Negative signals:
  - No live `watch.subscribe` proof was found.
  - Archive reports include `watch.subscribe` timeouts and gateway readiness
    degradation under iMessage channel churn.
  - Catchup has many correctness branches that are well unit-tested but not
    proven against real chat.db sleep/restart histories.
- Integration gaps:
  - Add a gated Mac lane that exercises live inbound message, Gateway restart,
    downtime catchup, duplicate prevention, and same-sender coalescing.
  - Add fake-imsg integration around out-of-order `messages.history` and
    overlapping live/replayed rows.

## Quality Score

- Score: `Beta (73%)`
- Gitcrawl reports:
  - `imsg rpc timeout gateway` returned #87263 for `watch.subscribe` timeout on
    every Gateway start.
  - `iMessage catchup coalesce history watch.subscribe echo` returned no direct
    hits in the latest gitcrawl pass.
- Discrawl reports:
  - `imsg rpc timeout gateway` returned support snippets with `imsg rpc not
ready` restart loops and Gateway readiness delays.
  - `iMessage catchup coalesce history watch.subscribe echo` returned no
    snippets.
- Good qualities:
  - Startup ordering is intentional: wait for transport, subscribe, then run
    catchup before entering the live dispatch loop.
  - Catchup cursor logic protects against leapfrogging failed rows and has
    explicit give-up behavior.
  - Echo/self-chat detection uses both transient and persisted sent-message
    state.
  - Coalescing preserves attachment and GUID metadata instead of just merging
    text.
- Bad qualities:
  - `watch.subscribe` is operationally fragile and can take down the channel.
  - Catchup and echo prevention depend on timing and ids from external Messages
    state.
  - Gateway sleep, Mac sleep, and multi-device echo behavior are hard to model
    in local-only checks.
- Excluded from quality:
  - Unit, integration, e2e, live, and runtime-flow test evidence is recorded
    under Coverage only.

## Completeness Score

- Score: `Beta (74%)`
- Surface instructions: evaluated against `references/completeness/imessage-bluebubbles.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Watch live messages, Coalesce split-send DMs, Replay missed messages, Seed conversation history.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Live inbound/catchup proof is missing.
- `watch.subscribe` timeouts are active field evidence.
- Sleep/restart behavior is not proven under real Messages.app history.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/channels/imessage.md:12`: catchup is opt-in and replays messages that landed while Gateway was down.
- `/Users/kevinlin/code/openclaw/docs/channels/imessage.md:672`: BlueBubbles coalescing settings should migrate to `channels.imessage.coalesceSameSenderDms`.
- `/Users/kevinlin/code/openclaw/docs/channels/imessage.md:711`: catchup is sequenced as `imsg` ready, `watch.subscribe`, catchup, then live dispatch.
- `/Users/kevinlin/code/openclaw/docs/channels/imessage.md:717`: catchup cursor path is under the OpenClaw state dir.
- `/Users/kevinlin/code/openclaw/docs/channels/imessage.md:729`: live-handled rows advance the same cursor only after startup catchup succeeds.
- `/Users/kevinlin/code/openclaw/docs/channels/imessage.md:730`: repeated row failures eventually force-advance past a wedged message.
- `/Users/kevinlin/code/openclaw/docs/channels/imessage.md:736`: catchup logs include replayed, skipped, failed, and fetched counts.

### Source

- `/Users/kevinlin/code/openclaw/extensions/imessage/src/monitor/monitor-provider.ts:261`: coalescing changes debounce behavior when enabled.
- `/Users/kevinlin/code/openclaw/extensions/imessage/src/monitor/monitor-provider.ts:297`: coalesced DMs key on chat and sender.
- `/Users/kevinlin/code/openclaw/extensions/imessage/src/monitor/monitor-provider.ts:487`: approval reaction shortcut bypasses normal dispatch for approval resolution.
- `/Users/kevinlin/code/openclaw/extensions/imessage/src/monitor/monitor-provider.ts:989`: runtime subscribes through `watch.subscribe`.
- `/Users/kevinlin/code/openclaw/extensions/imessage/src/monitor/monitor-provider.ts:1086`: catchup runs between `watch.subscribe` and live dispatch.
- `/Users/kevinlin/code/openclaw/extensions/imessage/src/monitor/catchup.ts:368`: `performIMessageCatchup` is the replay entrypoint.
- `/Users/kevinlin/code/openclaw/extensions/imessage/src/monitor/catchup.ts:527`: catchup avoids duplicate dispatch overlap.
- `/Users/kevinlin/code/openclaw/extensions/imessage/src/monitor/coalesce.ts:13`: coalesced messages preserve GUID tracking for replay paths.

### Integration tests

- `/Users/kevinlin/code/openclaw/scripts/e2e/mcp-channels-seed.ts:58`: seed data includes an iMessage transcript preview.
- `/Users/kevinlin/code/openclaw/scripts/e2e/mcp-channels-docker-client.ts:172`: Docker MCP client reads seeded transcript messages.
- No live `watch.subscribe` or catchup integration lane was found.

### Unit tests

- `/Users/kevinlin/code/openclaw/extensions/imessage/src/monitor.watch-subscribe-retry.test.ts:81`: transient `watch.subscribe` timeout retries without tearing down the monitor.
- `/Users/kevinlin/code/openclaw/extensions/imessage/src/monitor.watch-subscribe-retry.test.ts:122`: bounded retries eventually fail.
- `/Users/kevinlin/code/openclaw/extensions/imessage/src/monitor/catchup.test.ts:244`: fresh inbound rows replay and advance cursor.
- `/Users/kevinlin/code/openclaw/extensions/imessage/src/monitor/catchup.test.ts:311`: failing rows hold the cursor below max retries.
- `/Users/kevinlin/code/openclaw/extensions/imessage/src/monitor/catchup.test.ts:413`: a later success does not leapfrog a held failure.
- `/Users/kevinlin/code/openclaw/extensions/imessage/src/monitor/coalesce.test.ts:36`: split-send text and URL merge into one payload.
- `/Users/kevinlin/code/openclaw/extensions/imessage/src/monitor/coalesce.test.ts:61`: coalescing preserves attachments.
- `/Users/kevinlin/code/openclaw/extensions/imessage/src/monitor/monitor-provider.echo-cache.test.ts:128`: echo cache retains entries long enough for catchup replay.

### Gitcrawl queries

Query:

`gitcrawl search openclaw/openclaw --query "imsg rpc timeout gateway" --json --limit 6`

Results:

- Open issue #87263: `watch.subscribe` timeout on every Gateway start.

Query:

`gitcrawl search openclaw/openclaw --query "iMessage catchup coalesce history watch.subscribe echo" --json --limit 6`

Results:

- No direct hits in the latest pass.

### Discrawl queries

Query:

`/Users/kevinlin/.local/bin/discrawl search "imsg rpc timeout gateway" --limit 6`

Results:

- Discord snippets reported `imsg rpc not ready` loops, channel exits, and
  Gateway readiness degradation.

Query:

`/Users/kevinlin/.local/bin/discrawl search "iMessage catchup coalesce history watch.subscribe echo" --limit 6`

Results:

- No snippets returned.
