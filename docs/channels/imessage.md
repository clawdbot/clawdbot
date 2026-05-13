---
summary: "Native iMessage support via imsg (JSON-RPC over stdio), with private API actions for replies, tapbacks, effects, attachments, and group management. Preferred for new OpenClaw iMessage setups when host requirements fit."
read_when:
  - Setting up iMessage support
  - Debugging iMessage send/receive
title: "iMessage"
---

<Note>
For OpenClaw iMessage deployments, use `imsg` on a signed-in macOS Messages host. If your Gateway runs on Linux or Windows, point `channels.imessage.cliPath` at an SSH wrapper that runs `imsg` on the Mac.

**Gateway-downtime catchup is opt-in.** When enabled (`channels.imessage.catchup.enabled: true`), the gateway replays inbound messages that landed in `chat.db` while it was offline (crash, restart, Mac sleep) on next startup. Disabled by default — see [Catching up after gateway downtime](#catching-up-after-gateway-downtime). Closes [openclaw#78649](https://github.com/openclaw/openclaw/issues/78649).
</Note>

<Warning>
BlueBubbles support was removed. Migrate `channels.bluebubbles` configs to `channels.imessage`; OpenClaw supports iMessage through `imsg` only. Start with [BlueBubbles removal and the imsg iMessage path](/announcements/bluebubbles-imessage) for the short announcement, or [Coming from BlueBubbles](/channels/imessage-from-bluebubbles) for the full migration table.
</Warning>

Status: native external CLI integration. Gateway spawns `imsg rpc` and communicates over JSON-RPC on stdio (no separate daemon/port). Advanced actions require `imsg launch` and a successful private API probe.

<CardGroup cols={3}>
  <Card title="Private API actions" icon="wand-sparkles" href="#private-api-actions">
    Replies, tapbacks, effects, attachments, and group management.
  </Card>
  <Card title="Pairing" icon="link" href="/channels/pairing">
    iMessage DMs default to pairing mode.
  </Card>
  <Card title="Remote Mac" icon="terminal" href="#remote-mac-over-ssh">
    Use an SSH wrapper when the Gateway is not running on the Messages Mac.
  </Card>
  <Card title="Configuration reference" icon="settings" href="/gateway/config-channels#imessage">
    Full iMessage field reference.
  </Card>
</CardGroup>

## Quick setup

<Tabs>
  <Tab title="Local Mac (fast path)">
    <Steps>
      <Step title="Install and verify imsg">

```bash
brew install steipete/tap/imsg
imsg rpc --help
imsg launch
openclaw channels status --probe
```

      </Step>

      <Step title="Configure OpenClaw">

```json5
{
  channels: {
    imessage: {
      enabled: true,
      cliPath: "/usr/local/bin/imsg",
      dbPath: "/Users/user/Library/Messages/chat.db",
    },
  },
}
```

      </Step>

      <Step title="Start gateway">

```bash
openclaw gateway
```

      </Step>

      <Step title="Approve first DM pairing (default dmPolicy)">

```bash
openclaw pairing list imessage
openclaw pairing approve imessage <CODE>
```

        Pairing requests expire after 1 hour.
      </Step>
    </Steps>

  </Tab>

  <Tab title="Remote Mac over SSH">
    OpenClaw only requires a stdio-compatible `cliPath`, so you can point `cliPath` at a wrapper script that SSHes to a remote Mac and runs `imsg`.

```bash
#!/usr/bin/env bash
exec ssh -T gateway-host imsg "$@"
```

    Recommended config when attachments are enabled:

```json5
{
  channels: {
    imessage: {
      enabled: true,
      cliPath: "~/.openclaw/scripts/imsg-ssh",
      remoteHost: "user@gateway-host", // used for SCP attachment fetches
      includeAttachments: true,
      // Optional: override allowed attachment roots.
      // Defaults include /Users/*/Library/Messages/Attachments
      attachmentRoots: ["/Users/*/Library/Messages/Attachments"],
      remoteAttachmentRoots: ["/Users/*/Library/Messages/Attachments"],
    },
  },
}
```

    If `remoteHost` is not set, OpenClaw attempts to auto-detect it by parsing the SSH wrapper script.
    `remoteHost` must be `host` or `user@host` (no spaces or SSH options).
    OpenClaw uses strict host-key checking for SCP, so the relay host key must already exist in `~/.ssh/known_hosts`.
    Attachment paths are validated against allowed roots (`attachmentRoots` / `remoteAttachmentRoots`).

  </Tab>
</Tabs>

## Requirements and permissions (macOS)

- Messages must be signed in on the Mac running `imsg`.
- Full Disk Access is required for the process context running OpenClaw/`imsg` (Messages DB access).
- Automation permission is required to send messages through Messages.app.
- For advanced actions (react / edit / unsend / threaded reply / effects / group ops), System Integrity Protection must be disabled — see [Enabling the imsg private API](#enabling-the-imsg-private-api) below. Basic text and media send/receive work without it.

<Tip>
Permissions are granted per process context. If gateway runs headless (LaunchAgent/SSH), run a one-time interactive command in that same context to trigger prompts:

```bash
imsg chats --limit 1
# or
imsg send <handle> "test"
```

</Tip>

## Enabling the imsg private API

`imsg` ships in two operational modes:

- **Basic mode** (default, no SIP changes needed): outbound text and media via `send`, inbound watch/history, chat list. This is what you get out of the box from a fresh `brew install steipete/tap/imsg` plus the standard macOS permissions above.
- **Private API mode**: `imsg` injects a helper dylib into `Messages.app` to call internal `IMCore` functions. This is what unlocks `react`, `edit`, `unsend`, `reply` (threaded), `sendWithEffect`, `renameGroup`, `setGroupIcon`, `addParticipant`, `removeParticipant`, `leaveGroup`, plus typing indicators and read receipts.

To reach the advanced action surface that this channel page documents, you need Private API mode. The `imsg` README is explicit about the requirement:

> Advanced features such as `read`, `typing`, `launch`, bridge-backed rich send, message mutation, and chat management are opt-in. They require SIP to be disabled and a helper dylib to be injected into `Messages.app`. `imsg launch` refuses to inject when SIP is enabled.

The helper-injection technique uses `imsg`'s own dylib to reach Messages private APIs. There is no third-party server or BlueBubbles runtime in the OpenClaw iMessage path.

<Warning>
**Disabling SIP is a real security tradeoff.** SIP is one of macOS's core protections against running modified system code; turning it off system-wide opens up additional attack surface and side effects. Notably, **disabling SIP on Apple Silicon Macs also disables the ability to install and run iOS apps on your Mac**.

Treat this as a deliberate operational choice, not a default. If your threat model can't tolerate SIP being off, bundled iMessage is limited to basic mode — text and media send/receive only, no reactions / edit / unsend / effects / group ops.
</Warning>

### Setup

1. **Install (or upgrade) `imsg`** on the Mac that runs Messages.app:

   ```bash
   brew install steipete/tap/imsg
   imsg --version
   imsg status --json
   ```

   The `imsg status --json` output reports `bridge_version`, `rpc_methods`, and per-method `selectors` so you can see what the current build supports before you start.

2. **Disable System Integrity Protection.** This is macOS-version-specific because the underlying Apple requirement depends on the OS and hardware:
   - **macOS 10.13–10.15 (Sierra–Catalina):** disable Library Validation via Terminal, reboot to Recovery Mode, run `csrutil disable`, restart.
   - **macOS 11+ (Big Sur and later), Intel:** Recovery Mode (or Internet Recovery), `csrutil disable`, restart.
   - **macOS 11+, Apple Silicon:** power-button startup sequence to enter Recovery; on recent macOS versions hold the **Left Shift** key when you click Continue, then `csrutil disable`. Virtual-machine setups follow a separate flow — take a VM snapshot first.
   - **macOS 26 / Tahoe:** library-validation policies and `imagent` private-entitlement checks have tightened further; `imsg` may need an updated build to keep up. If `imsg launch` injection or specific `selectors` start returning false after a macOS major upgrade, check `imsg`'s release notes before assuming the SIP step succeeded.

   Follow Apple's Recovery-mode flow for your Mac to disable SIP before running `imsg launch`.

3. **Inject the helper.** With SIP disabled and Messages.app signed in:

   ```bash
   imsg launch
   ```

   `imsg launch` refuses to inject when SIP is still enabled, so this also doubles as a confirmation that step 2 took.

4. **Verify the bridge from OpenClaw:**

   ```bash
   openclaw channels status --probe
   ```

   The iMessage entry should report `works`, and `imsg status --json | jq '.selectors'` should show `retractMessagePart: true` plus whichever edit / typing / read selectors your macOS build exposes. The OpenClaw plugin per-method gating in `actions.ts` only advertises actions whose underlying selector is `true`, so the action surface you see in the agent's tool list reflects what the bridge can actually do on this host.

If `openclaw channels status --probe` reports the channel as `works` but specific actions throw "iMessage `<action>` requires the imsg private API bridge" at dispatch time, run `imsg launch` again — the helper can fall out (Messages.app restart, OS update, etc.) and the cached `available: true` status will keep advertising actions until the next probe refreshes.

### When you can't disable SIP

If SIP-disabled isn't acceptable for your threat model:

- `imsg` falls back to basic mode — text + media + receive only.
- The OpenClaw plugin still advertises text/media send and inbound monitoring; it just hides `react`, `edit`, `unsend`, `reply`, `sendWithEffect`, and group ops from the action surface (per the per-method capability gate).
- You can run a separate non-Apple-Silicon Mac (or a dedicated bot Mac) with SIP off for the iMessage workload, while keeping SIP enabled on your primary devices. See [Dedicated bot macOS user (separate iMessage identity)](#deployment-patterns) below.

## Access control and routing

<Tabs>
  <Tab title="DM policy">
    `channels.imessage.dmPolicy` controls direct messages:

    - `pairing` (default)
    - `allowlist`
    - `open` (requires `allowFrom` to include `"*"`)
    - `disabled`

    Allowlist field: `channels.imessage.allowFrom`.

    Allowlist entries must identify senders: handles or static sender access groups (`accessGroup:<name>`). Use `channels.imessage.groupAllowFrom` for chat targets such as `chat_id:*`, `chat_guid:*`, or `chat_identifier:*`; use `channels.imessage.groups` for numeric `chat_id` registry keys.

  </Tab>

  <Tab title="Group policy + mentions">
    `channels.imessage.groupPolicy` controls group handling:

    - `allowlist` (default when configured)
    - `open`
    - `disabled`

    Group sender allowlist: `channels.imessage.groupAllowFrom`.

    `groupAllowFrom` entries can also reference static sender access groups (`accessGroup:<name>`).

    Runtime fallback: if `groupAllowFrom` is unset, iMessage group sender checks use `allowFrom`; set `groupAllowFrom` when DM and group admission should differ.
    Runtime note: if `channels.imessage` is completely missing, runtime falls back to `groupPolicy="allowlist"` and logs a warning (even if `channels.defaults.groupPolicy` is set).

    <Warning>
    Group routing has **two** allowlist gates running back-to-back, and both must pass:

    1. **Sender / chat-target allowlist** (`channels.imessage.groupAllowFrom`) — handle, `chat_guid`, `chat_identifier`, or `chat_id`.
    2. **Group registry** (`channels.imessage.groups`) — with `groupPolicy: "allowlist"`, this gate requires either a `groups: { "*": { ... } }` wildcard entry (sets `allowAll = true`), or an explicit per-`chat_id` entry under `groups`.

    If gate 2 has nothing in it, every group message is dropped. The plugin emits two `warn`-level signals at the default log level:

    - one-time per account at startup: `imessage: groupPolicy="allowlist" but channels.imessage.groups is empty for account "<id>"`
    - one-time per `chat_id` at runtime: `imessage: dropping group message from chat_id=<id> ...`

    DMs continue to work because they take a different code path.

    Minimum config to keep groups flowing under `groupPolicy: "allowlist"`:

    ```json5
    {
      channels: {
        imessage: {
          groupPolicy: "allowlist",
          groupAllowFrom: ["+15555550123"],
          groups: { "*": { "requireMention": true } },
        },
      },
    }
    ```

    If those `warn` lines appear in the gateway log, gate 2 is dropping — add the `groups` block.
    </Warning>

    Mention gating for groups:

    - iMessage has no native mention metadata
    - mention detection uses regex patterns (`agents.list[].groupChat.mentionPatterns`, fallback `messages.groupChat.mentionPatterns`)
    - with no configured patterns, mention gating cannot be enforced

    Control commands from authorized senders can bypass mention gating in groups.

    Per-group `systemPrompt`:

    Each entry under `channels.imessage.groups.*` accepts an optional `systemPrompt` string. The value is injected into the agent's system prompt on every turn that handles a message in that group. Resolution mirrors the per-group prompt resolution used by `channels.whatsapp.groups`:

    1. **Group-specific system prompt** (`groups["<chat_id>"].systemPrompt`): used when the specific group entry exists in the map **and** its `systemPrompt` key is defined. If `systemPrompt` is an empty string (`""`) the wildcard is suppressed and no system prompt is applied to that group.
    2. **Group wildcard system prompt** (`groups["*"].systemPrompt`): used when the specific group entry is absent from the map entirely, or when it exists but defines no `systemPrompt` key.

    ```json5
    {
      channels: {
        imessage: {
          groupPolicy: "allowlist",
          groupAllowFrom: ["+15555550123"],
          groups: {
            "*": { systemPrompt: "Use British spelling." },
            "8421": {
              requireMention: true,
              systemPrompt: "This is the on-call rotation chat. Keep replies under 3 sentences.",
            },
            "9907": {
              // explicit suppression: the wildcard "Use British spelling." does not apply here
              systemPrompt: "",
            },
          },
        },
      },
    }
    ```

    Per-group prompts only apply to group messages — direct messages in this channel are unaffected.

  </Tab>

  <Tab title="Sessions and deterministic replies">
    - DMs use direct routing; groups use group routing.
    - With default `session.dmScope=main`, iMessage DMs collapse into the agent main session.
    - Group sessions are isolated (`agent:<agentId>:imessage:group:<chat_id>`).
    - Replies route back to iMessage using originating channel/target metadata.

    Group-ish thread behavior:

    Some multi-participant iMessage threads can arrive with `is_group=false`.
    If that `chat_id` is explicitly configured under `channels.imessage.groups`, OpenClaw treats it as group traffic (group gating + group session isolation).

  </Tab>
</Tabs>

## ACP conversation bindings

Legacy iMessage chats can also be bound to ACP sessions.

Fast operator flow:

- Run `/acp spawn codex --bind here` inside the DM or allowed group chat.
- Future messages in that same iMessage conversation route to the spawned ACP session.
- `/new` and `/reset` reset the same bound ACP session in place.
- `/acp close` closes the ACP session and removes the binding.

Configured persistent bindings are supported through top-level `bindings[]` entries with `type: "acp"` and `match.channel: "imessage"`.

`match.peer.id` can use:

- normalized DM handle such as `+15555550123` or `user@example.com`
- `chat_id:<id>` (recommended for stable group bindings)
- `chat_guid:<guid>`
- `chat_identifier:<identifier>`

Example:

```json5
{
  agents: {
    list: [
      {
        id: "codex",
        runtime: {
          type: "acp",
          acp: { agent: "codex", backend: "acpx", mode: "persistent" },
        },
      },
    ],
  },
  bindings: [
    {
      type: "acp",
      agentId: "codex",
      match: {
        channel: "imessage",
        accountId: "default",
        peer: { kind: "group", id: "chat_id:123" },
      },
      acp: { label: "codex-group" },
    },
  ],
}
```

See [ACP Agents](/tools/acp-agents) for shared ACP binding behavior.

## Deployment patterns

<AccordionGroup>
  <Accordion title="Dedicated bot macOS user (separate iMessage identity)">
    Use a dedicated Apple ID and macOS user so bot traffic is isolated from your personal Messages profile.

    Typical flow:

    1. Create/sign in a dedicated macOS user.
    2. Sign into Messages with the bot Apple ID in that user.
    3. Install `imsg` in that user.
    4. Create SSH wrapper so OpenClaw can run `imsg` in that user context.
    5. Point `channels.imessage.accounts.<id>.cliPath` and `.dbPath` to that user profile.

    First run may require GUI approvals (Automation + Full Disk Access) in that bot user session.

  </Accordion>

  <Accordion title="Remote Mac over Tailscale (example)">
    Common topology:

    - gateway runs on Linux/VM
    - iMessage + `imsg` runs on a Mac in your tailnet
    - `cliPath` wrapper uses SSH to run `imsg`
    - `remoteHost` enables SCP attachment fetches

    Example:

    ```json5
    {
      channels: {
        imessage: {
          enabled: true,
          cliPath: "~/.openclaw/scripts/imsg-ssh",
          remoteHost: "bot@mac-mini.tailnet-1234.ts.net",
          includeAttachments: true,
          dbPath: "/Users/bot/Library/Messages/chat.db",
        },
      },
    }
    ```

    ```bash
    #!/usr/bin/env bash
    exec ssh -T bot@mac-mini.tailnet-1234.ts.net imsg "$@"
    ```

    Use SSH keys so both SSH and SCP are non-interactive.
    Ensure the host key is trusted first (for example `ssh bot@mac-mini.tailnet-1234.ts.net`) so `known_hosts` is populated.

  </Accordion>

  <Accordion title="Multi-account pattern">
    iMessage supports per-account config under `channels.imessage.accounts`.

    Each account can override fields such as `cliPath`, `dbPath`, `allowFrom`, `groupPolicy`, `mediaMaxMb`, history settings, and attachment root allowlists.

  </Accordion>
</AccordionGroup>

## Media, chunking, and delivery targets

<AccordionGroup>
  <Accordion title="Attachments and media">
    - inbound attachment ingestion is **off by default** — set `channels.imessage.includeAttachments: true` to forward photos, voice memos, video, and other attachments to the agent. With it disabled, attachment-only iMessages are dropped before reaching the agent and may produce no `Inbound message` log line at all.
    - remote attachment paths can be fetched via SCP when `remoteHost` is set
    - attachment paths must match allowed roots:
      - `channels.imessage.attachmentRoots` (local)
      - `channels.imessage.remoteAttachmentRoots` (remote SCP mode)
      - default root pattern: `/Users/*/Library/Messages/Attachments`
    - SCP uses strict host-key checking (`StrictHostKeyChecking=yes`)
    - outbound media size uses `channels.imessage.mediaMaxMb` (default 16 MB)

  </Accordion>

  <Accordion title="Outbound chunking">
    - text chunk limit: `channels.imessage.textChunkLimit` (default 4000)
    - chunk mode: `channels.imessage.chunkMode`
      - `length` (default)
      - `newline` (paragraph-first splitting)

  </Accordion>

  <Accordion title="Addressing formats">
    Preferred explicit targets:

    - `chat_id:123` (recommended for stable routing)
    - `chat_guid:...`
    - `chat_identifier:...`

    Handle targets are also supported:

    - `imessage:+1555...`
    - `sms:+1555...`
    - `user@example.com`

    ```bash
    imsg chats --limit 20
    ```

  </Accordion>
</AccordionGroup>

## Private API actions

When `imsg launch` is running and `openclaw channels status --probe` reports `privateApi.available: true`, the message tool can use iMessage-native actions in addition to normal text sends.

```json5
{
  channels: {
    imessage: {
      actions: {
        reactions: true,
        edit: true,
        unsend: true,
        reply: true,
        sendWithEffect: true,
        sendAttachment: true,
        renameGroup: true,
        setGroupIcon: true,
        addParticipant: true,
        removeParticipant: true,
        leaveGroup: true,
      },
    },
  },
}
```

<AccordionGroup>
  <Accordion title="Available actions">
    - **react**: Add/remove iMessage tapbacks (`messageId`, `emoji`, `remove`). Supported tapbacks map to love, like, dislike, laugh, emphasize, and question.
    - **reply**: Send a threaded reply to an existing message (`messageId`, `text` or `message`, plus `chatGuid`, `chatId`, `chatIdentifier`, or `to`).
    - **sendWithEffect**: Send text with an iMessage effect (`text` or `message`, `effect` or `effectId`).
    - **edit**: Edit a sent message on supported macOS/private API versions (`messageId`, `text` or `newText`).
    - **unsend**: Retract a sent message on supported macOS/private API versions (`messageId`).
    - **upload-file**: Send media/files (`buffer` as base64 or a hydrated `media`/`path`/`filePath`, `filename`, optional `asVoice`). Legacy alias: `sendAttachment`.
    - **renameGroup**, **setGroupIcon**, **addParticipant**, **removeParticipant**, **leaveGroup**: Manage group chats when the current target is a group conversation.

  </Accordion>

  <Accordion title="Message IDs">
    Inbound iMessage context includes both short `MessageSid` values and full message GUIDs when available. Short IDs are scoped to the recent in-memory reply cache and are checked against the current chat before use. If a short ID has expired or belongs to another chat, retry with the full `MessageSidFull`.

  </Accordion>

  <Accordion title="Capability detection">
    OpenClaw hides private API actions only when the cached probe status says the bridge is unavailable. If the status is unknown, actions remain visible and dispatch probes lazily so the first action can succeed after `imsg launch` without a separate manual status refresh.

  </Accordion>

  <Accordion title="Read receipts and typing">
    When the private API bridge is up, accepted inbound chats are marked read before dispatch and a typing bubble is shown to the sender while the agent generates. Disable read-marking with:

    ```json5
    {
      channels: {
        imessage: {
          sendReadReceipts: false,
        },
      },
    }
    ```

    Older `imsg` builds that pre-date the per-method capability list will gate off typing/read silently; OpenClaw logs a one-time warning per restart so the missing receipt is attributable.

  </Accordion>

  <Accordion title="Inbound tapbacks">
    OpenClaw subscribes to iMessage tapbacks and routes accepted reactions as system events instead of normal message text, so a user tapback does not trigger an ordinary reply loop.

    Notification mode is controlled by `channels.imessage.reactionNotifications`:

    - `"own"` (default): notify only when users react to bot-authored messages.
    - `"all"`: notify for all inbound tapbacks from authorized senders.
    - `"off"`: ignore inbound tapbacks.

    Per-account overrides use `channels.imessage.accounts.<id>.reactionNotifications`.

  </Accordion>
</AccordionGroup>

## Config writes

iMessage allows channel-initiated config writes by default (for `/config set|unset` when `commands.config: true`).

Disable:

```json5
{
  channels: {
    imessage: {
      configWrites: false,
    },
  },
}
```

<a id="coalescing-split-send-dms-command--url-in-one-composition"></a>

## Coalescing split-send DMs (command + URL in one composition)

When a user types a command and a URL together — e.g. `Dump https://example.com/article` — Apple's Messages app splits the send into **two separate `chat.db` rows**:

1. A text message (`"Dump"`).
2. A URL-preview balloon (`"https://..."`) with OG-preview images as attachments.

The two rows arrive at OpenClaw ~0.8-2.0 s apart on most setups. Without coalescing, the agent receives the command alone on turn 1, replies (often "send me the URL"), and only sees the URL on turn 2 — at which point the command context is already lost. This is Apple's send pipeline, not anything OpenClaw or `imsg` introduces.

`channels.imessage.coalesceSameSenderDms` opts a DM into merging consecutive same-sender rows into a single agent turn. Group chats continue to dispatch per-message so multi-user turn structure is preserved.

<Tabs>
  <Tab title="When to enable">
    Enable when:

    - You ship skills that expect `command + payload` in one message (dump, paste, save, queue, etc.).
    - Your users paste URLs, images, or long content alongside commands.
    - You can accept the added DM turn latency (see below).

    Leave disabled when:

    - You need minimum command latency for single-word DM triggers.
    - All your flows are one-shot commands without payload follow-ups.

  </Tab>
  <Tab title="Enabling">
    ```json5
    {
      channels: {
        imessage: {
          coalesceSameSenderDms: true, // opt in (default: false)
        },
      },
    }
    ```

    With the flag on and no explicit `messages.inbound.byChannel.imessage`, the debounce window widens to **2500 ms** (the legacy default is 0 ms — no debouncing). The wider window is required because Apple's split-send cadence of 0.8-2.0 s does not fit in a tighter default.

    To tune the window yourself:

    ```json5
    {
      messages: {
        inbound: {
          byChannel: {
            // 2500 ms works for most setups; raise to 4000 ms if your Mac is
            // slow or under memory pressure (observed gap can stretch past 2 s
            // then).
            imessage: 2500,
          },
        },
      },
    }
    ```

  </Tab>
  <Tab title="Trade-offs">
    - **Added latency for DM messages.** With the flag on, every DM (including standalone control commands and single-text follow-ups) waits up to the debounce window before dispatching, in case a payload row is coming. Group-chat messages keep instant dispatch.
    - **Merged output is bounded.** Merged text caps at 4000 chars with an explicit `…[truncated]` marker; attachments cap at 20; source entries cap at 10 (first-plus-latest retained beyond that). Every source GUID is tracked in `coalescedMessageGuids` for downstream telemetry.
    - **DM-only.** Group chats fall through to per-message dispatch so the bot stays responsive when multiple people are typing.
    - **Opt-in, per-channel.** Other channels (Telegram, WhatsApp, Slack, …) are unaffected. Legacy BlueBubbles configs that set `channels.bluebubbles.coalesceSameSenderDms` should migrate that value to `channels.imessage.coalesceSameSenderDms`.

  </Tab>
</Tabs>

### Scenarios and what the agent sees

| User composes                                                      | `chat.db` produces    | Flag off (default)                      | Flag on + 2500 ms window                                                |
| ------------------------------------------------------------------ | --------------------- | --------------------------------------- | ----------------------------------------------------------------------- |
| `Dump https://example.com` (one send)                              | 2 rows ~1 s apart     | Two agent turns: "Dump" alone, then URL | One turn: merged text `Dump https://example.com`                        |
| `Save this 📎image.jpg caption` (attachment + text)                | 2 rows                | Two turns (attachment dropped on merge) | One turn: text + image preserved                                        |
| `/status` (standalone command)                                     | 1 row                 | Instant dispatch                        | **Wait up to window, then dispatch**                                    |
| URL pasted alone                                                   | 1 row                 | Instant dispatch                        | Instant dispatch (only one entry in bucket)                             |
| Text + URL sent as two deliberate separate messages, minutes apart | 2 rows outside window | Two turns                               | Two turns (window expires between them)                                 |
| Rapid flood (>10 small DMs inside window)                          | N rows                | N turns                                 | One turn, bounded output (first + latest, text/attachment caps applied) |
| Two people typing in a group chat                                  | N rows from M senders | M+ turns (one per sender bucket)        | M+ turns — group chats are not coalesced                                |

## Catching up after gateway downtime

When the gateway is offline (crash, restart, Mac sleep, machine off), `imsg watch` resumes from the current `chat.db` state once the gateway comes back up — anything that arrived during the gap is, by default, never seen. Catchup replays those messages on the next startup so the agent does not silently miss inbound traffic.

Catchup is **disabled by default**. Enable it per channel:

```ts
channels: {
  imessage: {
    catchup: {
      enabled: true,             // master switch (default: false)
      maxAgeMinutes: 120,        // skip rows older than now - 2h (default: 120, clamp 1..720)
      perRunLimit: 50,           // max rows replayed per startup (default: 50, clamp 1..500)
      firstRunLookbackMinutes: 30, // first run with no cursor: look back 30 min (default: 30)
      maxFailureRetries: 10,     // give up on a wedged guid after 10 dispatch failures (default: 10)
    },
  },
}
```

### How it runs

One pass per `monitorIMessageProvider` startup, sequenced as `imsg launch` ready → `watch.subscribe` → `performIMessageCatchup` → live dispatch loop. Catchup itself uses `chats.list` + per-chat `messages.history` against the same JSON-RPC client used by `imsg watch`. Anything that arrives during the catchup pass flows through live dispatch normally; the existing inbound-dedupe cache absorbs any overlap with replayed rows.

Each replayed row is fed through the live dispatch path (`evaluateIMessageInbound` + `dispatchInboundMessage`), so allowlists, group policy, debouncer, echo cache, and read receipts behave identically on replayed and live messages.

### Cursor and retry semantics

Catchup keeps a per-account cursor at `<openclawStateDir>/imessage/catchup/<account>__<hash>.json` (the OpenClaw state dir defaults to `~/.openclaw`, overridable with `OPENCLAW_STATE_DIR`):

```json
{
  "lastSeenMs": 1717900800000,
  "lastSeenRowid": 482910,
  "updatedAt": 1717900801234,
  "failureRetries": { "<guid>": 1 }
}
```

- The cursor advances on each successful dispatch and is held when a row's dispatch throws — the next startup retries the same row from the held cursor.
- After `maxFailureRetries` consecutive throws against the same `guid`, catchup logs a `warn` and force-advances the cursor past the wedged message so subsequent startups can make progress.
- Already-given-up guids are skipped on sight (no dispatch attempt) on later runs and counted under `skippedGivenUp` in the run summary.

### Operator-visible signals

```
imessage catchup: replayed=N skippedFromMe=… skippedGivenUp=… failed=… givenUp=… fetchedCount=…
imessage catchup: giving up on guid=<guid> after <N> failures; advancing cursor past it
imessage catchup: fetched <X> rows across chats, capped to perRunLimit=<Y>
```

A `WARN ... capped to perRunLimit` line means a single startup did not drain the full backlog. Raise `perRunLimit` (max 500) if your gaps regularly exceed the default 50-row pass.

### When to leave it off

- Gateway runs continuously with watchdog auto-restart and gaps are always < a few seconds — the default of off is fine.
- DM volume is low and missed messages would not change agent behavior — the `firstRunLookbackMinutes` initial window can dispatch surprising old context on first enable.

When you turn catchup on, the first startup with no cursor only looks back `firstRunLookbackMinutes` (30 min default), not the full `maxAgeMinutes` window — this avoids replaying a long history of pre-enable messages.

## Troubleshooting

<AccordionGroup>
  <Accordion title="imsg not found or RPC unsupported">
    Validate the binary and RPC support:

    ```bash
    imsg rpc --help
    imsg status --json
    openclaw channels status --probe
    ```

    If probe reports RPC unsupported, update `imsg`. If private API actions are unavailable, run `imsg launch` in the logged-in macOS user session and probe again. If the Gateway is not running on macOS, use the Remote Mac over SSH setup above instead of the default local `imsg` path.

  </Accordion>

  <Accordion title="Gateway is not running on macOS">
    The default `cliPath: "imsg"` must run on the Mac signed into Messages. On Linux or Windows, set `channels.imessage.cliPath` to a wrapper script that SSHes to that Mac and runs `imsg "$@"`.

```bash
#!/usr/bin/env bash
exec ssh -T messages-mac imsg "$@"
```

    Then run:

```bash
openclaw channels status --probe --channel imessage
```

  </Accordion>

  <Accordion title="DMs are ignored">
    Check:

    - `channels.imessage.dmPolicy`
    - `channels.imessage.allowFrom`
    - pairing approvals (`openclaw pairing list imessage`)

  </Accordion>

  <Accordion title="Group messages are ignored">
    Check:

    - `channels.imessage.groupPolicy`
    - `channels.imessage.groupAllowFrom`
    - `channels.imessage.groups` allowlist behavior
    - mention pattern configuration (`agents.list[].groupChat.mentionPatterns`)

  </Accordion>

  <Accordion title="Remote attachments fail">
    Check:

    - `channels.imessage.remoteHost`
    - `channels.imessage.remoteAttachmentRoots`
    - SSH/SCP key auth from the gateway host
    - host key exists in `~/.ssh/known_hosts` on the gateway host
    - remote path readability on the Mac running Messages

  </Accordion>

  <Accordion title="macOS permission prompts were missed">
    Re-run in an interactive GUI terminal in the same user/session context and approve prompts:

    ```bash
    imsg chats --limit 1
    imsg send <handle> "test"
    ```

    Confirm Full Disk Access + Automation are granted for the process context that runs OpenClaw/`imsg`.

  </Accordion>
</AccordionGroup>

## Configuration reference pointers

- [Configuration reference - iMessage](/gateway/config-channels#imessage)
- [Gateway configuration](/gateway/configuration)
- [Pairing](/channels/pairing)

## Related

- [Channels Overview](/channels) — all supported channels
- [BlueBubbles removal and the imsg iMessage path](/announcements/bluebubbles-imessage) — announcement and migration summary
- [Coming from BlueBubbles](/channels/imessage-from-bluebubbles) — config translation table and step-by-step cutover
- [Pairing](/channels/pairing) — DM authentication and pairing flow
- [Groups](/channels/groups) — group chat behavior and mention gating
- [Channel Routing](/channels/channel-routing) — session routing for messages
- [Security](/gateway/security) — access model and hardening
