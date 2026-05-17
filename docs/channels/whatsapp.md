---
summary: "WhatsApp channel support, access controls, delivery behavior, and operations"
read_when:
  - Working on WhatsApp/web channel behavior or inbox routing
title: "WhatsApp"
---

Status: production-ready via WhatsApp Web (Baileys). Gateway owns linked session(s).

## Install (on demand)

- Onboarding (`openclaw onboard`) and `openclaw channels add --channel whatsapp`
  prompt to install the WhatsApp plugin the first time you select it.
- `openclaw channels login --channel whatsapp` also offers the install flow when
  the plugin is not present yet.
- Dev channel + git checkout: defaults to the local plugin path.
- Stable/Beta: installs the official `@openclaw/whatsapp` plugin from ClawHub
  first, with npm as the fallback.
- The WhatsApp runtime is distributed outside the core OpenClaw npm package so
  WhatsApp-specific runtime dependencies stay with the external plugin.

Manual install stays available:

```bash
openclaw plugins install clawhub:@openclaw/whatsapp
```

Use the bare npm package (`@openclaw/whatsapp`) only when you need the registry
fallback. Pin an exact version only when you need a reproducible install.

<CardGroup cols={3}>
  <Card title="Pairing" icon="link" href="/channels/pairing">
    Default DM policy is pairing for unknown senders.
  </Card>
  <Card title="Channel troubleshooting" icon="wrench" href="/channels/troubleshooting">
    Cross-channel diagnostics and repair playbooks.
  </Card>
  <Card title="Gateway configuration" icon="settings" href="/gateway/configuration">
    Full channel config patterns and examples.
  </Card>
</CardGroup>

## Quick setup

<Steps>
  <Step title="Configure WhatsApp access policy">

```json5
{
  channels: {
    whatsapp: {
      dmPolicy: "pairing",
      allowFrom: ["+15551234567"],
      groupPolicy: "allowlist",
      groupAllowFrom: ["+15551234567"],
    },
  },
}
```

  </Step>

  <Step title="Link WhatsApp (QR)">

```bash
openclaw channels login --channel whatsapp
```

    For a specific account:

```bash
openclaw channels login --channel whatsapp --account work
```

    To attach an existing/custom WhatsApp Web auth directory before login:

```bash
openclaw channels add --channel whatsapp --account work --auth-dir /path/to/wa-auth
openclaw channels login --channel whatsapp --account work
```

  </Step>

  <Step title="Start the gateway">

```bash
openclaw gateway
```

  </Step>

  <Step title="Approve first pairing request (if using pairing mode)">

```bash
openclaw pairing list whatsapp
openclaw pairing approve whatsapp <CODE>
```

    Pairing requests expire after 1 hour. Pending requests are capped at 3 per channel.

  </Step>
</Steps>

<Note>
OpenClaw recommends running WhatsApp on a separate number when possible. (The channel metadata and setup flow are optimized for that setup, but personal-number setups are also supported.)
</Note>

## Deployment patterns

<AccordionGroup>
  <Accordion title="Dedicated number (recommended)">
    This is the cleanest operational mode:

    - separate WhatsApp identity for OpenClaw
    - clearer DM allowlists and routing boundaries
    - lower chance of self-chat confusion

    Minimal policy pattern:

    ```json5
    {
      channels: {
        whatsapp: {
          dmPolicy: "allowlist",
          allowFrom: ["+15551234567"],
        },
      },
    }
    ```

  </Accordion>

  <Accordion title="Personal-number fallback">
    Onboarding supports personal-number mode and writes a self-chat-friendly baseline:

    - `dmPolicy: "allowlist"`
    - `allowFrom` includes your personal number
    - `selfChatMode: true`

    In runtime, self-chat protections key off the linked self number and `allowFrom`.

  </Accordion>

  <Accordion title="WhatsApp Web-only channel scope">
    The messaging platform channel is WhatsApp Web-based (`Baileys`) in current OpenClaw channel architecture.

    There is no separate Twilio WhatsApp messaging channel in the built-in chat-channel registry.

  </Accordion>
