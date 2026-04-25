---
summary: "Browser-based control UI for the Gateway (chat, nodes, config)"
read_when:
  - You want to operate the Gateway from a browser
  - You want Tailnet access without SSH tunnels
title: "Control UI"
---

The Control UI is a small **Vite + Lit** single-page app served by the Gateway:

- default: `http://<host>:18789/`
- optional prefix: set `gateway.controlUi.basePath` (e.g. `/openclaw`)

It speaks **directly to the Gateway WebSocket** on the same port.

## Quick open (local)

If the Gateway is running on the same computer, open:

- [http://127.0.0.1:18789/](http://127.0.0.1:18789/) (or [http://localhost:18789/](http://localhost:18789/))

If the page fails to load, start the Gateway first: `openclaw gateway`.

Auth is supplied during the WebSocket handshake via:

- `connect.params.auth.token`
- `connect.params.auth.password`
- Tailscale Serve identity headers when `gateway.auth.allowTailscale: true`
- trusted-proxy identity headers when `gateway.auth.mode: "trusted-proxy"`

The dashboard settings panel keeps a token for the current browser tab session
and selected gateway URL; passwords are not persisted. Onboarding usually
generates a gateway token for shared-secret auth on first connect, but password
auth works too when `gateway.auth.mode` is `"password"`.

## Device pairing (first connection)

When you connect to the Control UI from a new browser or device, the Gateway
requires a **one-time pairing approval** — even if you're on the same Tailnet
with `gateway.auth.allowTailscale: true`. This is a security measure to prevent
unauthorized access.

**What you'll see:** "disconnected (1008): pairing required"

**To approve the device:**

```bash
# List pending requests
openclaw devices list

# Approve by request ID
openclaw devices approve <requestId>
```

If the browser retries pairing with changed auth details (role/scopes/public
key), the previous pending request is superseded and a new `requestId` is
created. Re-run `openclaw devices list` before approval.

If the browser is already paired and you change it from read access to
write/admin access, this is treated as an approval upgrade, not a silent
reconnect. OpenClaw keeps the old approval active, blocks the broader reconnect,
and asks you to approve the new scope set explicitly.

Once approved, the device is remembered and won't require re-approval unless
you revoke it with `openclaw devices revoke --device <id> --role <role>`. See
[Devices CLI](/cli/devices) for token rotation and revocation.

**Notes:**

- Direct local loopback browser connections (`127.0.0.1` / `localhost`) are
  auto-approved.
- Tailnet and LAN browser connects still require explicit approval, even when
  they originate from the same machine.
- Each browser profile generates a unique device ID, so switching browsers or
  clearing browser data will require re-pairing.

## Personal identity (browser-local)

The Control UI supports a per-browser personal identity (display name and
avatar) attached to outgoing messages for attribution in shared sessions. It
lives in browser storage, is scoped to the current browser profile, and is not
synced to other devices or persisted server-side beyond the normal transcript
authorship metadata on messages you actually send. Clearing site data or
switching browsers resets it to empty.

## Runtime config endpoint

The Control UI fetches its runtime settings from
`/__openclaw/control-ui-config.json`. That endpoint is gated by the same
gateway auth as the rest of the HTTP surface: unauthenticated browsers cannot
fetch it, and a successful fetch requires either an already valid gateway
token/password, Tailscale Serve identity, or a trusted-proxy identity.

## Language support

The Control UI can localize itself on first load based on your browser locale.
To override it later, open **Overview -> Gateway Access -> Language**. The
locale picker lives in the Gateway Access card, not under Appearance.

- Supported locales: `en`, `zh-CN`, `zh-TW`, `pt-BR`, `de`, `es`, `ja-JP`, `ko`, `fr`, `tr`, `uk`, `id`, `pl`, `th`
- Non-English translations are lazy-loaded in the browser.
- The selected locale is saved in browser storage and reused on future visits.
- Missing translation keys fall back to English.

## What it can do (today)

- Chat with the model via Gateway WS (`chat.history`, `chat.send`, `chat.abort`, `chat.inject`)
- Talk to OpenAI Realtime directly from the browser via WebRTC. The Gateway
  mints a short-lived Realtime client secret with `talk.realtime.session`; the
  browser sends microphone audio directly to OpenAI and relays
  `openclaw_agent_consult` tool calls back through `chat.send` for the larger
  configured OpenClaw model.
- Stream tool calls + live tool output cards in Chat (agent events)
- Channels: built-in plus bundled/external plugin channels status, QR login, and per-channel config (`channels.status`, `web.login.*`, `config.patch`)
- Instances: presence list + refresh (`system-presence`)
- Sessions: list + per-session model/thinking/fast/verbose/trace/reasoning overrides (`sessions.list`, `sessions.patch`)
- Dreams: dreaming status, enable/disable toggle, and Dream Diary reader (`doctor.memory.status`, `doctor.memory.dreamDiary`, `config.patch`)
- Cron jobs: list/add/edit/run/enable/disable + run history (`cron.*`)
- Skills: status, enable/disable, install, API key updates (`skills.*`)
- Nodes: list + caps (`node.list`)
- Exec approvals: edit gateway or node allowlists + ask policy for `exec host=gateway/node` (`exec.approvals.*`)
- Config: view/edit `~/.openclaw/openclaw.json` (`config.get`, `config.set`)
- Config: apply + restart with validation (`config.apply`) and wake the last active session
- Config writes include a base-hash guard to prevent clobbering concurrent edits
- Config writes (`config.set`/`config.apply`/`config.patch`) also preflight active SecretRef resolution for refs in the submitted config payload; unresolved active submitted refs are rejected before write
- Config schema + form rendering (`config.schema` / `config.schema.lookup`,
  including field `title` / `description`, matched UI hints, immediate child
  summaries, docs metadata on nested object/wildcard/array/composition nodes,
  plus plugin + channel schemas when available); Raw JSON editor is
  available only when the snapshot has a safe raw round-trip
- If a snapshot cannot safely round-trip raw text, Control UI forces Form mode and disables Raw mode for that snapshot
- Raw JSON editor "Reset to saved" preserves the raw-authored shape (formatting, comments, `$include` layout) instead of re-rendering a flattened snapshot, so external edits survive a reset when the snapshot can safely round-trip
- Structured SecretRef object values are rendered read-only in form text inputs to prevent accidental object-to-string corruption
- Debug: status/health/models snapshots + event log + manual RPC calls (`status`, `health`, `models.list`)
- Logs: live tail of gateway file logs with filter/export (`logs.tail`)
- Update: run a package/git update + restart (`update.run`) with a restart report

Cron jobs panel notes:

- For isolated jobs, delivery defaults to announce summary. You can switch to none if you want internal-only runs.
- Channel/target fields appear when announce is selected.
- Webhook mode uses `delivery.mode = "webhook"` with `delivery.to` set to a valid HTTP(S) webhook URL.
- For main-session jobs, webhook and none delivery modes are available.
- Advanced edit controls include delete-after-run, clear agent override, cron exact/stagger options,
  agent model/thinking overrides, and best-effort delivery toggles.
- Form validation is inline with field-level errors; invalid values disable the save button until fixed.
- Set `cron.webhookToken` to send a dedicated bearer token, if omitted the webhook is sent without an auth header.
- Deprecated fallback: stored legacy jobs with `notify: true` can still use `cron.webhook` until migrated.

## Chat behavior

- `chat.send` is **non-blocking**: it acks immediately with `{ runId, status: "started" }` and the response streams via `chat` events.
- Re-sending with the same `idempotencyKey` returns `{ status: "in_flight" }` while running, and `{ status: "ok" }` after completion.
- `chat.history` responses are size-bounded for UI safety. When transcript entries are too large, Gateway may truncate long text fields, omit heavy metadata blocks, and replace oversized messages with a placeholder (`[chat.history omitted: message too large]`).
- Assistant/generated images are persisted as managed media references and served back through authenticated Gateway media URLs, so reloads do not depend on raw base64 image payloads staying in the chat history response.
- `chat.history` also strips display-only inline directive tags from visible assistant text (for example `[[reply_to_*]]` and `[[audio_as_voice]]`), plain-text tool-call XML payloads (including `<tool_call>...</tool_call>`, `<function_call>...</function_call>`, `<tool_calls>...</tool_calls>`, `<function_calls>...</function_calls>`, and truncated tool-call blocks), and leaked ASCII/full-width model control tokens, and omits assistant entries whose whole visible text is only the exact silent token `NO_REPLY` / `no_reply`.
- During an active send and the final history refresh, the chat view keeps local
  optimistic user/assistant messages visible if `chat.history` briefly returns
  an older snapshot; the canonical transcript replaces those local messages once
  the Gateway history catches up.
- `chat.inject` appends an assistant note to the session transcript and broadcasts a `chat` event for UI-only updates (no agent run, no channel delivery).
- The chat header model and thinking pickers patch the active session immediately through `sessions.patch`; they are persistent session overrides, not one-turn-only send options.
- When fresh Gateway session usage reports show high context pressure, the chat
  composer area shows a context notice and, at recommended compaction levels, a
  compact button that runs the normal session compaction path. Stale token
  snapshots are hidden until the Gateway reports fresh usage again.
- Talk mode uses a registered realtime voice provider that supports browser
  WebRTC sessions. Configure OpenAI with `talk.provider: "openai"` plus
  `talk.providers.openai.apiKey`, or reuse the Voice Call realtime provider
  config. The browser never receives the standard OpenAI API key; it receives
  only the ephemeral Realtime client secret. Google Live realtime voice is
  supported for backend Voice Call and Google Meet bridges, but not this browser
  WebRTC path yet. The Realtime session prompt is assembled by the Gateway;
  `talk.realtime.session` does not accept caller-provided instruction overrides.
- In the Chat composer, the Talk control is the waves button next to the
  microphone dictation button. When Talk starts, the composer status row shows
  `Connecting Talk...`, then `Talk live` while audio is connected, or
  `Asking OpenClaw...` while a realtime tool call is consulting the configured
  larger model through `chat.send`.
- Stop:
  - Click **Stop** (calls `chat.abort`)
  - While a run is active, normal follow-ups queue. Click **Steer** on a queued message to inject that follow-up into the running turn.
  - Type `/stop` (or standalone abort phrases like `stop`, `stop action`, `stop run`, `stop openclaw`, `please stop`) to abort out-of-band
  - `chat.abort` supports `{ sessionKey }` (no `runId`) to abort all active runs for that session
- Abort partial retention:
  - When a run is aborted, partial assistant text can still be shown in the UI
  - Gateway persists aborted partial assistant text into transcript history when buffered output exists
  - Persisted entries include abort metadata so transcript consumers can tell abort partials from normal completion output

## Hosted embeds

Assistant messages can render hosted web content inline with the `[embed ...]`
shortcode. The iframe sandbox policy is controlled by
`gateway.controlUi.embedSandbox`:

- `strict`: disables script execution inside hosted embeds
- `scripts`: allows interactive embeds while keeping origin isolation; this is
  the default and is usually enough for self-contained browser games/widgets
- `trusted`: adds `allow-same-origin` on top of `allow-scripts` for same-site
  documents that intentionally need stronger privileges

Example:

```json5
{
  gateway: {
    controlUi: {
      embedSandbox: "scripts",
    },
  },
}
```

Use `trusted` only when the embedded document genuinely needs same-origin
behavior. For most agent-generated games and interactive canvases, `scripts` is
the safer choice.

Absolute external `http(s)` embed URLs stay blocked by default. If you
intentionally want `[embed url="https://..."]` to load third-party pages, set
`gateway.controlUi.allowExternalEmbedUrls: true`.

## Tailnet access (recommended)

### Integrated Tailscale Serve (preferred)

Keep the Gateway on loopback and let Tailscale Serve proxy it with HTTPS:

```bash
openclaw gateway --tailscale serve
```

Open:

- `https://<magicdns>/` (or your configured `gateway.controlUi.basePath`)

By default, Control UI/WebSocket Serve requests can authenticate via Tailscale identity headers
(`tailscale-user-login`) when `gateway.auth.allowTailscale` is `true`. OpenClaw
verifies the identity by resolving the `x-forwarded-for` address with
`tailscale whois` and matching it to the header, and only accepts these when the
request hits loopback with Tailscale’s `x-forwarded-*` headers. Set
`gateway.auth.allowTailscale: false` if you want to require explicit shared-secret
credentials even for Serve traffic. Then use `gateway.auth.mode: "token"` or
`"password"`.
For that async Serve identity path, failed auth attempts for the same client IP
and auth scope are serialized before rate-limit writes. Concurrent bad retries
from the same browser can therefore show `retry later` on the second request
instead of two plain mismatches racing in parallel.
Tokenless Serve auth assumes the gateway host is trusted. If untrusted local
code may run on that host, require token/password auth.

### Bind to tailnet + token

```bash
openclaw gateway --bind tailnet --token "$(openssl rand -hex 32)"
```

Then open:

- `http://<tailscale-ip>:18789/` (or your configured `gateway.controlUi.basePath`)

Paste the matching shared secret into the UI settings (sent as
`connect.params.auth.token` or `connect.params.auth.password`).

## Insecure HTTP

If you open the dashboard over plain HTTP (`http://<lan-ip>` or `http://<tailscale-ip>`),
the browser runs in a **non-secure context** and blocks WebCrypto. By default,
OpenClaw **blocks** Control UI connections without device identity.

Documented exceptions:

- localhost-only insecure HTTP compatibility with `gateway.controlUi.allowInsecureAuth=true`
- successful operator Control UI auth through `gateway.auth.mode: "trusted-proxy"`
- break-glass `gateway.controlUi.dangerouslyDisableDeviceAuth=true`

**Recommended fix:** use HTTPS (Tailscale Serve) or open the UI locally:

- `https://<magicdns>/` (Serve)
- `http://127.0.0.1:18789/` (on the gateway host)

**Insecure-auth toggle behavior:**

```json5
{
  gateway: {
    controlUi: { allowInsecureAuth: true },
    bind: "tailnet",
    auth: { mode: "token", token: "replace-me" },
  },
}
```

`allowInsecureAuth` is a local compatibility toggle only:

- It allows localhost Control UI sessions to proceed without device identity in
  non-secure HTTP contexts.
- It does not bypass pairing checks.
- It does not relax remote (non-localhost) device identity requirements.

**Break-glass only:**

```json5
{
  gateway: {
    controlUi: { dangerouslyDisableDeviceAuth: true },
    bind: "tailnet",
    auth: { mode: "token", token: "replace-me" },
  },
}
```

`dangerouslyDisableDeviceAuth` disables Control UI device identity checks and is a
severe security downgrade. Revert quickly after emergency use.

Trusted-proxy note:

- successful trusted-proxy auth can admit **operator** Control UI sessions without
  device identity
- this does **not** extend to node-role Control UI sessions
- same-host loopback reverse proxies still do not satisfy trusted-proxy auth; see
  [Trusted proxy auth](/gateway/trusted-proxy-auth)

See [Tailscale](/gateway/tailscale) for HTTPS setup guidance.

## Content Security Policy

The Control UI ships with a tight `img-src` policy: only **same-origin** assets and `data:` URLs are allowed. Remote `http(s)` and protocol-relative image URLs are rejected by the browser and do not issue network fetches.

What this means in practice:

- Avatars and images served under relative paths (for example `/avatars/<id>`) still render.
- Inline `data:image/...` URLs still render (useful for in-protocol payloads).
- Remote avatar URLs emitted by channel metadata are stripped at the Control UI's avatar helpers and replaced with the built-in logo/badge, so a compromised or malicious channel cannot force arbitrary remote image fetches from an operator browser.

You do not need to change anything to get this behavior — it is always on and not configurable.

## Avatar route auth

When gateway auth is configured, the Control UI avatar endpoint requires the same gateway token as the rest of the API:

- `GET /avatar/<agentId>` returns the avatar image only to authenticated callers. `GET /avatar/<agentId>?meta=1` returns the avatar metadata under the same rule.
- Unauthenticated requests to either route are rejected (matching the sibling assistant-media route). This prevents the avatar route from leaking agent identity on hosts that are otherwise protected.
- The Control UI itself forwards the gateway token as a bearer header when fetching avatars, and uses authenticated blob URLs so the image still renders in dashboards.

If you disable gateway auth (not recommended on shared hosts), the avatar route also becomes unauthenticated, in line with the rest of the gateway.

## Building the UI

The Gateway serves static files from `dist/control-ui`. Build them with:

```bash
pnpm ui:build
```

Optional absolute base (when you want fixed asset URLs):

```bash
OPENCLAW_CONTROL_UI_BASE_PATH=/openclaw/ pnpm ui:build
```

For local development (separate dev server):

```bash
pnpm ui:dev
```

Then point the UI at your Gateway WS URL (e.g. `ws://127.0.0.1:18789`).

## Debugging/testing: dev server + remote Gateway

The Control UI is static files; the WebSocket target is configurable and can be
different from the HTTP origin. This is handy when you want the Vite dev server
locally but the Gateway runs elsewhere.

1. Start the UI dev server: `pnpm ui:dev`
2. Open a URL like:

```text
http://localhost:5173/?gatewayUrl=ws://<gateway-host>:18789
```

Optional one-time auth (if needed):

```text
http://localhost:5173/?gatewayUrl=wss://<gateway-host>:18789#token=<gateway-token>
```

Notes:

- `gatewayUrl` is stored in localStorage after load and removed from the URL.
- `token` should be passed via the URL fragment (`#token=...`) whenever possible. Fragments are not sent to the server, which avoids request-log and Referer leakage. Legacy `?token=` query params are still imported once for compatibility, but only as a fallback, and are stripped immediately after bootstrap.
- `password` is kept in memory only.
- When `gatewayUrl` is set, the UI does not fall back to config or environment credentials.
  Provide `token` (or `password`) explicitly. Missing explicit credentials is an error.
- Use `wss://` when the Gateway is behind TLS (Tailscale Serve, HTTPS proxy, etc.).
- `gatewayUrl` is only accepted in a top-level window (not embedded) to prevent clickjacking.
- Non-loopback Control UI deployments must set `gateway.controlUi.allowedOrigins`
  explicitly (full origins). This includes remote dev setups.
- Do not use `gateway.controlUi.allowedOrigins: ["*"]` except for tightly controlled
  local testing. It means allow any browser origin, not “match whatever host I am
  using.”
- `gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback=true` enables
  Host-header origin fallback mode, but it is a dangerous security mode.

Example:

```json5
{
  gateway: {
    controlUi: {
      allowedOrigins: ["http://localhost:5173"],
    },
  },
}
```

Remote access setup details: [Remote access](/gateway/remote).

## Related

- [Dashboard](/web/dashboard) — gateway dashboard
- [WebChat](/web/webchat) — browser-based chat interface
- [TUI](/web/tui) — terminal user interface
- [Health Checks](/gateway/health) — gateway health monitoring
