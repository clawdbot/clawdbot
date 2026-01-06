---
summary: "Webhook ingress for wake and isolated agent runs"
read_when:
  - Adding or changing webhook endpoints
  - Wiring external systems into Clawdbot
---

# Webhooks

Gateway can expose a small HTTP webhook surface for external triggers.

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

Every request must include the hook token:
- `Authorization: Bearer <token>`
- or `x-clawdbot-token: <token>`
- or `?token=<token>`

## Endpoints

### `POST /hooks/wake`

Payload:
```json
{ "text": "System line", "mode": "now" }
```

- `text` required (string)
- `mode` optional: `now` | `next-heartbeat` (default `now`)

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
  "deliver": false,
  "channel": "last",
  "to": "+15551234567",
  "thinking": "low",
  "timeoutSeconds": 120
}
```

- `message` required (string)
- `name` optional (used in the summary prefix)
- `sessionKey` optional (default random `hook:<uuid>`)
- `wakeMode` optional: `now` | `next-heartbeat` (default `now`)
- `deliver` optional (default `false`)
- `channel` optional: `last` | `whatsapp` | `telegram`
- `to` optional (channel-specific target)
- `thinking` optional (override)
- `timeoutSeconds` optional

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
- TS transforms require a TS loader (e.g. `bun`) or precompiled `.js` at runtime.
- `clawdbot hooks gmail setup` writes `hooks.gmail` config for `clawdbot hooks gmail run`.

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
  -H 'x-clawdbot-token: SECRET' \
  -H 'Content-Type: application/json' \
  -d '{"message":"Summarize inbox","name":"Email","wakeMode":"next-heartbeat"}'
```

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