</AccordionGroup>

## Runtime model

- Gateway owns the WhatsApp socket and reconnect loop.
- The reconnect watchdog uses WhatsApp Web transport activity, not only inbound app-message volume, so a quiet linked-device session is not restarted solely because nobody has sent a message recently. A longer application-silence cap still forces a reconnect if transport frames keep arriving but no application messages are handled for the watchdog window; after a transient reconnect for a recently active session, that application-silence check uses the normal message timeout for the first recovery window.
- Baileys socket timings are explicit under `web.whatsapp.*`: `keepAliveIntervalMs` controls WhatsApp Web application pings, `connectTimeoutMs` controls the opening handshake timeout, and `defaultQueryTimeoutMs` controls Baileys query timeouts.
- Outbound sends require an active WhatsApp listener for the target account.
- Group sends attach native mention metadata for `@+<digits>` and `@<digits>` tokens in text and media captions when the token matches current WhatsApp participant metadata, including LID-backed groups.
- Status and broadcast chats are ignored (`@status`, `@broadcast`).
- The reconnect watchdog follows WhatsApp Web transport activity, not only inbound app-message volume: quiet linked-device sessions stay up while transport frames continue, but a transport stall forces reconnect well before the later remote disconnect path.
- Direct chats use DM session rules (`session.dmScope`; default `main` collapses DMs to the agent main session).
- Group sessions are isolated (`agent:<agentId>:whatsapp:group:<jid>`).
- WhatsApp Channels/Newsletters can be explicit outbound targets with their native `@newsletter` JID. Outbound newsletter sends use channel session metadata (`agent:<agentId>:whatsapp:channel:<jid>`) rather than DM session semantics.
- WhatsApp Web transport honors standard proxy environment variables on the gateway host (`HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY` / lowercase variants). Prefer host-level proxy config over channel-specific WhatsApp proxy settings.
- When `messages.removeAckAfterReply` is enabled, OpenClaw clears the WhatsApp ack reaction after a visible reply is delivered.

## Plugin hooks and privacy

WhatsApp inbound messages can contain personal message content, phone numbers,
group identifiers, sender names, and session correlation fields. For that reason,
WhatsApp does not broadcast inbound `message_received` hook payloads to plugins
unless you explicitly opt in:

```json5
{
  channels: {
    whatsapp: {
      pluginHooks: {
        messageReceived: true,
      },
    },
  },
}
```

You can scope the opt-in to one account:

```json5
{
  channels: {
    whatsapp: {
      accounts: {
        work: {
          pluginHooks: {
            messageReceived: true,
          },
        },
      },
    },
  },
}
```

Only enable this for plugins you trust to receive inbound WhatsApp message
content and identifiers.

## Access control and activation

