---
title: "Discord - Channel Setup and Operations Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Discord - Channel Setup and Operations Maturity Note

## Summary

Discord bot setup and account configuration are usable for the normal single-bot path and have deep docs, account-aware source, runtime probes, and live QA coverage. The component is not Stable because current archive evidence shows repeated operator confusion and active regressions around plugin enablement, application ID resolution, named-account SecretRefs, and multi-account command registration.

## Normalization

Active category after channel taxonomy normalization.

- Normalized category: `Channel Setup and Operations`
- Merged from: `Setup and Runtime`
- Score carry-forward: conservative minimum of merged source category scores.

## Category Scope

Included in this category:

- Application and bot setup: Covers Application and bot setup across Discord application/bot creation guidance, bot token and `applicationId` configuration, env and SecretRef token resolution, setup wizard/account inspection, and related bot setup and account configuration behavior.
- Token and application ID configuration: Covers Token and application ID configuration across Discord application/bot creation guidance, bot token and `applicationId` configuration, env and SecretRef token resolution, setup wizard/account inspection, and related bot setup and account configuration behavior.
- Setup wizard and account inspection: Covers Setup wizard and account inspection across Discord application/bot creation guidance, bot token and `applicationId` configuration, env and SecretRef token resolution, setup wizard/account inspection, and related bot setup and account configuration behavior.
- Status, doctor, and intent checks: Covers Status, doctor, and intent checks across Discord application/bot creation guidance, bot token and `applicationId` configuration, env and SecretRef token resolution, setup wizard/account inspection, and related bot setup and account configuration behavior.
- Multi-account bot configuration: Covers Multi-account bot configuration across Discord application/bot creation guidance, bot token and `applicationId` configuration, env and SecretRef token resolution, setup wizard/account inspection, and related bot setup and account configuration behavior.
- Account monitor startup: Covers Account monitor startup across Discord gateway monitor startup path, runtime provider lifecycle, WebSocket gateway client, reconnect/heartbeat handling, and related gateway monitor and runtime lifecycle behavior.
- Gateway WebSocket lifecycle: Covers Gateway WebSocket lifecycle across Discord gateway monitor startup path, runtime provider lifecycle, WebSocket gateway client, reconnect/heartbeat handling, and related gateway monitor and runtime lifecycle behavior.
- Reconnect and heartbeat handling: Covers Reconnect and heartbeat handling across Discord gateway monitor startup path, runtime provider lifecycle, WebSocket gateway client, reconnect/heartbeat handling, and related gateway monitor and runtime lifecycle behavior.
- Rate limits and gateway metadata: Covers Rate limits and gateway metadata across Discord gateway monitor startup path, runtime provider lifecycle, WebSocket gateway client, reconnect/heartbeat handling, and related gateway monitor and runtime lifecycle behavior.
- Status, probe, and health-monitor recovery: Covers Status, probe, and health-monitor recovery across Discord gateway monitor startup path, runtime provider lifecycle, WebSocket gateway client, reconnect/heartbeat handling, and related gateway monitor and runtime lifecycle behavior.

## Features

