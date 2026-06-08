---
title: "Microsoft Teams - Conversation Routing and Delivery Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Microsoft Teams - Conversation Routing and Delivery Maturity Note

## Summary

Teams routing has broad runtime implementation and meaningful archive evidence
from production-like thread/session fixes. Coverage reaches Beta because source
and tests cover nested allowlists, mention gates, thread sessions, parent
context, and Graph thread fetching. Quality stays Alpha because archive history
shows real regressions around thread session isolation, outbound reply targets,
pagination, and debounced cross-thread handling.

## Normalization

Active category after channel taxonomy normalization.

- Normalized category: `Conversation Routing and Delivery`
- Merged from: `Conversation Routing`, `Webhook and Delivery`
- Score carry-forward: conservative minimum of merged source category scores.

## Category Scope

Included in this category:

- Team and channel allowlists: Covers Teams/channel allowlists, stable conversation IDs, `channels.msteams.teams`, wildcard routing, and team/channel name resolution.
- Deterministic channel replies: Covers deterministic reply routing back to the Teams channel where a message arrived and wildcard routing safeguards.
- Mention-gated group access: Covers `groupPolicy`, `groupAllowFrom`, `requireMention`, and mention-gated group or channel replies.
- Session routing: Covers deterministic reply routing, session keys, channel bindings, and conversation isolation for Microsoft Teams rooms and channels.
- Reply and thread context: Covers reply context, quoted source messages, thread-aware routing, and room context for Teams conversations.
- Text formatting and chunking: Covers Text formatting and chunking across outbound text chunking, markdown table conversion, payload media sequencing, semantic presentation rendering, and related outbound delivery and rendering behavior.
- Adaptive and presentation cards: Covers Adaptive and presentation cards across outbound text chunking, markdown table conversion, payload media sequencing, semantic presentation rendering, and related outbound delivery and rendering behavior.
- Progress streaming: Covers Progress streaming across outbound text chunking, markdown table conversion, payload media sequencing, semantic presentation rendering, and related outbound delivery and rendering behavior.
- Delivery receipts and errors: Covers Delivery receipts and errors across outbound text chunking, markdown table conversion, payload media sequencing, semantic presentation rendering, and related outbound delivery and rendering behavior.
- Queued and proactive replies: Covers Queued and proactive replies across outbound text chunking, markdown table conversion, payload media sequencing, semantic presentation rendering, and related outbound delivery and rendering behavior.
- Webhook Runtime: Covers Webhook Runtime across webhook server startup, SDK auth/JWT handling, bearer pre-gate, JSON body limits, and related webhook runtime, sdk lifecycle, and proactive cloud boundary behavior.
- SDK Lifecycle: Covers SDK Lifecycle across webhook server startup, SDK auth/JWT handling, bearer pre-gate, JSON body limits, and related webhook runtime, sdk lifecycle, and proactive cloud boundary behavior.
- Proactive Cloud Boundary: Covers Proactive Cloud Boundary across webhook server startup, SDK auth/JWT handling, bearer pre-gate, JSON body limits, and related webhook runtime, sdk lifecycle, and proactive cloud boundary behavior.
- Text formatting and chunking: Covers Text formatting and chunking across outbound text chunking, markdown table conversion, payload media sequencing, semantic presentation rendering, and related outbound delivery and rendering behavior
- Adaptive and presentation cards: Covers Adaptive and presentation cards across outbound text chunking, markdown table conversion, payload media sequencing, semantic presentation rendering, and related outbound delivery and rendering behavior
- Progress streaming: Covers Progress streaming across outbound text chunking, markdown table conversion, payload media sequencing, semantic presentation rendering, and related outbound delivery and rendering behavior
- Delivery receipts and errors: Covers Delivery receipts and errors across outbound text chunking, markdown table conversion, payload media sequencing, semantic presentation rendering, and related outbound delivery and rendering behavior
- Queued and proactive replies: Covers Queued and proactive replies across outbound text chunking, markdown table conversion, payload media sequencing, semantic presentation rendering, and related outbound delivery and rendering behavior
- Webhook Runtime: Covers Webhook Runtime across webhook server startup, SDK auth/JWT handling, bearer pre-gate, JSON body limits, and related webhook runtime, sdk lifecycle, and proactive cloud boundary behavior
- SDK Lifecycle: Covers SDK Lifecycle across webhook server startup, SDK auth/JWT handling, bearer pre-gate, JSON body limits, and related webhook runtime, sdk lifecycle, and proactive cloud boundary behavior
- Proactive Cloud Boundary: Covers Proactive Cloud Boundary across webhook server startup, SDK auth/JWT handling, bearer pre-gate, JSON body limits, and related webhook runtime, sdk lifecycle, and proactive cloud boundary behavior

## Features

