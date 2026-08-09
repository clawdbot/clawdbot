---
summary: "Expose an OpenResponses-compatible /v1/responses HTTP endpoint from the Gateway"
read_when:
  - Integrating clients that speak the OpenResponses API
  - You want item-based inputs, client tool calls, or SSE events
title: "OpenResponses API"
---

The Gateway can serve an OpenResponses-compatible `POST /v1/responses` endpoint. It is **disabled by default** and shares its port with the Gateway (WS + HTTP multiplex): `http://<gateway-host>:<port>/v1/responses`.

Requests run as a normal Gateway agent run (same codepath as `openclaw agent`), so routing, permissions, and config match your Gateway.

Enable or disable with `gateway.http.endpoints.responses.enabled`. When enabled, the same compatibility surface also serves `GET /v1/models`, `GET /v1/models/{id}`, `POST /v1/embeddings`, and `POST /v1/chat/completions`.

## Authentication, security, and routing

Operational behavior matches [OpenAI Chat Completions](/gateway/openai-http-api):

- Auth path matches `gateway.auth.mode`: shared-secret (`token`/`password`) uses `Authorization: Bearer <token-or-password>`; trusted-proxy uses identity-aware proxy headers (same-host loopback proxies need `gateway.auth.trustedProxy.allowLoopback = true`, with a same-host direct fallback via `gateway.auth.password` / `OPENCLAW_GATEWAY_PASSWORD` when no `Forwarded`/`X-Forwarded-*`/`X-Real-IP` header is present); `none` on private ingress needs no auth header. See [Trusted proxy auth](/gateway/trusted-proxy-auth).
- Treat the endpoint as full operator access to the gateway instance.
- Shared-secret auth modes ignore a narrower bearer-declared `x-openclaw-scopes` and restore the full default operator scope set: `operator.admin`, `operator.approvals`, `operator.pairing`, `operator.read`, `operator.talk.secrets`, `operator.write`. Chat turns on this endpoint are treated as owner-sender turns.
- Trusted identity-bearing HTTP modes (trusted-proxy, or `gateway.auth.mode="none"`) honor `x-openclaw-scopes` when present, otherwise fall back to the operator default scope set. Owner semantics are lost only when the caller explicitly narrows scopes and omits `operator.admin`.
- Select agents with `model: "openclaw"`, `"openclaw/default"`, `"openclaw/<agentId>"`, or the `x-openclaw-agent-id` header.
- Use `x-openclaw-model` to override the selected agent's backend model (requires `operator.admin` on identity-bearing auth paths).
- Use `x-openclaw-session-key` for explicit session routing (rejected with `400 invalid_request_error` if it uses a reserved namespace: `subagent:`, `cron:`, `acp:`).
- Use `x-openclaw-message-channel` for a non-default synthetic ingress channel context.

