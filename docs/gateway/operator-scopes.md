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
| `operator.read`         | Read-only status, lists, catalog, logs, session reads, and other non-mutating calls.                                                                          |
| `operator.write`        | Mutating operator actions: sending messages, invoking tools, updating talk/voice settings, node command relay. Also satisfies `operator.read`.                |
| `operator.admin`        | Administrative access. Satisfies every `operator.*` scope. Required for config mutation, updates, native hooks, reserved namespaces, and high-risk approvals. |
| `operator.pairing`      | Device and node pairing management: list, approve, reject, remove, rotate, revoke.                                                                            |
| `operator.approvals`    | Exec and plugin approval APIs.                                                                                                                                |
| `operator.talk.secrets` | Reading Talk configuration with secrets included.                                                                                                             |

Unknown future `operator.*` scopes require an exact match unless the caller
already holds `operator.admin`.

## Method scope is only the first gate

Each Gateway RPC has a least-privilege method scope that decides whether a
request reaches its handler. Some handlers then apply stricter checks based on
the concrete thing being approved or mutated:

- `device.pair.approve` is reachable with `operator.pairing`, but approving an
  operator device can only mint or preserve scopes the caller already holds.
- `node.pair.approve` is reachable with `operator.pairing`, then derives extra
  approval scopes from the pending node's declared command list.
- `chat.send` is a write-scoped method, but the `/config set` and
  `/config unset` chat commands require `operator.admin` on top of that,
  regardless of the caller's chat-send scope.

This lets lower-scope operators perform low-risk pairing actions without
making all pairing approval admin-only.

## Device pairing approvals

Device pairing records are the durable source of approved roles and scopes.
An already-paired device does not get broader access silently: a reconnect
that asks for a broader role or broader scopes creates a new pending upgrade
request.

Approving a device request:

- A request with no operator role does not need operator scope approval.
- A request for a non-operator device role (for example `node`) requires
  `operator.admin`, even though `device.pair.approve` itself only needs
  `operator.pairing`.
- A request for `operator.read`, `operator.write`, `operator.approvals`,
  `operator.pairing`, or `operator.talk.secrets` requires the caller to already
  hold that scope, or `operator.admin`.
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

| Declared commands                                     | Required scopes                       |
| ----------------------------------------------------- | ------------------------------------- |
| none                                                  | `operator.pairing`                    |
| non-exec node commands                                | `operator.pairing` + `operator.write` |
| `system.run`, `system.run.prepare`, or `system.which` | `operator.pairing` + `operator.admin` |

Approving a node declaration does not enable commands that have a separate
runtime allowlist gate. For example, approving a node that declares
`computer.act` requires pairing plus write scope, but only records the surface.
An administrator or owner must still arm `computer.act`. While it remains
armed, invoking it through the write-scoped `node.invoke` method does not
require admin scope for each action.

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
