---
summary: "Operator roles, scopes, and approval-time checks for Gateway clients"
read_when:
  - Debugging missing operator scope errors
  - Reviewing device or node pairing approvals
  - Adding or classifying Gateway RPC methods
title: "Operator scopes"
---

Operator scopes gate what a Gateway client can do after it authenticates.
They are a control-plane guardrail inside one trusted Gateway operator domain,
not hostile multi-tenant isolation. For strong separation between people,
teams, or machines, run separate Gateways under separate OS users or hosts.

Related: [Security](/gateway/security), [Gateway protocol](/gateway/protocol),
[Gateway pairing](/gateway/pairing), [Devices CLI](/cli/devices).

## Roles

Every Gateway WebSocket client connects with one role:

- `operator`: control-plane clients such as CLI, Control UI, automation, and
  trusted helper processes.
- `node`: capability hosts (macOS, iOS, Android, headless) that expose
  commands through `node.invoke`.

Operator RPC methods require the `operator` role; node-originated methods
require the `node` role.

## Scope levels

| Scope                   | Meaning                                                                                                                                                       |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `operator.read`         | Read-only status, lists, catalog, logs, session reads, retained audit and execution-identity diagnostics, and other non-mutating calls.                       |
| `operator.write`        | Mutating operator actions: sending messages, invoking tools, updating talk/voice settings, node command relay. Also satisfies `operator.read`.                |
| `operator.admin`        | Administrative access. Satisfies every `operator.*` scope. Required for config mutation, updates, native hooks, reserved namespaces, and high-risk approvals. |
| `operator.pairing`      | Device and node pairing management: list, approve, reject, remove, rotate, revoke.                                                                            |
| `operator.approvals`    | Exec and plugin approval APIs.                                                                                                                                |
| `operator.questions`    | Listing, reading, answering, and resolving interactive questions.                                                                                             |
| `operator.talk`         | Creating, steering, and closing Talk sessions without general Gateway write access. `operator.write` also satisfies this scope.                               |
| `operator.talk.secrets` | Reading Talk configuration with secrets included.                                                                                                             |

Unknown future `operator.*` scopes require an exact match unless the caller
already holds `operator.admin`.

## Identity scope grants

`gateway.auth.identityScopes` grants operator scopes to verified user
identities from trusted-proxy auth or Tailscale WhoIs:

```json5
{
  gateway: {
    auth: {
      identityScopes: {
        "admin@example.com": ["operator.admin"],
        "operator@example.com": ["operator.read", "operator.write"],
      },
    },
  },
}
```

The key is the verified proxy identity or Tailscale WhoIs login. Email keys
match case-insensitively; non-email identities match exactly. Config validation
rejects scope names outside the closed set above.

Connection authority is resolved in this order:

1. For trusted-proxy Control UI connections, `x-openclaw-scopes` first caps
   device enrollment or upgrade requests. Device authorization then establishes
   the persistent scopes; a device-less session contributes no self-declared
   scopes.
2. OpenClaw unions a matching server-side identity grant with those scopes.
3. OpenClaw applies `x-openclaw-scopes` to the final union as the session cap.
   An absent header means no cap; a present-but-empty header yields no scopes.

The result is used for both `hello.auth.scopes` and Gateway method
authorization. Identity grants are session-only: they do not create or modify
pairing records or request a device scope upgrade. Token, password, and no-auth
connections carry no verified identity and receive no grant.
Identity grants apply only to `operator`-role connections; `node`-role connections never receive them.

## Method scope is only the first gate

Each Gateway RPC has a least-privilege method scope that decides whether a
request reaches its handler. Params-aware methods derive that scope before
dispatch so authorization failures have one canonical structured response:

- `agent` needs `operator.write` for ordinary turns and `operator.admin` for
  `/new` or `/reset` session lifecycle commands.
- `node.invoke` needs `operator.write` for ordinary relay commands and
  `operator.admin` when relaying `browser.proxy`, `browser.proxy.upload.v1`,
  `fs.listDir`, or `terminal.upload` to a node.
- The top-level `fs.listDir` RPC needs `operator.write` for Gateway-host
  requests and `operator.admin` when `nodeId` targets a node. Its handler limits
  non-admin Gateway-host browsing to configured agent workspaces.
- `sessions.create` needs `operator.write` for ordinary creation, including a
  `projectId`, and `operator.admin` for incognito sessions or any `execNode`
  request. For non-admin callers, the handler limits `cwd` to configured agent
  workspaces; `projectId` cannot be combined with `cwd` or `execNode`.
- `worktrees.branches` needs `operator.write`. Its handler limits non-admin
  callers to workspace-contained paths or registered-project roots; other host
  paths require `operator.admin`.
- `talk.config` needs `operator.read`; `includeSecrets: true` also needs
  `operator.talk.secrets`.
- `talk.client.*`, `talk.session.*`, `talk.speak`, and `talk.mode` need
  `operator.talk` (or the compatible broader `operator.write`).
- `sessions.patch` needs `operator.write` for session organization fields and
  the per-session `model` override. Other runtime overrides, including
  thinking, fast, verbose, trace, and reasoning levels, need `operator.admin`.
  Persisting a selected model as the configured agent default is also
  admin-only.

Project RPCs use these scopes:

