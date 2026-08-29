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
  contextBinding: {
    agentId: agentRoute.agentId,
    sessionKey: agentRoute.sessionKey,
    messageId,
    inboundEventKind: "user_request",
  },
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

const ctx = runtime.channel.inbound.buildContext({
  // Pass the exact host result; do not rebuild participant evidence from
  // SenderId, From, session keys, routes, rooms, or message metadata.
  channelIngress: result,
  // ...normalized channel facts
});
```

Do not precompute effective allowlists, command owners, or command groups.
The resolver derives them from raw allowlists, store callbacks, route
descriptors, access groups, policy, and conversation kind.

For a result that will enter a host context, resolve after the channel's route
owner has selected the final agent and session. `contextBinding` freezes those
facts with the stable transport message id (when present) and final inbound
event kind. Decision-only checks may omit it, but such a result is not valid
execution provenance and must not be passed as `channelIngress`. When a channel
batches several admitted messages, pass their exact results in source order;
the finalized context message id identifies the last source result.

### Product participant identity

An identity descriptor may provide `resolveParticipant(subject)`, returning
`{ domain, idKind, id }` only when the plugin can prove those remote facts.
The domain belongs to the remote service: for example, a Slack workspace or
an application-scoped identity issuer. It is not OpenClaw's local `accountId`.
Keep user IDs, bot IDs, and proxy identities distinct when the service gives
them different meanings. Names and successful Gateway profile lookups are
not identity evidence.

Pass the exact resolver result through the host-injected context builder.
The host carries product facts privately until accepted input is recorded in
the session participant aggregate. Raw product identity is not added to the
public diagnostic result. An unqualified producer retains an unresolved
observation instead of becoming a Gateway profile or an invented remote
subject. Product participation does not grant access.

This product path is independent of execution-identity audit collection:
it neither enables that collection nor reuses its HMAC references or opaque
diagnostic carriers. Audit's separate evidence contract is described below.

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

When execution-identity audit collection is enabled, a trusted active native
plugin is the authoritative in-process producer of its remote participant
fact. The host-injected registered runtime binds the resolver result to the
exact plugin record and registry lifecycle epoch, then validates its complete
available conversation, route, agent, session, message, event, and participant scope during a
one-shot context handoff. The public standalone builder remains
non-authoritative and cannot mint participant evidence.
Queue collection retains attribution only when every contribution has valid
evidence for the same participant; mixed, missing, stale, or unminted evidence
is `unknown`. The carrier is opaque, bounded, one-shot, and diagnostic only.
Plugins cannot mint participant evidence from caller-chosen sender, account,
room, route, session, message, or transport fields. The SDK intentionally
exposes no record, epoch, owner capability, participant-evidence constructor,
or evidence copier. A structurally similar result, stale record, reused result,
or scope-changed context does not gain host authority.

`boundary-verified` means core verified that the participant fact crossed this
trusted active registered native-plugin boundary with the exact record, epoch,
scope, and one-shot handoff. It does not mean core independently queried the
remote service; only the channel plugin can observe that transport fact.

The audit states are distinct:

- **supported**: the authoritative ingress resolver ran. Its exact result can
  yield a present invoker and enforced or attribution-only coverage.
- **unknown**: a supported handoff was missing, stale, fake, reused, mixed, or
  otherwise failed host validation. Unknown never means allowed.
- **unsupported**: a named path has no Phase 0 authoritative integration and
  explicitly passes `channelIngress: "unsupported"`. Unsupported never means
  allowed and is not a shortcut for incomplete wiring.

## Identifier authentication

`IdentifierAuthentication` grades an identifier claim as `verified`,
`asserted`, `unverified`, or `mutable`, strongest to weakest. It is an input to
channel authorization only. It is not a principal, grant, relationship, or
execution-identity assurance strength. In particular, an identifier claim of
`verified` never becomes execution assurance `boundary-verified` or
`cryptographic`.

Import the type and `meetsIdentifierAuthentication(actual, minimum)` from
`openclaw/plugin-sdk/channel-ingress-runtime`. Downstream authentication mappers
should use this boolean comparator instead of maintaining their own rank tables.

The meanings are normative:

- `verified`: the owning trusted transport or session boundary bound this exact
  identifier to this sender.
- `asserted`: a trusted boundary vouched for the sender without binding this
  exact identifier.
- `unverified`: the identifier is exact and stable, but claimed ownership was
  not proved.
- `mutable`: the identifier is a changeable or shared alias, such as a display
  name.

Declare `verified` only from transport or session metadata controlled by the
owning boundary. Sender-controlled content, model input, ordinary message
context, routing metadata, and the integrity of the host admission carrier do
not establish it.

The kernel preserves the exact redacted allowlist-entry to subject-identifier
pair that matched. It combines the entry and subject claims by taking the
weaker claim for that exact pair, then compares it with
`minIdentifierAuthentication`. Identifiers of the same kind remain distinct,
so a weak secondary email does not weaken a separately matched verified email.

A subject that supplies a per-message `authentication` map must claim every
field it wants counted. A field missing from a supplied map is treated as
`unverified`, even if its identity descriptor declares a stronger static claim.
Channels with static strength omit the map entirely.

Expose `classifyEntryAuthentication: identityEntryAuthenticationClassifier(identity)`
from the security adapter's `resolveDmPolicy` result, importing the helper from
`openclaw/plugin-sdk/channel-ingress-runtime`. It uses the identity descriptor's
entry normalizers and returns the strongest static claim among accepting fields,
or `undefined` when none accepts the entry; wildcard entries are excluded.
The [security audit](/gateway/security/audit-checks) counts configured `allowFrom`
entries that depend only on mutable identifiers: it warns when name matching is
disabled and, when enabled, previews how many entries would stop authorizing
after disabling it. Findings contain counts and config paths, not raw entries;
pairing-store approvals are outside this check.
Symbolic `accessGroup:` references resolve membership separately and are not
counted as mutable identifiers.

Existing plugins remain source-compatible during the deprecation window:

| Deprecated field                                   | Exact mapping                        |
| -------------------------------------------------- | ------------------------------------ |
| `dangerous: true`                                  | `authentication: "mutable"`          |
| `dangerous: false` or omitted                      | default `authentication: "asserted"` |
| `mutableIdentifierMatching: "enabled"`             | minimum `mutable`                    |
| `mutableIdentifierMatching: "disabled"` or omitted | default minimum `asserted`           |

An explicit `authentication` or `minIdentifierAuthentication` takes
precedence. The deprecated fields remain through the current Plugin SDK major
and are planned for removal in the next major after bundled and known external
plugins migrate.

### Bundled channel declarations

Bundled channels use the strongest claim supported by every receive path that
shares an identity declaration. These are channel-authorization claims, not
execution-identity assurance:

| Channel         | Identifier claim                                                                        | Authoritative transport or session fact                                                                                                                                                                 |
| --------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Discord         | Gateway user ID: `verified`; PluralKit member ID: `asserted`; names and tags: `mutable` | Discord supplies `author.id` or `user.id` on events delivered over the authenticated bot-token Gateway session. PluralKit member IDs come from its authenticated API response, not the Discord Gateway. |
| Google Chat     | `sender.name`: `verified`; email: `mutable`                                             | The webhook validates Google's signed token, issuer, and configured audience before consuming the Google-owned event body.                                                                              |
| IRC             | server connection prefix and `user@host`: `asserted`; nick-based aliases: `mutable`     | The selected IRC server vouches for the connection prefix, but the generic transport does not prove account ownership.                                                                                  |
| Mattermost      | post user ID: `verified`; username: `mutable`                                           | The authenticated Mattermost WebSocket emits server-owned post events whose `post.user_id` identifies the author.                                                                                       |
| Microsoft Teams | sender and conversation IDs: `asserted`; sender name: `mutable`                         | Bot Framework authenticates the connector activity, but the plugin does not independently prove exact ownership of every ID representation.                                                             |
| Slack           | user and workspace-user IDs: `asserted`; names and slugs: `mutable`                     | Direct Slack delivery binds user IDs, while relay mode authenticates the relay peer without an end-to-end exact-sender attestation. The shared declaration uses the defensible common claim.            |

If a receive path cannot support the declaration shared by its channel, split
the declaration or supply a weaker per-message claim. Never infer a stronger
claim from message text, routing, or host evidence-carrier integrity.

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
