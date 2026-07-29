---
summary: "Historical bridge protocol (legacy nodes): TCP JSONL, pairing, scoped RPC"
read_when:
  - Investigating old node client code or archived pairing logs
  - Auditing what the legacy node surface used to expose
title: "Bridge protocol"
---

<Warning>
The TCP bridge has been **removed**. Current OpenClaw builds do not ship the bridge listener, and `bridge.*` config keys are no longer in the schema. This page is historical reference only. Use the [Gateway protocol](/gateway/protocol) for all node/operator clients.
</Warning>

## Why it existed

- **Security boundary**: exposed a small allowlist instead of the full gateway API surface.
- **Pairing + node identity**: node admission was owned by the gateway and tied to a per-node token.
- **Discovery UX**: nodes could discover gateways via Bonjour on LAN, or connect directly over a tailnet.
- **Loopback WS**: the full WS control plane stayed local unless tunneled via SSH.

## Transport

- TCP, one JSON object per line (JSONL).
- Optional TLS (`bridge.tls.enabled: true`).
- Default listener port was `18790`.

When TLS was enabled, discovery TXT records included `bridgeTls=1` plus `bridgeTlsSha256` as a non-secret hint. Bonjour/mDNS TXT records are unauthenticated; clients could not treat the advertised fingerprint as an authoritative pin without other out-of-band verification.

## Handshake and pairing

1. Client sends `hello` with node metadata plus token (if already paired).
2. If not paired, gateway replies `error` (`NOT_PAIRED` / `UNAUTHORIZED`).
3. Client sends `pair-request`.
4. Gateway waits for approval, then sends `pair-ok` and `hello-ok`.

`hello-ok` used to return `serverName`; hosted plugin surfaces are now advertised through `pluginSurfaceUrls` on the current Gateway protocol (Canvas/A2UI uses `pluginSurfaceUrls.canvas`).

## Frames

Client to gateway:

- `req` / `res`: scoped gateway RPC (chat, sessions, config, health, voicewake, skills.bins).
- `event`: node signals (voice transcript, agent request, chat subscribe, exec lifecycle).

Gateway to client:

- `invoke` / `invoke-res`: node commands (`canvas.*`, `camera.*`, `screen.record`, `location.get`, `sms.send`).
- `event`: chat updates for subscribed sessions.
- `ping` / `pong`: keepalive.

Allowlist enforcement lived in `src/gateway/server-bridge.ts` (removed).

## Exec lifecycle events

Nodes emitted `exec.finished` to surface completed `system.run` activity, mapped to system events by the gateway (legacy nodes could also emit `exec.started`). `exec.denied` marked a denied `system.run` attempt as a terminal denial without enqueuing a system event or waking agent work.

Payload fields (all optional unless noted):

| Field                            | Notes                                                                                          |
| -------------------------------- | ---------------------------------------------------------------------------------------------- |
| `sessionKey`                     | Required. Agent session for event correlation and, for `exec.finished`, system event delivery. |
| `runId`                          | Unique exec id for grouping.                                                                   |
| `command`                        | Raw or formatted command string.                                                               |
| `exitCode`, `timedOut`, `output` | Completion details (finished only).                                                            |
| `reason`                         | Denial reason (denied only).                                                                   |

## Historical tailnet usage

- Bind the bridge to a tailnet IP: `bridge.bind: "tailnet"` in `~/.openclaw/openclaw.json` (historical only; `bridge.*` is no longer valid config).
- Clients connected via MagicDNS name or tailnet IP.
- Bonjour does not cross networks; wide-area DNS-SD or a manual host/port was required otherwise.

## Versioning

The bridge was implicit v1, with no min/max negotiation. Current node/operator clients use the WebSocket [Gateway protocol](/gateway/protocol), which does negotiate a protocol version range.

## Related

- [Gateway protocol](/gateway/protocol)
- [Nodes](/nodes)
