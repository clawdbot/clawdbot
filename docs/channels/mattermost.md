---
summary: "Mattermost bot setup and OpenClaw config"
read_when:
  - Setting up Mattermost
  - Debugging Mattermost routing
title: "Mattermost"
sidebarTitle: "Mattermost"
---

Status: bundled plugin (bot token + WebSocket events). Channels, groups, and DMs are supported. Mattermost is a self-hostable team messaging platform; see the official site at [mattermost.com](https://mattermost.com) for product details and downloads.

## Bundled plugin

<Note>
Mattermost ships as a bundled plugin in current OpenClaw releases, so normal packaged builds do not need a separate install.
</Note>

If you are on an older build or a custom install that excludes Mattermost, install a current npm package when one is published:

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

If npm reports the OpenClaw-owned package as deprecated, use a current packaged
OpenClaw build or the local checkout path until a newer npm package is
published.

Details: [Plugins](/tools/plugin)

## Quick setup

<Steps>
  <Step title="Ensure plugin is available">
    Current packaged OpenClaw releases already bundle it. Older/custom installs can add it manually with the commands above.
  </Step>
  <Step title="Create a Mattermost bot">
    Create a Mattermost bot account and copy the **bot token**.
  </Step>
  <Step title="Copy the base URL">
    Copy the Mattermost **base URL** (e.g., `https://chat.example.com`).
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

  </Step>
</Steps>

## Native slash commands

Native slash commands are opt-in. When enabled, OpenClaw registers `oc_*` slash commands via the Mattermost API and receives callback POSTs on the gateway HTTP server.

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

<AccordionGroup>
  <Accordion title="Behavior notes">
    - `native: "auto"` defaults to disabled for Mattermost. Set `native: true` to enable.
    - If `callbackUrl` is omitted, OpenClaw derives one from gateway host/port + `callbackPath`.
    - For multi-account setups, `commands` can be set at the top level or under `channels.mattermost.accounts.<id>.commands` (account values override top-level fields).
    - Command callbacks are validated with the per-command tokens returned by Mattermost when OpenClaw registers `oc_*` commands.
    - OpenClaw refreshes current Mattermost command registration before accepting each callback so stale tokens from deleted or regenerated slash commands stop being accepted without a gateway restart.
    - Callback validation fails closed if the Mattermost API cannot confirm the command is still current; failed validations are cached briefly, concurrent lookups are coalesced, and fresh lookup starts are rate-limited per command to bound replay pressure.
    - Slash callbacks fail closed when registration failed, startup was partial, or the callback token does not match the resolved command's registered token (a token valid for one command cannot reach upstream validation for a different command).

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

`MATTERMOST_URL` cannot be set from a workspace `.env`; see [Workspace `.env` files](/gateway/security).
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
      oncharPrefixes: [">", "!"],
    },
  },
}
```

Notes:

- `onchar` still responds to explicit @mentions.
- `channels.mattermost.requireMention` is honored for legacy configs but `chatmode` is preferred.

## Threading and sessions

Use `channels.mattermost.replyToMode` to control whether channel and group replies stay in the main channel or start a thread under the triggering post.

- `off` (default): only reply in a thread when the inbound post is already in one.
- `first`: for top-level channel/group posts, start a thread under that post and route the conversation to a thread-scoped session.
- `all`: same behavior as `first` for Mattermost today.
- Direct messages ignore this setting and stay non-threaded.

Config example:

```json5
{
  channels: {
    mattermost: {
      replyToMode: "all",
    },
  },
}
```

Notes:

- Thread-scoped sessions use the triggering post id as the thread root.
- `first` and `all` are currently equivalent because once Mattermost has a thread root, follow-up chunks and media continue in that same thread.

## Access control (DMs)

- Default: `channels.mattermost.dmPolicy = "pairing"` (unknown senders get a pairing code).
- Approve via:
  - `openclaw pairing list mattermost`
  - `openclaw pairing approve mattermost <CODE>`
- Public DMs: `channels.mattermost.dmPolicy="open"` plus `channels.mattermost.allowFrom=["*"]`.

## Channels (groups)

- Default: `channels.mattermost.groupPolicy = "allowlist"` (mention-gated).
- Allowlist senders with `channels.mattermost.groupAllowFrom` (user IDs recommended).
- Per-channel mention overrides live under `channels.mattermost.groups.<channelId>.requireMention` or `channels.mattermost.groups["*"].requireMention` for a default.
- `@username` matching is mutable and only enabled when `channels.mattermost.dangerouslyAllowNameMatching: true`.
- Open channels: `channels.mattermost.groupPolicy="open"` (mention-gated).
- Runtime note: if `channels.mattermost` is completely missing, runtime falls back to `groupPolicy="allowlist"` for group checks (even if `channels.defaults.groupPolicy` is set).

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

- `channel:<id>` for a channel
- `user:<id>` for a DM
- `@username` for a DM (resolved via the Mattermost API)

<Warning>
Bare opaque IDs (like `64ifufp...`) are **ambiguous** in Mattermost (user ID vs channel ID).

OpenClaw resolves them **user-first**:

- If the ID exists as a user (`GET /api/v4/users/<id>` succeeds), OpenClaw sends a **DM** by resolving the direct channel via `/api/v4/channels/direct`.
- Otherwise the ID is treated as a **channel ID**.

If you need deterministic behavior, always use the explicit prefixes (`user:<id>` / `channel:<id>`).
</Warning>

## DM channel retry

When OpenClaw sends to a Mattermost DM target and needs to resolve the direct channel first, it retries transient direct-channel creation failures by default.

Use `channels.mattermost.dmChannelRetry` to tune that behavior globally for the Mattermost plugin, or `channels.mattermost.accounts.<id>.dmChannelRetry` for one account.

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
- Retries apply to transient failures such as rate limits, 5xx responses, and network or timeout errors.
- 4xx client errors other than `429` are treated as permanent and are not retried.

## Preview streaming

Mattermost streams thinking, tool activity, and partial reply text into a single **draft preview post** that finalizes in place when the final answer is safe to send. The preview updates on the same post id instead of spamming the channel with per-chunk messages. Media/error finals cancel pending preview edits and use normal delivery instead of flushing a throwaway preview post.

Enable via `channels.mattermost.streaming`:

```json5
{
  channels: {
    mattermost: {
      streaming: "partial", // off | partial | block | progress
    },
  },
}
```

<AccordionGroup>
  <Accordion title="Streaming modes">
    - `partial` is the usual choice: one preview post that is edited as the reply grows, then finalized with the complete answer.
    - `block` uses append-style draft chunks inside the preview post.
    - `progress` shows a status preview while generating and only posts the final answer at completion.
    - `off` disables preview streaming.

  </Accordion>
  <Accordion title="Streaming behavior notes">
    - If the stream cannot be finalized in place (for example the post was deleted mid-stream), OpenClaw falls back to sending a fresh final post so the reply is never lost.
    - Reasoning-only payloads are suppressed from channel posts, including text that arrives as a `> Reasoning:` blockquote. Set `/reasoning on` to see thinking in other surfaces; the Mattermost final post keeps the answer only.
    - See [Streaming](/concepts/streaming#preview-streaming-modes) for the channel-mapping matrix.

  </Accordion>
</AccordionGroup>

## Reactions (message tool)

- Use `message action=react` with `channel=mattermost`.
- `messageId` is the Mattermost post id.
- `emoji` accepts names like `thumbsup` or `:+1:` (colons are optional).
- Set `remove=true` (boolean) to remove a reaction.
- Reaction add/remove events are forwarded as system events to the routed agent session.

Examples:

```
message action=react channel=mattermost target=channel:<channelId> messageId=<postId> emoji=thumbsup
message action=react channel=mattermost target=channel:<channelId> messageId=<postId> emoji=thumbsup remove=true
```

Config:

- `channels.mattermost.actions.reactions`: enable/disable reaction actions (default true).
- Per-account override: `channels.mattermost.accounts.<id>.actions.reactions`.

## Interactive buttons (message tool)

Send messages with clickable buttons. When a user clicks a button, the agent receives the selection and can respond.

Enable buttons by adding `inlineButtons` to the channel capabilities:

```json5
{
  channels: {
    mattermost: {
      capabilities: ["inlineButtons"],
    },
  },
}
```

Use `message action=send` with a `buttons` parameter. Buttons are a 2D array (rows of buttons):

```
message action=send channel=mattermost target=channel:<channelId> buttons=[[{"text":"Yes","callback_data":"yes"},{"text":"No","callback_data":"no"}]]
```

Button fields:

<ParamField path="text" type="string" required>
  Display label.
</ParamField>
<ParamField path="callback_data" type="string" required>
  Value sent back on click (used as the action ID).
</ParamField>
<ParamField path="style" type='"default" | "primary" | "danger"'>
  Button style.
</ParamField>

When a user clicks a button:

<Steps>
  <Step title="Buttons replaced with confirmation">
    All buttons are replaced with a confirmation line (e.g., "✓ **Yes** selected by @user").
  </Step>
  <Step title="Agent receives the selection">
    The agent receives the selection as an inbound message and responds.
  </Step>
</Steps>

<AccordionGroup>
  <Accordion title="Implementation notes">
    - Button callbacks use HMAC-SHA256 verification (automatic, no config needed).
    - Mattermost strips callback data from its API responses (security feature), so all buttons are removed on click — partial removal is not possible.
    - Action IDs containing hyphens or underscores are sanitized automatically (Mattermost routing limitation).

  </Accordion>
  <Accordion title="Config and reachability">
    - `channels.mattermost.capabilities`: array of capability strings. Add `"inlineButtons"` to enable the buttons tool description in the agent system prompt.
    - `channels.mattermost.interactions.callbackBaseUrl`: optional external base URL for button callbacks (for example `https://gateway.example.com`). Use this when Mattermost cannot reach the gateway at its bind host directly.
    - In multi-account setups, you can also set the same field under `channels.mattermost.accounts.<id>.interactions.callbackBaseUrl`.
    - If `interactions.callbackBaseUrl` is omitted, OpenClaw derives the callback URL from `gateway.customBindHost` + `gateway.port`, then falls back to `http://localhost:<port>`.
    - Reachability rule: the button callback URL must be reachable from the Mattermost server. `localhost` only works when Mattermost and OpenClaw run on the same host/network namespace.
    - If your callback target is private/tailnet/internal, add its host/domain to Mattermost `ServiceSettings.AllowedUntrustedInternalConnections`.

  </Accordion>
