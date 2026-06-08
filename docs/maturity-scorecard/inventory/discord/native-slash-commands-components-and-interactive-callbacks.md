---
title: "Discord - Native Controls and Approvals Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Discord - Native Controls and Approvals Maturity Note

## Summary

Discord native slash commands, the `/model` picker, Components v2 messages, button/select/modal callbacks, TTL-backed callback registries, and callback authorization are implemented and documented in the OpenClaw Discord extension.

Coverage scores Stable because runtime-flow and integration-style tests exercise native command dispatch, authz, routing, ACP bindings, model picker submit/apply behavior, component send/edit registration, and callback consumption. The main gap is live Discord e2e evidence: the located live smoke only proves bot identity/runtime metadata, not end-to-end slash command registration, real picker interaction, or real component callback execution against Discord.

Quality scores Beta because the source shape is layered and defensive, but current archive evidence still shows active Discord-specific friction around slash command deployment, multi-account registration, plugin command acknowledgement timing, large picker limits, component schema exposure, missing callback metadata, and Discord interaction timing.

## Normalization

Active category after channel taxonomy normalization.

- Normalized category: `Native Controls and Approvals`
- Merged from: `Native Commands and Components`, `Approvals and Sensitive Actions`
- Score carry-forward: conservative minimum of merged source category scores.

## Category Scope

Included in this category:

- Native slash command registration: Native slash command registration and reconciliation for Discord application commands
- Native slash command execution: Native slash command execution, autocomplete, authz, and interaction dispatch
- Model Picker Commands: Covers Model Picker Commands across Native slash command registration and reconciliation for Discord application commands. Native slash command execution, autocomplete, authz, and interaction dispatch. `/model` and `/models` picker flows, and related native slash commands, components, and interactive callbacks behavior.
- Components v2 messages: Components v2 messages, buttons, string/user/role/mentionable/channel selects, modal triggers, and modal submits
- Callback TTL: Callback TTL, reusable versus single-use callbacks, persistent callback registry entries, allowedUsers, guild/DM/group authz, and plugin interactive callback dispatch
- Native Discord exec/plugin approvals: Native Discord exec/plugin approvals, including approver resolution, dm/channel/both target routing, approval button authorization, stale/expired click handling, gateway resolution, and route-notice/privacy behavior
- Sensitive owner-only command routing for prompts: Sensitive owner-only command routing for prompts and final results, especially /diagnostics and /export-trajectory
- Discord message actions: Discord message actions for messages, reactions, pins, reads/search, permissions, channel/guild administration, role changes, moderation, scheduled events, voice status, and presence
- Action gates under channels.discord.actions._: Action gates under channels.discord.actions._, per-account overrides, requester trust, senderUserId-based Discord permission checks, role hierarchy checks, and read target allowlisting

## Features

