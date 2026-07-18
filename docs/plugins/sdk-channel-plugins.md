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

Inbound receivers that defer platform acknowledgements should declare
`message.receive.defaultAckPolicy` and `supportedAckPolicies` instead of hiding
ack timing in monitor-local state. Cover every declared policy with
`verifyChannelMessageReceiveAckPolicyAdapterProofs(...)`.

Legacy reply helpers such as `dispatchInboundReplyWithBase` and
`recordInboundSessionAndDispatchReply` remain available for compatibility
dispatchers. Do not use them for new channel code; start with the `message`
adapter, receipts, and receive/send lifecycle helpers on
`openclaw/plugin-sdk/channel-outbound` instead.

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

### Durable ingress and replay dedupe

Channels adopting the durable ingress drain follow the Telegram reference
pattern: enqueue the raw transport envelope at a single receive chokepoint
(no normalization at receive time), gate the transport ack on the durable
append for webhook transports, derive one serialized lane per conversation,
and mark the event complete at dispatch adoption. The queue's primary key is
`(queue_name, event_id)` and completion tombstones the row instead of
deleting it, so a late platform redelivery of the same `event_id` is rejected
durably for the tombstone retention window.

That tombstone is the layering rule for replay guards
(`openclaw/plugin-sdk/persistent-dedupe`): a drained channel keeps a separate
replay guard only when the guard's identity or retention exceeds the queue's
— a logical message key that differs from the transport delivery id (Telegram
dedupes `chat_id:message_id` because debounce merges can re-surface a message
under a fresh `update_id`), or a longer window than the channel's tombstone
retention. If your guard key would equal the drain `event_id`, delete the
guard when adopting the drain and size `completedTtlMs`/`completedMaxEntries`
to cover the old guard window instead. Non-dedupe protections (age fences,
outbound echo caches) are unrelated to this rule and stay.

### Typing indicators

If your channel supports typing indicators outside inbound replies, expose
`heartbeat.sendTyping(...)` on the channel plugin. Core calls it with the
resolved heartbeat delivery target before the heartbeat model run starts and
uses the shared typing keepalive/cleanup lifecycle. Add
`heartbeat.clearTyping(...)` when the platform needs an explicit stop signal.

### Media source params

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

### Account-scoped conversation binding support

Set `conversationBindings.supportsCurrentConversationBinding` when the channel
supports generic current-conversation bindings. `createChatChannelPlugin(...)`
sets this static capability to `true` by default.

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

If your channel supports env-driven setup or auth and generic startup/config
flows should know those env names before runtime loads, declare them in the
plugin manifest with `channelEnvVars`. Keep channel runtime `envVars` or local
constants for operator-facing copy only.

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
- `openclaw/plugin-sdk/channel-targets` for target parsing helpers
- `openclaw/plugin-sdk/outbound-media` for media loading and
  `openclaw/plugin-sdk/channel-outbound` for outbound identity/send delegates
  and payload planning
- `buildThreadAwareOutboundSessionRoute(...)` from
  `openclaw/plugin-sdk/channel-core` when an outbound route should preserve
  an explicit `replyToId`/`threadId` or recover the current `:thread:`
  session after the base session key still matches. Provider plugins can
  override precedence, suffix behavior, and thread id normalization when
  their platform has native thread delivery semantics.
- `openclaw/plugin-sdk/thread-bindings-runtime` for thread-binding lifecycle
  and adapter registration
- `openclaw/plugin-sdk/agent-media-payload` only when a legacy agent/media
  payload field layout is still required
- `openclaw/plugin-sdk/telegram-command-config` (deprecated: no bundled
  plugin uses it in production) for Telegram custom-command normalization,
  duplicate/conflict validation, and a fallback-stable command config
  contract; prefer plugin-local command config handling for new plugin code

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
    them.

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
