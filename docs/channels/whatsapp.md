---
summary: "WhatsApp channel support, access controls, delivery behavior, and operations"
read_when:
  - Working on WhatsApp/web channel behavior or inbox routing
title: "WhatsApp"
---

# WhatsApp (Web channel)

Status: production-ready via WhatsApp Web (Baileys). Gateway owns linked session(s).

## Install (on demand)

- Onboarding (`openclaw onboard`) and `openclaw channels add --channel whatsapp`
  prompt to install the WhatsApp plugin the first time you select it.
- `openclaw channels login --channel whatsapp` also offers the install flow when
  the plugin is not present yet.
- Dev channel + git checkout: defaults to the local plugin path.
- Stable/Beta: defaults to the npm package `@openclaw/whatsapp`.

Manual install stays available:

```bash
openclaw plugins install @openclaw/whatsapp
```

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
- Outbound sends require an active WhatsApp listener for the target account.
- Status and broadcast chats are ignored (`@status`, `@broadcast`).
- Direct chats use DM session rules (`session.dmScope`; default `main` collapses DMs to the agent main session).
- Group sessions are isolated (`agent:<agentId>:whatsapp:group:<jid>`).
- WhatsApp Web transport honors standard proxy environment variables on the gateway host (`HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY` / lowercase variants). Prefer host-level proxy config over channel-specific WhatsApp proxy settings.

## Access control and activation

<Tabs>
  <Tab title="DM policy">
    `channels.whatsapp.dmPolicy` controls direct chat access:

    - `pairing` (default)
    - `allowlist`
    - `open` (requires `allowFrom` to include `"*"`)
    - `disabled`

    `allowFrom` accepts E.164-style numbers (normalized internally).

    Multi-account override: `channels.whatsapp.accounts.<id>.dmPolicy` (and `allowFrom`) take precedence over channel-level defaults for that account.

    Runtime behavior details:

    - pairings are persisted in channel allow-store and merged with configured `allowFrom`
    - if no allowlist is configured, the linked self number is allowed by default
    - outbound `fromMe` DMs are never auto-paired

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

  </Accordion>

  <Accordion title="Media placeholders and location/contact extraction">
    Media-only inbound messages are normalized with placeholders such as:

    - `<media:image>`
    - `<media:video>`
    - `<media:audio>`
    - `<media:document>`
    - `<media:sticker>`

    Location and contact payloads are normalized into textual context before routing.

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
    - `audio/ogg` is rewritten to `audio/ogg; codecs=opus` for voice-note compatibility
    - animated GIF playback is supported via `gifPlayback: true` on video sends
    - captions are applied to the first media item when sending multi-media reply payloads
    - media source can be HTTP(S), `file://`, or local paths
  </Accordion>

  <Accordion title="Media size limits and fallback behavior">
    - inbound media save cap: `channels.whatsapp.mediaMaxMb` (default `50`)
    - outbound media send cap: `channels.whatsapp.mediaMaxMb` (default `50`)
    - per-account overrides use `channels.whatsapp.accounts.<accountId>.mediaMaxMb`
    - images are auto-optimized (resize/quality sweep) to fit limits
    - on media send failure, first-item fallback sends text warning instead of dropping the response silently
  </Accordion>
</AccordionGroup>

## Reply quoting

WhatsApp supports native reply quoting, where outbound replies visibly quote the inbound message. Control it with `channels.whatsapp.replyToMode`.

| Value    | Behavior                                                                           |
| -------- | ---------------------------------------------------------------------------------- |
| `"auto"` | Quote the inbound message when the provider supports it; skip quoting otherwise    |
| `"on"`   | Always quote the inbound message; fall back to a plain send if quoting is rejected |
| `"off"`  | Never quote; send as a plain message                                               |

Default is `"auto"`. Per-account overrides use `channels.whatsapp.accounts.<id>.replyToMode`.

```json5
{
  channels: {
    whatsapp: {
      replyToMode: "on",
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

    Fix:

    ```bash
    openclaw doctor
    openclaw logs --follow
    ```

    If needed, re-link with `channels login`.

  </Accordion>

  <Accordion title="No active listener when sending">
    Outbound sends fail fast when no active gateway listener exists for the target account.

    Make sure gateway is running and the account is linked.

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

1. **Group-specific system prompt** (`groups["<groupId>"].systemPrompt`): used if the specific group entry defines a `systemPrompt`.
2. **Group wildcard system prompt** (`groups["*"].systemPrompt`): used when the specific group entry is absent or defines no `systemPrompt`.

Resolution hierarchy for direct messages:

The effective `direct` map is determined first: if the account defines its own `direct`, it fully replaces the root `direct` map (no deep merge). Prompt lookup then runs on the resulting single map:

1. **Direct-specific system prompt** (`direct["<peerId>"].systemPrompt`): used if the specific peer entry defines a `systemPrompt`.
2. **Direct wildcard system prompt** (`direct["*"].systemPrompt`): used when the specific peer entry is absent or defines no `systemPrompt`.

Note: `dms` remains the lightweight per-DM history override bucket (`dms.<id>.historyLimit`); prompt overrides live under `direct`.

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

- [Configuration reference - WhatsApp](/gateway/configuration-reference#whatsapp)

High-signal WhatsApp fields:

- access: `dmPolicy`, `allowFrom`, `groupPolicy`, `groupAllowFrom`, `groups`
- delivery: `textChunkLimit`, `chunkMode`, `mediaMaxMb`, `sendReadReceipts`, `ackReaction`, `reactionLevel`
- multi-account: `accounts.<id>.enabled`, `accounts.<id>.authDir`, account-level overrides
- operations: `configWrites`, `debounceMs`, `web.enabled`, `web.heartbeatSeconds`, `web.reconnect.*`
- session behavior: `session.dmScope`, `historyLimit`, `dmHistoryLimit`, `dms.<id>.historyLimit`
- prompts: `groups.<id>.systemPrompt`, `groups["*"].systemPrompt`, `direct.<id>.systemPrompt`, `direct["*"].systemPrompt`

## Related

- [Pairing](/channels/pairing)
- [Groups](/channels/groups)
- [Security](/gateway/security)
- [Channel routing](/channels/channel-routing)
- [Multi-agent routing](/concepts/multi-agent)
- [Troubleshooting](/channels/troubleshooting)
