---
summary: "Config normalization, legacy config key migrations, and update-time schema publication"
title: "Config and migration repairs"
read_when:
  - Doctor reports a legacy config key or a failed config migration
  - You are adding or modifying a config migration
---

Checks 0-2 cover config normalization and the legacy config key migrations,
plus how doctor publishes shared-state schema during an update.

## Schema publication during a 2026.9.2 update

When OpenClaw 2026.9.2 drives an update that needs a newer shared-state schema,
Doctor applies the migration content and reports
`schema content applied; version publication deferred until update run <id> finishes`.
The old updater can finish its ledger access, while the new Gateway uses the
migrated content. Publication waits until all affected terminal runs are at least
five minutes old; a running row unchanged for more than 30 minutes counts as
abandoned. Every writable database open follows this rule, and the Gateway
watcher schedules publication after the deadline.

Ordinary CLI commands, including Doctor, remain usable while that Gateway runs.
Applied content counts as ready; only the owning Gateway, or a writable opener
when no Gateway owns the state directory, publishes the version after the grace.

Deferral does not cover agent-database migrations. Doctor reports
`update-schema-bump-unfenced` if one is pending, if the required shared-state
metadata table is missing, or if the content migration fails. Follow the
[manual update sequence](/install/updating#updating-from-2026.9.2-across-a-schema-bump)
from the refusal. See [Database schemas](/reference/database-schemas#schema-bumps-and-older-updaters)
for the publication contract and the remaining risk for an old CLI stalled
beyond the grace period.

## Checks 0-2

<AccordionGroup>
  <Accordion title="0. Optional update (git installs)">
    If this is a git checkout and doctor is running interactively, it offers to update (fetch/rebase/build) before running doctor.
  </Accordion>
  <Accordion title="1. Config normalization">
    Doctor normalizes legacy value shapes into the current schema. Current Talk speech config is `talk.provider` + `talk.providers.<provider>`, with realtime voice config under `talk.realtime.*`. Doctor rewrites old `talk.voiceId` / `talk.voiceAliases` / `talk.modelId` / `talk.outputFormat` / `talk.apiKey` shapes into the provider map, and rewrites legacy top-level realtime selectors (`talk.mode`, `talk.transport`, `talk.brain`, `talk.model`, `talk.voice`) into `talk.realtime`.

    Doctor also warns when `plugins.allow` is non-empty and tool policy uses wildcard or plugin-owned tool entries. `tools.allow: ["*"]` only matches tools from plugins that actually load; it does not bypass the exclusive plugin allowlist.

    `doctor --fix` removes `workspace: null` from `agents.entries.<id>` so normal workspace resolution can apply. It also removes invalid `heartbeat.activeHours` windows from agent entries and `agents.defaults`, preserving other heartbeat settings. Reconfigure a valid window if needed; without an explicit or inherited window, heartbeat hours are unrestricted. These repairs also apply after migrating a legacy `agents.list` roster.

  </Accordion>
  <Accordion title="2. Legacy config key migrations">
    Gateway startup automatically applies deterministic, prompt-free legacy config migrations when an otherwise invalid single-file config can be fully migrated. It uses the same migration transforms as `openclaw doctor --fix`, validates the complete result including plugin config before writing, and reports the applied changes. The write runs under the startup migration lease and preserves the previous config in the five-slot `openclaw.json.bak` / `.bak.1` through `.bak.4` backup ring.

    Startup does not migrate configs using `$include`, configs in Nix mode, or configs last written by a newer OpenClaw version. It also skips automatic config migration while an update is in progress and plugin validation is deferred; the post-update doctor run owns that repair. If any validation or legacy-key issue remains after migration, startup leaves the config unchanged, refuses to start, and prints the `openclaw doctor --fix` hint. An interactive terminal can still offer to run doctor and retry once for configs that need other repairs; headless services stop with the hint.

    Other commands that encounter legacy keys still ask you to run `openclaw doctor`. Doctor explains the issues, shows its migrations, and rewrites `~/.openclaw/openclaw.json` with the updated schema. Cron job store migrations are also handled by `openclaw doctor --fix`; automatic config-key migration does not import legacy session stores or repair services.

    When a readable active config can be fully migrated, Doctor preserves it before considering last-known-good recovery. This includes legacy multi-agent rosters with a `default: true` owner: unrelated settings and the original agent ownership survive the migration.

    Per-agent migrations apply to both keyed `agents.entries` and legacy `agents.list` rosters, including rosters that already set `agents.ownership: "explicit"`. For example, Doctor preserves an agent's legacy `memorySearch` settings under `memory.search` and converts `sandbox.perSession` to `sandbox.scope`. Existing values at the current config paths take precedence.

    For legacy rosters with multiple agents and no resolvable ambient owner, Doctor seeds `agents.defaults.systemAgent.agentId` from a uniquely marked `default: true` agent, or `main` when present. Sole-agent rosters and legacy default markers already honored by the runtime need no owner repair and produce no missing-owner advice. Explicit fleet ownership disables the legacy default-marker fallback, so those rosters may still need repair. Doctor also pins `agents.defaults.heartbeat.agentId` only when heartbeat enrollment would otherwise be unresolved; existing heartbeat owners, shared defaults, and per-agent enrollment are preserved. These changes are reported and saved by `doctor --fix`, including the update-time doctor pass. If no default can be identified, configure the system-agent owner explicitly.

    <Note>
      Doctor only carries automatic migrations for roughly two months after a
      key is retired. Older legacy keys (for example the original
      `routing.queue`, `routing.bindings`, `routing.agents`/`defaultAgentId`,
      `routing.transcribeAudio`, top-level `agent.*`, or top-level `identity`
      from the pre-multi-agent config shape) no longer have a migration path;
      config using them now fails validation instead of being rewritten. Fix
      those keys by hand against the current config reference before doctor
      can proceed.
    </Note>

    Active migrations:

    | Legacy key                                                                                    | Current key                                                                 |
    | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
    | `routing.allowFrom`                                                                              | `channels.whatsapp.allowFrom`                                                |
    | `routing.groupChat.requireMention`                                                               | `channels.whatsapp/telegram/imessage.groups."*".requireMention`             |
    | `routing.groupChat.historyLimit`                                                                 | `messages.groupChat.historyLimit`                                            |
    | `routing.groupChat.mentionPatterns`                                                              | `messages.groupChat.mentionPatterns`                                         |
    | `channels.telegram.requireMention`                                                               | `channels.telegram.groups."*".requireMention`                               |
    | `channels.webchat`, `gateway.webchat`                                                            | removed (WebChat is retired)                                                 |
    | `channels.feishu.accounts.<accountId>.botName`                                                   | `channels.feishu.accounts.<accountId>.name`                                 |
    | `session.threadBindings.ttlHours`, `channels.<id>.threadBindings.ttlHours` (and per-account)      | `...threadBindings.idleHours`                                               |
    | legacy `talk.voiceId`/`talk.voiceAliases`/`talk.modelId`/`talk.outputFormat`/`talk.apiKey`        | `talk.provider` + `talk.providers.<provider>`                               |
    | legacy top-level realtime Talk selectors (`talk.mode`/`talk.transport`/`talk.brain`/`talk.model`/`talk.voice`) | `talk.realtime`                                                              |
    | `messages.tts`                                                                                  | top-level `tts`                                                              |
    | `messages.tts.<provider>` (`openai`/`elevenlabs`/`microsoft`/`edge`)                             | `tts.providers.<provider>`                                                   |
    | `messages.tts.provider: "edge"` / `messages.tts.providers.edge`                                  | `tts.provider: "microsoft"` / `tts.providers.microsoft`                    |
    | `tools.exec.security` + `tools.exec.ask`                                                         | `tools.exec.mode`                                                            |
    | `session.idleMinutes`                                                                            | `session.reset.idleMinutes`                                                  |
    | `messages.responsePrefix` with explicit channel blocks                                           | copied to configured channel/account `responsePrefix`; global fallback retained for implicit/custom channels |
    | `web.enabled`                                                                                    | `channels.whatsapp.enabled`                                                  |
    | `meta.lastTouchedAt`, hook installs, cron store, bundled discovery, global TTS prefs path            | shared SQLite state                                                       |
    | TTS speaker fields `voice`/`voiceName`/`voiceId`                                                 | `speakerVoice`/`speakerVoiceId`                                              |
    | `channels.<id>.tts.<provider>` / `channels.<id>.accounts.<accountId>.tts.<provider>` (all channels except Discord)                                          | `...tts.providers.<provider>`                                                |
    | `channels.<id>.voice.tts.<provider>` / `channels.<id>.accounts.<accountId>.voice.tts.<provider>` (all channels, including Discord)                          | `...voice.tts.providers.<provider>`                                          |
    | `plugins.entries.voice-call.config.tts.<provider>` (`openai`/`elevenlabs`/`microsoft`/`edge`)     | `plugins.entries.voice-call.config.tts.providers.<provider>`                |
    | `plugins.entries.voice-call.config.tts.provider: "edge"` / `...tts.providers.edge`                | `provider: "microsoft"` / `...tts.providers.microsoft`                      |
    | `plugins.entries.voice-call.config.provider: "log"`                                              | `"mock"`                                                                      |
    | `plugins.entries.voice-call.config.twilio.from`                                                  | `plugins.entries.voice-call.config.fromNumber`                              |
    | `plugins.entries.voice-call.config.streaming.sttProvider`                                        | `plugins.entries.voice-call.config.streaming.provider`                      |
    | `plugins.entries.voice-call.config.streaming.openaiApiKey`/`sttModel`/`silenceDurationMs`/`vadThreshold` | `plugins.entries.voice-call.config.streaming.providers.openai.*`             |
    | `models.providers.*.api: "openai"`                                                               | `"openai-completions"` (gateway startup also skips providers whose `api` is a future/unknown enum value rather than failing closed) |
    | `browser.ssrfPolicy.allowPrivateNetwork`                                                         | `browser.ssrfPolicy.dangerouslyAllowPrivateNetwork`                          |
    | `browser.profiles.*.driver: "extension"` with a stale `cdpUrl`                                  | driver preserved; stale relay URL removed                                     |
    | `browser.relayBindHost`                                                                          | removed (legacy Chrome extension relay setting)                             |
    | `mcp.servers.*.type` (CLI-native aliases)                                                        | `mcp.servers.*.transport`                                                    |
    | `mcp.servers.*.disabled`                                                                         | inverse `mcp.servers.*.enabled`                                              |
    | MCP timeout aliases `connectTimeout`/`connect_timeout`/`timeout`                                 | `connectionTimeoutMs`/`requestTimeoutMs`                                    |
    | MCP snake-case server fields                                                                     | camelCase MCP server fields                                                   |
    | `tools.media.image/audio/video.models`                                                           | capability-tagged `tools.media.models`                                        |
    | `tools.media.asyncCompletion`                                                                    | removed                                                                       |
    | `tools.message.allowCrossContextSend`                                                            | `tools.message.crossContext`                                                  |
    | media model `deepgram` options                                                                   | `providerOptions.deepgram`                                                    |
    | `talk.realtime.voice`, Discord realtime `voice`                                                 | `speakerVoice`                                                                |
    | `agents.defaults.pdfMaxBytesMb`                                                                  | `agents.defaults.pdfMaxMb`                                                    |
    | `tools.exec.timeoutSec`                                                                          | `tools.exec.timeoutSeconds`                                                   |
    | `browser.ssrfPolicy.hostnameAllowlist`                                                           | wildcard-aware `browser.ssrfPolicy.allowedHostnames`                          |
    | sandbox browser `enableNoVnc`                                                                    | `noVncEnabled`                                                                |
    | root `media`                                                                                     | `attachments`                                                                |
    | channel/account `heartbeat` visibility blocks                                                   | `heartbeatVisibility`                                                         |
    | `channels.slack.identity`                                                                        | `channels.slack.postAs`                                                       |
    | root `audit`                                                                                     | `logging.audit`                                                               |
    | `gateway.nodes.skills.enabled`                                                                   | `gateway.nodes.allowSkills`                                                   |
    | `gateway.nodes.allowCommands`/`denyCommands`                                                    | `gateway.nodes.commands.allow`/`deny`                                         |
    | generation model defaults                                                                       | `agents.defaults.mediaModels.{image,video,music}`                              |
    | retired final-layout tuning knobs                                                               | built-in default behavior                                                     |
    | `channels.whatsapp.messagePrefix` and legacy `messages.messagePrefix`                            | `channels.whatsapp.responsePrefix`                                            |
    | `channels.whatsapp.ackReaction`                                                                  | global `messages.ackReaction` and `ackReactionScope` where translatable        |
    | `cron.failureDestination`                                                                        | destination fields on `cron.failureAlert`                                     |
    | `gateway.controlUi.chatMessageMaxWidth`, presentation-only `ui.prefs` keys                       | removed (text scale, chat width, and live sidebar activity are browser-local) |
    | `agents.list`                                                                                    | keyed `agents.entries`                                                        |
    | top-level `defaultModel`                                                                         | `agents.defaults.model`                                                      |
    | `messages.messagePrefix`                                                                         | `channels.whatsapp.responsePrefix`                                            |
    | `session.maintenance.pruneDays`, `session.resetByType.dm`                                        | `session.maintenance.pruneAfter`, `session.resetByType.direct`               |
    | top-level `tui`                                                                                  | removed (the TUI footer uses the compact default)                            |
    | `plugins.entries.codex.config.codexDynamicToolsProfile`                                          | removed (Codex app-server always keeps Codex-native workspace tools native) |
    | `commands.modelsWrite`                                                                           | removed (`/models add` is deprecated)                                       |
    | `agents.defaults/list[].silentReplyRewrite`, `surfaces.*.silentReplyRewrite`                     | removed (exact `NO_REPLY` is no longer rewritten to visible fallback text)  |
    | `agents.defaults/list[].systemPromptOverride`                                                    | removed (OpenClaw owns the generated system prompt)                        |
    | `agents.defaults/list[].embeddedPi`                                                              | `embeddedAgent`                                                              |
    | `agents.defaults/list[].sandbox.perSession`                                                      | `sandbox.scope`                                                              |
    | `agents.defaults.llm`                                                                             | removed (use `models.providers.<id>.timeoutSeconds` for slow model/provider timeouts, kept below the agent/run timeout ceiling) |
    | top-level `memorySearch`, `agents.defaults.memorySearch`                                         | `memory.search`                                                             |
    | `agents.entries.*.memorySearch`                                                                     | `agents.entries.*.memory.search`                                               |
    | `memorySearch.provider: "auto"`                                                                  | `"openai"`                                                                    |
    | `memorySearch.store.path` (any level)                                                            | removed (memory indexes live in each agent database)                       |
    | top-level `heartbeat`                                                                            | `agents.defaults.heartbeat` / `channels.defaults.heartbeat`                 |
    | `plugins.openai-codex` policy ids                                                                | `plugins.openai`                                                             |
    | `tools.web.x_search.apiKey`                                                                      | `plugins.entries.xai.config.webSearch.apiKey`                               |
    | `session.maintenance.rotateBytes`, `session.parentForkMaxTokens`                                 | removed (deprecated)                                                        |
    | Runtime and channel tuning knobs retired in 2026.7                                               | removed (built-in production defaults apply)                               |

    <Note>
      The Voice Call plugin supplies the migration for its legacy config keys.
      `openclaw doctor --fix` invokes it and persists the canonical shape in
      `openclaw.json`; runtime config parsing accepts only current keys.
      Existing canonical settings win over legacy values, including streaming
      provider credentials, models, and timing. Doctor reports retained
      destinations instead of claiming those legacy values were moved.
    </Note>

    Per-agent `memorySearch` migrations work with both old `agents.list` rosters and keyed `agents.entries`. Doctor preserves explicit `memory.search` settings when merging legacy values, including environment references moved to the new paths. When repairs affect only per-agent settings, single-file agent includes stay in their included file.

    The retired `tools.message.allowCrossContextSend` flag migrates at both root and per-agent scopes. Doctor preserves the effective cross-context permissions, including an agent's `false` override of a root `true` flag.

    Account-default guidance for multi-account channels:

    - If two or more `channels.<channel>.accounts` entries are configured without `channels.<channel>.defaultAccount` or `accounts.default`, doctor warns that fallback routing can pick an unexpected account.
    - If `channels.<channel>.defaultAccount` is set to an unknown account ID, doctor warns and lists configured account IDs.

    In multi-agent configs, `doctor --fix` adds a missing account-scoped routing
    binding when all matchable narrower bindings for that channel/account explicitly
    name one configured agent. Existing routes remain unchanged. Accounts with no
    owner evidence or conflicting owners need an explicit binding; Doctor does
    not infer their owner from roster order or another channel/account.

  </Accordion>
</AccordionGroup>
