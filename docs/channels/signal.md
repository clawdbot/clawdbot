---
summary: "Signal support via signal-cli (native daemon or bbernhard container), setup paths, and number model"
read_when:
  - Setting up Signal support
  - Debugging Signal send/receive
title: "Signal"
---

Signal is a downloadable channel plugin (`@openclaw/signal`). The gateway talks to `signal-cli` over HTTP: either the native daemon (JSON-RPC + SSE) or the [bbernhard/signal-cli-rest-api](https://github.com/bbernhard/signal-cli-rest-api) container (REST + WebSocket). OpenClaw does not embed libsignal.

## The number model (read this first)

- The gateway connects to a **Signal device**: the `signal-cli` account.
- Running the bot on **your personal Signal account** makes it ignore your own messages (loop protection).
- For "I text the bot and it replies," use a **separate bot number**.

## Install

```bash
openclaw plugins install @openclaw/signal
```

Bare plugin specs try ClawHub first, then npm fallback. Force a source with `openclaw plugins install clawhub:@openclaw/signal` or `npm:@openclaw/signal`. `plugins install` registers and enables the plugin; no separate `enable` step is needed. See [Plugins](/tools/plugin) for general install rules.

## Quick setup

<Steps>
  <Step title="Pick a number">
    Use a **separate Signal number** for the bot (recommended).
  </Step>
  <Step title="Install the plugin">
    ```bash
    openclaw plugins install @openclaw/signal
    ```
  </Step>
  <Step title="Run the guided setup">
    ```bash
    openclaw channels add
    ```
    The wizard detects whether `signal-cli` is on `PATH` and, when missing, offers to install it: downloads the official native GraalVM build on Linux x86-64, or installs via Homebrew on macOS and other architectures. It then prompts for the bot number and `signal-cli` path.

    For non-interactive setup, `openclaw channels add --channel signal` also accepts `--signal-number <e164>` for the bot phone number, plus `--http-host <host>` and `--http-port <port>` for the Signal daemon endpoint (default `127.0.0.1:8080`).

  </Step>
  <Step title="Link or register the account">
    - **QR link (fastest):** `signal-cli link -n "OpenClaw"`, then scan with Signal. See [Path A](#setup-path-a-link-existing-signal-account-qr).
    - **SMS registration:** dedicated number with captcha + SMS verification. See [Path B](#setup-path-b-register-dedicated-bot-number-sms-linux).

  </Step>
  <Step title="Verify and pair">
    ```bash
    openclaw gateway call channels.status --params '{"probe":true}'
    ```
    Send a first DM and approve pairing: `openclaw pairing approve signal <CODE>`.
  </Step>
</Steps>

Minimal config:

```json5
{
  channels: {
    signal: {
      enabled: true,
      account: "+15551234567",
      cliPath: "signal-cli",
      dmPolicy: "pairing",
      allowFrom: ["+15557654321"],
    },
  },
}
```

| Field        | Description                                       |
| ------------ | ------------------------------------------------- |
| `account`    | Bot phone number in E.164 format (`+15551234567`) |
| `cliPath`    | Path to `signal-cli` (`signal-cli` if on `PATH`)  |
| `configPath` | signal-cli config dir passed as `--config`        |
| `dmPolicy`   | DM access policy (`pairing` recommended)          |
| `allowFrom`  | Phone numbers or `uuid:<id>` values allowed to DM |

Multi-account support: use `channels.signal.accounts` with per-account config and optional `name`. See [Multi-account channels](/gateway/config-channels#multi-account-all-channels) for the shared pattern.

## What it is

- Deterministic routing: replies always go back to Signal.
- DMs share the agent's main session; groups are isolated (`agent:<agentId>:signal:group:<groupId>`).
- By default, Signal may write config updates triggered by `/config set|unset` (requires `commands.config: true`). Disable with `channels.signal.configWrites: false`.

## Setup path A: link existing Signal account (QR)

1. Install `signal-cli` (JVM or native build), or let `openclaw channels add` install it for you.
2. Link a bot account: `signal-cli link -n "OpenClaw"`, then scan the QR in Signal.
3. Configure Signal and start the gateway.

## Setup path B: register dedicated bot number (SMS, Linux)

Use this for a dedicated bot number instead of linking an existing Signal app account. The flow below is tested on Ubuntu 24.

1. Get a number that can receive SMS (or voice verification for landlines). A dedicated bot number avoids account/session conflicts.
2. Install `signal-cli` on the gateway host:

```bash
VERSION=$(curl -Ls -o /dev/null -w %{url_effective} https://github.com/AsamK/signal-cli/releases/latest | sed -e 's/^.*\/v//')
curl -L -O "https://github.com/AsamK/signal-cli/releases/download/v${VERSION}/signal-cli-${VERSION}-Linux-native.tar.gz"
sudo tar xf "signal-cli-${VERSION}-Linux-native.tar.gz" -C /opt
sudo ln -sf /opt/signal-cli /usr/local/bin/
signal-cli --version
```

If you use the JVM build (`signal-cli-${VERSION}.tar.gz`), install a JRE first. Keep `signal-cli` updated; upstream notes old releases can break as Signal server APIs change.

3. Register and verify the number:

```bash
signal-cli -a +<BOT_PHONE_NUMBER> register
```

If captcha is required (browser access is needed to complete this step):

1. Open `https://signalcaptchas.org/registration/generate.html`.
2. Complete the captcha, copy the `signalcaptcha://...` link target from "Open Signal".
3. Run from the same external IP as the browser session when possible (captcha tokens expire quickly).
4. Register and verify immediately:

```bash
signal-cli -a +<BOT_PHONE_NUMBER> register --captcha '<SIGNALCAPTCHA_URL>'
signal-cli -a +<BOT_PHONE_NUMBER> verify <VERIFICATION_CODE>
```

4. Configure OpenClaw, restart the gateway, verify the channel:

```bash
# If you run the gateway as a user systemd service:
systemctl --user restart openclaw-gateway.service

# Then verify:
openclaw doctor
openclaw channels status --probe
```

5. Pair your DM sender:
   - Send any message to the bot number.
   - Approve on the server: `openclaw pairing approve signal <PAIRING_CODE>`.
   - Save the bot number as a contact on your phone to avoid "Unknown contact".

<Warning>
Registering a phone number account with `signal-cli` can de-authenticate the main Signal app session for that number. Prefer a dedicated bot number, or use QR link mode to keep your existing phone app setup.
</Warning>

Upstream references:

- `signal-cli` README: `https://github.com/AsamK/signal-cli`
- Captcha flow: `https://github.com/AsamK/signal-cli/wiki/Registration-with-captcha`
- Linking flow: `https://github.com/AsamK/signal-cli/wiki/Linking-other-devices-(Provisioning)`

## External daemon mode (httpUrl)

To manage `signal-cli` yourself (slow JVM cold starts, container init, shared CPUs), run the daemon separately and point OpenClaw at it:

```json5
{
  channels: {
    signal: {
      httpUrl: "http://127.0.0.1:8080",
      autoStart: false,
    },
  },
}
```

This skips auto-spawn and OpenClaw's startup wait. For slow auto-spawned starts, set `channels.signal.startupTimeoutMs`.

## Container mode (bbernhard/signal-cli-rest-api)

Instead of running `signal-cli` natively, use the [bbernhard/signal-cli-rest-api](https://github.com/bbernhard/signal-cli-rest-api) Docker container, which wraps `signal-cli` behind a REST + WebSocket interface.

Requirements:

- The container **must** run with `MODE=json-rpc` for real-time message receiving.
- Register or link your Signal account inside the container before connecting OpenClaw.

Example `docker-compose.yml` service:

```yaml
signal-cli:
  image: bbernhard/signal-cli-rest-api:latest
  environment:
    MODE: json-rpc
  ports:
    - "8080:8080"
  volumes:
    - signal-cli-data:/home/.local/share/signal-cli
```

OpenClaw config:

```json5
{
  channels: {
    signal: {
      enabled: true,
      account: "+15551234567",
      httpUrl: "http://signal-cli:8080",
      autoStart: false,
      apiMode: "container", // or "auto" to detect automatically
    },
  },
}
```

`apiMode` controls which protocol OpenClaw uses:

| Value         | Behavior                                                                             |
| ------------- | ------------------------------------------------------------------------------------ |
| `"auto"`      | (Default) Probes both transports; streaming validates container WebSocket receive    |
| `"native"`    | Force native signal-cli (JSON-RPC at `/api/v1/rpc`, SSE at `/api/v1/events`)         |
| `"container"` | Force bbernhard container (REST at `/v2/send`, WebSocket at `/v1/receive/{account}`) |

When `apiMode` is `"auto"`, OpenClaw caches the detected mode for 30 seconds per daemon URL to avoid repeated probes (native wins when both transports are healthy). Container receive is only selected for streaming after `/v1/receive/{account}` upgrades to WebSocket, which requires `MODE=json-rpc`.

Container mode supports the same Signal operations as native mode where the container exposes matching APIs: sends, receives, attachments, typing indicators, read/viewed receipts, reactions, groups, and styled text. OpenClaw translates native Signal RPC calls into the container's REST payloads, including `group.{base64(internal_id)}` group IDs and `text_mode: "styled"` for formatted text.

Operational notes:

- Use `autoStart: false` with container mode; OpenClaw should not spawn a native daemon when `apiMode: "container"` is selected.
- Use `MODE=json-rpc` for receiving. `MODE=normal` can make `/v1/about` look healthy, but `/v1/receive/{account}` will not WebSocket-upgrade, so OpenClaw will not select container receive streaming in `auto` mode.
- Set `apiMode: "container"` when `httpUrl` points at the bbernhard REST API, `"native"` when it points at native `signal-cli` JSON-RPC/SSE, and `"auto"` when the deployment may vary.
- Container attachment downloads honor the same media byte limits as native mode. Oversized responses are rejected before being fully buffered when the server sends `Content-Length`, and while streaming otherwise.

## Access control (DMs + groups)

DMs:

- Default: `channels.signal.dmPolicy = "pairing"`.
- Unknown senders get a pairing code; messages are ignored until approved (codes expire after 1 hour).
- Approve via `openclaw pairing list signal` and `openclaw pairing approve signal <CODE>`.
- Pairing is the default token exchange for Signal DMs. Details: [Pairing](/channels/pairing)
- UUID-only senders (from `sourceUuid`) are stored as `uuid:<id>` in `channels.signal.allowFrom`.

Groups:

- `channels.signal.groupPolicy = open | allowlist | disabled`.
- `channels.signal.groupAllowFrom` controls which groups or senders can trigger group replies when `allowlist` is set; entries can be Signal group IDs (raw, `group:<id>`, or `signal:group:<id>`), sender phone numbers, `uuid:<id>` values, or `*`.
- `channels.signal.groups["<group-id>" | "*"]` can override group behavior with `requireMention`, `tools`, and `toolsBySender`.
- Use `channels.signal.accounts.<id>.groups` for per-account overrides in multi-account setups.
- Allowlisting a Signal group through `groupAllowFrom` does not disable mention gating by itself. A specifically configured `channels.signal.groups["<group-id>"]` entry processes every group message unless `requireMention=true` is set.
- With `requireMention=true`, Signal native @mentions are matched from structured mention metadata against the bot account phone or `accountUuid`. Configured `mentionPatterns` remain a plain-text fallback.
- Runtime note: if `channels.signal` is completely missing, runtime falls back to `groupPolicy="allowlist"` for group checks (even if `channels.defaults.groupPolicy` is set).

Mention-gated group with bounded context:

```json5
{
  channels: {
    signal: {
      account: "+15551234567",
      accountUuid: "bot-signal-uuid",
      groupPolicy: "allowlist",
      groupAllowFrom: ["group:<signal-group-id>"],
      historyLimit: 8,
      groups: {
        "<signal-group-id>": { requireMention: true },
      },
    },
  },
  messages: {
    groupChat: {
      mentionPatterns: ["\\bopenclaw\\b"],
    },
  },
}
```

Allowed group messages that do not mention the bot stay silent and are kept only in the bounded pending history window. When a later native @mention or fallback text mention triggers the bot, OpenClaw includes that recent context and replies to the same group. Skipped attachment bodies are not downloaded; they may appear only as compact media placeholders in the pending context.

## How it works (behavior)

- Native mode: `signal-cli` runs as a daemon; the gateway reads events via SSE.
- Container mode: the gateway sends via REST API and receives via WebSocket.
- Inbound messages are normalized into the shared channel envelope.
- Replies always route back to the same number or group.
- Replies to inbound messages include native Signal quote metadata when the backend accepts the inbound timestamp and author; if quote metadata is missing or rejected, OpenClaw sends the reply as a normal message.
- Configure native quote use with `channels.signal.replyToMode = off | first | all | batched`, or `channels.signal.replyToModeByChatType.direct/group` for per-chat-type overrides. Account-level values under `channels.signal.accounts.<id>` take precedence.

## Media + limits

- Outbound text is chunked to `channels.signal.textChunkLimit` (default 4000).
- Optional newline chunking: set `channels.signal.streaming.chunkMode="newline"` to split on blank lines (paragraph boundaries) before length chunking.
- Attachments are supported (base64 fetched from `signal-cli`).
- Voice-note attachments use the `signal-cli` filename as a MIME fallback when `contentType` is missing, so audio transcription can still classify AAC voice memos.
- Default media cap: `channels.signal.mediaMaxMb` (default 8).
- Use `channels.signal.ignoreAttachments` to skip downloading media.
- Group history context uses `channels.signal.historyLimit` (or `channels.signal.accounts.*.historyLimit`), falling back to `messages.groupChat.historyLimit`. Set `0` to disable (default 50).

## Typing + read receipts

- **Typing indicators**: OpenClaw sends typing signals via `signal-cli sendTyping` and refreshes them while a reply is running.
- **Read receipts**: when `channels.signal.sendReadReceipts` is true, OpenClaw forwards read receipts for allowed DMs.
- `signal-cli` does not expose read receipts for groups.

## Lifecycle status reactions

Set `messages.statusReactions.enabled: true` to let Signal show the shared queued/thinking/tool/compaction/done/error reaction lifecycle on inbound turns. Signal uses the inbound message timestamp as the reaction target; group reactions are sent with the Signal group ID plus the original sender as the target author.

Status reactions also require an ack reaction and a matching `messages.ackReactionScope` (`direct`, `group-all`, `group-mentions`, or `all`). Set `channels.signal.reactionLevel: "off"` to disable Signal status reactions.

`messages.removeAckAfterReply: true` clears the final status reaction after the configured hold time. Otherwise Signal restores the initial ack reaction after the final done/error state.

## Reactions (message tool)

Use `message action=react` with `channel=signal`.

- Targets: sender E.164 or UUID (use `uuid:<id>` from pairing output; a bare UUID also works).
- `messageId` is the Signal timestamp for the message you're reacting to.
- Group reactions require `targetAuthor` or `targetAuthorUuid`.

```text
message action=react channel=signal target=uuid:123e4567-e89b-12d3-a456-426614174000 messageId=1737630212345 emoji=🔥
message action=react channel=signal target=+15551234567 messageId=1737630212345 emoji=🔥 remove=true
message action=react channel=signal target=signal:group:<groupId> targetAuthor=uuid:<sender-uuid> messageId=1737630212345 emoji=✅
```

Config:

- `channels.signal.actions.reactions`: enable/disable reaction actions (default true).
- `channels.signal.reactionLevel`: `off | ack | minimal | extensive` (default `minimal`).
  - `off`/`ack` disables agent reactions (message tool `react` errors).
  - `minimal`/`extensive` enables agent reactions and sets the guidance level.
- Per-account overrides: `channels.signal.accounts.<id>.actions.reactions`, `channels.signal.accounts.<id>.reactionLevel`.

## Approval reactions

Signal exec and plugin approval prompts use the top-level `approvals.exec` and `approvals.plugin` routing blocks. Signal has no `channels.signal.execApprovals` block.

- `👍` approves once.
- `👎` denies.
- Use `/approve <id> allow-always` when a request offers persistent approval.

Approval reaction resolution requires explicit Signal approvers from `channels.signal.allowFrom`, `channels.signal.defaultTo`, or the matching account-level fields. Direct same-chat exec approval prompts can still suppress the duplicate local `/approve` fallback without explicit approvers; no-approver group approvals keep the local fallback visible.

## Delivery targets (CLI/cron)

- DMs: `signal:+15551234567` (or plain E.164).
- UUID DMs: `uuid:<id>` (or bare UUID).
- Groups: `signal:group:<groupId>`.
- Usernames: `username:<name>` (if supported by your Signal account).

## Aliases

Configure aliases for stable names on recurring Signal targets. Aliases are OpenClaw-side config only; they do not create or edit Signal contacts.

```json5
{
  channels: {
    signal: {
      aliases: {
        me: "+15557654321",
        jane: "uuid:123e4567-e89b-12d3-a456-426614174000",
        ops: "group:<groupId>",
      },
      defaultTo: "signal:me",
    },
  },
}
```

Use aliases anywhere Signal delivery targets are accepted:

```bash
openclaw message send --channel signal --target signal:ops --message "Deployment is complete"
```

Per-account aliases inherit the top-level aliases and can add or override names:

```json5
{
  channels: {
    signal: {
      aliases: {
        me: "+15557654321",
      },
      accounts: {
        work: {
          aliases: {
            ops: "group:<workGroupId>",
          },
        },
      },
    },
  },
}
```

`openclaw directory peers list --channel signal` and `openclaw directory groups list --channel signal` list configured aliases. The Signal directory is config-backed; it does not live-query Signal contacts or mutate the Signal account.

## Troubleshooting

Run this ladder first:

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

Then confirm DM pairing state if needed:

```bash
openclaw pairing list signal
```

Common failures:

- Daemon reachable but no replies: verify account/daemon settings (`httpUrl`, `account`) and receive mode.
- DMs ignored: sender is pending pairing approval.
- Group messages ignored: group sender/mention gating blocks delivery.
- Config validation errors after edits: run `openclaw doctor --fix`.
- Signal missing from diagnostics: confirm `channels.signal.enabled: true`.

Extra checks:

```bash
openclaw pairing list signal
pgrep -af signal-cli
grep -i "signal" "/tmp/openclaw/openclaw-$(date +%Y-%m-%d).log" | tail -20
```

For triage flow: [Channels Troubleshooting](/channels/troubleshooting).

## Security notes

- `signal-cli` stores account keys locally (typically `~/.local/share/signal-cli/data/`).
- Back up Signal account state before server migration or rebuild.
- Keep `channels.signal.dmPolicy: "pairing"` unless you explicitly want broader DM access.
- SMS verification is only needed for registration or recovery flows, but losing control of the number/account can complicate re-registration.

## Configuration reference (Signal)

Full configuration: [Configuration](/gateway/configuration)

Provider options:

- `channels.signal.enabled`: enable/disable channel startup.
- `channels.signal.apiMode`: `auto | native | container` (default: auto). See [Container mode](#container-mode-bbernhardsignal-cli-rest-api).
- `channels.signal.account`: E.164 for the bot account.
- `channels.signal.accountUuid`: optional bot account UUID for native @mention detection and loop protection.
- `channels.signal.cliPath`: path to `signal-cli`.
- `channels.signal.configPath`: optional `signal-cli --config` directory.
- `channels.signal.httpUrl`: full daemon URL (overrides host/port).
- `channels.signal.httpHost`, `channels.signal.httpPort`: daemon bind (default `127.0.0.1:8080`).
- `channels.signal.autoStart`: auto-spawn daemon (default true if `httpUrl` unset).
- `channels.signal.startupTimeoutMs`: startup wait timeout in ms (min 1000, cap 120000; default 30000).
- `channels.signal.receiveMode`: `on-start | manual`.
- `channels.signal.ignoreAttachments`: skip attachment downloads.
- `channels.signal.ignoreStories`: ignore stories from the daemon.
- `channels.signal.sendReadReceipts`: forward read receipts.
- `channels.signal.dmPolicy`: `pairing | allowlist | open | disabled` (default: pairing).
- `channels.signal.allowFrom`: DM allowlist (E.164 or `uuid:<id>`). `open` requires `"*"`. Signal has no usernames; use phone/UUID IDs.
- `channels.signal.aliases`: OpenClaw-side aliases for DM or group delivery targets.
- `channels.signal.groupPolicy`: `open | allowlist | disabled` (default: allowlist).
- `channels.signal.groupAllowFrom`: group allowlist; accepts Signal group IDs (raw, `group:<id>`, or `signal:group:<id>`), sender E.164 numbers, or `uuid:<id>` values.
- `channels.signal.groups`: per-group overrides keyed by Signal group ID (or `"*"`). Supported fields: `requireMention`, `tools`, `toolsBySender`.
- `channels.signal.accounts.<id>.groups`: per-account version of `channels.signal.groups` for multi-account setups.
- `channels.signal.accounts.<id>.aliases`: per-account aliases, merged with top-level aliases.
- `channels.signal.replyToMode`: native reply quote mode, `off | first | all | batched` (default: `all`).
- `channels.signal.replyToModeByChatType.direct`, `channels.signal.replyToModeByChatType.group`: per-chat-type native reply quote overrides.
- `channels.signal.accounts.<id>.replyToMode`, `channels.signal.accounts.<id>.replyToModeByChatType.direct`, `channels.signal.accounts.<id>.replyToModeByChatType.group`: per-account reply quote overrides.
- `channels.signal.historyLimit`: max group messages to include as context (0 disables).
- `channels.signal.dmHistoryLimit`: DM history limit in user turns. Per-user overrides: `channels.signal.dms["<phone_or_uuid>"].historyLimit`.
- `channels.signal.textChunkLimit`: outbound chunk size in characters (default 4000).
- `channels.signal.streaming.chunkMode`: `length` (default) or `newline` to split on blank lines (paragraph boundaries) before length chunking.
- `channels.signal.mediaMaxMb`: inbound/outbound media cap in MB (default 8).
- `channels.signal.reactionLevel`: `off | ack | minimal | extensive` (default `minimal`). See [Reactions](#reactions-message-tool).
- `channels.signal.reactionNotifications`: `off | own | all | allowlist` (default `own`) - when the agent is notified of incoming reactions from others.
- `channels.signal.reactionAllowlist`: senders whose reactions notify the agent when `reactionNotifications: "allowlist"`.
- `channels.signal.streaming.block.enabled`, `channels.signal.streaming.block.coalesce`: block-mode streaming controls shared across channels. See [Streaming](/concepts/streaming).

Related global options:

- `agents.list[].groupChat.mentionPatterns` (plain-text fallback; Signal native @mentions are detected from structured metadata when the bot account identity is configured).
- `messages.groupChat.mentionPatterns` (global fallback).
- `messages.responsePrefix`.

## Related

- [Channels Overview](/channels) - all supported channels
- [Pairing](/channels/pairing) - DM authentication and pairing flow
- [Groups](/channels/groups) - group chat behavior and mention gating
- [Channel Routing](/channels/channel-routing) - session routing for messages
- [Security](/gateway/security) - access model and hardening