- Native slash command registration: Native slash command registration and reconciliation for Discord application commands
- Native slash command execution: Native slash command execution, autocomplete, authz, and interaction dispatch
- Model Picker Commands: Covers Model Picker Commands across Native slash command registration and reconciliation for Discord application commands. Native slash command execution, autocomplete, authz, and interaction dispatch. `/model` and `/models` picker flows, and related native slash commands, components, and interactive callbacks behavior.
- Components v2 messages: Components v2 messages, buttons, string/user/role/mentionable/channel selects, modal triggers, and modal submits
- Callback TTL: Callback TTL, reusable versus single-use callbacks, persistent callback registry entries, allowedUsers, guild/DM/group authz, and plugin interactive callback dispatch

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Stable (82%)`
- Coverage basis: integration, e2e, live, and runtime-flow evidence only.
- Positive signals: native command dispatch and authz are exercised through focused runtime-flow tests for guild, DM, channel access, owner restrictions, ACP bindings, fallback routed sessions, plugin-owned native commands, autocomplete, expired interaction handling, and command reply delivery.
- Positive signals: `/model` picker behavior is exercised through runtime-flow tests covering picker display, deferred apply until submit, runtime persistence, timeout handling, recents, state verification against bound thread sessions, and stale-session override persistence.
- Positive signals: components and callbacks have runtime-flow coverage for Components v2 send/edit registration, TTL propagation, modal registration, component callback consumption, persistent entries, single-use sibling invalidation, and v2 follow-up/edit interaction APIs.
- Positive signals: dispatch-layer tests cover application command defer behavior, autocomplete handling, subcommand defer-before-run behavior, and Components v2 follow-up/edit `with_components` handling.
- Coverage gaps: no located live Discord e2e test invokes a real registered slash command, opens and submits the `/model` picker in a real guild/DM, clicks a real v2 button/select, submits a real modal, or verifies callback TTL/authz against the Discord API.
- Coverage gaps: the located live Discord smoke validates bot identity and runtime metadata only; the QA live Discord runtime canary is transport-level and does not prove this component's slash/component callback flows.
- Coverage gaps: no located live flow proves slash command registration/reconciliation across default and non-default Discord applications, including changed-only deploy, disabled deploy, or global/guild command cleanup behavior.

## Quality Score

- Score: `Beta (76%)`
- Quality basis: source architecture, documented behavior, runtime contracts, and current operational/archive issue evidence. Test coverage and lack of tests are not used as quality inputs.
- Good qualities: the implementation separates command definition, command deployment, interaction dispatch, native command context construction, authz, model picker state/view/apply, component builders, registry persistence, send/edit plumbing, and plugin interactive callbacks.
- Good qualities: slash commands are serialized with descriptions, localizations, options, integration types, contexts, and default member permissions, then reconciled through guild/devGuild/global deploy paths with persisted command hashes.
- Good qualities: native command execution constructs explicit command target session context, supports autocomplete auth, preserves route/session metadata, gates access through `commands.allowFrom`, owner/member policy, DM pairing, and group DM checks, and handles expired interactions before dispatch.
- Good qualities: the `/model` picker is deliberately stateful and bounded by Discord platform limits: compressed custom IDs, row/button/select option caps, provider/model paging, owner-only interaction checks, pending choices, and a hidden `/model` apply path with timeout and verification.
- Good qualities: component callbacks use structured custom IDs, TTL defaults, persistent registries, reusable/single-use consumption semantics, `allowedUsers`, guild/DM/group auth checks, modal-submit handling, and plugin callback context helpers for ack/reply/follow-up/edit/clear-components.
- Bad qualities: gitcrawl shows slash command deployment remains operationally noisy: restarts can redeploy commands and hit Discord rate limits, changed-only/disabled deploy mode is still tracked, and non-default Discord account registration is still an open issue.
- Bad qualities: gitcrawl and discrawl show interaction timing remains a recurring Discord failure mode, especially plugin slash commands missing the Discord 3-second acknowledgement window and historical `Unknown interaction` incidents under slow listener or network conditions.
- Bad qualities: gitcrawl shows the model picker still has hard UX pressure from Discord's 25-option, 5-row, and 100-character custom ID limits; discrawl confirms recent performance and pagination work was still active in late May 2026.
- Bad qualities: gitcrawl shows component quality issues remain active or recently active around native component exposure, message schema overexposure, undefined registry fields, callback metadata, and component/modal payload behavior.
- Bad qualities: the source handles many edge cases, but the interaction surface is broad and Discord-specific: slash registration, plugin command dispatch, picker state, callbacks, modal submits, TTL expiry, and authz each have separate failure modes that operators still encounter.
- Excluded from quality: unit test depth, integration test depth, live test depth, runtime-flow test depth, and absence of specific tests.

## Completeness Score

- Score: `Stable (82%)`
- Surface instructions: evaluated against `references/completeness/discord.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Native slash command registration, Native slash command execution, Model Picker Commands, Components v2 messages, Callback TTL.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Add live Discord e2e coverage for command registration, command invocation, picker submit, component callback, modal submit, unauthorized callback denial, TTL expiry, and process-restart callback persistence.
- Resolve or close the current slash deploy/registration issues covering changed-only or disabled deploy mode, deploy cache scoping, non-default account registration, and command redeploy rate limits.
- Close the plugin slash acknowledgement gap so plugin-owned native commands reliably acknowledge within Discord's 3-second interaction window.
- Continue hardening large model picker configs around Discord option, row, and custom ID limits, including operator-visible behavior when provider/model lists exceed the picker budget.
- Tighten component schema exposure and callback metadata so generated component payloads stay explicit and callback handlers receive enough context without overexposing Discord-specific internals.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/channels/discord.md:313` documents native slash commands as isolated command sessions keyed with `CommandTargetSessionKey`.
- `/Users/kevinlin/code/openclaw/docs/channels/discord.md:341` to `357` documents interactive Components v2 containers, action row limits, select types, single-use versus reusable controls, `allowedUsers`, default TTL of 30 minutes, maximum TTL of 24 hours, and owner-only ephemeral `/model` picker behavior.
- `/Users/kevinlin/code/openclaw/docs/channels/discord.md:367` to `369` documents modal forms, supported field types, and the trigger button.
- `/Users/kevinlin/code/openclaw/docs/channels/discord.md:625` to `638` documents native command enablement, `commands.native=false`, shared Discord auth policies, unauthorized responses, and default ephemeral command responses.
- `/Users/kevinlin/code/openclaw/docs/channels/discord.md:1078` to `1105` documents approval buttons, DM/channel/both target delivery, approver-only interaction, fallback `/approve`, plugin versus exec approval resolution, and 30-minute expiry.
- `/Users/kevinlin/code/openclaw/docs/channels/discord.md:1135` to `1142` documents Components v2 UI configuration, `ui.components.accentColor`, `agentComponents.ttlMs`, and embed behavior with v2 components.
- `/Users/kevinlin/code/openclaw/docs/tools/slash-commands.md:64` to `72` documents `commands.native`, native skills, and Discord native command specs including description localizations.
- `/Users/kevinlin/code/openclaw/docs/tools/slash-commands.md:114` to `121` documents command sources: core built-ins, dock commands, and plugin `registerCommand`.
- `/Users/kevinlin/code/openclaw/docs/tools/slash-commands.md:145` to `147` documents `/model` and `/models`.
- `/Users/kevinlin/code/openclaw/docs/tools/slash-commands.md:164` to `168` documents `/approve`.

### Source

- `/Users/kevinlin/code/openclaw/extensions/discord/src/internal/commands.ts:38` to `47` defers command interactions with ephemeral support.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/internal/commands.ts:83` to `96` handles focused autocomplete options.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/internal/commands.ts:98` to `134` serializes native application command metadata, localizations, options, integration types, contexts, and permissions.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/internal/commands.ts:160` to `188` dispatches subcommands and defers before subcommand execution.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/internal/command-deploy.ts:41` to `99` deploys guild, dev guild, and global commands.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/internal/command-deploy.ts:101` to `138` reconciles create/edit/delete command actions with persisted hashes.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/internal/client.ts:273` to `287` wires command list/deploy/reconcile and interaction dispatch into the Discord client.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/internal/interaction-dispatch.ts:43` to `115` dispatches autocomplete, application command, message component, and modal submit interactions.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/internal/interactions.ts:153` to `247` wraps callback, reply, defer, edit, and follow-up interactions including Components v2 queries.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/monitor/provider.interactions.ts:33` to `70` builds native commands from command specs.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/monitor/provider.interactions.ts:105` to `157` registers fallback component handlers, exec approval controls, agent component controls, and modal callbacks.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/monitor/native-command.ts:89` to `197` creates Discord native commands, parses options, defers, and dispatches command execution.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/monitor/native-command.ts:244` to `475` resolves sender/channel context and enforces allowlists, group/DM auth, owner checks, and command authorizers.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/monitor/native-command.ts:477` to `600` executes plugin-owned native commands directly.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/monitor/native-command.ts:603` to `619` opens the `/model` and `/models` picker when the command has no args.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/monitor/native-command.ts:621` to `714` resolves native command session targets, builds route state, and dispatches agent replies.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/monitor/native-command-context.ts:41` to `108` builds native command context including command target session, `From`, `To`, group metadata, `CommandTurn.kind="native"`, and originating target.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/monitor/native-command-auth.ts:23` to `64` implements `commands.allowFrom`.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/monitor/native-command-auth.ts:96` to `156` implements guild command auth through group policy, owner, and member authorizers.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/monitor/native-command-auth.ts:158` to `260` implements group DM and autocomplete authorization.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/monitor/native-command-agent-reply.ts:31` to `124` delivers native command replies and model-selection responses back to Discord.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/monitor/native-command-model-picker-ui.ts:64` to `81` detects picker-open command forms.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/monitor/native-command-model-picker-ui.ts:179` to `340` resolves picker context, current route/model, recents, provider page, and initial reply.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/monitor/native-command-model-picker-interaction.ts:265` to `333` parses picker interactions, verifies owner-only access, acknowledges, resolves route/data/current state, and updates the picker.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/monitor/native-command-model-picker-interaction.ts:473` to `657` handles provider, model, runtime, submit, reset, and quick-selection interactions.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/monitor/native-command-model-picker-apply.ts:76` to `183` dispatches the hidden `/model` apply command, verifies persisted overrides/runtime, and records recents.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/monitor/model-picker.state.ts:6` to `15` defines Discord custom ID, row, button, and option limits.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/monitor/model-picker.state.ts:216` to `360` constructs, bounds, parses, and validates picker custom IDs.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/monitor/model-picker.view.ts:121` to `203` builds picker buttons and compressed selects under Discord option/custom ID limits.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/monitor/model-picker.view.ts:319` to `349` renders provider select rows.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/component-custom-id.ts:3` to `72` defines component/modal custom ID keys, parsing, and wildcard registry mapping.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/components.builders.ts:48` to `207` builds button and select components with callback data, reusable flags, and `allowedUsers`.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/components.builders.ts:226` to `410` builds component messages, action rows, modals, and v2 containers.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/components-registry.ts:6` defines the default callback TTL as 30 minutes.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/components-registry.ts:124` to `157` creates persistent keyed stores with TTL and size limits.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/components-registry.ts:165` to `397` implements expiry, single-use consumption, registration, component resolution, and modal resolution.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/send.components.ts:171` to `191` registers built Discord component messages with configured TTL.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/send.components.ts:264` to `388` sends and edits component messages while registering or refreshing registry entries.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/monitor/agent-components.ts:54` to `69` registers agent component controls, Discord component controls, and modal handlers.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/monitor/agent-components-guild-auth.ts:124` to `322` enforces `allowedUsers`, guild auth, and component command authorization.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/monitor/agent-components-dm-auth.ts:22` to `135` enforces DM and group DM component auth.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/monitor/agent-components.handlers.ts:27` to `298` handles expired components, authz, single-use consumption, plugin callback dispatch, synthesized agent events, modal trigger auth, and modal display.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/monitor/agent-components.modal.ts:29` to `159` handles missing/expired modal submits, authz, allowed users, consumption, plugin dispatch, and agent dispatch.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/monitor/agent-components.plugin-interactive.ts:24` to `172` defines plugin interactive input and reply/follow-up/edit helpers.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/monitor/agent-components.dispatch.ts:89` to `358` builds component callback context and dispatches click/form events to the agent and Discord reply path.

### Integration tests

- `/Users/kevinlin/code/openclaw/extensions/discord/src/monitor/acp-bind-here.integration.test.ts:133` to `139` verifies a Discord ACP bind-here flow routes the next Discord DM turn to the existing ACP binding.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/monitor/native-command.plugin-dispatch.test.ts:463` to `487` verifies registry-backed native Discord plugin commands and aliases through the native command path.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/monitor/native-command.plugin-dispatch.test.ts:524` to `535` verifies configured binding agents for plugin-owned Discord command sessions.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/monitor/native-command.plugin-dispatch.test.ts:1122` to `1142` verifies native slash routing through configured ACP Discord channel bindings.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/monitor/native-command.plugin-dispatch.test.ts:1144` to `1224` verifies fallback to routed slash/channel session keys when no bound session exists.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/monitor/native-command.plugin-dispatch.test.ts:1226` to `1275` verifies DM native slash ACP bindings and that `/new` does not bypass ACP readiness.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/monitor/native-command.plugin-dispatch.test.ts:1277` to `1292` verifies recovery commands still run through ACP bindings when ensure fails.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/monitor/native-command.commands-allowfrom.test.ts:138` to `143` verifies guild slash auth through `commands.allowFrom`.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/monitor/native-command.commands-allowfrom.test.ts:263` to `370` verifies channel restrictions, member exclusion, owner restrictions, and allowlist rejection.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/monitor/native-command.commands-allowfrom.test.ts:509` to `532` verifies expired slash interactions are swallowed before dispatch when defer returns `Unknown interaction`.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/monitor/native-command.model-picker.test.ts:357` to `387` verifies model selection does not dispatch until submit.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/monitor/native-command.model-picker.test.ts:414` to `430` verifies runtime persistence outside the hidden `/model` pipeline.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/monitor/native-command.model-picker.test.ts:612` to `645` verifies timeout status and recents behavior.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/monitor/native-command.model-picker.test.ts:681` to `853` verifies recents, state verification against bound thread sessions, and stale-session override persistence.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/internal/interaction-dispatch.test.ts:15` to `125` verifies command defer behavior, autocomplete handling, and subcommand defer-before-run dispatch.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/internal/interactions.test.ts:50` to `82` verifies Components v2 follow-up and edit calls use `with_components`.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/send.components.test.ts:103` to `173` verifies component send registration and TTL handling.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/send.components.test.ts:220` to `257` verifies modal trigger registration.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/send.components.test.ts:302` to `343` verifies component edit refresh behavior.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/internal/live-smoke.live.test.ts:12` verifies live bot identity/metadata only; it is live evidence for the Discord transport, but not this component's slash/component callback flows.
- `/Users/kevinlin/code/openclaw/extensions/qa-lab/src/live-transports/discord/discord-live.runtime.test.ts:9` and `473` to `476` define the Discord live runtime canary scenarios; the located scenarios are transport-level rather than native slash/component callback flows.