<Tabs>
  <Tab title="DM policy">
    `channels.whatsapp.dmPolicy` controls direct chat access:

    - `pairing` (default)
    - `allowlist`
    - `open` (requires `allowFrom` to include `"*"`)
    - `disabled`

    `allowFrom` accepts E.164-style numbers (normalized internally).

    `allowFrom` is a DM sender access-control list. It does not gate explicit outbound sends to WhatsApp group JIDs or `@newsletter` channel JIDs.

    Multi-account override: `channels.whatsapp.accounts.<id>.dmPolicy` (and `allowFrom`) take precedence over channel-level defaults for that account.

    Runtime behavior details:

    - pairings are persisted in channel allow-store and merged with configured `allowFrom`
    - scheduled automation and heartbeat recipient fallback use explicit delivery targets or configured `allowFrom`; DM pairing approvals are not implicit cron or heartbeat recipients
    - if no allowlist is configured, the linked self number is allowed by default
    - OpenClaw never auto-pairs outbound `fromMe` DMs (messages you send to yourself from the linked device)

  </Tab>

  <Tab title="Group policy + allowlists">
    Group access has two layers:

    1. **Group membership allowlist** (`channels.whatsapp.groups`)
       - if `groups` is omitted, all groups are eligible
       - if `groups` is present, it acts as a group allowlist (`"*"` allowed)

    2. **Group sender policy** (`channels.whatsapp.groupPolicy` + `groupAllowFrom`)
       - `open`: sender allowlist bypassed
       - `allowlist`: sender must match `groupAllowFrom` (or `*`)
       - `disabled`: block all group inbound

    Sender allowlist fallback:

    - if `groupAllowFrom` is unset, runtime falls back to `allowFrom` when available
    - sender allowlists are evaluated before mention/reply activation

    Note: if no `channels.whatsapp` block exists at all, runtime group-policy fallback is `allowlist` (with a warning log), even if `channels.defaults.groupPolicy` is set.

  </Tab>

  <Tab title="Mentions + /activation">
    Group replies require mention by default.

    Mention detection includes:

    - explicit WhatsApp mentions of the bot identity
    - configured mention regex patterns (`agents.list[].groupChat.mentionPatterns`, fallback `messages.groupChat.mentionPatterns`)
    - inbound voice-note transcripts for authorized group messages
    - implicit reply-to-bot detection (reply sender matches bot identity)

    Security note:

    - quote/reply only satisfies mention gating; it does **not** grant sender authorization
    - with `groupPolicy: "allowlist"`, non-allowlisted senders are still blocked even if they reply to an allowlisted user's message

    Session-level activation command:

    - `/activation mention`
    - `/activation always`

    `activation` updates session state (not global config). It is owner-gated.

  </Tab>
</Tabs>

## Personal-number and self-chat behavior

When the linked self number is also present in `allowFrom`, WhatsApp self-chat safeguards activate:

- skip read receipts for self-chat turns
- ignore mention-JID auto-trigger behavior that would otherwise ping yourself
- if `messages.responsePrefix` is unset, self-chat replies default to `[{identity.name}]` or `[openclaw]`

## Message normalization and context

<AccordionGroup>
  <Accordion title="Inbound envelope + reply context">
    Incoming WhatsApp messages are wrapped in the shared inbound envelope.

    If a quoted reply exists, context is appended in this form:

    ```text
    [Replying to <sender> id:<stanzaId>]
    <quoted body or media placeholder>
    [/Replying]
    ```

    Reply metadata fields are also populated when available (`ReplyToId`, `ReplyToBody`, `ReplyToSender`, sender JID/E.164).
    When the quoted reply target is downloadable media, OpenClaw saves it through
    the normal inbound media store and exposes it as `MediaPath`/`MediaType` so
    the agent can inspect the referenced image instead of only seeing
    `<media:image>`.

  </Accordion>

  <Accordion title="Media placeholders and location/contact extraction">
    Media-only inbound messages are normalized with placeholders such as:

    - `<media:image>`
    - `<media:video>`
    - `<media:audio>`
    - `<media:document>`
    - `<media:sticker>`

    Authorized group voice notes are transcribed before mention gating when the
    body is only `<media:audio>`, so saying the bot mention in the voice note can
    trigger the reply. If the transcript still does not mention the bot, the
    transcript is kept in pending group history instead of the raw placeholder.

    Location bodies use terse coordinate text. Location labels/comments and contact/vCard details are rendered as fenced untrusted metadata, not inline prompt text.

  </Accordion>

  <Accordion title="Pending group history injection">
    For groups, unprocessed messages can be buffered and injected as context when the bot is finally triggered.

    - default limit: `50`
    - config: `channels.whatsapp.historyLimit`
    - fallback: `messages.groupChat.historyLimit`
    - `0` disables

    Injection markers:

    - `[Chat messages since your last reply - for context]`
    - `[Current message - respond to this]`

  </Accordion>

  <Accordion title="Read receipts">
    Read receipts are enabled by default for accepted inbound WhatsApp messages.

    Disable globally:

    ```json5
    {
      channels: {
        whatsapp: {
          sendReadReceipts: false,
        },
      },
    }
    ```

    Per-account override:

    ```json5
    {
      channels: {
        whatsapp: {
          accounts: {
            work: {
              sendReadReceipts: false,
            },
          },
        },
      },
    }
    ```

    Self-chat turns skip read receipts even when globally enabled.

  </Accordion>
