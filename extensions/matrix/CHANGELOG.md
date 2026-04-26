# Changelog

## 2026.4.25

### Changes

- Version alignment with core OpenClaw release numbers.

## 2026.4.20

### Changes

- Version alignment with core OpenClaw release numbers.

## 2026.4.19-beta.1

### Changes

- Version alignment with core OpenClaw release numbers.

This file tracks Matrix-related release notes for the local `@openclaw/matrix`
plugin since the `matrix-js-sdk` migration. Source release notes live in
`../../changelog.md`; exact repeated entries inside the same version are
collapsed here.

## 2026.4.15-beta.2

### Fixes

- Matrix/pairing: block DM pairing-store entries from authorizing room control commands [AI-assisted]. (#67294) Thanks @pgondhi987.
- Docker/build: verify `@matrix-org/matrix-sdk-crypto-nodejs` native bindings with `find` under `node_modules` instead of a hardcoded `.pnpm/...` path so pnpm v10+ virtual-store layouts no longer fail the image build. (#67143) thanks @ly85206559.
- Matrix/E2EE: keep startup bootstrap conservative for passwordless token-auth bots, still attempt the guarded repair pass without requiring `channels.matrix.password`, and document the remaining password-UIA limitation. (#66228) Thanks @SARAMALI15792.
- Matrix/commands: skip DM pairing-store reads on room traffic now that room control-command authorization ignores pairing-store entries, keeping the room path narrower without changing room auth behavior. (#67325) Thanks @gumadeiras.

## 2026.4.15-beta.1

### Changes

- QA/Matrix: split Matrix live QA into a source-linked `qa-matrix` runner and keep repo-private `qa-*` surfaces out of packaged and published builds. (#66723) Thanks @gumadeiras.

### Fixes

- Matrix/security: normalize sandboxed profile avatar params, preserve `mxc://` avatar URLs, and surface gmail watcher stop failures during reload. (#64701) Thanks @slepybear.
- Docker/build: verify `@matrix-org/matrix-sdk-crypto-nodejs` native bindings with `find` under `node_modules` instead of a hardcoded `.pnpm/...` path so pnpm v10+ virtual-store layouts no longer fail the image build. (#67143) Thanks @ly85206559.
- Matrix/E2EE: keep startup bootstrap conservative for passwordless token-auth bots, still attempt the guarded repair pass without requiring `channels.matrix.password`, and document the remaining password-UIA limitation. (#66228) Thanks @SARAMALI15792.
- Matrix/commands: skip DM pairing-store reads on room traffic now that room control-command authorization ignores pairing-store entries, keeping the room path narrower without changing room auth behavior. (#67325) Thanks @gumadeiras.
- Matrix/security: block DM pairing-store entries from authorizing room control commands. (#67294) Thanks @pgondhi987.

## 2026.4.12

### Changes

- Matrix/partial streaming: add MSC4357 live markers to draft preview sends and edits so supporting Matrix clients can render a live/typewriter animation and stop it when the final edit lands. (#63513) Thanks @TigerInYourDream.

### Fixes

- Matrix/mentions: keep room mention gating strict while accepting visible `@displayName` Matrix URI labels, so `requireMention` works for non-OpenClaw Matrix clients again. (#64796) Thanks @hclsys.
- Channels/replay dedupe: standardize replay claims, retryable-failure release, and post-success commit behavior across Telegram, Discord, Slack, Mattermost, WhatsApp, Matrix, LINE, Feishu, Zalo, Nextcloud Talk, TLON, Nostr, Voice Call, and shared plugin interactive callbacks so duplicate deliveries stay reply-once after success but retry cleanly after pre-delivery failures. Thanks @vincentkoc.

## 2026.4.10

### Changes

- QA/Matrix: add a live `openclaw qa matrix` lane backed by a disposable Matrix homeserver, shared live-transport seams, and Matrix-specific transport coverage for threading, reactions, restart, and allowlist behavior. (#64489) Thanks @gumadeiras.
- Matrix/partial streaming: add MSC4357 live markers to draft preview sends and edits so supporting Matrix clients can render a live/typewriter animation and stop it when the final edit lands. (#63513) Thanks @TigerInYourDream.

### Fixes

- Gateway/thread routing: preserve Slack, Telegram, Mattermost, Matrix, ACP, restart-sentinel, and agent announce delivery targets so subagent, cron, stream-relay, session fallback, and restart messages land back in the originating thread, topic, or room casing. (#54840, #57056, #63143, #63228, #63506, #64343, #64391)
- Matrix: keep multi-account room scoping consistent, keep packaged crypto migrations warning-only when appropriate, preserve ordered block streaming, add explicit Matrix block-streaming opt-in, and resolve verification/bootstrap from the packaged runtime entry. (#58449, #59249, #59266, #64373) Thanks @gumadeiras.
- Matrix/migration: keep packaged warning-only crypto migrations from being misclassified as actionable when only helper chunks are present, so startup and doctor stay on the warning-only path instead of creating unnecessary migration snapshots. (#64373) Thanks @gumadeiras.
- Matrix/ACP thread bindings: preserve canonical room casing and parent conversation routing during ACP session spawn so mixed-case room ids bind correctly from top-level rooms and existing Matrix threads. (#64343) Thanks @gumadeiras.

## 2026.4.9

### Fixes

- Matrix/gateway: wait for Matrix sync readiness before marking startup successful, keep Matrix background handler failures contained, and route fatal Matrix sync stops through channel-level restart handling instead of crashing the whole gateway. (#62779) Thanks @gumadeiras.
- Matrix/doctor: migrate legacy `channels.matrix.dm.policy: "trusted"` configs back to compatible DM policies during `openclaw doctor --fix`, preserving explicit `allowFrom` boundaries as `allowlist` and defaulting empty legacy configs to `pairing`. (#62942) Thanks @lukeboyett.

## 2026.4.8

### Fixes

- Bundled channels/setup: load shared secret contracts through packaged top-level sidecars across BlueBubbles, Feishu, Google Chat, IRC, Matrix, Mattermost, Microsoft Teams, Nextcloud Talk, Slack, and Zalo so installed npm builds no longer rely on missing `dist/extensions/*/src/*` files during gateway startup.

## 2026.4.7

### Fixes

- Matrix/onboarding: add an invite auto-join setup step with explicit off warnings and strict stable-target validation so new Matrix accounts stop silently ignoring invited rooms and fresh DM-style invites unless operators opt in. (#62168) Thanks @gumadeiras.
- Matrix/formatting: preserve multi-paragraph and loose-list rendering in Element so numbered and bulleted Markdown keeps their content attached to the correct list item. (#60997) Thanks @gucasbrg.
- Matrix/agents: hide owner-only `set-profile` from embedded agent channel-action discovery so non-owner runs stop advertising profile updates they cannot execute. (#62662) Thanks @eleqtrizit.

## 2026.4.5

### Changes

- Matrix/exec approvals: add Matrix-native exec approval prompts with account-scoped approvers, channel-or-DM delivery, and room-thread aware resolution handling. (#58635) Thanks @gumadeiras.
- Matrix/exec approvals: clarify unavailable-approval replies so Matrix no longer claims chat approvals are unsupported when native exec approvals are merely unconfigured. (#61424) Thanks @gumadeiras.

### Fixes

- Matrix/exec approvals: anchor seeded approval reactions to the primary Matrix prompt event, resolve them from event metadata instead of prompt text, and clean up chunked approval prompts correctly. (#60931) Thanks @gumadeiras.
- Matrix: recover more reliably when secret storage or recovery keys are missing by recreating secret storage during repair and backup reset, hold crypto snapshot locks during persistence, and surface explicit too-large attachment markers. (#59846, #59851, #60599, #60289) Thanks @al3mart, @emonty, and @efe-arv.
- Matrix/DM sessions: add `channels.matrix.dm.sessionScope`, shared-session collision notices, and aligned outbound session reuse so separate Matrix DM rooms can keep distinct context when configured. (#61373) Thanks @gumadeiras.
- Matrix: move legacy top-level `avatarUrl` into the default account during multi-account promotion and keep env-backed account setup avatar config persisted. (#61437) Thanks @gumadeiras.
- Matrix/streaming: add a quiet preview mode for streamed Matrix replies, keep legacy `partial` preview-first behavior, and finalize quiet media captions correctly so previews stop notifying early without dropping final text semantics. (#61450) Thanks @gumadeiras.
- Matrix: keep direct transport requests on the pinned dispatcher by routing them through undici runtime fetch, so Matrix clients resume syncing on newer runtimes without dropping the validated address binding. (#61595) Thanks @gumadeiras.
- Matrix: avoid failing startup when token auth already knows the user ID but still needs optional device metadata, retry transient auth bootstrap requests, and backfill missing device IDs after startup while keeping unknown-device storage reuse conservative until metadata is repaired. (#61383) Thanks @gumadeiras.
- Matrix: pass configured `deviceId` through health probes and keep probe-only client setup out of durable Matrix storage, so health checks preserve the correct device identity without rewriting `storage-meta.json` or related probe state on disk. (#61581) Thanks @MoerAI.
- Matrix/plugin loading: ship and source-load the crypto bootstrap runtime sidecar correctly so current `main` stops warning about failed Matrix bootstrap loads and `matrix/index` plugin-id mismatches on every invocation. (#53298) thanks @keithce.
- Plugins/Matrix: mirror the Matrix crypto WASM runtime dependency into the root packaged install and enforce root/plugin dependency parity so bundled Matrix E2EE crypto resolves correctly in shipped builds. (#57163) Thanks @gumadeiras.
- Plugins/CLI: add descriptor-backed lazy plugin CLI registration so Matrix can keep its CLI module lazy-loaded without dropping `openclaw matrix ...` from parse-time command registration. (#57165) Thanks @gumadeiras.
- Matrix/delivery recovery: treat Synapse `User not in room` replay failures as permanent during startup recovery so poisoned queued messages move to `failed/` instead of crash-looping Matrix after restart. (#57426) thanks @dlardo.
- Doctor/plugins: skip false Matrix legacy-helper warnings when no migration plans exist, and keep bundled `enabledByDefault` plugins in the gateway startup set. (#57931) Thanks @dinakars777.
- Matrix/CLI send: start one-off Matrix send clients before outbound delivery so `openclaw message send --channel matrix` restores E2EE in encrypted rooms instead of sending plain events. (#57936) Thanks @gumadeiras.
- Matrix/direct rooms: stop trusting remote `is_direct`, honor explicit local `is_direct: false` for discovered DM candidates, and avoid extra member-state lookups for shared rooms so DM routing and repair stay aligned. (#57124) Thanks @w-sss.
- Matrix/direct rooms: recover fresh auto-joined 1:1 DMs without eagerly persisting invite-only `m.direct` mappings, while keeping named, aliased, and explicitly configured rooms on the room path. (#58024) Thanks @gumadeiras.

## 2026.4.2

### Changes

- Matrix/plugin: emit spec-compliant `m.mentions` metadata across text sends, media captions, edits, poll fallback text, and action-driven edits so Matrix mentions notify reliably in clients like Element. (#59323) Thanks @gumadeiras.

## 2026.4.1-beta.1

### Notes

- Matrix/onboarding: restore guided setup in `openclaw channels add` and `openclaw configure --section channels`, while keeping custom plugin wizards on the shared `setupWizard` seam. (#59462) Thanks @gumadeiras.
- Matrix/streaming: keep live partial previews for the current assistant block while preserving completed block updates as separate messages when `channels.matrix.blockStreaming` is enabled. (#59384) Thanks @gumadeiras.

## 2026.3.31

### Changes

- Matrix/history: add optional room history context for Matrix group triggers via `channels.matrix.historyLimit`, with per-agent watermarks and retry-safe snapshots so failed trigger retries do not drift into newer room messages. (#57022) thanks @chain710.
- Matrix/network: add explicit `channels.matrix.proxy` config for routing Matrix traffic through an HTTP(S) proxy, including account-level overrides and matching probe/runtime behavior. (#56931) thanks @patrick-yingxi-pan.
- Matrix/streaming: add draft streaming so partial Matrix replies update the same message in place instead of sending a new message for each chunk. (#56387) Thanks @jrusz.
- Matrix/threads: add per-DM `threadReplies` overrides and keep thread session isolation aligned with the effective room or DM thread policy from the triggering message onward. (#57995) thanks @teconomix.

### Fixes

- Doctor/plugins: skip false Matrix legacy-helper warnings when no migration plans exist, and keep bundled `enabledByDefault` plugins in the gateway startup set. (#57931) Thanks @dinakars777.

## 2026.3.31-beta.1

### Fixes

- Matrix/CLI send: start one-off Matrix send clients before outbound delivery so `openclaw message send --channel matrix` restores E2EE in encrypted rooms instead of sending plain events. (#57936) Thanks @gumadeiras.
- Matrix/context: filter fetched room context by sender allowlists so reply and thread context lookup no longer pulls non-allowlisted messages into agent context. (#58376) Thanks @jacobtomlinson.
- Matrix/delivery recovery: treat Synapse `User not in room` replay failures as permanent during startup recovery so poisoned queued messages move to `failed/` instead of crash-looping Matrix after restart. (#57426) thanks @dlardo.
- Matrix/direct rooms: recover fresh auto-joined 1:1 DMs without eagerly persisting invite-only `m.direct` mappings, while keeping named, aliased, and explicitly configured rooms on the room path. (#58024) Thanks @gumadeiras.
- Matrix/direct rooms: stop trusting remote `is_direct`, honor explicit local `is_direct: false` for discovered DM candidates, and avoid extra member-state lookups for shared rooms so DM routing and repair stay aligned. (#57124) Thanks @w-sss.
- Matrix/DM threads: keep strict unnamed fresh-invite rooms promotable even when Matrix omits the optional direct hint, preserve repair-failed local DM promotions while still revalidating later room metadata, and keep both bound and thread-isolated Matrix sessions reporting the correct route policy. (#58099) Thanks @gumadeiras.
- Matrix/plugin loading: ship and source-load the crypto bootstrap runtime sidecar correctly so current `main` stops warning about failed Matrix bootstrap loads and `matrix/index` plugin-id mismatches on every invocation. (#53298) thanks @keithce.
- Plugins/CLI: add descriptor-backed lazy plugin CLI registration so Matrix can keep its CLI module lazy-loaded without dropping `openclaw matrix ...` from parse-time command registration. (#57165) Thanks @gumadeiras.
- Plugins/Matrix: mirror the Matrix crypto WASM runtime dependency into the root packaged install and enforce root/plugin dependency parity so bundled Matrix E2EE crypto resolves correctly in shipped builds. (#57163) Thanks @gumadeiras.

## 2026.3.28

### Changes

- Plugins/Matrix TTS: send auto-TTS replies as native Matrix voice bubbles instead of generic audio attachments. (#37080) thanks @Matthew19990919.

### Fixes

- Matrix/replies: include quoted poll question/options in inbound reply context so the agent sees the original poll content when users reply to Matrix poll messages. (#55056) Thanks @alberthild.
- Matrix/plugins: keep plugin bootstrap from crashing when built runtime mixes bare and deep `matrix-js-sdk` entrypoints, so unrelated channels do not get taken down during plugin load. (#56273) Thanks @aquaright1.
- Matrix: keep separate 2-person rooms out of DM routing after `m.direct` seeds successfully, while still honoring explicit `is_direct` state and startup fallback recovery. (#54890) thanks @private-peter
- Plugins/Matrix: preserve sender filenames for inbound media by forwarding `originalFilename` to `saveMediaBuffer`. (#55692) thanks @esrehmki.
- Matrix/mentions: recognize `matrix.to` mentions whose visible label uses the bot's room display name, so `requireMention: true` rooms respond correctly in modern Matrix clients. (#55393) thanks @nickludlam.
- Plugins/Matrix: prefer explicit DM signals when choosing outbound direct rooms and routing unmapped verification summaries, so strict 2-person fallback rooms do not outrank the real DM. (#56076) thanks @gumadeiras
- Plugins/Matrix: resolve env-backed `accessToken` and `password` SecretRefs against the active Matrix config env path during startup, and officially accept SecretRef `accessToken` config values. (#54980) thanks @kakahu2015.
- Plugins/Matrix: load bundled `@matrix-org/matrix-sdk-crypto-nodejs` through `createRequire(...)` so E2EE media send and receive keep the package-local native binding lookup working in packaged ESM builds. (#54566) thanks @joelnishanth.
- Plugins/Matrix: encrypt E2EE image thumbnails with `thumbnail_file` while keeping unencrypted-room previews on `thumbnail_url`, so encrypted Matrix image events keep thumbnail metadata without leaking plaintext previews. (#54711) thanks @frischeDaten.

## 2026.3.23

### Fixes

- Plugins/bundled runtimes: ship bundled plugin runtime sidecars like WhatsApp `light-runtime-api.js`, Matrix `runtime-api.js`, and other plugin runtime entry files in the npm package again, so global installs stop failing on missing bundled plugin runtime surfaces.
- Plugins/Matrix: avoid duplicate `resolveMatrixAccountStringValues` runtime-api exports under Jiti so bundled Matrix installs no longer crash at startup with `Cannot redefine property: resolveMatrixAccountStringValues`. Fixes #52909 and #52891. Thanks @vincentkoc.

## 2026.3.22

### Breaking

- Plugins/Matrix: add a new Matrix plugin backed by the official `matrix-js-sdk`. If you are upgrading from the previous public Matrix plugin, follow the migration guide: https://docs.openclaw.ai/install/migrating-matrix Thanks @gumadeiras.
- Plugins/Matrix: stop mention-gated or otherwise dropped room chatter from refreshing focused thread bindings before the message is actually routed, so idle ACP and session bindings can still expire normally in mention-required rooms. Thanks @vincentkoc, @dinakars777 and @mvanhorn.
- Plugins/Matrix: durably dedupe inbound room events across gateway restarts so previously handled Matrix messages are not replayed as new, while preserving clean-restart backlog delivery for unseen events. (#50922) thanks @gumadeiras

### Changes

- Plugins/Matrix: add `allowBots` room policy so configured Matrix bot accounts can talk to each other, with optional mention-only gating. Thanks @gumadeiras.
- Plugins/Matrix: add per-account `allowPrivateNetwork` opt-in for private/internal homeservers, while keeping public cleartext homeservers blocked. Thanks @gumadeiras.

### Fixes

- Plugins/Matrix: move bundled plugin `KeyedAsyncQueue` imports onto the stable `plugin-sdk/core` surface so Matrix Docker/runtime builds do not depend on the brittle keyed-async-queue subpath. Thanks @ecohash-co and @vincentkoc.
- Doctor/extensions: keep Matrix DM `allowFrom` repairs on the canonical `dm.allowFrom` path and stop treating Zalouser group sender gating as if it fell back to `allowFrom`, so doctor warnings and `--fix` stay aligned with runtime access control. Thanks @vincentkoc.
- Matrix: make onboarding status runtime-safe (#49995) Thanks @joshavant.
- Plugins/Matrix: accept shared send-tool media aliases (`mediaUrl`, `filePath`, `path`) and preserve `asVoice` / `audioAsVoice` through Matrix action dispatch so media-only sends and voice-message intents reach the plugin send layer correctly. Thanks @psacc and @vincentkoc.
