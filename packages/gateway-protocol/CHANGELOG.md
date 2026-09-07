# Changelog — @openclaw/gateway-protocol

Wire-protocol and schema contracts for the OpenClaw Gateway (WebSocket JSON-RPC-style
frames, handshake, and method/event payload schemas). Protocol version is negotiated
per connection via `minProtocol`/`maxProtocol`. This log covers the wire protocol
version and schema surface, including removals and semantic changes. Dates are
authoring dates (2026), not package publication dates.

## Unreleased

No changes outside the dated history below.

## Deferred to the next wire version

Changes that are agreed but intentionally NOT shipped, because they alter the
negotiated shape of the current wire version. A version bump is an explicit
breaking event for third-party clients (see "Notes for external versioning"), so
each entry stays here until an owner approves the bump and lands it together with
client follow-through. Add an entry whenever you defer a shape change; remove it
in the commit that bumps the version.

- **Remove `execSecurity` / `execAsk` from `SessionsPatchMutation`.** Retired in
  favour of `permissionMode` (PR #132740, landed `a151c1e0d35`). The properties
  remain declared in the closed v4 mutation schema so existing v4 callers keep a
  valid request shape; the applier rejects either field before any mutation with
  guidance naming `permissionMode` and `/exec`. Deleting the properties changes
  the closed-object shape, so it waits for the bump. Code marker:
  `packages/gateway-protocol/src/schema/sessions-patch.ts`.

## Protocol v4 (current)

Introduced 2026-05-07 (commit `330ba1f`). The stable, current wire version.

Wire contract:
- Frame envelopes: `req` / `res` / `event`, discriminated on `type`.
- Handshake: client sends `ConnectParams` (advertises `minProtocol`/`maxProtocol`,
  client identity, `caps`, `commands`, `permissions`, `role`/`scopes`, optional signed
  `device` identity, and an `auth` bag: token / bootstrapToken / deviceToken / password /
  approvalRuntimeToken / agentRuntimeIdentityToken).
- Server replies `hello-ok` with the negotiated `protocol`, server identity, the live
  `features` map (`methods`, `events`, `capabilities`), initial `snapshot`, minted `auth`
  device tokens, and connection `policy` (maxPayload / maxBufferedBytes / tickIntervalMs).
- Server events: `tick` heartbeat and `shutdown` notice; event frames may carry `seq`
  and `stateVersion` for ordered state sync.

Changed vs v3:
- `hello-ok` handshake replaced the single `canvasHostUrl` string with a
  `pluginSurfaceUrls` map (canvas generalized into arbitrary plugin surfaces). This
  field change is the breaking bump behind v4.
- Later additively extended (no bump) with `controlUiTabs` (plugin-declared Control UI
  tabs) and multi-`deviceTokens` in the handshake auth block.

Compatibility window (`version.ts`):
- `MIN_CLIENT_PROTOCOL_VERSION = 4` — general clients must speak v4.
- `MIN_NODE_PROTOCOL_VERSION = 3` and `MIN_PROBE_PROTOCOL_VERSION = 3` — authenticated
  nodes and lightweight probes are accepted at N-1 (v3) to stay manageable during
  rolling upgrades. Added 2026-07-06 (#101109).
- A transient v5 (2026-05-16, `07f05e9`) renamed `inboundTurnKind` -> `inboundEventKind`;
  it was reverted the next day (2026-05-17, `ad155fb`, "restore v4 message action
  protocol"). v5 never shipped as a stable ceiling; v4 remains current.

## Protocol v3

Baseline wire version. Present since repo genesis (2026-04-21) as an inline literal in
`protocol-schemas.ts`; extracted into `version.ts` unchanged on 2026-05-04 (`2949171`).
The first externally-relevant version — there is no 2->3 bump in tracked history.

Established the still-current shape: `req`/`res`/`event` frame envelopes, the
`ConnectParams` -> `hello-ok` handshake with protocol negotiation, `snapshot` state sync,
and the founding method/event families: sessions, agent chat, cron, devices, nodes,
channels, config, commands, logs-chat, exec-approvals, plugin-approvals, secrets, push,
wizard. (v3 `hello-ok` carried `canvasHostUrl`; v4 replaced it — see above.)

## Schema surface history

Method/event/schema changes over time. Pure refactors, test-only, and
docs commits are omitted. The package was extracted from `src/gateway/protocol` to
`packages/gateway-protocol` on 2026-05-29 (#87797); paths before that date lived under
the old tree.

### 2026-04 (v3 baseline era)

- Ship baseline families: frames/handshake, sessions, agent chat, cron, devices, nodes,
  channels, config, commands, logs-chat, exec-approvals, plugin-approvals, secrets, push,
  wizard, snapshot, primitives, agents-models-skills.
- Add WhatsApp `replyToMode` quoting (#62305).
- Add browser realtime Talk and transports — origin of the talk/voice families.
- Add Control UI PWA web push support (#44590).
- Add plugins and artifacts schema modules.
- Add OpenClaw SDK package and authenticated iOS background presence beacon (#73330).

### 2026-05

- Add environments discovery RPCs (#74867) and task-ledger RPCs (#74847) — tasks family.
- Add unified Talk gateway sessions, realtime active-run control, and typed `sessionKey`
  on the wake protocol.
- Add SDK `tools.invoke` RPC; extend cron with agentId filtering (#77602), run
  diagnostics (#75928), and direct job lookup.
- Add Skill Workshop gateway methods: proposal files, revision requests, persisted origin.
- Add core session goals (#87469).
- Add heartbeat flag on agent event broadcast (#80610), warm-MCP effective inventory, and
  plugin approval action metadata.
- Harden auth/device identity: bind approval access to requester metadata (#81380);
  require approval for setup-code device pairing (#81292); scope Talk session to resolver.
- Introduce and revert transient protocol v5 (`07f05e9` / `ad155fb`).

### 2026-06

Enhancement-only month (no new schema modules):
- Extend cron with command jobs, compact list responses (#93395), and an on-exit
  schedule kind that fires when a watched command exits.
- Forward-port fast-Talks auto mode (#85104); add session workspace rail (#92856).

### 2026-07 (largest expansion)

- Add terminal family: `terminal.*` RPC methods/events, detach/reattach with output
  replay, `terminal.list`/`terminal.text`, and file uploads into terminals (#107364;
  `terminal.text` removed in August by #121387).
- Add managed git worktrees: lifecycle create/provision/snapshot/restore/GC (#100535),
  new-session-in-worktree (#100788), session worktree targeting and branch listing
  (#103432); add read-only `agents.workspace` browsing RPCs (#100738).
- Add audit family: metadata-only message audit events (#103903), native-search audit
  correlation (#98704), and audit-activity schema.
- Add `tts.speak` returning synthesized audio inline (#100770).
- Add cooperative host suspension / gateway-suspend prepare/status/resume RPCs (#103618).
- Add durable approvals: persisted operator approvals (#103579), typed cross-surface
  approval actions (#103679), approval-id, and the durable-approvals stack (#104837).
- Add cloud-workers stack: durable environments + lifecycle RPCs (#104401), worker bundle
  + SSH bootstrap + admission handshake (#104532), authenticated worker protocol with
  minted credentials (#104688), durable transcript commit (#104809), live-event streaming
  (#105275), inference proxy (#105719), and session placement/dispatch (#106332).
- Add session catalog: sessions-catalog + sessions-create with external-session
  pagination unification (#104717).
- Add fs family: `sessions.files.set` hash-CAS writes (#104757) and gateway/node folder
  browsing (#105114).
- Add node-hosted plugins — dynamic tools, MCP servers, skills (#90431) — plus node
  invoke/presence protocol schemas.
- Add migrations family: log-migration protocol schemas and Codex/Claude memory import
  (#106406).
- Add durable device rename for human-friendly device names (#94517).
- Add follow-up task suggestions (#102422) and task-suggestions schema.
- Add cron event triggers via polled condition-watcher scripts (#101195) and native
  mobile Automations parity (#106355).
- Add system-agent conversational onboarding (#99935); rename `crestodian.*` methods to
  `openclaw.chat` / `openclaw.setup.*` (2026-07-14, `a6a0716`).
- Add typed structured questions / `ask_user` with live option cards (#109922, #110242)
  and the questions schema module.
- Add ui-command / screen-tool Control UI layout control and capability-gated
  `show_widget` inline web chat widgets (#101840).
- Add direct watch/watchOS node connect to Gateway (#102893); widen node/probe protocol
  acceptance to N-1 (#101109).
- Add session boards: `board.get` / `board.update`, widget put/grant and event schemas; pinned MCP apps, `board.widget.appView`, lease re-mint, declared network/tool grants, and ticketed widget actions (#110960, #111524, #111687).
- Add session visibility (`shared`, `read-only`, `suggest`, `draft`), `session.members.*`, `session.visibility.set`, and server-enforced participation (#112787).
- Add canonical session lineage and typed `SessionRow`: creation provenance, fork ancestry, generation links, and catalog `createdBy` renamed to `createdActor`; remove writable spawn-lineage fields from `sessions.patch` (#111861).
- Add durable `users.*` profiles with email aliases, display names, and avatars (#111224).
- Add `session.discussion.info` / `session.discussion.open` with discussion state and URLs (#111337).
- Add paginated `openclaw.changes.list` with typed change sources and summaries (#111286).
- Add durable client voice sessions: `voiceSessionId`, `voice-transcript` capability, `talk.client.transcript`, and `talk.client.close` (#111216).
- Add `session.suggestions.*`, suggestion resolution events, and `session.typing` indicators (#113173).
- Add machine-readable `FORBIDDEN` / `MISSING_SCOPE` errors with `missingScope` and `requiredScopes` (#110925, #111013).
- Add Skill Workshop evaluation and lifecycle replay through `skills.proposals.evaluate` / `skills.proposals.events.list`, revision hashes, and evaluation outcomes (#115606).
- Add `channels.pairing.list` / `approve` / `dismiss` for pending DM sender access requests (#112401).
- Add custom session `icon` values (emoji, named icon, or SVG; removed in August by #121263) (#110682).
- Add semantic `agent` / `system` roster kinds negotiated through the `agent-kind` client capability (#111920).
- Rename structured-question item `id` to `questionId`, flatten keyed answer arrays, and cap input headers at 12 characters; rename catalog `openClawSessionKey` to `sessionKey`, make cursor maps optional, and type the health snapshot (#111041).
- Add release-vintage metadata to core methods and selected schemas; consolidate worker schema/type exports without changing their payload shape (#111041).

### 2026-08

#### Removed

- Remove `terminal.text`, `sessions.compaction.get`, `sessions.unsubscribe`, `doctor.memory.remHarness`, and `voicewake.routing.set` (#121387). `terminal.list` remains; `gateway.restart.preflight` was removed in the same change and restored by #121757.
- Remove `talk.session.join` / `startTurn` / `endTurn` / `cancelTurn` and their unused join/turn/cancel-turn schemas (#121387). `TalkSessionTurnParams` / `TalkSessionTurnResult` disappear; `TalkEvent` and `talk.event` remain. `talk.session.cancelOutput` remains, with a new result contract described below.
- Remove the July custom session `icon` contract (#121263); restore emoji icons and then named glyphs with a new shape, without the former SVG support (#124034, #124629).
- Remove `hello-ok.deviceAuthMigration` (#124667) and beta-only `chat.send.expectedRunId` (#125921; introduced by #120285); active-run start-or-steer becomes Gateway-owned (#125808).
- Replace same-month `sessions.archiveMany` with `sessions.patchMany` (#120493, #120629), and `node.protocolFeatures.update` with `node.runnerInventory.update` (#122939, #123094).
- Remove same-month `users.setGitHubIdentity` / `users.clearGitHubIdentity` in favor of authenticated sign-in facts (#125827, #126114); remove `delivery.failures.resubmit` and retained failed-delivery payloads (#123410, #123642).
- Replace `audit.run.inspect.decisions` with required bounded `decisionDisplays` (#126007); replace flat GitHub status fields with `selected` / `effective` identity facts and require `selectedScope` (#126474).
- Replace worker machine-option `description` with `cpu` / `memoryGb` (#125696), and participant actor arrays with tagged `SessionParticipant.identity` records (#130986).
- Remove `acknowledgeClawHubRisk` from skill install/update and plugin install, plus `clawhub_risk_acknowledgement_required`; expose security-audit metadata instead (#131233).
- Retire session `execSecurity` / `execAsk`: both stay wire-valid in v4 but `sessions.patch` / `sessions.patchMany` now reject them with guidance naming `permissionMode` (#132740). Schema deletion remains deferred above.

#### Handshake and capabilities

- Add optional `hello-ok.policy.attachments` with required `maxBytes` / `maxImageBytes` decoded per-attachment ceilings (#116188).
- Add `hello-ok.auth.recoveryMigrationAllowed` / `recoveryScope` (#121671), connect `computerUse` (#123544), client/server `buildId` and server `controlUiBuildSource` (#123660), server `bootId` (#128365), and client/presence `timeZone` (#128438).
- Add node `workerRuns` admission metadata (#122966), then deprecate that envelope in favor of runner inventory while retaining its accepted v1 shape (#124356); add bundle-prewarm negotiation (#124427).
- Project plugin tab `placement` in `hello-ok` so active plugins can target native Control UI routes (#125473).
- Add the client `usage-refreshing` capability (#121799), `CONTROL_UI_BUILD_MISMATCH` reload details (#123882), identity-header-required errors (#125132, #125700), and structured `gateway-restarting` / `gateway-suspending` unavailability reasons (#130025).
- Advertise server capabilities through `hello-ok.features.capabilities`: `gateway-restart-target-safe-v1`, `node-worker-bundle-retention-v1`, `node-worker-bundle-status-v1`, `node-worker-environment-session-v1`, `node-worker-portal-stream-v1`, `session-scoped-chat-metadata`, `session-unread-ack-contract`, `session-goal-start-v1`, `openclaw-chat-wizard-cancel`, `openclaw-setup-model-ref`, `taskSuggestions.acceptModes`, `board-widget-put-canvas-doc`, and `chat-send-routing-contract` (current `GATEWAY_SERVER_CAPS`; additions span #121173, #123920, #124590, #124640, #129386, #130105, #131370).
- Replace advertised worker `worker-launch-v2` with execution-context negotiation (#120534); advance `worker-execution-context-v1` to `worker-execution-context-v2` for permission context (#125326). These are worker-dialect tokens, not changes to `PROTOCOL_VERSION`.

#### Method and event families

- Add bounded `sessions.patchMany` mutation orchestration with per-target outcomes (#120629), restart recovery through `sessions.recover` (#122644), and folder defaults through `sessions.groups.defaults` / `update` (#123276).
- Add projects: `projects.list` / `register` / `remove` / `add` / `searchRemote`, typed records/checkouts/remotes, session project targeting, clone progress/errors, and per-project worker-profile defaults (#121465, #120804, #121818, #126238, #130192).
- Add `secrets.store.list` / `set` / `delete`, redacted entry metadata, destination-bound `allowedHosts`, and credential-question `secretStore` / `secretStoreExisting` bindings (#121559, #121724, #123216, #129670).
- Add `users.prefs.get` / `set`, `users.prefs.changed`, bounded preference-limit errors, appearance/font preferences, and `users.setRole` with optional profile `role` (#121816, #128548, #130340, #131275).
- Add GitHub identity facts, per-agent `tools.github.status` / `configure` and `tools.github.authorize.start` / `poll` / `cancel`, plus brokered `sessions.github.publish` outcomes; project verified participant co-author identities and their preference (#125199, #125827, #126114, #126474, #126306, #131964).
- Add `worker.desktop.observe` / `launch` and local/paired-node `desktop.observe` / `launch` with `DesktopSource` and app-launch results (#120727, #121475, #122545, #122724).
- Add `portal.list` / `open` / `close` and `portal.changed`, including portals on node-backed workers (#122536, #130105).
- Add `sessions.move` between Gateway and runners, machine-class targeting, optional device/automatic-device dispatch, and atomic `node.runnerInventory.update` / `node.runnerInventory.changed` (#125036, #125292, #122769, #128421, #123094).
- Add `sessions.assignOwner`, `SessionOwner`, participant/person projections, and owner/participant roster filters; add `session.members.listEvidence` and `session.sharing.evidence` (#125057, #125579, #125645, #129093, #130986).
- Add `progressCard.get` / `put` and `progressCard.changed`, typed steps/statuses, and dismissal (#125125, #126102); add `sessions.goal.update` / `clear` and goal-start `chat.send.intent` (#131370).
- Add `device.scopes.requestUpgrade` / `waitUpgrade`, one-paste pairing links, `device.pair.setupStatus`, `device.pair.setup.completed` / `device.pair.setup.deliveryUncertain`, and `device.pair.changed` after device edits (#121459, #120768, #122499, #120933, #126432).
- Add `exec.approval.grants.list` / `revoke`, standing-grant expiry/revocation records, typed `ApprovalScope`, and reviewer/grant-term fields (#129526, #130116, #131602).
- Add `plugins.inspect`, declared capability surfaces, artifact-bound operator grants, install/enable consent, and install security-audit metadata (#130168, #131233).
- Add `push.web.preferences.get` / `set`, notification category/detail level, quiet hours, and approval-notification preferences (#129348).
- Add `hooks.status` (#118288), `audit.run.inspect` with execution identity/receipt/display contracts (#117034, #120534, #126007, #126082), and command-lane `diagnostics.lanes` (#125591).
- Add `tasks.retry` / `dismiss` with `TasksRecoveryParams` / `Result` and delivery outcomes (`d9393bd3cbe`, `1f78c39bd82`, `6ca16f7f3d2`, `d0439b9ce0f`); add task-suggestion acceptance `mode` / `cloudProfileId` and reject whitespace-only title/prompt/TLDR values (#121173, #120940).
- Extend worker RPCs with `worker.sessions.spawn` / `send`, `worker.github.publish`, and `worker.portal`, negotiated by `worker-session-tools-v1`, `worker-github-publication-v1`, and `worker-portal-v1` (#121846, #126306, #130105); add public `/__openclaw__/worker` ingress and `admission-rejected` close reason (#122578).
- Add scheduled-update `update.hold`, `UpdateScheduleState`, update status/availability projections, checkout-lag `refreshCheckout`, and exact update/restart targets (#120506, #120769, #118518, #124891, #128868); extend cooperative suspension with terminal policy and renewable `draining` results (#121601, #130003).
- Add `sessions.catalog.startTerminal` plans (#121020), `controlUi.sessionPreview` (#125014), and short-reference/candidate results on existing `sessions.resolve` (#120512, #128778).

#### Fields and payload contracts

- Preserve required legacy agent-default fields while adding honest `ownership` and `selectionRequired` state to agent lists and initial snapshots; carry explicit `agentId` through session, board, companion, discussion, plugin, and UI requests, and require nonempty model-list agent IDs when supplied (#114388). Add agent creation hierarchy, resolved-name provenance, and purge-failure results (#124967, #122463, #125217).
- Project optional `defaultPermissionMode` on agent rows so clients can label the inherited session permission default; omitted whenever the effective policy cannot be stated truthfully (#132989).
- Add session `permissionMode` (`SessionPermissionMode`) on create/patch/rows (#124909), emoji/glyph icons (#124034, #124629), and `color` on patch/row/catalog projections (#132570).
- Extend session rows with classification/peer-kind facts (#106832), conversation avatar (#125668), restart recovery and terminal placement reasons (#122644, #121122, #120976), `lastRunId` (#126180), inherited-model provenance (#120805), and queued `SessionRunStatus` (#125654, #131444). Add roster bootstrap/people projections and remove the implicit row cap (#130294, #131202).
- Extend session creation with `forkFrom`, category, tool overrides, idempotency, context-window and fast-mode selection, and worktree startup phases (#123718, #123276, #128081, #128661, #127951, #131272, #131559); carry catalog `sourceHomeId` and explicit owner targeting (#123899).
- Allow write-scoped folder browsing/session creation within configured agent workspaces; arbitrary host and node paths remain admin-scoped (#121417).
- Add chat-history cursors with delta/reset results, delta `inFlightRun`, pending-input pagination and steering status (`ChatPendingInputsPage`), and session-scoped chat metadata plus `chat.metadata.changed` (#125606, #129640, #132887, #131697, #132179). Add `markedUnreadAt` / `expectedMarkedUnreadAt` acknowledgment fencing (#129386), bounded typing previews (#126994), and terminal-open `sessionKey` with agent-owned terminal detach semantics (#125758).
- Add typed hosted-wizard answers and optional `SystemAgentChatResult.step` (#114631), wizard cancellation (`890a4b0089f`, `2300de71627`), prepared-model references (`dea04651b9c`), snapshot `modelConfigured` (#128135), setup `agentId` (#123429), restart-required activation (#127713), and terminal `modelActivation` / `SetupAdmissionBusyErrorDetails` (#131757).
- Add gateway-owned realtime `gateway-control-v1` / `clientControl.owner` (#121054); add `TalkSessionCancelOutputResult` with `applied` / `stale` / `idle` status and optional `turnId` (#127186).
- Extend model catalogs with per-agent availability/provider outcomes, mutually exclusive `preparedOnly: true` / `refresh: true` requests, thinking choices/defaults, tags, context-window choices/defaults, effective fast mode, and auth-unavailability reasons/deadlines (#121852, #122125, #126194, #127951, #131272, #131697; `d83f7b815db`, `639e7718f39`). Align fallback-reason values across cron, sessions, and worker events (#117909, #121285, #121334, #121898).
- Extend worker/environment placements with desktop apps, disk-space facts, offline host presence/trust, runtime-target issues, worker profiles/execution modes, bundle status/retention, exact slot counts, and service/profile/runner projections (#121475, #122531, #123177, #123198, #124037, #124864, #124640, #124590, #125708, #127752, #132405). Add runtime cloud/device support, `invocableCommands`/slot requirements, and local-or-reclaimed results; make dispatch `profileId` optional for mutually exclusive device/automatic targeting and add offline-runner `abandonSource` (#123743, #122769, #124791, #126067, #126284, #126585, #127202, #128421).
- Add worker transcript/inference `providerReplay`, expand its bounded replay budget, and add versioned compaction-token provenance (#120457, #120803, #120497); raise worker transcript image-data ceiling to 25 MiB (#132114).
- Extend session diffs with commit/scope selection, commits, merge base and ahead count (#122470); record worktree run-end cleanup, removal `snapshotError` even when removal stops, and typed preserved-worktree deletion outcomes (#120434, #126174, #126347). Add live task `lastActivity` / `diffStat` (#121549).
- Add generated board-widget identities and canonical put results (#117132), registered/A2UI content and content-owner projections (#125803, #128489); add command client presentation and skill display names (#120855, #124017).
- Extend cron with auto-disable state, Date-range timestamp bounds, `if-enabled` run mode and trigger filtering, typed delivery traces/completion status/suppression reasons, and system-owned skill-review status (#118113, #121394, #125170, #126534, #124856, #126164, #130811, #130030). Add missing-job `CronJobNotFoundErrorDetails` (#124663).
- Require source-qualified skill-search `installRef`, distinguish install-only/unscanned results, carry install-policy warnings and update conflicts, and require `expectedRevisionHash` for proposal apply/reject/revision requests (#119672, #121697, #124250, #120900, #118190, #126156). Report curator collection/experience reviews; retired curator actions remain wire-valid but return guidance (#129769).
- Require `avatarRevision` in avatar-save results (#120791) and nullable `githubIdentity` in user profiles (#125827). Add bounded user preference values and default-on co-author credit for verified identities (#121816, #131964).
- Extend channel/health snapshots with nullable status timestamps/errors, credential/audience/webhook and active-run facts, event-loop degradation age, ingress failure/pressure, and heartbeat session targeting (#117817, #118193, #123234, #121892). Add presence activity timestamps and qualified profile/viewer identities (#130664, #132038, #132250).
- Add outbound-delivery audit/error details, typed queued-delivery outcomes, reply metadata, and payload-free failed-row retention (#123709, #128202, #126205, #123410, #123642); reject impossible audit filter combinations (#124513). Bind approval requests to channel accounts, project resolved exec defaults, and surface controlling-chat source sessions (#121673, #125756, #131829); clarify other-device token-rotation delivery in `DeviceTokenRotateResult` (#121361).

## Notes for external versioning

- Removals and semantic breaks have shipped in v4 builds without a wire-version bump, including the July question/catalog reshaping and August RPC/field removals above. The negotiated version remains `4`, with minimum client/node/probe versions `4` / `3` / `3`; it does not identify a fixed schema vintage. Monthly history records authoring, not a guarantee that every intermediate shape reached a stable package release.
- Discover current methods, events, and capabilities through `hello-ok.features`; consult the matching release's schemas for payload contracts. The Deferred section records shape changes still waiting for an owner-approved version bump, not changes already made under v4.
- Core method `since` values are release-train metadata (`<=2026.7` predates tracking), not exact authoring dates. Use the method table for retained methods, generated Kotlin catalog history for method/event changes, and schema/generated Swift diffs for field changes; the sparse `x-openclaw-since` annotations are not a complete schema history.
- `schema/types.ts` was removed 2026-07-11 (#103679); it re-exported compile-time type
  aliases only and has no wire impact.
