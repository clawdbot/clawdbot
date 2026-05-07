---
summary: "Historical bridge protocol (legacy nodes): TCP JSONL, pairing, scoped RPC"
read_when:
  - Building or debugging node clients (iOS/Android/macOS node mode)
  - Investigating pairing or bridge auth failures
  - Auditing the node surface exposed by the gateway
title: "Bridge protocol"
---

<Warning>
The TCP bridge has been **removed**. Current OpenClaw builds do not ship the bridge listener and `bridge.*` config keys are no longer in the schema. This page is kept for historical reference only. Use the [Gateway Protocol](/gateway/protocol) for all node/operator clients.
</Warning>

## Why it existed

- **Security boundary**: the bridge exposes a small allowlist instead of the
  full gateway API surface.
- **Pairing + node identity**: node admission is owned by the gateway and tied
  to a per-node token.
- **Discovery UX**: nodes can discover gateways via Bonjour on LAN, or connect
  directly over a tailnet.
- **Loopback WS**: the full WS control plane stays local unless tunneled via SSH.

## Transport

- TCP, one JSON object per line (JSONL).
- Optional TLS (when `bridge.tls.enabled` is true).
- Historical default listener port was `18790` (current builds do not start a
  TCP bridge).

When TLS is enabled, discovery TXT records include `bridgeTls=1` plus
`bridgeTlsSha256` as a non-secret hint. Note that Bonjour/mDNS TXT records are
unauthenticated; clients must not treat the advertised fingerprint as an
authoritative pin without explicit user intent or other out-of-band verification.

## Handshake + pairing

1. Client sends `hello` with node metadata + token (if already paired).
2. If not paired, gateway replies `error` (`NOT_PAIRED`/`UNAUTHORIZED`).
3. Client sends `pair-request`.
4. Gateway waits for approval, then sends `pair-ok` and `hello-ok`.

Historically, `hello-ok` returned `serverName`; hosted plugin surfaces are now
advertised through `pluginSurfaceUrls`. Canvas/A2UI uses
`pluginSurfaceUrls.canvas`; the deprecated `canvasHostUrl` alias is not part of
the refactored protocol.

## Frames

Client → Gateway:

- `req` / `res`: scoped gateway RPC (chat, sessions, config, health, voicewake, skills.bins)
- `event`: node signals (voice transcript, agent request, chat subscribe, exec lifecycle)

Gateway → Client:

- `invoke` / `invoke-res`: node commands (`canvas.*`, `camera.*`, `screen.record`,
  `location.get`, `sms.send`)
- `event`: chat updates for subscribed sessions
- `ping` / `pong`: keepalive

Legacy allowlist enforcement lived in `src/gateway/server-bridge.ts` (removed).

## Exec lifecycle events

Nodes can emit `exec.finished` or `exec.denied` events to surface system.run activity.
These are mapped to system events in the gateway. (Legacy nodes may still emit `exec.started`.)

Payload fields (all optional unless noted):

- `sessionKey` (required): agent session to receive the system event.
- `runId`: unique exec id for grouping.
- `command`: raw or formatted command string.
- `exitCode`, `timedOut`, `success`, `output`: completion details (finished only).
- `reason`: denial reason (denied only).

## Historical tailnet usage

- Bind the bridge to a tailnet IP: `bridge.bind: "tailnet"` in
  `~/.openclaw/openclaw.json` (historical only; `bridge.*` is no longer valid).
- Clients connect via MagicDNS name or tailnet IP.
- Bonjour does **not** cross networks; use manual host/port or wide-area DNS-SD
  when needed.

## Versioning

The bridge was **implicit v1** (no min/max negotiation). This section is
historical reference only; current node/operator clients use the WebSocket
[Gateway Protocol](/gateway/protocol).

## Related

- [Gateway protocol](/gateway/protocol)
- [Nodes](/nodes)
