---
title: "Channel framework - Inbound Access and Identity Gates Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Channel framework - Inbound Access and Identity Gates Maturity Note

## Summary

Inbound access and identity gating is one of the stronger parts of the channel framework. The shared code models route allowlists, DM pairing, group policies, access groups, mention activation, command authorization, event authorization, and sanitized admission projections before a channel turn reaches agent dispatch.

The maturity limit is consistency across providers and historical migration. The shared algebra is present and well tested, but archive evidence shows it was introduced to replace duplicated channel-specific auth trees, and docs still need to make the cross-channel contract easier for operators to verify.

## Category Scope

Included in this category:

- DM pairing: DM pairing and allowFrom sender controls
- Group/channel allowlists: Group/channel allowlists and sender allowlists
- Access group expansion: Access group expansion and sender authorization helpers
- Mention gating: Mention gating, implicit mentions, command bypass, and bot-loop-aware admission
- Sanitized inbound identity/route projections: Sanitized inbound identity/route projections for downstream dispatch

## Features

- DM pairing: DM pairing and allowFrom sender controls
- Group/channel allowlists: Group/channel allowlists and sender allowlists
- Access group expansion: Access group expansion and sender authorization helpers
- Mention gating: Mention gating, implicit mentions, command bypass, and bot-loop-aware admission
- Sanitized inbound identity/route projections: Sanitized inbound identity/route projections for downstream dispatch

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Stable (80%)`
- Positive signals:
  - Docs cover access groups, DM pairing, group policy, group allowlists, group sender authorization, and per-channel examples (`docs/channels/access-groups.md:10`, `docs/channels/access-groups.md:121`, `docs/channels/groups.md:112`, `docs/channels/groups.md:286`, `docs/channels/groups.md:431`).
  - Source has shared admission logic for route, command, event, activation, sender, pairing, access-group, and mention-gating decisions (`src/channels/message-access/decision.ts:33`, `src/channels/message-access/decision.ts:70`, `src/channels/message-access/decision.ts:125`, `src/channels/message-access/decision.ts:204`, `src/channels/message-access/runtime.ts:598`).
  - Provider docs show the shared gates wired into Discord, LINE, Signal, Google Chat, Matrix, and group behavior (`docs/channels/discord.md:429`, `docs/channels/discord.md:532`, `docs/channels/line.md:139`, `docs/channels/signal.md:247`, `docs/channels/googlechat.md:162`, `docs/channels/matrix.md:652`).
  - Unit coverage directly exercises message access, allowlist matching, mention gating, and command gating.
- Negative signals:
  - The docs are spread across generic and provider-specific pages, making it hard for operators to know which fields participate in the same shared decision.
  - Some provider pages still describe local behavior more deeply than the shared ingress contract.
  - Archive evidence shows the shared ingress algebra was created to address duplicated, drifting channel auth implementations.
- Integration gaps:
  - No broad live matrix was found that runs the same pairing/group/mention/access-group scenarios across all supported channels.
  - Access groups have good helper-level coverage, but current evidence does not prove every listed provider has a live conformance case.

## Quality Score

- Score: `Beta (76%)`
- Quality rationale:
  - The core decision graph is explicit and composable; identity facts are normalized, raw sender values are not retained unnecessarily, and admission projections are separated from dispatch.
  - Access groups are documented as allowlist aliases rather than role/owner grants, reducing operator misuse.
  - Mention gating includes explicit/implicit/bypass handling and preserves command bypass rules.
- Main quality risks:
  - Operators still need to stitch together generic docs, channel docs, and config examples to diagnose why a message was dropped.
  - Some channels have special sender formats, group IDs, bot flags, or native mention semantics, so the shared contract depends on provider adapters producing correct facts.
  - The archive shows low-volume but high-impact ingress issues around mention gating and upstream auth tree drift.
- Quality scoring excludes test quantity; tests are recorded only as coverage evidence.

## Completeness Score

- Score: `Stable (80%)`
- Surface instructions: evaluated against `references/completeness/channel-framework.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for DM pairing, Group/channel allowlists, Access group expansion, Mention gating, Sanitized inbound identity/route projections.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Publish one cross-channel ingress decision table that maps DM pairing, group policy, access groups, mention gating, commands, and event classes to allow/drop outcomes.
- Add a conformance fixture that runs the same ingress cases against every bundled channel adapter that claims shared access support.
- Improve status/debug output so operators can see the exact gate that dropped a message without reading logs.

## Evidence

### Docs

