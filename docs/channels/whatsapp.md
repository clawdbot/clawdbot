---
summary: "WhatsApp channel support, access controls, delivery behavior, and operations"
read_when:
  - Working on WhatsApp/web channel behavior or inbox routing
title: "WhatsApp"
---

Status: production-ready via WhatsApp Web (Baileys). The gateway owns the linked session(s); there is no separate Twilio WhatsApp channel.

## Install

`openclaw onboard` and `openclaw channels add --channel whatsapp` prompt to install the plugin the first time you select it; `openclaw channels login --channel whatsapp` offers the same install flow if the plugin is missing. Dev checkouts use the local plugin path; stable/beta installs `@openclaw/whatsapp` from ClawHub first, falling back to npm. The WhatsApp runtime ships outside the core OpenClaw npm package, so its runtime dependencies stay with the external plugin. Manual install:

```bash
openclaw plugins install clawhub:@openclaw/whatsapp
```

Use the bare npm package (`@openclaw/whatsapp`) only for the registry fallback; pin an exact version only for a reproducible install.

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
  <Step title="Configure access policy">

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

    Login is QR-only. On remote or headless hosts, have a reliable path to deliver the live QR to the phone before starting login; terminal-rendered QRs, screenshots, or chat attachments can expire in transit.

    For a specific account:

```bash
openclaw channels login --channel whatsapp --account work
```

    To attach an existing/custom auth directory before login:

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

  <Step title="Approve the first pairing request (pairing mode)">

```bash
openclaw pairing list whatsapp
openclaw pairing approve whatsapp <CODE>
```

    Pairing requests expire after 1 hour; pending requests are capped at 3 per account.

  </Step>
</Steps>

<Note>
A separate WhatsApp number is recommended (setup and metadata are optimized for it), but personal-number/self-chat setups are fully supported.
</Note>

## Deployment patterns

<AccordionGroup>
  <Accordion title="Dedicated number (recommended)">
    - separate WhatsApp identity for OpenClaw
    - clearer DM allowlists and routing boundaries
    - lower chance of self-chat confusion

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
    Onboarding supports personal-number mode and writes a self-chat-friendly baseline: `dmPolicy: "allowlist"`, `allowFrom` including your own number, `selfChatMode: true`. Runtime self-chat protections key off the linked self number plus `allowFrom`.
  </Accordion>
</AccordionGroup>

## Runtime model

