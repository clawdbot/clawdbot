---
summary: "Native iMessage support via imsg (JSON-RPC over stdio), with private API actions for replies, tapbacks, effects, polls, attachments, and group management. Preferred for new OpenClaw iMessage setups when host requirements fit."
read_when:
  - Setting up iMessage support
  - Debugging iMessage send/receive
title: "iMessage"
---

<Note>
For the usual OpenClaw iMessage deployment, run the Gateway and `imsg` on the same signed-in macOS Messages host. If your Gateway runs elsewhere, point `channels.imessage.cliPath` at a transparent SSH wrapper that runs `imsg` on the Mac.

**Inbound recovery is automatic.** After a bridge or gateway restart, iMessage replays the messages missed while it was down and suppresses the stale "backlog bomb" Apple can flush after a Push recovery, deduping so nothing is dispatched twice. There is no config to enable — see [Inbound recovery after a bridge or gateway restart](#inbound-recovery-after-a-bridge-or-gateway-restart).
</Note>

<Warning>
BlueBubbles support was removed. Migrate `channels.bluebubbles` configs to `channels.imessage`; OpenClaw supports iMessage through `imsg` only. Start with [BlueBubbles removal and the imsg iMessage path](/announcements/bluebubbles-imessage) for the short announcement, or [Coming from BlueBubbles](/channels/imessage-from-bluebubbles) for the full migration table.
</Warning>

Status: native external CLI integration. The Gateway spawns `imsg rpc` and speaks JSON-RPC over stdio — no separate daemon or port. Private API mode is strongly encouraged for a complete iMessage channel; replies, tapbacks, effects, polls, attachment replies, and group actions require `imsg launch` and a successful private API probe.

For the common local setup, OpenClaw setup can offer a user-confirmed Homebrew install or update for `imsg` on the signed-in Messages Mac. Manual setup and SSH-wrapper topologies remain operator-managed: install or update `imsg` in the same user context that will run the Gateway or wrapper.

<CardGroup cols={3}>
  <Card title="Private API actions" icon="wand-sparkles" href="#private-api-actions">
    Replies, tapbacks, effects, polls, attachments, and group management.
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
brew update && brew upgrade imsg
imsg rpc --help
imsg launch
openclaw channels status --probe
```

        When the local setup wizard detects a missing default `imsg` command, it can prompt to install `steipete/tap/imsg` through Homebrew. If it detects a Homebrew-managed `imsg`, it can prompt to reinstall or update it. Custom `cliPath` wrappers are not modified.

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
    Most setups do not need SSH. Use this topology only when the Gateway cannot run on the signed-in Messages Mac. OpenClaw only requires a stdio-compatible `cliPath`, so you can point `cliPath` at a wrapper script that SSHes to a remote Mac and runs `imsg`.
    Install and update `imsg` on that remote Mac, not on the Gateway host:

```bash
ssh messages-mac 'brew install steipete/tap/imsg && brew update && brew upgrade imsg'
```

```bash
#!/usr/bin/env bash
exec ssh -T messages-mac imsg "$@"
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
      // Optional: extra allowed attachment roots (merged with the default
      // /Users/*/Library/Messages/Attachments).
      attachmentRoots: ["/Users/*/Library/Messages/Attachments"],
      remoteAttachmentRoots: ["/Users/*/Library/Messages/Attachments"],
    },
  },
}
```

    If `remoteHost` is not set, OpenClaw attempts to auto-detect it by parsing the SSH wrapper script.
    `remoteHost` must be `host` or `user@host` (no spaces or SSH options); unsafe values are ignored.
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
- For advanced actions (react / edit / unsend / threaded reply / effects / polls / group ops), System Integrity Protection must be disabled — see [Enabling the imsg private API](#enabling-the-imsg-private-api). Basic text and media send/receive work without it.

<Tip>
Permissions are granted per process context. If the gateway runs headless (LaunchAgent/SSH), run a one-time interactive command in that same context to trigger prompts:

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

`imsg` ships in two operational modes. For OpenClaw, Private API mode is the recommended setup because it gives the channel the native iMessage actions users expect. Basic mode remains useful for low-risk installs, initial verification, or hosts where SIP cannot be disabled.

- **Basic mode** (default, no SIP changes needed): outbound text and media via `send`, inbound watch/history, chat list. This is what you get out of the box from a fresh `brew install steipete/tap/imsg` plus the standard macOS permissions above.
- **Private API mode**: `imsg` injects a helper dylib into `Messages.app` to call internal `IMCore` functions. This unlocks `react`, `edit`, `unsend`, `reply` (threaded), `sendWithEffect`, `poll` and `poll-vote` (native Messages polls), `renameGroup`, `setGroupIcon`, `addParticipant`, `removeParticipant`, `leaveGroup`, plus typing indicators and read receipts.

The recommended action surface on this page requires Private API mode. The `imsg` README is explicit about the requirement:

> Advanced features such as `read`, `typing`, `launch`, bridge-backed rich send, message mutation, and chat management are opt-in. They require SIP to be disabled and a helper dylib to be injected into `Messages.app`. `imsg launch` refuses to inject when SIP is enabled.

The helper-injection technique uses `imsg`'s own dylib to reach Messages private APIs. There is no third-party server or BlueBubbles runtime in the OpenClaw iMessage path.

<Warning>
**Disabling SIP is a real security tradeoff.** SIP is one of macOS's core protections against running modified system code; turning it off system-wide opens up additional attack surface and side effects. Notably, **disabling SIP on Apple Silicon Macs also disables the ability to install and run iOS apps on your Mac**.

Treat this as a deliberate operational choice, especially on a primary personal Mac. For production-quality OpenClaw iMessage, prefer a dedicated Mac or bot macOS user where you are comfortable enabling the bridge. If your threat model cannot tolerate SIP being off anywhere, bundled iMessage is limited to basic mode — text and media send/receive only, no reactions / edit / unsend / effects / group ops.
</Warning>

### Setup

1. **Install (or upgrade) `imsg`** on the Mac that runs Messages.app:

   ```bash
   brew install steipete/tap/imsg
   brew update && brew upgrade imsg
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
   - **Without the plist (even with SIP off):** `imsg launch` fails with `Failed to launch: Timeout waiting for Messages.app to initialize`. AMFI rejects the adhoc helper at load, so the bridge never becomes ready and the launch times out. That timeout is the symptom most people hit on Tahoe; the fix is the plist above, not anything more drastic.

   If `imsg launch` injection or specific `selectors` start returning false after a macOS upgrade, this gate is the usual cause. Check your SIP and library-validation state before assuming the SIP step itself failed. If those settings are correct and the bridge still cannot inject, collect `imsg status --json` plus the `imsg launch` output and report it to the `imsg` project instead of weakening additional system-wide security controls.