| Method                                 | Required scope and additional gate                                                            |
| -------------------------------------- | --------------------------------------------------------------------------------------------- |
| `projects.list`                        | `operator.read`; only callers satisfying `operator.write` receive `repoRoot` and `originUrl`. |
| `projects.add`                         | `operator.write` and the `controlPlaneWrite` method flag.                                     |
| `projects.register`, `projects.remove` | `operator.admin`.                                                                             |
| `projects.searchRemote`                | `operator.read`.                                                                              |

Some handlers then apply stricter checks based on the concrete thing being
approved or mutated:

- `device.pair.approve` is reachable with `operator.pairing`, but approving an
  operator device can only mint or preserve scopes the caller already holds.
- `node.pair.approve` is reachable with `operator.pairing`, then derives extra
  approval scopes from the pending node's declared command list.
- `chat.send` is a write-scoped method, but the `/config set` and
  `/config unset` chat commands require `operator.admin` on top of that,
  regardless of the caller's chat-send scope.

This lets lower-scope operators perform low-risk pairing actions without
making all pairing approval admin-only.

Session mutation RPCs are authorized by their negotiated operator scopes,
independent of the connecting client's `client.id` or `client.mode`. Client
identity can still affect connection and device-auth policy, but it neither
grants nor removes session mutation authority.

`audit.run.inspect` intentionally uses `operator.read`. Every client with that
scope in a Gateway operator domain may receive the retained execution-identity
context, including bounded pseudonymized references and secret-redacted display
labels. `operator.read` is not a per-user or hostile multi-tenant privacy
boundary. Operators who must keep this data separate need separate Gateway
trust domains.

## Device pairing approvals

Device pairing records are the durable source of approved roles and scopes.
An already-paired device does not get broader access silently: a reconnect
that asks for a broader role or broader scopes creates a new pending upgrade
request.

A connected limited Control UI can file that same pending request through its
**Request admin** banner without attempting a broader reconnect. The banner can
collapse into a persistent **Limited access** chip that reopens the action. The request is
bound to the signed device identity on the live connection. Approval still
comes from `device.pair.approve` and therefore requires `operator.pairing` plus
authority for every requested scope. After approval rotates the operator token,
the Gateway returns the new token only to that device's live waiter; the browser
stores it before reconnecting. Canceling the wait or disconnecting before
approval falls back to the ordinary pairing repair flow on the next connection.

The explicit exception is the administrator-capable Control UI owner profile
issued directly on the Gateway host by `openclaw dashboard` or graphical
onboarding. Its short-lived, single-use bootstrap can approve the exact closed
scope set for a fresh browser or upgrade an existing limited credential only
when it binds to that same signed browser keypair. Generic Control UI and
Telegram handoffs, mobile setup profiles, shared credentials, locality, and
caller-selected scopes do not receive this exception.

Approving a device request:

- A request with no operator role does not need operator scope approval.
- A request for a non-operator device role (for example `node`) requires
  `operator.admin`, even though `device.pair.approve` itself only needs
  `operator.pairing`.
- A request for `operator.read`, `operator.write`, `operator.approvals`,
  `operator.questions`, `operator.pairing`, `operator.talk`, or
  `operator.talk.secrets` requires
  the caller to already hold that scope, or `operator.admin`.
- A request for `operator.admin` requires `operator.admin`.
- A repair request with no explicit scopes can inherit the existing operator
  token's scopes; if that token is admin-scoped, approval still requires
  `operator.admin`.

Non-admin shared-secret and trusted-proxy sessions can only approve
operator-device requests within their own declared operator scopes; approving
non-operator roles is admin-only even when those sessions can otherwise use
`operator.pairing`.

For paired-device token sessions, management is self-scoped unless the caller
has `operator.admin`: a non-admin caller sees only its own pairing entries, and
can approve, reject, rotate, revoke, or remove only its own device entry.

## Node pairing approvals

Legacy `node.pair.*` methods use a separate Gateway-owned node pairing store.
WS nodes use device pairing (`role: node`) instead, but the same approval
vocabulary applies. See [Gateway pairing](/gateway/pairing) for how the two
stores relate.

`node.pair.approve` derives extra required scopes from the pending request's
command list:

| Declared commands                                                                                                                               | Required scopes                       |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| none                                                                                                                                            | `operator.pairing`                    |
| ordinary node commands                                                                                                                          | `operator.pairing` + `operator.write` |
| `system.run`, `system.run.prepare`, `system.which`, `browser.proxy`, `browser.proxy.upload.v1`, `fs.listDir`, or `system.execApprovals.get/set` | `operator.pairing` + `operator.admin` |

Here, `fs.listDir` is the node command declared for relay through `node.invoke`,
not the top-level Gateway RPC described above.

Approving a node declaration records its command surface. For `computer.act`,
the node advertises that surface only after Computer Control is enabled locally;
once the pairing update is approved, invoking it through `node.invoke` requires
write scope but not admin scope for each action. Commands classified as
dangerous or privacy-heavy still require a persistent
`gateway.nodes.commands.allow` entry in addition to pairing.

Node pairing establishes identity and trust; it does not replace a node's own
`system.run` exec approval policy.

## Shared-secret auth

Shared gateway token/password auth is treated as trusted operator access for
that Gateway. OpenAI-compatible HTTP surfaces, `/tools/invoke`, and HTTP
session-history endpoints restore the full default operator scope set for
shared-secret bearer auth, even if a caller sends narrower declared scopes.

Identity-bearing modes, such as trusted proxy auth or private-ingress `none`,
can still honor explicit declared scopes. Use separate Gateways for real trust
boundary separation.
