---
summary: "Per-agent Policy plugin overlays layered on top of global policy rules."
read_when:
  - You are designing per-agent policy requirements
  - You need to distinguish tool posture policy from workspace policy
  - You are configuring stricter policy for one named agent
title: "Agent-scoped policy overlays"
---

# Agent-scoped policy overlays

OpenClaw policy supports global requirements and stricter requirements for
explicit runtime agent ids. Some deployments need one agent to use a tighter
workspace and tool posture than other agents, but deployment-wide rules should
not force every agent to use the same posture.

This page describes the agent-scoped overlay model. The field reference remains
[`openclaw policy`](/cli/policy).

## Design goals

- Keep global policy as the deployment baseline.
- Let a named agent add stricter requirements without weakening global rules.
- Reuse existing policy section shapes where the evidence can be attributed to
  an agent.
- Avoid making `agents.workspace` a second tool-permission system.
- Leave global-only checks global until their evidence can be mapped to an
  agent.

## Shape

Use `scopes.<scopeName>` for purpose-named agent policy scopes. Each
scope lists the runtime `agentIds` it applies to, then reuses the normal
top-level policy section grammar where the section evidence can be attributed to
those agents. The initial shipped scoped sections are `tools` and
`agents.workspace`; sandbox and ingress stay out of this PR and can join the
same container once those policy PRs land and their evidence carries agent
identity. The scoped field inventory is backed by policy rule metadata that
records each field's strictness semantics for later policy-file conformance.

```jsonc
{
  "tools": {
    "denyTools": ["process"],
  },
  "agents": {
    "workspace": {
      "allowedAccess": ["none", "ro"],
    },
  },
  "scopes": {
    "release-agent-lockdown": {
      "agentIds": ["release-agent"],
      "agents": {
        "workspace": {
          "allowedAccess": ["none", "ro"],
        },
      },
      "tools": {
        "profiles": { "allow": ["minimal", "messaging"] },
        "fs": { "requireWorkspaceOnly": true },
        "exec": {
          "allowSecurity": ["deny", "allowlist"],
          "requireAsk": ["always"],
          "allowHosts": ["sandbox"],
        },
        "elevated": { "allow": false },
        "alsoAllow": { "expected": ["message", "read"] },
        "denyTools": ["exec", "process", "write", "edit", "apply_patch"],
      },
    },
  },
}
```

`agents.workspace` remains the existing all-agent workspace baseline.
`scopes.<scopeName>` is a scoped overlay, not a replacement for global
policy. The scope name is descriptive only; matching uses `agentIds`, not
display names. It deliberately contains normal section names instead of a
bespoke per-agent mini-grammar.
Every scope present in `policy.jsonc` must be valid and enforceable. In this
PR, the only supported selector is `agentIds`, and it supports only `tools.*`
and `agents.workspace.*`.

## Layering semantics

Policy evaluation is additive:

1. Top-level policy applies to all matching evidence.
2. Existing `agents.workspace` applies to defaults and every listed agent.
3. `scopes.<scopeName>` applies to evidence for each normalized runtime
   id in `agentIds`.
4. Multiple scope blocks may target the same agent when they govern
   different fields, or when a later value for the same field is equally or
   more restrictive according to policy metadata.
5. A named-agent overlay can tighten policy, but it cannot make a global
   violation acceptable.

If both global and agent-scoped rules fail, findings should point at the rule
that was violated:

```text
oc://policy.jsonc/tools/denyTools
oc://policy.jsonc/scopes/release-agent-lockdown/tools/denyTools
oc://policy.jsonc/scopes/release-agent-lockdown/agents/workspace/allowedAccess
```

That keeps broad tool posture, named-agent tool posture, and workspace posture
auditable as separate requirements even when they observe the same config
fields.

Exact-list claims such as `tools.alsoAllow.expected` compare the configured list
to the expected list and report both missing expected entries and unexpected
extra entries. This is intended for additive posture such as `alsoAllow`, where
one extra entry can widen an agent beyond its reviewed role.

## Policy and config layering

The overlay model separates where policy is authored from where OpenClaw config
is observed:

