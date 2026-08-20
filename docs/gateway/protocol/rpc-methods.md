---
summary: "RPC method families, discovery, session list bootstrap, and event families"
read_when:
  - Looking up a gateway RPC method and its scope
  - Bootstrapping a session list or subscribing to event families
  - Implementing node helper methods or exec lifecycle handling
title: "Gateway protocol RPC methods"
sidebarTitle: "RPC methods"
doc-schema-version: 1
---

The gateway method surface, grouped into families, plus the session list bootstrap, the common event families, and the node helper and exec lifecycle contracts.

## RPC method families

`hello-ok.features.methods` is a conservative discovery list built from
`src/gateway/server-methods-list.ts` plus loaded plugin/channel method
exports — it is not a generated dump of every method, and some methods (for
example `push.test`, `web.login.start`, `web.login.wait`, `sessions.usage`)
are intentionally excluded from discovery even though they are real, callable
methods. Treat this as feature discovery, not a full enumeration of
`src/gateway/server-methods/*.ts`.

<AccordionGroup>
  <Accordion title="System and identity">
    - `health` returns the cached or freshly probed gateway health snapshot.
    - `diagnostics.stability` returns the recent bounded diagnostic stability recorder: event names, counts, byte sizes, memory readings, queue/session state, channel/plugin names, session ids. No chat text, webhook bodies, tool outputs, raw request/response bodies, tokens, cookies, or secrets. Requires `operator.read`.
    - `status` returns the `/status`-style gateway summary; sensitive fields only for admin-scoped operator clients.
    - `gateway.identity.get` returns the gateway device identity used by relay and pairing flows.
    - `system-presence` returns the current presence snapshot for connected operator/node devices.
    - `system-event` appends a system event and can update/broadcast presence context.
    - `last-heartbeat` returns the latest persisted heartbeat event.
    - `set-heartbeats` toggles heartbeat processing on the gateway.
    - `gateway.restart.preflight` is a deprecated, read-only compatibility preview of restart-specific active work. It does not close admission, create a suspension lease, or provide the atomic full-work fence of `gateway.suspend.prepare`; new restart flows should call `gateway.restart.request`.
    - `gateway.suspend.prepare` creates a short cooperative-suspension lease only when tracked Gateway work is idle. While prepared, authenticated WebSocket connects remain available, but only `gateway.suspend.*` and an exact targeted non-safe `gateway.restart.request` may run; safe and untargeted restarts remain fenced. `gateway.suspend.status` checks the lease, and `gateway.suspend.resume` releases it after thaw or an aborted host operation.

  </Accordion>

  <Accordion title="Models and usage">
    - `models.list` returns the runtime-allowed model catalog. See "`models.list` views" below.
    - `usage.status` returns provider usage windows/remaining quota summaries. Clients advertising `usage-refreshing` receive an immediate `refreshing: true` placeholder on a cold cache and must refetch on a bounded schedule; other callers block for the cold provider read.
    - `usage.cost` returns aggregated cost usage summaries for a date range. Pass `agentId` for one agent, or `agentScope: "all"` to aggregate configured agents.
    - `doctor.memory.status` returns vector-memory / cached embedding readiness for the active default agent workspace. Pass `{ "probe": true }` or `{ "deep": true }` only for an explicit live embedding provider ping. Pass `{ "agentId": "agent-id" }` to scope Dreaming store stats to one agent workspace; omitting it aggregates configured Dreaming workspaces.
    - `doctor.memory.dreamDiary`, `doctor.memory.backfillDreamDiary`, `doctor.memory.resetDreamDiary`, `doctor.memory.resetGroundedShortTerm`, `doctor.memory.repairDreamingArtifacts`, and `doctor.memory.dedupeDreamDiary` accept optional `{ "agentId": "agent-id" }`; omitted, they operate on the configured default agent workspace.
    - `sessions.usage` returns per-session usage summaries. Pass `agentId` for one agent, or `agentScope: "all"` to list configured agents together.
      Both usage methods accept `mode: "specific"` with an IANA `timeZone` for DST-aware calendar-day boundaries and buckets. `utcOffset` remains supported for older clients and as a fallback when the Gateway runtime does not recognize the requested zone.
    - `sessions.usage.timeseries` returns timeseries usage for one session.
    - `sessions.usage.logs` returns usage log entries for one session.

  </Accordion>

  <Accordion title="Channels and login helpers">
    - `channels.status` returns built-in + bundled channel/plugin status summaries.
    - `channels.start` (`operator.admin`) starts one channel account runtime without re-authenticating. Params `{ channel, accountId? }`; omitted `accountId` selects the default account. Responds `{ channel, accountId, started, outcome }`, with `started` true only when the resulting runtime snapshot reports `running: true`. `outcome` carries the account lifecycle decision: `{ status: "handed-off" }`, `{ status: "retry", reason }`, or `{ status: "skipped", reason }`. The RPC is a manual override of automatic-start suppression; no `manual` parameter is accepted. This is not a provider-connectivity check; see [Per-account recovery](/cli/channels#per-account-recovery-non-destructive) for reasons and recovery guidance.
    - `channels.stop` (`operator.admin`) stops one channel account runtime without clearing auth state. Params `{ channel, accountId? }`; omitted `accountId` selects the default account. Responds `{ channel, accountId, stopped }`, with `stopped` true when the resulting runtime snapshot does not report `running: true`. Unlike `channels.logout`, it retains the account's credentials.
    - `channels.logout` logs out a specific channel/account where the channel supports it.
    - `web.login.start` starts a QR/web login flow. Params include optional `{ channel, accountId, force, timeoutMs, verbose }`. When `channel` is present, the Gateway normalizes its canonical id or alias and dispatches only to that installed channel plugin. Omitting `channel` preserves the legacy behavior of selecting the first loaded QR-capable provider. A provider may return an opaque `sessionKey` with its QR response.
    - `web.login.wait` waits for that flow to complete and starts the channel on success. Params include optional `{ channel, accountId, sessionKey, timeoutMs, currentQrDataUrl }`. Use the same `channel` as `web.login.start` and pass its returned `sessionKey` through unchanged so the provider can correlate the wait request with the QR session. Omitting `channel` retains the same legacy provider fallback as `web.login.start`.
    - `push.test` sends a test APNs push to a registered iOS node.
    - `voicewake.get` returns the stored wake-word triggers.
    - `voicewake.set` updates wake-word triggers and broadcasts the change.

  </Accordion>

  <Accordion title="Plugin management">
    - `plugins.list` (`operator.read`) returns the installed plugin inventory plus locally curated official picks, diagnostics, and whether the current install mode allows mutations.
    - `plugins.search` (`operator.read`) searches installable ClawHub code-plugin and bundle-plugin families. Pass non-empty `query` and optional `limit` from 1 to 100.
    - `plugins.install` (`operator.admin`) installs either an official catalog entry with `{ source: "official", pluginId, acknowledgeInstallPolicyWarning? }` or a ClawHub package with `{ source: "clawhub", packageName, version?, acknowledgeInstallPolicyWarning? }`. When install policy returns `warn`, the error `details` include `installPolicyCode: "install_policy_warning_acknowledgement_required"`, the target, reason, and optional findings. After review, retrying the same action with `acknowledgeInstallPolicyWarning: true` approves every warning in that install invocation; each warning is freshly evaluated before installation continues. `block` and policy failures remain terminal. ClawHub installs preserve Gateway trust and integrity checks. Successful installs require a Gateway restart.
    - `plugins.setEnabled` (`operator.admin`) changes one installed plugin's enabled policy with `{ pluginId, enabled }`. The response includes the updated catalog entry, restart metadata, and any slot-selection warnings.
    - `plugins.uninstall` (`operator.admin`) removes one externally installed plugin with `{ pluginId }`: config references, the install record, and managed files. Bundled plugins cannot be uninstalled, only disabled. The response lists the removal actions and always requires a Gateway restart.

  </Accordion>

  <Accordion title="Messaging and logs">
    - `send` is the direct outbound-delivery RPC for channel/account/thread-targeted sends outside the chat runner.
    - `logs.tail` returns the configured gateway file-log tail with cursor/limit and max-byte controls.

  </Accordion>

  <Accordion title="Operator terminal">
    - `terminal.open` starts a host PTY for an explicit `agentId` or the default agent and returns the resolved agent, working directory, shell, and confinement state. Passing `sessionKey` binds the PTY to that exact agent session and attaches the calling connection as its first viewer; omitting it creates a connection-owned operator terminal.
    - `terminal.input` and `terminal.resize` operate on sessions owned by the calling connection and agent-owned sessions where that connection is an attached viewer. `terminal.close` kills a connection-owned session, but only detaches the calling viewer from an established agent-owned session. For a new session-bound Control UI terminal, the initiating viewer's close or disconnect discards the PTY until the browser or exact-session agent first adopts it through an authorized operation.
    - `terminal.upload` accepts one base64 file up to 16 MiB, stages it in a private 24-hour temporary directory on the session's Gateway or paired-node host, and returns the absolute path. The caller must still paste or otherwise use that path; the RPC never writes terminal input or executes a command.
    - `terminal.data` and `terminal.exit` events stream to the connection owner and attached viewers. Conversation-owned terminals remain persistent. The agent-facing `terminal` tool can list, read, resize, or close only terminals an operator opened for its exact session; it cannot open terminals. Agent input follows effective session and exec policy: `full` (YOLO) sends immediately, `guarded` and `workspace` (including accept-only or Guardian-reviewed flows) require explicit one-time approval of that exact input, and `read-only` or `deny` blocks it.
    - Connection-owned sessions whose connection drops are detached, not killed: they stay reattachable for `gateway.terminal.detachedSessionTimeoutSeconds` (default 300; `0` restores kill-on-disconnect) while recent output accumulates in a bounded server-side buffer. Established agent-owned sessions likewise survive viewer disconnect.
    - `terminal.list` returns attachable sessions. `terminal.attach` returns the replay buffer and either rebinds a connection-owned session (tmux-style take-over — a previous live owner receives `terminal.exit` with reason `detached`) or adds the connection as a viewer of an agent-owned session.
    - Every terminal method requires `operator.admin`; `gateway.terminal.enabled` is on by default and refuses every method when set to `false`. Fully sandboxed agents are refused, and an agent policy change closes existing and in-flight PTYs, detached ones included.

  </Accordion>

  <Accordion title="Talk and TTS">
    - `talk.catalog` returns the read-only Talk provider catalog for speech, streaming transcription, and realtime voice: canonical provider ids, registry aliases, labels, configured state, an optional group-level `ready` result, exposed model/voice ids, canonical modes, transports, brain strategies, and realtime audio/capability flags, without returning provider secrets or mutating global config. Current gateways set `ready` after applying runtime provider selection; treat its absence as unverified on older gateways.
    - `talk.config` returns the effective Talk config payload; `includeSecrets` requires `operator.talk.secrets` (or `operator.admin`).
    - `talk.session.create` (`operator.talk`) creates a gateway-owned Talk session for `realtime/gateway-relay`, `transcription/gateway-relay`, or `stt-tts/managed-room`. For `stt-tts/managed-room`, non-admin callers that pass `sessionKey` must also pass `spawnedBy` for scoped session-key visibility; unscoped `sessionKey` creation and `brain: "direct-tools"` require `operator.admin`.
    - `talk.session.appendAudio` appends base64 PCM input audio to gateway-owned realtime relay and transcription sessions.
    - `talk.session.cancelOutput` stops assistant audio output, primarily for VAD-gated barge-in in gateway relay sessions. Send the current `talk.event.turnId`; the result is `applied`, `stale`, or `idle`.
    - `talk.session.submitToolResult` completes a provider tool call emitted by a gateway-owned realtime relay session. The request waits for any asynchronous completion signal exposed by the provider bridge; failed submissions keep the linked run active and do not emit a successful tool-result event. Pass `options: { willContinue: true }` for interim tool output or `options: { suppressResponse: true }` when the provider bridge advertises suppression support and the result should not start another response.
    - `talk.session.steer` sends active-run voice control into a gateway-owned agent-backed Talk session: `{ sessionId, text, mode? }`, where `mode` is `status`, `steer`, `cancel`, or `followup`; omitted mode is classified from the spoken text. It selects only work bound to that logical voice call, not another call sharing the connection and agent session.
    - `talk.session.close` closes a gateway-owned relay, transcription, or managed-room session and emits terminal Talk events.
    - `talk.mode` sets/broadcasts the current Talk mode state for WebChat/Control UI clients.
    - `talk.client.create` creates or resumes a client-owned realtime provider session using `webrtc` or `provider-websocket` while the gateway owns credentials, instructions, tool policy, and the returned `voiceSessionId`. Clients pass `sessionKey` and reuse `voiceSessionId` when replacing the provider transport during one call. Clients that negotiate `gateway-control-v1` keep WebRTC media direct but move the provider control channel and tool lifecycle to the Gateway.
    - `talk.client.transcript` appends one finalized `{ role, text }` item to the normal agent session. The required `entryId` is idempotent within `voiceSessionId`; retries do not duplicate transcript messages.
    - `talk.client.close` closes the logical voice session after pending transcript writes. Closing is idempotent and may deliver a mutation-only call digest to the session's last non-WebChat channel.
    - `talk.client.toolCall` lets client-owned realtime transports forward provider tool calls to gateway policy. The first supported tool is `openclaw_agent_consult`; clients get `runId`, `agentId`, and canonical `agentSessionKey` and wait for normal chat lifecycle events before submitting the provider-specific tool result. Use the returned target for `chat.abort` and `chat.history`; keep the original key for voice-session requests. Voice-bound high-impact actions return `VOICE_CONFIRMATION_REQUIRED:<id>` until a later finalized user utterance explicitly confirms that exact final execution action and the next consult supplies the `confirmationId`; policy or hook rewrites require confirmation again.
    - `talk.client.steer` sends session-scoped active-run voice control for client-owned realtime transports. The gateway resolves owned active work from `sessionKey`, without a voice call ID, and returns a structured accepted/rejected result instead of silently dropping steering. Provider-attached Gateway controls are call-scoped instead.
    - `talk.event` is the single Talk event channel for realtime, transcription, STT/TTS, managed-room, telephony, and meeting adapters.
    - `talk.speak` synthesizes speech through the active Talk speech provider.
    - `tts.status` returns TTS enabled state, active provider, fallback providers, and provider config state.
    - `tts.providers` returns the visible TTS provider inventory.
    - `tts.enable` and `tts.disable` toggle TTS prefs state.
    - `tts.setProvider` updates the preferred TTS provider.
    - `tts.convert` runs one-shot text-to-speech conversion.
    - `tts.speak` (`operator.write`) renders non-empty `text` with the configured general TTS provider chain and returns one whole clip inline as `audioBase64`, plus `provider` and optional `outputFormat`, `mimeType`, and `fileExtension` metadata. Unlike `tts.convert`, it does not return a Gateway-local path; unlike `talk.speak`, it does not require a Talk provider. Text above `tts.maxTextLength` returns `INVALID_REQUEST`; synthesis failures return `UNAVAILABLE`.

  </Accordion>

  <Accordion title="Secrets, config, update, and wizard">
    - `secrets.reload` re-resolves active SecretRefs and atomically publishes owner-aware runtime state. Eligible owner failures can publish as cold or stale degradation with `warningCount`; strict or unmapped failures reject the reload and preserve the active snapshot.
    - `secrets.resolve` resolves command-target secret assignments for a specific command/target set.
    - `secrets.store.list` (`operator.admin`) returns team-scoped metadata and values only for `kind: "env"` entries. `kind: "secret"` entries use a distinct result shape with no value field; there is no reveal method.
    - `secrets.store.set` and `secrets.store.delete` (`operator.admin`) create/update or soft-delete one team-scoped entry. After a successful write, the Gateway refreshes the active secrets runtime only when the name is referenced by a `store` SecretRef in the active source config.
    - `config.get` returns the current on-disk config snapshot, raw root-file `hash`, resolved `configRevisionHash`, and optional `appliedConfigHash` for the resolved revision accepted by the active Gateway runtime.
    - `config.set` writes a validated config payload.
    - `config.patch` merges a partial config update. Destructive array replacement requires the affected path in `replacePaths`; nested arrays under array entries use `[]` paths such as `agents.entries.*.skills`.
    - `config.apply` validates + replaces the full config payload.
    - `config.schema` returns the live config schema payload used by Control UI and CLI tooling: schema, `uiHints`, version, generation metadata, plugin + channel schema metadata when loadable. It includes `title` / `description` metadata from the same labels/help text as the UI, including nested object, wildcard, array-item, and `anyOf` / `oneOf` / `allOf` composition branches when matching field documentation exists.
    - `config.schema.lookup` returns a path-scoped lookup payload for one config path: normalized path, a shallow schema node, matched hint + `hintPath`, optional `reloadKind`, and immediate child summaries for UI/CLI drill-down. `reloadKind` is one of `restart`, `hot`, or `none` (`src/config/schema.ts`) and mirrors the gateway config reload planner for the requested path. Lookup schema nodes keep the user-facing docs and common validation fields (`title`, `description`, `type`, `enum`, `const`, `format`, `pattern`, numeric/string/array/object bounds, `additionalProperties`, `deprecated`, `readOnly`, `writeOnly`). Child summaries expose `key`, normalized `path`, `type`, `required`, `hasChildren`, optional `reloadKind`, plus the matched `hint` / `hintPath`.
    - `update.run` runs the gateway update flow and schedules a restart only if the update succeeded; callers with a session can include `continuationMessage` so startup resumes one follow-up agent turn through the restart continuation queue. Package-manager updates and supervised git-checkout updates from the control plane use a detached managed-service handoff instead of replacing the package tree or mutating checkout/build output inside the live gateway. A started handoff returns `ok: true` with `result.reason: "managed-service-handoff-started"` and `handoff.status: "started"`. A second concurrent `update.run` handled by the same Gateway process returns `ok: false` with `result.reason: "managed-service-handoff-already-running"` and `handoff.status: "already-running"`; its continuation is not accepted, so the caller can retry after the active update completes. Standalone CLI updaters and replacement Gateway processes are outside this process-local guard. Unavailable or failed handoffs return `ok: false` with `managed-service-handoff-unavailable` or `managed-service-handoff-failed`, plus `handoff.command` when a manual shell update is required. Unavailable means OpenClaw lacks a safe supervisor boundary or durable service identity, such as `OPENCLAW_SYSTEMD_UNIT` for systemd. During a started handoff, the restart sentinel may briefly report `stats.reason: "restart-health-pending"`; the continuation is delayed until the CLI verifies the restarted gateway and writes the final `ok` sentinel.
    - `update.status` refreshes and returns the latest update restart sentinel, including the post-restart running version when available.
    - `wizard.start`, `wizard.next`, `wizard.status`, and `wizard.cancel` expose the onboarding wizard over WS RPC.

  </Accordion>

  <Accordion title="Agent and workspace helpers">
    - `agents.list` returns gateway-visible agent entries, including effective model/runtime metadata and optional semantic `kind` (`agent` or `system`). Entries with recorded creation provenance also include `createdVia` (`operator`, `agent`, or `claw`), nullable `creatorAgentId`, and millisecond `createdAt`; entries without provenance omit those fields. Clients advertise the `agent-kind` handshake capability to receive the complete typed roster; clients without it keep the legacy selector-safe roster without system rows. Kind-aware clients exclude `system` rows from ordinary selectors while retaining them in diagnostic views. Older v4 gateways may return rows without `kind`.
    - `agents.create`, `agents.update`, and `agents.delete` manage agent records and workspace wiring.
    - `claws.monitors` (`operator.admin`, rate-limited as a control-plane write for all phases) supports [Claw removal](/cli/claws#remove-an-installed-claw). Every request includes `binding: { configPath, statePath, cronStorePath }` for the local profile, checked against the serving owner. `{ phase: "inspect", agentId, binding }` returns at most two corroborated config-owned monitor snapshots, each with `id`, `name`, `enabled`, `agentId`, null `ownerAgentId`, `storeKey`, `declarationKey`, and `revision`. `{ phase: "quiesce", agentId, operationId, monitors, binding }` validates the current deletion journal and exact consented snapshots before cancelling scheduled work. `{ phase: "drain", agentId, operationId, binding }` also requires applied agent removal and monitor convergence. Successful quiescence or drainage returns `{ drained: true }`; incomplete drainage returns `UNAVAILABLE` after a five-second wait. The operation id must match the live journal in the serving Gateway's state; it is not standalone cleanup authority. Extra request fields are rejected.
    - `agents.files.list`, `agents.files.get`, and `agents.files.set` manage the bootstrap workspace files exposed for an agent.
    - `audit.activity.list` returns the versioned metadata-only activity ledger; `audit.run.inspect` discovers execution ids or inspects one exact execution identity context; `audit.list` remains the compatibility-safe run/tool RPC.
    - `agents.workspace.list` and `agents.workspace.get` (`operator.read`) expose read-only, paginated browsing of an agent's workspace directory for clients in the trusted operator domain described in [Operator scopes](/gateway/operator-scopes). Requests accept workspace-relative paths only; reads stay confined to the realpathed workspace root (symlink and hardlink escapes rejected), size-capped, and limited to UTF-8 text plus common image types (base64). Responses do not expose the host workspace path. There are no write operations in this namespace.
    - `transcripts.list` (`operator.read`) lists durable meeting captures newest first. Optional `limit` accepts 1–200 (default 50); `providerId` filters the source. The `sessions` result includes selectors, provider/source locators, times, active state, utterance counts, participants, summary availability, optional model/heuristic provenance, and an overview preview capped at 280 characters. Source locators expose only `providerId`, `accountId`, `guildId`, `channelId`, and `meetingUrl`, never free-form metadata.
    - `transcripts.get` (`operator.read`) accepts `selector` and optional `includeUtterances`. It returns the session and stored summary, including its canonical Markdown; requested utterances are sanitized and bounded by the capture limit of 2,000. Missing summaries omit `summary` rather than generating notes. Both transcript methods read across one trusted Gateway domain, like `agents.workspace.*`; separate domains are required for reader isolation. They do not export files or change capture state. See [Transcripts CLI](/cli/transcripts#gateway-and-control-ui-reads).
    - `tasks.list`, `tasks.get`, and `tasks.cancel` expose the gateway task ledger to SDK and operator clients. See [Task ledger RPCs](/gateway/protocol/ledgers#task-ledger-rpcs).
    - `artifacts.list`, `artifacts.get`, and `artifacts.download` expose transcript-derived artifact summaries and downloads for an explicit `sessionKey`, `runId`, or `taskId` scope. Run and task queries resolve the owning session server-side and only return transcript media with matching provenance; unsafe or local URL sources return unsupported downloads instead of fetching server-side.
    - `environments.list` and `environments.status` (`operator.read`) remain available without cloud-worker profiles and preserve gateway-local and node environment discovery. `environments.list` also accepts an optional `runtimeId` from callers with `operator.write`. That request adds one Gateway-owned `requiredNodeCommand` result to each connected node when the runtime requires a node command. Its closed state is `invocable`, `pending-approval`, `undeclared`, or `unauthorized`; it never exposes the node's full pending declaration. Node environments include the durable `sessionHost` identity used to keep a known offline host visible, while current connected inventory is authoritative over that history. Missing identity means false. Exact bounded `{ total, available }` worker slots are live-only and omitted offline; worker-turn admission consumes a slot, while node-backed remote-exec does not. Configured profile summaries expose their bounded, canonically ordered `executionModes` array plus the existing singular `executionMode` primary/default display projection. Current clients select profiles only by membership in `executionModes`. Configured cloud workers and durable records left by earlier profiles add `worker` metadata with `providerId`, optional `leaseId`, `state`, `ageMs`, optional `idleMs`, and `attachedSessionIds`. Worker lifecycle states are `requested`, `provisioning`, `bootstrapping`, `ready`, `attached`, `idle`, `draining`, `destroying`, `destroyed`, `failed`, and `orphaned`. A connected node may also include `workerBundle: { status: "installed", version }` or `workerBundle: { status: "missing" }`. This optional observation is reconnect-scoped and reports validation of one Gateway-retained bundle; it is not launch authority. The public result never exposes the bundle hash, Gateway namespace, node filesystem path, receipt, or protocol-feature details.
    - `environments.create` (`{ profileId, idempotencyKey }`) provisions an environment from a configured plugin provider profile; retries with the same key reuse the durable operation. Direct creation without a session does not select an execution mode, so the provider uses its intentional default; Crabbox prepares `worker-turn`. `environments.destroy` (`{ environmentId }`) requests idempotent teardown of a durable worker environment. Both require `operator.admin`, are control-plane writes, and return the same environment summary shape used by status responses.
    - `worker.desktop.observe` (`{ environmentId, control? }`, `operator.admin`) starts or reuses the environment's desktop forward and returns `{ transport, wsPath, expiresAtMs, control, vncPassword? }`. `wsPath` carries a single-use 60-second token for the Gateway's desktop observer WebSocket; reconnecting requires a fresh observe call. Environments with an observable desktop advertise `worker.desktop: true` in `environments.list`. The method is advertised only when the `cloudWorkers.desktop` lab is enabled. See [Cloud workers](/gateway/cloud-workers#desktop-interactive).
    - `agent.identity.get` returns the effective assistant identity for an agent or session.
    - `agent.wait` waits for a run to finish and returns the terminal snapshot when available.

  </Accordion>

  <Accordion title="Session control">
    - `sessions.list` returns the current session index, including per-row `agentRuntime` metadata when an agent runtime backend is configured. `hasActiveRun` is the authoritative aggregate direct-session activity fact. When projected, `activeRunIds` is the complete exact active set; an empty array proves the session is idle. If aggregate activity is true while the field is omitted, another runtime owner is active but its exact identities are unavailable. Snapshot omission means identities unavailable. On incremental events, omission means no change, `null` is the event-only tombstone that clears cached exact IDs to unavailable, and an array replaces the cache. Clients correlate only exact IDs they own locally or received from requests, history, or events and never select the first list entry as an owner. When cloud-worker placement is enabled or durable recovery state exists, session rows also include a closed `placement` state (`local`, `requested`, `provisioning`, `syncing`, `starting`, `active`, `draining`, `reconciling`, `reclaimed`, or `failed`) plus state-specific environment, owner-epoch, workspace, bundle, ACK-cursor, or recovery fields. Active placements may include an advisory `diskSpace` sample with `status` (`ok`, `warning`, or `critical`), `availableBytes`, `totalBytes`, and `observedAtMs`. An active paired-device placement also includes `runner: { kind: "device", status: "available" | "offline", deviceId? }`; `deviceId` names the paired device hosting the placement (the selected host for `autoDevice` dispatch), and non-device placements omit the field. This availability is process-current, derived from the exact active environment binding and reconnect-scoped node-runner proof, and starts offline after Gateway restart until that runner reconnects. Inventory changes emit `sessions.changed` so clients refresh the canonical row. Rows carry ownership projections — write-once `createdActor`, the mutable `owner` (actor plus `assignedBy`/`assignedAt`), a bounded `participants` list (owner excluded, up to 4 actors), and the full `participantCount`; actor display labels and avatars are resolved from current profiles and agent identities at read time. Pass `creatorId` to filter by immutable `createdActor.id`; pass `ownerId` to filter by the current assignable owner, falling back to `createdActor` when no owner is assigned. The complete `owners` facet is independent of pagination and remains unfiltered by either query, so clients can render the full owner picker. Authenticated callers can pass `involvingMe: true` to keep only sessions the caller owns or has prompted, evaluated against the full participant history (profile-backed human participants only).
    - `sessions.subscribe` enables session change events for the current WebSocket client and accepts the same parameters as `sessions.list` to return an initial list in the same response. Empty `{}` parameters return only the subscription acknowledgment. The subscription ends when that client disconnects. See [Session list bootstrap](/gateway/protocol/rpc-methods#session-list-bootstrap).
    - `sessions.messages.subscribe` and `sessions.messages.unsubscribe` toggle transcript/message event subscriptions for one session. Pass `includeApprovals: true` to also receive sanitized `session.approval` lifecycle events for approvals whose persisted audience includes that exact session and whose reviewer binding authorizes the subscribing client. The subscribe response then includes a bounded pending `approvalReplay`; it is authoritative when `truncated` is false. The opt-in is per subscribe call, not sticky: re-subscribing to the same session without `includeApprovals: true` removes an existing approval subscription. In addition to normal session-read authority, this opt-in requires `operator.admin`, or `operator.approvals` on a paired device.
    - `sessions.preview` returns bounded transcript previews for specific session keys.
    - `sessions.describe` returns one gateway session row for an exact session key.
    - `sessions.github.options`, `sessions.github.publish`, `sessions.github.status`, and `sessions.github.confirm` accept optional `agentId` alongside `sessionKey`. Carry the selected session's agent through all four calls, especially for the shared key `global`, which does not identify its owner. An explicit agent must be configured and match any agent-qualified session key; malformed, unknown, or conflicting owners return `INVALID_REQUEST` before publication. Tool-originated publication remains bound to the tool caller's session and agent.
    - `sessions.resolve` resolves or canonicalizes a session target by key, raw session ID, label, Control UI short ID, or `reference: { key, slug? }`. A reference searches visible active and archived sessions: its exact canonical key wins, then an optional display-name slug is matched against UUID-backed sessions. Reference discovery retains session-list visibility rules; the separate `key` selector retains exact-key read semantics. Ambiguous references and short IDs return at most ten candidates as a successful RPC result. Set `allowMissing: true` to receive `{ ok: false }` when no session matches.
    - `sessions.create` creates a new session entry. When sandbox containment applies, local `cwd` and project paths are checked against the selected agent's canonical workspace: aliases inside it are accepted, and symlinks resolving outside it are rejected. Optional `model`, `contextWindow`, and `thinkingLevel` values persist the initial model, advertised context-window choice, and reasoning overrides atomically; optional `category` assigns the session to a custom group and registers that group when first used. `worktree: true` provisions a managed worktree; optional `worktreeBaseRef`/`worktreeName` select the base ref and branch name, and `execNode` (`operator.admin`) binds session exec to a node host. Without `worktreeName`, OpenClaw derives a readable name from the session label or generated first-message title, then falls back to a crustacean-themed name; names already occupied by another owner, local branch, or unmanaged path receive a numeric suffix. The created worktree is echoed in the result and persisted on the session row (`worktree: { id, branch, repoRoot }`). When the entry is created but its nested initial `chat.send` is rejected, the successful result includes `runStarted: false` and `runError`; clients can preserve the prompt and retry against the returned session key. A caller that passes `parentSessionKey` with `emitCommandHooks: true` should also declare the lifecycle disposition of a distinct child: `succeedsParent: true` ends the parent with `session_end`, while `false` keeps the parent active and emits only the child's `session_start`. Omitting `succeedsParent` preserves the legacy parent-rollover behavior for existing clients. The disposition requires both parent linkage and command hooks; a fork cannot succeed its parent. Main-session reset-in-place behavior is unchanged because no distinct child is created. New rows are stamped with write-once creation provenance (`createdVia`, `createdActor`, `createdAt`) from the trusted creation seam; adopting an existing key never restamps it. For human profile actors, `createdActor.label` is resolved from the current user profile when the row is projected and is never stored on the session entry, so profile renames do not drift. Session rows also carry `parentSessionKey` (navigation parent, persisted), `controlOwnerSessionKey` (runtime controller when live), `forkSource` (exact source key + transcript generation for forks), and `previousSessionId` (prior transcript generation under the same key).
    - `sessions.dispatch` moves an authorized local OpenClaw or Codex session with a live, registry-owned session managed worktree to a paired device or configured cloud profile. Pass `{ key, deviceId, agentId? }` for an explicit device, `{ key, autoDevice: true, agentId? }` for automatic paired-device selection, `{ key, profileId, machineClass?, agentId? }` for an explicit profile, or `{ key, agentId? }` to look up the managed worktree's normalized origin in `cloudWorkers.projectProfiles`. These target modes are mutually exclusive and explicit targets take precedence over project-profile lookup. Automatic selection ranks worker-slot runtimes by available slots and then device ID; runtimes without worker slots use device ID order. If a candidate becomes ineligible during dispatch, up to three ranked candidates are attempted; other errors are not retried. Explicit and automatic device dispatch require `operator.write`; explicit-profile and project-profile dispatch require `operator.admin`. A missing origin, unmatched mapping, or mapping to an unconfigured profile returns a typed `INVALID_REQUEST` without provisioning or falling back to another target. Malformed params use the write scope before schema validation. A missing cloud profile hides only cloud targets; eligible paired-device dispatch remains available. Dispatch closes local turn admission before draining active work and returns only after placement reaches `active`, with worker-child ownership for `worker-turn` or Gateway-owned harness execution for `remote-exec`. Arbitrary plain directories are not dispatchable; after admission, the workspace transport may use manifest mirroring if the managed worktree's Git metadata later becomes unavailable. SSH fallback candidates rotate only for idempotent probes, content-addressed transfers, receipt/lock-guarded artifact installation, convergent managed-worktree mirroring, and tunnel reconnects. Ambiguous unguarded stateful commands fail closed and are not replayed. Dispatch is one-way; worker-to-local pull-back is not part of this RPC.
    - `sessions.reclaim` (`operator.write`) safely stops a session placement by key. It waits for an in-flight dispatch, drains admitted work, reconciles active workspace changes, and retries pending failed-environment teardown through the placement owner. Callers never need raw environment-destroy authority.
    - `sessions.move` moves an authorized active session to the Gateway, a paired device, or a configured profile. Gateway and device targets require `operator.write`; profile targets require `operator.admin`; malformed targets use the write scope before schema validation. The caller supplies the exact observed generation, environment, and owner epoch; session authorization and those source facts are revalidated before the move commits. Ordinary moves always reconcile the source. Only a Gateway target may add `abandonSource: true`, and only when the exact source is a currently offline paired-device placement. That durable decision force-fences and destroys the remote owner, skips remote workspace reconciliation, and continues from the last Gateway-synced state without replay; unsynced files and in-flight work may be lost. Available, unknown, profile, and other-worker sources reject explicit abandonment.
    - `sessions.groups.list`, `sessions.groups.put`, `sessions.groups.rename`, and `sessions.groups.delete` manage the gateway-owned custom session group catalog (names + display order). The read-scoped list result is intentionally path-free. `sessions.groups.defaults` and `sessions.groups.update` require `operator.write` and read or replace one custom group's optional working-directory and worktree defaults. Non-admin callers can save only directories inside a configured agent workspace; other absolute Gateway paths require `operator.admin`. Membership stays on each session's `category` field; rename and delete update member sessions server-side. `sessions.groups.put` replaces only the name list and order, and rejects dropping a group that still has member sessions — delete it explicitly first. Dropping a group participates in the same member-session authorization as delete.
    - `sessions.send` sends a message into an existing session.
    - `sessions.steer` is a deprecated alias for `chat.send` with `queueMode: "interrupt"`; removal follows the protocol deprecation policy.
    - `sessions.abort` aborts active work for a session. Pass `key` plus optional `runId`, or `runId` alone for active runs the gateway can resolve to a session. Supplying `runId` keeps cancellation scoped to that run. Set `clearQueued: true` on a key-only non-global request to also discard followup and lane queues owned by that session. Existing callers that omit `clearQueued` preserve those queues. The literal `global` key keeps the existing agent-qualified `chat.abort` ownership rules and does not perform non-global followup or lane cleanup.
    - `sessions.patch` updates session metadata/overrides and reports the resolved canonical model plus effective `agentRuntime`. `contextWindow` accepts only an id advertised by the selected model's `contextWindows` array; `null` restores `contextWindowDefault`. Session organization fields and the per-session `model` override require `operator.write`; thinking, fast, verbose, trace, reasoning, and other privileged overrides require `operator.admin`. Only an admin model selection can persist as the configured agent default. Archive and restore patches require the caller-observed `sessionId` from `sessions.list` or `sessions.describe` as `expectedSessionId`; missing or changed targets fail without materializing or mutating a replacement. With `archived: true`, the Gateway protects agent main sessions (including `global` when global scope is configured) and the `unknown` sentinel; for every other real session it first fences new admission, cancels exact-session active, pending, queued, reply, embedded, and worker work, and waits for admission and runtime terminal-persistence drains before committing `archivedAt`. A cancellation, drain, or persistence failure returns retryable `UNAVAILABLE` and leaves the session unarchived. `sessions.patchMany` carries `expectedSessionId` per target, prepares archive targets in input order inside the same batch lifecycle fence, and returns ordered per-target outcomes. Spawn lineage (`spawnedBy`, `spawnedWorkspaceDir`, `spawnedCwd`, `spawnDepth`, `subagentRole`, `subagentControlScope`) is no longer publicly patchable; those facts are written once by trusted creation paths, and requests that still send them are rejected.
    - `sessions.assignOwner` (`operator.write`) reassigns the session's mutable owner to a person or configured agent (`{ key, owner: { type, id } }`). It requires an identified caller (authenticated profile or trusted agent identity), authorizes by session visibility, and records `assignedBy`/`assignedAt` on the row's `owner` field. The write-once `createdActor` and creator-anchored sharing authority are unchanged; see [Multi-user mode](/concepts/multi-user#assigning-an-owner).
    - `sessions.reset`, `sessions.delete`, and `sessions.compact` perform session maintenance. `sessions.reset` accepts an optional `expectedSessionId` from `sessions.list` or `sessions.describe`. If that session ID is no longer current when the reset enters its lifecycle fence, the Gateway rejects the request before interrupting work with `INVALID_REQUEST` and `error.details.reason: "session-changed"`; re-read the session before deciding whether to retry. Omitting the field preserves unconditional reset behavior. The guard does not reject changes that keep the same session ID, including metadata edits or another reset-in-place.
    - `sessions.get` returns the full stored session row.
    - Chat execution still uses `chat.history`, `chat.send`, `chat.abort`, and `chat.inject`. Its `sessionInfo` uses the same aggregate `hasActiveRun` and optional complete-exact `activeRunIds` semantics as `sessions.list`. `chat.history` is display-normalized for UI clients: inline directive tags are stripped from visible text, plain-text tool-call XML payloads (`<tool_call>...</tool_call>`, `<function_call>...</function_call>`, `<tool_calls>...</tool_calls>`, `<function_calls>...</function_calls>`, and truncated tool-call blocks) and leaked ASCII/full-width model control tokens are stripped, pure silent-token assistant rows (exact `NO_REPLY` / `no_reply`) are omitted, and oversized rows can be replaced with placeholders.
      Tail responses can include an opaque `deltaCursor`. Pass it back as `cursor` to `chat.history` or `chat.startup` instead of `offset` or `messageId`. A successful catch-up returns `{ kind: "delta", messages, deltaCursor, sessionInfo }`; replay each `messages` entry through the same reducer as a live `session.message` payload. `{ kind: "reset" }` means the cursor is invalid, stale, belongs to another session, crossed a reset or compaction, or is too far behind; fetch a normal tail page. Catch-up never returns a partial page or continuation: more than 200 raw events or the 1 MB payload budget resets to a tail fetch.
    - `chat.message.get` is the additive bounded full-message reader for a single visible transcript entry. Pass `sessionKey`, optional `agentId` when session selection is agent-scoped, and a transcript `messageId` previously surfaced through `chat.history`; the gateway returns the same display-normalized projection without the lightweight history truncation cap when the stored entry is still available and not oversized.
    - `chat.toolTitles` is deprecated. It validates the existing bounded request shape and returns `{ titles: {}, disabled: true }` so older clients stop requesting titles. It makes no model calls and does not access the old title cache. Current Control UI clients display descriptions supplied with tool calls automatically.
    - `chat.send` accepts one-turn `fastMode: "auto"` to use fast mode for model calls started before the auto cutoff, then start later retry, fallback, tool-result, or continuation calls without fast mode. The cutoff defaults to 60 seconds (`DEFAULT_FAST_MODE_AUTO_ON_SECONDS`) and can be configured per model with `agents.defaults.models["<provider>/<model>"].params.fastAutoOnSeconds`. A `chat.send` caller can pass one-turn `fastAutoOnSeconds` to override the cutoff for that request. Pass `queueMode` (`steer`, `followup`, `collect`, or `interrupt`) to override the stored queue mode for this request only; explicit Control UI steer actions use `queueMode: "steer"`. Interrupt mode captures and aborts the session's current admitted turn, waits for that exact owner to settle, then starts the new turn; an idle session starts normally. A steer send targets the selected session's current state: the Gateway atomically injects the message into that session's direct active run, or starts a new turn when the session is idle. Activity in descendant subagent sessions never makes the selected session busy for this decision. `expectedLeafEntryId` is an independent transcript-branch compare-and-swap for non-steer interactive sends: pass the displayed branch leaf (or deliberate `null` for an authoritative empty transcript) and the send rejects with `details.reason: "active-leaf-changed"` if another client switched transcript branches first; steer sends ignore it.

    - `chat.send`, `sessions.send`, and initial-turn `sessions.create` acknowledgments report admission separately from transcript persistence. Optional `messageSeq` is the one-based position from an actual committed user-turn receipt; it is absent while the input exists only in pending custody. `status: "started"` and `runStarted: true` alone do not establish a transcript row. Reconcile provisional input by its submission identity against accepted custody or canonical transcript identity, never a predicted position or matching content.

    - `sessions.create.fastMode` accepts `true`, `false`, or `"auto"` and persists that speed override before the initial turn starts.
    - `sessions.title.prepare` (`{ agentId, message, model?, catalogId?, incognito? }`, `operator.write`, rate-limited as a control-plane write) returns `{ title }` from the selected agent's utility model only, without creating or renaming a session; it returns `title: null` for incognito, empty, slash-command, or unavailable-utility input and never falls back to the primary model. A client passes a ready result as `sessions.create.displayName`: a presentation title stored like a generated first-message title, so it is not unique, never claims `label`, and is ignored when adopting an existing key.

  </Accordion>

  <Accordion title="Device pairing and device tokens">
    - `device.pair.list` returns pending and approved paired devices.
    - `device.pair.setupCode` creates a mobile setup code and, by default, a PNG QR data URL. It requires `operator.admin` and is intentionally omitted from advertised discovery. Current gateways include an opaque non-secret `setupId`, authoritative `expiresAtMs`, `setupCode`, optional `qrDataUrl`, `gatewayUrl`, the non-secret `auth` label, `urlSource`, and the issued `access` level (`full`, `limited`, or `node`). Older protocol-v4 gateways omit `setupId` and `expiresAtMs`, so separately shipped clients must treat those lifecycle fields as optional. The `setupId` is independent from the bootstrap credential and is not embedded in the setup code.
    - `device.pair.setupStatus` reconciles one setup credential the caller already issued (`{ setupId }`). It requires `operator.admin`, is omitted from advertised discovery, and returns either `{ completion }` after the credential-bearing response finishes or `{ deliveryUncertain }` when the bearer was retired but response delivery could not be confirmed. Both use the same non-secret payload as their corresponding events. When both fields are absent, the gateway holds no retained outcome for that `setupId`.
    - `device.pair.approve`, `device.pair.reject`, and `device.pair.remove` manage device-pairing records.
    - `device.pair.rename` assigns an operator label (`{ deviceId, label }`) that is preferred over the client-reported display name and survives device repair or re-approval.
    - `device.token.rotate` rotates a paired device token within its approved role and caller scope bounds.
    - `device.token.revoke` revokes a paired device token within its approved role and caller scope bounds.

    The setup code embeds a short-lived bootstrap credential. Clients must not
    log or persist it beyond the pairing flow.

    Pairing-scoped clients receive `device.pair.setup.completed` only after the
    exact setup handoff has delivered its credentials. Its payload is
    `{ setupId, deviceId, deviceName?, access, ts }`; it never includes the
    bootstrap credential or token-derived identifiers.

    If the response closes before delivery can be confirmed, the gateway keeps
    the bearer retired and emits `device.pair.setup.deliveryUncertain` instead
    of success. The presenting client should offer the operator a path to inspect
    or remove the paired device and generate a new setup code.

    The gateway records an uncertain outcome when it consumes the bearer, then
    promotes it to completion only after response delivery finishes. Operator
    event frames are best effort and drop for slow subscribers rather than
    closing their socket. A client that displayed a setup code must therefore
    call `device.pair.setupStatus` before presenting the code as expired.
    Outcomes are retained past the credential's own expiry.

  </Accordion>

  <Accordion title="Node pairing, invoke, and pending work">
    - `node.pair.list`, `node.pair.approve`, `node.pair.reject`, and `node.pair.remove` cover node capability approvals. `node.pair.request` and `node.pair.verify` were removed in 2026.7 together with the standalone node pairing store; pending requests are created by the Gateway during node connects.
    - `node.list` and `node.describe` return known/connected node state.
    - `node.rename` updates a paired node label.
    - `node.invoke` forwards a command to a connected node.
    - `node.invoke.result` returns the result for an invoke request.
      A node may return `NODE_NOT_READY` only when lifecycle cleanup prevented
      execution, before calling a command handler or emitting progress. The
      Gateway retries this rejection up to four times within the original invoke
      deadline, rechecking the connection, pairing, and command authorization at
      each dispatch. General `UNAVAILABLE` errors, disconnects, timeouts, and
      failures after progress are not retried.
    - `mcp.tools.call.v1` is the headless node-host command for calling a configured node-local MCP tool. It is carried through `node.invoke`, requires the node to declare the command, and remains subject to pairing approval and `gateway.nodes.commands.deny`.
    - `node.event` carries node-originated events back into the gateway.
    - `node.pluginTools.update` is the only publication path for replacing the connected node's agent-visible plugin/MCP tool descriptors; `connect` params do not carry them.
    - `node.pending.pull` and `node.pending.ack` are the connected-node queue APIs.
    - `node.pending.enqueue` and `node.pending.drain` manage durable pending work for offline/disconnected nodes.

  </Accordion>

  <Accordion title="Approval families">
    - `approval.history` returns newest-first terminal approvals retained for 30 days for exec, plugin, and system-agent requests (scope `operator.approvals`). It supports cursor pagination plus an optional kind filter; pending approvals are not history rows. Treat each cursor as an opaque server token and return the exact value without padding, rewriting, or adding fields.
    - `approval.get` and `approval.resolve` are the kind-agnostic durable approval methods (scope `operator.approvals`). `approval.get` returns a sanitized pending or retained terminal projection with a stable `urlPath`; `approval.resolve` accepts the canonical approval id, an explicit `kind`, and a decision, applies first-answer-wins resolution, and always returns the recorded canonical result.
    - `exec.approval.request`, `exec.approval.get`, `exec.approval.list`, and `exec.approval.resolve` cover one-shot exec approval requests plus pending approval lookup/replay. They are protocol-boundary adapters over the same durable approval registry.
    - `exec.approval.waitDecision` waits on one pending exec approval and returns the final decision (or `null` on timeout).
    - `exec.approvals.get` and `exec.approvals.set` manage gateway exec approval policy snapshots.
    - `exec.approvals.node.get` and `exec.approvals.node.set` manage node-local exec approval policy via node relay commands.
    - `plugin.approval.request`, `plugin.approval.list`, `plugin.approval.waitDecision`, and `plugin.approval.resolve` cover plugin-defined approval flows.

  </Accordion>

  <Accordion title="Control UI commands">
    - `ui.command` lets an `operator.write` caller send typed layout and navigation commands to connected Control UI clients that advertise the `ui-commands` capability.
    - Commands cover pane split/close/focus, sidebar visibility, terminal/browser panel visibility and dock, and session navigation.
    - Protocol v1 intentionally fans out to every connected capable Control UI. If none is connected, the request fails with `UNAVAILABLE` instead of pretending the layout changed.

  </Accordion>

  <Accordion title="Automation, skills, and tools">
    - Automation: `wake` schedules an immediate or next-heartbeat wake text injection; `cron.get`, `cron.list`, `cron.status`, `cron.add`, `cron.update`, `cron.remove`, `cron.run`, `cron.runs` manage scheduled work.
    - `cron.run` remains an enqueue-style RPC for manual runs. Clients that need completion semantics should read the returned `runId` and poll `cron.runs`.
    - `cron.runs` accepts an optional non-empty `runId` filter so clients can follow one queued manual run without racing against other history entries for the same job.
    - Skills and tools: `commands.list`, `skills.*`, `tools.catalog`, `tools.effective`, `tools.invoke`. See [Operator helper methods](/gateway/protocol/operator-methods#operator-helper-methods).

  </Accordion>
</AccordionGroup>

### Session list bootstrap

Call `sessions.subscribe` with a non-empty `sessions.list` parameter object, such
as `{ limit: 60, ownerFirst: true }`, to subscribe and load the initial roster in
one request. A successful WebSocket response has the payload
`{ subscribed: true, list }`, where `list` is the normal `SessionsListResult`.
Calling with `{}` preserves the acknowledgment-only response
`{ subscribed: true }` and does not read a snapshot.
List parameters select the snapshot; they do not filter the connection's session
event subscription.

The Gateway registers the subscription before projecting the list. Clients must
listen for `sessions.changed` before making the request: events can arrive while
the snapshot is being built. Reconcile those events with the response and issue
a trailing `sessions.list` refresh when needed, including when an event only
invalidates the cached list. Reconnects require a new subscription and snapshot.

Both methods accept `activeOnly: true` to select currently running or queued sessions before pagination. Activity comes from the live runtime owners, not a stored status flag. Ordinary listing behavior is unchanged when the option is omitted or false. Active-only results include each visible agent-owned `global` and `unknown` session with its raw key and captured `agentId`; callers identify rows by agent, key, and `sessionId` together. Literal `agent:<id>:global` and `agent:<id>:unknown` sessions remain different rows. Active-only raw sentinel rows omit the optional `childSessions` and `hasActiveSubagentRun` fields; use `hasActiveRun` for direct activity. Normal permissions, archive/inclusion filters, and page limits still apply. Sessionless/internal runs are outside the session index.

Both methods accept `ownerFirst: true` to prepend up to 60 matching viewer-owned
rows (or `limit`, when smaller) to the normal first page, deduplicated by session key. This applies only
when `offset` is zero or omitted; later pages use normal pagination. Owned rows
must pass the same visibility and list filters as the shared page. The Gateway
resolves the viewer from the authenticated connection; no client-supplied
identity selects these rows. Without an authenticated viewer identity, or when
`ownerFirst` is false or omitted, the list uses normal ordering.

The shared page still determines `limitApplied`, `offset`, `nextOffset`,
`hasMore`, and `totalCount`. Prepended rows can make `sessions.length` and `count`
exceed the shared page size. Use `nextOffset` to advance and deduplicate rows by
session key across pages; do not derive the next offset from the displayed row
count.

### Common event families

- `chat`: UI chat updates such as `chat.inject` and other transcript-only chat
  events. In protocol v4, delta payloads carry `deltaText`; `message` remains
  the cumulative assistant snapshot. Non-prefix replacements set
  `replace=true` and use `deltaText` as the replacement text.
  Failed runs (`state: "error"`) may include `errorDetail` alongside the coarse
  `errorKind` and human-readable `errorMessage`. This closed object has seven
  optional fields: `provider`, `model`, `failoverReason`,
  `providerRuntimeFailureKind`, `providerErrorType`, `httpStatus`, and
  `providerErrorMessagePreview`. Strings are capped at 300 characters; `httpStatus`
  is an integer from 100 through 599. Details come from the failed attempt's
  sanitized provider observation, not from reparsing the user-facing message.
  The preview is credential-redacted and may be shorter than the protocol cap.
  Raw bodies, raw previews, and diagnostic hashes are never included in
  `errorDetail`. Runs without provider observations omit it; successful and
  canceled events do not carry it. This is an additive protocol-v4 field.
- `session.message`, `session.operation`, `session.tool`: transcript, in-flight
  session operation, and event-stream updates for a subscribed session.
- `session.approval`: sanitized pending and terminal approval truth for an
  explicitly opted-in exact-session subscriber. Child approvals use the
  persisted ancestor audience; events never mutate transcripts or wake agents.
- `session.observer`: safe live session headline and status digest. A model-authored
  preamble can update the headline immediately; utility-model assessments replace
  it later when available. Web, iOS, and Android use the same run-scoped digest.
  The optional `sessionId` and opaque `lifecycleRevision` identify the session
  lifecycle; `lifecycleRevision` can be absent before the first reset. Revisions
  increase across runs within that lifecycle but can restart after a reset.
  Critical notice history starts fresh when the identity pair changes, including
  when `/clear` preserves `sessionId` and changes `lifecycleRevision`.
  Clients show its headline or inspector link only while the digest's exact `runId`
  is present in `activeRunIds`.
- `sessions.changed`: session index or metadata changed. Active-run fields use the
  same aggregate and complete-exact semantics as `sessions.list`; `activeRunIds: null`
  clears cached exact identities to unavailable, omission leaves the cache unchanged,
  and an array replaces it. Delete notifications from `sessions.delete` and incognito
  reset carry the removed generation's `sessionId`, without a current-row snapshot.
  Clients must not delete a replacement with a different ID. A key-only delete event
  or a rowless global notification invalidates the canonical session list; it does
  not identify the current generation as deleted.
- `presence`: system presence snapshot updates.
- `tick`: periodic keepalive/liveness event.
- `health`: gateway health snapshot update.
- `heartbeat`: heartbeat event stream update.
- `cron`: cron run/job change event.
- `shutdown`: gateway shutdown notification.
- `node.pair.requested` / `node.pair.resolved`: node pairing lifecycle.
- `node.invoke.request`: node invoke request broadcast.
- `device.pair.requested` / `device.pair.resolved`: paired-device approval lifecycle.
- `device.pair.setup.completed`: exact setup-code handoff completion, scoped to
  `operator.pairing`.
- `device.pair.setup.deliveryUncertain`: replay-safe setup-code retirement whose
  credential response delivery could not be confirmed, scoped to `operator.pairing`.
- `voicewake.changed`: wake-word trigger config changed.
- `config.changed`: a config write persisted (payload carries the config path,
  the new snapshot hash, and a timestamp — never config content). Operator-read
  scoped; clients refresh via `config.get`.
- `skills.changed`: connectivity, the skill catalog, config, or eligibility
  changed after the gateway invalidated its skills snapshot. The payload's
  `reason` is `watch`, `watch-targets`, `manual`, `remote-node`,
  `config-change`, or `workshop`. Operator-read scoped; clients refresh via
  `skills.status`.
- `exec.approval.requested` / `exec.approval.resolved`: exec approval
  lifecycle.
- `plugin.approval.requested` / `plugin.approval.resolved`: plugin approval
  lifecycle.

### Node helper methods

Nodes may call `skills.bins` to fetch the current list of skill executables
for auto-allow checks.

### Node exec lifecycle events

Nodes report `system.run` lifecycle through the node-role `node.event` RPC with
`event: "exec.started"`, `"exec.finished"`, or `"exec.denied"`. These are not the
operator `exec.approval.*` broadcasts and do not use the retired TCP bridge.

The RPC accepts a JSON string in `payloadJSON` or an object in `payload`. A string
`payloadJSON` takes precedence when both are supplied. For example:

```json
{
  "event": "exec.finished",
  "payload": {
    "sessionKey": "agent:main:main",
    "runId": "<exec-run-id>",
    "host": "node",
    "exitCode": 0,
    "timedOut": false,
    "success": true,
    "output": "done"
  }
}
```

Current headless nodes include `sessionKey`, `runId`, and `host: "node"`.
Additional fields are:

| Field                  | Meaning                                                      |
| ---------------------- | ------------------------------------------------------------ |
| `command`              | Raw or formatted command text.                               |
| `exitCode`, `timedOut` | Process completion code and timeout flag.                    |
| `success`              | Producer result flag, not the notification-gating predicate. |
| `output`               | Bounded combined stdout, stderr, and error text.             |
| `reason`               | Denial reason for `exec.denied`.                             |
| `suppressNotifyOnExit` | Suppress this invocation's system notification.              |

Echo the correlation fields forwarded with `system.run`; neither an ID nor the
payload's `host` field grants authority. The Gateway matches the authenticated
node and connection, run ID, and session key when the invocation binds one.
Unmatched events return `handled: false` with `reason: "unmatched_exec_event"` and
produce no system notification. A narrow legacy macOS-client path may match a
missing or mismatched run ID only to one unambiguous invocation on that
connection/session; new clients must send the issued run ID.

`exec.started` retains the authorization record; `exec.finished` and
`exec.denied` consume it before notification filtering. `tools.exec.notifyOnExit:
false` or `suppressNotifyOnExit: true` suppresses notifications. Denied events
never enqueue a system event or wake agent work. Finished events notify only for
timeout, nonzero or unknown exit code, or nonempty compacted output; successful
exit 0 with no output stays quiet. Finished notifications with a run ID are
deduplicated by canonical session and run ID. A heartbeat wake is requested only
after a system event is queued.

Node event delivery is best-effort, not a durable completion ledger.
