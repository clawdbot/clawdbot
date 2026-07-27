---
summary: "Publish redacted local coding sessions into a shared read-only OpenClaw catalog"
read_when:
  - Sharing a Claude Code or Codex session with trusted Gateway operators
  - Configuring an authenticated session-ingest endpoint without connecting a node
  - Auditing what Beam stores and exposes
title: "Beam plugin"
---

The bundled `beam` plugin receives a sanitized coding-session snapshot over authenticated HTTP and presents it in the Control UI's existing external-session catalog. The source computer sends text out; OpenClaw never connects back to that computer and receives no filesystem, terminal, tool, or node capability.

Beam ships with OpenClaw but is disabled by default. When enabled, it registers:

- `POST /api/v1/beam/sessions`
- the read-only **Beam** session catalog in the Control UI sidebar

## Enable

```bash
openclaw plugins enable beam
openclaw gateway restart
```

Equivalent config:

```json5
{
  plugins: {
    entries: {
      beam: { enabled: true },
    },
  },
}
```

Disable the plugin when the ingest route is not needed:

```bash
openclaw plugins disable beam
openclaw gateway restart
```

## Authentication

The receiver uses normal Gateway HTTP authentication. It is not an anonymous upload endpoint.

- With `gateway.auth.mode: "trusted-proxy"`, send requests through the configured identity-aware proxy. Beam relies on Gateway authentication but does not persist proxy identity headers as uploader attribution.
- With token or password auth, send `Authorization: Bearer <gateway-token-or-password>`.
- Do not enable Beam with `gateway.auth.mode: "none"` unless another private ingress fully authenticates every request.

A Cloudflare Access-protected deployment can authenticate a local CLI without exposing a GitHub token:

```bash
cloudflared access login https://gateway.example.com
cloudflared access curl https://gateway.example.com/api/v1/beam/sessions \
  -H 'Content-Type: application/json' \
  --data-binary @sanitized-beam.json
```

The `beam` skill in [openclaw/agent-skills](https://github.com/openclaw/agent-skills) handles local transcript discovery, redaction, Cloudflare Access login, and upload for Claude Code and Codex.

## Request

```http
POST /api/v1/beam/sessions
Content-Type: application/json
```

```json
{
  "version": 1,
  "beamId": "0123456789abcdef0123456789abcdef",
  "source": "claude",
  "title": "Fix the upload flow",
  "updatedAt": "2026-07-20T12:00:00.000Z",
  "completed": false,
  "items": [
    { "type": "userMessage", "text": "Fix the upload flow." },
    { "type": "agentMessage", "text": "Implemented and tested." },
    { "type": "other", "text": "3 read, 2 write, 1 execute; raw tool outputs dropped: 4" }
  ]
}
```

The schema is closed. Beam rejects unknown fields, invalid item types, empty text, more than 200 items, item text over 6,000 characters, non-JSON requests, and bodies over 56 KiB.

A successful upload returns the stable Beam id and a relative Control UI URL:

```json
{
  "ok": true,
  "beamId": "0123456789abcdef0123456789abcdef",
  "url": "/chat?session=catalog%3Abeam%3Agateway%3A0123456789abcdef0123456789abcdef"
}
```

Uploading the same `beamId` updates the existing catalog row. A completed upload sets the row status to `completed`; earlier updates display as `live`.

## Storage and visibility

Beam stores sanitized payloads in OpenClaw's shared SQLite-backed plugin state:

- at most 500 sessions
- seven-day retention refreshed by each update
- oldest-entry eviction when the catalog reaches its bound
- server receipt time controls catalog ordering; clients cannot move themselves ahead with a forged timestamp

The catalog is intentionally shared across the Gateway operator domain. Every client with `operator.read` can view every beamed session, while uploads require `operator.write` or `operator.admin`. Uploader identity is not retained, and any write-authorized operator that knows a Beam id can update that row. OpenClaw operator scopes are not tenant isolation; use a separate Gateway when sessions must be isolated between teams or machines.

## Security boundary

Beam is passive session publication, not remote control.

- It has no `continueSession`, archive, terminal, tool, or node capability.
- It accepts text-only normalized transcript items, not HTML, scripts, archives, attachments, or server-fetched URLs.
- The official skill removes raw tool results, reasoning, prompts, local paths, credentials, cookies, and auth material before upload.
- The receiver still treats every transcript as untrusted text. Copying a beamed transcript into a new agent session is a separate operator action.
- Requests are rate-limited and concurrency-limited before the body is read.

## Troubleshooting

`404 Not Found`

: The Beam plugin is disabled, the Gateway has not restarted since enablement, or the request is reaching another Gateway.

`401 Unauthorized`

: The request did not satisfy Gateway HTTP auth. Check the bearer credential or trusted-proxy/Access session.

`405 Method Not Allowed`

: The receiver accepts only `POST`.

`413 Payload Too Large`

: The serialized request exceeded 56 KiB. The official skill drops older sanitized messages until the snapshot fits.

`429 Too Many Requests`

: The authenticated client exceeded the bounded request or concurrency limit. Retry after the current minute window.

## Related

- [Control UI](/web/control-ui)
- [Operator scopes](/gateway/operator-scopes)
- [Trusted proxy auth](/gateway/trusted-proxy-auth)
- [Plugin management](/plugins/manage-plugins)
