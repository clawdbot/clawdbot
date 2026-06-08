---
title: "Discord - Realtime Voice and Calls Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Discord - Realtime Voice and Calls Maturity Note

## Summary

Realtime Discord voice channels have a substantial implementation and a broad simulated runtime-flow suite across `/vc`, auto-join, `followUsers`, STT/TTS, realtime `agent-proxy`/`bidi`, wake names, barge-in, DAVE recovery, and `libopus-wasm`. The live proof is narrower: the QA live lane verifies Discord voice auto-join against Discord's voice-state API, but I did not find a live Discord speech loop that proves real microphone capture, realtime provider transcription, wake-name activation, barge-in, and playback together.

The component is therefore beta on Coverage and alpha on Quality. Quality is held down by active GitHub issues and Discord support reports for join failures, DAVE/decryption receive failures, voice-output adapter gaps, and user confusion around `/vc`.

## Normalization

Active category after channel taxonomy normalization.

- Normalized category: `Realtime Voice and Calls`
- Merged from: `Realtime Voice`
- Score carry-forward: conservative minimum of merged source category scores.

## Category Scope

Included in this category:

- Voice Channel Lifecycle: Covers Voice Channel Lifecycle across Includes Discord voice channel sessions controlled by `/vc join`, `/vc status`, and `/vc leave`; config-driven `autoJoin`; `followUsers`; voice/stage channel allowlists; connect/reconnect and DAVE handling; `stt-tts`, `agent-proxy`, and related realtime voice channels behavior.
- Auto-join and follow-users: Covers Auto-join and follow-users across Includes Discord voice channel sessions controlled by `/vc join`, `/vc status`, and `/vc leave`; config-driven `autoJoin`; `followUsers`; voice/stage channel allowlists; connect/reconnect and DAVE handling; `stt-tts`, `agent-proxy`, and related realtime voice channels behavior.
- Realtime voice modes: Covers Realtime voice modes across Includes Discord voice channel sessions controlled by `/vc join`, `/vc status`, and `/vc leave`; config-driven `autoJoin`; `followUsers`; voice/stage channel allowlists; connect/reconnect and DAVE handling; `stt-tts`, `agent-proxy`, and related realtime voice channels behavior.
- Wake, barge-in, and echo handling: Covers Wake, barge-in, and echo handling across Includes Discord voice channel sessions controlled by `/vc join`, `/vc status`, and `/vc leave`; config-driven `autoJoin`; `followUsers`; voice/stage channel allowlists; connect/reconnect and DAVE handling; `stt-tts`, `agent-proxy`, and related realtime voice channels behavior.
- Voice codec and DAVE recovery: Covers Voice codec and DAVE recovery across Includes Discord voice channel sessions controlled by `/vc join`, `/vc status`, and `/vc leave`; config-driven `autoJoin`; `followUsers`; voice/stage channel allowlists; connect/reconnect and DAVE handling; `stt-tts`, `agent-proxy`, and related realtime voice channels behavior.

## Features

