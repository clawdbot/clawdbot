---
summary: "Opt-in presentation policy for hosts that serve the Control UI from another runtime"
read_when:
  - You host the Control UI inside another application or gateway
  - You need route, settings, action, or Gateway scope presentation policy
title: "Hosted Control UI policy"
sidebarTitle: "Host policy"
---

The Control UI can run inside another host runtime when that host serves the
same OpenClaw `dist/control-ui` bundle and exposes a runtime config document at
`/control-ui-config.json`, resolved relative to the configured Control UI base
path.

The hosted policy is an **opt-in browser presentation contract** plus a small
server-enforcement envelope for hosted Gateway actions. It can hide or disable
routes, render settings as read-only, select a same-origin Gateway path, reduce
requested Gateway scopes, and block obvious browser-side action calls before
they are sent.

Hosts must enforce every restricted mutation in the host runtime or Gateway
relay. Hidden UI, disabled controls, and action preflight only reduce accidental
use from the bundled Control UI. OpenClaw's Gateway can enforce the same
resolved policy for Gateway action IDs when the host/runtime supplies it to the
Gateway request context.

## Enablement path

To host the Control UI:

1. Serve a version-matched OpenClaw `dist/control-ui` bundle under a host-owned
   base path, such as `/openclaw`.
2. Serve `<basePath>/control-ui-config.json` from the same origin.
3. Put `hostControlPolicy.version: 1` in that config document.
4. Point `hostControlPolicy.gateway.path` at the host-owned Gateway relay.
5. Enforce authentication, authorization, scope checks, and mutation policy in
   the relay or backing Gateway.

When no host policy is provided, OpenClaw keeps the normal local behavior:
routes are enabled, settings are editable, actions are enabled, and the default
Gateway connection settings apply.

## Runtime config shape

```json
{
  "version": 1,
  "hostControlPolicy": {
    "version": 1,
    "host": {
      "id": "example-host",
      "mode": "hosted",
      "displayName": "Example Host"
    },
    "gateway": {
      "path": "/v1/openclaw-control-ui-gateway",
      "scopes": ["operator.read", "operator.write"]
    },
    "defaults": {
      "route": "enabled",
      "setting": "editable",
      "action": "enabled"
    },
    "routes": {
      "debug": {
        "state": "disabled",
        "reason": "Diagnostics are owned by the host."
      }
    },
    "settings": {
      "*": {
        "state": "readOnly",
        "reason": "Deployment settings are owned by the host."
      }
    },
    "actions": {
      "sessions.delete": {
        "state": "disabled",
        "reason": "Session retention is owned by the host."
      },
      "config.apply": {
        "state": "brokered",
        "reason": "Config apply must go through the host policy workflow.",
        "broker": "example-host.policy.apply"
      }
    }
  }
}
```

V1 accepts `hostControlPolicy` as the canonical wrapper. `controlPolicy` and
`policy` are accepted as compatibility aliases by the browser parser, but new
hosts should emit `hostControlPolicy`.

## Policy fields

`host.id`, `host.mode`, and `host.displayName` identify the host in browser
state. They do not grant trust.

`gateway.path` selects the WebSocket path used by the Control UI. Hosted
deployments usually set this to a same-origin relay path. If `gateway.path` is
empty, the Control UI uses its normal Gateway target.

`gateway.scopes` selects the scopes requested by the browser Gateway client. A
non-empty hosted scope list takes precedence over the default bootstrap scopes,
including bootstrap-token connections. The host relay still has to reject calls
that exceed the scopes or tenant policy it intends to allow.

`defaults.route`, `defaults.setting`, and `defaults.action` provide fallback
states when no more specific policy exists.

Policy decisions share a small shape across surfaces:

- `state`: the resolved decision, such as `enabled`, `disabled`, `readOnly`, or
  `brokered`.
- `reason`: optional user-facing explanation.
- `source`: optional provenance, such as `lobster`, `policy`, or a policy
  document reference.
- `broker`: optional host workflow ID for `brokered` decisions.

`routes` maps Control UI route IDs to route states:

- `enabled`: the route is available.
- `readOnly`: the route remains visible, but route-specific controls should
  avoid mutation affordances where the page supports that state.
- `disabled`: the route is unavailable and the app should redirect away from
  it.

`settings` is intentionally coarse in V1. The browser honors only `settings["*"]`
or `defaults.setting` for hosted settings ownership:

- `editable`: settings controls may be edited by the browser.
- `readOnly`: settings are shown without edit affordances.
- `locked`: settings are owned outside the browser and should be presented as
  unavailable for editing.

Granular field ownership is reserved for a later server-enforced configuration
contract.

The same policy envelope can already describe that later contract. For example,
a host or the Policy plugin could eventually project active policy into:

```json
{
  "settings": {
    "gateway.bind": {
      "state": "disabled",
      "reason": "Active policy requires loopback-only gateway bind.",
      "source": "policy/gateway-non-loopback-bind"
    },
    "tools.exec.host": {
      "state": "readOnly",
      "reason": "Tenant policy controls host exec posture.",
      "source": "lobster"
    },
    "channels.*.groupPolicy": {
      "state": "readOnly",
      "reason": "Ingress policy is managed centrally.",
      "source": "policy/channels-ingress"
    }
  }
}
```

Current V1 browser behavior treats this as coarse settings ownership. A future
settings-constraints contract can use the same decision shape and exact or
hierarchical wildcard matching to disable specific values and reject
`config.set`, `config.patch`, or `config.apply` writes that violate active
policy.

`actions` maps Gateway action IDs to action states:

- `enabled`: the browser may send the action.
- `disabled`: the browser blocks the action before sending it.
- `brokered`: the browser blocks direct invocation because the host is expected
  to provide a mediated workflow.

Action IDs can be exact, such as `sessions.delete`, or hierarchical wildcards,
such as `sessions.*`.

## Required enforcement

The browser projection is best treated as UX guidance. A user can still call the
host relay directly, use an older bundle, or alter browser state. Hosts that use
this policy must also:

- Authenticate the operator before serving the config and Gateway relay.
- Reject Gateway methods outside the allowed hosted surface.
- Reject mutation methods that the policy marks as disabled or brokered.
- Bind requested scopes to the authenticated operator and tenant.
- Keep any deployment-owned settings authoritative on the server side.

When OpenClaw Gateway receives a resolved hosted Gateway action policy, it
enforces `actions` after normal role/scope authorization and before method
dispatch. `disabled` and `brokered` methods return a structured forbidden error
with the method, state, reason, source, and broker when provided. Synthetic
in-process dispatch remains outside hosted browser policy.

For OpenClaw-hosted local use, the normal Gateway auth and device pairing rules
still apply. See [Control UI](/web/control-ui) and [Web](/web) for the local
Gateway security model.

## Versioning and rollout

V1 is additive and default-open. Hosts can roll it out behind their own feature
flag or deployment gate by serving or withholding `hostControlPolicy` from
`control-ui-config.json`.

Use a version-matched Control UI bundle and host policy config together. If a
host needs to change the allowed routes, scopes, settings ownership, or action
states, update the config served by the host and keep the server-side relay
policy in sync.

Future policy versions should add fields or behavior without changing the V1
meaning of existing states. Hosts should keep unsupported policy versions
fail-closed in their own runtime and omit the policy from the browser config
until the served bundle supports the version they intend to use.
