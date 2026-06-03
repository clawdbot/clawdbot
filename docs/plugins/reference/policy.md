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

plugin

<!-- openclaw-plugin-reference:manual-start -->

## Behavior

The Policy plugin contributes doctor health checks for policy-managed OpenClaw
settings and governed workspace declarations. Policy currently covers channel
conformance, governed tool metadata, MCP server posture, model-provider posture,
private-network access posture, Gateway exposure posture, agent workspace/tool
posture, configured global/per-agent tool posture, configured sandbox runtime
posture, ingress/channel access posture, data-handling posture, and OpenClaw config secret
provider/auth profile posture.

Policy stores authored requirements in `policy.jsonc`, observes existing
OpenClaw settings and workspace declarations as evidence, and reports drift
through `openclaw policy check` and `openclaw doctor --lint`. A clean policy
check emits policy, evidence, findings, and attestation hashes that operators
can record for audit.

`openclaw policy compare --baseline <file>` compares one policy file to another
policy file. It is config-level conformance only: it uses policy rule metadata
to verify that the checked policy is not missing or weaker than the authored
baseline, and it does not inspect runtime state, credentials, or secret values.

Tool posture rules can require approved profiles, workspace-only filesystem
tools, bounded exec security/ask/host settings, disabled elevated mode, exact
`alsoAllow` entries, and required tool deny entries. The evidence records
additive `alsoAllow` entries because they can widen effective tool posture.
These checks observe config conformance only; they do not read runtime approval
state or add runtime enforcement.

Sandbox posture rules can require approved sandbox modes/backends, deny host
container networking, deny container namespace joins, require read-only container
mounts, deny container runtime socket mounts and unconfined container profiles,
and require sandbox browser CDP source ranges.
These checks observe config conformance only; they do not read runtime approval
state, inspect live containers, or add runtime enforcement.

Data-handling rules can require sensitive logging redaction, deny telemetry
content capture, require session retention maintenance, and deny session
transcript memory indexing. These checks observe config conformance only; they
do not inspect raw logs, telemetry exports, transcripts, memory files, secrets,
or personal data.

Named policy scopes under `scopes.<scopeName>` can add stricter normal policy
sections for the selector they list. `agentIds` supports `tools`,
`agents.workspace`, `sandbox`, and `dataHandling.memory`; `channelIds` supports
`ingress.channels`.
Runtime agent ids that are not explicitly listed in `agents.list[]` are checked
against inherited global/default posture rather than silently passing with no
evidence. Every scope present in `policy.jsonc` must be valid and enforceable
for its selector. Overlay rules are additional claims, so they do not weaken
top-level policy and can produce their own findings when the same observed
config violates both scopes.

<!-- openclaw-plugin-reference:manual-end -->

## Related docs

- [policy](/cli/policy)