3. **Inject the helper.** With SIP disabled and Messages.app signed in:

   ```bash
   imsg launch
   ```

   `imsg launch` refuses to inject when SIP is still enabled, so this also doubles as a confirmation that step 2 took.

4. **Verify the bridge from OpenClaw:**

   ```bash
   openclaw channels status --probe
   ```

   The iMessage entry should report `works`, and `imsg status --json | jq '{rpc_methods, selectors}'` should show the capabilities exposed by your macOS build. Poll creation requires `selectors.pollPayloadMessage`; voting requires both `selectors.pollVoteMessage` and the `poll.vote` RPC method. The OpenClaw plugin advertises only actions supported by the cached probe, while an empty cache stays optimistic and probes on first dispatch.

If `openclaw channels status --probe` reports the channel as `works` but specific actions throw "iMessage `<action>` requires the imsg private API bridge" at dispatch time, run `imsg launch` again — the helper can fall out (Messages.app restart, OS update, etc.) and the cached `available: true` status will keep advertising actions until the next probe refreshes.

### When SIP stays enabled

If disabling SIP is not acceptable for your threat model:

- `imsg` falls back to basic mode — text + media + receive only.
- The OpenClaw plugin still advertises text/media send and inbound monitoring; it hides `react`, `edit`, `unsend`, `reply`, `sendWithEffect`, and group ops from the action surface (per the per-method capability gate).
- You can run a separate non-Apple-Silicon Mac (or a dedicated bot Mac) with SIP off for the iMessage workload, while keeping SIP enabled on your primary devices. See [Dedicated bot macOS user (separate iMessage identity)](#deployment-patterns) below.

## Access control and routing

<Tabs>
  <Tab title="DM policy">
    `channels.imessage.dmPolicy` controls direct messages:

    - `pairing` (default)
    - `allowlist` (requires at least one `allowFrom` entry)
    - `open` (requires `allowFrom` to include `"*"`)
    - `disabled`

    Allowlist field: `channels.imessage.allowFrom`.

    Allowlist entries must identify senders: handles or static sender access groups (`accessGroup:<name>`). Use `channels.imessage.groupAllowFrom` for chat targets such as `chat_id:*`, `chat_guid:*`, or `chat_identifier:*`; use `channels.imessage.groups` for numeric `chat_id` registry keys.

  </Tab>

  <Tab title="Group policy + mentions">
    `channels.imessage.groupPolicy` controls group handling:

    - `allowlist` (default)
    - `open`
    - `disabled`

    Group sender allowlist: `channels.imessage.groupAllowFrom`.

    `groupAllowFrom` entries can also reference static sender access groups (`accessGroup:<name>`).

    Runtime fallback: if `groupAllowFrom` is unset, iMessage group sender checks use `allowFrom`; set `groupAllowFrom` when DM and group admission should differ. An explicitly empty `groupAllowFrom: []` does not fall back — it blocks all group senders under `allowlist`.
    Runtime note: if `channels.imessage` is completely missing, runtime falls back to `groupPolicy="allowlist"` and logs a warning (even if `channels.defaults.groupPolicy` is set).

    <Warning>
    Group routing under `groupPolicy: "allowlist"` runs **two** gates back-to-back:

    1. **Sender allowlist** (`channels.imessage.groupAllowFrom`) — handle, `accessGroup:<name>`, `chat_guid`, `chat_identifier`, or `chat_id`. An empty effective list (no `groupAllowFrom` and no `allowFrom` fallback) blocks every group sender.
    2. **Group registry** (`channels.imessage.groups`) — enforced once the map has entries: the chat must match an explicit per-`chat_id` entry or a `groups: { "*": { ... } }` wildcard. When `groups` is empty or missing, the sender allowlist alone decides admission.

    If no effective group sender allowlist is configured, every group message is dropped before the registry gate. Each gate has its own `warn`-level signal at the default log level, and each names a different fix:

    - one-time per account at startup, when the effective group sender allowlist is empty: `imessage: groupPolicy="allowlist" for account "<id>" but no group sender allowlist is configured ...` — fix by setting `channels.imessage.groupAllowFrom` (or `allowFrom`); adding `groups` entries alone leaves gate 1 blocking every sender.
    - one-time per `chat_id` at runtime, when a sender passed gate 1 but the chat is missing from a populated `groups` registry: `imessage: dropping group message from chat_id=<id> ...` — fix by adding that `chat_id` (or `"*"`) under `channels.imessage.groups`.

    DMs are unaffected — they take a different code path.

    Recommended config for group flow under `groupPolicy: "allowlist"`:

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

    `groupAllowFrom` alone admits those senders in any group; add the `groups` block to scope which chats are allowed (and to set per-chat options like `requireMention`).
    </Warning>

    Mention gating for groups:

    - iMessage has no native mention metadata
    - mention detection uses regex patterns (`agents.entries.*.groupChat.mentionPatterns`, fallback `messages.groupChat.mentionPatterns`)
    - with no configured patterns, mention gating cannot be enforced
    - control commands from authorized senders bypass mention gating

    Per-group `systemPrompt`:

    Each entry under `channels.imessage.groups.*` accepts an optional `systemPrompt` string, injected into the agent's system prompt on every turn that handles a message in that group. Resolution mirrors `channels.whatsapp.groups`:

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

    Per-group prompts only apply to group messages — direct messages are unaffected.

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

iMessage chats can be bound to ACP sessions.

Fast operator flow:

- Run `/acp spawn codex --bind here` inside the DM or allowed group chat.
- Future messages in that same iMessage conversation route to the spawned ACP session.
- `/new` and `/reset` reset the same bound ACP session in place.
- `/acp close` closes the ACP session and removes the binding.

Configured persistent bindings use top-level `bindings[]` entries with `type: "acp"` and `match.channel: "imessage"`.

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
    4. Create an SSH wrapper so OpenClaw can run `imsg` in that user context.
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
      - configured roots extend the default root pattern `/Users/*/Library/Messages/Attachments` (merged, not replaced)
    - SCP uses strict host-key checking (`StrictHostKeyChecking=yes`)
    - outbound media size uses `channels.imessage.mediaMaxMb` (default 16 MB)

  </Accordion>

  <Accordion title="Outbound text and chunking">
    - text chunk limit: `channels.imessage.textChunkLimit` (default 4000)
    - chunk mode: `channels.imessage.streaming.chunkMode`
      - `length` (default)
      - `newline` (paragraph-first splitting)
    - outbound markdown bold/italic/underline/strikethrough is converted to native styled text (macOS 15+ recipients render the styling; older recipients see plain text without the markers); markdown tables are converted per the channel markdown table mode
    - `channels.imessage.sendTransport` (`auto` default, `bridge`, `applescript`) selects how `imsg` delivers sends

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

All actions are enabled by default; use `channels.imessage.actions` to turn individual actions off:

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
        polls: true,
      },
    },
  },
}
```

<AccordionGroup>
  <Accordion title="Available actions">
    - **react**: Add/remove iMessage tapbacks (`messageId`, `emoji`, `remove`). Supported tapbacks map to love, like, dislike, laugh, emphasize, and question. Removing without an emoji clears whichever tapback was set.
    - **reply**: Send a threaded reply to an existing message (`messageId`, `text` or `message`, plus `chatGuid`, `chatId`, `chatIdentifier`, or `to`). Reply-with-attachment additionally needs an `imsg` build whose `send-rich` supports `--file`.
    - **sendWithEffect**: Send text with an iMessage effect (`text` or `message`, `effect` or `effectId`). Short names: slam, loud, gentle, invisibleink, confetti, lasers, fireworks, balloon, heart, echo, happybirthday, shootingstar, sparkles, spotlight.
    - **edit**: Edit a sent message on supported macOS/private API versions (`messageId`, `text` or `newText`). Only messages the gateway itself sent can be edited.
    - **unsend**: Retract a sent message on supported macOS/private API versions (`messageId`). Only messages the gateway itself sent can be unsent.
    - **upload-file**: Send media/files (`buffer` as base64 or a hydrated `media`/`path`/`filePath`, `filename`, optional `asVoice`). Legacy alias: `sendAttachment`.
    - **renameGroup**, **setGroupIcon**, **addParticipant**, **removeParticipant**, **leaveGroup**: Manage group chats when the current target is a group conversation. These mutate the host's Messages identity, so they require an owner sender or an `operator.admin` Gateway client.
    - **poll**: Create a native Apple Messages poll (`pollQuestion`, `pollOption` repeated 2 to 12 times, plus `chatGuid`, `chatId`, `chatIdentifier`, or `to`). Recipients on iOS/iPadOS/macOS 26+ see and vote on it natively; older OS versions get a "Sent a poll" text fallback. Requires `selectors.pollPayloadMessage`.
    - **poll-vote**: Vote on an existing poll (`pollId` or `messageId`, plus exactly one of `pollOptionIndex`, `pollOptionId`, or `pollOptionText`). Requires `selectors.pollVoteMessage` and the `poll.vote` RPC method.

    Accepted inbound polls are rendered for the agent with the question, numbered option labels, vote counts, and the poll message ID needed by `poll-vote`.

  </Accordion>

  <Accordion title="Message IDs">
    Inbound iMessage context includes both short `MessageSid` values and full message GUIDs (`MessageSidFull`) when available. Short IDs are scoped to the recent SQLite-backed reply cache and are checked against the current chat before use. If a short ID expires, retry with its `MessageSidFull` while targeting the conversation that supplied it. Full IDs do not bypass conversation or account binding, so replace an ID from another chat with one from the current target. Remote delegated calls can reject stale full IDs when current-conversation evidence is unavailable.

  </Accordion>

  <Accordion title="Capability detection">
    OpenClaw hides private API actions only when the cached probe status says the bridge is unavailable. If the status is unknown, actions remain visible and dispatch probes lazily so the first action can succeed after `imsg launch` without a separate manual status refresh.

  </Accordion>

  <Accordion title="Read receipts and typing">
    When the private API bridge is up, accepted inbound chats are marked read and direct chats show a typing bubble as soon as the turn is accepted, while the agent prepares context and generates. Disable read-marking with:

    ```json5
    {
      channels: {
        imessage: {
          sendReadReceipts: false,
        },
      },
    }
    ```

    Older `imsg` builds that pre-date the per-method capability list gate off typing/read silently; OpenClaw logs a one-time warning per restart so the missing receipt is attributable.

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

    Reaction handling requires the reacting user's handle to be an explicit approver. The approver list is read from `channels.imessage.allowFrom` (or `channels.imessage.accounts.<id>.allowFrom`); add the user's phone number in E.164 form or their Apple ID email (chat targets such as `chat_id:*` are not valid approver entries). The wildcard entry `"*"` is honored but allows any sender to approve; an empty approver list disables the reaction shortcut entirely. The reaction shortcut intentionally bypasses `reactionNotifications`, `dmPolicy`, and `groupAllowFrom` because the explicit-approver allowlist is the only gate that matters for approval resolution.

    `/approve` text command authorization follows the same list: when `channels.imessage.allowFrom` is non-empty, `/approve <id> <decision>` is authorized against that approver list (not the broader DM allowlist), and senders permitted on the DM allowlist but not in `allowFrom` receive an explicit denial. When `allowFrom` is empty, the same-chat fallback stays in effect and `/approve` authorizes anyone the DM allowlist permits. Add every operator who should approve — via `/approve` or via reactions — to `allowFrom`.

    Operator notes:
    - The reaction binding is stored both in memory and in the gateway's persistent keyed store (TTL matched to the approval expiry), and the gateway also polls pending prompts for tapbacks, so a tapback that lands shortly after a gateway restart still resolves the approval.
    - The operator's own `is_from_me=true` tapback (for example from a paired Apple device) resolves the approval when that handle is an explicit approver.
    - Approval prompts route into a group conversation only when explicit approvers are configured; otherwise any group member could approve.
    - Legacy text-style tapbacks (`Liked "…"` plain text from very old Apple clients) cannot resolve approvals because they carry no message GUID; reaction resolution requires the structured tapback metadata that current macOS / iOS clients emit.

  </Accordion>

  <Accordion title="Question reactions (1️⃣ / 2️⃣ / 3️⃣ / 4️⃣)">
    For an `ask_user` prompt with one non-secret, single-select question and one to four options, OpenClaw adds numbered emoji choices. React to the delivered prompt with the matching number to answer it. The reaction must carry the stable GUID of the bot-authored message; OpenClaw then maps the number to the canonical option through the Gateway. Stale or duplicate taps are ignored.

    Multi-question, multi-select, and free-text prompts remain text-reply-only. Question reactions follow normal iMessage DM/group admission rules. They are recognized even when general `reactionNotifications` is `"off"`, without turning unrelated reactions into agent events.

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

The two rows arrive at OpenClaw ~0.8-2.0 s apart on most setups. Without coalescing, the agent gets the command alone on turn 1 (and often replies "send me the URL") before the URL arrives on turn 2. This is Apple's send pipeline, not anything OpenClaw or `imsg` introduces.

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

    With the flag on and no explicit `messages.inbound.byChannel.imessage` or global `messages.inbound.debounceMs`, the debounce window widens to **7000 ms** (the legacy default is 0 ms — no debouncing). The wider window is required because Apple's URL-preview split-send cadence can stretch to several seconds while Messages.app emits the preview row.

    To tune the window yourself:

    ```json5
    {
      messages: {
        inbound: {
          byChannel: {
            // 7000 ms covers observed Messages.app URL-preview delays.
            imessage: 7000,
          },
        },
      },
    }
    ```

  </Tab>
  <Tab title="Trade-offs">
    - **Precise merging needs current `imsg` payload metadata.** With `balloon_bundle_id` present, only the real split-send merges; the metadata-less fallback merge described above is interim back-compat, removed once `imsg` coalesces split-sends upstream.
    - **Added latency for DM messages.** With the flag on, every DM (including standalone control commands and single-text follow-ups) waits up to the debounce window before dispatching, in case a URL-preview row is coming. Group-chat messages keep instant dispatch.
    - **Merged output is bounded.** Merged text caps at 4000 chars with an explicit `…[truncated]` marker; attachments cap at 20; source entries cap at 10 (first-plus-latest retained beyond that). Every source GUID is tracked in `coalescedMessageGuids` for downstream telemetry.
    - **DM-only.** Group chats fall through to per-message dispatch so the bot stays responsive when multiple people are typing.
    - **Opt-in, per-channel.** Other channels (Discord, Slack, Telegram, WhatsApp, …) are unaffected. Legacy BlueBubbles configs that set `channels.bluebubbles.coalesceSameSenderDms` should migrate that value to `channels.imessage.coalesceSameSenderDms`.

  </Tab>
</Tabs>

### Scenarios and what the agent sees

The "Flag on" column shows behavior on an `imsg` build that emits `balloon_bundle_id`. On older `imsg` builds that emit no balloon metadata at all, the rows below marked "Two turns" / "N turns" instead fall back to a legacy merge (one turn): OpenClaw cannot structurally tell a split-send from separate sends, so it preserves the pre-metadata merge. Precise separation activates once the build emits balloon metadata.

| User composes                                                      | `chat.db` produces                  | Flag off (default)                      | Flag on + window (imsg emits balloon metadata)                                                      |
| ------------------------------------------------------------------ | ----------------------------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `Dump https://example.com` (one send)                              | 2 rows ~1 s apart                   | Two agent turns: "Dump" alone, then URL | One turn: merged text `Dump https://example.com`                                                    |
| `Save this 📎image.jpg caption` (attachment + text)                | 2 rows without URL balloon metadata | Two turns                               | Two turns after metadata is observed; one merged turn on old/pre-latch metadata-less sessions       |
| `/status` (standalone command)                                     | 1 row                               | Instant dispatch                        | **Wait up to window, then dispatch**                                                                |
| URL pasted alone                                                   | 1 row                               | Instant dispatch                        | Wait up to window, then dispatch                                                                    |
| Text + URL sent as two deliberate separate messages, minutes apart | 2 rows outside window               | Two turns                               | Two turns (window expires between them)                                                             |
| Rapid flood (>10 small DMs inside window)                          | N rows without URL balloon metadata | N turns                                 | N turns after metadata is observed; one bounded merged turn on old/pre-latch metadata-less sessions |
| Two people typing in a group chat                                  | N rows from M senders               | M+ turns (one per sender bucket)        | M+ turns — group chats are not coalesced                                                            |

