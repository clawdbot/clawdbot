---
summary: "Webhook ingress for wake and isolated agent runs"
read_when:
  - Adding or changing webhook endpoints
  - Wiring external systems into Moltbot
---

# Webhooks

Gateway can expose a small HTTP webhook endpoint for external triggers.

## Enable

```json5
{
  hooks: {
    enabled: true,
    token: "shared-secret",
    path: "/hooks"
  }
}
```

Notes:
- `hooks.token` is required when `hooks.enabled=true`.
- `hooks.path` defaults to `/hooks`.

## Auth

Every request must include the hook token. Prefer headers:
- `Authorization: Bearer <token>` (recommended)
- `x-moltbot-token: <token>`
- `?token=<token>` (deprecated; logs a warning and will be removed in a future major release)

## Endpoints

### `POST /hooks/wake`

Payload:
```json
{ "text": "System line", "mode": "now" }
```

- `text` **required** (string): The description of the event (e.g., "New email received").
- `mode` optional (`now` | `next-heartbeat`): Whether to trigger an immediate heartbeat (default `now`) or wait for the next periodic check.

Effect:
- Enqueues a system event for the **main** session
- If `mode=now`, triggers an immediate heartbeat

### `POST /hooks/agent`

Payload:
```json
{
  "message": "Run this",
  "name": "Email",
  "sessionKey": "hook:email:msg-123",
  "wakeMode": "now",
  "deliver": true,
  "channel": "last",
  "to": "+15551234567",
  "model": "openai/gpt-5.2-mini",
  "thinking": "low",
  "timeoutSeconds": 120
}
```

- `message` **required** (string): The prompt or message for the agent to process.
- `name` optional (string): Human-readable name for the hook (e.g., "GitHub"), used as a prefix in session summaries.
- `sessionKey` optional (string): The key used to identify the agent's session. Defaults to a random `hook:<uuid>`. Using a consistent key allows for a multi-turn conversation within the hook context.
- `wakeMode` optional (`now` | `next-heartbeat`): Whether to trigger an immediate heartbeat (default `now`) or wait for the next periodic check.
- `deliver` optional (boolean): If `true`, the agent's response will be sent to the messaging channel. Defaults to `true`. Responses that are only heartbeat acknowledgments are automatically skipped.
- `channel` optional (string): The messaging channel for delivery. One of: `last`, `whatsapp`, `telegram`, `discord`, `slack`, `mattermost` (plugin), `signal`, `imessage`, `msteams`. Defaults to `last`.
- `to` optional (string): The recipient identifier for the channel (e.g., phone number for WhatsApp/Signal, chat ID for Telegram, channel ID for Discord/Slack/Mattermost (plugin), conversation ID for MS Teams). Defaults to the last recipient in the main session.
- `model` optional (string): Model override (e.g., `anthropic/claude-3-5-sonnet` or an alias). Must be in the allowed model list if restricted.
- `thinking` optional (string): Thinking level override (e.g., `low`, `medium`, `high`).
- `timeoutSeconds` optional (number): Maximum duration for the agent run in seconds.

Effect:
- Runs an **isolated** agent turn (own session key)
- Always posts a summary into the **main** session
- If `wakeMode=now`, triggers an immediate heartbeat

### `POST /hooks/<name>` (mapped)

Custom hook names are resolved via `hooks.mappings` (see configuration). A mapping can
turn arbitrary payloads into `wake` or `agent` actions, with optional templates or
code transforms.

Mapping options (summary):
- `hooks.presets: ["gmail"]` enables the built-in Gmail mapping.
- `hooks.mappings` lets you define `match`, `action`, and templates in config.
- `hooks.transformsDir` + `transform.module` loads a JS/TS module for custom logic.
- Use `match.source` to keep a generic ingest endpoint (payload-driven routing).
- TS transforms require a TS loader (e.g. `bun` or `tsx`) or precompiled `.js` at runtime.
- Set `deliver: true` + `channel`/`to` on mappings to route replies to a chat surface
  (`channel` defaults to `last` and falls back to WhatsApp).
- `allowUnsafeExternalContent: true` disables the external content safety wrapper for that hook
  (dangerous; only for trusted internal sources).
- `moltbot webhooks gmail setup` writes `hooks.gmail` config for `moltbot webhooks gmail run`.
See [Gmail Pub/Sub](/automation/gmail-pubsub) for the full Gmail watch flow.

## Responses

- `200` for `/hooks/wake`
- `202` for `/hooks/agent` (async run started)
- `401` on auth failure
- `400` on invalid payload
- `413` on oversized payloads

## Examples

```bash
curl -X POST http://127.0.0.1:18789/hooks/wake \
  -H 'Authorization: Bearer SECRET' \
  -H 'Content-Type: application/json' \
  -d '{"text":"New email received","mode":"now"}'
```

```bash
curl -X POST http://127.0.0.1:18789/hooks/agent \
  -H 'x-moltbot-token: SECRET' \
  -H 'Content-Type: application/json' \
  -d '{"message":"Summarize inbox","name":"Email","wakeMode":"next-heartbeat"}'
```

### Use a different model

Add `model` to the agent payload (or mapping) to override the model for that run:

```bash
curl -X POST http://127.0.0.1:18789/hooks/agent \
  -H 'x-moltbot-token: SECRET' \
  -H 'Content-Type: application/json' \
  -d '{"message":"Summarize inbox","name":"Email","model":"openai/gpt-5.2-mini"}'
```

If you enforce `agents.defaults.models`, make sure the override model is included there.

```bash
curl -X POST http://127.0.0.1:18789/hooks/gmail \
  -H 'Authorization: Bearer SECRET' \
  -H 'Content-Type: application/json' \
  -d '{"source":"gmail","messages":[{"from":"Ada","subject":"Hello","snippet":"Hi"}]}'
```

## Security

- Keep hook endpoints behind loopback, tailnet, or trusted reverse proxy.
- Use a dedicated hook token; do not reuse gateway auth tokens.
- Avoid including sensitive raw payloads in webhook logs.
- Hook payloads are treated as untrusted and wrapped with safety boundaries by default.
  If you must disable this for a specific hook, set `allowUnsafeExternalContent: true`
  in that hook's mapping (dangerous).
