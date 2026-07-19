---
summary: "Google Chat app support status, capabilities, and configuration"
read_when:
  - Working on Google Chat channel features
title: "Google Chat"
---

Google Chat runs as the official `@openclaw/googlechat` plugin: DMs and spaces through Google Chat API webhooks (HTTP endpoint only, no Pub/Sub).

## Install

```bash
openclaw plugins install @openclaw/googlechat
```

Local checkout (when running from a git repo):

```bash
openclaw plugins install ./path/to/local/googlechat-plugin
```

## Quick setup (beginner)

1. Create a Google Cloud project and enable the **Google Chat API**.
   - Go to: [Google Chat API Credentials](https://console.cloud.google.com/apis/api/chat.googleapis.com/credentials)
   - Enable the API if it is not already enabled.
2. Create a **Service Account**:
   - Press **Create Credentials** > **Service Account**.
   - Name it whatever you want (e.g., `openclaw-chat`).
   - Leave permissions and principals blank (**Continue**, then **Done**).
3. Create and download the **JSON key**:
   - Click the new service account > **Keys** tab > **Add Key** > **Create new key** > **JSON** > **Create**.
4. Store the downloaded JSON file on your gateway host (e.g., `~/.openclaw/googlechat-service-account.json`).
5. Create a Google Chat app in the [Google Cloud Console Chat Configuration](https://console.cloud.google.com/apis/api/chat.googleapis.com/hangouts-chat):
   - Fill in **Application info** (app name, avatar URL, description).
   - Enable **Interactive features**.
   - Under **Functionality**, check **Join spaces and group conversations**.
   - Under **Connection settings**, select **HTTP endpoint URL**.
   - Under **Triggers**, select **Use a common HTTP endpoint URL for all triggers** and set it to your public gateway URL followed by `/googlechat` (see [Public URL](#public-url-webhook-only)).
   - Under **Visibility**, check **Make this Chat app available to specific people and groups in `<Your Domain>`** and enter your email address.
   - Click **Save**.
6. Enable the app status: refresh the page, find **App status**, set it to **Live - available to users**, and **Save** again.
7. Configure OpenClaw with the service account and the webhook audience (must match the Chat app config):
   - Env: `GOOGLE_CHAT_SERVICE_ACCOUNT_FILE=/path/to/service-account.json` (default account only), or
   - Config: see [Config highlights](#config-highlights). `openclaw channels add --channel googlechat` also accepts `--audience-type`, `--audience`, `--webhook-path`, and `--webhook-url`.
8. Start the gateway. Google Chat will POST to your webhook path (default `/googlechat`).

## Add to Google Chat

Once the gateway is running and your email is on the visibility list:

1. Go to [Google Chat](https://chat.google.com/).
2. Click the **+** (plus) icon next to **Direct Messages**.
3. Search for the **App name** you configured in the Google Cloud Console.
   - The bot does _not_ appear in the Marketplace browse list because it is a private app; search for it by name.
4. Select the bot, click **Add** or **Chat**, and send a message.

## Public URL (Webhook-only)

Google Chat webhooks require a public HTTPS endpoint. For security, expose **only the `/googlechat` path** to the internet and keep the OpenClaw dashboard and other endpoints private.

### Option A: Tailscale Funnel (Recommended)

Use Tailscale Serve for the private dashboard and Funnel for the public webhook path.

1. Check what address your gateway is bound to:

   ```bash
   ss -tlnp | grep 18789
   ```

   Note the IP (e.g., `127.0.0.1`, `0.0.0.0`, or a Tailscale `100.x.x.x` address).

2. Expose the dashboard to the tailnet only (port 8443):

   ```bash
   # If bound to localhost (127.0.0.1 or 0.0.0.0):
   tailscale serve --bg --https 8443 http://127.0.0.1:18789

   # If bound to a Tailscale IP only:
   tailscale serve --bg --https 8443 http://100.x.x.x:18789
   ```

3. Expose only the webhook path publicly:

   ```bash
   # If bound to localhost (127.0.0.1 or 0.0.0.0):
   tailscale funnel --bg --set-path /googlechat http://127.0.0.1:18789/googlechat

   # If bound to a Tailscale IP only:
   tailscale funnel --bg --set-path /googlechat http://100.x.x.x:18789/googlechat
   ```

4. If prompted, visit the authorization URL shown in the output to enable Funnel for this node.

5. Verify:

   ```bash
   tailscale serve status
   tailscale funnel status
   ```

Your public webhook URL is `https://<node-name>.<tailnet>.ts.net/googlechat`; the dashboard stays tailnet-only at `https://<node-name>.<tailnet>.ts.net:8443/`. Use the public URL (without `:8443`) in the Google Chat app config.

> Note: This configuration persists across reboots. Remove it later with `tailscale funnel reset` and `tailscale serve reset`.

### Option B: Reverse Proxy (Caddy)

Proxy only the webhook path:

```caddy
your-domain.com {
    reverse_proxy /googlechat* localhost:18789
}
```

Requests to `your-domain.com/` are ignored or 404, while `your-domain.com/googlechat` routes to OpenClaw.

### Option C: Cloudflare Tunnel

Configure the tunnel ingress rules to route only the webhook path:

- **Path**: `/googlechat` -> `http://localhost:18789/googlechat`
- **Default rule**: HTTP 404 (Not Found)

## How it works

1. Google Chat POSTs JSON to the gateway webhook path (POST only, JSON content type required, per-IP rate limited).
2. OpenClaw authenticates every request before dispatch:
   - Chat app events carry `Authorization: Bearer <token>`; the token is verified before the full body is parsed.
   - Google Workspace Add-on events carry the token in the body (`authorizationEventObject.systemIdToken`) and are read under a stricter pre-auth budget (16 KB, 3 s) before verification.
3. The token is checked against `audienceType` + `audience`:
   - `audienceType: "app-url"` → audience is your HTTPS webhook URL.
   - `audienceType: "project-number"` → audience is the Cloud project number.
   - Add-on tokens under `app-url` additionally require `appPrincipal` set to the app's numeric OAuth 2.0 client ID (21 digits, not an email); otherwise verification fails with a logged warning.
4. Messages route by space:
   - Spaces get per-space sessions `agent:<agentId>:googlechat:group:<spaceId>`; replies go to the message thread.
   - DMs collapse into the agent's main session by default; set `session.dmScope` for per-peer DM sessions (see [Session](/concepts/session)).
5. DM access is pairing by default. Unknown senders receive a pairing code; approve with:
   - `openclaw pairing approve googlechat <code>`
6. Group spaces require @-mention by default. Mentions are detected from Chat `USER_MENTION` annotations targeting the app; set `botUser` (e.g., `users/1234567890`) if detection needs the app's user resource name.
7. When an exec or plugin approval starts from Google Chat and a stable `users/<id>` approver is configured, OpenClaw posts a native approval card (`cardsV2`) in the originating space or thread. Card buttons carry opaque callback tokens; the manual `/approve <id> <decision>` prompt appears only when native delivery is unavailable.

### Inbound durability

After request authentication, OpenClaw removes the add-on authorization object from storage and durably queues Google Chat `MESSAGE` events before returning `200`. A persistence failure returns `503`, allowing Google Chat to retry instead of acknowledging an event that could be lost.

Pending or retryable messages survive a Gateway restart, remain serialized per space, and use the Google Chat message resource name to suppress duplicate queue entries while the active or retained completion record exists. Non-message actions keep their existing detached webhook path and do not receive this durable-queue guarantee. Delivery remains at least once across the queue-to-agent boundary, so a crash during handoff can replay a turn.

## Targets

Use these identifiers for delivery and allowlists:

- Direct messages: `users/<userId>` (recommended).
- Spaces: `spaces/<spaceId>`.
- Raw email `name@example.com` is mutable and only used for allowlist matching when `channels.googlechat.dangerouslyAllowNameMatching: true`.
- Deprecated: `users/<email>` is treated as a user id, not an email allowlist entry.
- Prefixes `googlechat:`, `google-chat:`, and `gchat:` are accepted and stripped.

## Config highlights

```json5
{
  channels: {
    googlechat: {
      enabled: true,
      serviceAccountFile: "/path/to/service-account.json",
      // or serviceAccountRef: { source: "file", provider: "filemain", id: "/channels/googlechat/serviceAccount" }
      audienceType: "app-url",
      audience: "https://gateway.example.com/googlechat",
      appPrincipal: "123456789012345678901", // add-on verification only; numeric OAuth client ID
      webhookPath: "/googlechat",
      botUser: "users/1234567890", // optional; helps mention detection
      allowBots: false,
      dm: {
        policy: "pairing",
        allowFrom: ["users/1234567890"],
      },
      groupPolicy: "allowlist",
      groups: {
        "spaces/AAAA": {
          enabled: true,
          requireMention: true,
          users: ["users/1234567890"],
          systemPrompt: "Short answers only.",
        },
      },
      typingIndicator: "message",
      mediaMaxMb: 20,
    },
  },
}
```

Notes:

- Service account credentials: `serviceAccountFile` (path), `serviceAccount` (inline JSON string or object), or `serviceAccountRef` (env/file SecretRef). Env vars `GOOGLE_CHAT_SERVICE_ACCOUNT` (inline JSON) and `GOOGLE_CHAT_SERVICE_ACCOUNT_FILE` (path) apply to the default account only. Multi-account setups use `channels.googlechat.accounts.<id>` with the same keys, including per-account `serviceAccountRef`.
- Default webhook path is `/googlechat` when `webhookPath` is unset; `webhookUrl` can supply the path instead.
- Group keys must be stable space ids (`spaces/<spaceId>`). Display-name keys are deprecated and logged as such.
- `dangerouslyAllowNameMatching` re-enables mutable email principal matching for allowlists (break-glass compatibility mode); doctor warns about email entries.
- Google Chat reaction actions are not exposed. The plugin uses service-account authentication, while Google Chat reaction endpoints require user authentication. Existing `actions.reactions` config is accepted for compatibility but has no effect.
- Native approval cards use Google Chat `cardsV2` button clicks, not reaction events. Approvers come from `dm.allowFrom` or `defaultTo` and must be stable numeric `users/<id>` values.
- Message actions expose text `send` only. Google Chat attachment upload requires user authentication, while this plugin uses service-account authentication, so outbound file upload is not exposed.
- `typingIndicator`: `message` (default) posts a `_<Bot> is typing..._` placeholder and edits it into the first reply; `none` disables it; `reaction` requires user OAuth and currently falls back to `message` with a logged error under service-account auth.
- Inbound attachments (first attachment per message) are downloaded through the Chat API into the media pipeline, capped by `mediaMaxMb` (default 20).
- Bot-authored messages are ignored by default. With `allowBots: true`, accepted bot messages use shared [bot loop protection](/channels/bot-loop-protection): configure `channels.defaults.botLoopProtection`, then override with `channels.googlechat.botLoopProtection` or `channels.googlechat.groups.<space>.botLoopProtection`.

Secrets reference details: [Secrets Management](/gateway/secrets).

## Troubleshooting

### 405 Method Not Allowed

If Google Cloud Logs Explorer shows errors like:

```text
status code: 405, reason phrase: HTTP error response: HTTP/1.1 405 Method Not Allowed
```

The webhook handler is not registered. Common causes:

1. **Channel not configured**: the `channels.googlechat` section is missing. Verify with:

   ```bash
   openclaw config get channels.googlechat
   ```

   If it returns "Config path not found", add the configuration (see [Config highlights](#config-highlights)).

2. **Plugin not enabled**: check plugin status:

   ```bash
   openclaw plugins list | grep googlechat
   ```

   If it shows "disabled", add `plugins.entries.googlechat.enabled: true` to your config.

3. **Gateway not restarted** after config changes:

   ```bash
   openclaw gateway restart
   ```

Verify the channel is running:

```bash
openclaw channels status
# Should show: Google Chat default: enabled, configured, ...
```

### Other issues

- `openclaw channels status --probe` surfaces auth errors and missing audience config (`audience` and `audienceType` are both required).
- If no messages arrive, confirm the Chat app's webhook URL and trigger configuration.
- If mention gating blocks replies, set `botUser` to the app's user resource name and check `requireMention`.
- `openclaw logs --follow` while sending a test message shows whether requests reach the gateway.

## Related

- [Channels Overview](/channels) — all supported channels
- [Channel Routing](/channels/channel-routing) — session routing for messages
- [Gateway configuration](/gateway/configuration)
- [Groups](/channels/groups) — group chat behavior and mention gating
- [Pairing](/channels/pairing) — DM authentication and pairing flow
- [Security](/gateway/security) — access model and hardening
