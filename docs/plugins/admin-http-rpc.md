---
summary: "Expose selected Gateway control-plane methods through the bundled, opt-in admin-http-rpc plugin"
read_when:
  - Building host tooling that cannot use the Gateway WebSocket RPC client
  - Exposing Gateway admin automation behind a private trusted ingress
  - Auditing the security model for HTTP access to Gateway methods
title: "Admin HTTP RPC plugin"
---

The bundled `admin-http-rpc` plugin exposes an allowlisted set of Gateway control-plane methods over HTTP, for trusted host automation that cannot keep a Gateway WebSocket connection open.

It ships with OpenClaw but is disabled by default; when disabled, the route is not registered. When enabled, it adds `POST /api/v1/admin/rpc` on the same listener as the Gateway (`http://<gateway-host>:<port>/api/v1/admin/rpc`).

Enable it only for private host tooling, tailnet automation, or a trusted internal ingress. Never expose this route directly to the public internet.

## Before you enable it

Admin HTTP RPC is a full operator control-plane surface: any caller that passes Gateway HTTP auth can invoke the allowlisted methods below. Enable it only when all of these are true:

- The caller is trusted to operate the Gateway.
- The caller cannot use the WebSocket RPC client.
- The route is reachable only on loopback, a tailnet, or a private authenticated ingress.
- You have reviewed the allowed methods and they match the automation you plan to run.

For OpenClaw clients and interactive tools that can keep a Gateway WebSocket connection open, use WebSocket RPC instead.

## Enable

Enable the bundled plugin:

<Tabs>
  <Tab title="CLI">
    ```bash
    openclaw plugins enable admin-http-rpc
    openclaw gateway restart
    ```
  </Tab>
  <Tab title="Config">
    ```json5
    {
      plugins: {
        entries: {
          "admin-http-rpc": { enabled: true },
        },
      },
    }
    ```
  </Tab>
</Tabs>

The route is registered during plugin startup, so restart the Gateway after changing plugin config.

Disable it when you no longer need the HTTP surface:

```bash
openclaw plugins disable admin-http-rpc
openclaw gateway restart
```

## Verify the route

Use `health` as the smallest safe request:

```bash
curl -sS http://<gateway-host>:<port>/api/v1/admin/rpc \
  -H 'Authorization: Bearer <gateway-token>' \
  -H 'Content-Type: application/json' \
  -d '{"method":"health","params":{}}'
```

A successful response has `ok: true`:

```json
{
  "id": "generated-request-id",
  "ok": true,
  "payload": {
    "status": "ok"
  }
}
```

When the plugin is disabled, the route returns `404` because it is not registered.

## Authentication

The plugin route uses Gateway HTTP auth.

Common authentication paths:

- shared-secret auth (`gateway.auth.mode="token"` or `"password"`): `Authorization: Bearer <token-or-password>`
- trusted identity-bearing HTTP auth (`gateway.auth.mode="trusted-proxy"`): route through the configured identity-aware proxy and let it inject the required identity headers
- private-ingress open auth (`gateway.auth.mode="none"`): no auth header required

## Security model

Treat this plugin as a full Gateway operator surface.

- Enabling the plugin intentionally offers access to the allowlisted admin RPC methods at `/api/v1/admin/rpc`.
- The plugin declares the reserved `contracts.gatewayMethodDispatch: ["authenticated-request"]` manifest contract, which is what lets its Gateway-authenticated HTTP route dispatch control-plane methods in process. This is not a sandbox: the contract prevents accidental use of reserved SDK helpers, but trusted plugins still run in the Gateway process.
- Shared-secret bearer auth (`token`/`password` modes) proves possession of the gateway operator secret; narrower `x-openclaw-scopes` headers are ignored on that path and normal full operator defaults are restored.
- Trusted identity-bearing HTTP auth (`trusted-proxy` mode) honors `x-openclaw-scopes` when present.
- `gateway.auth.mode="none"` means this route is unauthenticated if the plugin is enabled. Use that only behind a private ingress you fully trust.
- Requests dispatch through the same Gateway method handlers and scope checks as WebSocket RPC, after the plugin route auth passes.
- The route remains reachable during a prepared suspension lease. Bounded request validation and the local `commands.list` discovery response remain available. Of the methods dispatched into the Gateway, only `gateway.suspend.prepare`, `gateway.suspend.status`, and `gateway.suspend.resume` may run while admission is closed; other allowlisted methods return the normal retryable Gateway `UNAVAILABLE` response.
- Keep this route on loopback, tailnet, or a private trusted ingress. Do not expose it directly to the public internet. Use separate gateways when callers cross trust boundaries.

