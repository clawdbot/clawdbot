---
summary: "Connect external agents to OpenClaw through the A2A 1.0 JSON-RPC protocol"
read_when:
  - You want an A2A-compliant agent to discover and message OpenClaw
  - You need to configure authenticated A2A peers or outbound agent messages
title: "A2A"
---

The A2A channel plugin connects OpenClaw to other agents through the Linux Foundation [Agent2Agent protocol](https://a2a-protocol.org). External agents discover the gateway through a public Agent Card and submit authenticated text tasks using the A2A 1.0 JSON-RPC binding. OpenClaw can also send messages to configured peer agents.

## Quick setup

Add the bundled plugin to your OpenClaw configuration and define a separate bearer token for each trusted peer:

```json5
{
  channels: {
    a2a: {
      enabled: true,
      advertisedUrl: "https://openclaw.example.com",
      peers: {
        hermes: {
          token: "${A2A_HERMES_TOKEN}",
        },
      },
    },
  },
}
```

Set `A2A_HERMES_TOKEN` to a strong, unique secret in the gateway environment, then restart the gateway. Use your externally reachable HTTPS origin as `advertisedUrl` when the gateway runs behind a reverse proxy. If omitted, the plugin derives the advertised origin from the incoming discovery request.

## Discover the Agent Card

Fetch the public A2A Agent Card without authentication:

```bash
curl http://127.0.0.1:18789/.well-known/agent-card.json
```

The card advertises the gateway JSON-RPC endpoint, supported text input and output, and one skill for each exposed OpenClaw agent. Set `channels.a2a.exposeAgents` to an array of agent IDs to limit which agents appear. If unset or empty, all configured agents are advertised.

`/.well-known/agent.json` returns the same card for older A2A clients.

## Send a task

Send an authenticated `SendMessage` JSON-RPC request to `/a2a/v1`:

```bash
curl http://127.0.0.1:18789/a2a/v1 \
  -H "Authorization: Bearer $A2A_HERMES_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": "request-1",
    "method": "SendMessage",
    "params": {
      "message": {
        "messageId": "message-1",
        "role": "ROLE_USER",
        "parts": [{ "text": "Summarize my latest project updates." }]
      }
    }
  }'
```

By default, the request waits for the agent response. A completed response contains a task with the reply in its artifact:

```json
{
  "jsonrpc": "2.0",
  "id": "request-1",
  "result": {
    "task": {
      "id": "<task-id>",
      "contextId": "<context-id>",
      "status": {
        "state": "TASK_STATE_COMPLETED",
        "timestamp": "2026-01-01T12:00:00.000Z"
      },
      "artifacts": [
        {
          "artifactId": "<artifact-id>",
          "parts": [{ "text": "Here are your latest project updates..." }]
        }
      ],
      "history": []
    }
  }
}
```

Include `message.contextId` on subsequent requests to continue the same conversation. Context IDs can contain letters, numbers, periods, underscores, colons, and hyphens, and must not exceed 128 characters.

To return immediately while the agent continues working, add `"configuration": { "returnImmediately": true }` alongside `"message"` in `params`. The task initially reports `TASK_STATE_WORKING`. Requests that exceed `replyTimeoutMs` also return the current working task instead of canceling it.

Older clients can use `message/send` as an alias for `SendMessage`.

## Poll a task

Poll a task by sending its ID to `GetTask`:

```bash
curl http://127.0.0.1:18789/a2a/v1 \
  -H "Authorization: Bearer $A2A_HERMES_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": "poll-1",
    "method": "GetTask",
    "params": { "id": "<task-id>" }
  }'
```

The task transitions from `TASK_STATE_WORKING` to `TASK_STATE_COMPLETED`, `TASK_STATE_FAILED`, or `TASK_STATE_REJECTED`. Older clients can use `tasks/get` as a compatibility alias.

`CancelTask` is refused with JSON-RPC error `-32004` rather than acknowledged. A dispatched agent run has no plugin-facing abort seam, so reporting `TASK_STATE_CANCELED` would tell the peer the work stopped while the run kept using tools. Refusing keeps the reported state honest.

## Configure outbound peers

Add a peer URL when OpenClaw should send messages to another A2A agent. Set `outboundToken` when the remote agent requires its own bearer token:

```json5
{
  channels: {
    a2a: {
      enabled: true,
      peers: {
        hermes: {
          token: "${A2A_HERMES_TOKEN}",
          url: "https://hermes.example.com/a2a/v1",
          outboundToken: "${A2A_HERMES_OUTBOUND_TOKEN}",
        },
      },
    },
  },
}
```

Address outbound messages to `a2a:hermes`. The plugin sends `SendMessage` directly to the configured URL without performing Agent Card discovery. Outbound messages reuse a stable conversation context per peer. A peer without a configured `url` cannot receive outbound messages.

## Configuration reference

| Key                          | Type     | Default  | Description                                                                    |
| ---------------------------- | -------- | -------- | ------------------------------------------------------------------------------ |
| `enabled`                    | boolean  | -        | Enables or disables the A2A channel.                                           |
| `advertisedUrl`              | string   | request  | Public gateway origin used in the Agent Card.                                  |
| `replyTimeoutMs`             | number   | `120000` | Maximum blocking reply wait; allowed range is `5000` to `600000` milliseconds. |
| `rateLimitPerMinute`         | number   | `30`     | Sliding-window request limit per peer; `0` disables the limit.                 |
| `exposeAgents`               | string[] | all      | Agent IDs advertised as Agent Card skills.                                     |
| `peers`                      | object   | `{}`     | Trusted peers keyed by lowercase names up to 64 characters.                    |
| `peers.<name>.token`         | string   | required | Bearer token required when this peer sends requests to OpenClaw.               |
| `peers.<name>.url`           | string   | -        | Peer JSON-RPC endpoint for outbound messages.                                  |
| `peers.<name>.outboundToken` | string   | -        | Bearer token OpenClaw sends to the configured peer URL.                        |

Peer names must begin with a lowercase letter or number and can also contain periods, underscores, and hyphens.

## Session isolation

Each authenticated peer and A2A `contextId` pair gets its own agent session. A2A pins the most
isolated direct-message scope rather than inheriting `session.dmScope`, so remote peer content never
joins the operator's main session and one peer cannot read another peer's conversation history.

## Security

Agent Card discovery is intentionally public: anyone who can reach the gateway can read the instance description and exposed agent IDs. Use `exposeAgents` to limit disclosure, and expose the gateway through HTTPS when it is reachable over an untrusted network.

Every JSON-RPC request requires a configured peer bearer token; there is no unauthenticated mode. Each authenticated peer is also the sender identity used for normal OpenClaw channel ingress policy. Use different high-entropy tokens for each peer, keep tokens out of source control, and rotate tokens by updating the gateway environment and restarting.

Requests are limited to 1 MiB. Extracted message text is capped at 64 KiB and includes an explicit truncation marker when shortened. The default sliding-window limit is 30 requests per minute for each peer; set `rateLimitPerMinute` to `0` only on a separately protected network. Rate-limited requests return a JSON-RPC error while keeping HTTP status 200.

Outbound destinations come only from operator-configured peer URLs. Inbound callers cannot supply a proxy target or redirect OpenClaw to another destination.

## A2A 1.0 limitations

The current plugin supports text messages and structured JSON data parts, which are appended as compact JSON text. File URL and raw binary parts are ignored. Streaming, server-sent events, push notifications, task cancellation, task listing, extended Agent Cards, and multi-tenant routing are not supported.

Tasks remain in memory only. Completed and other terminal tasks are retained for up to 24 hours, with a maximum of 500 retained entries; restarting the gateway discards all tasks and task history.

## Related

- [Channels overview](/channels)
- [Channel routing](/channels/channel-routing)
- [Gateway security](/gateway/security)
- [Channel plugin SDK](/plugins/sdk-channel-plugins)
