---
title: "Discord - Access and Identity Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Discord - Access and Identity Maturity Note

## Summary

Discord DM pairing and sender authorization are implemented as a shared channel-ingress authorization surface with Discord-specific identity normalization, account-aware allowlist inheritance, pairing-store approval, dynamic access-group membership checks, and explicit group-DM gates. The docs and source agree on the intended baseline: unknown direct senders receive pairing challenges by default, open DMs require an explicit wildcard, group DMs are off unless configured, and dynamic Discord channel-audience access fails closed.

The maturity ceiling is held below Stable by missing live coverage for the core first-contact DM pairing loop and by active archive reports of silent Discord inbound drops, identity mismatches, and sender-authorization ambiguity. The implementation has good fail-closed primitives, but field evidence shows enough Discord-specific edge cases that this component should be treated as Beta until the pairing and allowlist paths have live regressions and the open bugs are retired.

## Normalization

Active category after channel taxonomy normalization.

- Normalized category: `Access and Identity`
- Merged from: `DM Pairing and Access`
- Score carry-forward: conservative minimum of merged source category scores.

## Category Scope

Included in this category:

- DM policy modes: Covers DM policy modes across Discord direct-message `dmPolicy` modes: `pairing`, `allowlist`, `open`, and `disabled`. Canonical and legacy `allowFrom` resolution across top-level Discord config, and related dm pairing and sender authorization behavior.
- Allowlist inheritance: Covers Allowlist inheritance across Discord direct-message `dmPolicy` modes: `pairing`, `allowlist`, `open`, and `disabled`. Canonical and legacy `allowFrom` resolution across top-level Discord config, and related dm pairing and sender authorization behavior.
- Pairing-code approval: Covers Pairing-code approval across Discord direct-message `dmPolicy` modes: `pairing`, `allowlist`, `open`, and `disabled`. Canonical and legacy `allowFrom` resolution across top-level Discord config, and related dm pairing and sender authorization behavior.
- Sender authorization: Covers Sender authorization across Discord direct-message `dmPolicy` modes: `pairing`, `allowlist`, `open`, and `disabled`. Canonical and legacy `allowFrom` resolution across top-level Discord config, and related dm pairing and sender authorization behavior.
- Access-group authorization: Covers Access-group authorization across Discord direct-message `dmPolicy` modes: `pairing`, `allowlist`, `open`, and `disabled`. Canonical and legacy `allowFrom` resolution across top-level Discord config, and related dm pairing and sender authorization behavior.
- Group DM authorization: Covers Group DM authorization across Discord direct-message `dmPolicy` modes: `pairing`, `allowlist`, `open`, and `disabled`. Canonical and legacy `allowFrom` resolution across top-level Discord config, and related dm pairing and sender authorization behavior.

## Features