## Inbound recovery after a bridge or gateway restart

iMessage recovers messages missed while the gateway was down, and at the same time suppresses the stale "backlog bomb" Apple can flush after a Push recovery. The default behavior is always on, built on durable ingress plus an age fence.

- **Durable replay protection.** Before advancing the recovery cursor, OpenClaw journals each raw row in the shared SQLite ingress queue with its Apple GUID as the event ID. A completed row leaves a tombstone for about 4 hours, capped at 10,000 entries, so a replay with the same GUID is dropped even after a restart. A pending row stays recoverable until dispatch adopts it.
- **Downtime recovery.** On startup the monitor remembers the last durably admitted `chat.db` rowid (a persisted per-account cursor) and passes it to `imsg watch.subscribe` as `since_rowid`, so imsg replays rows that were not yet journaled and then tails live. Rows journaled before a crash resume from SQLite. Replay is bounded to the most recent 500 rows and to messages up to ~2 hours old, and GUID tombstones drop anything already handled.
- **Stale-backlog age fence.** Rows above the startup boundary are genuinely live; one whose send date is more than ~15 minutes older than its arrival is the Push-flush backlog and is suppressed. Replayed rows (at or below the boundary) use the wider recovery window instead, so a recently-missed message is delivered while ancient history is not.

Recovery works over both local and remote `cliPath` setups, because `since_rowid` replay runs over the same `imsg` RPC connection. The difference is the window: when the gateway can read `chat.db` (local), it anchors the startup rowid boundary, caps the replay span, and delivers missed messages up to a couple of hours old. Over a remote SSH `cliPath` it cannot read the database, so the replay is uncapped and every row uses the live age fence — it still recovers recently-missed messages and still suppresses old backlog, just with the narrower live window. Run the gateway on the Messages Mac for the wider recovery window.

