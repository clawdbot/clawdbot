---
summary: "Step-by-step guide to building a messaging channel plugin for OpenClaw"
title: "Building channel plugins"
sidebarTitle: "Channel Plugins"
read_when:
  - You are building a new messaging channel plugin
  - You want to connect OpenClaw to a messaging platform
  - You need to understand the ChannelPlugin adapter surface
---

This guide builds a channel plugin that connects OpenClaw to a messaging
platform: DM security, pairing, reply threading, and outbound messaging.

<Info>
  New to OpenClaw plugins? Read [Getting Started](/plugins/building-plugins)
  first for package structure and manifest setup.
</Info>

## What your plugin owns

Channel plugins do not implement send/edit/react tools; core provides one
shared `message` tool. Your plugin owns:

- **Config** - account resolution and setup wizard
- **Security** - DM policy and allowlists
- **Pairing** - DM approval flow
- **Session grammar** - how provider-specific conversation ids map to base
  chats, thread ids, and parent fallbacks
- **Outbound** - sending text, media, and polls to the platform
- **Threading** - how replies are threaded
- **Heartbeat typing** - optional typing/busy signals for heartbeat delivery
  targets

Core owns the shared message tool, prompt wiring, the outer session-key shape,
generic `:thread:` bookkeeping, and dispatch.

Core also owns model-picker product actions. A channel that renders a
`ModelPickerAction` declares its `ModelPickerCapabilityProfile`, then encodes
the typed action in a transport-private authenticated callback envelope. Keep
approval, command, URL, web-app, question, callback, and model-picker actions
distinguishable until that encoding boundary; never infer picker intent from a
raw callback string. Actor and source-message checks remain channel-owned.

## Message adapter

Expose a `message` adapter with `defineChannelMessageAdapter` from
`openclaw/plugin-sdk/channel-outbound`. Declare only the durable final-send
capabilities your native transport actually supports, backed by a contract
test that proves the native side effect and returned receipt. Point text/media
sends at the same transport functions the legacy `outbound` adapter uses. For
the full API contract, capability matrix, receipt rules, live preview
finalization, receive ack policy, tests, and migration table, see
[Channel outbound API](/plugins/sdk-channel-outbound).

If your existing `outbound` adapter already has the right send methods and
capability metadata, derive the `message` adapter with
`createChannelMessageAdapterFromOutbound(...)` instead of hand-writing another
bridge. Adapter sends return `MessageReceipt` values. For legacy ids, derive
them with `listMessageReceiptPlatformIds(...)` or
`resolveMessageReceiptPrimaryId(...)` instead of keeping parallel `messageIds`
fields.

Channel actions and adapter capabilities come from the selected plugin
registration. An omitted `actions`, `message`, or `outbound` surface is not
filled from another plugin with the same channel ID. Prepared delivery handlers
created inside a registry scope retain that handle when invoked after the caller
leaves the scope.

Declare live and finalizer capabilities precisely - core uses these to decide
what a channel can do, and drift between the declared and actual behavior is a
contract test failure:

| Surface                               | Values                                                                                           |
| ------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `message.live.capabilities`           | `draftPreview`, `previewFinalization`, `progressUpdates`, `nativeStreaming`, `quietFinalization` |
| `message.live.finalizer.capabilities` | `finalEdit`, `normalFallback`, `discardPending`, `previewReceipt`, `retainOnAmbiguousFailure`    |

Channels that finalize a draft preview in place should route the runtime logic
through `defineFinalizableLivePreviewAdapter(...)` plus
`deliverWithFinalizableLivePreviewAdapter(...)`, and keep the declared
capabilities backed by `verifyChannelMessageLiveCapabilityAdapterProofs(...)`
and `verifyChannelMessageLiveFinalizerProofs(...)` tests so native preview,
progress, edit, fallback/retention, cleanup, and receipt behavior cannot drift
silently.

### Progress visibility acceptance

Progress callbacks report what the operator can see, not merely what a plugin queued. Return
`true` after accepting visible progress and `false` while delivery is pending or when no visible
update occurred. Existing synchronous and asynchronous callbacks that return `void` remain
backward-compatible and are treated as visible; new acceptance-aware implementations should use
an explicit boolean.

### Quiet progress presentation

Native progress renderers must retain approval and failure lines when ordinary
tool rows are disabled. The shared progress compositor retains those lines in
its snapshots; native renderers must preserve them alongside plan rows and
ordinary activity.

`resolveChannelStreamingPreviewToolProgress(entry, defaultValue?, mode?)` keeps
its shipped default of `true` when the second argument is omitted or
`undefined`. Bundled channels pass `mode !== "progress"` as the second argument
and their resolved streaming mode as the third argument, so unconfigured
`progress` drafts hide ordinary tool rows while `partial` and `block` previews
show them.

The compositor and formatter's `presentation: "summary"` option and the
checklist formatter's `plain: true` option are deprecated but retain their
explicit output until the next breaking SDK release. New callers should omit
them and use `streaming.progress.toolProgress` to control tool rows with the
standard progress markers.

### Quiet acknowledgement and coalesced progress

`createStatusReactionController({ presentation: "acknowledgement", ... })`
keeps the initial reaction through work and success, skips inactivity warnings,
and retains the existing error/cleanup lifecycle. The default `activity` policy
continues to expose detailed lifecycle reactions.

For edited or native progress, `createDraftStreamLoop` and finalizable draft
controls accept `coalesceInFlight: true` to keep background updates arriving
during a send in the next throttle window. Explicit `flush()` still bypasses
the delay for attention and finalization. Cancel pending updates and await
in-flight work before closing or rotating a stream.

### Commentary delivery ownership

Set `commentaryPayloadsEnabled: true` when the channel supports durable commentary messages.
Channels that normally render commentary in one evolving progress draft can also provide
`shouldDeliverCommentaryPayloads`. Core freezes verbose visibility for the turn, registers that
getter through `onVerboseProgressVisibility`, evaluates the delivery callback once before
dispatch, and snapshots that result for the whole turn. Session changes apply on the next turn.
The callback is inert unless `commentaryPayloadsEnabled` is also `true`; without that static
opt-in, core neither evaluates the callback nor freezes the registered visibility getter.

Return `false` while the draft owns normal progress and `true` when verbose progress makes that
draft yield to durable commentary. Keep the callback synchronous and read only channel-owned,
already prepared state. Omitting it preserves durable delivery for existing plugins that use the
static opt-in. The callback does not control reasoning, partial replies, tool progress, or final
answers.

Inbound receivers that defer platform acknowledgements should declare
`message.receive.defaultAckPolicy` and `supportedAckPolicies` instead of hiding
ack timing in monitor-local state. Cover every declared policy with
`verifyChannelMessageReceiveAckPolicyAdapterProofs(...)`.

### TTS voice delivery

Declare native voice-note behavior under `capabilities.tts.voice`. Set
`synthesisTarget: "voice-note"` when TTS providers should produce a native
voice-note format. Set `captionedFinalText: true` only when the outbound voice
operation accepts visible final text and enforces its transport's caption and
overflow rules. Core then holds final-mode streamed text for that operation and
falls back to text when the voice payload is proven unsent.

The legacy `dispatchInboundReplyWithBase` helper remains available from the
deprecated `openclaw/plugin-sdk/inbound-reply-dispatch` compatibility shim.
Do not use it for new channel code; start with the `message` adapter, receipts,
and receive/send lifecycle helpers on `openclaw/plugin-sdk/channel-outbound`
instead.

### Inbound ingress (experimental)