### Unit tests

- `/Users/kevinlin/code/openclaw/extensions/discord/src/components.test.ts:28` to `60` verifies v2 containers with modal triggers and `allowedUsers`.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/components.test.ts:98` to `116` verifies modal select options and attachment reference validation.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/components.test.ts:131` to `191` verifies component registry and single-use sibling consumption.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/components.test.ts:218` to `304` verifies persistent component and modal entries.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/components.test.ts:308` to `355` verifies sibling persistent entry deletion when a group is consumed.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/components.test.ts:355` to `380` verifies fallback to in-memory registry when persistent state cannot open.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/monitor/model-picker.test.ts:98` to `249` verifies picker custom ID parsing and max-length enforcement.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/monitor/model-picker.test.ts:265` to `383` verifies provider/model paging and option caps.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/monitor/model-picker.test.ts:474` to `1120` verifies provider/model rendering, custom ID compression, model selects, submit buttons, and runtime picker rendering.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/monitor/model-picker.test.ts:1240` to `1437` verifies recents rendering.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/monitor/model-picker-preferences.test.ts:27` to `66` verifies recents order, filtering, and corrupt file fallback.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/internal/command-deploy.test.ts:16` verifies command equality behavior for deploy reconciliation.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/monitor/native-command.options.test.ts:214` to `506` verifies native command option wiring, autocomplete auth, truncation, and localizations.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/monitor/native-command-context.test.ts:4` to `44` verifies direct and guild native slash context.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/monitor/native-command-reply.test.ts:16` to `64` verifies component-only native command replies.

