---
summary: "Adds policy-backed doctor checks for workspace conformance."
read_when:
  - You are installing, configuring, or auditing the policy plugin
title: "Policy plugin"
---

# Policy plugin

Adds policy-backed doctor checks for workspace conformance.

## Distribution

- Package: `@openclaw/policy`
- Install route: included in OpenClaw

## Surface

plugin; CLI command: [`openclaw policy`](/cli/policy)

## Behavior

The Policy plugin contributes doctor health checks for policy-managed OpenClaw
settings and governed workspace declarations. Policy currently covers channel
conformance, governed tool metadata, MCP server posture, model-provider posture,
private-network access posture, Gateway exposure posture, and OpenClaw config
secret provider/auth profile posture.

Policy stores authored requirements in `policy.jsonc`, observes existing
OpenClaw settings and workspace declarations as evidence, and reports drift
through `openclaw policy check` and `openclaw doctor --lint`. A clean policy
check emits policy, evidence, findings, and attestation hashes that operators
can record for audit.

## Related docs

- [Policy CLI](/cli/policy)
- [Doctor lint mode](/cli/doctor#lint-mode)
