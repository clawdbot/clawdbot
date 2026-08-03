---
summary: "Invoke a single tool directly via the Gateway HTTP endpoint"
read_when:
  - Calling tools without running a full agent turn
  - Building automations that need tool policy enforcement
title: "Tools invoke API"
---

OpenClaw's Gateway exposes an HTTP endpoint for invoking a single tool directly. It is always enabled and uses Gateway auth plus tool policy. Like the OpenAI-compatible `/v1/*` surface, shared-secret bearer auth is treated as trusted operator access for the whole gateway.

- `POST /tools/invoke`
- Same port as the Gateway (WS + HTTP multiplex): `http://<gateway-host>:<port>/tools/invoke`
- Default max request body size: 2 MB

## Authentication

Uses the Gateway auth configuration.

Common HTTP auth paths:

- shared-secret auth (`gateway.auth.mode="token"` or `"password"`): `Authorization: Bearer <token-or-password>`
- trusted identity-bearing HTTP auth (`gateway.auth.mode="trusted-proxy"`): route through the configured identity-aware proxy and let it inject the required identity headers
- private-ingress open auth (`gateway.auth.mode="none"`): no auth header required

Notes:

- `mode="token"` uses `gateway.auth.token` (or `OPENCLAW_GATEWAY_TOKEN`).
- `mode="password"` uses `gateway.auth.password` (or `OPENCLAW_GATEWAY_PASSWORD`).
- `mode="trusted-proxy"` requires the HTTP request to come from a configured trusted proxy source; same-host loopback proxies require explicit `gateway.auth.trustedProxy.allowLoopback = true`.
- Internal same-host callers that bypass the proxy can use `gateway.auth.password` / `OPENCLAW_GATEWAY_PASSWORD` as a local direct fallback. Any `Forwarded`, `X-Forwarded-*`, or `X-Real-IP` header evidence keeps the request on the trusted-proxy path instead.
- If `gateway.auth.rateLimit` is configured and too many auth failures occur, the endpoint returns `429` with `Retry-After`.

## Security boundary (important)

Treat this endpoint as a **full operator-access** surface for the gateway instance.

- HTTP bearer auth here is not a narrow per-user scope model.
- A valid Gateway token/password for this endpoint should be treated like an owner/operator credential.
- For shared-secret auth modes (`token` and `password`), the endpoint restores the normal full operator defaults even if the caller sends a narrower `x-openclaw-scopes` header.
- Shared-secret auth also treats direct tool invokes on this endpoint as owner-sender turns.
- Trusted identity-bearing HTTP modes (trusted proxy auth, or `gateway.auth.mode="none"` on a private ingress) honor `x-openclaw-scopes` when present and otherwise fall back to the normal operator default scope set.
- Keep this endpoint on loopback/tailnet/private ingress only; do not expose it directly to the public internet.

Auth matrix:

| Auth mode                                                                               | Behavior                                                                                                                                                                                                                                                                                                               |
| --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `token` or `password` + `Authorization: Bearer ...`                                     | Proves possession of the shared gateway operator secret. Ignores narrower `x-openclaw-scopes`. Restores the full default operator scope set: `operator.admin`, `operator.approvals`, `operator.pairing`, `operator.read`, `operator.talk.secrets`, `operator.write`. Treats direct tool invokes as owner-sender turns. |
| Trusted identity-bearing HTTP (trusted proxy auth, or `mode="none"` on private ingress) | Authenticates an outer trusted identity or deployment boundary. Honors `x-openclaw-scopes` when present. Falls back to the normal operator default scope set when the header is absent. Only loses owner semantics when the caller explicitly narrows scopes and omits `operator.admin`.                               |

## Request body

```json
{
  "tool": "sessions_list",
  "action": "json",
  "args": {},
  "sessionKey": "main",
  "dryRun": false
}
```

Fields:

- `tool` / `name` (string, required): tool name to invoke. `name` takes precedence if both are sent.
- `action` (string, optional): merged into `args.action` if the tool schema supports an `action` property and `args` did not already set one.
- `args` (object, optional): tool-specific arguments.
- `sessionKey` (string, optional): target session key. If omitted or `"main"`, the Gateway uses the configured main session key (honors `session.mainKey` and the default agent, or `global` in global session scope).
- `agentId` (string, optional): resolves the session key for that agent. Errors with `400` if it conflicts with an explicit `sessionKey` that already maps to a different agent.
- `idempotencyKey` (string, optional): used to derive a stable tool-call id for the invocation.
- `dryRun` (boolean, optional): reserved for future use; currently ignored.