- The gateway owns the WhatsApp socket and reconnect loop.
- A watchdog tracks two signals independently: raw WhatsApp Web transport activity and application-message activity. A quiet-but-connected session is not restarted just because no message arrived recently; it forces reconnect only when transport frames stop arriving for a fixed internal window (not user-configurable) or application messages stay silent past 4x the normal message timeout. Right after a reconnect for a recently active session, that first window uses the shorter normal message timeout instead of the 4x window. OpenClaw can auto-reply to offline messages that Baileys delivers early in that reconnect, bounded by the inbound message-ID dedupe lifetime; initial startup keeps the short stale-history guard.
- Baileys socket timings are explicit under `web.whatsapp.*`: `keepAliveIntervalMs` (application ping interval), `connectTimeoutMs` (opening handshake timeout), `defaultQueryTimeoutMs` (Baileys query waits, plus OpenClaw's outbound send/presence and inbound read-receipt timeouts).
- Outbound sends require an active WhatsApp listener for the target account; sends fail fast otherwise.
- Group sends attach native mention metadata for `@+<digits>` and `@<digits>` tokens (in text and media captions) when the token matches current participant metadata, including LID-backed groups.
- Status and broadcast chats (`@status`, `@broadcast`) are ignored.
- Direct chats use DM session rules (`session.dmScope`; default `main` collapses DMs into the agent main session). Group sessions are isolated per JID (`agent:<agentId>:whatsapp:group:<jid>`).
- WhatsApp Channels/Newsletters can be explicit outbound targets via their native `@newsletter` JID, using channel session metadata (`agent:<agentId>:whatsapp:channel:<jid>`) rather than DM semantics.
- WhatsApp Web transport honors standard proxy environment variables on the gateway host (`HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY`, lowercase variants). Prefer host-level proxy config over per-channel settings.
- With `messages.removeAckAfterReply` enabled, OpenClaw clears the ack reaction once a visible reply is delivered.

## Call the current requester with MeowCaller (experimental)

The plugin can expose `whatsapp_call` in WhatsApp-originated agent turns. It uses [MeowCaller](https://github.com/purpshell/meowcaller) to place a WhatsApp voice call to the current authorized requester and play an OpenClaw TTS message after they answer. The tool has no destination-number parameter, so a prompt cannot redirect the call. Disabled by default.

<Warning>
MeowCaller is experimental, has no tagged release, and uses a separately paired whatsmeow linked-device session — it cannot reuse the plugin's Baileys credentials. Pairing adds another linked device to the same WhatsApp account; scan with the identity used by OpenClaw. Personal-number/self-chat mode cannot call itself; use a dedicated OpenClaw number to call your personal number.
</Warning>

<Steps>
  <Step title="Enable experimental calls">

    Add `actions.calls: true` to the WhatsApp channel config and restart the gateway:

```json
{
  "channels": {
    "whatsapp": {
      "actions": {
        "calls": true
      }
    }
  }
}
```

    When absent or `false`, OpenClaw does not expose the `whatsapp_call` tool.

  </Step>

  <Step title="Install the reviewed MeowCaller CLI">

    The adapter expects a `meowcaller` executable on the gateway host's `PATH`. Until [MeowCaller PR #7](https://github.com/purpshell/meowcaller/pull/7) merges, build the reviewed branch:

```bash
git clone --branch feat/send-only-notify https://github.com/steipete/meowcaller.git
cd meowcaller
git checkout 752050471fc2bf7a8cdfbf7dbd3cd4e865d85d3f
mkdir -p "$HOME/.local/bin"
go build -o "$HOME/.local/bin/meowcaller" ./cmd/meowcaller
```

    Ensure `$HOME/.local/bin` is on the gateway service's `PATH`. This revision has explicit `pair` and send-only `notify` commands; `notify` opens no microphone, speaker, video device, or diagnostic capture. Do not substitute the upstream example CLI's `play` command.

  </Step>

  <Step title="Pair the MeowCaller linked device">

    Ask the WhatsApp agent to check call setup (`whatsapp_call` status action reports the account-specific state directory and pairing command). For the default account:

```bash
state_dir="$HOME/.openclaw/credentials/whatsapp-calls/default"
mkdir -p "$state_dir"
chmod 700 "$state_dir"
meowcaller pair --store "$state_dir/wa-voip.db"
```

    Run this interactively, scan the QR from **WhatsApp > Linked devices**, and wait for `MeowCaller linked device ready`. Keep `wa-voip.db` private — it is the MeowCaller session. Non-default accounts get their own store path from the status action; on Windows, run its PowerShell command.

  </Step>

  <Step title="Configure TTS and call from WhatsApp">

    Configure a telephony-capable [TTS provider](/tools/tts), restart the gateway, then send a request such as `Call me and say the build finished.` The tool resolves the sender from trusted inbound context, synthesizes a temporary private WAV file, runs MeowCaller for a bounded call window, and deletes the audio file afterward. OpenClaw passes the account's store explicitly, waits for a zero exit status after answer/playback/hangup, and treats a timeout or nonzero exit as a failed tool call.

  </Step>
</Steps>

Limits: one-to-one outbound audio calls only, no arbitrary destination numbers, no shared auth with the chat connection, no self-calls from personal-number/self-chat mode, synthesized audio capped at 60 seconds, no handset-side audibility receipt beyond MeowCaller's answer/playback/hangup completion, and OpenClaw stops the companion process after a bounded 115-175 second window (covering MeowCaller's connection, answer, playback, and shutdown phases).

## Approval prompts

WhatsApp can render exec and plugin approval prompts as `👍`/`👎` reactions, controlled by the top-level approval forwarding config:

```json5
{
  approvals: {
    exec: {
      enabled: true,
      mode: "session",
    },
    plugin: {
      enabled: true,
      mode: "targets",
      targets: [{ channel: "whatsapp", to: "+15551234567" }],
    },
  },
}
```

`approvals.exec` and `approvals.plugin` are independent; enabling WhatsApp as a channel only links the transport and sends nothing unless the matching approval family is enabled and routed there. Session mode delivers native emoji approvals only for approvals that originate from WhatsApp. Target mode uses the shared forwarding pipeline for explicit targets and does not create separate approver-DM fanout.

WhatsApp approval reactions require explicit approvers in `allowFrom` (or `"*"`). `defaultTo` sets ordinary default message targets, not an approver list. Manual `/approve` commands still pass the normal WhatsApp sender-authorization path before approval resolution.

## Plugin hooks and privacy

Inbound WhatsApp messages can carry personal content, phone numbers, group identifiers, sender names, and session correlation fields. WhatsApp does not broadcast inbound `message_received` hook payloads to plugins unless you opt in:

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

Scope the opt-in to one account under `channels.whatsapp.accounts.<id>.pluginHooks.messageReceived`. Only enable this for plugins you trust with inbound WhatsApp content and identifiers.

## Access control and activation

<Tabs>
  <Tab title="DM policy">
    `channels.whatsapp.dmPolicy`:

    | Value | Behavior |
    | --- | --- |
    | `pairing` (default) | Unknown senders request pairing; owner approves |
    | `allowlist` | Only `allowFrom` senders admitted |
    | `open` | Requires `allowFrom` to include `"*"` |
    | `disabled` | Block all DMs |

    `allowFrom` accepts E.164-style numbers (normalized internally). It is a DM sender access-control list only — it does not gate explicit outbound sends to group JIDs or `@newsletter` channel JIDs.

    Multi-account override: `channels.whatsapp.accounts.<id>.dmPolicy` (and `.allowFrom`) take precedence over channel-level defaults for that account.

    Runtime notes:

    - pairings persist in the channel allow-store and merge with configured `allowFrom`
    - scheduled automation and heartbeat recipient fallback use explicit delivery targets or configured `allowFrom`; DM pairing approvals are not implicit cron/heartbeat recipients
    - if no allowlist is configured, the linked self number is allowed by default
    - OpenClaw never auto-pairs outbound `fromMe` DMs (messages you send yourself from the linked device)

  </Tab>

  <Tab title="Group policy and allowlists">
    Group access has two layers:

    1. **Group membership allowlist** (`channels.whatsapp.groups`): if `groups` is omitted, all groups are eligible; if present, it acts as a group allowlist (`"*"` admits all).
    2. **Group sender policy** (`channels.whatsapp.groupPolicy` + `groupAllowFrom`): `open` bypasses the sender allowlist, `allowlist` requires a `groupAllowFrom` (or `*`) match, `disabled` blocks all group inbound.

    If `groupAllowFrom` is unset, sender checks fall back to `allowFrom` when it has entries. Sender allowlists are evaluated before mention/reply activation.

    If no `channels.whatsapp` block exists at all, runtime falls back to `groupPolicy: "allowlist"` (with a warning log), even if `channels.defaults.groupPolicy` is set to something else.

    <Note>
    Group-membership resolution has a single-account safety net: if only one WhatsApp account is configured and its `accounts.<id>.groups` is an explicit empty object (`{}`), that is treated as "not set" and falls back to the root `channels.whatsapp.groups` map, instead of silently blocking every group. With 2+ accounts configured, an explicit empty account map stays empty and does not fall back — this lets one account intentionally disable all groups without affecting siblings.
    </Note>

  </Tab>

  <Tab title="Mentions and /activation">
    Group replies require a mention by default. Mention detection includes:

    - explicit WhatsApp mentions of the bot identity
    - configured mention regex patterns (`agents.list[].groupChat.mentionPatterns`, fallback `messages.groupChat.mentionPatterns`)
    - inbound voice-note transcripts for authorized group messages
    - implicit reply-to-bot detection (reply sender matches bot identity)

    Security: quote/reply only satisfies mention gating — it does **not** grant sender authorization. With `groupPolicy: "allowlist"`, non-allowlisted senders stay blocked even replying to an allowlisted user's message.

    Session-level activation command: `/activation mention` or `/activation always`. This updates session state (not global config) and is owner-gated.

  </Tab>
</Tabs>

## Configured ACP bindings

WhatsApp supports persistent ACP bindings via top-level `bindings[]`:

```json5
{
  bindings: [
    {
      type: "acp",
      agentId: "codex",
      match: {
        channel: "whatsapp",
        accountId: "work",
        peer: { kind: "direct", id: "+15555550123" },
      },
    },
    {
      type: "acp",
      agentId: "codex",
      match: {
        channel: "whatsapp",
        accountId: "work",
        peer: { kind: "group", id: "120363424282127706@g.us" },
      },
    },
  ],
}
```

Direct chats match E.164 numbers; groups match WhatsApp group JIDs. Group allowlists, sender policy, and mention/activation gating run before OpenClaw ensures the bound ACP session exists. A matched binding owns the route — broadcast groups do not fan that turn out to ordinary WhatsApp sessions.

## Personal-number and self-chat behavior

When the linked self number is also present in `allowFrom`, self-chat safeguards activate: skip read receipts for self-chat turns, ignore mention-JID auto-trigger behavior that would ping yourself, and default replies to `[{identity.name}]` (or `[openclaw]`) when `messages.responsePrefix` is unset.

## Message normalization and context

<AccordionGroup>
  <Accordion title="Inbound envelope and reply context">
    Incoming messages are wrapped in the shared inbound envelope. A quoted reply appends context in this form:

    ```text
    [Replying to <sender> id:<stanzaId>]
    <quoted body or media placeholder>
    [/Replying]
    ```

    Reply metadata (`ReplyToId`, `ReplyToBody`, `ReplyToSender`, sender JID/E.164) is populated when available. If the quoted target is downloadable media, OpenClaw saves it through the normal inbound media store and exposes `MediaPath`/`MediaType` so the agent can inspect it directly instead of seeing only `<media:image>`.

  </Accordion>

  <Accordion title="Media placeholders and location/contact extraction">
    Media-only messages normalize to placeholders: `<media:image>`, `<media:video>`, `<media:audio>`, `<media:document>`, `<media:sticker>`.

    Authorized group voice notes are transcribed before mention gating when the body is only `<media:audio>`, so saying the bot mention in the voice note can trigger the reply. If the transcript still does not mention the bot, it stays in pending group history instead of the raw placeholder.

    Location bodies render as terse coordinate text. Location labels/comments and contact/vCard details render as fenced untrusted metadata, not inline prompt text.

  </Accordion>

  <Accordion title="Pending group history injection">
    Unprocessed group messages buffer and inject as context when the bot is finally triggered.

    - default limit: `50`
    - config: `channels.whatsapp.historyLimit`, fallback `messages.groupChat.historyLimit`
    - `0` disables

    Injection markers: `[Chat messages since your last reply - for context]` and `[Current message - respond to this]`.

  </Accordion>

  <Accordion title="Read receipts">
    Enabled by default for accepted inbound messages. Disable globally:

    ```json5
    { channels: { whatsapp: { sendReadReceipts: false } } }
    ```

    Per-account override: `channels.whatsapp.accounts.<id>.sendReadReceipts`. Self-chat turns skip read receipts even when globally enabled.

  </Accordion>
</AccordionGroup>

## Delivery, chunking, and media

<AccordionGroup>
  <Accordion title="Text chunking">
    - default chunk limit: `channels.whatsapp.textChunkLimit = 4000`
    - `channels.whatsapp.streaming.chunkMode = "length" | "newline"`; `newline` prefers paragraph boundaries (blank lines), then falls back to length-safe chunking

  </Accordion>

  <Accordion title="Outbound media behavior">
    - supports image, video, audio (PTT voice-note), and document payloads
    - audio is sent as the Baileys `audio` payload with `ptt: true`, rendering as a push-to-talk voice note; `audioAsVoice` is preserved on reply payloads so TTS voice-note output stays on this path regardless of the provider's source format
    - native Ogg/Opus audio sends as `audio/ogg; codecs=opus`; anything else (including Microsoft Edge TTS MP3/WebM output) is transcoded with `ffmpeg` to 48 kHz mono Ogg/Opus before PTT delivery
    - `/tts latest` sends the latest assistant reply as one voice note and suppresses repeat sends for the same reply; `/tts chat on|off|default` controls auto-TTS for the current chat
    - `gifPlayback: true` on video sends enables animated GIF playback
    - `forceDocument`/`asDocument` routes outbound images, GIFs, and videos through the Baileys document payload to avoid WhatsApp's media compression, preserving the resolved filename and MIME type
    - captions apply to the first media item in a multi-media reply, except PTT voice notes: the audio sends first with no caption, then the caption sends as a separate text message (WhatsApp clients do not render voice-note captions consistently)
    - media source can be HTTP(S), `file://`, or a local path

  </Accordion>

  <Accordion title="Media size limits and fallback behavior">
    - inbound save cap and outbound send cap: `channels.whatsapp.mediaMaxMb` (default `50`)
    - per-account override: `channels.whatsapp.accounts.<id>.mediaMaxMb`
    - images auto-optimize (resize/quality sweep) to fit limits unless `forceDocument`/`asDocument` requests document delivery
    - on media send failure, the first-item fallback sends a text warning instead of dropping the response silently

  </Accordion>
</AccordionGroup>

## Reply quoting

`channels.whatsapp.replyToMode` controls native reply quoting (outbound replies visibly quote the inbound message):

| Value             | Behavior                                                       |
| ----------------- | -------------------------------------------------------------- |
| `"off"` (default) | Never quote; send as a plain message                           |
| `"first"`         | Quote only the first outbound reply chunk                      |
| `"all"`           | Quote every outbound reply chunk                               |
| `"batched"`       | Quote queued batched replies; leave immediate replies unquoted |

Per-account override: `channels.whatsapp.accounts.<id>.replyToMode`.

```json5
{ channels: { whatsapp: { replyToMode: "first" } } }
```

## Reaction level

`channels.whatsapp.reactionLevel` controls how broadly the agent uses emoji reactions:

| Level                 | Ack reactions | Agent-initiated reactions  |
| --------------------- | ------------- | -------------------------- |
| `"off"`               | No            | No                         |
| `"ack"`               | Yes           | No                         |
| `"minimal"` (default) | Yes           | Yes, conservative guidance |
| `"extensive"`         | Yes           | Yes, encouraged guidance   |

Per-account override: `channels.whatsapp.accounts.<id>.reactionLevel`.

```json5
{ channels: { whatsapp: { reactionLevel: "ack" } } }
```

## Acknowledgment reactions

`channels.whatsapp.ackReaction` sends an immediate reaction on inbound receipt, gated by `reactionLevel` (suppressed when `"off"`):

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

Notes: sent immediately after inbound is accepted (pre-reply); if `ackReaction` is present without `emoji`, WhatsApp uses the routed agent's identity emoji falling back to "👀" (omit `ackReaction` or set `emoji: ""` for no ack); failures are logged but do not block reply delivery; group mode `mentions` reacts only on mention-triggered turns, while group activation `always` bypasses that check; WhatsApp uses `channels.whatsapp.ackReaction` only (legacy `messages.ackReaction` does not apply here).

## Lifecycle status reactions

Set `messages.statusReactions.enabled: true` to let WhatsApp replace the ack reaction during a turn instead of leaving a static receipt emoji, cycling through states such as queued, thinking, tool activity, compaction, done, and error:

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

Notes: `channels.whatsapp.ackReaction` still controls eligibility for direct messages and groups; the queued state uses the same effective emoji as plain ack reactions; WhatsApp has one bot reaction slot per message, so lifecycle updates replace the current reaction in place; `messages.removeAckAfterReply: true` clears the final status reaction after the configured done/error hold; tool emoji categories include `tool`, `coding`, `web`, `deploy`, `build`, and `concierge`.

## Multi-account and credentials

<AccordionGroup>
  <Accordion title="Account selection and defaults">
    Account ids come from `channels.whatsapp.accounts`. Default account selection is `default` if present, otherwise the first configured account id (alphabetically sorted). Account ids are normalized internally for lookup.
  </Accordion>

  <Accordion title="Credential paths and legacy compatibility">
    - current auth path: `~/.openclaw/credentials/whatsapp/<accountId>/creds.json` (backup: `creds.json.bak`)
    - legacy default auth in `~/.openclaw/credentials/` is still recognized/migrated for default-account flows

  </Accordion>

  <Accordion title="Logout behavior">
    `openclaw channels logout --channel whatsapp [--account <id>]` clears WhatsApp auth state for that account. When a gateway is reachable, logout stops the live listener for that account first, so the linked session stops receiving messages before the next restart. `openclaw channels remove --channel whatsapp` also stops the live listener before disabling or deleting account config.

    In legacy auth directories, `oauth.json` is preserved while Baileys auth files are removed.

  </Accordion>
</AccordionGroup>

## Tools, actions, and config writes

- Agent tool support includes the WhatsApp reaction action (`react`).
- Action gates: `channels.whatsapp.actions.reactions`, `channels.whatsapp.actions.polls` (existing actions default to `true`), `channels.whatsapp.actions.calls` (default `false`, see MeowCaller above).
- Channel-initiated config writes are enabled by default; disable via `channels.whatsapp.configWrites: false`.

## Troubleshooting

<AccordionGroup>
  <Accordion title="Not linked (QR required)">
    Symptom: channel status reports not linked.

```bash
openclaw channels login --channel whatsapp
openclaw channels status
```

  </Accordion>

  <Accordion title="Linked but disconnected / reconnect loop">
    Symptom: linked account with repeated disconnects or reconnect attempts.

    Quiet accounts can stay connected past the normal message timeout; the watchdog restarts only when WhatsApp Web transport activity stops, the socket closes, or application-level activity stays silent beyond the longer safety window (see Runtime model above).

    If logs show repeated `status=408 Request Time-out Connection was lost`, tune Baileys socket timings under `web.whatsapp`. Start by shortening `keepAliveIntervalMs` below your network's idle timeout and increasing `connectTimeoutMs` on slow or lossy links:

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
    openclaw channels status --probe
    openclaw doctor
    openclaw logs --follow
    openclaw gateway status
    ```

    If the loop persists after host connectivity and timing are fixed, back up the account auth directory and re-link:

    ```bash
    cp -a ~/.openclaw/credentials/whatsapp/<accountId> \
      ~/.openclaw/credentials/whatsapp/<accountId>.bak
    openclaw channels logout --channel whatsapp --account <accountId>
    openclaw channels login --channel whatsapp --account <accountId>
    ```

    If `~/.openclaw/logs/whatsapp-health.log` says `Gateway inactive` but `openclaw gateway status` and `openclaw channels status --probe` both show healthy, run `openclaw doctor`. On Linux, doctor warns about legacy crontab entries invoking the retired `~/.openclaw/bin/ensure-whatsapp.sh` script; remove those entries with `crontab -e` — cron can lack the systemd user-bus environment and make that old script misreport gateway health.

  </Accordion>

  <Accordion title="QR login times out behind a proxy">
    Symptom: `openclaw channels login --channel whatsapp` fails before showing a usable QR with `status=408 Request Time-out` or a TLS socket disconnect.

    WhatsApp Web login uses the gateway host's standard proxy environment (`HTTPS_PROXY`, `HTTP_PROXY`, lowercase variants, `NO_PROXY`). Verify the gateway process inherits the proxy env and that `NO_PROXY` does not match `mmg.whatsapp.net`.

  </Accordion>

  <Accordion title="No active listener when sending">
    Outbound sends fail fast when no active gateway listener exists for the target account. Confirm the gateway is running and the account is linked.
  </Accordion>

  <Accordion title="Reply appears in transcript but not in WhatsApp">
    Transcript rows record what the agent generated; WhatsApp delivery is checked separately. OpenClaw only treats an auto-reply as sent after Baileys returns an outbound message id for at least one visible text or media send.

    Ack reactions are independent pre-reply receipts — a successful reaction does not prove the later text/media reply was accepted. Check gateway logs for `auto-reply delivery failed` or `auto-reply was not accepted by WhatsApp provider`.

  </Accordion>

  <Accordion title="Group messages unexpectedly ignored">
    Check in this order: `groupPolicy`, `groupAllowFrom`/`allowFrom`, `groups` allowlist entries, mention gating (`requireMention` + mention patterns), and duplicate keys in `openclaw.json` (JSON5 later entries override earlier ones — keep a single `groupPolicy` per scope).

    If `channels.whatsapp.groups` is present, WhatsApp can still observe messages from other groups, but OpenClaw drops them before session routing. Add the group JID to `channels.whatsapp.groups`, or add `groups["*"]` to admit all groups while keeping sender authorization under `groupPolicy`/`groupAllowFrom`.

  </Accordion>

  <Accordion title="Bun runtime warning">
    OpenClaw gateways require Node. Bun does not provide the `node:sqlite` API used by the canonical state store, and doctor migrates legacy Bun services to Node.
  </Accordion>
</AccordionGroup>

## System prompts

WhatsApp supports Telegram-style system prompts for groups and direct chats via the `groups` and `direct` maps.

Resolution for group messages: the effective `groups` map is determined first — if the account defines its own `groups` key at all, it fully replaces the root `groups` map (no deep merge). Prompt lookup then runs on that single resulting map:

1. **Group-specific prompt** (`groups["<groupId>"].systemPrompt`): used when the group entry exists **and** its `systemPrompt` key is defined. An empty string (`""`) suppresses the wildcard and applies no prompt.
2. **Group wildcard prompt** (`groups["*"].systemPrompt`): used when the specific group entry is absent, or exists without a `systemPrompt` key.

Resolution for direct messages follows the identical pattern against the `direct` map and `direct["*"]`.

<Note>
`dms` remains the lightweight per-DM history override bucket (`dms.<id>.historyLimit`). Prompt overrides live under `direct`.
</Note>

<Note>
This account-replaces-root behavior for prompt resolution is a plain shallow override: any account `groups`/`direct` key, including an explicit empty object, replaces the root map. It differs from the group-membership allowlist check described above, which has a single-account safety net for an accidentally empty `groups: {}`.
</Note>

**Difference from Telegram:** Telegram suppresses root `groups` for every account in a multi-account setup (even accounts with no `groups` of their own) to stop a bot receiving group messages for groups it does not belong to. WhatsApp does not apply that guard — root `groups`/`direct` are inherited by any account without its own override, regardless of account count. In a multi-account WhatsApp setup, define the full map under each account explicitly if you want per-account prompts.

Important behavior:

- `channels.whatsapp.groups` is both a per-group config map and the chat-level group allowlist. At either root or account scope, `groups["*"]` means "all groups are admitted" for that scope.
- Only add a wildcard `systemPrompt` when you already want that scope to admit all groups. To keep only a fixed set of group IDs eligible, repeat the prompt on each explicitly allowlisted entry instead of using `groups["*"]`.
- Group admission and sender authorization are separate checks. `groups["*"]` widens which groups reach group handling; it does not authorize every sender in those groups — that stays controlled by `groupPolicy`/`groupAllowFrom`.
- `channels.whatsapp.direct` has no equivalent side effect for DMs: `direct["*"]` only supplies a default config after a DM is already admitted by `dmPolicy` plus `allowFrom` or pairing-store rules.

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

Primary reference: [Configuration reference - WhatsApp](/gateway/config-channels#whatsapp)

| Area             | Fields                                                                                                         |
| ---------------- | -------------------------------------------------------------------------------------------------------------- |
| Access           | `dmPolicy`, `allowFrom`, `groupPolicy`, `groupAllowFrom`, `groups`                                             |
| Delivery         | `textChunkLimit`, `streaming.chunkMode`, `mediaMaxMb`, `sendReadReceipts`, `ackReaction`, `reactionLevel`      |
| Multi-account    | `accounts.<id>.enabled`, `accounts.<id>.authDir`, and other per-account overrides                              |
| Operations       | `configWrites`, `debounceMs`, `web.enabled`, `web.heartbeatSeconds`, `web.reconnect.*`, `web.whatsapp.*`       |
| Session behavior | `session.dmScope`, `historyLimit`, `dmHistoryLimit`, `dms.<id>.historyLimit`                                   |
| Prompts          | `groups.<id>.systemPrompt`, `groups["*"].systemPrompt`, `direct.<id>.systemPrompt`, `direct["*"].systemPrompt` |

## Related

- [Pairing](/channels/pairing)
- [Groups](/channels/groups)
- [Security](/gateway/security)
- [Channel routing](/channels/channel-routing)
- [Multi-agent routing](/concepts/multi-agent)
- [Troubleshooting](/channels/troubleshooting)