Channels migrating inbound authorization can use the experimental
`openclaw/plugin-sdk/channel-ingress-runtime` subpath from runtime receive
paths. It accepts platform facts, raw allowlists, route descriptors, command
facts, and access group config, then returns sender/route/command/activation
projections plus the ordered ingress graph, while platform lookup and side
effects stay in the plugin. Keep plugin identity normalization in the
descriptor you pass to the resolver; do not serialize raw match values from
the resolved state or decision. See
[Channel ingress API](/plugins/sdk-channel-ingress) for the API design,
ownership boundary, and test expectations.

Pass the exact resolver result to the host-injected registered context builder
as `channelIngress`. Results used for execution must include the final
agent/session/message/event `contextBinding`; decision-only resolver calls may
omit it. This preserves the native plugin's record-, epoch-, and scope-bound participant evidence through one-shot queued run admission without
exposing it in message context fields. The standalone public builder is not an
authoritative substitute. Never reconstruct evidence from sender, route, room,
account, thread, message, transport, or session values. Legacy adapters can explicitly pass
`channelIngress: "unsupported"` only when the path is source-proven to lack an
authoritative Phase 0 integration. Supported paths must pass the exact result;
omission is invalid production wiring. Missing, fake, stale, reused, or mixed
supported evidence projects as unknown, never as an allow signal.

### Durable ingress and replay dedupe

