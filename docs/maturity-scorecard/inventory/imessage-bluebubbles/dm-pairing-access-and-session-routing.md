---
title: "iMessage / BlueBubbles - Access and Identity Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# iMessage / BlueBubbles - Access and Identity Maturity Note

## Summary

DM pairing, access, and session routing are Beta. The implementation has clear
policy modes, pairing behavior, allowlist formatting, command authorization,
sender normalization, and ACP conversation binding. The main maturity limit is
not the shape of the code; it is the amount of identity variance at runtime:
phone numbers, Apple ID emails, service prefixes, chat ids, and old session keys
all have to map cleanly.

## Normalization

Active category after channel taxonomy normalization.

- Normalized category: `Access and Identity`
- Merged from: `Conversation Routing and Access`
- Score carry-forward: conservative minimum of merged source category scores.

## Category Scope

Included in this category:

- Authorize direct senders: Covers Authorize direct senders across `dmPolicy`, `allowFrom`, pairing, sender identity normalization, and related dm pairing, access, and session routing behavior.
- Route direct conversations: Covers Route direct conversations across `dmPolicy`, `allowFrom`, pairing, sender identity normalization, and related dm pairing, access, and session routing behavior.
- Bind ACP sessions: Covers Bind ACP sessions across `dmPolicy`, `allowFrom`, pairing, sender identity normalization, and related dm pairing, access, and session routing behavior.
- Group Policy: Covers Group Policy across `groupPolicy`, `groupAllowFrom`, `groups`, wildcard registry entries, `requireMention`, mention patterns, per-group tools, per-group system prompts, group sessions, and warnings for allowlist misconfiguration.
- Mentions: Covers Mentions across `groupPolicy`, `groupAllowFrom`, `groups`, wildcard registry entries, `requireMention`, mention patterns, per-group tools, per-group system prompts, group sessions, and warnings for allowlist misconfiguration.
- System Prompts: Covers System Prompts across `groupPolicy`, `groupAllowFrom`, `groups`, wildcard registry entries, `requireMention`, mention patterns, per-group tools, per-group system prompts, group sessions, and warnings for allowlist misconfiguration.
- Group Policy: Covers Group Policy across `groupPolicy`, `groupAllowFrom`, `groups`, wildcard registry entries, `requireMention`, mention patterns, per-group tools, per-group system prompts, group sessions, and warnings for allowlist misconfiguration
- Mentions: Covers Mentions across `groupPolicy`, `groupAllowFrom`, `groups`, wildcard registry entries, `requireMention`, mention patterns, per-group tools, per-group system prompts, group sessions, and warnings for allowlist misconfiguration
- System Prompts: Covers System Prompts across `groupPolicy`, `groupAllowFrom`, `groups`, wildcard registry entries, `requireMention`, mention patterns, per-group tools, per-group system prompts, group sessions, and warnings for allowlist misconfiguration

## Features