- DM policy modes: Covers DM policy modes across Discord direct-message `dmPolicy` modes: `pairing`, `allowlist`, `open`, and `disabled`. Canonical and legacy `allowFrom` resolution across top-level Discord config, and related dm pairing and sender authorization behavior.
- Allowlist inheritance: Covers Allowlist inheritance across Discord direct-message `dmPolicy` modes: `pairing`, `allowlist`, `open`, and `disabled`. Canonical and legacy `allowFrom` resolution across top-level Discord config, and related dm pairing and sender authorization behavior.
- Pairing-code approval: Covers Pairing-code approval across Discord direct-message `dmPolicy` modes: `pairing`, `allowlist`, `open`, and `disabled`. Canonical and legacy `allowFrom` resolution across top-level Discord config, and related dm pairing and sender authorization behavior.
- Sender authorization: Covers Sender authorization across Discord direct-message `dmPolicy` modes: `pairing`, `allowlist`, `open`, and `disabled`. Canonical and legacy `allowFrom` resolution across top-level Discord config, and related dm pairing and sender authorization behavior.
- Access-group authorization: Covers Access-group authorization across Discord direct-message `dmPolicy` modes: `pairing`, `allowlist`, `open`, and `disabled`. Canonical and legacy `allowFrom` resolution across top-level Discord config, and related dm pairing and sender authorization behavior.
- Group DM authorization: Covers Group DM authorization across Discord direct-message `dmPolicy` modes: `pairing`, `allowlist`, `open`, and `disabled`. Canonical and legacy `allowFrom` resolution across top-level Discord config, and related dm pairing and sender authorization behavior.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (74%)`

This score uses only integration, e2e, live, and runtime-flow evidence.

Positive coverage signals:

- Live Discord QA exercises real Discord posting and polling for channel canary and mention-gating behavior, with runtime config that uses guild/channel allowlists and an allowlisted driver user (`extensions/qa-lab/src/live-transports/discord/discord-live.runtime.ts:291`, `extensions/qa-lab/src/live-transports/discord/discord-live.runtime.ts:307`, `extensions/qa-lab/src/live-transports/discord/discord-live.runtime.ts:451`, `extensions/qa-lab/src/live-transports/discord/discord-live.runtime.ts:671`, `extensions/qa-lab/src/live-transports/discord/discord-live.runtime.ts:1120`).
- The macOS Discord e2e script configures a real token, guild, channel, and sender allowlist, then runs status probing, outbound send, inbound host post, and readback (`scripts/e2e/parallels/macos-discord.ts:27`, `scripts/e2e/parallels/macos-discord.ts:48`).
- The package onboarding e2e accepts Discord as a supported channel, installs/configures it, runs status/doctor steps, and executes a local agent turn (`scripts/e2e/npm-onboard-channel-agent-docker.sh:27`, `scripts/e2e/npm-onboard-channel-agent-docker.sh:86`, `scripts/e2e/npm-onboard-channel-agent-docker.sh:163`, `scripts/e2e/npm-onboard-channel-agent-docker.sh:172`).
- A Discord ACP bind-here integration proves a direct-message runtime path can route into an existing ACP session when configured with `dmPolicy: "open"` and `allowFrom: ["*"]` (`extensions/discord/src/monitor/acp-bind-here.integration.test.ts:139`, `extensions/discord/src/monitor/acp-bind-here.integration.test.ts:196`, `extensions/discord/src/monitor/acp-bind-here.integration.test.ts:210`).
- Runtime-flow tests cover pairing replies, pairing-store authorization, direct/group DM classification, component-interaction authorization, and native-command group-DM rejection (`extensions/discord/src/monitor/monitor.agent-components.test.ts:157`, `extensions/discord/src/monitor/monitor.agent-components.test.ts:221`, `extensions/discord/src/monitor/monitor.agent-components.test.ts:276`, `extensions/discord/src/monitor/native-command.plugin-dispatch.test.ts:827`).

Coverage gaps:

- No located live or e2e scenario proves the full Discord first-contact DM loop: unknown sender receives code, owner approves the code, and a later DM from that sender is admitted through the approved pairing store.
- No located live or e2e scenario proves Discord allowlist denial, disabled-DM denial, or open-DM-without-wildcard denial.
- No located live or e2e scenario proves dynamic `discord.channelAudience` membership against Discord permissions, including Missing Access, wrong-guild, and unresolved-member fail-closed cases.
- No located live or e2e scenario proves group DM gating through `dm.groupEnabled` and `dm.groupChannels`.
- No located live or e2e scenario proves multi-account pairing-store scoping for named Discord accounts.

## Quality Score

- Score: `Beta (72%)`

Quality-positive findings:

- Policy semantics are documented in one place with canonical `channels.discord.dmPolicy`, canonical `channels.discord.allowFrom`, legacy aliases, target formats, multi-account precedence, pairing-code expiration, and `open` wildcard requirements (`docs/channels/discord.md:425`, `docs/channels/discord.md:456`, `docs/channels/pairing.md:24`, `docs/channels/pairing.md:79`).
- The config schema rejects unsafe or ambiguous DM modes: `dmPolicy: "open"` requires an effective wildcard, `dmPolicy: "allowlist"` requires an effective allowlist, and named accounts inherit parent allowlists for validation (`src/config/zod-schema.providers-core.ts:830`).
- The shared message-access resolver separates direct and group policies, expands access groups, reads pairing state only when policy permits it, and converts pairing-required decisions into a distinct admission result (`src/channels/message-access/runtime.ts:237`, `src/channels/message-access/runtime.ts:610`, `src/channels/message-access/sender-gates.ts:37`, `src/channels/message-access/decision.ts:290`).
- Discord-specific authorization normalizes stable user IDs and dangerous username/tag aliases, threads account ID into pairing-store access, and supports dynamic `discord.channelAudience` checks (`extensions/discord/src/monitor/dm-command-auth.ts:58`, `extensions/discord/src/monitor/dm-command-auth.ts:93`, `extensions/discord/src/monitor/dm-command-auth.ts:128`).
- Channel-audience authorization is explicitly fail-closed: permission lookup returns false on missing channel, wrong guild, unresolved member, or Discord fetch errors (`extensions/discord/src/send.permissions.ts:180`).
- Group DMs default off and require explicit channel allowlisting; group policy is not silently treated as direct-DM policy (`src/config/types.discord.ts:28`, `extensions/discord/src/monitor/message-handler.preflight.ts:318`).
- Discord approval docs prevent a risky inference path: exec approval approvers are resolved from exec/owner configuration and are not inferred from channel `allowFrom`, legacy `dm.allowFrom`, or DM `defaultTo` (`docs/channels/discord.md:1078`).
- Security audit code flags open DM posture and risky name/tag allowlist entries (`extensions/discord/src/security-audit.ts:50`, `src/security/audit-channel.ts:203`).

Quality-negative findings:

- Gitcrawl has open reports that direct Discord allowlist users can be silently ignored or dropped: #48641 reports allowlisted inbound DMs silently dropped while outbound and guild channels work, and #79043 reports a resolved Discord allowlist user being ignored with undocumented bot-owner injection into runtime allowlists.
- Gitcrawl #86332 reports a Discord DM pairing identity mismatch for PluralKit users, where the authorization path and pairing handler use different identities and can leave users in an infinite pairing loop.
- Gitcrawl #81876 reports post-bootstrap pairing exposure: after first-owner bootstrap, default pairing behavior can keep replying with pairing codes to random senders instead of auto-restricting to the owner.
- Gitcrawl #84447 identifies no per-sender inbound DM throttle for pairing and allowlist policies, which leaves pairing-code and blocked-sender surfaces vulnerable to spam and noisy operational failure.
- Gitcrawl #53198 reports Discord `allowFrom` fallback and diagnostics inconsistency around elevated authorization, showing that adjacent sender-authorization config semantics are still fragile.
- Discrawl support history repeatedly shows pairing and sender-auth confusion around Discord DMs versus server channels, named accounts, group DMs, and silently ignored commands; the model is documented, but user-visible diagnostics are not yet consistently explanatory.
- Discrawl did not surface current operational adoption evidence for `discord.channelAudience`, so the dynamic access-group path appears source-backed but not field-proven in the archive snapshot.

## Completeness Score

- Score: `Beta (74%)`
- Surface instructions: evaluated against `references/completeness/discord.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for DM policy modes, Allowlist inheritance, Pairing-code approval, Sender authorization, Access-group authorization, Group DM authorization.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Add a live Discord regression for first-contact DM pairing: challenge, `openclaw pairing approve discord <CODE>`, and post-approval message admission.
- Add a live or recorded Discord regression for `discord.channelAudience`, including ViewChannel success and Missing Access, wrong-guild, unresolved-member, and fetch-error fail-closed behavior.
- Add live or e2e coverage for direct-DM denial modes and group-DM `dm.groupChannels` authorization.
- Resolve or explicitly design around #86332, #48641, #79043, #81876, and #84447 before rating this sender-auth surface Stable.
- Improve Discord drop diagnostics so unauthorized direct messages, command-only messages, account-scope mismatches, and group-DM policy failures are externally distinguishable.

