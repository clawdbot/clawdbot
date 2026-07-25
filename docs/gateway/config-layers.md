---
summary: "Compose ordered, read-only configuration files at Gateway startup"
read_when:
  - Starting one Gateway from multiple configuration sources
  - Packaging OpenClaw for a hosted or managed environment
  - Replacing generated config overlays with explicit ordered inputs
title: "Configuration layers"
---

Configuration layers are an opt-in Gateway startup feature. Pass
`--config-layer <id=path>` more than once to compose ordinary OpenClaw config
files in the declared order.

Without `--config-layer`, OpenClaw uses its normal single-config behavior. No
layer parsing, composition, write restrictions, or other managed behavior is
active.

## How composition works

```mermaid
flowchart LR
  A[Layer 1 JSON5] --> D[Parse includes and env references]
  B[Layer 2 JSON5] --> D
  C[Layer N JSON5] --> D
  D --> E[Compose in declared order]
  E --> F[Schema and plugin validation]
  F --> G[Validated startup snapshot]
  G --> H[Gateway runtime]
```

Layer IDs are generic labels. OpenClaw does not assign special meaning to names
such as `global`, `tenant`, or `operator`.

The composer applies these rules recursively:

- The first layer to declare a config path controls that path.
- A later layer may repeat the same value.
- A later layer may not replace a controlled value.
- Empty objects claim their path rather than disappearing.
- `tools.allow` may become more restrictive in a later layer.
- `tools.deny` may become more restrictive by denying additional tools.
- Tool wildcards and groups use OpenClaw's runtime policy semantics. Ambiguous
  wildcard-to-wildcard allowlist replacements fail closed.

```mermaid
flowchart TD
  L1[Earlier layer declares a path] --> Q{Later declaration}
  Q -->|Same value| S[Accepted]
  Q -->|New unrelated path| N[Accepted]
  Q -->|Different controlled value| C[Conflict]
  Q -->|Tighter tools policy| T[Accepted]
  Q -->|Weaker tools policy| W[Conflict]
```

Conflicts stop startup and identify the later layer, config path, controlling
layer, and reason.

## Why OpenClaw owns composition

The launcher owns each source file and its declared order. OpenClaw owns how
those sources compose because OpenClaw also owns the config schema,
plugin-aware validation, tool-policy interpretation, runtime snapshot, and
mutation boundary. Keeping these decisions together gives every launcher the
same conflict and security behavior without teaching core about host-specific
roles.

Use `$include` to structure one authored config document. Includes do not
represent authority between independent sources, enforce monotonic tool-policy
bounds, or make the resulting runtime immutable. Flattening sources in the
launcher also erases their authority boundaries before OpenClaw can enforce
them and requires the launcher to duplicate OpenClaw-specific validation.

## Native config handling

Each layer remains an ordinary OpenClaw JSON5 document:

- `$include` is resolved relative to that layer file.
- `OPENCLAW_INCLUDE_ROOTS` authorizes the same additional include roots as the
  normal config reader.
- `${ENV_NAME}` references use the normal environment substitution behavior.
- The composed document passes the normal OpenClaw schema, defaults, plugin
  metadata, and plugin validation pipeline.

The root `meta` and `env` keys are not accepted in layered V1 because they
participate in bootstrap behavior that happens before composition. Supply
process environment through the launcher instead.

## Lobster example

A Lobster-hosted Scout can keep three independent inputs without baking values
into one generated `openclaw.json`.

### 1. Scout global config

```json5
// /run/lobster/openclaw/scout-global.json5
{
  gateway: {
    mode: "local",
  },
  tools: {
    allow: ["group:fs", "web_*"],
    deny: ["exec"],
  },
}
```

This file contains the Scout-wide baseline shared by every tenant instance.

### 2. Tenant network config

```json5
// /run/lobster/openclaw/tenant-network.json5
{
  gateway: {
    customBindHost: "10.42.17.8",
    trustedProxies: ["10.42.0.0/16"],
    controlUi: {
      allowedOrigins: ["https://scout.contoso.example"],
    },
  },
}
```

This file contains tenant-specific URLs and private-network boundaries. Lobster
can regenerate it from tenant and VPN state without rewriting global or local
operator choices.

### 3. Operator-local config

```json5
// /var/lib/lobster/openclaw/operator-local.json5
{
  agents: {
    defaults: {
      workspace: "/var/lib/lobster/workspace",
      model: {
        primary: "openai/gpt-5.4",
      },
    },
  },
  tools: {
    allow: ["read", "web_search"],
    deny: ["exec", "write"],
  },
}
```

The operator file adds local choices and tightens the earlier tool policy. It
cannot replace tenant network values or weaken the Scout baseline.

Start the Gateway with the files in the intended order:

```bash
openclaw gateway run \
  --config-layer scout-global=/run/lobster/openclaw/scout-global.json5 \
  --config-layer tenant-network=/run/lobster/openclaw/tenant-network.json5 \
  --config-layer operator-local=/var/lib/lobster/openclaw/operator-local.json5
```

The same options can appear before `run`:

```bash
openclaw gateway \
  --config-layer scout-global=/run/lobster/openclaw/scout-global.json5 \
  --config-layer tenant-network=/run/lobster/openclaw/tenant-network.json5 \
  --config-layer operator-local=/var/lib/lobster/openclaw/operator-local.json5 \
  run
```

## V1 lifecycle and write boundary

Layered V1 is deliberately startup-based and read-only:

- `config.get` reports the composed source and effective runtime config.
- Config persistence targeting the layered Gateway's canonical config path is
  blocked across Gateway RPCs and plugin/runtime config writers.
- An unrelated config path remains writable. A separate process may edit the
  canonical file, but that file is not the layered Gateway's effective config
  and the change does not affect its startup snapshot.
- `config.set`, `config.patch`, `config.apply`, and `config.openFile` reject the
  request rather than editing an unrelated canonical config file.
- Canonical config file watching and last-known-good promotion are disabled.
- Changing a layer file requires a full process restart. An in-process Gateway
  restart reuses the already validated startup snapshot.
- `--dev` cannot be combined with `--config-layer` because dev bootstrap creates
  or resets mutable canonical config state.

Live layer reload, writes, generations, provenance/status APIs, and management
controllers are not part of V1. The launcher owns source creation, permissions,
rollout, and process restart.
