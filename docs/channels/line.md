---
summary: "LINE Messaging API plugin setup, config, and usage"
read_when:
  - You want to connect OpenClaw to LINE
  - You need LINE webhook + credential setup
  - You want LINE-specific message options
title: LINE
---

LINE connects to OpenClaw via the LINE Messaging API. The plugin runs as a webhook
receiver on the Gateway and uses your channel access token + channel secret for
authentication.

Status: official plugin, installed separately. Direct messages, group chats, media,
locations, Flex messages, template messages, and quick replies are supported.
Reactions and threads are not supported.

## Install

Install LINE before configuring the channel:

```bash
openclaw plugins install @openclaw/line
```

Local checkout (when running from a git repo):

```bash
openclaw plugins install ./path/to/local/line-plugin
```

## Setup

1. Create a LINE Developers account and open the Console:
   [https://developers.line.biz/console/](https://developers.line.biz/console/)
2. Create (or pick) a Provider and add a **Messaging API** channel.
3. Copy the **Channel access token** and **Channel secret** from the channel settings.
4. Enable **Use webhook** in the Messaging API settings.
5. Set the webhook URL to your gateway endpoint (HTTPS required):

```text
https://gateway-host/line/webhook
```

The Gateway answers LINE's signed webhook verification request: a `POST` with an
empty `events` list. For signed inbound events, it writes each event to the durable
ingress queue before returning `200`; agent processing continues asynchronously.
Failed delivery is retried from the queue, including after a Gateway restart, and
poison events become failed queue records after bounded retries. If durable
persistence fails, the request returns
`500` instead of acknowledging an event that could be lost.
Delivery is at least once across the queue-to-agent boundary: a Gateway shutdown or
crash during an active delivery can replay the turn. Message events deduplicate by
LINE message ID; other event types use `webhookEventId`. Retained completion records
suppress ordinary duplicate webhooks, but handlers that perform external side effects
should still be idempotent.
If you need a custom path, set `channels.line.webhookPath` or
`channels.line.accounts.<id>.webhookPath` and update the URL accordingly.

Security notes:

- LINE signature verification is body-dependent (HMAC over the raw body), so OpenClaw applies a strict pre-auth body limit (64 KB) and read timeout before verification.
- OpenClaw processes webhook events from the verified raw request bytes. Upstream middleware-transformed `req.body` values are ignored for signature-integrity safety.

## Inbound durability

The [Setup](#setup) webhook contract acknowledges an event only after it is durably
queued. The durable `200` carries `x-openclaw-delivery-accepted: durable`; signed
verification pings (empty event lists) and error responses omit the marker, so
reverse proxies can require it to distinguish durable acceptance from a generic
`200`. From there, delivery runs through the core channel-ingress drain with
LINE-specific settings:

- **Per-conversation ordering.** Events are serialized by source lane —
  `group:<groupId>`, `room:<roomId>`, or `user:<userId>`; events without a
  conversation source use their own event-scoped lane. Within a lane, events
  dispatch in received order, so a retrying event delays later events in the same
  chat. One chat's backlog never blocks another chat's lane, but all lanes share
  a cap of 8 concurrent deliveries: other chats progress independently while a
  slot is free, and a 9th lane waits for one to open.
- **Retries.** A failed delivery retries with exponential backoff starting at
  1 second and doubling per attempt, roughly two minutes of cumulative backoff
  across the window. After the 8th failed attempt the event dead-letters
  (`retry-limit-exceeded`) immediately: LINE opts out of the generic 24-hour
  dead-letter age floor so a poison event cannot block its conversation lane for
  a day.
- **Non-retryable failures.** These dead-letter immediately, with no further
  retries regardless of the attempt count: stored payloads that no longer parse
  (`invalid-event`), deliveries that already committed side effects
  (`delivery-side-effects-committed`), and LINE API authentication failures
  (`authentication-failed`, HTTP 401/403).
- **Stall watchdog.** A claimed delivery that neither reaches agent-turn adoption
  nor reports continued deferred progress for 5 minutes is aborted and released
  back to its lane through the same retry policy as any other failure: the event
  returns to pending with its attempt count incremented and `handler-timeout`
  recorded as its last error, and it keeps its place at the head of its lane. A
  stall is not itself a dead letter — only the retry limit above ends the event,
  as `retry-limit-exceeded`. The watchdog only covers the window between claim
  and adoption: deferred progress re-arms it and adoption clears it, so a long
  agent turn is never interrupted by it. Adoption that arrives after the
  watchdog fires is fenced off, so a late turn cannot claim an event that has
  already been handed back.
- **Crash recovery.** Every drain pass opens with a recovery sweep that reclaims
  any claim whose owning Gateway process is no longer running, so a delivery lost
  to a hard crash is retried on the next sweep rather than after a timeout. The
  30-minute claim lease is the fallback bound for the opposite case: without a
  successful lease refresh, it caps how long a claim stays protected solely
  because its owner PID still looks alive — including a reused PID whose process
  identity cannot be verified. Events accepted while the Gateway is stopping are
  still persisted and drain after the next start.
- **Duplicate suppression window.** On every admission, LINE removes completed
  and failed queue records older than 30 days, then keeps the most recently
  updated 4096 records of each kind per account. Because pruning runs before the
  new event is queued rather than on a timer, records can remain past 30 days on
  an idle account, and a newly completed record can put the count above 4096 until
  the next admission. While a record exists, a redelivered webhook for the same
  event is acknowledged without a second dispatch; once it is gone — by age or by
  cap — a redelivery is admitted and dispatched again, so handlers with external
  side effects should not treat this window as a substitute for their own
  idempotency.

The `500`-on-persistence-failure contract only helps if LINE re-sends the event.
LINE redelivers a webhook when **Webhook redelivery** is enabled for the channel in
the LINE Developers Console (Messaging API settings, alongside **Use webhook**) and
the bot server did not answer `2xx`. Without that setting, an event refused with
`500` is not re-sent. Even enabled, redelivery is best effort rather than a
guarantee: LINE documents that it is not reliable, that the retry count and
interval are undisclosed, and that redelivered events may arrive out of order or
more than once (the duplicate suppression window above absorbs the repeats). See
[Redeliver a webhook that failed to be received](https://developers.line.biz/en/docs/messaging-api/receiving-messages/#webhook-redelivery).

Dead-lettered events stay inspectable and, depending on the failure reason,
recoverable; see [Inbound dead letters](/cli/channels#inbound-dead-letters) and
[Troubleshooting](#troubleshooting) below.

## Configure

Minimal config:

```json5
{
  channels: {
    line: {
      enabled: true,
      channelAccessToken: "LINE_CHANNEL_ACCESS_TOKEN",
      channelSecret: "LINE_CHANNEL_SECRET",
      dmPolicy: "pairing",
    },
  },
}
```

Public DM config:

```json5
{
  channels: {
    line: {
      enabled: true,
      channelAccessToken: "LINE_CHANNEL_ACCESS_TOKEN",
      channelSecret: "LINE_CHANNEL_SECRET",
      dmPolicy: "open",
      allowFrom: ["*"],
    },
  },
}
```

Env vars (default account only):

- `LINE_CHANNEL_ACCESS_TOKEN`
- `LINE_CHANNEL_SECRET`

Token/secret files:

```json5
{
  channels: {
    line: {
      tokenFile: "/path/to/line-token.txt",
      secretFile: "/path/to/line-secret.txt",
    },
  },
}
```

`tokenFile` and `secretFile` must point to regular files. Symlinks are rejected.
Inline config values win over files; env vars are the last fallback for the default account.

Multiple accounts:

```json5
{
  channels: {
    line: {
      accounts: {
        marketing: {
          channelAccessToken: "...",
          channelSecret: "...",
          webhookPath: "/line/marketing",
        },
      },
    },
  },
}
```

## Access control

Direct messages default to pairing. Unknown senders get a pairing code and their
messages are ignored until approved:

```bash
openclaw pairing list line
openclaw pairing approve line <CODE>
```

Allowlists and policies:

- `channels.line.dmPolicy`: `pairing | allowlist | open | disabled` (default `pairing`)
- `channels.line.allowFrom`: allowlisted LINE user IDs for DMs; `dmPolicy: "open"` requires `["*"]`
- `channels.line.groupPolicy`: `allowlist | open | disabled` (default `allowlist`)
- `channels.line.groupAllowFrom`: allowlisted LINE user IDs for groups; DM `allowFrom` entries do not admit group senders
- Per-group overrides: `channels.line.groups.<groupId>.allowFrom` (plus `enabled`, `requireMention`, `systemPrompt`, `skills`). With
  `groupPolicy: "allowlist"`, set `groupAllowFrom` or the per-group `allowFrom`; an empty group allowlist blocks group messages even when DMs are open.
- Quoting one of the bot's own messages counts as addressing it, so a group reply made with LINE's quote gesture reaches the agent without an explicit mention. LINE does not read the `implicitMentions` flags, so this always counts; see [Groups](/channels/groups). The bot recognizes a quote of its own message from the most recent ones it remembers sending (a few hundred per account), so quoting an older message, or one sent before the last Gateway restart, still needs a mention.
- Static sender access groups can be referenced from `allowFrom`, `groupAllowFrom`, and per-group `allowFrom` with `accessGroup:<name>`; see [Access groups](/channels/access-groups).
- Runtime note: if `channels.line` is completely missing, runtime falls back to `groupPolicy="allowlist"` for group checks (even if `channels.defaults.groupPolicy` is set).

LINE IDs are case-sensitive. Valid IDs look like:

- User: `U` + 32 hex chars
- Group: `C` + 32 hex chars
- Room: `R` + 32 hex chars

## Group join introductions

When the bot joins an allowed group or multi-person room, it posts one
introduction there. LINE exposes a group name through its group summary API, but
no room name or topic for multi-person rooms. The Messaging API cannot read prior
messages, so introductions use only available metadata and ask what the room
wants the bot to take on rather than inventing activity.

Introductions are enabled by default. Set `channels.line.joinIntro: false` to
disable them, or use `channels.line.accounts.<accountId>.joinIntro` to override
one account. They never run in one-to-one user chats or when another member joins.
See [group join introductions](/channels#group-join-introductions) for room
admission, once-per-room behavior, and the no-tools turn that treats room content
as untrusted.

## Message behavior

- Text is chunked at 5000 characters, which is the longest text message LINE
  accepts. Set `channels.line.textChunkLimit` (or
  `channels.line.accounts.<id>.textChunkLimit`) for shorter bubbles; a larger
  value stays bounded by what LINE accepts.
- Markdown formatting is stripped; code blocks and tables are converted into Flex
  cards when possible.
- Streaming responses are buffered; LINE receives full chunks with a loading
  animation while the agent works.
- Media downloads are capped by `channels.line.mediaMaxMb` (default 10).
- Inbound media is saved under `~/.openclaw/media/inbound/` before it is passed
  to the agent, matching the shared media store used by other channel plugins.
- LINE webhooks carry ids but no names, so the sender's display name and the
  group's name are fetched once and cached for five minutes. Group and room
  members are read through their conversation, which is the only way to see a
  member who has not added the bot as a friend. If either lookup fails the raw
  id is used and the message is still delivered. Multi-person rooms have no name
  API, so they keep their room id.

## Structured rich messages

Use the shared message presentation fields for portable choices. LINE renders
`buttons` blocks as Flex controls and `select` blocks as quick replies. A two-button
block is the portable confirm-style form.

```json5
{
  action: "send",
  message: "Choose an action",
  presentation: {
    title: "Menu",
    blocks: [
      {
        type: "buttons",
        buttons: [
          { label: "Status", action: { type: "command", command: "/status" } },
          { label: "Website", action: { type: "url", url: "https://example.com" } },
        ],
      },
      {
        type: "select",
        placeholder: "Pick one",
        options: [
          { label: "Alpha", action: { type: "callback", value: "alpha" } },
          { label: "Help", action: { type: "command", command: "/help" } },
        ],
      },
    ],
  },
}
```

LINE-only output uses the schema-validated `channelData.line` fields on
`message(action="send")`. Send one location and/or one `card`. The supported card
types are `media_player`, `event`, `agenda`, `device`, and `appletv_remote`.

```json5
{
  action: "send",
  message: "Here you go",
  channelData: {
    line: {
      location: {
        title: "Office",
        address: "123 Main St",
        latitude: 35.681236,
        longitude: 139.767125,
      },
      card: {
        type: "event",
        title: "Team meeting",
        date: "2026-08-18",
        time: "10:00",
        location: "Conference room",
        description: "Weekly planning",
      },
    },
  },
}
```

Other card shapes:

```json5 validate=false
{ type: "media_player", title: "Song", artist: "Artist", source: "Living Room", status: "playing", imageUrl: "https://example.com/cover.jpg" }
{ type: "agenda", title: "Today", events: [{ title: "Standup", time: "09:00", location: "Online" }] }
{ type: "device", name: "TV", deviceType: "Streaming box", status: "Playing", controls: [{ label: "Pause", action: "pause" }] }
{ type: "appletv_remote", name: "Living Room", status: "Playing" }
```

Double-bracket strings such as `[[buttons: ...]]` are plain text and are not
interpreted as rich-message instructions.

The LINE plugin also ships a `/card` command for Flex message presets:

```text
/card info "Welcome" "Thanks for joining!"
```

## ACP support

LINE supports ACP (Agent Communication Protocol) conversation bindings:

- `/acp spawn <agent> --bind here` binds the current LINE chat to an ACP session without creating a child thread.
- Configured ACP bindings and active conversation-bound ACP sessions work on LINE like other conversation channels.

See [ACP agents](/tools/acp-agents) for details.

## Outbound media

The LINE plugin sends images, videos, and audio through the agent message tool:

- **Images**: sent as LINE image messages; the preview image defaults to the media URL.
- **Videos**: require a preview image; set `channelData.line.previewImageUrl` to an image URL.
- **Audio**: sent as LINE audio messages; duration defaults to 60 seconds unless `channelData.line.durationMs` is set.

When `mediaKind` is omitted, LINE infers it from LINE-specific options or the URL
suffix. Native suffix inference supports JPEG/PNG, MP4, and MP3/M4A; suffixless URLs
retain the image fallback. Other suffixed URLs and inferred MP4 without a preview
become text links. Explicit video still requires `previewImageUrl`.

Outbound media URLs must be public HTTPS URLs of at most 2000 characters. OpenClaw
validates the target hostname before handing the URL to LINE and rejects loopback,
link-local, and private-network targets.

## Troubleshooting

- **Webhook verification fails:** ensure the webhook URL is HTTPS and the
  `channelSecret` matches the LINE console.
- **No inbound events:** confirm the webhook path matches `channels.line.webhookPath`
  and that the gateway is reachable from LINE.
- **Media download errors:** raise `channels.line.mediaMaxMb` if media exceeds the
  default limit.
- **Bot silently skips messages (events dead-lettered):** `openclaw logs` shows
  `line: spooled update <id> ... dead-lettered` lines with the failure reason.
  Inspect with `openclaw channels dead-letters list --channel line --account default`
  and check the failure reason before recovering: `resubmit` re-enqueues by event
  id without checking why the event failed. After fixing the cause of a failure
  with no committed side effects (for example `retry-limit-exceeded` after a
  provider outage), re-enqueue one event with
  `openclaw channels dead-letters resubmit <event-id> --channel line --account default`.
  Never resubmit a `delivery-side-effects-committed` event: that reason means the
  delivery already adopted an agent turn or consumed its reply token, so
  re-enqueuing repeats the committed work — for example a second visible reply.
  `openclaw health` reports dead-letter counts and `openclaw doctor` names
  affected accounts.
- **`handler-timeout` retries:** the delivery was claimed but neither reached
  agent-turn adoption nor reported deferred progress for 5 minutes. This is a
  stall _before_ the turn starts —
  adoption clears the watchdog, so a turn that is already running is never the
  cause and is never cut off by it. Look at the dispatch path instead: the
  delivery preparation that runs between claim and adoption, such as inbound
  media download or a Gateway that is not accepting new work. This does not
  dead-letter the event; `openclaw logs` shows
  `applying retry policy (handler-timeout)` and the event waits out its backoff
  with `handler-timeout` as its last error. A stall that keeps repeating is what
  eventually exhausts the retry limit, so an event that stalls its way to a dead
  letter lands under `retry-limit-exceeded`, not under a timeout reason. Check
  `openclaw logs --follow` around the affected event id.

## Related

- [Channels Overview](/channels) — all supported channels
- [Pairing](/channels/pairing) — DM authentication and pairing flow
- [Groups](/channels/groups) — group chat behavior and mention gating
- [Channel Routing](/channels/channel-routing) — session routing for messages
- [Security](/gateway/security) — access model and hardening