- Application and bot setup: Covers Application and bot setup across Discord application/bot creation guidance, bot token and `applicationId` configuration, env and SecretRef token resolution, setup wizard/account inspection, and related bot setup and account configuration behavior.
- Token and application ID configuration: Covers Token and application ID configuration across Discord application/bot creation guidance, bot token and `applicationId` configuration, env and SecretRef token resolution, setup wizard/account inspection, and related bot setup and account configuration behavior.
- Setup wizard and account inspection: Covers Setup wizard and account inspection across Discord application/bot creation guidance, bot token and `applicationId` configuration, env and SecretRef token resolution, setup wizard/account inspection, and related bot setup and account configuration behavior.
- Status, doctor, and intent checks: Covers Status, doctor, and intent checks across Discord application/bot creation guidance, bot token and `applicationId` configuration, env and SecretRef token resolution, setup wizard/account inspection, and related bot setup and account configuration behavior.
- Multi-account bot configuration: Covers Multi-account bot configuration across Discord application/bot creation guidance, bot token and `applicationId` configuration, env and SecretRef token resolution, setup wizard/account inspection, and related bot setup and account configuration behavior.
- Account monitor startup: Covers Account monitor startup across Discord gateway monitor startup path, runtime provider lifecycle, WebSocket gateway client, reconnect/heartbeat handling, and related gateway monitor and runtime lifecycle behavior.
- Gateway WebSocket lifecycle: Covers Gateway WebSocket lifecycle across Discord gateway monitor startup path, runtime provider lifecycle, WebSocket gateway client, reconnect/heartbeat handling, and related gateway monitor and runtime lifecycle behavior.
- Reconnect and heartbeat handling: Covers Reconnect and heartbeat handling across Discord gateway monitor startup path, runtime provider lifecycle, WebSocket gateway client, reconnect/heartbeat handling, and related gateway monitor and runtime lifecycle behavior.
- Rate limits and gateway metadata: Covers Rate limits and gateway metadata across Discord gateway monitor startup path, runtime provider lifecycle, WebSocket gateway client, reconnect/heartbeat handling, and related gateway monitor and runtime lifecycle behavior.
- Status, probe, and health-monitor recovery: Covers Status, probe, and health-monitor recovery across Discord gateway monitor startup path, runtime provider lifecycle, WebSocket gateway client, reconnect/heartbeat handling, and related gateway monitor and runtime lifecycle behavior.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (74%)`
- Positive signals: Real Discord live lanes exist. The QA live transport requires real guild/channel IDs, driver and SUT bot tokens, and a SUT application ID, injects `plugins.entries.discord.enabled`, `channels.discord.enabled`, a named account token, `defaultAccount`, guild/channel allowlists, then starts a gateway and waits for the Discord channel account to run before exercising canary, mention gating, and native command registration. A separate live smoke verifies a real bot token against Discord REST and gateway metadata.
- Negative signals: The live lanes cover a curated QA config, not the full human setup path from Developer Portal through `openclaw config patch`, `openclaw channels add`, setup wizard prompts, service env propagation, and `openclaw doctor --fix`. There is no broad live proof in the evidence for multi-account slash command parity, named-account SecretRef send/lookup parity, or the silent plugin-entry disabled case.
- Integration gaps: Add a live setup scenario that starts from a minimal documented config, verifies plugin enablement behavior, checks `applicationId` fallback and configured `applicationId`, runs named-account env SecretRef send and lookup actions, and asserts `channels status --probe` surfaces missing intents and permissions in operator-facing language.

## Quality Score

- Score: `Beta (71%)`
- Gitcrawl reports: Current open reports include #83212 for a Discord channel staying disabled with no warning unless `plugins.entries.discord.enabled` is set, #77359 for missing slash commands on non-default Discord accounts despite valid per-account `applicationId`, #87656 and #84530 for named-account env SecretRef resolution mismatches across provider startup, sends, and lookup/admin actions, #77429 for confusing multi-account startup order, #53198 for a documented elevated allowlist fallback not working for Discord, and #79043 for allowlisted users being silently ignored while the bot owner is implicitly injected.
- Discrawl reports: Discord archive discussion repeats the same operator pain: bot setup threads mention stuck typing, failed application ID resolution, token reset/reconfiguration loops, the need to manually set `plugins.entries.discord.enabled true`, repeated Message Content/Server Members intent checklists, and "awaiting gateway readiness" reports despite visible bot presence and enabled intents. SecretRef-specific Discord discussion had no direct hits in the queried Discord archive, so the SecretRef quality signal comes from gitcrawl.
- Good qualities: The public docs give a detailed setup flow for bot creation, privileged intents, OAuth invite scopes, developer-mode IDs, secure token config, service env propagation, pairing, multi-bot accounts, application IDs, token precedence, duplicate-token handling, DM policy, guild policy, troubleshooting, and config reference. Source has account-aware setup state, token precedence and SecretRef inspection, runtime config snapshot selection, duplicate token owner filtering, application ID parsing before REST fallback, privileged-intent probing, permission audit status issues, numeric ID doctor repair, and startup phase logging.
- Bad qualities: Docs/source alignment is still brittle around plugin activation because the quick setup shows `channels.discord.enabled` and token config while archive evidence shows operators can still need `plugins.entries.discord.enabled`. Named-account token behavior is inconsistent across runtime surfaces. Multi-account behavior is implemented but still has visible product gaps around command registration and startup ordering. Some failure modes are silent or too indirect for operators, especially disabled plugin state, unresolved account tokens in action paths, allowlist drops, and gateway readiness stalls.
- Excluded from quality: Unit, integration, e2e, live test presence/depth and absent tests were not used to raise or lower this Quality score.

## Completeness Score

- Score: `Beta (74%)`
- Surface instructions: evaluated against `references/completeness/discord.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Application and bot setup, Token and application ID configuration, Setup wizard and account inspection, Status, doctor, and intent checks, Multi-account bot configuration, Account monitor startup, Gateway WebSocket lifecycle, Reconnect and heartbeat handling, Rate limits and gateway metadata, Status, probe, and health-monitor recovery.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Make the documented quick setup and actual plugin activation contract impossible to drift: either implicit-enable the Discord plugin from `channels.discord.enabled` or document and validate `plugins.entries.discord.enabled` in the same flow.
- Normalize named-account env SecretRef resolution so provider startup, visible sends, lookup/admin message actions, and status probes all consume the same runtime-resolved account state.
- Add explicit startup/status warnings for disabled plugin registry entries, unresolved SecretRefs, missing or limited privileged intents, unregistered native commands on secondary accounts, and allowlist drops.
- Prioritize the configured `channels.discord.defaultAccount` during multi-account startup, or make ordering explicit in status output.
- Improve setup UX for application ID failures: current source can parse IDs from tokens or fetch them, but archive evidence shows users still hit opaque "Failed to resolve Discord application id" loops.