### Gitcrawl queries

Commands:

```sh
gitcrawl search openclaw/openclaw --query "Discord native slash commands interaction dispatch" --json
gitcrawl search openclaw/openclaw --query "Discord model picker /model /models" --json
gitcrawl search openclaw/openclaw --query "Discord components v2 buttons select modal callback ttl" --json
gitcrawl search openclaw/openclaw --query "Discord component callback expired allowedUsers modal" --json
gitcrawl search openclaw/openclaw --query "Discord slash command registration cleanup commands.native" --json
gitcrawl search openclaw/openclaw --query "discord slash" --json
gitcrawl search openclaw/openclaw --query "discord components" --json
gitcrawl search openclaw/openclaw --query "discord model picker" --json
gitcrawl search openclaw/openclaw --query "agentComponents ttlMs" --json
gitcrawl search openclaw/openclaw --query "interaction expired discord" --json
gitcrawl search openclaw/openclaw --query "Discord modal payloads components" --json
gitcrawl search openclaw/openclaw --query "Discord INTERACTION_CREATE wildcard handler components v2" --json
gitcrawl search openclaw/openclaw --query "Discord components v2" --json
gitcrawl search openclaw/openclaw --query "Discord modal" --json
gitcrawl search openclaw/openclaw --query "Discord INTERACTION_CREATE" --json
```