</AccordionGroup>

## Delivery, chunking, and media

<AccordionGroup>
  <Accordion title="Text chunking">
    - default chunk limit: `channels.whatsapp.textChunkLimit = 4000`
    - `channels.whatsapp.chunkMode = "length" | "newline"`
    - `newline` mode prefers paragraph boundaries (blank lines), then falls back to length-safe chunking

  </Accordion>

  <Accordion title="Outbound media behavior">
    - supports image, video, audio (PTT voice-note), and document payloads
    - audio media is sent through the Baileys `audio` payload with `ptt: true`, so WhatsApp clients render it as a push-to-talk voice note
    - reply payloads preserve `audioAsVoice`; TTS voice-note output for WhatsApp stays on this PTT path even when the provider returns MP3 or WebM
    - native Ogg/Opus audio is sent as `audio/ogg; codecs=opus` for voice-note compatibility
    - non-Ogg audio, including Microsoft Edge TTS MP3/WebM output, is transcoded with `ffmpeg` to 48 kHz mono Ogg/Opus before PTT delivery
    - `/tts latest` sends the latest assistant reply as one voice note and suppresses repeat sends for the same reply; `/tts chat on|off|default` controls auto-TTS for the current WhatsApp chat
    - animated GIF playback is supported via `gifPlayback: true` on video sends
    - `forceDocument` / `asDocument` sends outbound images, GIFs, and videos through the Baileys document payload to avoid WhatsApp media compression while preserving the resolved filename and MIME type
    - captions are applied to the first media item when sending multi-media reply payloads, except PTT voice notes send the audio first and visible text separately because WhatsApp clients do not render voice-note captions consistently
    - media source can be HTTP(S), `file://`, or local paths

  </Accordion>

  <Accordion title="Media size limits and fallback behavior">
    - inbound media save cap: `channels.whatsapp.mediaMaxMb` (default `50`)
    - outbound media send cap: `channels.whatsapp.mediaMaxMb` (default `50`)
    - per-account overrides use `channels.whatsapp.accounts.<accountId>.mediaMaxMb`
    - images are auto-optimized (resize/quality sweep) to fit limits unless `forceDocument` / `asDocument` requests document delivery
    - on media send failure, first-item fallback sends text warning instead of dropping the response silently

  </Accordion>
</AccordionGroup>

## Reply quoting

WhatsApp supports native reply quoting, where outbound replies visibly quote the inbound message. Control it with `channels.whatsapp.replyToMode`.

| Value       | Behavior                                                              |
| ----------- | --------------------------------------------------------------------- |
| `"off"`     | Never quote; send as a plain message                                  |
| `"first"`   | Quote only the first outbound reply chunk                             |
| `"all"`     | Quote every outbound reply chunk                                      |
| `"batched"` | Quote queued batched replies while leaving immediate replies unquoted |

Default is `"off"`. Per-account overrides use `channels.whatsapp.accounts.<id>.replyToMode`.

```json5
{
  channels: {
    whatsapp: {
      replyToMode: "first",
    },
  },
}
```

## Reaction level

`channels.whatsapp.reactionLevel` controls how broadly the agent uses emoji reactions on WhatsApp:

| Level         | Ack reactions | Agent-initiated reactions | Description                                      |
| ------------- | ------------- | ------------------------- | ------------------------------------------------ |
| `"off"`       | No            | No                        | No reactions at all                              |
| `"ack"`       | Yes           | No                        | Ack reactions only (pre-reply receipt)           |
| `"minimal"`   | Yes           | Yes (conservative)        | Ack + agent reactions with conservative guidance |
| `"extensive"` | Yes           | Yes (encouraged)          | Ack + agent reactions with encouraged guidance   |

Default: `"minimal"`.

Per-account overrides use `channels.whatsapp.accounts.<id>.reactionLevel`.

