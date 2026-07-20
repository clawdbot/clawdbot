# Changelog — @openclaw/gateway-protocol

Wire-protocol and schema contracts for the OpenClaw Gateway (WebSocket JSON-RPC-style
frames, handshake, and method/event payload schemas). Protocol version is negotiated
per connection via `minProtocol`/`maxProtocol`. This log covers the wire protocol
version and the additive schema surface. Dates are authoring dates (2026).

## Unreleased

- Rename structured-question item `id` to `questionId` and flatten keyed answer arrays.
- Slim worker and session-catalog payloads to the active wire contract.
- Remove dead protocol surfaces and add since-vintage metadata to retained schemas and methods.

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

Additive method/event/schema families added over time. Pure refactors, test-only, and
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
  replay, `terminal.list`/`terminal.text`, and file uploads into terminals (#107364).
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

## Notes for external versioning

- Post-v4 changes are additive except: the transient v5 rename (reverted, net-zero) and
  the 2026-07-14 `crestodian.*` -> `openclaw.*` method rename. The renamed feature was
  introduced only 9 days earlier (2026-07-05, #99935), never left the v4 window, and
  predates public publish, so no released method name changed under v4.
- `schema/types.ts` was removed 2026-07-11 (#103679); it re-exported compile-time type
  aliases only and has no wire impact.