Channels adopting durable ingress should use `createChannelIngressMonitor`
from `openclaw/plugin-sdk/channel-outbound` unless they need a materially
different admission or pump contract. Enqueue the raw transport envelope at a
single receive chokepoint (no normalization at receive time), gate the
transport ack on the durable append for webhook transports, derive one
serialized lane per conversation, and mark the event complete at dispatch
adoption. The queue's primary key is `(queue_name, event_id)` and completion
tombstones the row instead of deleting it, so a late platform redelivery of
the same `event_id` is rejected durably for the tombstone retention window.
See [Channel outbound API](/plugins/sdk-channel-outbound#durable-ingress-monitors)
for the monitor API and shutdown contract.

That tombstone is the layering rule for replay guards
(`openclaw/plugin-sdk/persistent-dedupe`): a drained channel keeps a separate
replay guard only when the guard's identity or retention exceeds the queue's
— a logical message key that differs from the transport delivery id (Telegram
dedupes `chat_id:message_id` because debounce merges can re-surface a message
under a fresh `update_id`), or a longer window than the channel's tombstone
retention. If your guard key would equal the drain `event_id`, delete the
guard when adopting the drain and size `completedTtlMs`/`completedMaxEntries`
to cover the old guard window instead. Non-dedupe protections such as age
fences are unrelated to this rule. Stable outbound message IDs use the shared
outbound-echo registry from `openclaw/plugin-sdk/channel-outbound` instead of a
channel-local TTL cache.

#### Transport classes and retention

Classify a transport by the recovery guarantee at its receive boundary:

- **Ack-gated webhook or event delivery:** acknowledge or return success only
  after the durable append. An append failure must leave the delivery eligible
  for retry or fail the receive boundary. This class includes Slack, SMS, Zalo,
  Microsoft Teams, Google Chat, LINE, and Synology Chat.
- **Awaited polling or stream delivery:** advance the remote cursor or send the
  transport ack only after the append. When no explicit cursor exists, keep the
  receive callback serialized and awaited so an append failure cannot let the
  receive loop run ahead. Telegram polling, Signal, and Tlon use this class;
  Telegram webhook delivery follows the ack-gated rule above.
- **Non-replay sockets:** IRC, Mattermost, Twitch, and Zalo Personal cannot ask
  the platform to redeliver an accepted event. Their durable queue protects the
  process crash window and supports local restart recovery; completion
  tombstones are near-inert against platform replay.

Use 30 days as the fleet tombstone-TTL convention, not as an SDK default. A
high-volume redelivery window normally uses a 20,000-entry completed cap;
lower-volume awaited and non-replay transports normally use 1,000-2,000.
Current exceptions include LINE's 4,096-entry caps, SMS's 24-hour completed
TTL, and Tlon's cap-only completed retention. Failed-row caps may also be lower
than completed caps. TTL and cap both prune rows, so effective retention ends
when the first bound is reached. Deviate only for a documented platform retry
horizon, preserved shipped replay-guard window, expected volume or disk budget,
or non-replay transport, and cover the retention contract with tests.

#### At-least-once side effects

Drain dispatch runs command side effects before the ingress row reaches its
completion tombstone. A process crash between those steps replays the row and
can execute the side effect again. This at-least-once crash window is the
default contract. For non-idempotent work such as config writes, storage
clears, or visible acknowledgements outside the reply lane, use
`createIngressEffectOnce(...)` from
`openclaw/plugin-sdk/ingress-effect-once`. Give each call the stable ingress
`eventId` plus an effect name. Create one helper per ingress queue/account and
use a stable, unique `namespacePrefix` for that scope because transport event
IDs may be queue-local. The helper commits its durable claim only after the
effect succeeds; a thrown effect releases the claim so a drain retry can
execute it again, while concurrent callers wait for the active claim. Durable
state errors call `onDiskError` when provided and reject instead of falling
back to process memory.

Set the helper's `ttlMs` to at least the channel's ingress tombstone retention
plus the maximum delay between effect commit and row completion, including
bounded downtime and drain retries. The effect record's TTL starts at commit,
while tombstone retention starts later at completion; if pending-row lifetime
is unbounded, no finite TTL covers arbitrary downtime. After the tombstone can
no longer replay the row, older effect records are dead weight. Size
`stateMaxEntries` for every distinct event/effect key that can exist in that
retention window, accounting for the queue's completed-entry bound and the
maximum effects per event. A lower cap evicts the oldest record before its TTL
and allows that effect to execute again. Residual at-least-once windows remain
if the process dies or persistence fails after the effect succeeds but before
the claim commits, or if the record expires while its ingress row is still
pending.

#### Account-scoped restart contract

Channel config changes restart the whole channel by default. A multi-account
channel may set `reload.accountScopedRestart: true` only when configuration
resolution reads channel-wide shared fields plus the selected account, never a
sibling account, and the Gateway can stop and start one `(channel, accountId)`
runtime without replacing sibling runtimes.

The scoped path applies only to changes under
`channels.<channel>.accounts.<non-default-id>.*`. Changes to shared channel
fields, `accounts.default`, removed or unresolvable accounts, and mixed changes
that can affect inheritance are promoted to a whole-channel restart. Plugins
that do not opt in always use the whole-channel path.

For channels using the durable ingress drain, the account monitor's stop path
must first settle all accepted transport admissions, then dispose and await its
drain. Starting the account opens the same account-keyed queue, whose initial
drain recovers undispatched durable rows. Do not add a second reload-specific
replay pass; queue recovery is the canonical restart path.

Treat this flag as a capability claim, not a performance preference. Contract
tests should prove that adding and editing one named account leaves a sibling's
resolved config unchanged, stopping one account settles only that account's
monitor and drain, and a fresh monitor recovers that account's rows exactly
once. If any guarantee cannot be proved, omit the flag.

### Runtime lifecycle status

For channel-authored runtime state, `ChannelAccountSnapshot.lifecycle` is the
successor to `healthState`. Existing plugins may keep publishing `healthState`
during adoption, and core-derived policy writes remain supported. There is no
removal date; removal waits for external channel-plugin adoption.

### Typing indicators

If your channel supports typing indicators outside inbound replies, expose
`heartbeat.sendTyping(...)` on the channel plugin. Core calls it with the
resolved heartbeat delivery target before the heartbeat model run starts and
uses the shared typing keepalive/cleanup lifecycle. Add
`heartbeat.clearTyping(...)` when the platform needs an explicit stop signal.

### Media source params

Resolve account media limits with `resolveChannelMediaMaxBytes(...)` from
`openclaw/plugin-sdk/account-helpers`. Pass the already-merged account's
`mediaMaxMb` through `resolveChannelLimitMb`; the helper applies the agent
default only when the account/channel limit is absent. Its optional byte result
must reach the actual media loader, capped by any transport ceiling. Preserve
the loader's existing default when no limit is configured.

The focused account-helper import keeps setup and account resolution free of
media analysis runtimes. The old `media-runtime` export remains available for
existing external plugins, but new and bundled callers should use the focused import.

If your channel adds message-tool params that carry media sources, expose
those param names through `plugin.actions.describeMessageTool(...).mediaSourceParams`.
Core uses that explicit list for sandbox path normalization and outbound
media-access policy, so plugins do not need shared-core special cases for
provider-specific avatar, attachment, or cover-image params.

Prefer an action-keyed map such as `{ "set-profile": ["avatarUrl", "avatarPath"] }`
so unrelated actions do not inherit another action's media args. A flat array
still works for params intentionally shared across every exposed action.

Channels that must expose a temporary public URL for a platform-side media
fetch can use `createHostedOutboundMediaStore(...)` from
`openclaw/plugin-sdk/outbound-media` with plugin state stores. Keep platform
route parsing and token enforcement in the channel plugin; the shared helper
only owns media loading, expiry metadata, chunk rows, and cleanup.

`prepareUrl({ mediaAccess })` forwards host-authorized local media access to
the shared outbound loader. Hosted media capacity defaults to
`overflowPolicy: "evict-oldest"` for compatibility. Use `"reject-new"` when
issued URLs must remain valid until expiry, and configure both backing keyed
stores with `"reject-new"` so independent writers cannot evict live rows.
Use `validateBeforePersist` to inspect the guarded loader's exact bytes and
metadata when a transport must reject a payload class. Treat its buffer as
read-only and throw to reject before capability creation or any store write.
Authenticate bearer requests with `readMetadata(...)` before calling `read(...)`
so invalid tokens and `HEAD` requests do not hydrate stored media chunks.

Inbound attachments use ordered facts, not parallel `Media*` fields. Normalize
channel records with `toInboundMediaFacts(...)` from
`openclaw/plugin-sdk/channel-inbound` and pass them as `media` when building the
inbound context. When a plugin must authorize local media reads, import
`getAgentScopedMediaLocalRoots(...)` or
`getAgentScopedMediaLocalRootsForSources(...)` from the focused
`openclaw/plugin-sdk/media-local-roots` subpath. The old
`agent-media-payload` builder/root facade is deprecated compatibility.

### Native payload shaping

If your channel needs provider-specific shaping for `message(action="send")`,
prefer `actions.prepareSendPayload(...)`. Put native cards, blocks, embeds, or
other durable data under `payload.channelData.<channel>` and let core send
through the outbound/message adapter. Use `actions.handleAction(...)` for send
only as a compatibility fallback for payloads that cannot be serialized and
retried.

### Session conversation grammar

If your platform stores extra scope inside conversation ids, keep that parsing
in the plugin with `messaging.resolveSessionConversation(...)`. That is the
canonical hook for mapping `rawId` to the base conversation id, optional
thread id, explicit `baseConversationId`, and any
`parentConversationCandidates`. When you return `parentConversationCandidates`,
order them from the narrowest parent to the broadest/base conversation.

`messaging.resolveParentConversationCandidates(...)` is a deprecated
compatibility fallback for plugins that only need parent fallbacks on top of
the generic/raw id. If both hooks exist, core uses
`resolveSessionConversation(...).parentConversationCandidates` first and only
falls back to `resolveParentConversationCandidates(...)` when the canonical
hook omits them.

Bundled plugins that need the same parsing before the channel registry boots
can expose a top-level `session-key-api.ts` file with a matching
`resolveSessionConversation(...)` export (see the Feishu and Telegram
plugins). Core uses that bootstrap-safe surface only when the runtime plugin
registry is not available yet.

Use `openclaw/plugin-sdk/channel-route` when plugin code needs to normalize
route-like fields, compare a child thread with its parent route, or build a
stable dedupe key from `{ channel, to, accountId, threadId }`. The helper
normalizes numeric thread ids the same way core does, so prefer it over ad hoc
`String(threadId)` comparisons. Plugins with provider-specific target grammar
should expose `messaging.resolveOutboundSessionRoute(...)` so core gets
provider-native session and thread identity without parser shims.

### Conversation route ownership

Implement `messaging.resolveConversationRouteOwner(...)` when generic route
matching cannot reproduce the channel's configured and runtime binding rules.
The resolver receives the current config, account, and recorded conversation
identity, including a delivery `target` when it differs from the routing peer.
It must reuse the same precedence and provider identity grammar as inbound
routing.

Ownership inspection is synchronous and read-only. Do not refresh binding
liveness, perform network requests, or infer missing provider facts. Return:

- `{ kind: "agent", agentId }` for an agent-owned route.
- `{ kind: "plugin", pluginId, fallbackAgentId }` for a plugin-owned runtime
  binding. `fallbackAgentId` is the route used when that plugin has no active
  inbound claim handler.
- `{ kind: "unavailable" }` when authoritative owner state is temporarily
  unavailable and the caller should retry.
- `null` when the supplied identity is invalid or cannot be authorized.
- `undefined` to delegate to core's generic owner resolution.

Keep temporary unavailability distinct from `null`: an adapter restart is not
proof that a previously bound conversation is unowned.
Use `inspectConversationBinding(...)` and its `ConversationBindingInspection`
result from `openclaw/plugin-sdk/conversation-binding-inspection-runtime` for this
available/unavailable distinction. This public inspection helper is synchronous,
read-only, and does not refresh binding liveness.

### Account-scoped conversation binding support

Set `conversationBindings.supportsCurrentConversationBinding` when the channel
supports generic current-conversation bindings. `createChatChannelPlugin(...)`
sets this static capability to `true` by default. Channels whose monitor owns a custom binding
adapter must also set `bindingStore: "adapter"`; core then fails closed while
that adapter is unavailable instead of reading or writing generic binding rows.
Older `createManager`-only plugins retain the same adapter-owned behavior.

If support differs by configured account, also implement
`conversationBindings.isCurrentConversationBindingSupported({ accountId })`.
Core evaluates this synchronous hook only after the static capability is
enabled. Returning `false` makes generic current-conversation capability,
bind, lookup, list, touch, and unbind operations unavailable for that account.
Omitting the hook applies the static capability to every account.

Resolve the answer from already-loaded account config or runtime state. This
hook gates only generic current-conversation bindings; it does not replace
configured binding rules or plugin-owned session routing. Contract tests
should cover at least one supported and one unsupported account through the
`ChannelPlugin["conversationBindings"]` contract exported by
`openclaw/plugin-sdk/channel-core`.

Binding ids are local to a channel and account. `SessionBindingService.touch(bindingId, at?, scope?)`
and `unbind({ bindingId, reason, scope })` accept an optional `{ channel, accountId }`
scope to select that owner. For an individual mutation, pass the existing binding's
`conversation` as the scope. For example, to detach a resolved binding:

```ts
await getSessionBindingService().unbind({
  bindingId: binding.bindingId,
  scope: binding.conversation,
  reason: "manual",
});
```

Import `getSessionBindingService` from `openclaw/plugin-sdk/session-binding-runtime`.
For activity updates, use `service.touch(binding.bindingId, at, binding.conversation)`.
Omit scope only for intentional global cleanup or an existing legacy cross-channel
operation. Scope does not change binding ids or require a new adapter method.

Refreshing the same target session and target kind preserves omitted runtime
metadata. Replacing either starts fresh target metadata, so a new session cannot
inherit the previous plugin owner, agent, or label. Keep conversation transport
details and explicit lifecycle settings separate from target metadata.

Preserve opaque plugin ownership metadata when projecting binding records.
Plugin-owned targets do not require an OpenClaw agent id; use
`isPluginOwnedSessionBindingRecord(...)` from
`openclaw/plugin-sdk/conversation-binding-runtime` to distinguish them from
agent-owned targets before resolving an agent.

For agent-owned targets with an unscoped session key such as `global`, preserve
`metadata.agentId` so routing keeps the binding's owner. An agent-scoped target
key remains authoritative over conflicting metadata.

## Approvals and channel capabilities

Most channel plugins do not need approval-specific code. Core owns same-chat
`/approve`, shared approval button payloads, and generic fallback delivery.
`ChannelPlugin.approvals` was removed; put approval delivery/native/render/auth
facts on one `approvalCapability` object instead. `plugin.auth` is login/logout
only - core no longer reads approval auth hooks from that object.

Use `approvalCapability.delivery` only for native approval routing or fallback
suppression, and `approvalCapability.render` only when a channel truly needs
custom approval payloads instead of the shared renderer.

### Approval auth

- `approvalCapability.authorizeActorAction` and
  `approvalCapability.getActionAvailabilityState` are the canonical
  approval-auth seam.
- Use `getActionAvailabilityState` for same-chat approval auth availability.
  Keep configured approvers available for `/approve` even when native delivery
  is disabled; use native initiating-surface state for delivery/setup guidance
  instead.
- If your channel exposes native exec approvals, use
  `approvalCapability.getExecInitiatingSurfaceState` for the
  initiating-surface/native-client state when it differs from same-chat
  approval auth. Core uses that exec-specific hook to distinguish `enabled` vs
  `disabled`, decide whether the initiating channel supports native exec
  approvals, and include the channel in native-client fallback guidance.
  `createApproverRestrictedNativeApprovalCapability(...)` fills this in for
  the common case.
- If a channel can infer stable owner-like DM identities from existing config,
  use `createResolvedApproverActionAuthAdapter` from
  `openclaw/plugin-sdk/approval-runtime` to restrict same-chat `/approve`
  without adding approval-specific core logic.
- If custom approval auth intentionally allows only same-chat fallback, return
  `markImplicitSameChatApprovalAuthorization({ authorized: true })` from
  `openclaw/plugin-sdk/approval-auth-runtime`; otherwise core treats the
  result as explicit approver authorization.
- If a channel-owned native callback resolves approvals directly, use
  `isImplicitSameChatApprovalAuthorization(...)` before resolving so implicit
  fallback still goes through the channel's normal actor authorization.

### Payload lifecycle and setup guidance

- Use `outbound.shouldSuppressLocalPayloadPrompt` or
  `outbound.beforeDeliverPayload` for channel-specific payload lifecycle
  behavior such as hiding duplicate local approval prompts or sending typing
  indicators before delivery.
- Use `approvalCapability.describeExecApprovalSetup` when the channel wants
  the disabled-path reply to explain the exact config knobs needed to enable
  native exec approvals. The hook receives `{ channel, channelLabel, accountId }`;
  named-account channels should render account-scoped paths such as
  `channels.<channel>.accounts.<id>.execApprovals.*` instead of top-level
  defaults.
- Use `approvalCapability.describePluginApprovalSetup` when plugin approval
  failure guidance is safe to show for plugin approval no-route and timeout
  failures. `createApproverRestrictedNativeApprovalCapability(...)` does not
  infer this from `describeExecApprovalSetup`; pass the same helper explicitly
  only when plugin and exec approvals truly use the same native setup.

### Native approval delivery

If a channel needs native approval delivery, keep channel code focused on
target normalization plus transport/presentation facts. Use
`createChannelExecApprovalProfile`, `createChannelNativeOriginTargetResolver`,
`createChannelApproverDmTargetResolver`, and
`createApproverRestrictedNativeApprovalCapability` from
`openclaw/plugin-sdk/approval-runtime`. Put the channel-specific facts behind
`approvalCapability.nativeRuntime`, ideally via
`createChannelApprovalNativeRuntimeAdapter(...)` or
`createLazyChannelApprovalNativeRuntimeAdapter(...)`, so core can assemble the
handler and own request filtering, routing, dedupe, expiry, gateway
subscription, and routed-elsewhere notices.

`nativeRuntime` is split into a few smaller seams:

- `availability` - whether the account is configured and whether a request
  should be handled
- `presentation` - map the shared approval view model into
  pending/resolved/expired native payloads or final actions
- `transport` - prepare targets plus send/update/delete native approval
  messages
- `interactions` - optional bind/unbind/clear-action hooks for native buttons
  or reactions, plus an optional `cancelDelivered` hook. Implement
  `cancelDelivered` when `deliverPending` registers in-process or persistent
  state (such as a reaction target store) so that state can be released if a
  handler stop cancels the delivery before `bindPending` runs, or when
  `bindPending` returns no handle
- `observe` - optional delivery diagnostics hooks

Native approval runtimes can receive three approval kinds: `exec`, `plugin`,
and `system-agent`. A `system-agent` request asks an operator to approve a
Gateway-side persistent change, such as a config write or Gateway restart.
The runtime must render the typed approval actions and then render the final
application result. An allowed request can finish as applied or not applied;
do not treat the recorded approval alone as proof that the change completed.

Other approval helpers:

- Use `createNativeApprovalChannelRouteGates` from
  `openclaw/plugin-sdk/approval-native-runtime` when a channel supports both
  session-origin native delivery and explicit approval forwarding targets. The
  helper centralizes approval config selection, `mode` handling, agent/session
  filters, account binding, session-target matching, and target-list matching
  while callers still own the channel id, default forwarding mode, account
  lookup, transport-enabled check, target normalization, and turn-source
  target resolution. Do not use it to create core-owned channel policy
  defaults; pass the channel's documented default mode explicitly.
- `createNativeApprovalMessagingTargetResolvers` centralizes channel matching
  and `{ to, accountId, threadId }` normalization for messaging transports
  whose native approval target is a channel-owned normalized destination.
  Keep group authorization, approver mapping, and other transport policy in
  the channel plugin.
- `createChannelNativeOriginTargetResolver` uses the shared channel-route
  matcher by default for `{ to, accountId, threadId }` targets. Pass
  `targetsMatch` only when a channel has provider-specific equivalence rules,
  such as Slack timestamp prefix matching. Pass `normalizeTargetForMatch` when
  the channel needs to canonicalize provider ids before the default route
  matcher or a custom `targetsMatch` callback runs, while preserving the
  original target for delivery. Use `normalizeTarget` only when the resolved
  delivery target itself should be canonicalized.
- If the channel needs runtime-owned objects such as a client, token, Bolt
  app, or webhook receiver, register them through
  `openclaw/plugin-sdk/channel-runtime-context`. The generic runtime-context
  registry lets core bootstrap capability-driven handlers from channel
  startup state without adding approval-specific wrapper glue.
- Reach for the lower-level `createChannelApprovalHandler` or
  `createChannelNativeApprovalRuntime` only when the capability-driven seam is
  not expressive enough yet.
- Native approval channels must route both `accountId` and `approvalKind`
  through those helpers. `accountId` keeps multi-account approval policy
  scoped to the right bot account, and `approvalKind` keeps exec vs plugin
  approval behavior available to the channel without hardcoded branches in
  core.
- Core owns approval reroute notices too. Channel plugins should not send
  their own "approval went to DMs / another channel" follow-up messages from
  `createChannelNativeApprovalRuntime`; instead, expose accurate origin +
  approver-DM routing through the shared approval capability helpers and let
  core aggregate actual deliveries before posting any notice back to the
  initiating chat.
- Preserve the delivered approval id kind end-to-end. Native clients should
  not guess or rewrite exec vs plugin approval routing from channel-local
  state.
- Pass that explicit `approvalKind` to `resolveApprovalOverGateway`. This uses
  the canonical `approval.resolve` service and returns the recorded winner when
  another surface answers first. The older explicit `resolveMethod` input
  remains for command-backed controls; new native actions must not use it or
  infer kind from an ID.
- Different approval kinds can intentionally expose different native
  surfaces. Current bundled examples: Matrix keeps the same native DM/channel
  routing and reaction UX for exec and plugin approvals, while still letting
  auth differ by approval kind; Slack keeps native approval routing available
  for both exec and plugin ids.
- `createApproverRestrictedNativeApprovalAdapter` still exists as a
  compatibility wrapper, but new code should prefer the capability builder
  and expose `approvalCapability` on the plugin.

### Narrower approval runtime subpaths

For hot channel entrypoints, prefer these narrower subpaths over the broader
`approval-runtime` barrel when you only need one part of that family:

- `openclaw/plugin-sdk/approval-auth-runtime`
- `openclaw/plugin-sdk/approval-client-runtime`
- `openclaw/plugin-sdk/approval-delivery-runtime`
- `openclaw/plugin-sdk/approval-gateway-runtime`
- `openclaw/plugin-sdk/approval-reference-runtime`
- `openclaw/plugin-sdk/approval-handler-adapter-runtime`
- `openclaw/plugin-sdk/approval-handler-runtime`
- `openclaw/plugin-sdk/approval-native-runtime`
- `openclaw/plugin-sdk/approval-reply-runtime`
- `openclaw/plugin-sdk/channel-runtime-context`

Likewise, prefer `openclaw/plugin-sdk/reply-runtime`,
`openclaw/plugin-sdk/reply-dispatch-runtime`,
`openclaw/plugin-sdk/reply-reference`, and
`openclaw/plugin-sdk/reply-chunking` over broader umbrella surfaces when you
do not need them all.

### Setup subpaths

- `openclaw/plugin-sdk/setup-runtime` covers the runtime-safe setup helpers:
  `createSetupTranslator`, import-safe setup patch adapters
  (`createPatchedAccountSetupAdapter`, `createEnvPatchedAccountSetupAdapter`,
  `createSetupInputPresenceValidator`), lookup-note output,
  `promptResolvedAllowFrom`, `splitSetupEntries`, and the delegated
  setup-proxy builders.
- `openclaw/plugin-sdk/channel-setup` covers the optional-install setup
  builders plus a few setup-safe primitives: `createOptionalChannelSetupSurface`,
  `createOptionalChannelSetupAdapter`, `createOptionalChannelSetupWizard`,
  `DEFAULT_ACCOUNT_ID`, `createTopLevelChannelDmPolicy`,
  `setSetupChannelEnabled`, and `splitSetupEntries`.
- Use the broader `openclaw/plugin-sdk/setup` seam only when you also need
  the heavier shared setup/config helpers such as
  `moveSingleAccountChannelSectionToDefaultAccount(...)`.

If your channel only wants to advertise "install this plugin first" in setup
surfaces, prefer `createOptionalChannelSetupSurface(...)`. The generated
adapter/wizard fail closed on config writes and finalization, and they reuse
the same install-required message across validation, finalize, and docs-link
copy.

If your channel supports env-driven setup or auth, expose it through the
channel config schema and setup descriptors. Keep channel runtime `envVars` or
local constants for operator-facing copy only.

If your channel can appear in `status`, `channels list`, `channels status`, or
SecretRef scans before the plugin runtime starts, add `openclaw.setupEntry` in
`package.json`. That entrypoint should be safe to import in read-only command
paths and should return the channel metadata, setup-safe config adapter,
status adapter, and channel secret target metadata needed for those
summaries. Do not start clients, listeners, or transport runtimes from the
setup entry.

Keep the main channel entry import path narrow too. Discovery can evaluate
the entry and the channel plugin module to register capabilities without
activating the channel. Files such as `channel-plugin-api.ts` should export
the channel plugin object without importing setup wizards, transport
clients, socket listeners, subprocess launchers, or service startup modules.
Put those runtime pieces in modules loaded from `registerFull(...)`, runtime
setters, or lazy capability adapters.

### Account schemas and inheritance

Use `buildChannelAccountSchemaParts` from
`openclaw/plugin-sdk/channel-config-schema`. Its `accountShape` leaves
`dmPolicy` and `groupPolicy` optional, so an omitted account policy inherits
the channel root. Spread its `rootPolicyShape` into the root schema
only: it defaults DMs to `pairing` and groups to `allowlist`. Do not apply
those defaults to account entries or remove them from the root; the former
shadows operator settings and the latter can leave group access open.
This replaces `buildCommonChannelAccountShape` and its defaulting flags.

Use `mergeAccountConfig` or `resolveMergedAccountConfig` through the existing
`openclaw/plugin-sdk/account-helpers` export for runtime inheritance. Their
shared implementation lives at `src/config/channel-account-config.ts`;
plugins must use the SDK import. Account fields replace root fields, including
explicit empty collections. `nestedObjectKeys` selects shallow object merges;
`inheritEmptyKeys` maps fields to `"array"` or `"object"` to inherit the root
when that kind of account collection is empty. `preserveRootAllowFrom: true` removes an account wildcard
when the root contains restrictive sender entries, retaining explicit account
senders or falling back to the root list. These collection and allowlist rules
are owner-selected, not universal channel defaults. Keep credentials, transport
selection, and other channel-specific account concerns in the plugin.

### Other narrow channel subpaths

For other hot channel paths, prefer the narrow helpers over broader legacy
surfaces:

- `openclaw/plugin-sdk/account-core`, `openclaw/plugin-sdk/account-id`,
  `openclaw/plugin-sdk/account-resolution`, and
  `openclaw/plugin-sdk/account-helpers` for multi-account config and
  default-account fallback
- `openclaw/plugin-sdk/inbound-envelope` and
  `openclaw/plugin-sdk/channel-inbound` for inbound route/envelope and
  record-and-dispatch wiring
- `readAgentRunTerminalOutcome(dispatchResult)` from
  `openclaw/plugin-sdk/channel-inbound` when terminal reactions or status UI
  must distinguish a completed core agent run from a recovered failed run. It
  returns `"completed"` or `"failed"` only when a core run actually started,
  and `undefined` for commands, dedupe, busy, pre-run abort, and custom dispatch
  results. Delivery counts and visibility remain transport facts, including
  successful delivery of an error payload; the process-local carrier is not
  serialized to JSON.
- `createInboundEventDeliveryCorrelation(...)` from
  `openclaw/plugin-sdk/inbound-event-delivery` when successful outbound sends must
  retire an active inbound-event marker; create one tracker per channel and
  keep target matching in the channel plugin
- `openclaw/plugin-sdk/channel-targets` for target parsing helpers
- `openclaw/plugin-sdk/channel-outbound` for outbound identity/send delegates
  and typed payload planning
- `buildThreadAwareOutboundSessionRoute(...)` from
  `openclaw/plugin-sdk/channel-core` when an outbound route should preserve
  an explicit `replyToId`/`threadId` or recover the current `:thread:`
  session after the base session key still matches. Provider plugins can
  override precedence, suffix behavior, and thread id normalization when
  their platform has native thread delivery semantics.
- `openclaw/plugin-sdk/thread-bindings-runtime` for thread-binding lifecycle
  and adapter registration

The `threading.resolveReplyTransport` hook receives the payload's optional
`replyToCurrent` intent separately from `replyToIsExplicit`. Channels whose
native API requires a thread root can resolve a current-message reply against
the admitted thread without redirecting arbitrary explicit `replyToId` targets.
Omitted intent keeps the existing explicit-target behavior.

Auth-only channels can usually stop at the default path: core handles
approvals and the plugin just exposes outbound/auth capabilities. Native
approval channels such as Matrix, Slack, Telegram, and custom chat transports
should use the shared native helpers instead of rolling their own approval
lifecycle.

## Inbound mention policy

Keep inbound mention handling split in two layers:

- plugin-owned evidence gathering
- shared policy evaluation

Use `openclaw/plugin-sdk/channel-mention-gating` for mention-policy decisions.
Use `openclaw/plugin-sdk/channel-inbound` only when you need the broader
inbound helper barrel.

Good fit for plugin-local logic:

- reply-to-bot detection
- quoted-bot detection
- thread-participation checks
- service/system-message exclusions
- platform-native caches needed to prove bot participation

Good fit for the shared helper:

- `requireMention`
- explicit mention result
- implicit mention allowlist
- command bypass
- final skip decision

Preferred flow:

1. Compute local mention facts.
2. Pass those facts into `resolveInboundMentionDecision({ facts, policy })`.
3. Use `decision.effectiveWasMentioned`, `decision.shouldBypassMention`, and
   `decision.shouldSkip` in your inbound gate.

```typescript
import {
  implicitMentionKindWhen,
  matchesMentionWithExplicit,
  resolveInboundMentionDecision,
} from "openclaw/plugin-sdk/channel-inbound";
import { resolveChannelImplicitMentions } from "openclaw/plugin-sdk/channel-ingress-runtime";

const wasMentioned = matchesMentionWithExplicit({
  text,
  mentionRegexes,
  explicit: {
    hasAnyMention,
    isExplicitlyMentioned,
    canResolveExplicit,
  },
});

const facts = {
  canDetectMention: true,
  wasMentioned,
  hasAnyMention,
  implicitMentionKinds: [
    ...implicitMentionKindWhen("reply_to_bot", isReplyToBot),
    ...implicitMentionKindWhen("quoted_bot", isQuoteOfBot),
  ],
};

const implicitMentions = resolveChannelImplicitMentions({
  cfg,
  channel: channelId,
  accountId,
});

const decision = resolveInboundMentionDecision({
  facts,
  policy: {
    isGroup,
    requireMention,
    implicitMentions,
    allowTextCommands,
    hasControlCommand,
    commandAuthorized,
  },
});

if (decision.shouldSkip) return;
```

`matchesMentionWithExplicit(...)` returns a boolean. `hasAnyMention`,
`isExplicitlyMentioned`, and `canResolveExplicit` come from the channel's own
native mention metadata (message entities, reply-to-bot flags, and similar);
supply `false`/`undefined` values when your platform cannot detect them.

`api.runtime.channel.mentions` exposes the same shared mention helpers for
bundled channel plugins that already depend on runtime injection:
`buildMentionRegexes`, `matchesMentionPatterns`, `matchesMentionWithExplicit`,
`implicitMentionKindWhen`, `resolveInboundMentionDecision`.

If you only need `implicitMentionKindWhen` and `resolveInboundMentionDecision`,
import from `openclaw/plugin-sdk/channel-mention-gating` to avoid loading
unrelated inbound runtime helpers.

## Walkthrough

<Steps>
  <a id="step-1-package-and-manifest"></a>
  <Step title="Package and manifest">
    Create the standard plugin files. The `channels` field in
    `openclaw.plugin.json` (not a `kind` field) is what marks a manifest as
    owning a channel. For the full package-metadata surface, see
    [Plugin Setup and Config](/plugins/sdk-setup#openclaw-channel):

    <CodeGroup>
    ```json package.json
    {
      "name": "@myorg/openclaw-acme-chat",
      "version": "1.0.0",
      "type": "module",
      "openclaw": {
        "extensions": ["./index.ts"],
        "setupEntry": "./setup-entry.ts",
        "channel": {
          "id": "acme-chat",
          "label": "Acme Chat",
          "blurb": "Connect OpenClaw to Acme Chat."
        }
      }
    }
    ```

    ```json openclaw.plugin.json
    {
      "id": "acme-chat",
      "channels": ["acme-chat"],
      "name": "Acme Chat",
      "description": "Acme Chat channel plugin",
      "configSchema": {
        "type": "object",
        "additionalProperties": false,
        "properties": {}
      },
      "channelConfigs": {
        "acme-chat": {
          "schema": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "token": { "type": "string" },
              "allowFrom": {
                "type": "array",
                "items": { "type": "string" }
              }
            }
          },
          "uiHints": {
            "token": {
              "label": "Bot token",
              "sensitive": true
            }
          }
        }
      }
    }
    ```
    </CodeGroup>

    `configSchema` validates `plugins.entries.acme-chat.config`. Use it for
    plugin-owned settings that are not the channel account config.
    `channelConfigs.acme-chat.schema` validates `channels.acme-chat` and is the
    cold-path source used by config schema, setup, and UI surfaces before the
    plugin runtime loads. See [Plugin manifest](/plugins/manifest) for the full
    top-level field reference.

  </Step>

  <Step title="Build the channel plugin object">
    The `ChannelPlugin` interface has many optional adapter surfaces. Start with
    the minimum - `id`, `config`, and `setup` - and add adapters as you need
    them. `createChatChannelPlugin` defaults omitted capabilities to direct
    messages; declare `capabilities.chatTypes` when the channel supports more.

    `config.inspectAccount` is synchronous and returns metadata
    for read-only diagnostics, including disabled or configured-but-unavailable
    accounts. Return `enabled`, `configured`, and applicable credential status
    fields without requiring secret resolution. Its result is not a resolved
    account: operational hooks such as probes and account status builders receive
    `config.resolveAccount` results instead.
    Diagnostics expose only status-safe fields from the inspection result.
    Include the same account enablement and configuration decisions used by the
    runtime, including duplicate-account suppression. If `configured` is omitted,
    diagnostics use a recorded Gateway value when available; otherwise they report
    that configuration status is unavailable.
    Selection before secret redemption also reads this metadata directly. Directory
    auto-selection requires `configured: true`; callers can still select the channel
    explicitly when configuration status is unknown.

    Create `src/channel.ts`:

    ```typescript src/channel.ts
    import {
      createChatChannelPlugin,
      createChannelPluginBase,
    } from "openclaw/plugin-sdk/channel-core";
    import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
    import { acmeChatApi } from "./client.js"; // your platform API client

    type ResolvedAccount = {
      accountId: string | null;
      token: string;
      allowFrom: string[];
      dmPolicy: string | undefined;
    };

    function resolveAccount(
      cfg: OpenClawConfig,
      accountId?: string | null,
    ): ResolvedAccount {
      const section = (cfg.channels as Record<string, any>)?.["acme-chat"];
      const token = section?.token;
      if (!token) throw new Error("acme-chat: token is required");
      return {
        accountId: accountId ?? null,
        token,
        allowFrom: section?.allowFrom ?? [],
        dmPolicy: section?.dmSecurity,
      };
    }

    export const acmeChatPlugin = createChatChannelPlugin<ResolvedAccount>({
      base: createChannelPluginBase({
        id: "acme-chat",
        // Account resolution/inspection belongs on `config`, not `setup`.
        // `setup` covers onboarding writes (applyAccountConfig, validateInput).
        config: {
          listAccountIds: () => ["default"],
          resolveAccount,
          inspectAccount(cfg, accountId) {
            const section =
              (cfg.channels as Record<string, any>)?.["acme-chat"];
            return {
              enabled: Boolean(section?.token),
              configured: Boolean(section?.token),
              tokenStatus: section?.token ? "available" : "missing",
            };
          },
        },
        setup: {
          applyAccountConfig: ({ cfg, input }) => ({
            ...cfg,
            channels: {
              ...cfg.channels,
              "acme-chat": { ...(cfg.channels as any)?.["acme-chat"], ...input },
            },
          }),
        },
      }),

      // DM security: who can message the bot
      security: {
        dm: {
          channelKey: "acme-chat",
          resolvePolicy: (account) => account.dmPolicy,
          resolveAllowFrom: (account) => account.allowFrom,
          defaultPolicy: "allowlist",
        },
      },

      // Pairing: approval flow for new DM contacts
      pairing: {
        text: {
          idLabel: "Acme Chat username",
          message: "Send this code to verify your identity:",
          notify: async ({ target, code }) => {
            await acmeChatApi.sendDm(target, `Pairing code: ${code}`);
          },
        },
      },

      // Threading: how replies are delivered
      threading: { topLevelReplyToMode: "reply" },

      // Outbound: send messages to the platform
      outbound: {
        attachedResults: {
          channel: "acme-chat",
          sendText: async (params) => {
            const result = await acmeChatApi.sendMessage(
              params.to,
              params.text,
            );
            return { messageId: result.id };
          },
        },
        base: {
          sendMedia: async (params) => {
            await acmeChatApi.sendFile(params.to, params.filePath);
          },
        },
      },
    });
    ```

    For channels that accept both canonical top-level DM keys and legacy nested keys, use the helpers from `plugin-sdk/channel-config-helpers`: `resolveChannelDmAccess`, `resolveChannelDmPolicy`, `resolveChannelDmAllowFrom`, and `normalizeChannelDmPolicy` keep account-local values ahead of inherited root values. Pair the same resolver with doctor repair through `normalizeLegacyDmAliases` so runtime and migration read the same contract.

    Config-backed logout handlers can use `clearAccountFieldsFromConfigSection`
    from `openclaw/plugin-sdk/channel-config-helpers`. Pass `cfg`, `sectionKey`,
    `accountId`, and the plugin-owned `fields` to remove. It returns
    `{ nextConfig, changed, cleared }` without writing config or resolving
    credentials. Root fields clear together only for the exact `default` account
    when at least one value is truthy. Nested fields use `clearAccountEntryFields`
    semantics: an empty account ID selects `accounts.default`, and empty or
    whitespace strings are removed without reporting `cleared` unless
    `markClearedOnFieldPresence: true` is set. Unchanged config retains its object
    identity; cleanup prunes only branches it changes. Keep file-reference
    selection, persistence, environment reporting, and other logout side effects
    in the plugin.

    If a channel intentionally applies stricter DM session routing than the
    global config, expose that behavior through `security.dmRouting` so Doctor
    and security audit resolve the same session owner as runtime. The optional
    `resolveDmScope` callback runs before core route resolution; its context
    includes `cfg`, `accountId`, the resolved `account`, and a `principalId`
    for finite allowlist entries. `resolveDmRoute` receives those fields plus
    the resolved core `route`; it may return `{ sessionKey }` for a shared final
    bucket, `{ kind: "isolated" }` for an unknown peer, or `{ kind: "core" }`
    to preserve core `dmScope` namespace analysis. For wildcard/open policy,
    `principalId` is absent and an undefined result is reported as unverified.
    Diagnostics never invent a peer ID. Keep both callbacks pure and
    import-safe because read-only diagnostics run without channel runtime.

    Channel-specific security diagnostics can use `security.collectWarnings`.
    Legacy string results are warning severity. Return the structured
    `SecurityAuditFinding` shape (`checkId`, `severity`, `title`, `detail`, and
    optional `remediation`) when the producer must declare informational or
    critical severity; the same finding is used by Doctor and the main security
    audit. Use `collectAuditFindings` only for diagnostics that should appear in
    the full security audit but not Doctor.

    <Accordion title="What createChatChannelPlugin does for you">
      Instead of implementing low-level adapter interfaces manually, you pass
      declarative options and the builder composes them:

      | Option | What it wires |
      | --- | --- |
      | `security.dm` | Scoped DM security resolver from config fields |
      | `pairing.text` | Text-based DM pairing flow with code exchange |
      | `threading` | Reply-to-mode resolver (fixed, account-scoped, or custom) |
      | `outbound.attachedResults` | Send functions that return result metadata (message IDs); requires a sibling `channel` id so core can stamp the returned delivery result |

      You can also pass raw adapter objects instead of the declarative options
      if you need full control.

      Raw outbound adapters may define a `chunker(text, limit, ctx)` function.
      The optional `ctx.formatting` carries delivery-time formatting decisions
      such as `maxLinesPerMessage`; apply it before sending so reply threading
      and chunk boundaries are resolved once by shared outbound delivery.
      Send contexts also include `replyToIdSource` (`implicit` or `explicit`)
      when a native reply target was resolved, so payload helpers can preserve
      explicit reply tags without consuming an implicit single-use reply slot.
    </Accordion>

    ### Group tool-policy adapters

    A channel that implements `group.resolveToolPolicy` and supports
    `toolsBySender` must forward the complete `ChannelGroupContext` to its
    shared policy resolver. In particular, honor `senderPolicyMode: "never"`
    by skipping sender-specific overlays at both the matched-group and wildcard
    scopes while still applying the base `tools` policy.

    OpenClaw sets this mode only for trusted non-ingress execution whose sender
    authority was already captured in a server-owned envelope, such as an
    explicitly capped scheduled run. Plugins must not derive the mode from
    inbound metadata, persist it as channel state, or expose it as config. Add
    an adapter test that proves the mode skips a wildcard `toolsBySender` entry
    without dropping the matching base `tools` restriction.

    ### Native plugin command ownership

    Channel plugins that publish provider-native command catalogs should use
    `openclaw/plugin-sdk/plugin-command-runtime`. Create one runtime while
    planning the catalog, merge its candidates with built-in and skill entries,
    and retain the winning candidate object in the registered handler closure.
    A plugin registry replacement drains and restarts loaded channel accounts
    so their handlers, command catalogs, and routes use the new generation.
    Manually stopped accounts stay stopped. Ordinary channel config changes
    still restart only the affected channel or accounts.
    `retainNativeCatalog(provider)` is deprecated and will be removed in the
    next breaking SDK release; existing calls only assert that the captured
    registry generation is still active.
    Call `prepareDispatch(rawArgs)` only on that winner and execute the returned
    dispatch with `dispatch.execute(context)`. Carry an explicit
    `{ kind: "non-plugin" }` decision for retained built-in and skill winners.
    This keeps the advertised command and
    its executable plugin registration on the same registry generation.

    Candidates expose only immutable display/auth/progress metadata plus an
    opaque process-local dispatch. They do not expose handlers, plugin roots,
    or registry rows. Dispatches cannot cross runtime factories or channels,
    and a registry replacement makes new executions return an unavailable
    result instead of rematching command text against the replacement registry.
    A command already admitted before retirement may finish on its captured
    generation. Do not serialize candidates or dispatches; project only their
    display fields into provider API payloads.

  </Step>

  <Step title="Wire the entry point">
    Create `index.ts`:

    ```typescript index.ts
    import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";
    import { acmeChatPlugin } from "./src/channel.js";

    export default defineChannelPluginEntry({
      id: "acme-chat",
      name: "Acme Chat",
      description: "Acme Chat channel plugin",
      plugin: acmeChatPlugin,
      registerCliMetadata(api) {
        api.registerCli(
          ({ program }) => {
            program
              .command("acme-chat")
              .description("Acme Chat management");
          },
          {
            descriptors: [
              {
                name: "acme-chat",
                description: "Acme Chat management",
                hasSubcommands: false,
              },
            ],
          },
        );
      },
      registerFull(api) {
        api.registerGatewayMethod(/* ... */);
      },
    });
    ```

    Put channel-owned CLI descriptors in `registerCliMetadata(...)` so OpenClaw
    can show them in root help without activating the full channel runtime,
    while normal full loads still pick up the same descriptors for real command
    registration. Keep `registerFull(...)` for runtime-only work.
    `defineChannelPluginEntry` handles the registration-mode split automatically.
    If `registerFull(...)` registers gateway RPC methods, use a
    plugin-specific prefix. Core admin namespaces (`config.*`,
    `exec.approvals.*`, `wizard.*`, `update.*`) stay reserved and always
    resolve to `operator.admin`. See
    [Entry Points](/plugins/sdk-entrypoints#definechannelpluginentry) for all
    options.

  </Step>

  <Step title="Add a setup entry">
    Create `setup-entry.ts` for lightweight loading during onboarding:

    ```typescript setup-entry.ts
    import { defineSetupPluginEntry } from "openclaw/plugin-sdk/channel-core";
    import { acmeChatPlugin } from "./src/channel.js";

    export default defineSetupPluginEntry(acmeChatPlugin);
    ```

    OpenClaw loads this instead of the full entry when the channel is disabled
    or unconfigured. It avoids pulling in heavy runtime code during setup flows.
    See [Setup and Config](/plugins/sdk-setup#setup-entry) for details.

    Bundled workspace channels that split setup-safe exports into sidecar
    modules can use `defineBundledChannelSetupEntry(...)` from
    `openclaw/plugin-sdk/channel-entry-contract` when they also need an
    explicit setup-time runtime setter.

  </Step>

  <Step title="Handle inbound messages">
    Your plugin needs to receive messages from the platform and forward them to
    OpenClaw. The typical pattern is a webhook that verifies the request and
    dispatches it through your channel's inbound handler:

    ```typescript
    registerFull(api) {
      api.registerHttpRoute({
        path: "/acme-chat/webhook",
        auth: "plugin", // plugin-managed auth (verify signatures yourself)
        handler: async (req, res) => {
          const event = parseWebhookPayload(req);

          // Your inbound handler dispatches the message to OpenClaw.
          // The exact wiring depends on your platform SDK -
          // see a real example in the bundled Microsoft Teams or Google Chat plugin package.
          await handleAcmeChatInbound(api, event);

          res.statusCode = 200;
          res.end("ok");
          return true;
        },
      });
    }
    ```

    <Note>
      Inbound message handling is channel-specific. Each channel plugin owns
      its own inbound pipeline. Look at bundled channel plugins
      (for example the Microsoft Teams or Google Chat plugin package) for real patterns.
    </Note>

  </Step>

<a id="step-6-test"></a>
<Step title="Test">
Write colocated tests in `src/channel.test.ts`:

    ```typescript src/channel.test.ts
    import { describe, it, expect } from "vitest";
    import { acmeChatPlugin } from "./channel.js";

    describe("acme-chat plugin", () => {
      it("resolves account from config", () => {
        const cfg = {
          channels: {
            "acme-chat": { token: "test-token", allowFrom: ["user1"] },
          },
        } as any;
        const account = acmeChatPlugin.config.resolveAccount(cfg, undefined);
        expect(account.token).toBe("test-token");
      });

      it("inspects account without materializing secrets", () => {
        const cfg = {
          channels: { "acme-chat": { token: "test-token" } },
        } as any;
        const result = acmeChatPlugin.config.inspectAccount!(cfg, undefined);
        expect(result.configured).toBe(true);
        expect(result.tokenStatus).toBe("available");
      });

      it("reports missing config", () => {
        const cfg = { channels: {} } as any;
        const result = acmeChatPlugin.config.inspectAccount!(cfg, undefined);
        expect(result.configured).toBe(false);
      });
    });
    ```

    ```bash
    pnpm test <bundled-plugin-root>/acme-chat/
    ```

    For shared test helpers, see [Testing](/plugins/sdk-testing).

</Step>
</Steps>

## File structure

```text
<bundled-plugin-root>/acme-chat/
├── package.json              # openclaw.channel metadata
├── openclaw.plugin.json      # Manifest with config schema
├── index.ts                  # defineChannelPluginEntry
├── setup-entry.ts            # defineSetupPluginEntry
├── api.ts                    # Public exports (optional)
├── runtime-api.ts            # Internal runtime exports (optional)
└── src/
    ├── channel.ts            # ChannelPlugin via createChatChannelPlugin
    ├── channel.test.ts       # Tests
    ├── client.ts             # Platform API client
    └── runtime.ts            # Runtime store (if needed)
```

## Advanced topics

<CardGroup cols={2}>
  <Card title="Threading options" icon="git-branch" href="/plugins/sdk-entrypoints#registration-mode">
    Fixed, account-scoped, or custom reply modes
  </Card>
  <Card title="Message tool integration" icon="puzzle" href="/plugins/architecture#channel-plugins-and-the-shared-message-tool">
    describeMessageTool and action discovery
  </Card>
  <Card title="Target resolution" icon="crosshair" href="/plugins/architecture-internals#channel-target-resolution">
    inferTargetChatType, looksLikeId, reservedLiterals, resolveTarget
  </Card>
  <Card title="Runtime helpers" icon="settings" href="/plugins/sdk-runtime">
    TTS, STT, media, subagent via api.runtime
  </Card>
  <Card title="Channel inbound API" icon="bolt" href="/plugins/sdk-channel-inbound">
    Shared inbound event lifecycle: ingest, resolve, record, dispatch, finalize
  </Card>
</CardGroup>

<Note>
Some bundled helper seams still exist for bundled-plugin maintenance and
compatibility. They are not the recommended pattern for new channel plugins;
prefer the generic channel/setup/reply/runtime subpaths from the common SDK
surface unless you are maintaining that bundled plugin family directly.
</Note>

## Next steps

- [Provider Plugins](/plugins/sdk-provider-plugins) - if your plugin also provides models
- [SDK Overview](/plugins/sdk-overview) - full subpath import reference
- [SDK Testing](/plugins/sdk-testing) - test utilities and contract tests
- [Plugin Manifest](/plugins/manifest) - full manifest schema

## Related

- [Plugin SDK setup](/plugins/sdk-setup)
- [Building plugins](/plugins/building-plugins)
- [Agent harness plugins](/plugins/sdk-agent-harness)
