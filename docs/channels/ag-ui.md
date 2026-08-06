---
summary: "AG-UI protocol endpoint for CopilotKit and other AG-UI clients"
title: AG-UI
read_when:
  - You want to drive an OpenClaw agent from a web app or custom frontend
  - You are wiring CopilotKit (or another AG-UI client) to your Gateway
  - You need to choose between the operator-token route and device pairing
---

AG-UI is a protocol for connecting frontends to agents over HTTP with
Server-Sent Events. This channel exposes your OpenClaw agent as an AG-UI
endpoint, so an AG-UI-compatible client — such as
[CopilotKit](https://docs.copilotkit.ai) — can stream a conversation, render
tool calls as UI, and execute tools in the browser.

Unlike the chat channels, there is no third-party service to connect to: the
Gateway itself serves the endpoint, and you point your frontend at it.

## Quick start

1. Enable the channel in `~/.openclaw/openclaw.json`:

```json5
{
  channels: {
    "ag-ui": {
      enabled: true,
    },
  },
}
```

2. Restart the Gateway, then send a turn using your Gateway token:

```bash
curl -N http://localhost:8000/v1/ag-ui/operator \
  -H "Authorization: Bearer $OPENCLAW_GATEWAY_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: text/event-stream" \
  -d '{"messages":[{"role":"user","content":"Say hello in 3 words"}]}'
```

You get back an SSE stream of AG-UI events: `RUN_STARTED`, the assistant's
`TEXT_MESSAGE_*` events, any `TOOL_CALL_*` events, then `RUN_FINISHED`.

## Choosing a route

| Route                     | Auth                                      | Use for                                                                                                             |
| ------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `POST /v1/ag-ui/operator` | Gateway token, scoped to `operator.write` | Trusted server-side callers — a backend integration, or an AG-UI runtime proxy that keeps the token on your server. |
| `POST /v1/ag-ui`          | Device pairing (per-client token)         | Untrusted or external clients that pair once and receive their own token.                                           |

Pick by where the credential lives. The operator route expects the Gateway token
to stay on a server you control, so browser apps use one of the two paths built
for them: pair through `/v1/ag-ui`, which issues each client its own token and
answers browser preflight directly, or keep the token server-side behind an
AG-UI runtime proxy — which is what CopilotKit's runtime does for you. Both give
a browser a first-class path to the agent without ever exposing your Gateway
token to the page.

## Using it from CopilotKit

CopilotKit's runtime runs on your server, holds the Gateway token, and proxies
the browser's requests to the endpoint. That keeps the credential server-side
and gives you a place to add your own authentication, rate limiting, or request
logging before a turn reaches the agent.

Frontend tools declared in the browser are forwarded per request, so the agent
can call them and the browser executes them — that round trip needs no
extra Gateway configuration.

## Selecting an agent

Send `X-OpenClaw-Agent-Id` to choose which configured agent runs the turn. An
unknown id is rejected with `400` rather than silently falling back to the
default agent.

## Per-user sessions

For a multi-user web app, send `X-OpenClaw-Session-Key`. The value is composed
under the route-derived session key, so each authenticated user keeps their own
conversation history. Treat it as a trusted-proxy-only header — set it on your
server, next to the auth check that establishes who the user is, never from
browser-supplied input.

## Notes

- Streaming is Server-Sent Events only; the endpoint always responds
  `Content-Type: text/event-stream`.
- One run at a time per session. A second overlapping request for the same
  session is refused with `409` so two runs cannot interleave on one stream.
- Reasoning-capable models surface their thinking as AG-UI `REASONING_*`
  events. Disable with `surfaceReasoning: false` in the channel defaults.

See the plugin README for the full event mapping, deployment topology, and
security contract.