## Request

```http
POST /api/v1/admin/rpc
Authorization: Bearer <gateway-token>
Content-Type: application/json
```

```json
{
  "id": "optional-request-id",
  "method": "health",
  "params": {}
}
```

Fields:

- `id` (string, optional): copied into the response. A UUID is generated when omitted.
- `method` (string, required): allowed Gateway method name.
- `params` (any, optional): method-specific params.

The default max request body size is 1 MB.

## Response

Success responses use the Gateway RPC shape:

```json
{
  "id": "optional-request-id",
  "ok": true,
  "payload": {}
}
```

Gateway method errors use:

```json
{
  "id": "optional-request-id",
  "ok": false,
  "error": {
    "code": "INVALID_REQUEST",
    "message": "bad params"
  }
}
```

HTTP status follows the error code:

| Error code                 | HTTP status |
| -------------------------- | ----------- |
| `INVALID_REQUEST`          | 400         |
| `APPROVAL_NOT_FOUND`       | 404         |
| `NOT_LINKED`, `NOT_PAIRED` | 409         |
| `UNAVAILABLE`              | 503         |
| `AGENT_TIMEOUT`            | 504         |
| any other code             | 500         |

## Allowed methods

- discovery: `commands.list`
  Returns the HTTP RPC method names allowed by this plugin.
- gateway: `health`, `status`, `logs.tail`, `usage.status`, `usage.cost`, `gateway.restart.request`, `gateway.suspend.prepare`, `gateway.suspend.status`, `gateway.suspend.resume`
- config: `config.get`, `config.schema`, `config.schema.lookup`, `config.set`, `config.patch`, `config.apply`
- channels: `channels.status`, `channels.start`, `channels.stop`, `channels.logout`
- web: `web.login.start`, `web.login.wait`
- models: `models.list`, `models.authStatus`
- agents: `agents.list`, `agents.create`, `agents.update`, `agents.delete`
- approvals: `exec.approvals.get`, `exec.approvals.set`, `exec.approvals.node.get`, `exec.approvals.node.set`
- cron: `cron.status`, `cron.list`, `cron.get`, `cron.runs`, `cron.add`, `cron.update`, `cron.remove`, `cron.run`
- devices: `device.pair.list`, `device.pair.approve`, `device.pair.reject`, `device.pair.remove`
- nodes: `node.list`, `node.describe`, `node.pair.list`, `node.pair.approve`, `node.pair.reject`, `node.pair.remove`, `node.rename`
- tasks: `tasks.list`, `tasks.get`, `tasks.cancel`
- diagnostics: `doctor.memory.status`, `update.status`

Other Gateway methods are blocked until they are intentionally added.

## WebSocket comparison

The normal Gateway WebSocket RPC path remains the preferred control-plane API for OpenClaw clients. Use admin HTTP RPC only for host tooling that needs a request/response HTTP surface.

Shared-token WebSocket clients without a trusted device identity cannot self-declare admin scopes during connect. Admin HTTP RPC deliberately follows the existing trusted HTTP operator model: when the plugin is enabled, shared-secret bearer auth is treated as full operator access for this admin surface.

## Troubleshooting

`404 Not Found`

: The plugin is disabled, the Gateway has not restarted since enabling it, or the request is going to a different Gateway process.

`401 Unauthorized`

: The request did not satisfy Gateway HTTP auth. Check the bearer token or the trusted-proxy identity headers.

`405 Method Not Allowed`

: The request used something other than `POST`.

`413 Payload Too Large`

: The request body exceeded the 1 MB limit.

`400 INVALID_REQUEST`

: The request body is not valid JSON, the `method` field is missing, the method is not in the plugin allowlist, or a suspension resume ID does not match the active lease.

`503 UNAVAILABLE`

: The Gateway method is starting, rate-limited, suspended, or waiting on a competing suspension/resume operation. Inspect `error.details` when present and honor `error.retryAfterMs` before retrying.

## Related

- [Operator scopes](/gateway/operator-scopes)
- [Gateway security](/gateway/security)
- [Remote access](/gateway/remote)
- [Plugin manifest](/plugins/manifest#contracts-reference)
- [SDK subpaths](/plugins/sdk-subpaths)