```json5
{
  channels: {
    whatsapp: {
      reactionLevel: "ack",
    },
  },
}
```

## Acknowledgment reactions

WhatsApp supports immediate ack reactions on inbound receipt via `channels.whatsapp.ackReaction`.
Ack reactions are gated by `reactionLevel` — they are suppressed when `reactionLevel` is `"off"`.

```json5
{
  channels: {
    whatsapp: {
      ackReaction: {
        emoji: "👀",
        direct: true,
        group: "mentions", // always | mentions | never
      },
    },
  },
}
```

Behavior notes:

- sent immediately after inbound is accepted (pre-reply)
- failures are logged but do not block normal reply delivery
- group mode `mentions` reacts on mention-triggered turns; group activation `always` acts as bypass for this check
- WhatsApp uses `channels.whatsapp.ackReaction` (legacy `messages.ackReaction` is not used here)

## Lifecycle status reactions

Set `messages.statusReactions.enabled: true` to let WhatsApp replace the ack reaction during a turn instead of leaving a static receipt emoji. When enabled, OpenClaw uses the same inbound message reaction slot for lifecycle states such as queued, thinking, tool activity, compaction, done, and error.

```json5
{
  messages: {
    statusReactions: {
      enabled: true,
      emojis: {
        deploy: "🛫",
        build: "🏗️",
        concierge: "💁",
      },
    },
  },
}
```

Behavior notes:

- `channels.whatsapp.ackReaction` still controls whether status reactions are eligible for direct messages and groups.
- WhatsApp has one bot reaction slot per message, so lifecycle updates replace the current reaction in place.
- `messages.removeAckAfterReply: true` clears the final status reaction after the configured done/error hold.
- Tool emoji categories include `tool`, `coding`, `web`, `deploy`, `build`, and `concierge`.

## Multi-account and credentials

<AccordionGroup>
  <Accordion title="Account selection and defaults">
    - account ids come from `channels.whatsapp.accounts`
    - default account selection: `default` if present, otherwise first configured account id (sorted)
    - account ids are normalized internally for lookup

  </Accordion>

  <Accordion title="Credential paths and legacy compatibility">
    - current auth path: `~/.openclaw/credentials/whatsapp/<accountId>/creds.json`
    - backup file: `creds.json.bak`
    - legacy default auth in `~/.openclaw/credentials/` is still recognized/migrated for default-account flows

  </Accordion>

  <Accordion title="Logout behavior">
    `openclaw channels logout --channel whatsapp [--account <id>]` clears WhatsApp auth state for that account.

    When a Gateway is reachable, logout first stops the live WhatsApp listener for the selected account so the linked session does not keep receiving messages until the next restart. `openclaw channels remove --channel whatsapp` also stops the live listener before disabling or deleting account config.

    In legacy auth directories, `oauth.json` is preserved while Baileys auth files are removed.

  </Accordion>
</AccordionGroup>

## Tools, actions, and config writes

- Agent tool support includes WhatsApp reaction action (`react`).
- Action gates:
  - `channels.whatsapp.actions.reactions`
  - `channels.whatsapp.actions.polls`
- Channel-initiated config writes are enabled by default (disable via `channels.whatsapp.configWrites=false`).

## Troubleshooting