## Evidence

### Docs

- `docs/channels/discord.md`: "Quick setup" walks through creating a Discord application and bot, enabling Message Content/Server Members/Presence intents, copying the bot token, OAuth invite scopes/permissions, Developer Mode IDs, DM privacy, secure env SecretRef token setup, `applicationId` fallback guidance, CLI/config setup, pairing approval, multi-bot `accounts`, token precedence, duplicate-token handling, DM/guild access policies, troubleshooting, and config reference.
- `docs/plugins/reference/discord.md`: plugin reference identifies `@openclaw/discord`, npm/ClawHub distribution, channel surface `discord`, and related docs.
- `docs/install/fly.md` and `docs/start/setup.md`: deployment/setup docs mention `DISCORD_BOT_TOKEN` as a channel credential and explain env-backed token placement in hosted or development setups.
- `docs/tools/slash-commands.md`: documents Discord native command registration defaults and the impact of `commands.native=false`.

### Source

- `extensions/discord/openclaw.plugin.json`: declares plugin id/name/description, `channels: ["discord"]`, and `channelEnvVars.discord: ["DISCORD_BOT_TOKEN"]`.
- `extensions/discord/src/setup-core.ts` and `extensions/discord/src/setup-surface.ts`: define the Discord setup wizard, token credential prompts, preferred `DISCORD_BOT_TOKEN` env var, account-scoped DM policy, group allowlist, allow-from prompts, and live user/channel allowlist resolution when a token is available.
- `extensions/discord/src/setup-account-state.ts`, `extensions/discord/src/account-inspect.ts`, `extensions/discord/src/token.ts`, and `extensions/discord/src/accounts.ts`: implement account enumeration, `defaultAccount` resolution, root/account token precedence, env fallback for default only, SecretRef inspection, runtime snapshot selection, merged account config, duplicate-token owner filtering, and disabled-reason reporting.
- `extensions/discord/src/probe.ts`: probes Discord REST, summarizes privileged intents from application flags, derives application IDs from bot tokens before REST lookup, and fetches application IDs with rate-limit handling.
- `extensions/discord/src/channel.ts` and `extensions/discord/src/monitor/provider.ts`: wire status probes, permission audits, account snapshots, SecretRef fail-fast behavior before provider startup, startup staggering, Discord provider startup, group-policy fallback warning, application ID resolution, command registration, and lifecycle status.
- `extensions/discord/src/status-issues.ts`, `extensions/discord/src/doctor.ts`, and `extensions/discord/src/security-doctor.ts`: surface missing Message Content Intent, permission audit failures, unresolved channel IDs, numeric ID repair, missing env token warnings, and mutable allowlist entry warnings.
- `src/plugin-sdk/discord.ts`: compatibility facade exports Discord setup/status/account helpers and runtime methods used by bundled Discord wiring.