- Voice Channel Lifecycle: Covers Voice Channel Lifecycle across Includes Discord voice channel sessions controlled by `/vc join`, `/vc status`, and `/vc leave`; config-driven `autoJoin`; `followUsers`; voice/stage channel allowlists; connect/reconnect and DAVE handling; `stt-tts`, `agent-proxy`, and related realtime voice channels behavior.
- Auto-join and follow-users: Covers Auto-join and follow-users across Includes Discord voice channel sessions controlled by `/vc join`, `/vc status`, and `/vc leave`; config-driven `autoJoin`; `followUsers`; voice/stage channel allowlists; connect/reconnect and DAVE handling; `stt-tts`, `agent-proxy`, and related realtime voice channels behavior.
- Realtime voice modes: Covers Realtime voice modes across Includes Discord voice channel sessions controlled by `/vc join`, `/vc status`, and `/vc leave`; config-driven `autoJoin`; `followUsers`; voice/stage channel allowlists; connect/reconnect and DAVE handling; `stt-tts`, `agent-proxy`, and related realtime voice channels behavior.
- Wake, barge-in, and echo handling: Covers Wake, barge-in, and echo handling across Includes Discord voice channel sessions controlled by `/vc join`, `/vc status`, and `/vc leave`; config-driven `autoJoin`; `followUsers`; voice/stage channel allowlists; connect/reconnect and DAVE handling; `stt-tts`, `agent-proxy`, and related realtime voice channels behavior.
- Voice codec and DAVE recovery: Covers Voice codec and DAVE recovery across Includes Discord voice channel sessions controlled by `/vc join`, `/vc status`, and `/vc leave`; config-driven `autoJoin`; `followUsers`; voice/stage channel allowlists; connect/reconnect and DAVE handling; `stt-tts`, `agent-proxy`, and related realtime voice channels behavior.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (74%)`
- Positive signals:
  - Runtime-flow evidence is broad. `extensions/discord/src/voice/manager.e2e.test.ts` exercises disabled config, `/vc` join/status/leave manager flows, duplicate auto-join, fatal auto-join suppression, allowlists, `followUsers`, bot moves, realtime barge-in, DAVE options and recovery, realtime session cleanup, default `agent-proxy`, agent-control tool calls, model/voice overrides, wake-name gating, fuzzy wake-name matching, forced consult fallback, `bidi`, speaker context, authorization before subscribe, `libopus-wasm` cleanup, streaming TTS, transcript preview, and Ready/Resumed auto-join.
  - Live Discord coverage exists for voice channel presence. `extensions/qa-lab/src/live-transports/discord/discord-live.runtime.ts` defines `discord-voice-autojoin`, mutates gateway config with `channels.discord.voice.enabled=true` and `autoJoin`, resolves an explicit or visible voice/stage channel, and polls Discord's `/guilds/{guildId}/voice-states/@me` until the bot is in the expected channel.
- Negative signals:
  - I did not find live evidence that a real Discord user can speak in a voice channel and complete the full microphone-to-agent-to-playback loop through realtime `agent-proxy` or `bidi`.
  - The live QA lane validates voice-state residency, not real audio receive, STT, realtime provider events, wake-name activation, DAVE receive recovery, echo suppression, barge-in, or outbound playback.
  - `/vc` command behavior is covered by simulated runtime-flow and unit-level evidence, but I did not find an end-to-end live Discord slash-command scenario for `/vc join`, `/vc status`, and `/vc leave`.
  - Windows/event-loop and Discord voice websocket failures remain open in Gitcrawl, which suggests some runtime paths are not fully covered by repeatable live gates.
- Integration gaps:
  - Add a live Discord speech scenario that joins a voice channel, injects or plays deterministic audio, verifies transcript/agent response, and observes Discord playback.
  - Add live coverage for wake-name-required conversations, barge-in while the bot is speaking, echo suppression, and forced consult fallback.
  - Add live DAVE/decryption recovery coverage that proves the current `libopus-wasm` and receive-recovery path under Discord's current voice behavior.
  - Add live `/vc join/status/leave` command coverage separate from config-driven auto-join.

## Quality Score

- Score: `Alpha (66%)`
- Gitcrawl reports:
  - Open issues include `/vc join` failing on Windows with `AggregateError` plus gateway heartbeat timeout/event-loop starvation (#80344), voice websocket closing before UDP handshake (#65039), `/voice list` returning no usable voices and status-only outbound audio (#80010), DAVE receive failures with `UnencryptedWhenPassthroughDisabled` (#81518), and a still-open voice-as-IO/session routing feature request (#73699).
  - Open PRs around this area include account-scoped voice groups plus delayed auto-join safety net (#87530), fallback when voice adapter is unavailable (#84965), degraded audio-as-voice behavior when the voice adapter is unavailable (#85173), preserving the Discord voice outbound helper (#85529), and a proposed `/vc switch` handoff (#60902).
  - No Gitcrawl hits were found for `libopus wasm discord voice` or `discord voice realtime wake barge`, so the archive has limited issue/PR traceability for some of the newest quality mechanisms.
- Discrawl reports:
  - Discord search for `discord voice` shows recent release/support discussion around sharper Discord voice/model picking and Talk/voice follow-up, but also support routing for Discord voice-specific problems.
  - Discord search for `vc join` includes user confusion that the `/vc` command was missing and a maintainer/bot response that a given runtime could not join VC because only Discord text/message actions were exposed.
  - Discord search for `libopus` shows a maintainer note that OpenClaw created `openclaw/libopus-wasm` because Discord dependency quality was poor, which is a positive mitigation but also evidence that this surface depended on fragile upstream codec packaging.
  - Discord search for `UnencryptedWhenPassthroughDisabled` shows multiple support threads around voice receive breakage, `/vc status` reporting ready while no STT response arrives, reconnect loops, DAVE/E2EE receive bugs, and dependency loading failures.
- Good qualities:
  - Voice is opt-in, and `voice/config.ts` only enables it when explicit voice config is present or enabled.
  - `/vc` command handling gates access through `authorizeDiscordVoiceIngress`, validates channel type, checks channel access, and reports clear join/status/leave outcomes.
  - `voice/manager.ts` serializes joins, dedupes auto-join, enforces `allowedChannels`, handles bot moves outside allowed channels, reconciles `followUsers`, and bounds some guild/member lookup work.
  - DAVE and receive recovery are first-class in source: config carries DAVE options, receive errors are classified, repeated decrypt failures trigger recovery, and warmup/passthrough state is tracked.
  - `libopus-wasm` removes reliance on native Opus packages for the main receive/decode path and is also used for playback encoding.
  - Realtime source has explicit wake-name defaults and configured wake names, barge-in thresholds, output-activity tracking, forced consult fallback, bounded transcript previews, and voice-output policy controls.
  - Docs are unusually detailed for this surface, covering setup, `/vc`, auto-join, modes, wake names, DAVE, `followUsers`, `libopus-wasm`, STT/TTS, and QA live automation.
- Bad qualities:
  - Active issues show brittle join and receive behavior in real deployments, including Windows/event-loop starvation, voice websocket early close, DAVE receive failures, and status-only outbound audio.
  - The adapter/outbound-helper PR set suggests packaging and runtime availability of voice output is still being hardened.
  - Documentation is not perfectly aligned: `docs/gateway/config-channels.md` says playback is not interrupted by speaker-start events, while newer Discord docs/source describe realtime barge-in behavior; `docs/providers/openai.md` still describes Discord voice using short segment batch transcription in a section that can read stale next to `agent-proxy` realtime docs.
  - User-facing command discoverability appears fragile based on Discord support reports for missing `/vc` and runtimes that expose only text actions.
- Excluded from quality:
  - Unit tests, integration tests, e2e tests, live tests, and runtime-flow coverage were not used to raise or lower this Quality score.

## Completeness Score

- Score: `Beta (74%)`
- Surface instructions: evaluated against `references/completeness/discord.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Voice Channel Lifecycle, Auto-join and follow-users, Realtime voice modes, Wake, barge-in, and echo handling, Voice codec and DAVE recovery.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Full live Discord speech validation is missing for the core realtime promise: user audio in, provider transcript/events, agent consult, TTS or realtime playback out.
- Real Discord `/vc join/status/leave` command automation is not visible in the live QA lane; the visible live lane uses config-driven auto-join and Discord voice-state polling.
- DAVE/decryption recovery is implemented and simulated, but the archive still contains recent real-user failures around current Discord receive behavior.
- Docs need one alignment pass across Discord, OpenAI provider, and gateway config pages so users can tell when the path is realtime `agent-proxy`/`bidi` versus short-segment STT/TTS.
- Voice adapter availability and packaging still appear to be active hardening areas based on open issues and PRs.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/channels/discord.md:1163` documents Discord voice channels as a supported voice surface and distinguishes realtime voice channels from voice message attachments.
- `/Users/kevinlin/code/openclaw/docs/channels/discord.md:1178` documents `/vc join channel:<voice-channel-id>`, `/vc status`, `/vc leave`, and capability probing.
- `/Users/kevinlin/code/openclaw/docs/channels/discord.md:1190` documents `channels.discord.voice` setup with `enabled`, `model`, `autoJoin`, `allowedChannels`, DAVE, connect/reconnect timeouts, and realtime provider/model/voice settings.
- `/Users/kevinlin/code/openclaw/docs/channels/discord.md:1228` documents `voice.mode`, default `agent-proxy`, `stt-tts`, `bidi`, `voice.agentSession`, `followUsers`, consult/tool policy, bootstrap context files, and wake names.
- `/Users/kevinlin/code/openclaw/docs/channels/discord.md:1238` documents realtime event alias compatibility, barge-in, minimum barge-in duration, TTS voice, system prompt, allowlists, opt-in `GuildVoiceStates`, DAVE defaults, `libopus-wasm`, STT/TTS feedback behavior, echo handling, transcript preview, and forced-consult fragment handling.
- `/Users/kevinlin/code/openclaw/docs/channels/discord.md:1263` documents `followUsers`, auto-join versus `/vc` versus follow behavior, and `libopus-wasm` for receive, realtime playback, and file playback.
- `/Users/kevinlin/code/openclaw/docs/channels/discord.md:1310` documents the STT plus TTS pipeline through PCM-to-WAV, `tools.media.audio`, Discord ingress/routing, and voice-output policy.
- `/Users/kevinlin/code/openclaw/docs/providers/openai.md:654` documents OpenAI STT for Discord voice-channel segments and attachments, while later lines describe the Discord path as short segments and batch transcription.
- `/Users/kevinlin/code/openclaw/docs/providers/elevenlabs.md:49` documents ElevenLabs streaming TTS for Discord voice channels when selected.
- `/Users/kevinlin/code/openclaw/docs/concepts/qa-e2e-automation.md:411` documents `OPENCLAW_QA_DISCORD_VOICE_CHANNEL_ID` and `discord-voice-autojoin`, which verifies the SUT bot's Discord voice state.
- `/Users/kevinlin/code/openclaw/docs/gateway/config-channels.md:354` documents voice config, DAVE, reconnects, and decrypt recovery, but includes the stale-looking statement that speaker-start events do not interrupt playback.
- `/Users/kevinlin/code/openclaw/CHANGELOG.md:90` records shared realtime SDK reuse for Discord speaker attribution, playback/barge-in, consult matching, and activation-name matching.
- `/Users/kevinlin/code/openclaw/CHANGELOG.md:1657` records the major Discord realtime voice channel implementation, including `agent-proxy`, target session, barge/echo handling, forced consult fallback, and transcript preview.

### Source

- `/Users/kevinlin/code/openclaw/extensions/discord/src/voice/command.ts:22` defines voice/stage channel types; later command handlers authorize and implement `/vc join`, `/vc leave`, and `/vc status`.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/voice/manager.ts:276` defines `DiscordVoiceManager`, including session tracking, `allowedChannels`, `followUsers`, and opt-in voice enablement.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/voice/manager.ts:339` handles auto-join, duplicate guild config, fatal-start suppression, and follow-user reconciliation.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/voice/manager.ts:426` implements join validation, serialization, DAVE config, Ready waits, route resolution, session/player setup, and realtime session attachment.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/voice/manager.ts:967` reacts to voice-state updates, bot moves, followed-user moves, and leave/rejoin flows.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/voice/manager.ts:1510` handles speaker-start capture, non-realtime playback suppression, and realtime barge-in.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/voice/manager.ts:1565` handles receive streams, realtime chunks, STT/TTS decode, DAVE passthrough, and segment processing.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/voice/manager.ts:1769` classifies receive errors and triggers recovery when repeated receive failures pass threshold.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/voice/realtime.ts:101` defines `stt-tts`, `agent-proxy`, and `bidi`; later code resolves default `agent-proxy`, wake names, connect options, consult policy, barge-in, playback, transcript handling, and forced consult fallback.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/voice/audio.ts:4` imports `libopus-wasm`; later code creates the decoder, encoder, playback stream, and decode stream.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/voice/ingress.ts:64` authorizes voice ingress and routes voice turns through `agentCommandFromIngress`.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/voice/receive-recovery.ts:3` defines receive failure thresholds, DAVE markers, passthrough expiry, and recovery decisions.
- `/Users/kevinlin/code/openclaw/src/plugin-sdk/realtime-voice.ts:53` exports shared realtime SDK primitives for activation names, forced consult coordination, output tracking, consult tools, talkback controls, health, transcript, and echo suppression.

