---
title: "Channel framework - Conversation Routing and Delivery Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Channel framework - Conversation Routing and Delivery Maturity Note

## Summary

Conversation routing and delivery is implemented as a shared framework rather than a per-provider afterthought. Docs and source define deterministic routing, account IDs, agent IDs, session keys, main-DM pinning, group/thread session shapes, binding precedence, broadcast groups, runtime conversation bindings, plugin registry resolution, scoped channel runtime creation, and explicit channel lifecycle controls for starting, stopping, logging out, reloading, and recovering accounts.

The main maturity limit is interaction complexity. Core abstractions are strong, but archive evidence still shows active work around Discord thread binding, parent/child session inheritance, ACP binding persistence, registry cache rebinding, single-account restart behavior, and channel restarts after config or transport faults.

## Category Scope

Included in this category:

- Inbound conversation routing: Inbound and command conversation resolution across sessions, threads, and provider-owned targets.
- Session key construction: Session key construction and session metadata recording
- Agent binding precedence: Agent binding precedence and broadcast group dispatch
- Runtime conversation bindings: Runtime conversation bindings and ACP session binding routes
- Thread/parent-child placement: Thread/parent-child placement and provider-owned target normalization
- Plugin registry resolution: Plugin registry resolution and scoped channel runtime creation
- Channel account startup: Channel account startup, shutdown, logout, abort, and manual-stop state
- Whole-channel lifecycle controls: Whole-channel and per-account lifecycle fanout for start, stop, logout, restart, and runtime snapshots.
- Config/secrets reload interactions: Config/secrets reload interactions with channel plugin reload targets
- Auto-restart: Auto-restart, backoff, crash-loop caps, and runtime snapshot reporting

## Features

