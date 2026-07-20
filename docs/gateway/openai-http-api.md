---
summary: "Expose an OpenAI-compatible /v1/chat/completions HTTP endpoint from the Gateway"
read_when:
  - Integrating tools that expect OpenAI Chat Completions
title: "OpenAI chat completions"
---

The Gateway can serve a small OpenAI-compatible Chat Completions surface. It is **disabled by default**.

Once enabled, it serves all of these on the same port as the Gateway (WS + HTTP multiplex):

| Method | Path                   |
| ------ | ---------------------- |
| POST   | `/v1/chat/completions` |
| GET    | `/v1/models`           |
| GET    | `/v1/models/{id}`      |
| POST   | `/v1/embeddings`       |
| POST   | `/v1/responses`        |

Requests run as a normal Gateway agent run (same codepath as `openclaw agent`), so routing, permissions, and config match your Gateway.

## Enabling the endpoint

```json5
{
  gateway: {
    http: {
      endpoints: {
        chatCompletions: { enabled: true },
      },
    },
  },
}
```

Set `enabled: false` (or omit it) to disable.

## Security boundary (important)

Treat this endpoint as **full operator access** to the gateway instance:

- A valid Gateway token/password for this endpoint is equivalent to an owner/operator credential, not a narrow per-user scope.
- Requests run through the same control-plane agent path as trusted operator actions, so if the target agent's policy allows sensitive tools, this endpoint can use them.
- Keep it on loopback/tailnet/private ingress only. Do not expose it to the public internet.

Auth matrix:

| Auth path                                                                                            | Behavior                                                                                                                                                                                                                                                                                                  |
| ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gateway.auth.mode="token"` or `"password"` + `Authorization: Bearer ...`                            | Proves possession of the shared gateway secret. Ignores any `x-openclaw-scopes` header and restores the full default operator scope set: `operator.admin`, `operator.approvals`, `operator.pairing`, `operator.read`, `operator.talk.secrets`, `operator.write`. Treats chat turns as owner-sender turns. |
| Trusted identity-bearing HTTP (trusted-proxy auth, or `gateway.auth.mode="none"` on private ingress) | Honors `x-openclaw-scopes` when present; falls back to the default operator scope set when absent. Loses owner semantics only when the caller explicitly narrows scopes and omits `operator.admin`. Requires `operator.admin` for owner-level controls such as `x-openclaw-model`.                        |

See [Operator scopes](/gateway/operator-scopes), [Security](/gateway/security), and [Remote access](/gateway/remote).

## Authentication

Uses the Gateway auth configuration (see [Trusted proxy auth](/gateway/trusted-proxy-auth) for that mode's details):

| Mode                                | How to authenticate                                                                                                                                                                     |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gateway.auth.mode="token"`         | `Authorization: Bearer <token>`. Set via `gateway.auth.token` or `OPENCLAW_GATEWAY_TOKEN`.                                                                                              |
| `gateway.auth.mode="password"`      | `Authorization: Bearer <password>`. Set via `gateway.auth.password` or `OPENCLAW_GATEWAY_PASSWORD`.                                                                                     |
| `gateway.auth.mode="trusted-proxy"` | Route through the configured identity-aware proxy; it injects the required identity headers. Same-host loopback proxies need explicit `gateway.auth.trustedProxy.allowLoopback = true`. |
| `gateway.auth.mode="none"`          | No auth header required (private ingress only).                                                                                                                                         |

Notes:

- Same-host callers that bypass the proxy on a `trusted-proxy` gateway can fall back to `gateway.auth.password` / `OPENCLAW_GATEWAY_PASSWORD` directly. Any `Forwarded`, `X-Forwarded-*`, or `X-Real-IP` header evidence keeps the request on the trusted-proxy path instead.
- If `gateway.auth.rateLimit` is configured and too many auth attempts fail, the endpoint returns `429` with a `Retry-After` header.

## When to use this endpoint

- Prefer this over adding a new built-in channel when your integration is just another operator/client surface for the same gateway.
- For native mobile clients that connect directly to a remote gateway, prefer [WebChat](/web/webchat) or the [Gateway Protocol](/gateway/protocol) with the paired-device bootstrap/device-token flow, so the device does not need a shared HTTP token/password.
- Build a channel plugin instead when integrating an external messaging network with its own users, rooms, webhook delivery, or outbound transport. See [Building plugins](/plugins/building-plugins).

## Agent-first model contract

OpenClaw treats the OpenAI `model` field as an **agent target**, not a raw provider model id.

| `model` value                                | Routes to                                                                                                                |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `openclaw`                                   | Configured default agent                                                                                                 |
| `openclaw/default`                           | Configured default agent (stable alias; safe to hardcode even if the real default agent id changes between environments) |
| `openclaw/<agentId>` or `openclaw:<agentId>` | Specific agent                                                                                                           |
| `agent:<agentId>`                            | Specific agent (compatibility alias)                                                                                     |

Optional request headers:

| Header                                          | Effect                                                                                                                                                                                                                                                                      |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `x-openclaw-model: <provider/model-or-bare-id>` | Overrides the backend model for the selected agent. Shared-secret bearer callers can use this directly; identity-bearing callers (trusted-proxy, or private no-auth ingress with `x-openclaw-scopes`) need `operator.admin`, otherwise `403 missing scope: operator.admin`. |
| `x-openclaw-agent-id: <agentId>`                | Compatibility override for agent selection.                                                                                                                                                                                                                                 |
| `x-openclaw-session-key: <sessionKey>`          | Explicit session routing. Rejected with `400 invalid_request_error` if it uses a reserved internal namespace (`subagent:`, `cron:`, `acp:`).                                                                                                                                |
| `x-openclaw-message-channel: <channel>`         | Sets the synthetic ingress channel context for channel-aware prompts/policies.                                                                                                                                                                                              |

`/v1/models` lists top-level agent targets (`openclaw`, `openclaw/default`, `openclaw/<agentId>`), not backend provider models and not sub-agents; sub-agents stay internal execution topology. If you omit `x-openclaw-model`, the selected agent runs with its normal configured model.

`/v1/embeddings` uses the same agent-target `model` ids. Send `x-openclaw-model` (from a shared-secret caller, or an identity-bearing caller with `operator.admin`) to pick a specific embedding model; otherwise the request uses the selected agent's normal embedding setup.

## Session behavior

By default the endpoint is **stateless per request** (a new session key is generated each call).

If the request includes an OpenAI `user` string, the Gateway derives a stable session key from it so repeated calls can share an agent session. For custom apps, reuse the same `user` value per conversation thread; avoid account-level identifiers unless you want multiple conversations/devices to share one OpenClaw session. Use `x-openclaw-session-key` only when you need explicit routing control across multiple clients/threads, with application-owned keys that avoid the reserved namespaces above.

## Request limits

The endpoint uses built-in limits of 20 MB per request body, 8 `image_url`
parts from the latest user message, and 20 MB of cumulative decoded image
data. Image source policy remains configurable under
`gateway.http.endpoints.chatCompletions.images`:

```json5
{
  gateway: {
    http: {
      endpoints: {
        chatCompletions: {
          enabled: true,
          images: {
            allowUrl: false,
            urlAllowlist: ["cdn.example.com", "*.assets.example.com"],
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

Image settings default to:

| Key                   | Default                                                             |
| --------------------- | ------------------------------------------------------------------- |
| `images.allowUrl`     | `false` (URL-sourced `image_url` parts are rejected unless enabled) |
| `images.maxBytes`     | 10MB per image                                                      |
| `images.maxRedirects` | 3                                                                   |
| `images.timeoutMs`    | 10s                                                                 |

HEIC/HEIF `image_url` sources are accepted and normalized to JPEG before provider delivery through the shared OpenClaw image processor (Rastermill), which falls back to a system converter (`sips`, ImageMagick, GraphicsMagick, or ffmpeg) for formats needing external codec support.

Security note: allowlisting a hostname does not bypass private/internal IP blocking. For internet-exposed gateways, apply network egress controls in addition to app-level guards. See [Security](/gateway/security).

## Chat tool contract

`/v1/chat/completions` supports a function-tool subset compatible with common OpenAI Chat clients.

### Supported request fields

| Field                      | Notes                                                                                                                                         |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `tools`                    | Array of `{ "type": "function", "function": { ... } }`                                                                                        |
| `tool_choice`              | `"auto"`, `"none"`, `"required"`, or `{ "type": "function", "function": { "name": "..." } }`                                                  |
| `messages[*].role: "tool"` | Follow-up turns                                                                                                                               |
| `messages[*].tool_call_id` | Binds a tool result back to a prior tool call                                                                                                 |
| `max_completion_tokens`    | Number; per-call cap on total completion tokens (reasoning tokens included). Current field name; used when both it and `max_tokens` are sent. |
| `max_tokens`               | Number; legacy alias, ignored when `max_completion_tokens` is also present.                                                                   |
| `temperature`              | Number 0-2; best-effort, forwarded to the upstream provider. `400 invalid_request_error` if out of range.                                     |
| `top_p`                    | Number 0-1; best-effort. `400 invalid_request_error` if out of range.                                                                         |
| `frequency_penalty`        | Number -2.0 to 2.0; best-effort. `400 invalid_request_error` if out of range.                                                                 |
| `presence_penalty`         | Number -2.0 to 2.0; best-effort. `400 invalid_request_error` if out of range.                                                                 |
| `seed`                     | Integer; best-effort. `400 invalid_request_error` for non-integer values.                                                                     |
| `stop`                     | String or array of up to 4 strings; best-effort. `400 invalid_request_error` for more than 4 sequences or non-string/empty entries.           |

All sampling and token-cap fields ride the same agent stream-param channel and are forwarded best-effort:

- Token cap: the wire field name is chosen by the provider transport: `max_completion_tokens` for OpenAI-family endpoints, `max_tokens` for providers that only accept the legacy name (Mistral, Chutes).
- `stop` maps to the transport's stop field: `stop` for Chat Completions backends, `stop_sequences` for Anthropic. The OpenAI Responses API has no stop parameter, so `stop` is not applied on Responses-backed models.
- The ChatGPT-based Codex Responses backend uses fixed server-side sampling and strips `temperature`/`top_p` (along with `max_output_tokens`, `metadata`, `prompt_cache_retention`, `service_tier`) before the request reaches that backend.

### Unsupported variants

Returns `400 invalid_request_error` for:

- non-array `tools`, non-function tool entries, or missing `tool.function.name`
- `tool_choice` variants such as `allowed_tools` and `custom`
- `tool_choice.function.name` values that do not match a provided tool

For `tool_choice: "required"` and function-pinned `tool_choice`, the endpoint narrows the exposed client function-tool set, instructs the runtime to call a client tool before responding, and errors if the agent response has no matching structured client-tool call. This applies to the caller-supplied HTTP `tools` list, not every internal OpenClaw agent tool.

### Non-streaming tool response shape

When the agent calls tools, the response uses:

- `choices[0].finish_reason = "tool_calls"`
- `choices[0].message.tool_calls[]` entries with `id`, `type: "function"`, `function.name`, `function.arguments` (JSON string)
- Assistant commentary before the tool call, in `choices[0].message.content` (possibly empty)

### Streaming tool response shape

When `stream: true`, tool calls arrive as incremental SSE chunks: an initial assistant role delta, optional assistant commentary deltas, one or more `delta.tool_calls` chunks carrying tool identity and argument fragments, then a final chunk with `finish_reason: "tool_calls"` and `data: [DONE]`.

If `stream_options.include_usage=true`, a trailing usage chunk is emitted before `[DONE]`.

### Tool follow-up loop

After receiving `tool_calls`, execute the requested function(s) and send a follow-up request that includes the prior assistant tool-call message plus one or more `role: "tool"` messages with matching `tool_call_id`. This continues the same agent reasoning loop to produce the final answer.

## Streaming (SSE)

Set `stream: true` to receive Server-Sent Events:

- `Content-Type: text/event-stream`
- Each event line is `data: <json>`
- Stream ends with `data: [DONE]`

## Open WebUI quick setup

- Base URL: `http://127.0.0.1:18789/v1`
- Docker on macOS base URL: `http://host.docker.internal:18789/v1`
- API key: your Gateway bearer token
- Model: `openclaw/default`