Results:

- Direct targeted queries for `"Discord native slash commands interaction dispatch"`, `"Discord components v2 buttons select modal callback ttl"`, `"Discord component callback expired allowedUsers modal"`, `"Discord slash command registration cleanup commands.native"`, `"agentComponents ttlMs"`, and `"Discord INTERACTION_CREATE wildcard handler components v2"` returned no hits, so broader Discord slash/component/model/modal queries were needed.
- `"discord slash"` returned active operational issues and PRs including `#75888 [discord] expose slashCommandDeploy mode in config (changed-only / disabled)`, `#39605 Discord/Telegram/Slack slash commands ignore session.dmScope routing`, `#39341 security audit doesn't check top-level channels.discord.allowFrom for slash commands`, `#77359 slash commands not registered for non-default Discord accounts in multi-bot setup`, `#73978 plugin slash commands miss 3s ack deadline / Unknown interaction`, `#79458 i18n fields for slash command descriptions`, `#69629 per-channel command visibility multi-bot`, `#51041 expose Discord slash interaction response controls to plugin commands`, and `#77367 scope command-deploy cache by application id`.
- `"discord model picker"` and `"Discord model picker /model /models"` returned `#86182 discord/picker: structural 25-option / 5-row / 100-char limits constrain large wildcard configs`, plus related model picker and runtime-picker work such as `#83573`, `#83805`, and `#82224`.
- `"discord components"`, `"Discord components v2"`, `"Discord modal"`, and `"Discord modal payloads components"` returned component/modal issues and PRs including `#73967 fix(discord): expose native components on message sends`, `#78813 feat(gateway): add components field to SendParamsSchema for Discord`, `#43015 message.send schema overexposes poll/components/modal causing GPT auto-population breakages`, `#85979 fix(discord): omit undefined component registry fields`, `#41805 Include interaction metadata in Discord button callbacks`, `#53641 attachment silently dropped with components`, and `#84937 minimal Discord /ask command`.
- `"interaction expired discord"` returned `#73978 plugin slash commands miss 3s ack deadline / Unknown interaction`, `#86716 harden reply delivery accounting`, and `#68538 timebox native-command defer before dispatch`.
- `"Discord INTERACTION_CREATE"` returned adjacent historical interaction timing evidence, including slow listener and already-acknowledged Discord interaction reports.