### Operator-visible signal

Suppressed backlog is logged at the default level, never silently dropped (the `recovery` flag shows which window applied):

```text
imessage: suppressed stale inbound backlog account=<id> sent=<iso> recovery=<bool> (<N> suppressed since start)
```

### Migration

`channels.imessage.catchup.*` is deprecated — downtime recovery is automatic and needs no config for new setups. Existing configs with `catchup.enabled: true` remain honored as a compatibility profile for the recovery replay window. Disabled catchup blocks (`enabled: false` or no `enabled: true`) are retired; `openclaw doctor --fix` removes those.

## Troubleshooting

<AccordionGroup>
  <Accordion title="imsg not found or RPC unsupported">
    Validate the binary and RPC support:

    ```bash
    imsg rpc --help
    imsg status --json
    openclaw channels status --probe
    ```

    If the probe reports RPC unsupported, update `imsg`. If private API actions are unavailable, run `imsg launch` in the logged-in macOS user session and probe again. If the Gateway is not running on macOS, use the Remote Mac over SSH setup above instead of the default local `imsg` path.

  </Accordion>

  <Accordion title="Messages send but inbound iMessages do not arrive">
    First prove whether the message reached the local Mac. If `chat.db` does not change, OpenClaw cannot receive the message even when `imsg status --json` reports a healthy bridge.

```bash
imsg chats --limit 10 --json
imsg watch --chat-id <chat-id> --json
sqlite3 ~/Library/Messages/chat.db \
  "select datetime(max(date)/1000000000 + 978307200, 'unixepoch', 'localtime'), max(ROWID) from message;"
```

    If phone-sent messages create no new rows, repair the macOS Messages and Apple Push layer before changing OpenClaw config. A one-shot service refresh is often enough:

```bash
launchctl kickstart -k system/com.apple.apsd
launchctl kickstart -k gui/$(id -u)/com.apple.CommCenter
launchctl kickstart -k gui/$(id -u)/com.apple.identityservicesd
launchctl kickstart -k gui/$(id -u)/com.apple.imagent
imsg launch
openclaw gateway restart
```

    Send a fresh iMessage from the phone and confirm a new `chat.db` row or `imsg watch` event before debugging OpenClaw sessions. Do not run this as a periodic bridge-relaunch loop; repeated `imsg launch` plus gateway restarts during active work can interrupt deliveries and strand in-flight channel runs.

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
    - mention pattern configuration (`agents.entries.*.groupChat.mentionPatterns`)

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