- Inbound conversation routing: Inbound and command conversation resolution across sessions, threads, and provider-owned targets.
- Session key construction: Session key construction and session metadata recording
- Agent selection precedence: Agent binding precedence and broadcast group dispatch
- Runtime conversation routing: Runtime conversation bindings and ACP session binding routes
- Thread/parent-child placement: Thread/parent-child placement and provider-owned target normalization
- Plugin registry resolution: Plugin registry resolution and scoped channel runtime creation
- Channel account startup: Channel account startup, shutdown, logout, abort, and manual-stop state
- Whole-channel lifecycle controls: Whole-channel and per-account lifecycle fanout for start, stop, logout, restart, and runtime snapshots.
- Config/secrets reload interactions: Config/secrets reload interactions with channel plugin reload targets
- Auto-restart: Auto-restart, backoff, crash-loop caps, and runtime snapshot reporting

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (77%)`
- Merge rule: arithmetic mean of archived category scores for Routing Session and Agent Binding (`78%`) and Registry Runtime Lifecycle (`76%`), rounded to the nearest whole number.
- Positive signals:
  - Routing docs explicitly define deterministic reply routing, provider-prefix semantics, session-key shapes, main-DM route pinning, guarded inbound recording, binding precedence, broadcast groups, and session storage (`docs/channels/channel-routing.md:9`, `docs/channels/channel-routing.md:26`, `docs/channels/channel-routing.md:32`, `docs/channels/channel-routing.md:57`, `docs/channels/channel-routing.md:79`, `docs/channels/channel-routing.md:92`, `docs/channels/channel-routing.md:133`).
  - Source centralizes conversation resolution, route projection, session recording, configured binding matching, runtime binding routing, thread binding policy, channel runtime resolution, start/stop/logout flows, restart tracking, and runtime snapshots (`src/channels/conversation-resolution.ts:296`, `src/channels/plugins/binding-routing.ts:69`, `src/channels/thread-bindings-policy.ts:50`, `src/gateway/server-channels.ts:222`, `src/gateway/server-methods/channels.ts:236`, `src/gateway/plugin-channel-reload-targets.ts:17`).
  - Unit coverage directly exercises command and inbound resolution, provider-owned target parsing, route projection, runtime bindings, thread spawn policy, auto-restart caps, manual stops, startup concurrency, cancellation, lazy runtime resolution, reload state eviction, and health-monitor overrides (`src/channels/conversation-resolution.test.ts:36`, `src/channels/route-projection.test.ts:15`, `src/channels/plugins/binding-routing.test.ts:62`, `src/channels/thread-bindings-policy.test.ts:11`, `src/gateway/server-channels.test.ts:198`, `src/gateway/server-methods/channels.start.test.ts:67`).
  - Live ACP binding coverage proves at least one Slack-shaped conversation binds and reroutes through the live ACP session path, while Docker channel harnesses and onboarding flows prove representative runtime startup and status behavior (`src/gateway/gateway-acp-bind.live.test.ts:565`, `scripts/e2e/mcp-channels-docker-client.ts:97`, `scripts/e2e/npm-onboard-channel-agent-docker.sh:147`).
- Negative signals:
  - Routing behavior is rich enough that provider pages still carry specialized rules for Discord threads, Matrix threads, Telegram topics, and Slack thread/status targets.
  - Operator docs explain restart/status paths per channel, but the cross-channel lifecycle state machine is less visible than the source implementation.
  - Recent archive results show both routing and lifecycle behavior are still changing, especially around thread inheritance, spawn-child outbound binding, explicit lifecycle controls, and plugin registry rebinding.
- Integration gaps:
  - No single integration suite was found that covers every documented binding precedence level across Discord, Slack, Matrix, Telegram topics, and WebChat together with lifecycle operations.
  - No broad live sweep was found that starts, stops, logs out, and restarts every supported channel account type through the same Gateway RPC contract.
  - Parent-child session binding, ACP routing, and config reload rollback each have targeted tests, but broad live proof remains concentrated in select channels.

## Quality Score

- Score: `Beta (71%)`
- Merge rule: arithmetic mean of archived category scores for Routing Session and Agent Binding (`72%`) and Registry Runtime Lifecycle (`70%`), rounded to the nearest whole number.
- Quality rationale:
  - Deterministic routing is well documented: the model does not pick arbitrary channels, provider prefixes are treated as selection hints only under defined conditions, and core route abstractions let plugins own provider parsing while core owns fallback and binding.
  - Lifecycle implementation has clear state boundaries: startup tasks, stop tasks, manual-stop markers, scoped runtime cleanup, startup trace spans, restart attempts, and reload handling are tracked explicitly in Gateway surfaces.
  - The combined framework is operationally useful but not yet quiet: recent archive results show active fixes for thread inheritance, persistent bindings, restart behavior, lifecycle controls, and registry cache behavior.
- Main quality risks:
  - Many valid route forms exist, so edge cases around thread inheritance, target prefixes, spawn placement, and binding precedence are easy to regress.
  - Lifecycle state is spread across Gateway channel manager internals, Gateway RPC methods, reload handlers, plugin reload target detection, health monitor, and CLI status formatters.
  - Plugin runtime cache and scoped runtime boundaries are subtle enough that reviewers caught rebinding issues after start/stop/restart.
- Quality scoring excludes test quantity; tests are recorded only as coverage evidence.

## Completeness Score

- Score: `Beta (77%)`
- Merge rule: arithmetic mean of archived category scores for Routing Session and Agent Binding (`78%`) and Registry Runtime Lifecycle (`76%`), rounded to the nearest whole number.
- Surface instructions: evaluated against `references/completeness/channel-framework.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Inbound conversation routing, Session key construction, Agent selection precedence, Runtime conversation routing, Thread/parent-child placement, Plugin registry resolution, Channel account startup, Whole-channel lifecycle controls, Config/secrets reload interactions, Auto-restart.
- Negative signals: the archived notes predated process-version-3 Completeness scoring, so this merged score is initialized from the same archived evidence breadth and known-gap record used for the archived Coverage scores, then averaged across the merged categories.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Add an operator-facing route trace that reports which binding tier matched and why.
- Add a cross-provider route fixture for DM, group, channel, thread, topic, parent-thread, runtime binding, ACP binding, and representative lifecycle operations.
- Add a docs table mapping provider target strings to normalized route shape and session key shape.
- Add a lifecycle-oriented operator doc that describes `configured`, `enabled`, `running`, `connected`, `manual stop`, `logged out`, `reload`, and `health restart` state transitions.
- Add one E2E lifecycle sweep that exercises `channels.start`, `channels.stop`, `channels.logout`, config reload, and restart recovery against representative bundled and plugin-backed channels.
- Continue reducing plugin runtime cache coupling during start/stop/reload.