### Integration tests

- `extensions/qa-lab/src/live-transports/discord/discord-live.runtime.ts`: live QA runtime requires real Discord guild/channel IDs, driver bot token, SUT bot token, and SUT application ID; builds a gateway config with `plugins.entries.discord.enabled`, `channels.discord.enabled`, `defaultAccount`, named account token, guild/channel allowlists, then starts a live gateway, waits for the Discord channel account to run, checks SUT identity, and exercises Discord canary, mention-gating, native help command registration, plus optional voice/status/thread scenarios.
- `extensions/qa-lab/src/live-transports/discord/discord-live.runtime.test.ts`: validates the live Discord QA environment contract, credential payload parsing, snowflake validation, and injected Discord account config shape used by the live runtime.
- `extensions/discord/src/internal/live-smoke.live.test.ts`: gated live smoke uses `DISCORD_BOT_TOKEN` and `DISCORD_LIVE_TEST` to call Discord REST for bot identity and gateway metadata, and checks the token-derived application ID matches the bot user.

### Unit tests

- `extensions/discord/src/setup-surface.test.ts`: covers named-account DM policy, account-scoped config keys, open-policy writes, setup configured-state defaultAccount selection, and guild/channel allowlist writes.
- `extensions/discord/src/setup-account-state.test.ts`: covers normalized setup account IDs, account config resolution, configured default account, explicit blank account tokens, and unresolved SecretRef account token state.
- `extensions/discord/src/token.test.ts`: covers config-over-env precedence, env fallback, account token precedence, explicit blank account tokens preventing fallback, runtime snapshot SecretRef resolution, and configured-unavailable SecretRefs.
- `extensions/discord/src/accounts.test.ts`: covers defaultAccount omission behavior, allowFrom precedence, account config merge precedence, duplicate-token filtering, runtime config selection, and configured-unavailable token preservation.
- `extensions/discord/src/config-schema.test.ts`: covers secure defaults such as `dmPolicy="open"` requiring `allowFrom: ["*"]`, groupPolicy defaulting to allowlist, application ID acceptance/rejection, numeric ID coercion/rejection, and account-scoped config fields.
- `extensions/discord/src/probe.intents.test.ts` and `extensions/discord/src/probe.parse-token.test.ts`: cover privileged-intent flag interpretation, application ID derivation from tokens, large snowflake preservation, and Cloudflare rate-limit handling during application ID lookup.
- `extensions/discord/src/channel.test.ts`, `extensions/discord/src/monitor/provider.test.ts`, `extensions/discord/src/monitor/provider.startup.test.ts`, `extensions/discord/src/monitor/provider.lifecycle.test.ts`, `extensions/discord/src/monitor/gateway-plugin.test.ts`, `extensions/discord/src/monitor/gateway-supervisor.test.ts`, and `extensions/discord/src/monitor/startup-status.test.ts`: cover startup probes, unresolved SecretRef fail-fast behavior, startup phase logging, app ID resolution preference, gateway lifecycle/reconnect/error classification, event queue config, voice-intent gating, and status wording.
- `extensions/discord/src/doctor.test.ts` and `extensions/discord/src/security-doctor.test.ts`: cover config migration/repair, numeric ID warnings and repair, missing env token warnings, and mutable allowlist entry detection.
- `src/plugin-sdk/discord.test.ts`: covers the deprecated Discord SDK facade exports and runtime forwarding used by bundled plugin wiring.

### Gitcrawl queries

Query:

`gitcrawl search issues discord --repo openclaw/openclaw --limit 5 --json number,title,state,updatedAt,url`