### Discrawl queries

Commands:

```sh
DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 10 "Discord slash commands"
DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 10 "Discord model picker"
DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 10 "Discord components"
DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 10 "Discord modal"
DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 10 "Unknown interaction Discord slash"
```

Results:

- `"Discord slash commands"` returned maintainer and user reports from May 2026 about model picker performance fixes discovered while testing slash commands, CLI/slash approval work, disabling native skill slash commands, Discord's 100 slash command maximum, beta slash commands not appearing, and multi-agent/single-bot slash command questions.
- `"Discord model picker"` returned May 2026 release-note and maintainer discussion around the Discord model picker, including late-May fixes, pagination for provider/model pools above 25 options, and beta release notes for model-picker fixes.
- `"Discord components"` returned maintainer discussion that Discord has a richer component-message path and registry in `extensions/discord/src/send.components.ts`, plus closed issues for message tool modal validation, INTERACTION_CREATE wildcard handling for Components v2 buttons, attachment-with-components handling, and shared component/modal registry behavior.
- `"Discord modal"` returned current and historical modal payload discussion, including May 2026 issue triage and April 2026 closed issues for explicit modal validation, normalized empty/default interactive payloads, shared modal registry, and direct modal trigger/showModal handling.
- `"Unknown interaction Discord slash"` returned historical and current interaction timing evidence: closed issues for native slash missing `deferReply`, slash subcommands timing out, repeated `Interaction already acknowledged` errors, slow listener timing around Discord's 3-second window, and plugin slash command acknowledgement concerns.