## Evidence

### Docs

- `docs/channels/channel-routing.md:9` through `docs/channels/channel-routing.md:11` state that replies go back to the inbound channel deterministically and the model does not choose the channel.
- `docs/channels/channel-routing.md:14` through `docs/channels/channel-routing.md:24` define Channel, AccountId, AgentId, and SessionKey.
- `docs/channels/channel-routing.md:26` through `docs/channels/channel-routing.md:31` define outbound provider prefix behavior and cross-channel mismatch failure.
- `docs/channels/channel-routing.md:32` through `docs/channels/channel-routing.md:53` define DM, group/channel, and thread session-key shapes.
- `docs/channels/channel-routing.md:57` through `docs/channels/channel-routing.md:73` describe main DM route pinning and guarded inbound session recording.
- `docs/channels/channel-routing.md:79` through `docs/channels/channel-routing.md:90` define binding precedence and multi-field matching.
- `docs/channels/channel-routing.md:92` through `docs/channels/channel-routing.md:108` document broadcast groups as multi-agent routing.
- `docs/channels/groups.md:149` through `docs/channels/groups.md:152` document group, channel, topic, direct-chat, and heartbeat session behavior.
- `docs/channels/discord.md:736` through `docs/channels/discord.md:868` document Discord thread history, thread bindings, focus/unfocus, spawn sessions, and persistent ACP channel bindings.
- `docs/channels/matrix.md:504` through `docs/channels/matrix.md:532` document Matrix native thread behavior and inheritance.
- `docs/channels/troubleshooting.md:16` through `docs/channels/troubleshooting.md:28` define the operator baseline using `openclaw status`, `openclaw gateway status`, `openclaw channels status --probe`, runtime running, and connected probes.
- `docs/channels/troubleshooting.md:36` through `docs/channels/troubleshooting.md:46` document restart and stale plugin/auth recovery flows.
- `docs/channels/discord.md:116` through `docs/channels/discord.md:117` tell managed-service operators to restart after token changes.
- `docs/channels/discord.md:1520`, `docs/channels/discord.md:1595`, and `docs/channels/discord.md:1731` document restart/status checks for Discord intents, READY timeout restarts, and stale command deployment.
- `docs/gateway/configuration-reference.md:622` through `docs/gateway/configuration-reference.md:642` document gateway reload modes, restart/hot/hybrid behavior, and bounded reload deferral.

### Source