<AccordionGroup>
  <Accordion title="Not linked (QR required)">
    Symptom: channel status reports not linked.

    Fix:

    ```bash
    openclaw channels login --channel whatsapp
    openclaw channels status
    ```

  </Accordion>

  <Accordion title="Linked but disconnected / reconnect loop">
    Symptom: linked account with repeated disconnects or reconnect attempts.

    Quiet accounts can stay connected past the normal message timeout; the watchdog
    restarts when WhatsApp Web transport activity stops, the socket closes, or
    application-level activity stays silent beyond the longer safety window.

    If logs show repeated `status=408 Request Time-out Connection was lost`, tune
    Baileys socket timings under `web.whatsapp`. Start by shortening
    `keepAliveIntervalMs` below your network's idle timeout and increasing
    `connectTimeoutMs` on slow or lossy links:

    ```json5
    {
      web: {
        whatsapp: {
          keepAliveIntervalMs: 15000,
          connectTimeoutMs: 60000,
          defaultQueryTimeoutMs: 60000,
        },
      },
    }
    ```

    Fix:

    ```bash
    openclaw doctor
    openclaw logs --follow
    ```

    If `~/.openclaw/logs/whatsapp-health.log` says `Gateway inactive` but
    `openclaw gateway status` and `openclaw channels status --probe` show the
    gateway and WhatsApp are healthy, run `openclaw doctor`. On Linux, doctor
    warns about legacy crontab entries that still invoke
    `~/.openclaw/bin/ensure-whatsapp.sh`; remove those stale entries with
    `crontab -e` because cron can lack the systemd user-bus environment and
    make that old script misreport gateway health.

    If needed, re-link with `channels login`.

  </Accordion>

  <Accordion title="QR login times out behind a proxy">
    Symptom: `openclaw channels login --channel whatsapp` fails before showing a usable QR code with `status=408 Request Time-out` or a TLS socket disconnect.

    WhatsApp Web login uses the gateway host's standard proxy environment (`HTTPS_PROXY`, `HTTP_PROXY`, lowercase variants, and `NO_PROXY`). Verify the gateway process inherits the proxy env and that `NO_PROXY` does not match `mmg.whatsapp.net`.

  </Accordion>

  <Accordion title="No active listener when sending">
    Outbound sends fail fast when no active gateway listener exists for the target account.

    Make sure gateway is running and the account is linked.

  </Accordion>

  <Accordion title="Reply appears in transcript but not in WhatsApp">
    Transcript rows record what the agent generated. WhatsApp delivery is checked separately: OpenClaw only treats an auto-reply as sent after Baileys returns an outbound message id for at least one visible text or media send.

    Ack reactions are independent pre-reply receipts. A successful reaction does not prove that the later text or media reply was accepted by WhatsApp.

    Check gateway logs for `auto-reply delivery failed` or `auto-reply was not accepted by WhatsApp provider`.

  </Accordion>

  <Accordion title="Group messages unexpectedly ignored">
    Check in this order:

    - `groupPolicy`
    - `groupAllowFrom` / `allowFrom`
    - `groups` allowlist entries
    - mention gating (`requireMention` + mention patterns)
    - duplicate keys in `openclaw.json` (JSON5): later entries override earlier ones, so keep a single `groupPolicy` per scope

  </Accordion>

  <Accordion title="Bun runtime warning">
    WhatsApp gateway runtime should use Node. Bun is flagged as incompatible for stable WhatsApp/Telegram gateway operation.
  </Accordion>
</AccordionGroup>

## System prompts

WhatsApp supports Telegram-style system prompts for groups and direct chats via the `groups` and `direct` maps.

Resolution hierarchy for group messages:

The effective `groups` map is determined first: if the account defines its own `groups`, it fully replaces the root `groups` map (no deep merge). Prompt lookup then runs on the resulting single map:

1. **Group-specific system prompt** (`groups["<groupId>"].systemPrompt`): used when the specific group entry exists in the map **and** its `systemPrompt` key is defined. If `systemPrompt` is an empty string (`""`), the wildcard is suppressed and no system prompt is applied.
2. **Group wildcard system prompt** (`groups["*"].systemPrompt`): used when the specific group entry is absent from the map entirely, or when it exists but defines no `systemPrompt` key.

Resolution hierarchy for direct messages:

The effective `direct` map is determined first: if the account defines its own `direct`, it fully replaces the root `direct` map (no deep merge). Prompt lookup then runs on the resulting single map:

1. **Direct-specific system prompt** (`direct["<peerId>"].systemPrompt`): used when the specific peer entry exists in the map **and** its `systemPrompt` key is defined. If `systemPrompt` is an empty string (`""`), the wildcard is suppressed and no system prompt is applied.
2. **Direct wildcard system prompt** (`direct["*"].systemPrompt`): used when the specific peer entry is absent from the map entirely, or when it exists but defines no `systemPrompt` key.

