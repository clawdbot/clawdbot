---
name: diagnose-gateway
description: Diagnose Gateway, config, secrets, channels, and port failures without changing system state.
---

# Diagnose the Gateway

This playbook is read-only. Never print or persist secret values; report only redacted SecretRef owner state. Never hand-edit config files on disk. Every run ends with the observable Prove result or an exact explanation of why it could not be proven.

Use [Gateway troubleshooting](https://docs.openclaw.ai/gateway/troubleshooting) and [SecretRefs](https://docs.openclaw.ai/gateway/secrets).

## Gather

Run the `openclaw` tool's read actions `status`, `validate_config`, `gateway_status`, and `doctor`. From a trusted shell, collect `openclaw gateway status --deep`; on managed installs use `./scripts/clawlog.sh` for bounded recent logs. Check these signatures without guessing:

- invalid config or schema errors;
- degraded SecretRef owners, never secret ids or values;
- expired or rejected channel authentication;
- `EADDRINUSE`, another Gateway listener, or service/config port mismatch.

Correlate timestamps and identify the first owner-boundary failure.

## Mutate

Do not mutate config, services, credentials, ports, or files. Do not run `doctor --fix`, restart the Gateway, or kill a listener.

## Repair

Run read-only `openclaw doctor` and translate each finding into a recommended next action. Name the best next skill when applicable: `configure-channel`, `add-model-provider`, or `cloud-image-bake`. Recommend `openclaw doctor --fix` only as a separately approved action outside the active Custodian inference session.

## Prove

Repeat the smallest read-only probe that exposes the condition, such as `openclaw gateway status --deep --require-rpc` or a channel status probe. Record the observable result. If access, logs, or the Gateway are unavailable, report that exact blocker rather than declaring a cause.

## Report

Return findings in causal order, evidence for each, the current Gateway/config/SecretRef/channel/port state, and one recommended next skill or operator action. State explicitly that nothing was changed.