## Policy + routing behavior

Tool availability is filtered through the same policy chain used by Gateway agents:

- `tools.profile` / `tools.byProvider.profile`
- `tools.allow` / `tools.byProvider.allow`
- `agents.<id>.tools.allow` / `agents.<id>.tools.byProvider.allow`
- group policies (if the session key maps to a group or channel)
- subagent policy (when invoking with a subagent session key)

If a tool is not allowed by policy, the endpoint returns **404**.

Important boundary notes:

- Exec approvals are operator guardrails, not a separate authorization boundary for this HTTP endpoint. If a tool is reachable here via Gateway auth + tool policy, `/tools/invoke` does not add an extra per-call approval prompt.
- If `exec` is reachable here, treat it as a mutating shell surface. Denying `write`, `edit`, `apply_patch`, or HTTP filesystem-write tools does not make shell execution read-only.
- Do not share Gateway bearer credentials with untrusted callers. If you need separation across trust boundaries, run separate gateways (ideally on separate OS users/hosts).

Gateway HTTP also applies a hard deny list by default (even if session policy allows the tool):

| Tool             | Reason                                                    |
| ---------------- | --------------------------------------------------------- |
| `exec`           | Direct command execution (RCE surface)                    |
| `spawn`          | Arbitrary child process creation (RCE surface)            |
| `shell`          | Shell command execution (RCE surface)                     |
| `fs_write`       | Arbitrary file mutation on the host                       |
| `fs_delete`      | Arbitrary file deletion on the host                       |
| `fs_move`        | Arbitrary file move/rename on the host                    |
| `apply_patch`    | Patch application can rewrite arbitrary files             |
| `sessions_spawn` | Session orchestration; spawning agents remotely is RCE    |
| `sessions_send`  | Cross-session message injection                           |
| `cron`           | Persistent automation control plane                       |
| `gateway`        | Gateway control plane; prevents reconfiguration via HTTP  |
| `nodes`          | Node command relay can reach `system.run` on paired hosts |

`cron`, `gateway`, and `nodes` are also owner-only: even outside this default deny list, non-owner callers cannot invoke them on this surface.

Customize the general deny list via `gateway.tools`:

```json5
{
  gateway: {
    tools: {
      // Additional tools to block over HTTP /tools/invoke
      deny: ["browser"],
      // Remove tools from the default deny list for owner/admin callers
      allow: ["gateway"],
    },
  },
}
```

`gateway.tools.allow` is an exposure override, not a scope upgrade. In identity-bearing HTTP modes, `cron`, `gateway`, and `nodes` remain unavailable to callers without owner/admin identity (`operator.admin`) even when listed in `gateway.tools.allow`. Shared-secret bearer auth still follows the full trusted-operator rule above.

To help group policies resolve context, you can optionally set:

- `x-openclaw-message-channel: <channel>` (example: `slack`, `telegram`)
- `x-openclaw-account-id: <accountId>` (when multiple accounts exist)
- `x-openclaw-message-to: <target>` (delivery target for message-tool policy)
- `x-openclaw-thread-id: <threadId>` (thread context for message-tool policy)

## Responses

| Status | Meaning                                                                                        |
| ------ | ---------------------------------------------------------------------------------------------- |
| `200`  | `{ ok: true, result }`                                                                         |
| `400`  | `{ ok: false, error: { type, message } }` (invalid request or tool input error)                |
| `401`  | Unauthorized                                                                                   |
| `403`  | `{ ok: false, error: { type, message, requiresApproval? } }` (tool call blocked by policy)     |
| `404`  | Tool not available (not found or not allowlisted)                                              |
| `405`  | Method not allowed                                                                             |
| `408`  | Request body read timed out                                                                    |
| `413`  | Request body exceeded the max payload size                                                     |
| `429`  | Auth rate-limited (`Retry-After` set)                                                          |
| `500`  | `{ ok: false, error: { type, message } }` (unexpected tool execution error; sanitized message) |

## Example

```bash
curl -sS http://127.0.0.1:18789/tools/invoke \
  -H 'Authorization: Bearer secret' \
  -H 'Content-Type: application/json' \
  -d '{
    "tool": "sessions_list",
    "action": "json",
    "args": {}
  }'
```

## Related

- [Gateway protocol](/gateway/protocol)
- [Tools and plugins](/tools)
