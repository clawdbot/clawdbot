---
summary: "Experimental channel ingress API for inbound message authorization"
read_when:
  - Building or migrating a messaging channel plugin
  - Changing DM or group allowlists, route gates, command auth, event auth, or mention activation
  - Reviewing channel ingress redaction or SDK compatibility boundaries
title: "Channel ingress API"
sidebarTitle: "Channel Ingress"
---

Channel ingress is the experimental access-control boundary for inbound
channel events. Plugins own platform facts and side effects; core owns
generic policy: DM/group allowlists, pairing-store DM entries, route gates,
command gates, event auth, mention activation, redacted diagnostics, and
admission.

Use `openclaw/plugin-sdk/channel-ingress-runtime` for receive paths.

## Runtime resolver

```ts
import {
  defineStableChannelIngressIdentity,
  resolveChannelMessageIngress,
} from "openclaw/plugin-sdk/channel-ingress-runtime";
import { buildChannelInboundEventContext } from "openclaw/plugin-sdk/channel-inbound";

const identity = defineStableChannelIngressIdentity({
  key: "platform-user-id",
  normalize: normalizePlatformUserId,
  sensitivity: "pii",
});

const result = await resolveChannelMessageIngress({
  channelId: "my-channel",
  accountId,
  identity,
  subject: { stableId: platformUserId },
  conversation: { kind: isGroup ? "group" : "direct", id: conversationId },
  event: { kind: "message", authMode: "inbound", mayPair: !isGroup },
  policy: {
    dmPolicy: config.dmPolicy,
    groupPolicy: config.groupPolicy,
    groupAllowFromFallbackToAllowFrom: true,
  },
  allowFrom: config.allowFrom,
  groupAllowFrom: config.groupAllowFrom,
  accessGroups: cfg.accessGroups,
  route,
  readStoreAllowFrom,
  command: hasControlCommand ? { allowTextCommands: true, hasControlCommand } : undefined,
});

const ctx = buildChannelInboundEventContext({
  // Pass the exact host result; do not rebuild participant evidence from
  // SenderId, From, session keys, routes, rooms, or message metadata.
  channelIngress: result,
  // ...normalized channel facts
});
```

Do not precompute effective allowlists, command owners, or command groups.
The resolver derives them from raw allowlists, store callbacks, route
descriptors, access groups, policy, and conversation kind.

## Result

Bundled plugins should consume modern projections directly:

| Field              | Meaning                                                            |
| ------------------ | ------------------------------------------------------------------ |
| `ingress`          | ordered gate decision and admission                                |
| `senderAccess`     | sender/conversation authorization only                             |
| `routeAccess`      | route and route-sender projection                                  |
| `commandAccess`    | command authorization; `requested: false` when no command gate ran |
| `activationAccess` | mention/activation result                                          |

Event authorization stays available on the ordered `ingress.graph` and the
decisive `ingress.reasonCode`; no separate event projection is emitted.

Deprecated third-party SDK helpers may rebuild older shapes internally. New
bundled receive paths should not translate modern results back into local
DTOs.

When execution-identity audit collection is enabled, the inbound context
builder privately carries the exact admitted participant to run admission.
Queue collection retains attribution only when every contribution has valid
evidence for the same participant; mixed, missing, stale, or unminted evidence
is `unknown`. The carrier is opaque, bounded, one-shot, and diagnostic only.
Plugins cannot mint participant evidence from caller-chosen sender, account,
room, route, session, message, or transport fields. The SDK intentionally
exposes no participant-evidence constructor. A structurally similar result or
copied context does not gain host authority.

The audit states are distinct:

- **supported**: the authoritative ingress resolver ran. Its exact result can
  yield a present invoker and enforced or attribution-only coverage.
- **unknown**: a supported handoff was missing, stale, fake, reused, mixed, or
  otherwise failed host validation. Unknown never means allowed.
- **unsupported**: a named path has no Phase 0 authoritative integration and
  explicitly passes `channelIngress: "unsupported"`. Unsupported never means
  allowed and is not a shortcut for incomplete wiring.

## Access groups

`accessGroup:<name>` entries stay redacted. Core resolves static
`message.senders` groups itself and calls `resolveAccessGroupMembership` only
for dynamic groups that require a platform lookup. Missing, unsupported, and
failed groups fail closed.

## Event modes

| `authMode`       | Meaning                                          |
| ---------------- | ------------------------------------------------ |
| `inbound`        | normal inbound sender gates                      |
| `command`        | command gates for callbacks or scoped buttons    |
| `origin-subject` | actor must match the original message subject    |
| `route-only`     | route gates only for route-scoped trusted events |
| `none`           | plugin-owned internal events bypass shared auth  |

Use `mayPair: false` for reactions, buttons, callbacks, and native commands.

## Routes and activation

Use route descriptors for room, topic, guild, thread, or nested route policy:

```ts
route: {
  id: "room",
  allowed: roomAllowed,
  enabled: roomEnabled,
  senderPolicy: "replace",
  senderAllowFrom: roomAllowFrom,
  blockReason: "room_sender_not_allowlisted",
}
```

Use `channelIngressRoutes(...)` when a plugin has several optional route
descriptors; it filters disabled branches while keeping route facts generic
and ordered by each descriptor's `precedence`.

Mention gating is an activation gate. A mention miss returns
`admission: "skip"` so the turn kernel does not process an observe-only turn.
Most channels should leave activation after sender and command gates. Public
chat surfaces that must quiet non-mentioned traffic before sender allowlist
noise can opt into `activation.order: "before-sender"` when text-command
bypass is disabled. Channels with implicit activation, such as replies in bot
threads, resolve `channels.defaults.implicitMentions` plus channel and account
overrides with `resolveChannelImplicitMentions(...)`, then pass the result as
`activation.implicitMentions`. The projected
`activationAccess.shouldBypassMention` reports when command or implicit
activation bypassed an explicit mention.

## Redaction

Raw sender values and raw allowlist entries are resolver input only. They
must not appear in resolved state, decisions, diagnostics, snapshots, or
compatibility facts. Use opaque subject ids, entry ids, route ids, and
diagnostic ids.

## Verification

```bash
pnpm test src/channels/message-access/message-access.test.ts src/plugin-sdk/channel-ingress-runtime.test.ts
pnpm plugin-sdk:api:diff --base "$(git merge-base origin/main HEAD)" --head HEAD
```