- Authorize direct senders: Covers Authorize direct senders across `dmPolicy`, `allowFrom`, pairing, sender identity normalization, and related dm pairing, access, and session routing behavior.
- Route direct conversations: Covers Route direct conversations across `dmPolicy`, `allowFrom`, pairing, sender identity normalization, and related dm pairing, access, and session routing behavior.
- Bind ACP sessions: Covers Bind ACP sessions across `dmPolicy`, `allowFrom`, pairing, sender identity normalization, and related dm pairing, access, and session routing behavior.
- Group Policy: Covers Group Policy across `groupPolicy`, `groupAllowFrom`, `groups`, wildcard registry entries, `requireMention`, mention patterns, per-group tools, per-group system prompts, group sessions, and warnings for allowlist misconfiguration.
- Mentions: Covers Mentions across `groupPolicy`, `groupAllowFrom`, `groups`, wildcard registry entries, `requireMention`, mention patterns, per-group tools, per-group system prompts, group sessions, and warnings for allowlist misconfiguration.
- System Prompts: Covers System Prompts across `groupPolicy`, `groupAllowFrom`, `groups`, wildcard registry entries, `requireMention`, mention patterns, per-group tools, per-group system prompts, group sessions, and warnings for allowlist misconfiguration.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (76%)`
- Positive signals:
  - Docs explain DM policy modes, allowlist shape, pairing approvals, and
    troubleshooting.
  - Source resolves direct sender decisions, pairing requests, command auth,
    conversation bindings, and sender identity aliases.
  - Unit tests cover allowlist entry classes, pairing-mode store auth, command
    classification, ACP current conversation ids, and message-tool target
    behavior.
  - MCP channel seed/e2e scripts include an iMessage seeded conversation through
    Gateway/MCP surfaces.
- Negative signals:
  - No live iMessage DM pairing scenario was found.
  - Old BlueBubbles session keys do not carry forward automatically.
  - Real Apple handle normalization remains broader than synthetic test data.
- Integration gaps:
  - Add a live or fake-imsg DM flow that starts from pairing policy, sends first
    DM, approves, binds an ACP conversation, and verifies subsequent command
    authorization.

## Quality Score

- Score: `Beta (74%)`
- Gitcrawl reports:
  - `channels.imessage allowFrom` returned #73822 for SecretRef phone numbers,
    #58057 for dynamic identity resolution for allowlists, and #81876 for
    default DM allowlist behavior after first-owner bootstrap.
  - `iMessage dmPolicy allowFrom pairing sender authorization` returned no
    direct hits in the latest gitcrawl pass.
- Discrawl reports:
  - `iMessage dmPolicy allowFrom pairing sender authorization` returned no
    snippets.
  - `iMessage groupPolicy groups groupAllowFrom requireMention` returned
    support snippets that also discuss DM `dmPolicy` and `allowFrom` settings.
- Good qualities:
  - The setup path rejects chat-target entries in DM `allowFrom`, reducing a
    common policy mistake.
  - Command authorization is separate from ordinary DM admission where needed.
  - ACP conversation id resolution handles direct iMessage targets and strips
    channel prefixes.
  - Pairing request failure is surfaced as an operator-visible runtime error.
- Bad qualities:
  - Identity formats are numerous and operator-provided.
  - SecretRef and dynamic identity work in adjacent issues show the config model
    is still evolving.
  - Session migration from old BlueBubbles keys is a documented break rather
    than a code-managed transition.
- Excluded from quality:
  - Unit, integration, e2e, live, and runtime-flow test evidence is recorded
    under Coverage only.

## Completeness Score

- Score: `Beta (76%)`
- Surface instructions: evaluated against `references/completeness/imessage-bluebubbles.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Authorize direct senders, Route direct conversations, Bind ACP sessions, Group Policy, Mentions, System Prompts.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Live DM pairing proof is missing.
- Handle normalization depends on real-world phone/email/service-prefix inputs.
- Old BlueBubbles session continuity is not automatic.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/channels/imessage.md:223`: `channels.imessage.dmPolicy` controls direct messages.
- `/Users/kevinlin/code/openclaw/docs/channels/imessage.md:227`: open DM policy requires `allowFrom` to include `"*"`.
- `/Users/kevinlin/code/openclaw/docs/channels/imessage.md:230`: `channels.imessage.allowFrom` is the DM allowlist field.
- `/Users/kevinlin/code/openclaw/docs/channels/imessage.md:232`: allowlist entries must identify senders; chat targets belong in group allowlists or groups.
- `/Users/kevinlin/code/openclaw/docs/channels/imessage.md:785`: troubleshooting includes `dmPolicy`, `allowFrom`, and pairing approvals.
- `/Users/kevinlin/code/openclaw/docs/channels/imessage-from-bluebubbles.md:105`: BlueBubbles `dmPolicy` maps to iMessage `dmPolicy`.
- `/Users/kevinlin/code/openclaw/docs/channels/imessage-from-bluebubbles.md:106`: BlueBubbles `allowFrom` maps to iMessage `allowFrom` but pairing approvals carry over by handle, not token.

### Source

- `/Users/kevinlin/code/openclaw/extensions/imessage/src/setup-core.ts:62`: setup rejects DM allowlist entries that are chat targets.
- `/Users/kevinlin/code/openclaw/extensions/imessage/src/setup-core.ts:138`: setup resolves the account DM policy with pairing as default.
- `/Users/kevinlin/code/openclaw/extensions/imessage/src/monitor/monitor-provider.ts:200`: runtime normalizes DM `allowFrom`.
- `/Users/kevinlin/code/openclaw/extensions/imessage/src/monitor/monitor-provider.ts:225`: runtime defaults DM policy to `pairing`.
- `/Users/kevinlin/code/openclaw/extensions/imessage/src/monitor/monitor-provider.ts:571`: pairing decisions are converted into pairing request handling.
- `/Users/kevinlin/code/openclaw/extensions/imessage/src/monitor/inbound-processing.ts:529`: sender decisions can return a pairing request.
- `/Users/kevinlin/code/openclaw/extensions/imessage/src/monitor/inbound-processing.ts:532`: blocked sender logs include the active DM policy.
- `/Users/kevinlin/code/openclaw/extensions/imessage/src/monitor/inbound-processing.ts:684`: reply context carries allowlist information for command auth.

### Integration tests

- `/Users/kevinlin/code/openclaw/scripts/e2e/mcp-channels-seed.ts:51`: seeds a session with delivery context channel `imessage`.
- `/Users/kevinlin/code/openclaw/scripts/e2e/mcp-channels-docker-client.ts:100`: Docker MCP channel client expects seeded delivery context channel `imessage`.
- `/Users/kevinlin/code/openclaw/scripts/e2e/mcp-channels-docker-client.ts:154`: seeded conversation is returned as `imessage`.
- `/Users/kevinlin/code/openclaw/src/auto-reply/reply/commands-acp/context.test.ts:668`: ACP context resolves iMessage DM conversation ids from current targets.

### Unit tests

- `/Users/kevinlin/code/openclaw/extensions/imessage/src/monitor/inbound-processing.test.ts:888`: open-mode DMs without allowlists are not auto-authorized for commands.
- `/Users/kevinlin/code/openclaw/extensions/imessage/src/monitor/inbound-processing.test.ts:897`: pairing-mode store allowlist authorizes DM commands.
- `/Users/kevinlin/code/openclaw/extensions/imessage/src/monitor/inbound-processing.test.ts:912`: authorized iMessage control commands become text-command turns.
- `/Users/kevinlin/code/openclaw/extensions/imessage/src/approval-auth.test.ts:5`: approver auth authorizes handles and ignores chat target entries.
- `/Users/kevinlin/code/openclaw/src/auto-reply/reply/commands-acp/context.test.ts:705`: ACP context resolves iMessage DM conversation ids from current targets.
- `/Users/kevinlin/code/openclaw/src/agents/tools/message-tool.test.ts:1493`: message tool tests define an iMessage channel plugin for description/target behavior.

### Gitcrawl queries

Query:

`gitcrawl search openclaw/openclaw --query "channels.imessage allowFrom" --json --limit 6`

Results:

- #73822: SecretRef support for phone numbers in channel configs.
- #58057: dynamic identity resolution for allowlists.
- #81876: channel DM default allowlist behavior after first-owner bootstrap.

Query:

`gitcrawl search openclaw/openclaw --query "iMessage dmPolicy allowFrom pairing sender authorization" --json --limit 6`

Results:

- No direct hits in the latest pass.

### Discrawl queries

Query:

`/Users/kevinlin/.local/bin/discrawl search "iMessage dmPolicy allowFrom pairing sender authorization" --limit 6`

Results:

- No snippets returned.

Query:

`/Users/kevinlin/.local/bin/discrawl search "iMessage groupPolicy groups groupAllowFrom requireMention" --limit 6`

Results:

- Support snippets included config examples with `dmPolicy: "pairing"` and
  `allowFrom` guidance alongside group setup.
