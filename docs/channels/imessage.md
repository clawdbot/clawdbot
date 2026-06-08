---
summary: "Native iMessage support via imsg (JSON-RPC over stdio), with private API actions for replies, tapbacks, effects, attachments, and group management. Preferred for new OpenClaw iMessage setups when host requirements fit."
read_when:
  - Setting up iMessage support
  - Debugging iMessage send/receive
title: "iMessage"
---

<Note>
For OpenClaw iMessage deployments, use `imsg` on a signed-in macOS Messages host. If your Gateway runs on Linux or Windows, point `channels.imessage.cliPath` at an SSH wrapper that runs `imsg` on the Mac.

**Inbound recovery is automatic.** After a bridge or gateway restart, iMessage replays the messages missed while it was down and suppresses the stale "backlog bomb" Apple can flush after a Push recovery, deduping so nothing is dispatched twice. There is no config to enable — see [Inbound recovery after a bridge or gateway restart](#inbound-recovery-after-a-bridge-or-gateway-restart).
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

<Warning>
Any `cliPath` wrapper or SSH proxy you put in front of `imsg` MUST behave like a transparent stdio pipe for long-lived JSON-RPC. OpenClaw exchanges small newline-framed JSON-RPC messages over the wrapper's stdin/stdout for the lifetime of the channel:

- Forward each stdin chunk/line **as soon as bytes are available** — don't wait for EOF.
- Forward each stdout chunk/line promptly in the reverse direction.
- Preserve newlines.
- Avoid fixed-size blocking reads (`read(4096)`, `cat | buffer`, default shell `read`) that can starve small frames.
- Keep stderr separate from the JSON-RPC stdout stream.

A wrapper that buffers stdin until a large block fills will produce symptoms that look like an iMessage outage — `imsg rpc timeout (chats.list)` or repeated channel restarts — even though `imsg rpc` itself is healthy. `ssh -T host imsg "$@"` (above) is safe because it forwards OpenClaw's `cliPath` arguments such as `rpc` and `--db`. Pipelines like `ssh host imsg | grep -v '^DEBUG'` are NOT — line-buffered tools can still hold frames; use `stdbuf -oL -eL` on every stage if you must filter.
</Warning>

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

<Accordion title="SSH wrapper sends fail with AppleEvents -1743">
  A remote-SSH setup can read chats, pass `channels status --probe`, and process inbound messages while outbound sends still fail with an AppleEvents authorization error:

```text
Not authorized to send Apple events to Messages. (-1743)
```

Check the signed-in Mac user's TCC database or System Settings > Privacy & Security > Automation. If the Automation entry is recorded for `/usr/libexec/sshd-keygen-wrapper` instead of the `imsg` or local shell process, macOS may not expose a usable Messages toggle for that SSH server-side client:

```text
kTCCServiceAppleEvents | /usr/libexec/sshd-keygen-wrapper | auth_value=0 | com.apple.MobileSMS
```

In that state, repeating `tccutil reset AppleEvents` or rerunning `imsg send` through the same SSH wrapper may keep failing because the process context that needs Messages Automation is the SSH wrapper, not an app the UI can grant.

Use one of the supported `imsg` process contexts instead:

- Run the Gateway, or at least the `imsg` bridge, in the logged-in Messages user's local session.
- Start the Gateway with a LaunchAgent for that user after granting Full Disk Access and Automation from the same session.
- If you keep the two-user SSH topology, verify that a real outbound `imsg send` succeeds through the exact wrapper before enabling the channel. If it cannot be granted Automation, reconfigure to a single-user `imsg` setup instead of relying on the SSH wrapper for sends.

</Accordion>

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

2. **Disable System Integrity Protection, and (on modern macOS) Library Validation.** Injecting a non-Apple helper dylib into the Apple-signed `Messages.app` needs SIP off **and** library validation relaxed. The Recovery-mode SIP step is macOS-version-specific:
   - **macOS 10.13-10.15 (Sierra-Catalina):** disable Library Validation via Terminal, reboot to Recovery Mode, run `csrutil disable`, restart.
   - **macOS 11+ (Big Sur and later), Intel:** Recovery Mode (or Internet Recovery), `csrutil disable`, restart.
   - **macOS 11+, Apple Silicon:** power-button startup sequence to enter Recovery; on recent macOS versions hold the **Left Shift** key when you click Continue, then `csrutil disable`. Virtual-machine setups follow a separate flow, so take a VM snapshot first.

   **On macOS 11 and later, `csrutil disable` alone is usually not enough.** Apple still enforces library validation against `Messages.app` as a platform binary, so an adhoc-signed helper is rejected (`Library Validation failed: ... platform binary, but mapped file is not`) even with SIP off. After disabling SIP, also disable library validation and reboot:

   ```bash
   sudo defaults write /Library/Preferences/com.apple.security.libraryvalidation.plist DisableLibraryValidation -bool true
   ```

   **macOS 26 (Tahoe), verified on 26.5.1:** SIP off **plus** the `DisableLibraryValidation` command above is sufficient to inject the helper across 26.0 through 26.5.x. **No boot-args are required.** The plist is the decisive factor and the most common missing step when injection fails on Tahoe:
   - **With the plist:** `imsg launch` injects and `imsg status` reports `advanced_features: true`.
   - **Without the plist (even with SIP off):** `imsg launch` fails with `Failed to launch: Timeout waiting for Messages.app to initialize`. AMFI rejects the adhoc helper at load, so the bridge never becomes ready and the launch times out. That timeout is the symptom most people hit on Tahoe, and the fix is the plist above, not anything more drastic.

   This was confirmed with a controlled before/after on macOS 26.5.1 (Apple Silicon): with the plist, the dylib maps into `Messages.app` and the bridge comes up; remove the plist and reboot, and `imsg launch` produces the timeout failure above with the dylib not mapped.

   If `imsg launch` injection or specific `selectors` start returning false after a macOS upgrade, this gate is the usual cause. Check your SIP and library-validation state before assuming the SIP step itself failed. If those settings are correct and the bridge still cannot inject, collect `imsg status --json` plus the `imsg launch` output and report it to the `imsg` project instead of weakening additional system-wide security controls.

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

  <Accordion title="Direct-message history">
    Set `channels.imessage.dmHistoryLimit` to seed new direct-message sessions with recent decoded `imsg` history for that conversation. Use `channels.imessage.dms["<sender>"].historyLimit` for per-sender overrides, including `0` to disable history for a sender.

    iMessage DM history is fetched on demand from `imsg`. Leaving `dmHistoryLimit` unset disables global DM history seeding, but a positive per-sender `channels.imessage.dms["<sender>"].historyLimit` still enables seeding for that sender.

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
    Inbound iMessage context includes both short `MessageSid` values and full message GUIDs when available. Short IDs are scoped to the recent SQLite-backed reply cache and are checked against the current chat before use. If a short ID has expired or belongs to another chat, retry with the full `MessageSidFull`.

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

  <Accordion title="Approval reactions (👍 / 👎)">
    When `approvals.exec.enabled` or `approvals.plugin.enabled` is true and the request routes to iMessage, the gateway delivers an approval prompt natively and accepts a tapback to resolve it:

    - `👍` (Like tapback) → `allow-once`
    - `👎` (Dislike tapback) → `deny`
    - `allow-always` remains a manual fallback: send `/approve <id> allow-always` as a regular reply.

    Reaction handling requires the reacting user's handle to be an explicit approver. The approver list is read from `channels.imessage.allowFrom` (or `channels.imessage.accounts.<id>.allowFrom`); add the user's phone number in E.164 form or their Apple ID email. The wildcard entry `"*"` is honored but allows any sender to approve. The reaction shortcut intentionally bypasses `reactionNotifications`, `dmPolicy`, and `groupAllowFrom` because the explicit-approver allowlist is the only gate that matters for approval resolution.

    **Behavior change with this release:** When `channels.imessage.allowFrom` is non-empty, the `/approve <id> <decision>` text command is now authorized against that approver list (not the broader DM allowlist). Senders permitted on the DM allowlist but not in `allowFrom` will receive an explicit denial. Add every operator who should be able to approve via `/approve` (and via reactions) to `allowFrom` to preserve the previous behavior. When `allowFrom` is empty the legacy "same-chat fallback" stays in effect and `/approve` continues to authorize anyone the DM allowlist permits.

    Operator notes:
    - The reaction binding is stored both in memory (with TTL matched to the approval expiry) and in the gateway's persistent keyed store, so a tapback that lands shortly after a gateway restart still resolves the approval.
    - Cross-device `is_from_me=true` tapbacks (the operator's own reaction on a paired Apple device) are intentionally ignored so the bot cannot self-approve.
    - Legacy text-style tapbacks (`Liked "…"` plain text from very old Apple clients) cannot resolve approvals because they carry no message GUID; reaction resolution requires the structured tapback metadata that current macOS / iOS clients emit.

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

`channels.imessage.coalesceSameSenderDms` opts a DM into buffering consecutive same-sender rows. When `imsg` exposes the structural URL-preview marker `balloon_bundle_id: "com.apple.messages.URLBalloonProvider"` on one of the source rows, OpenClaw merges only that real split-send and keeps any other buffered rows as separate turns. On older `imsg` builds that emit no balloon metadata at all, OpenClaw cannot tell a split-send from separate sends, so it falls back to merging the bucket. That preserves the pre-metadata behavior rather than regressing `Dump <url>` split-sends into two turns. Group chats continue to dispatch per-message so multi-user turn structure is preserved.

<Tabs>
  <Tab title="When to enable">
    Enable when:

    - You ship skills that expect `command + payload` in one message (dump, paste, save, queue, etc.).
    - Your users paste URLs alongside commands.
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
    - **Precise merging needs current `imsg` payload metadata.** When the URL row includes `balloon_bundle_id`, only that real split-send merges and other buffered rows stay separate. On older `imsg` builds that expose no balloon metadata, OpenClaw falls back to merging the buffered bucket so `Dump <url>` split-sends are not regressed into two turns (interim back-compat, removed once `imsg` coalesces split-sends upstream).
    - **Added latency for DM messages.** With the flag on, every DM (including standalone control commands and single-text follow-ups) waits up to the debounce window before dispatching, in case a URL-preview row is coming. Group-chat messages keep instant dispatch.
    - **Merged output is bounded.** Merged text caps at 4000 chars with an explicit `…[truncated]` marker; attachments cap at 20; source entries cap at 10 (first-plus-latest retained beyond that). Every source GUID is tracked in `coalescedMessageGuids` for downstream telemetry.
    - **DM-only.** Group chats fall through to per-message dispatch so the bot stays responsive when multiple people are typing.
    - **Opt-in, per-channel.** Other channels (Telegram, WhatsApp, Slack, …) are unaffected. Legacy BlueBubbles configs that set `channels.bluebubbles.coalesceSameSenderDms` should migrate that value to `channels.imessage.coalesceSameSenderDms`.

  </Tab>
</Tabs>

### Scenarios and what the agent sees

The "Flag on" column shows behavior on an `imsg` build that emits `balloon_bundle_id`. On older `imsg` builds that emit no balloon metadata at all, the rows below marked "Two turns" / "N turns" instead fall back to a legacy merge (one turn): OpenClaw cannot structurally tell a split-send from separate sends, so it preserves the pre-metadata merge. Precise separation activates once the build emits balloon metadata.

| User composes                                                      | `chat.db` produces                  | Flag off (default)                      | Flag on + window (imsg emits balloon metadata)   |
| ------------------------------------------------------------------ | ----------------------------------- | --------------------------------------- | ------------------------------------------------ |
| `Dump https://example.com` (one send)                              | 2 rows ~1 s apart                   | Two agent turns: "Dump" alone, then URL | One turn: merged text `Dump https://example.com` |
| `Save this 📎image.jpg caption` (attachment + text)                | 2 rows without URL balloon metadata | Two turns                               | Two turns (legacy merge on metadata-less builds) |
| `/status` (standalone command)                                     | 1 row                               | Instant dispatch                        | **Wait up to window, then dispatch**             |
| URL pasted alone                                                   | 1 row                               | Instant dispatch                        | Wait up to window, then dispatch                 |
| Text + URL sent as two deliberate separate messages, minutes apart | 2 rows outside window               | Two turns                               | Two turns (window expires between them)          |
| Rapid flood (>10 small DMs inside window)                          | N rows without URL balloon metadata | N turns                                 | N turns (legacy merge on metadata-less builds)   |
| Two people typing in a group chat                                  | N rows from M senders               | M+ turns (one per sender bucket)        | M+ turns — group chats are not coalesced         |

## Inbound recovery after a bridge or gateway restart

iMessage recovers messages missed while the gateway was down, and at the same time suppresses the stale "backlog bomb" Apple can flush after a Push recovery. The default behavior is always on, built on the inbound dedupe.

- **Replay dedupe.** Every dispatched inbound message is recorded by its Apple GUID in persistent plugin state (`imessage.inbound-dedupe`), claimed at ingestion and committed after handling (released on a transient failure so it can retry). Anything already handled is dropped instead of dispatched twice. This is what lets recovery replay aggressively without per-message bookkeeping.
- **Downtime recovery.** On startup the monitor remembers the last dispatched `chat.db` rowid (a persisted per-account cursor) and passes it to `imsg watch.subscribe` as `since_rowid`, so imsg replays the rows that landed while the gateway was down, then tails live. Replay is bounded to the most recent rows and to messages up to ~2 hours old, and the dedupe drops anything already handled.
- **Stale-backlog age fence.** Rows above the startup boundary are genuinely live; one whose send date is more than ~15 minutes older than its arrival is the Push-flush backlog and is suppressed. Replayed rows (at or below the boundary) use the wider recovery window instead, so a recently-missed message is delivered while ancient history is not.

Recovery works over both local and remote `cliPath` setups, because `since_rowid` replay runs over the same `imsg` RPC connection. The difference is the window: when the gateway can read `chat.db` (local), it anchors the startup rowid boundary, caps the replay span, and delivers missed messages up to a couple of hours old. Over a remote SSH `cliPath` it cannot read the database, so the replay is uncapped and every row uses the live age fence — it still recovers recently-missed messages and still suppresses old backlog, just with the narrower live window. Run the gateway on the Messages Mac for the wider recovery window.

### Operator-visible signal

Suppressed backlog is logged at the default level, never silently dropped (the `recovery` flag shows which window applied):

```
imessage: suppressed stale inbound backlog account=<id> sent=<iso> recovery=<bool> (<N> suppressed since start)
```

### Migration

`channels.imessage.catchup.*` is deprecated — downtime recovery is now automatic and needs no config for new setups. Existing configs with `catchup.enabled: true` remain honored as a compatibility profile for the recovery replay window. Disabled catchup blocks (`enabled: false` or no `enabled: true`) are retired; `openclaw doctor --fix` removes those.

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
