---
summary: "Operator roles, scopes, and approval-time checks for Gateway clients"
read_when:
  - Debugging missing operator scope errors
  - Reviewing device or node pairing approvals
  - Adding or classifying Gateway RPC methods
title: "Operator scopes"
---

Operator scopes define what a Gateway client may do after it authenticates.
They are a control-plane guardrail inside one trusted Gateway operator domain,
not hostile multi-tenant isolation. If you need strong separation between
people, teams, or machines, run separate Gateways under separate OS users or
hosts.

Related: [Security](/gateway/security), [Gateway protocol](/gateway/protocol),
[Gateway pairing](/gateway/pairing), [Devices CLI](/cli/devices).

## Roles

Gateway WebSocket clients connect with one role:

- `operator`: control-plane clients such as CLI, Control UI, automation, and
  trusted helper processes.
- `node`: capability hosts such as macOS, iOS, Android, or headless nodes that
  expose commands through `node.invoke`.

Operator RPC methods require the `operator` role. Node-originated methods
require the `node` role.

## Scope levels

| Scope                   | Meaning                                                                                                                                                                               |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `operator.read`         | Read-only status, lists, catalog, logs, session reads, and other non-mutating control-plane calls.                                                                                    |
| `operator.write`        | Normal mutating operator actions such as sending messages, invoking tools, updating talk/voice settings, and node command relay. Also satisfies `operator.read`.                      |
| `operator.admin`        | Administrative control-plane access. Satisfies every `operator.*` scope. Required for config mutation, updates, native hooks, sensitive reserved namespaces, and high-risk approvals. |
| `operator.pairing`      | Device and node pairing management, including listing, approving, rejecting, removing, rotating, and revoking pairing records or device tokens.                                       |
| `operator.approvals`    | Exec and plugin approval APIs.                                                                                                                                                        |
| `operator.talk.secrets` | Reading Talk configuration with secrets included.                                                                                                                                     |

Unknown future `operator.*` scopes require an exact match unless the caller has
`operator.admin`.

## Method scope is only the first gate

Each Gateway RPC has a least-privilege method scope. That method scope decides
whether the request can reach the handler. Some handlers then apply stricter
approval-time checks based on the concrete thing being approved or mutated.

Examples:

- `device.pair.approve` is reachable with `operator.pairing`, but approving an
  operator device can only mint or preserve scopes the caller already holds.
- `node.pair.approve` is reachable with `operator.pairing`, then derives extra
  approval scopes from the pending node command list.
- `chat.send` is normally a write-scoped method, but persistent `/config set`
  and `/config unset` require `operator.admin` at command level.

This lets lower-scope operators perform low-risk pairing actions without making
all pairing approval admin-only.

## Device pairing approvals

Device pairing records are the durable source of approved roles and scopes.
Already paired devices do not get broader access silently: reconnects that ask
for a broader role or broader scopes create a new pending upgrade request.

When approving a device request:

- A request with no operator role does not need operator token scope approval.
- A request for `operator.read`, `operator.write`, `operator.approvals`,
  `operator.pairing`, or `operator.talk.secrets` requires the caller to hold
  those scopes, or `operator.admin`.
- A request for `operator.admin` requires `operator.admin`.
- A repair request with no explicit scopes can inherit the existing operator
  token scopes. If that existing token is admin-scoped, approval still requires
  `operator.admin`.

For paired-device token sessions, management is self-scoped unless the caller
also has `operator.admin`: non-admin callers can rotate, revoke, or remove only
their own device entry.

## Node pairing approvals

Legacy `node.pair.*` uses a separate Gateway-owned node pairing store. WS nodes
use device pairing with `role: node`, but the same approval-level vocabulary
applies.

`node.pair.approve` uses the pending request command list to derive additional
required scopes:

- Commandless request: `operator.pairing`
- Non-exec node commands: `operator.pairing` + `operator.write`
- `system.run`, `system.run.prepare`, or `system.which`:
  `operator.pairing` + `operator.admin`

Node pairing establishes identity and trust. It does not replace the node's
own `system.run` exec approval policy.

## Shared-secret auth

Shared gateway token/password auth is treated as trusted operator access for
that Gateway. OpenAI-compatible HTTP surfaces and `/tools/invoke` restore the
normal full operator default scope set for shared-secret bearer auth, even if a
caller sends narrower declared scopes.

Identity-bearing modes, such as trusted proxy auth or private-ingress `none`,
can still honor explicit declared scopes. Use separate Gateways for real trust
boundary separation.