| Policy scope                            | Observed config                                      | Applies to                        | Example result                                                                |
| --------------------------------------- | ---------------------------------------------------- | --------------------------------- | ----------------------------------------------------------------------------- |
| Top-level `tools.*`                     | Global `tools.*` and inherited agent tool posture    | All agents using matching posture | Deny `gateway` exec host for every agent unless the global policy allows it.  |
| Top-level `tools.*`                     | `agents.list[].tools.*` overrides                    | Any agent with an override        | Flag one agent that overrides `tools.exec.host` to an unapproved value.       |
| `scopes.<scopeName>.tools.*`            | Matching `agents.list[]` entry and inherited posture | Only that named agent             | Let most agents use `node` exec host while one agent must use only `sandbox`. |
| `agents.workspace`                      | Defaults and every listed agent workspace posture    | Defaults and all listed agents    | Require every agent workspace access to be `none` or `ro`.                    |
| `scopes.<scopeName>.agents.workspace.*` | Matching `agents.list[]` workspace posture           | Only that named agent             | Require one agent to be read-only without requiring the same for `main`.      |

Per-agent overlays are additive. A named-agent rule can be stricter than the
top-level rule, but it cannot make a global violation acceptable. For allow-list
rules, the effective allowed set is the intersection of the global rule and the
named-agent overlay when both are present.

For example, if top-level `tools.exec.allowHosts` permits `["sandbox", "node"]`
and `scopes.release-agent-lockdown.tools.exec.allowHosts` permits only
`["sandbox"]`, `release-agent` fails when its effective exec host is `node`;
another agent can still pass
with `node`.

## Tool posture versus workspace posture

Tool posture belongs under `tools` because it describes what tool behavior a
configuration may expose. The existing `tools.*` policy observes both global
`tools.*` config and per-agent `agents.list[].tools.*` overrides.

Workspace posture belongs under `workspace` because it describes sandbox mode
and workspace access. The workspace section should not grow into a general tool
policy namespace. If one agent needs stricter tool restrictions to make its
workspace posture meaningful, put those restrictions in the same agent overlay
under `scopes.<scopeName>.tools`.

For a restricted release agent, the intended split is:

```jsonc
{
  "scopes": {
    "release-agent-lockdown": {
      "agentIds": ["release-agent"],
      "agents": {
        "workspace": { "allowedAccess": ["none", "ro"] },
      },
      "tools": {
        "denyTools": ["exec", "process", "write", "edit", "apply_patch"],
      },
    },
  },
}
```

## Section eligibility

An agent-scoped section should be added only when policy evidence carries an
agent id or can be attributed to one without guessing.

| Section     | Initial agent-scoped status | Reason                                                                   |
| ----------- | --------------------------- | ------------------------------------------------------------------------ |
| `workspace` | Include                     | Agent sandbox/workspace evidence already has agent identity.             |
| `tools`     | Include                     | Tool posture evidence includes global and per-agent tool config.         |
| `sandbox`   | Pipeline follow-up          | Keep out until the sandbox posture PR lands and evidence can be scoped.  |
| `ingress`   | Pipeline follow-up          | Keep out until ingress/channel posture lands with agent attribution.     |
| `models`    | Include when mapped         | Selected model refs can be agent-specific.                               |
| `mcp`       | Include when mapped         | Use only when MCP server evidence is attributable to an agent.           |
| `auth`      | Defer                       | Auth profile metadata is a config catalog unless agent binding is clear. |
| `channels`  | Defer                       | Channel provider posture is deployment-level until routing is scoped.    |
| `gateway`   | Keep global                 | Gateway exposure/auth/http posture is process-level.                     |
| `network`   | Keep global                 | Private-network SSRF posture is runtime-level.                           |
| `secrets`   | Keep global first           | Secret provider posture is shared unless refs are agent-attributed.      |

## Compatibility

The implementation is additive:

- keep all existing top-level policy fields valid;
- keep `agents.workspace` semantics unchanged;
- validate `scopes` before evaluating scoped rules;
- reject unsupported scoped sections clearly until their evidence and policy
  contracts are implemented;
- do not reinterpret top-level `tools.requireMetadata` as agent-scoped, because
  tool metadata describes the declared workspace tool catalog;
- include agent-scoped evidence in the attestation hash when any scoped rule is
  present.

This lets broad tool posture remain a top-level policy contract while named
agents add stricter observable claims without weakening the global baseline.