- `docs/channels/access-groups.md:10` describes access groups as named sender lists referenced from channel allowlists; `docs/channels/access-groups.md:14` warns they do not grant access by themselves.
- `docs/channels/access-groups.md:121` through `docs/channels/access-groups.md:128` lists shared message-channel authorization paths and current bundled support.
- `docs/channels/groups.md:112` through `docs/channels/groups.md:126` separates trigger authorization from context visibility and defines `allowlist`, `allowlist_quote`, and quote/reply context behavior.
- `docs/channels/groups.md:286` through `docs/channels/groups.md:296` document group policy, DM-pairing separation, and Matrix allowlist caveats.
- `docs/channels/groups.md:321` through `docs/channels/groups.md:323` document mention-required group behavior and implicit mentions through replies/quotes.
- `docs/channels/groups.md:428` through `docs/channels/groups.md:431` explain group allowlist keys and the common confusion that DM pairing does not authorize group commands.
- `docs/channels/discord.md:429` through `docs/channels/discord.md:589` document Discord DM pairing, access groups, group policy, mention gating, channel/guild allowlists, and role-aware sender controls.
- `docs/channels/line.md:139` through `docs/channels/line.md:145`, `docs/channels/signal.md:247` through `docs/channels/signal.md:258`, and `docs/channels/googlechat.md:160` through `docs/channels/googlechat.md:164` show provider-specific pairing and group allowlist wiring.

### Source

- `src/channels/message-access/decision.ts:33` through `src/channels/message-access/decision.ts:68` evaluate route gates and empty-sender policy.
- `src/channels/message-access/decision.ts:70` through `src/channels/message-access/decision.ts:112` evaluate command gates; `src/channels/message-access/decision.ts:125` through `src/channels/message-access/decision.ts:164` evaluate event gates.
- `src/channels/message-access/decision.ts:204` through `src/channels/message-access/decision.ts:254` evaluates activation gates; `src/channels/message-access/decision.ts:256` through `src/channels/message-access/decision.ts:328` composes the channel ingress decision graph.
- `src/channels/message-access/runtime.ts:66` through `src/channels/message-access/runtime.ts:98` merges effective `allowFrom` lists; `src/channels/message-access/runtime.ts:100` through `src/channels/message-access/runtime.ts:123` reads pairing-store state.
- `src/channels/message-access/runtime.ts:237` through `src/channels/message-access/runtime.ts:310` builds reusable access resolvers; `src/channels/message-access/runtime.ts:598` through `src/channels/message-access/runtime.ts:722` resolves normalized identity, access groups, route facts, state, decision, and sanitized projections.
- `src/channels/mention-gating.ts:34` through `src/channels/mention-gating.ts:54` models mention facts and policy; `src/channels/mention-gating.ts:171` through `src/channels/mention-gating.ts:191` produces inbound mention decisions.
- `src/channels/allowlist-match.ts:35` through `src/channels/allowlist-match.ts:80` compiles and matches allowlist entries; `src/channels/allowlist-match.ts:93` through `src/channels/allowlist-match.ts:122` supports simple sender matching.
- `src/channels/command-gating.ts:8` through `src/channels/command-gating.ts:66` resolves command and control-command gates.

### Integration tests

- `scripts/e2e/npm-onboard-channel-agent-docker.sh:184` through `scripts/e2e/npm-onboard-channel-agent-docker.sh:201` verifies a channel-driven local agent turn after setup for common channels, indirectly proving admission reaches dispatch.
- `src/gateway/gateway-acp-bind.live.test.ts:565` exercises a synthetic Slack DM conversation bound to a live ACP session and reroutes the next turn, covering admitted inbound identity through routing.
- No broad live conformance suite was found for all access gates across every supported channel.

### Unit tests

- `src/channels/message-access/message-access.test.ts:87` through `src/channels/message-access/message-access.test.ts:164` verifies channel ingress, route sender allowlists without retaining raw sender values, and deny-when-empty sender policy.
- `src/channels/allowlist-match.test.ts:7` through `src/channels/allowlist-match.test.ts:50` verifies allowlist cache invalidation and candidate recomputation.
- `src/channels/mention-gating.test.ts:9` through `src/channels/mention-gating.test.ts:265` covers explicit/implicit mentions, bypass, unavailable mentions, command bypass behavior, and implicit mention kind helpers.
- `src/channels/command-gating.test.ts:8` through `src/channels/command-gating.test.ts:99` covers access-group-backed command auth and control-command gates.

### Gitcrawl queries

Query: `gitcrawl search openclaw/openclaw --query "channel inbound allowlist pairing mention gating access group" --json --limit 8`

Results:

- Returned issue/PR cluster #74163 with a Microsoft Teams mention-gating note that `suppressAlways` behavior should be honored, showing provider-specific ingress semantics still matter.
- Did not return a large current open bug cluster for the exact shared ingress query.

### Discrawl queries

Query: `/Users/kevinlin/.local/bin/discrawl --json search "channel inbound allowlist pairing mention gating access group" --limit 8`

Results:

- Returned a maintainer design note for `channel_ingress_refactor.md` describing duplicated upstream auth trees and the goal of one core ingress authorization algebra covering DM/group policy, allowlists, access groups, pairing, command/event auth, and mention activation.
- This supports the quality assessment that the shared contract exists but was built to replace previously drifting provider-specific logic.