## Evidence

### Docs

- `docs/channels/discord.md:8` states Discord supports DMs and guild channels, with DMs defaulting to pairing mode.
- `docs/channels/discord.md:183` documents first-DM pairing approval, pairing-list and pairing-approve commands, and one-hour code expiration.
- `docs/channels/discord.md:425` documents Discord access control, `dmPolicy`, canonical `allowFrom`, `pairing`, `allowlist`, `open`, `disabled`, legacy aliases, and target formats.
- `docs/channels/discord.md:456` documents access groups, `message.senders`, `discord.channelAudience`, ViewChannel authorization, Server Members Intent, and fail-closed behavior.
- `docs/channels/discord.md:577` documents mentions and group DMs, with group DMs ignored by default and optional `dm.groupChannels` allowlisting.
- `docs/channels/discord.md:1078` documents Discord approval authorization and explicitly rejects inference from channel allowlists and DM defaults.
- `docs/channels/pairing.md:10` defines pairing as explicit access approval; unknown DM senders get a pairing code and their original message is not processed.
- `docs/channels/pairing.md:24` documents open-DM wildcard requirements, 8-character pairing codes, one-hour expiry, and pending request caps.
- `docs/channels/pairing.md:79` documents account-scoped pairing and allowlist state files under `~/.openclaw/credentials`.
- `docs/channels/access-groups.md:149` documents `discord.channelAudience`, ViewChannel membership, and fail-closed Missing Access/member/guild behavior.
- `docs/channels/groups.md:291` documents that DM pairing approvals apply only to DMs and that Discord group DMs are separately controlled by `channels.discord.dm.*`.