- `src/channels/conversation-resolution.ts:36` through `src/channels/conversation-resolution.ts:46` define resolution shapes; `src/channels/conversation-resolution.ts:118` through `src/channels/conversation-resolution.ts:160` normalize targets.
- `src/channels/conversation-resolution.ts:296` through `src/channels/conversation-resolution.ts:401` resolve command conversations; `src/channels/conversation-resolution.ts:403` through `src/channels/conversation-resolution.ts:500` resolve inbound conversations.
- `src/channels/plugins/binding-routing.ts:69` through `src/channels/plugins/binding-routing.ts:111` apply configured binding routes; `src/channels/plugins/binding-routing.ts:113` through `src/channels/plugins/binding-routing.ts:199` handle runtime conversation binding routes and readiness.
- `src/channels/plugins/configured-binding-match.ts:17` through `src/channels/plugins/configured-binding-match.ts:120` implement account match priority, exact matching, and wildcard matching.
- `src/channels/session.ts:32` through `src/channels/session.ts:80` record inbound session metadata and last-route updates.
- `src/channels/route-projection.ts:41` through `src/channels/route-projection.ts:153` normalize routes, project routes from conversations, and compare delivery targets.
- `src/channels/thread-bindings-policy.ts:50` through `src/channels/thread-bindings-policy.ts:257` implement placement, idle/enabled state, spawn policy, and user-facing errors.
- `src/gateway/server-channels.ts:34` through `src/gateway/server-channels.ts:42` define restart backoff/caps and startup concurrency constants.
- `src/gateway/server-channels.ts:222` through `src/gateway/server-channels.ts:231` define the channel manager interface; `src/gateway/server-channels.ts:349` through `src/gateway/server-channels.ts:362` resolve channel runtime lazily and use bundled startup runtime where possible.
- `src/gateway/server-channels.ts:388` through `src/gateway/server-channels.ts:691` start channel accounts with config resolution, enabled/configured checks, scoped runtime, approval bootstrap, account handoff, and auto-restart/backoff.
- `src/gateway/server-channels.ts:697` through `src/gateway/server-channels.ts:778` stop channel accounts with manual-stop state, abort signals, plugin `stopAccount`, timeout handling, and runtime updates.
- `src/gateway/server-channels.ts:780` through `src/gateway/server-channels.ts:814` start all configured channel accounts with bounded fanout; `src/gateway/server-channels.ts:841` through `src/gateway/server-channels.ts:880` expose runtime snapshots.
- `src/gateway/server-methods/channels.ts:204` through `src/gateway/server-methods/channels.ts:260` implement logout/start handoff; `src/gateway/server-methods/channels.ts:262` through `src/gateway/server-methods/channels.ts:283` implement stop.
- `src/gateway/server-methods/channels.ts:542` through `src/gateway/server-methods/channels.ts:699` expose `channels.start`, `channels.stop`, and `channels.logout`.
- `src/gateway/plugin-channel-reload-targets.ts:17` through `src/gateway/plugin-channel-reload-targets.ts:39` resolve changed plugin channel reload targets.
- `src/gateway/server-aux-handlers.ts:95` through `src/gateway/server-aux-handlers.ts:99` serialize reload handling; `src/gateway/server-aux-handlers.ts:165` through `src/gateway/server-aux-handlers.ts:229` handle channel restart after secrets reload and rollback.

### Integration tests

- `src/gateway/gateway-acp-bind.live.test.ts:565` binds a synthetic Slack DM conversation to a live ACP session and reroutes the next turn.
- `scripts/e2e/mcp-channels-docker-client.ts:97`, `scripts/e2e/mcp-channels-docker-client.ts:254`, and `scripts/e2e/mcp-channels-docker-client.ts:311` exercise channel-shaped delivery, conversation routing, and attachment flows through the Docker MCP channel harness.
- `scripts/e2e/npm-onboard-channel-agent-docker.sh:147` through `scripts/e2e/npm-onboard-channel-agent-docker.sh:171` verify package-mode channel setup and status after channel add for Telegram, Discord, and Slack.
- `scripts/e2e/npm-onboard-channel-agent-docker.sh:173` through `scripts/e2e/npm-onboard-channel-agent-docker.sh:201` verify doctor, mocked model configuration, and a channel-driven agent turn after setup.
- `scripts/e2e/bundled-plugin-install-uninstall-docker.sh:33` through `scripts/e2e/bundled-plugin-install-uninstall-docker.sh:47` exercise bundled plugin install/uninstall lifecycle entrypoints.
- No broad live binding-precedence matrix or every-channel lifecycle sweep was found.

### Unit tests

