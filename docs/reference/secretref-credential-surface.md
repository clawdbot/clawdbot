---
summary: "Canonical supported vs unsupported SecretRef credential surface"
read_when:
  - Verifying SecretRef credential coverage
  - Auditing whether a credential is eligible for `secrets configure` or `secrets apply`
  - Verifying why a credential is outside the supported surface
title: "SecretRef credential surface"
---

This page defines the canonical SecretRef credential surface: which credential fields accept a `SecretRef` (env/file/exec-backed reference) instead of a raw secret value.

Scope:

- In scope: strictly user-supplied credentials that OpenClaw does not mint or rotate.
- Out of scope: runtime-minted or rotating credentials, OAuth refresh material, and session-like artifacts.

The lists below are generated from the source target registry and checked against `docs/reference/secretref-user-supplied-credentials-matrix.json` in CI; do not hand-edit entries.

## Supported credentials

### `openclaw.json` targets (`secrets configure` + `secrets apply` + `secrets audit`)

[//]: # "secretref-supported-list-start"

- `models.providers.*.apiKey`
- `models.providers.*.headers.*`
- `models.providers.*.request.auth.token`
- `models.providers.*.request.auth.value`
- `models.providers.*.request.headers.*`
- `models.providers.*.request.proxy.tls.ca`
- `models.providers.*.request.proxy.tls.cert`
- `models.providers.*.request.proxy.tls.key`
- `models.providers.*.request.proxy.tls.passphrase`
- `models.providers.*.request.tls.ca`
- `models.providers.*.request.tls.cert`
- `models.providers.*.request.tls.key`
- `models.providers.*.request.tls.passphrase`
- `skills.entries.*.apiKey`
- `agents.defaults.memorySearch.remote.apiKey`
- `agents.list[].tts.providers.*.apiKey`
- `agents.list[].memorySearch.remote.apiKey`
- `talk.providers.*.apiKey`
- `talk.realtime.providers.*.apiKey`
- `messages.tts.providers.*.apiKey`
- `tools.web.fetch.firecrawl.apiKey`
- `plugins.entries.acpx.config.mcpServers.*.env.*`
- `plugins.entries.brave.config.webSearch.apiKey`
- `plugins.entries.codex.config.appServer.authToken`
- `plugins.entries.codex.config.appServer.headers.*`
- `plugins.entries.exa.config.webSearch.apiKey`
- `plugins.entries.google-meet.config.realtime.providers.*.apiKey`
- `plugins.entries.google.config.webSearch.apiKey`
- `plugins.entries.xai.config.webSearch.apiKey`
- `plugins.entries.moonshot.config.webSearch.apiKey`
- `plugins.entries.perplexity.config.webSearch.apiKey`
- `plugins.entries.firecrawl.config.webSearch.apiKey`
- `plugins.entries.minimax.config.webSearch.apiKey`
- `plugins.entries.tavily.config.webSearch.apiKey`
- `plugins.entries.parallel.config.webSearch.apiKey`
- `plugins.entries.voice-call.config.realtime.providers.*.apiKey`
- `plugins.entries.voice-call.config.streaming.providers.*.apiKey`
- `plugins.entries.voice-call.config.tts.providers.*.apiKey`
- `plugins.entries.voice-call.config.twilio.authToken`
- `plugins.entries.webhooks.config.routes.*.secret`
- `tools.web.search.*.apiKey`
- `tools.web.search.apiKey`
- `gateway.auth.password`
- `gateway.auth.token`
- `gateway.remote.token`
- `gateway.remote.password`
- `cron.webhookToken`
- `channels.telegram.botToken`
- `channels.telegram.webhookSecret`
- `channels.telegram.accounts.*.botToken`
- `channels.telegram.accounts.*.webhookSecret`
- `channels.slack.botToken`
- `channels.slack.appToken`
- `channels.slack.relay.authToken`
- `channels.slack.userToken`
- `channels.slack.signingSecret`
- `channels.slack.accounts.*.botToken`
- `channels.slack.accounts.*.appToken`
- `channels.slack.accounts.*.relay.authToken`
- `channels.slack.accounts.*.userToken`
- `channels.slack.accounts.*.signingSecret`
- `channels.sms.authToken`
- `channels.sms.accounts.*.authToken`
- `channels.clickclack.token`
- `channels.clickclack.accounts.*.token`
- `channels.discord.token`
- `channels.discord.pluralkit.token`
- `channels.discord.voice.tts.providers.*.apiKey`
- `channels.discord.accounts.*.token`
- `channels.discord.accounts.*.pluralkit.token`
- `channels.discord.accounts.*.voice.tts.providers.*.apiKey`
- `channels.irc.password`
- `channels.irc.nickserv.password`
- `channels.irc.accounts.*.password`
- `channels.irc.accounts.*.nickserv.password`
- `channels.feishu.appSecret`
- `channels.feishu.encryptKey`
- `channels.feishu.verificationToken`
- `channels.feishu.accounts.*.appSecret`
- `channels.feishu.accounts.*.encryptKey`
- `channels.feishu.accounts.*.verificationToken`
- `channels.qqbot.clientSecret`
- `channels.qqbot.accounts.*.clientSecret`
- `channels.msteams.appPassword`
- `channels.mattermost.botToken`
- `channels.mattermost.accounts.*.botToken`
- `channels.matrix.accessToken`
- `channels.matrix.password`
- `channels.matrix.accounts.*.accessToken`
- `channels.matrix.accounts.*.password`
- `channels.nextcloud-talk.botSecret`
- `channels.nextcloud-talk.apiPassword`
- `channels.nextcloud-talk.accounts.*.botSecret`
- `channels.nextcloud-talk.accounts.*.apiPassword`
- `channels.zalo.botToken`
- `channels.zalo.webhookSecret`
- `channels.zalo.accounts.*.botToken`
- `channels.zalo.accounts.*.webhookSecret`
- `channels.googlechat.serviceAccount` via sibling `serviceAccountRef` (compatibility exception)
- `channels.googlechat.accounts.*.serviceAccount` via sibling `serviceAccountRef` (compatibility exception)

### `auth-profiles.json` targets (`secrets configure` + `secrets apply` + `secrets audit`)

- `profiles.*.keyRef` (`type: "api_key"`; unsupported when `auth.profiles.<id>.mode = "oauth"`)
- `profiles.*.tokenRef` (`type: "token"`; unsupported when `auth.profiles.<id>.mode = "oauth"`)

[//]: # "secretref-supported-list-end"

Notes:

- Auth-profile plan targets require `agentId`; plan entries target `profiles.*.key` / `profiles.*.token` and write sibling refs (`keyRef` / `tokenRef`). Auth-profile refs are included in runtime resolution and audit coverage.
- In `openclaw.json`, SecretRefs must use structured objects such as `{"source":"env","provider":"default","id":"DISCORD_BOT_TOKEN"}`. Legacy `secretref-env:<ENV_VAR>` marker strings are rejected on SecretRef credential paths; run `openclaw doctor --fix` to migrate valid markers.
- OAuth policy guard: `auth.profiles.<id>.mode = "oauth"` cannot be combined with SecretRef inputs for that profile. Startup/reload and auth-profile resolution fail fast when this policy is violated.
- For SecretRef-managed model providers, generated `agents/*/agent/models.json` entries persist non-secret markers (not resolved secret values) for `apiKey`/header surfaces. Marker persistence is source-authoritative: OpenClaw writes markers from the active source config snapshot (pre-resolution), not from resolved runtime secret values.
- Cold Gateway startup can isolate retryable resolution failures for mapped, non-Gateway owners. Current mapped classes include model providers and skills, media/TTS/cron providers, eligible auth profiles, per-agent memory, sandbox SSH, channel accounts, and manifest-declared plugin routes. Startup keeps each failed owner's explicit refs in the runtime snapshot, reports the owner through status and doctor, and rejects requests for that owner without trying lower-precedence credentials. Reload and config-write preflight use the same owner-aware policy: healthy owners refresh; an eligible failed owner stays stale only when its ref identities, provider definitions, and complete non-secret owner contract are unchanged; a new or changed failure becomes cold. Gateway ingress auth, structurally invalid refs or values, fail-closed owners, and currently unmapped owners remain strict.
- For web search: in explicit provider mode (`tools.web.search.provider` set), only the selected provider key is active. In auto mode (`tools.web.search.provider` unset), only the first provider key that resolves by precedence is active, and non-selected provider refs are treated as inactive until selected. Legacy `tools.web.search.*` provider paths still resolve during the compatibility window, but the canonical SecretRef surface is `plugins.entries.<plugin>.config.webSearch.*`.
- Slack `identity: "user"` uses `channels.slack.userToken` with `channels.slack.appToken` for Socket Mode or `channels.slack.signingSecret` for HTTP mode. The same pairing applies under `channels.slack.accounts.*`; no bot token is required for this identity.

## Unsupported credentials

These credentials are minted, rotated, session-bearing, or OAuth-durable classes that do not fit read-only external SecretRef resolution:

[//]: # "secretref-unsupported-list-start"

- `commands.ownerDisplaySecret`
- `hooks.token`
- `hooks.gmail.pushToken`
- `hooks.mappings[].sessionKey`
- `auth-profiles.oauth.*`
- `channels.discord.threadBindings.webhookToken`
- `channels.discord.accounts.*.threadBindings.webhookToken`
- `channels.whatsapp.creds.json`
- `channels.whatsapp.accounts.*.creds.json`

[//]: # "secretref-unsupported-list-end"

## Related

- [Secrets management](/gateway/secrets)
- [Auth credential semantics](/auth-credential-semantics)