</AccordionGroup>

### Direct API integration (external scripts)

External scripts and webhooks can post buttons directly via the Mattermost REST API instead of going through the agent's `message` tool. Use `buildButtonAttachments()` from the plugin when possible; if posting raw JSON, follow these rules:

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
            id: "mybutton01", // alphanumeric only — see below
            type: "button", // required, or clicks are silently ignored
            name: "Approve", // display label
            style: "primary", // optional: "default", "primary", "danger"
            integration: {
              url: "https://gateway.example.com/mattermost/interactions/default",
              context: {
                action_id: "mybutton01", // must match button id (for name lookup)
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
2. Every action needs `type: "button"` — without it, clicks are swallowed silently.
3. Every action needs an `id` field — Mattermost ignores actions without IDs.
4. Action `id` must be **alphanumeric only** (`[a-zA-Z0-9]`). Hyphens and underscores break Mattermost's server-side action routing (returns 404). Strip them before use.
5. `context.action_id` must match the button's `id` so the confirmation message shows the button name (e.g., "Approve") instead of a raw ID.
6. `context.action_id` is required — the interaction handler returns 400 without it.

</Warning>

**HMAC token generation**

The gateway verifies button clicks with HMAC-SHA256. External scripts must generate tokens that match the gateway's verification logic:

<Steps>
  <Step title="Derive the secret from the bot token">
    `HMAC-SHA256(key="openclaw-mattermost-interactions", data=botToken)`
  </Step>
  <Step title="Build the context object">
    Build the context object with all fields **except** `_token`.
  </Step>
  <Step title="Serialize with sorted keys">
    Serialize with **sorted keys** and **no spaces** (the gateway uses `JSON.stringify` with sorted keys, which produces compact output).
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
    - Use `sort_keys=True` — the gateway sorts keys before signing, and Mattermost may reorder context fields when storing the payload.
    - Derive the secret from the bot token (deterministic), not random bytes. The secret must be the same across the process that creates buttons and the gateway that verifies.

  </Accordion>
</AccordionGroup>

## Directory adapter

The Mattermost plugin includes a directory adapter that resolves channel and user names via the Mattermost API. This enables `#channel-name` and `@username` targets in `openclaw message send` and cron/webhook deliveries.

No configuration is needed — the adapter uses the bot token from the account config.

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

## Troubleshooting

<AccordionGroup>
  <Accordion title="No replies in channels">
    Ensure the bot is in the channel and mention it (oncall), use a trigger prefix (onchar), or set `chatmode: "onmessage"`.
  </Accordion>
  <Accordion title="Auth or multi-account errors">
    - Check the bot token, base URL, and whether the account is enabled.
    - Multi-account issues: env vars only apply to the `default` account.

  </Accordion>
  <Accordion title="Native slash commands fail">
    - `Unauthorized: invalid command token.`: OpenClaw did not accept the callback token. Typical causes:
      - slash command registration failed or only partially completed at startup
      - the callback is hitting the wrong gateway/account
      - Mattermost still has old commands pointing at a previous callback target
      - the gateway restarted without reactivating slash commands
    - If native slash commands stop working, check logs for `mattermost: failed to register slash commands` or `mattermost: native slash commands enabled but no commands could be registered`.
    - If `callbackUrl` is omitted and logs warn that the callback resolved to `http://127.0.0.1:18789/...`, that URL is probably only reachable when Mattermost runs on the same host/network namespace as OpenClaw. Set an explicit externally reachable `commands.callbackUrl` instead.

  </Accordion>
  <Accordion title="Buttons issues">
    - Buttons appear as white boxes: the agent may be sending malformed button data. Check that each button has both `text` and `callback_data` fields.
    - Buttons render but clicks do nothing: verify `AllowedUntrustedInternalConnections` in Mattermost server config includes `127.0.0.1 localhost`, and that `EnablePostActionIntegration` is `true` in ServiceSettings.
    - Buttons return 404 on click: the button `id` likely contains hyphens or underscores. Mattermost's action router breaks on non-alphanumeric IDs. Use `[a-zA-Z0-9]` only.
    - Gateway logs `invalid _token`: HMAC mismatch. Check that you sign all context fields (not a subset), use sorted keys, and use compact JSON (no spaces). See the HMAC section above.
    - Gateway logs `missing _token in context`: the `_token` field is not in the button's context. Ensure it is included when building the integration payload.
    - Confirmation shows raw ID instead of button name: `context.action_id` does not match the button's `id`. Set both to the same sanitized value.
    - Agent doesn't know about buttons: add `capabilities: ["inlineButtons"]` to the Mattermost channel config.

  </Accordion>
</AccordionGroup>

## Related

- [Channel Routing](/channels/channel-routing) — session routing for messages
- [Channels Overview](/channels) — all supported channels
- [Groups](/channels/groups) — group chat behavior and mention gating
- [Pairing](/channels/pairing) — DM authentication and pairing flow
- [Security](/gateway/security) — access model and hardening