- `src/channels/conversation-resolution.test.ts:36` through `src/channels/conversation-resolution.test.ts:437` cover runtime command resolvers, provider self-parent defaults, prefixed parent/thread fallbacks, Telegram topic shorthand, inbound resolver behavior, Matrix room casing, explicit rejection, and placement from runtime metadata.
- `src/channels/route-projection.test.ts:15` through `src/channels/route-projection.test.ts:164` cover metadata round trips, parent-child projections, fallback generic targets, session binding records, last-route priority, and delivery-target comparison.
- `src/channels/plugins/binding-routing.test.ts:62` through `src/channels/plugins/binding-routing.test.ts:154` cover runtime binding rewrites, plugin-owned bindings, isolated cron sessions, and bounded readiness failures.
- `src/channels/plugins/session-conversation.test.ts:13` through `src/channels/plugins/session-conversation.test.ts:104` cover generic thread parsing, Telegram topic grammar, inactive plugin fallbacks, Feishu parent candidates, and legacy fallback hooks.
- `src/channels/thread-bindings-policy.test.ts:11` through `src/channels/thread-bindings-policy.test.ts:110` cover child-placement channels, thread-here behavior, default spawn policy, `spawnSessions`, and account overrides.
- `src/gateway/server-channels.test.ts:198` through `src/gateway/server-channels.test.ts:431` cover auto-restart caps, clean monitor exit, manual abort, recovery backoff, stop timeout, and descriptor defaults.
- `src/gateway/server-channels.test.ts:462` through `src/gateway/server-channels.test.ts:647` cover runtime passing, late-loaded channels, concurrent starts, mid-boot stops, lazy runtime resolution, bundled startup runtime, non-bundled runtime, disabled accounts, and invalid runtime surfaces.
- `src/gateway/server-channels.test.ts:692` through `src/gateway/server-channels.test.ts:858` cover continuing after startup failure, fallback runtime/loggers, startup trace spans, stop-winning handoff, and startup fanout limits.
- `src/gateway/server-channels.approval-bootstrap.test.ts:105` through `src/gateway/server-channels.approval-bootstrap.test.ts:199` cover shared approval bootstrap lifecycle and failure isolation.
- `src/gateway/server-methods/channels.start.test.ts:67` through `src/gateway/server-methods/channels.start.test.ts:253` cover start, stop, logout, active runtime config, and stopped-runtime reporting.
- `src/gateway/plugin-channel-reload-targets.test.ts:7` through `src/gateway/plugin-channel-reload-targets.test.ts:8` verify changed plugin config maps to owning channel reload targets.

### Gitcrawl queries

Query: `gitcrawl search openclaw/openclaw --query "channel routing session binding agent bindings broadcast" --json --limit 8`

Results:

- Returned PR #79548, "fix(acp): bind-aware persistent dispatcher for spawn-child outbound after parent ends", showing active routing/binding work.

Query: `gitcrawl search openclaw/openclaw --query "Discord thread binding channel parent session" --json --limit 8`

Results:

- Returned issue #64199, PR #64322, issue #53548, PR #81341, issue #87599, PR #82023, PR #81402, and PR #74163, showing a significant archive cluster around Discord thread binding, parent sessions, and routing behavior.

Query: `gitcrawl search openclaw/openclaw --query "channel runtime lifecycle start stop restart" --json --limit 8`

Results:

- Returned PR #75560, "feat(channels): add explicit lifecycle CLI controls", showing active operator-control work.
- Returned PR #71863, "fix(signal): await daemon shutdown on restart", indicating provider lifecycle shutdown correctness work.
- Returned PR #76611 for Matrix crypto-store state persisted timer/restart behavior.
- Returned issue #87457 for a Nostr restart-loop regression.
- Returned PR #78414, "gateway: restart when config enables an unloaded channel plugin".
- Returned issue #87711 about empty assistant delivery, an adjacent delivery/lifecycle symptom after turns.

### Discrawl queries

Query: `/Users/kevinlin/.local/bin/discrawl --json search "Discord thread binding channel parent session" --limit 8`

Results:

- Found implementation discussion for parent binding inheritance and thread-bound subagent spawning.
- Found a live user error around a session binding adapter failure.
- Found review comments and issue references around Discord thread binding and parent/child routing behavior.

Query: `/Users/kevinlin/.local/bin/discrawl --json search "channel runtime lifecycle start stop restart" --limit 8`

Results:

- Found issue #42026 discussion asking for starting, stopping, and restarting a single agent runtime without touching the whole gateway, supporting the need for fine-grained lifecycle controls.
- Found PR #49526 review discussion warning that plugin registry cache rebinding could be lost after start/stop/restart, a lifecycle quality risk around runtime cache boundaries.