- Team and channel allowlists: Covers Teams/channel allowlists, stable conversation IDs, `channels.msteams.teams`, wildcard routing, and team/channel name resolution.
- Deterministic channel replies: Covers deterministic reply routing back to the Teams channel where a message arrived and wildcard routing safeguards.
- Mention-gated group access: Covers `groupPolicy`, `groupAllowFrom`, `requireMention`, and mention-gated group or channel replies.
- Session routing: Covers deterministic reply routing, session keys, channel bindings, and conversation isolation for Microsoft Teams rooms and channels.
- Reply and thread context: Covers reply context, quoted source messages, thread-aware routing, and room context for Teams conversations.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (72%)`
- Positive signals: Docs, runtime source, and focused tests cover nested
  team/channel allowlists, mention gates, reply style, session keys, thread
  parent context, and Graph thread fetching.
- Negative signals: No current live Teams thread-routing scenario file was
  found; archive proof is mostly issue/PR discussion and production
  confirmation rather than a reproducible test lane.
- Integration gaps: Missing live scenarios for posts vs threads UI style,
  channel thread replies, top-level fallback, long thread pagination, and
  supplemental context filtering under allowlists.

## Quality Score

- Score: `Alpha (68%)`
- Gitcrawl reports: Focused keyword search for thread/session terms returned
  no hits, but broad Teams archive search and discrawl surfaced thread-session
  PRs/issues.
- Discrawl reports: `msteams thread session replyToId routing` returned `#62713`
  with a P1 review comment about inbound debounce coalescing messages from
  different channel threads; broad search also surfaced `#59294`, `#66771`, and
  `#69428` discussion around thread isolation, outbound `replyToId`, malformed
  session keys, and pagination.
- Good qualities: Routing is ID-first, mention-gated by default, nested by team
  and channel, and source now isolates channel threads and fetches parent/thread
  context with graceful degradation.
- Bad qualities: Teams API does not expose channel UI style, so `replyStyle`
  is operator-configured; thread/session behavior has a recent regression
  history.
- Excluded from quality: Unit-test count, route-test breadth, and live-proof
  gaps.

## Completeness Score

- Score: `Beta (72%)`
- Surface instructions: evaluated against `references/completeness/microsoft-teams.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Team and channel allowlists, Deterministic channel replies, Mention-gated group access, Session routing, Reply and thread context.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Add a live routing scorecard for Teams posts-style and threads-style channels.
- Add tenant-backed scenarios for multiple simultaneous threads in one channel,
  debounced sends, and long thread pagination.
- Add operator diagnostics for wrong `replyStyle` and stale stored thread
  references.

## Evidence

### Docs

- `docs/channels/msteams.md` documents `groupPolicy`, `groupAllowFrom`, nested
  Teams/channel allowlists, stable conversation IDs, Graph resolution,
  `replyStyle`, thread context preservation, history context, Team/Channel ID
  extraction, and private-channel limitations.
- `docs/channels/groups.md` documents cross-channel group behavior, mention
  gates, implicit mentions, group session keys, and per-group tool restrictions.
- `docs/channels/channel-routing.md` is the shared routing reference.

### Source

- `extensions/msteams/src/policy.ts` resolves nested team/channel allowlists,
  tool policy, mention requirements, and reply style precedence.
- `extensions/msteams/src/monitor-handler/message-handler.ts` drops blocked
  group senders, resolves route/session keys, applies mention gates, stores
  conversation references, builds native channel IDs, fetches Graph thread
  replies, filters supplemental context, and dispatches replies.
- `extensions/msteams/src/monitor-handler/thread-session.ts` isolates channel
  thread sessions.
- `extensions/msteams/src/thread-parent-context.ts` implements cached parent
  context injection.
- `extensions/msteams/src/graph-thread.ts` resolves team IDs and fetches parent
  and reply messages with pagination caveats.

### Integration tests

- No real Teams live/e2e routing lane was found by `rg`.
- Archive discussion references production confirmation on prior thread
  session fixes, but this audit did not find a checked-in scenario artifact.

### Unit tests

- `extensions/msteams/src/policy.test.ts` covers route config and reply policy.
- `extensions/msteams/src/monitor-handler/message-handler.thread-session.test.ts`
  covers thread session isolation.
- `extensions/msteams/src/monitor-handler/message-handler.thread-parent.test.ts`
  and `extensions/msteams/src/thread-parent-context.test.ts` cover parent
  context injection and caching.
- `extensions/msteams/src/resolve-allowlist.test.ts` covers team/channel and
  user allowlist resolution.
- `extensions/msteams/src/channel.actions.test.ts` covers native channel ID
  action routing.

### Gitcrawl queries

Query:

- `gitcrawl search openclaw/openclaw --query "msteams thread session routing replyToId channel" --json --limit 10`
- `gitcrawl search openclaw/openclaw --query "msteams thread session replyToId thread context" --json --limit 10`

Results:

- Both focused gitcrawl searches returned `[]`.

### Discrawl queries

Query:

- `DISCRAWL_NO_AUTO_UPDATE=1 /Users/kevinlin/.local/bin/discrawl search --limit 10 "msteams thread session replyToId routing"`
- `DISCRAWL_NO_AUTO_UPDATE=1 /Users/kevinlin/.local/bin/discrawl search --limit 10 "msteams groupPolicy groupAllowFrom requireMention team channel"`

Results:

- The thread query returned `#62713`, including a P1 review comment to include
  thread identity in debounce partitioning.
- The group policy query returned no lines.