### Integration tests

- `/Users/kevinlin/code/openclaw/extensions/discord/src/voice/manager.e2e.test.ts:554` covers join rejection when voice config is absent.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/voice/manager.e2e.test.ts:1003` covers duplicate auto-join handling; `:1026` covers repeated fatal auto-join suppression.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/voice/manager.e2e.test.ts:1044` and `:1062` cover allowlisted channel rejection and acceptance.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/voice/manager.e2e.test.ts:1077` through `:1494` cover `followUsers`, moves, leaves, handoffs, disallowed channels, and bounded reconciliation.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/voice/manager.e2e.test.ts:1531` and `:1546` cover empty allowlists and bot moves outside allowed channels.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/voice/manager.e2e.test.ts:1616`, `:1637`, `:1690`, and `:1880` cover playback suppression and realtime barge-in behavior.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/voice/manager.e2e.test.ts:1913` through `:2186` cover DAVE options, Ready timeout/retry behavior, reconnect grace, and realtime session cleanup.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/voice/manager.e2e.test.ts:2209`, `:2306`, and `:2697` cover default `agent-proxy`, agent-control tool calls, and realtime model/voice overrides.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/voice/manager.e2e.test.ts:2737` through `:4245` cover active-run transcript/control, forced consult, wake-name requirements, partial wake acknowledgement, default OpenClaw wake name, fuzzy wake matching/rejection, forced fallback reuse, and stale answer prevention.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/voice/manager.e2e.test.ts:4461` through `:4817` cover `bidi`, configured session routing, speaker context, turn expiry, and speaker authorization before subscribe.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/voice/manager.e2e.test.ts:4889` through `:5112` cover DAVE passthrough, recovery rejoin, follow ownership preservation, realtime-audio reset, `libopus-wasm` cleanup, decoder failure state preservation, and partial non-realtime segments after abort.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/voice/manager.e2e.test.ts:5225` through `:5730` cover silence grace, allowlisted/open-policy speakers, STT/TTS control, model override, voice output policy, transcript preview, streaming TTS, system prompt overrides, speaker cache/role refetch, guild metadata ordering, and Ready/Resumed auto-join.
- `/Users/kevinlin/code/openclaw/extensions/qa-lab/src/live-transports/discord/discord-live.runtime.ts:331` defines the `discord-voice-autojoin` live scenario.
- `/Users/kevinlin/code/openclaw/extensions/qa-lab/src/live-transports/discord/discord-live.runtime.ts:499` injects voice auto-join config for that scenario.
- `/Users/kevinlin/code/openclaw/extensions/qa-lab/src/live-transports/discord/discord-live.runtime.ts:568` resolves voice/stage channels for the live scenario.
- `/Users/kevinlin/code/openclaw/extensions/qa-lab/src/live-transports/discord/discord-live.runtime.ts:615` polls Discord voice state for the bot in the target channel.
- `/Users/kevinlin/code/openclaw/extensions/qa-lab/src/live-transports/discord/discord-live.runtime.ts:1622` mutates gateway config for the voice scenario, and `:1687` waits for the target voice state before passing.

### Unit tests

- `/Users/kevinlin/code/openclaw/extensions/discord/src/config-schema.test.ts:166` validates voice model, `agentSession`, realtime mode fields, `followUsers`, provider/model/voice, tool and consult policies, wake names, bootstrap files, and barge-in settings.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/config-schema.test.ts:240` rejects invalid modes, wake names, tool policies, consult policies, unsafe bootstrap paths, and empty `followUsers`.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/config-schema.test.ts:260` validates timing and allowed-channel config.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/doctor.test.ts:121` covers voice doctor normalization for invalid wake-name configuration.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/voice/audio.test.ts:18` verifies `libopus-wasm` receive decoding defaults and raw PCM encoding.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/voice/command.test.ts:64` covers `/vc` command registration and status behavior.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/voice/access.test.ts:207` covers voice sender allowlist behavior and guards against dangerous name matching.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/voice/receive-recovery.test.ts` covers receive-recovery classification and thresholds.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/voice/transcripts-source.test.ts` covers transcript source behavior for voice transcripts.
- `/Users/kevinlin/code/openclaw/extensions/qa-lab/src/live-transports/discord/discord-live.runtime.test.ts:170` covers voice auto-join config injection; `:535` covers voice channel/voice-state handling.

### Gitcrawl queries

Query:

```
gitcrawl search issues "discord voice" -R openclaw/openclaw --state all --json number,title,state,url,updatedAt --limit 20
```

Results:

- Returned 20 issues. Key open results include #80344 `/vc join` failing on Windows with `AggregateError` and gateway heartbeat timeout, #65039 voice websocket closing before UDP handshaking, #80010 `/voice list` and `/voice chat` status-only audio failure, #81518 DAVE receive failure with `UnencryptedWhenPassthroughDisabled`, #73699 voice-as-IO/session routing, #53562 `sessionChannelId` for auto-join transcript routing, and #84952 voice outbound adapter unavailable.

Query:

```
gitcrawl search issues "voice channel" -R openclaw/openclaw --state all --json number,title,state,url,updatedAt --limit 20
```

Results:

- Returned overlapping open issues for Discord voice runtime behavior, including #73699, #53562, #80344, #80010, #65039, #81518, and adjacent async channel-completion work.

Query:

```
gitcrawl search issues "discord voice realtime" -R openclaw/openclaw --state all --json number,title,state,url,updatedAt --limit 20
```

Results:

- Returned #73699 and adjacent voice-call work, with no issue archive proving the full realtime Discord voice path as complete.

Query:

```
gitcrawl search issues "libopus wasm discord voice" -R openclaw/openclaw --state all --json number,title,state,url,updatedAt --limit 20
```

Results:

- Returned no results.

Query:

```
gitcrawl search issues "Discord voice UnencryptedWhenPassthroughDisabled DAVE" -R openclaw/openclaw --state all --json number,title,state,url,updatedAt --limit 20
```

Results:

- Returned #81518, an open DAVE receive breakage report updated on 2026-05-28.

Query:

```
gitcrawl search issues "Discord voice followUsers" -R openclaw/openclaw --state all --json number,title,state,url,updatedAt --limit 20
```

Results:

- Returned no results.

Query:

```
gitcrawl search prs "discord voice" -R openclaw/openclaw --state all --json number,title,state,url,updatedAt --limit 20
```

Results:

- Returned 20 PRs. Key open results include #87530 account-scoped voice groups plus delayed auto-join safety net, #84965 fallback when voice adapter is unavailable, #85173 degrade audio-as-voice to media attachment when voice adapter is unavailable, #60902 `/vc switch`, #85529 preserve Discord voice outbound helper, and #82105 bundle channel voice plugin dependencies.

Query:

```
gitcrawl search prs "discord voice realtime wake barge" -R openclaw/openclaw --state all --json number,title,state,url,updatedAt --limit 20
```

Results:

- Returned no results.

### Discrawl queries

Query:

```
DISCRAWL_NO_AUTO_UPDATE=1 discrawl --json search --limit 10 "discord voice /vc agent-proxy realtime wake barge libopus followUsers"
```

Results:

- Returned `null`; the combined targeted phrase had no direct Discord archive hit.

Query:

```
DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 10 "discord voice"
```

Results:

- Returned recent release/support messages about sharper Discord voice/model picking and Talk/voice controls, plus maintainer support routing around Discord voice issues.

Query:

```
DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 10 "vc join"
```

Results:

- Returned a May 2026 setup snippet covering `channels.discord.voice.enabled`, `GuildVoiceStates`, `/vc join/status/leave`, auto-join behavior, and permissions.
- Also returned user/support messages that `/vc` appeared missing and that a specific runtime could not join VC because only Discord text/message actions were exposed.

Query:

```
DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 10 "libopus"
```

Results:

- Returned a maintainer note that OpenClaw created `openclaw/libopus-wasm` because the Discord dependency state was poor, which supports the current codec mitigation and the quality-risk history.

Query:

```
DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 10 "UnencryptedWhenPassthroughDisabled"
```

Results:

- Returned support threads for Discord voice receive breakage, `/vc status` showing ready while no STT response arrived, reconnect loops, DAVE/E2EE receive failures, dependency loading failures, and guidance to rely on DAVE defaults and rejoin after repeated decrypt failures.