<Note>
`dms` remains the lightweight per-DM history override bucket (`dms.<id>.historyLimit`). Prompt overrides live under `direct`.
</Note>

**Difference from Telegram multi-account behavior:** In Telegram, root `groups` is intentionally suppressed for all accounts in a multi-account setup — even accounts that define no `groups` of their own — to prevent a bot from receiving group messages for groups it does not belong to. WhatsApp does not apply this guard: root `groups` and root `direct` are always inherited by accounts that define no account-level override, regardless of how many accounts are configured. In a multi-account WhatsApp setup, if you want per-account group or direct prompts, define the full map under each account explicitly rather than relying on root-level defaults.

Important behavior:

- `channels.whatsapp.groups` is both a per-group config map and the chat-level group allowlist. At either the root or account scope, `groups["*"]` means "all groups are admitted" for that scope.
- Only add a wildcard group `systemPrompt` when you already want that scope to admit all groups. If you still want only a fixed set of group IDs to be eligible, do not use `groups["*"]` for the prompt default. Instead, repeat the prompt on each explicitly allowlisted group entry.
- Group admission and sender authorization are separate checks. `groups["*"]` widens the set of groups that can reach group handling, but it does not by itself authorize every sender in those groups. Sender access is still controlled separately by `channels.whatsapp.groupPolicy` and `channels.whatsapp.groupAllowFrom`.
- `channels.whatsapp.direct` does not have the same side effect for DMs. `direct["*"]` only provides a default direct-chat config after a DM is already admitted by `dmPolicy` plus `allowFrom` or pairing-store rules.

Example:

```json5
{
  channels: {
    whatsapp: {
      groups: {
        // Use only if all groups should be admitted at the root scope.
        // Applies to all accounts that do not define their own groups map.
        "*": { systemPrompt: "Default prompt for all groups." },
      },
      direct: {
        // Applies to all accounts that do not define their own direct map.
        "*": { systemPrompt: "Default prompt for all direct chats." },
      },
      accounts: {
        work: {
          groups: {
            // This account defines its own groups, so root groups are fully
            // replaced. To keep a wildcard, define "*" explicitly here too.
            "120363406415684625@g.us": {
              requireMention: false,
              systemPrompt: "Focus on project management.",
            },
            // Use only if all groups should be admitted in this account.
            "*": { systemPrompt: "Default prompt for work groups." },
          },
          direct: {
            // This account defines its own direct map, so root direct entries are
            // fully replaced. To keep a wildcard, define "*" explicitly here too.
            "+15551234567": { systemPrompt: "Prompt for a specific work direct chat." },
            "*": { systemPrompt: "Default prompt for work direct chats." },
          },
        },
      },
    },
  },
}
```

## Configuration reference pointers

Primary reference:

- [Configuration reference - WhatsApp](/gateway/config-channels#whatsapp)

High-signal WhatsApp fields:

- access: `dmPolicy`, `allowFrom`, `groupPolicy`, `groupAllowFrom`, `groups`
- delivery: `textChunkLimit`, `chunkMode`, `mediaMaxMb`, `sendReadReceipts`, `ackReaction`, `reactionLevel`
- multi-account: `accounts.<id>.enabled`, `accounts.<id>.authDir`, account-level overrides
- operations: `configWrites`, `debounceMs`, `web.enabled`, `web.heartbeatSeconds`, `web.reconnect.*`, `web.whatsapp.*`
- session behavior: `session.dmScope`, `historyLimit`, `dmHistoryLimit`, `dms.<id>.historyLimit`
- prompts: `groups.<id>.systemPrompt`, `groups["*"].systemPrompt`, `direct.<id>.systemPrompt`, `direct["*"].systemPrompt`

## Related

- [Pairing](/channels/pairing)
- [Groups](/channels/groups)
- [Security](/gateway/security)
- [Channel routing](/channels/channel-routing)
- [Multi-agent routing](/concepts/multi-agent)
- [Troubleshooting](/channels/troubleshooting)
