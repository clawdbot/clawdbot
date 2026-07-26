---
summary: "Mattermost bot setup and OpenClaw config"
read_when:
  - Setting up Mattermost
  - Debugging Mattermost routing
title: "Mattermost"
sidebarTitle: "Mattermost"
---

Status: downloadable plugin (bot token + WebSocket events). Channels, private channels, group DMs, and DMs are supported. Mattermost is a self-hostable team messaging platform ([mattermost.com](https://mattermost.com)).

## Install

<Tabs>
  <Tab title="npm registry">
    ```bash
    openclaw plugins install @openclaw/mattermost
    ```
  </Tab>
  <Tab title="Local checkout">
    ```bash
    openclaw plugins install ./path/to/local/mattermost-plugin
    ```
  </Tab>
</Tabs>

Details: [Plugins](/tools/plugin)

## Quick setup

<Steps>
  <Step title="Ensure plugin is available">
    Install `@openclaw/mattermost` with the command above, then restart the Gateway if it is already running.
  </Step>
  <Step title="Create a Mattermost bot">
    Create a Mattermost bot account, copy the **bot token**, and add the bot to the teams and channels it should read.
  </Step>
  <Step title="Copy the base URL">
    Copy the Mattermost **base URL** (e.g., `https://chat.example.com`). A trailing `/api/v4` is stripped automatically.
  </Step>
  <Step title="Configure OpenClaw and start the gateway">
    Minimal config:

    ```json5
    {
      channels: {
        mattermost: {
          enabled: true,
          botToken: "mm-token",
          baseUrl: "https://chat.example.com",
          dmPolicy: "pairing",
        },
      },
    }
    ```

    Non-interactive alternative:

    ```bash
    openclaw channels add --channel mattermost --bot-token <token> --http-url https://chat.example.com
    ```

  </Step>
</Steps>

<Note>
Self-hosted Mattermost on a private/LAN/tailnet address: outbound Mattermost API requests pass through an SSRF guard that blocks private and internal IPs by default. Opt in with `channels.mattermost.network.dangerouslyAllowPrivateNetwork: true` (per account: `channels.mattermost.accounts.<id>.network.dangerouslyAllowPrivateNetwork`).
</Note>

## Native slash commands

Native slash commands are opt-in. When enabled, OpenClaw registers `oc_*` slash commands on every team the bot is a member of and receives callback POSTs on the gateway HTTP server.

```json5
{
  channels: {
    mattermost: {
      commands: {
        native: true,
        nativeSkills: true,
        callbackPath: "/api/channels/mattermost/command",
        // Use when Mattermost cannot reach the gateway directly (reverse proxy/public URL).
        callbackUrl: "https://gateway.example.com/api/channels/mattermost/command",
      },
    },
  },
}
```

Registered commands: `/oc_status`, `/oc_model`, `/oc_models`, `/oc_new`, `/oc_help`, `/oc_think`, `/oc_reasoning`, `/oc_verbose`, `/oc_queue`. With `nativeSkills: true`, skill commands are also registered as `/oc_<skill>`.

<AccordionGroup>
  <Accordion title="Behavior notes">
    - `native` and `nativeSkills` default to `"auto"`, which resolves to disabled for Mattermost. Set them to `true` explicitly.
    - `callbackPath` defaults to `/api/channels/mattermost/command`.
    - If `callbackUrl` is omitted, OpenClaw derives `http://<gateway.customBindHost or localhost>:<gateway.port, default 18789><callbackPath>`. Wildcard bind hosts (`0.0.0.0`, `::`) fall back to `localhost`.
    - For multi-account setups, `commands` can be set at the top level or under `channels.mattermost.accounts.<id>.commands` (account values override top-level fields).
    - Existing slash commands with the same trigger created by other integrations are left untouched (registration skips them); commands the bot created are updated or recreated when the callback URL drifts.
    - Command callbacks are validated with the per-command tokens returned by Mattermost when OpenClaw registers `oc_*` commands.
    - OpenClaw refreshes current Mattermost command registration before accepting each callback, so stale tokens from deleted or regenerated slash commands stop being accepted without a gateway restart.
    - Callback validation fails closed if the Mattermost API cannot confirm the command is still current; failed validations are cached briefly, concurrent lookups are coalesced, and fresh lookup starts are rate-limited per command to bound replay pressure.
    - Slash callbacks fail closed when registration failed, startup was partial, or the callback token does not match the resolved command's registered token (a token valid for one command cannot reach upstream validation for a different command).
    - Accepted callbacks are acknowledged with an ephemeral "Processing..." reply; the real answer arrives as a normal message.

  </Accordion>
  <Accordion title="Reachability requirement">
    The callback endpoint must be reachable from the Mattermost server.

    - Do not set `callbackUrl` to `localhost` unless Mattermost runs on the same host/network namespace as OpenClaw.
    - Do not set `callbackUrl` to your Mattermost base URL unless that URL reverse-proxies `/api/channels/mattermost/command` to OpenClaw.
    - A quick check is `curl https://<gateway-host>/api/channels/mattermost/command`; a GET should return `405 Method Not Allowed` from OpenClaw, not `404`.

  </Accordion>
  <Accordion title="Mattermost egress allowlist">
    If your callback targets private/tailnet/internal addresses, set Mattermost `ServiceSettings.AllowedUntrustedInternalConnections` to include the callback host/domain.

    Use host/domain entries, not full URLs.

    - Good: `gateway.tailnet-name.ts.net`
    - Bad: `https://gateway.tailnet-name.ts.net`

  </Accordion>
</AccordionGroup>

## Environment variables (default account)

Set these on the gateway host if you prefer env vars:

- `MATTERMOST_BOT_TOKEN=...`
- `MATTERMOST_URL=https://chat.example.com`

<Note>
Env vars apply only to the **default** account (`default`). Other accounts must use config values.

`MATTERMOST_URL` cannot be set from a workspace `.env`; see [Workspace .env files](/gateway/security).
</Note>

## Chat modes

Mattermost responds to DMs automatically. Channel behavior is controlled by `chatmode`:

<Tabs>
  <Tab title="oncall (default)">
    Respond only when @mentioned in channels.
  </Tab>
  <Tab title="onmessage">
    Respond to every channel message.
  </Tab>
  <Tab title="onchar">
    Respond when a message starts with a trigger prefix.
  </Tab>
</Tabs>

Config example:

```json5
{
  channels: {
    mattermost: {
      chatmode: "onchar",
      oncharPrefixes: [">", "!"], // default
    },
  },
}
```

Notes:

- `onchar` still responds to explicit @mentions.
- `channels.mattermost.requireMention` is still honored, but `chatmode` is preferred. Per-channel `groups.<channelId>.requireMention` settings win over both.
- After the bot sends a visible reply in a channel thread, later messages in that same thread are answered without a new @mention or `onchar` prefix, so multi-turn thread conversations keep flowing. Participation is remembered for 7 days after the bot last replied in that thread and persists across gateway restarts. Threads the bot has only observed are unaffected; start a new top-level message to require an explicit mention again.
- Set `channels.mattermost.implicitMentions.threadParticipation: false` to stop participated-thread follow-ups from bypassing mention gating. Account overrides use `channels.mattermost.accounts.<id>.implicitMentions`. Mattermost does not currently produce `replyToBot` or `quotedBot` facts, so those flags have no effect here.

## Threading and sessions

Use `channels.mattermost.replyToMode` to control whether channel and group replies stay in the main channel or start a thread under the triggering post.

- `off` (default): only reply in a thread when the inbound post is already in one.
- `first`: for top-level channel/group posts, start a thread under that post and route the conversation to a thread-scoped session.
- `all` and `batched`: same behavior as `first` for Mattermost today, because once Mattermost has a thread root, follow-up chunks and media continue in that same thread.
- Direct messages default to `off` even when `replyToMode` is set.

Use `channels.mattermost.replyToModeByChatType` to override the mode for `direct`, `group`, or `channel` chats. Set `direct` to opt direct messages into threading:

- `off` (default): direct messages stay non-threaded in one rolling session.
- `first`, `all`, or `batched`: each top-level direct message starts a Mattermost thread backed by a fresh, independent session.

```json5
{
  channels: {
    mattermost: {
      replyToMode: "all",
      replyToModeByChatType: {
        direct: "first",
      },
    },
  },
}
```

Notes:

- Thread-scoped sessions use the triggering post id as the thread root.
- `first` and `all` are currently equivalent because once Mattermost has a thread root, follow-up chunks and media continue in that same thread.
- Per-chat-type overrides take precedence over `replyToMode`. Without a `direct` override, existing deployments keep flat, non-threaded DMs.

## Access control (DMs)

- Default: `channels.mattermost.dmPolicy = "pairing"` (unknown senders get a pairing code). Other values: `allowlist`, `open`, `disabled`.
- Approve via:
  - `openclaw pairing list mattermost`
  - `openclaw pairing approve mattermost <CODE>`
- Public DMs: `channels.mattermost.dmPolicy="open"` plus `channels.mattermost.allowFrom=["*"]` (the config schema enforces the wildcard).
- `channels.mattermost.allowFrom` accepts user ids (recommended) and `accessGroup:<name>` entries. See [Access groups](/channels/access-groups).

## Channels (groups)

- Default: `channels.mattermost.groupPolicy = "allowlist"` (mention-gated).
- Allowlist senders with `channels.mattermost.groupAllowFrom` (user IDs recommended).
- `channels.mattermost.groupAllowFrom` accepts `accessGroup:<name>` entries. See [Access groups](/channels/access-groups).
- Per-channel mention overrides live under `channels.mattermost.groups.<channelId>.requireMention` or `channels.mattermost.groups["*"].requireMention` for a default.
- `@username` matching is mutable and only enabled when `channels.mattermost.dangerouslyAllowNameMatching: true`.
- Open channels: `channels.mattermost.groupPolicy="open"` (mention-gated).
- Resolution order: `channels.mattermost.groupPolicy`, then `channels.defaults.groupPolicy`, then `"allowlist"`.
- Runtime note: if the `channels.mattermost` section is completely missing, runtime fails closed to `groupPolicy="allowlist"` for group checks (even if `channels.defaults.groupPolicy` is set) and logs a one-time warning.

Example:

```json5
{
  channels: {
    mattermost: {
      groupPolicy: "open",
      groups: {
        "*": { requireMention: true },
        "team-channel-id": { requireMention: false },
      },
    },
  },
}
```

## Targets for outbound delivery

Use these target formats with `openclaw message send` or cron/webhooks:

| Target                              | Delivers to                                                   |
| ----------------------------------- | ------------------------------------------------------------- |
| `channel:<id>`                      | Channel by id                                                 |
| `channel:<name>` or `#channel-name` | Channel by name, searched across the teams the bot belongs to |
| `user:<id>` or `mattermost:<id>`    | DM with that user                                             |
| `@username`                         | DM (username resolved via the Mattermost API)                 |

Outbound sends support at most one attachment per message; split multiple files into separate sends.

<Warning>
Bare opaque IDs (like `64ifufp...`) are **ambiguous** in Mattermost (user ID vs channel ID).

OpenClaw resolves them **user-first**:

- If the ID exists as a user (`GET /api/v4/users/<id>` succeeds), OpenClaw sends a **DM** by resolving the direct channel via `/api/v4/channels/direct`.
- Otherwise the ID is treated as a **channel ID**.

If you need deterministic behavior, always use the explicit prefixes (`user:<id>` / `channel:<id>`).
</Warning>

## DM channel retry

When OpenClaw sends to a Mattermost DM target and needs to resolve the direct channel first, it retries transient direct-channel creation failures by default.

Use `channels.mattermost.dmChannelRetry` to tune that behavior globally for the Mattermost plugin, or `channels.mattermost.accounts.<id>.dmChannelRetry` for one account. Defaults:

```json5
{
  channels: {
    mattermost: {
      dmChannelRetry: {
        maxRetries: 3,
        initialDelayMs: 1000,
        maxDelayMs: 10000,
        timeoutMs: 30000,
      },
    },
  },
}
```

Notes:

- This applies only to DM channel creation (`/api/v4/channels/direct`), not every Mattermost API call.
- Retries use exponential backoff with jitter and apply to transient failures such as rate limits, 5xx responses, and network or timeout errors.
- 4xx client errors other than `429` are treated as permanent and are not retried.

## Preview streaming

Mattermost streams thinking, tool activity, and partial reply text into a **draft preview post** that finalizes in place when the final answer is safe to send. In `partial` mode the preview updates on the same post id instead of spamming the channel with per-chunk messages. In `block` mode the preview rotates between completed text and tool-activity blocks, so earlier blocks stay visible as their own posts instead of being overwritten by the next one. Media/error finals cancel pending preview edits and use normal delivery instead of flushing a throwaway preview post.

Preview streaming is **on by default** in `partial` mode. Configure via `channels.mattermost.streaming.mode` (legacy scalar/boolean `streaming` values are migrated by `openclaw doctor --fix`):

```json5
{
  channels: {
    mattermost: {
      streaming: { mode: "partial" }, // off | partial | block | progress
    },
  },
}
```

<AccordionGroup>
  <Accordion title="Streaming modes">
    - `partial` (default): one preview post that is edited as the reply grows, then finalized with the complete answer.
    - `block` rotates the preview between completed text and tool-activity blocks, so each block stays visible as its own post instead of being overwritten in place. Parallel and consecutive tool updates share the current tool-activity post.
    - `progress` shows a status preview while generating and only posts the final answer at completion.
    - `off` disables preview streaming. With `streaming.block.enabled: true`, completed assistant blocks are still delivered as normal block replies (separate posts) rather than a single coalesced final post.

  </Accordion>
  <Accordion title="Streaming behavior notes">
    - If the stream cannot be finalized in place (for example the post was deleted mid-stream), OpenClaw falls back to sending a fresh final post so the reply is never lost.
    - Thinking-only payloads are suppressed from channel posts, including text that arrives as a `> Thinking` blockquote. Set `/reasoning on` to see thinking in other surfaces; the Mattermost final post keeps the answer only.
    - See [Streaming](/concepts/streaming#preview-streaming-modes) for the channel-mapping matrix.

  </Accordion>
</AccordionGroup>

## Reactions (message tool)

- Use `message action=react` with `channel=mattermost`.
- `messageId` is the Mattermost post id.
- `emoji` accepts names like `thumbsup` or `:+1:` (colons are optional).
- Set `remove=true` (boolean) to remove a reaction.
- Reaction add/remove events are forwarded as system events to the routed agent session, subject to the same DM/group policy checks as messages.

Examples:

```text
message action=react channel=mattermost target=channel:<channelId> messageId=<postId> emoji=thumbsup
message action=react channel=mattermost target=channel:<channelId> messageId=<postId> emoji=thumbsup remove=true
```

Config:

- `channels.mattermost.actions.reactions`: enable/disable reaction actions (default true).
- Per-account override: `channels.mattermost.accounts.<id>.actions.reactions`.

## Interactive buttons (message tool)

Send messages with clickable buttons. When a user clicks a button, the agent receives the selection and can respond.

Buttons come from the semantic `presentation` payload (in normal agent replies and in `message action=send`). OpenClaw renders value buttons as Mattermost interactive buttons, keeps URL buttons visible in the message text, and downgrades select menus to readable text.

```text
message action=send channel=mattermost target=channel:<channelId> presentation={"blocks":[{"type":"buttons","buttons":[{"label":"Yes","value":"yes"},{"label":"No","value":"no"}]}]}
```

Presentation button fields:

<ParamField path="label" type="string" required>
  Display label (alias: `text`).
</ParamField>
<ParamField path="value" type="string">
  Value sent back on click, used as the action ID (aliases: `callback_data`, `callbackData`). Required for a clickable button unless `url` is set.
</ParamField>
<ParamField path="url" type="string">
  Link button; rendered as `label: url` text in the message body instead of an interactive button.
</ParamField>
<ParamField path="style" type='"primary" | "secondary" | "success" | "danger"'>
  Button style. Mattermost applies default styling to values it does not support.
</ParamField>

To advertise button support in the agent system prompt, add `inlineButtons` to the channel capabilities:

```json5
{
  channels: {
    mattermost: {
      capabilities: ["inlineButtons"],
    },
  },
}
```

When a user clicks a button:

<Steps>
  <Step title="Access check">
    The clicker must pass the same DM/group policy checks as a message sender; unauthorized clicks get an ephemeral notice and are ignored.
  </Step>
  <Step title="Buttons replaced with confirmation">
    All buttons are replaced with a confirmation line (e.g., "✓ **Yes** selected by @user").
  </Step>
  <Step title="Agent receives the selection">
    The agent receives the selection as an inbound message (plus a system event) and responds.
  </Step>
</Steps>

<AccordionGroup>
  <Accordion title="Implementation notes">
    - Button callbacks use HMAC-SHA256 verification (automatic, no config needed).
    - The whole attachment block is replaced on click, so all buttons are removed together - partial removal is not possible.
    - Action IDs containing hyphens or underscores are sanitized automatically (Mattermost routing limitation).
    - Clicks whose `action_id` does not match an action on the original post are rejected with `403` ("Unknown action").

  </Accordion>
  <Accordion title="Config and reachability">
    - `channels.mattermost.capabilities`: array of capability strings. Add `"inlineButtons"` to enable the buttons tool description in the agent system prompt.
    - `channels.mattermost.interactions.callbackBaseUrl`: optional external base URL for button callbacks (for example `https://gateway.example.com`). Use this when Mattermost cannot reach the gateway at its bind host directly.
    - In multi-account setups, you can also set the same field under `channels.mattermost.accounts.<id>.interactions.callbackBaseUrl`.
    - If `interactions.callbackBaseUrl` is omitted, OpenClaw derives the callback URL from `gateway.customBindHost` + `gateway.port` (default 18789), then falls back to `http://localhost:<port>`. The callback path is `/mattermost/interactions/<accountId>`.
    - Reachability rule: the button callback URL must be reachable from the Mattermost server. `localhost` only works when Mattermost and OpenClaw run on the same host/network namespace.
    - `channels.mattermost.interactions.allowedSourceIps`: source-IP allowlist for button callbacks. Without it, only loopback sources (`127.0.0.1`, `::1`) are accepted, so a remote Mattermost server must be allowlisted here or its clicks are rejected with `403`. Behind a reverse proxy, also set `gateway.trustedProxies` so the real client IP is derived from forwarded headers.
    - If your callback target is private/tailnet/internal, add its host/domain to Mattermost `ServiceSettings.AllowedUntrustedInternalConnections`.

  </Accordion>
</AccordionGroup>

### Direct API integration (external scripts)

External scripts and webhooks can post buttons directly via the Mattermost REST API instead of going through the agent's `message` tool. Prefer OpenClaw's `message` tool. For direct integrations, import `buildButtonAttachments` from `@openclaw/mattermost/api.js`; if posting raw JSON, follow these rules:

**Payload structure:**

```json5
{
  channel_id: "<channelId>",
  message: "Choose an option:",
  props: {
    attachments: [
      {
        actions: [
          {
            id: "mybutton01", // alphanumeric only - see below
            type: "button", // required, or clicks are silently ignored
            name: "Approve", // display label
            style: "primary", // optional: "default", "primary", "danger"
            integration: {
              url: "https://gateway.example.com/mattermost/interactions/default",
              context: {
                action_id: "mybutton01", // must match button id
                action: "approve",
                // ... any custom fields ...
                _token: "<hmac>", // see HMAC section below
              },
            },
          },
        ],
      },
    ],
  },
}
```

<Warning>
**Critical rules**

1. Attachments go in `props.attachments`, not top-level `attachments` (silently ignored).
2. Every action needs `type: "button"` - without it, clicks are swallowed silently.
3. Every action needs an `id` field - Mattermost ignores actions without IDs.
4. Action `id` must be **alphanumeric only** (`[a-zA-Z0-9]`). Hyphens and underscores break Mattermost's server-side action routing (returns 404). Strip them before use.
5. `context.action_id` must match the button's `id`; the gateway rejects clicks whose `action_id` does not exist on the post.
6. `context.action_id` is required - the interaction handler returns 400 without it.
7. The callback source IP must be allowed (see `interactions.allowedSourceIps` above).

</Warning>

**HMAC token generation**

The gateway verifies button clicks with HMAC-SHA256. External scripts must generate tokens that match the gateway's verification logic:

<Steps>
  <Step title="Derive the secret from the bot token">
    `HMAC-SHA256(key="openclaw-mattermost-interactions", data=botToken)`, hex-encoded.
  </Step>
  <Step title="Build the context object">
    Build the context object with all fields **except** `_token`.
  </Step>
  <Step title="Serialize with sorted keys">
    Serialize with **recursively sorted keys** and **no spaces** (the gateway canonicalizes nested objects too and produces compact JSON).
  </Step>
  <Step title="Sign the payload">
    `HMAC-SHA256(key=secret, data=serializedContext)`
  </Step>
  <Step title="Add the token">
    Add the resulting hex digest as `_token` in the context.
  </Step>
</Steps>

Python example:

```python
import hmac, hashlib, json

secret = hmac.new(
    b"openclaw-mattermost-interactions",
    bot_token.encode(), hashlib.sha256
).hexdigest()

ctx = {"action_id": "mybutton01", "action": "approve"}
payload = json.dumps(ctx, sort_keys=True, separators=(",", ":"))
token = hmac.new(secret.encode(), payload.encode(), hashlib.sha256).hexdigest()

context = {**ctx, "_token": token}
```

<AccordionGroup>
  <Accordion title="Common HMAC pitfalls">
    - Python's `json.dumps` adds spaces by default (`{"key": "val"}`). Use `separators=(",", ":")` to match JavaScript's compact output (`{"key":"val"}`).
    - Always sign **all** context fields (minus `_token`). The gateway strips `_token` then signs everything remaining. Signing a subset causes silent verification failure.
    - Use `sort_keys=True` - the gateway sorts keys before signing, and Mattermost may reorder context fields when storing the payload.
    - Derive the secret from the bot token (deterministic), not random bytes. The secret must be the same across the process that creates buttons and the gateway that verifies.

  </Accordion>
</AccordionGroup>

## Directory adapter

The Mattermost plugin includes a directory adapter that resolves channel and user names via the Mattermost API. This enables `#channel-name` and `@username` targets in `openclaw message send` and cron/webhook deliveries.

No configuration is needed - the adapter uses the bot token from the account config.

## Multi-account

Mattermost supports multiple accounts under `channels.mattermost.accounts`:

```json5
{
  channels: {
    mattermost: {
      accounts: {
        default: { name: "Primary", botToken: "mm-token", baseUrl: "https://chat.example.com" },
        alerts: { name: "Alerts", botToken: "mm-token-2", baseUrl: "https://alerts.example.com" },
      },
    },
  },
}
```

Account values override top-level fields; `channels.mattermost.defaultAccount` picks which account is used when none is specified.

## Troubleshooting

<AccordionGroup>
  <Accordion title="No replies in channels">
    Ensure the bot is in the channel and mention it (oncall), use a trigger prefix (onchar), or set `chatmode: "onmessage"`.
  </Accordion>
  <Accordion title="Auth or multi-account errors">
    - Check the bot token, base URL, and whether the account is enabled.
    - Multi-account issues: env vars only apply to the `default` account.
    - Private/LAN Mattermost hosts need `network.dangerouslyAllowPrivateNetwork: true` (the SSRF guard blocks private IPs by default).

  </Accordion>
  <Accordion title="Native slash commands fail">
    - `Unauthorized: invalid command token.`: OpenClaw did not accept the callback token. Typical causes:
      - slash command registration failed or only partially completed at startup
      - the callback is hitting the wrong gateway/account
      - Mattermost still has old commands pointing at a previous callback target
      - the gateway restarted without reactivating slash commands
    - If native slash commands stop working, check logs for `mattermost: failed to register slash commands` or `mattermost: native slash commands enabled but no commands could be registered`.
    - If `callbackUrl` is omitted and logs warn that the callback resolved to a loopback URL like `http://localhost:18789/...`, that URL is probably only reachable when Mattermost runs on the same host/network namespace as OpenClaw. Set an explicit externally reachable `commands.callbackUrl` instead.

  </Accordion>
  <Accordion title="Buttons issues">
    - Buttons appear as white boxes or not at all: the button data is malformed. Each presentation button needs a `label` and a `value` (buttons missing either are dropped).
    - Buttons render but clicks do nothing: verify the gateway is reachable from the Mattermost server, the Mattermost server IP is included in `channels.mattermost.interactions.allowedSourceIps` (only loopback is accepted without it), and `ServiceSettings.AllowedUntrustedInternalConnections` includes the callback host for private targets.
    - Buttons return 404 on click: the button `id` likely contains hyphens or underscores. Mattermost's action router breaks on non-alphanumeric IDs. Use `[a-zA-Z0-9]` only.
    - Gateway logs `rejected callback source`: the click came from an IP outside `interactions.allowedSourceIps`. Allowlist the Mattermost server or your ingress, and set `gateway.trustedProxies` behind a reverse proxy.
    - Gateway logs `invalid _token`: HMAC mismatch. Check that you sign all context fields (not a subset), use sorted keys, and use compact JSON (no spaces). See the HMAC section above.
    - Gateway logs `missing _token in context`: the `_token` field is not in the button's context. Ensure it is included when building the integration payload.
    - Gateway rejects the click with `Unknown action`: `context.action_id` does not match any action `id` on the post. Set both to the same sanitized value.
    - Agent does not offer buttons: add `capabilities: ["inlineButtons"]` to the Mattermost channel config.

  </Accordion>
</AccordionGroup>

## Related

- [Channel Routing](/channels/channel-routing) - session routing for messages
- [Channels Overview](/channels) - all supported channels
- [Groups](/channels/groups) - group chat behavior and mention gating
- [Pairing](/channels/pairing) - DM authentication and pairing flow
- [Security](/gateway/security) - access model and hardening