For the canonical explanation of agent-target models, `openclaw/default`, embeddings pass-through, and backend model overrides, see [OpenAI Chat Completions](/gateway/openai-http-api#agent-first-model-contract).

See [Operator scopes](/gateway/operator-scopes) and [Security](/gateway/security).

## Session behavior

By default the endpoint is **stateless per request** (a new session key is generated each call).

If the request includes an OpenResponses `user` string, the Gateway derives a stable session key from it so repeated calls can share an agent session.

`previous_response_id` reuses the earlier response's session when the request stays within the same agent/user/requested-session scope (matched by auth subject, agent id, and `x-openclaw-session-key`).

## Request shape

| Field                                                            | Support                                                                                                                        |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `input`                                                          | String or array of item objects.                                                                                               |
| `instructions`                                                   | Merged into the system prompt.                                                                                                 |
| `tools`                                                          | Client tool definitions (function tools).                                                                                      |
| `tool_choice`                                                    | `"auto"`, `"none"`, `"required"`, or `{ "type": "function", "name": "..." }` to filter or require client tools.                |
| `stream`                                                         | Enables SSE streaming.                                                                                                         |
| `max_output_tokens`                                              | Best-effort output limit (provider dependent).                                                                                 |
| `temperature`                                                    | Best-effort sampling temperature. Ignored by the ChatGPT-based Codex Responses backend, which uses fixed server-side sampling. |
| `top_p`                                                          | Best-effort nucleus sampling. Same Codex Responses caveat as `temperature`.                                                    |
| `user`                                                           | Stable session routing.                                                                                                        |
| `previous_response_id`                                           | Session continuity (see above).                                                                                                |
| `max_tool_calls`, `reasoning`, `metadata`, `store`, `truncation` | Accepted but currently ignored.                                                                                                |

## Items (input)

### `message`

Roles: `system`, `developer`, `user`, `assistant`.

- `system` and `developer` are appended to the system prompt.
- The most recent `user` or `function_call_output` item becomes the "current message."
- Earlier user/assistant messages are included as history for context.

### `function_call_output` (turn-based tools)

Send tool results back to the model:

```json
{
  "type": "function_call_output",
  "call_id": "call_123",
  "output": "{\"temperature\": \"72F\"}"
}
```

### `reasoning` and `item_reference`

Accepted for schema compatibility but ignored when building the prompt.

## Tools (client-side function tools)

Provide tools with `tools: [{ type: "function", name, description?, parameters? }]`.

If the agent calls a tool, the response returns a `function_call` output item. Send a follow-up request with `function_call_output` to continue the turn.

For `tool_choice: "required"` and function-pinned `tool_choice`, the endpoint narrows the exposed client function-tool set, instructs the runtime to call a client tool before responding, and rejects the turn if it does not include a matching structured client-tool call, matching the `/v1/chat/completions` contract. Non-streaming requests return `502` with an `api_error`; streaming requests emit a `response.failed` event.

## Images (`input_image`)

Supports base64 or URL sources:

```json
{
  "type": "input_image",
  "source": { "type": "url", "url": "https://example.com/image.png" }
}
```

Allowed MIME types (default): `image/jpeg`, `image/png`, `image/gif`, `image/webp`, `image/heic`, `image/heif`. Max size (default): 10MB.

## Files (`input_file`)

Supports base64 or URL sources:

```json
{
  "type": "input_file",
  "source": {
    "type": "base64",
    "media_type": "text/plain",
    "data": "SGVsbG8gV29ybGQh",
    "filename": "hello.txt"
  }
}
```

Allowed MIME types (default): `text/plain`, `text/markdown`, `text/html`, `text/csv`, `application/json`, `application/pdf`. Max size (default): 5MB.

Current behavior:

- File content is decoded and added to the **system prompt**, not the user message, so it stays ephemeral (not persisted in session history).
- Decoded file text is wrapped as **untrusted external content** before it is added, so file bytes are treated as data, not trusted instructions. The injected block uses explicit boundary markers (`<<<EXTERNAL_UNTRUSTED_CONTENT id="...">>>` / `<<<END_EXTERNAL_UNTRUSTED_CONTENT id="...">>>`) and a `Source: External` metadata line. It intentionally omits the long `SECURITY NOTICE:` banner to preserve prompt budget; the boundary markers and metadata still apply.
- PDFs are parsed for text first. If little text is found, the first pages are rasterized into images and passed to the model, and the injected file block uses the placeholder `[PDF content rendered to images]`.

PDF parsing is provided by the bundled `document-extract` plugin, which uses `clawpdf` and its packaged PDFium WebAssembly runtime for text extraction and page rendering.

URL fetch defaults:

- `files.allowUrl`: `true`
- `images.allowUrl`: `true`
- `maxUrlParts`: `8` (total URL-based `input_file` + `input_image` parts per request)
- Requests are guarded (DNS resolution, private IP blocking, redirect caps, timeouts).
- Optional hostname allowlists are supported per input type (`files.urlAllowlist`, `images.urlAllowlist`): exact host (`"cdn.example.com"`) or wildcard subdomains (`"*.assets.example.com"`, does not match the apex). Empty or omitted allowlists mean no hostname allowlist restriction.
- To disable URL-based fetches entirely, set `files.allowUrl: false` and/or `images.allowUrl: false`.

## File + image limits

The endpoint uses a built-in 20 MB request-body limit. File and image source
policy remains configurable under `gateway.http.endpoints.responses`:

```json5
{
  gateway: {
    http: {
      endpoints: {
        responses: {
          enabled: true,
          maxUrlParts: 8,
          files: {
            allowUrl: true,
            urlAllowlist: ["cdn.example.com", "*.assets.example.com"],
            allowedMimes: [
              "text/plain",
              "text/markdown",
              "text/html",
              "text/csv",
              "application/json",
              "application/pdf",
            ],
            maxBytes: 5242880,
            maxChars: 60000,
            maxRedirects: 3,
            timeoutMs: 10000,
            pdf: {
              maxPages: 4,
              maxPixels: 4000000,
              minTextChars: 200,
            },
          },
          images: {
            allowUrl: true,
            urlAllowlist: ["images.example.com"],
            allowedMimes: [
              "image/jpeg",
              "image/png",
              "image/gif",
              "image/webp",
              "image/heic",
              "image/heif",
            ],
            maxBytes: 10485760,
            maxRedirects: 3,
            timeoutMs: 10000,
          },
        },
      },
    },
  },
}
```

Defaults when omitted:

| Key                      | Default   |
| ------------------------ | --------- |
| `maxUrlParts`            | 8         |
| `files.maxBytes`         | 5MB       |
| `files.maxChars`         | 60k       |
| `files.maxRedirects`     | 3         |
| `files.timeoutMs`        | 10s       |
| `files.pdf.maxPages`     | 4         |
| `files.pdf.maxPixels`    | 4,000,000 |
| `files.pdf.minTextChars` | 200       |
| `images.maxBytes`        | 10MB      |
| `images.maxRedirects`    | 3         |
| `images.timeoutMs`       | 10s       |

HEIC/HEIF `input_image` sources are normalized to JPEG before provider delivery through the shared OpenClaw image processor (Rastermill), which falls back to a system converter (`sips`, ImageMagick, GraphicsMagick, or ffmpeg) for formats needing external codec support.

Security note: URL allowlists are enforced before fetch and on redirect hops. Allowlisting a hostname does not bypass private/internal IP blocking. For internet-exposed gateways, apply network egress controls in addition to app-level guards. See [Security](/gateway/security).

## Streaming (SSE)

Set `stream: true` to receive Server-Sent Events:

- `Content-Type: text/event-stream`
- Each event line is `event: <type>` and `data: <json>`
- Stream ends with `data: [DONE]`

Event types currently emitted: `response.created`, `response.in_progress`, `response.output_item.added`, `response.content_part.added`, `response.output_text.delta`, `response.output_text.done`, `response.content_part.done`, `response.output_item.done`, `response.completed`, `response.failed` (on error).

## Usage

`usage` is populated when the underlying provider reports token counts. OpenClaw normalizes common OpenAI-style aliases before those counters reach downstream status/session surfaces, including `input_tokens` / `output_tokens` and `prompt_tokens` / `completion_tokens`.

## Errors

Errors use a JSON object like:

```json
{ "error": { "message": "...", "type": "invalid_request_error" } }
```

Common cases: `400` invalid request body, `401` missing/invalid auth, `403` missing operator scope, `405` wrong method, `429` too many failed auth attempts (with `Retry-After`).

## Examples

Non-streaming:

```bash
curl -sS http://127.0.0.1:18789/v1/responses \
  -H 'Authorization: Bearer YOUR_TOKEN' \
  -H 'Content-Type: application/json' \
  -H 'x-openclaw-agent-id: main' \
  -d '{
    "model": "openclaw",
    "input": "hi"
  }'
```

Streaming:

```bash
curl -N http://127.0.0.1:18789/v1/responses \
  -H 'Authorization: Bearer YOUR_TOKEN' \
  -H 'Content-Type: application/json' \
  -H 'x-openclaw-agent-id: main' \
  -d '{
    "model": "openclaw",
    "stream": true,
    "input": "hi"
  }'
```

## Related

- [OpenAI chat completions](/gateway/openai-http-api)
- [Operator scopes](/gateway/operator-scopes)
- [OpenAI](/providers/openai)