Results:

- Returned open setup/account-relevant issues #53198, #83212, #87656, and #77429 among the top Discord hits. #81107 was about a Discord skill-command CPU loop and was treated as adjacent runtime quality evidence, not setup/account configuration evidence.

Query:

`gitcrawl search issues "Discord setup bot token applicationId" --repo openclaw/openclaw --limit 10 --json number,title,state,updatedAt,url`

Results:

- Returned #77359, an open multi-bot report where a secondary Discord account had a valid token, per-account `applicationId`, and working chat, but no slash commands registered and no visible startup errors.

Query:

`gitcrawl search issues "Discord plugins.entries enabled setup disabled warning" --repo openclaw/openclaw --limit 10 --json number,title,state,updatedAt,url`

Results:

- Returned #83212, an open report that `channels.discord.enabled: true` with a valid token can still leave Discord "installed, not configured, disabled" without logs unless `plugins.entries.discord.enabled` is also set. One unrelated Docker restart-loop issue was ignored.

Query:

`gitcrawl search issues "Discord multi-account token default account applicationId" --repo openclaw/openclaw --limit 10 --json number,title,state,updatedAt,url`

Results:

- Returned #77359 again, confirming the multi-account `applicationId`/command-registration problem is the primary current issue for that query. `gitcrawl gh issue view 77429` was also read because the broader Discord query surfaced a related default-account startup-order issue.

Query:

`gitcrawl search issues "Discord SecretRef named account token" --repo openclaw/openclaw --limit 10 --json number,title,state,updatedAt,url`

Results:

- Returned #87656 and #84530. Both are open named-account SecretRef reports: one says provider startup succeeds while message-tool send fails, and the other says lookup/admin `channel-info` fails while inbound/send behavior works in the same runtime.

Query:

`gitcrawl search issues "Discord Message Content Intent privileged intents setup" --repo openclaw/openclaw --limit 10 --json number,title,state,updatedAt,url`

Results:

- Returned #79043, an open report where Message Content and Server Members intents were enabled but an allowlisted user was silently ignored and bot-owner implicit allowlisting confused runtime diagnosis.

Additional issue detail read:

- `gitcrawl gh issue view 83212`, `77359`, `87656`, `84530`, `77429`, `53198`, and `79043` were read for summaries, steps, expected/actual behavior, environments, and operator impact.

### Discrawl queries

Query:

`discrawl search "Discord bot token setup applicationId" --limit 10`

Results:

- Returned a March setup thread where the bot was online but stuck typing, logs showed "Failed to resolve Discord application id", adding `applicationId` caused an unrecognized-key error before doctor repair, a token reset was attempted, and the symptom persisted after update. Also returned an older application-ID setup checklist emphasizing bot invite permissions, Server Members Intent, Message Content Intent, config, and gateway restart.

Query:

`discrawl search "plugins.entries.discord.enabled" --limit 10`

Results:

- Returned multiple operator/help messages where Discord did not come online or stayed disabled until users manually set `plugins.entries.discord.enabled: true`, including one explicit command recommendation and configs showing `plugins.entries.discord.enabled` toggled false/true. This corroborates #83212's plugin activation confusion.

Query:

`discrawl search "Discord multi account applicationId" --limit 10`

Results:

- Returned an OpenClaw PR review/comment about multi-account channel claim ownership using the wrong bot key in shared guild/channel setups. No broad user setup thread was returned for this exact query, so the main multi-account setup/account signal remains gitcrawl #77359 and #77429.

Query:

`discrawl search "Discord SecretRef named account token" --limit 10`

Results:

- Returned no direct Discord archive hits. This is neutral after successful freshness checks; gitcrawl supplied the concrete SecretRef regression evidence.

Query:

`discrawl search "Discord Message Content Intent setup" --limit 10`

Results:

- Returned several setup/help threads repeating the Message Content Intent and Server Members Intent requirements, `intents:content=limited` explanations, a stuck "awaiting gateway readiness" report despite all three privileged intents being enabled, and an OpenClaw issue/comment about guided setup saying Discord was not enabled and skipping token input.