### Source

- `src/config/types.discord.ts:28` defines Discord DM policy, direct allowlist, group-DM default-off behavior, and group channel allowlisting.
- `src/config/types.discord.ts:399` defines canonical top-level `dmPolicy` and `allowFrom` plus legacy keys.
- `src/config/zod-schema.providers-core.ts:830` validates Discord DM policy safety, including wildcard and non-empty allowlist requirements.
- `extensions/discord/src/accounts.ts:61` resolves account-aware Discord `allowFrom`; `extensions/discord/src/accounts.ts:78` resolves account-aware `dmPolicy` with default `pairing`.
- `src/channels/plugins/dm-access.ts:125` resolves canonical and legacy direct-message policy and allowlist values across account and parent scopes.
- `extensions/discord/src/monitor/provider.ts:183` resolves monitor-time account, configured DM allowlist, group policy fallback, DM enablement, and default pairing policy.
- `extensions/discord/src/monitor/message-handler.preflight.ts:252` classifies direct versus group DM and drops disabled direct or group-DM traffic before routing.
- `extensions/discord/src/monitor/message-handler.dm-preflight.ts:27` blocks disabled direct DMs, invokes Discord DM command access, and sends pairing replies for pairing-required decisions.
- `extensions/discord/src/monitor/dm-command-auth.ts:58` builds stable and alias sender identities; `extensions/discord/src/monitor/dm-command-auth.ts:93` wires `discord.channelAudience`; `extensions/discord/src/monitor/dm-command-auth.ts:171` resolves direct-message command access.
- `src/channels/message-access/runtime.ts:100` reads the pairing store only when policy permits; `src/channels/message-access/runtime.ts:237` sets default direct/group policies; `src/channels/message-access/runtime.ts:610` produces the effective access decision.
- `src/channels/message-access/sender-gates.ts:37` enforces direct-sender gates for disabled, open, allowlist, and pairing modes.
- `src/plugin-sdk/access-groups.ts:50` resolves access-group states, including missing, unsupported, failed, static `message.senders`, and dynamic resolver matches.
- `extensions/discord/src/send.permissions.ts:180` implements Discord ViewChannel membership checks with false returns for wrong guild and fetch failures.
- `extensions/discord/src/channel.ts:700` wires the Discord pairing adapter, including `discordUserId` labels, entry normalization, and approval notification.
- `src/pairing/pairing-store.ts:47` defines pairing requests and store path; `src/pairing/pairing-store.ts:265` applies account scoping.
- `src/pairing/pairing-challenge.ts:20` issues or reuses pairing challenges and sends replies only for newly created requests.
- `extensions/discord/src/security-audit.ts:50` reads Discord config and pairing allowlists for audit warnings.

### Integration tests

- `extensions/qa-lab/src/live-transports/discord/discord-live.runtime.ts:291` runs live Discord canary and mention-gating scenarios against real Discord message send/poll loops.
- `extensions/qa-lab/src/live-transports/discord/discord-live.runtime.test.ts:108` verifies the live QA Discord config injects account, guild, channel, and driver-user allowlists.
- `scripts/e2e/parallels/macos-discord.ts:27` configures a real Discord token/guild/channel/sender allowlist, probes status, sends outbound, and verifies inbound readback.
- `scripts/e2e/npm-onboard-channel-agent-docker.sh:27` includes Discord in package-onboarding e2e setup, channel add/status/doctor, and local agent-turn flow.
- `scripts/e2e/lib/upgrade-survivor/config-recipe/channels-discord.json:1` preserves Discord token, legacy DM allowlist policy, group policy, and guild/channel tool config across upgrade-survivor coverage.
- `extensions/discord/src/monitor/acp-bind-here.integration.test.ts:133` verifies a Discord DM runtime path can attach to an existing ACP session under open DM policy.

### Unit tests