Expected behavior: `GET /v1/models` lists `openclaw/default`, and Open WebUI uses it as the chat model id. For a specific backend provider/model, set the agent's normal default model, or send `x-openclaw-model` (shared-secret caller, or identity-bearing caller with `operator.admin`).

Quick smoke test:

```bash
curl -sS http://127.0.0.1:18789/v1/models \
  -H 'Authorization: Bearer YOUR_TOKEN'
```

If that returns `openclaw/default`, most Open WebUI setups can connect with the same base URL and token.

## Examples

Stable session for one app conversation:

```bash
curl -sS http://127.0.0.1:18789/v1/chat/completions \
  -H 'Authorization: Bearer YOUR_TOKEN' \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "openclaw/default",
    "user": "conv:YOUR_CONVERSATION_ID",
    "messages": [{"role":"user","content":"Summarize my tasks for today"}]
  }'
```

Reuse the same `user` value on later calls for that conversation to continue the same agent session.

Non-streaming:

```bash
curl -sS http://127.0.0.1:18789/v1/chat/completions \
  -H 'Authorization: Bearer YOUR_TOKEN' \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "openclaw/default",
    "messages": [{"role":"user","content":"hi"}]
  }'
```

Streaming:

```bash
curl -N http://127.0.0.1:18789/v1/chat/completions \
  -H 'Authorization: Bearer YOUR_TOKEN' \
  -H 'Content-Type: application/json' \
  -H 'x-openclaw-model: openai/gpt-5.4' \
  -d '{
    "model": "openclaw/research",
    "stream": true,
    "messages": [{"role":"user","content":"hi"}]
  }'
```

List models:

```bash
curl -sS http://127.0.0.1:18789/v1/models \
  -H 'Authorization: Bearer YOUR_TOKEN'
```

Fetch one model:

```bash
curl -sS http://127.0.0.1:18789/v1/models/openclaw%2Fdefault \
  -H 'Authorization: Bearer YOUR_TOKEN'
```

Create embeddings:

```bash
curl -sS http://127.0.0.1:18789/v1/embeddings \
  -H 'Authorization: Bearer YOUR_TOKEN' \
  -H 'Content-Type: application/json' \
  -H 'x-openclaw-model: openai/text-embedding-3-small' \
  -d '{
    "model": "openclaw/default",
    "input": ["alpha", "beta"]
  }'
```

`/v1/embeddings` supports `input` as a string or array of strings.

## Related

- [Configuration reference](/gateway/configuration-reference)
- [Operator scopes](/gateway/operator-scopes)
- [OpenAI](/providers/openai)