- `extensions/discord/src/monitor/dm-command-auth.test.ts:113` verifies open DMs are blocked without wildcard or with mismatched allowlists.
- `extensions/discord/src/monitor/dm-command-auth.test.ts:142` verifies pairing-required decisions and pairing-store admission.
- `extensions/discord/src/monitor/dm-command-auth.test.ts:170` verifies `discord.channelAudience` access-group admission.
- `extensions/discord/src/monitor/dm-command-auth.test.ts:235` verifies channel-audience lookup rejection fails closed.
- `extensions/discord/src/monitor/message-handler.preflight.test.ts:530` verifies direct DM preflight behavior and default-account fallback.
- `extensions/discord/src/monitor/monitor.agent-components.test.ts:157` verifies pairing replies for unallowlisted DMs.
- `extensions/discord/src/monitor/monitor.agent-components.test.ts:179` verifies allowlist-mode DM blocking.
- `extensions/discord/src/monitor/monitor.agent-components.test.ts:198` verifies group-DM classification.
- `extensions/discord/src/monitor/monitor.agent-components.test.ts:221` verifies group-DM blocking when not allowlisted even if direct DMs are open.
- `extensions/discord/src/monitor/monitor.agent-components.test.ts:276` verifies DM component interactions from pairing store and open mode.
- `extensions/discord/src/monitor/native-command.plugin-dispatch.test.ts:827` verifies group-DM slash commands are rejected outside configured group channels.
- `extensions/discord/src/config-schema.test.ts:23` verifies `dmPolicy: "open"` rejects configs without `*` and accepts legacy aliases.
- `extensions/discord/src/accounts.test.ts:101` verifies Discord allowFrom precedence across default and named accounts.

### Gitcrawl queries

- `gitcrawl doctor --json`
  - Result: archive healthy for the required snapshot; freshness recorded above.
- `gitcrawl search issues "discord dmPolicy allowFrom" -R openclaw/openclaw --state all --json number,title,url,state`
  - Result: surfaced open direct sender-auth issues including #48641, #53198, #81876, #84447, #86332, and #79043.
- `gitcrawl search issues "Discord DM pairing code" -R openclaw/openclaw --state all --json number,title,url,state`
  - Result: surfaced pairing-related issues, including #86332 identity mismatch and #81876 post-bootstrap pairing exposure.
- `gitcrawl search issues "discord channelAudience accessGroup" -R openclaw/openclaw --state all --json number,title,url,state`
  - Result: no direct issue hits for dynamic Discord channel-audience access groups.
- `gitcrawl search issues "Discord group DM" -R openclaw/openclaw --state all --json number,title,url,state`
  - Result: surfaced adjacent group-DM and group-chat routing issues, including #51805 and #59933.
- `gitcrawl search issues "Discord unauthorized sender allowlist" -R openclaw/openclaw --state all --json number,title,url,state`
  - Result: no direct hits under that query.
- `gitcrawl search issues "Discord allowFrom channelAudience Missing Access" -R openclaw/openclaw --state all --json number,title,url,state`
  - Result: no direct hits under that query.
- `gitcrawl threads openclaw/openclaw --numbers 48641,53198,81876,84447,86332,79043 --include-closed --json`
  - Result: confirmed open issues for silent Discord DM drops, elevated allowFrom fallback confusion, post-bootstrap pairing exposure, inbound DM rate-limit gap, PluralKit pairing identity mismatch, and resolved allowlist users being ignored.

### Discrawl queries

- `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 10 "discord dmPolicy allowFrom"`
  - Result: surfaced channel-ingress refactor discussion covering shared DM policy, pairing stores, allowlists, access-group provenance, and fail-closed states; also surfaced user config/debug history for Discord DM policy and allowlists.
- `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 10 "Discord DM pairing code"`
  - Result: surfaced support guidance for DMing the bot, approving real pairing codes, code expiry, named-account `--account` use, and Discord DM server-member settings.
- `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 10 "discord channelAudience accessGroup"`
  - Result: no direct hits in the snapshot.
- `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 10 "Discord group DM"`
  - Result: surfaced group-originated approval privacy concerns and Discord group-chat versus DM route divergence.
- `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 8 "Discord channel audience ViewChannel"`
  - Result: no direct hits in the snapshot.
- `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 8 "Discord allowFrom silently ignored"`
  - Result: surfaced support history around silently ignored command-only messages and group messages with empty allowlists.
- `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 8 "Discord DMs inbound silently dropped"`
  - Result: surfaced user reports and issue discussion for inbound Discord DMs silently dropped while other paths worked.
- `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 8 "dmPolicy pairing allowFrom accessGroups"`
  - Result: surfaced runtime logs showing resolved Discord `dmPolicy`, `allowFrom`, group policy, and access-groups configuration.
