---
summary: "Select a release-tested Gateway readiness posture"
read_when:
  - Running OpenClaw locally, in a container, behind a trusted proxy, or as a node controller
  - Choosing a readiness contract for an OpenClaw deployment
title: "Hosting profiles"
---

# Hosting profiles

Hosting profiles are optional, named presets over OpenClaw's canonical
[readiness conditions](/gateway/health#selected-readiness-criteria). Select a profile when the
Gateway should report ready only after the runtime facts for a known deployment posture are true.

Without a selected profile, OpenClaw keeps its ordinary Gateway lifecycle readiness baseline and
does not add profile-only conditions.

## Standard profiles

| Profile         | Use when                                         | Profile-specific required evidence                                                                                                                                                                      |
| --------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `local`         | Running a foreground or local Gateway            | No topology-specific evidence beyond the shared serving contract.                                                                                                                                       |
| `container`     | Exposing the Gateway directly from a container   | The effective listener is not loopback-only.                                                                                                                                                            |
| `reverse-proxy` | Running behind a trusted identity proxy          | Trusted-proxy auth is active, an identity header is configured, and at least one effective proxy source is trusted. Loopback proxy sources also require `gateway.auth.trustedProxy.allowLoopback=true`. |
| `node-mode`     | Controlling one or more paired execution targets | At least one target is paired, connected, command-approved, and available through a live control channel.                                                                                               |

Every profile requires the same agent-serving baseline: current configuration, an authenticated
default model route, resolved runtime secrets, writable workspace and session storage, and usable
plugin, context-engine, tool, MCP, sandbox, and harness surfaces. Features that are not configured
satisfy their capability criterion without starting work from the readiness request.

Shared state, durable delivery, and scheduler lifecycle are selected as advisory evidence. They
remain visible in the canonical result but do not block a profile because those owners may be lazy
or disabled. Operators can promote any advisory selector through `gateway.readiness.requiredCriteria`.

Profiles add requirements to the universal Gateway lifecycle conditions. They do not generate or
repair configuration, choose restart policy, or replace explicit `gateway.readiness` criteria.

## Inspect the catalog

The standard catalog is shipped with OpenClaw and can be inspected without loading configuration,
starting plugins, or contacting a Gateway:

```bash
openclaw hosting profiles list
openclaw hosting profiles inspect container
openclaw hosting profiles inspect node-mode --json
```

`list` shows each supported posture and the number of profile conditions, required criteria, and
advisories it selects. `inspect` shows the complete descriptor. JSON output includes
`contractVersion: 1` and is derived from the same definitions used by runtime readiness, so release
and support tooling does not need a second profile inventory.

These commands describe the shipped support contracts. They do not infer which profile a running
Gateway selected; use [`openclaw ready`](/cli/ready) for active profile attribution and live
conditions.

## Validate a running profile

Validate the active profile against the running Gateway's canonical readiness result:

```bash
openclaw hosting profiles validate
openclaw hosting profiles validate container --json
```

With no argument, the command validates whichever Standard Hosting Profile the Gateway reports.
With an argument, it also requires that exact profile. Validation checks the profile contract
version and the required profile-condition rows, then reports canonical readiness separately. A
profile can therefore be conformant but currently not ready, such as a `container` Gateway with a
loopback-only listener; both states produce a nonzero exit for host and CI use.

The JSON result embeds the canonical readiness result as its evidence. Validation does not load
local configuration, invoke plugins, reproduce profile predicates, or run a second evaluator.

## Select a profile

Use one of these equivalent inputs:

```json5
{
  hosting: {
    profile: "container",
  },
}
```

```bash
OPENCLAW_HOSTING_PROFILE=container openclaw gateway run
openclaw gateway run --hosting-profile container
```

When more than one input is present, precedence is:

```text
--hosting-profile > OPENCLAW_HOSTING_PROFILE > hosting.profile
```

Supported values are `local`, `container`, `reverse-proxy`, and `node-mode`. Invalid values stop
Gateway startup.

## Readiness identity

The canonical result identifies the host workload, process, Gateway serving lifecycle, selected
profile, and bounded observed nodes through the shared readiness subject package. A host may add a
workload-level correlation value:

```bash
OPENCLAW_INSTANCE_ID=workload-7 \
  openclaw gateway run --hosting-profile container
```

OpenClaw one-way fingerprints that host value before projection. It does not replace the
OpenClaw-generated process or Gateway IDs. The host value follows the host workload's renewal
boundary; the process ID changes at process start, and the Gateway ID changes at each serving
lifecycle start while remaining stable across readiness evaluation, reload, and drain.

Readiness, health, and status report `profileContractVersion: 1`, the selected `profile`, its
selection source (`argument`, `environment`, or `config`), and an
`openclaw/hosting-profile/selected` subject. Node mode also reports the observed node subjects, and
its conditions refer to those subjects so repeated results can be diffed. Profile fields are
omitted when no profile is selected. Use
[`openclaw ready`](/cli/ready) or `/readyz` for the serving decision; `/healthz` remains a shallow
liveness check.

## Container probe

After selecting `container`, a container host can use the canonical readiness command directly:

```dockerfile
HEALTHCHECK --interval=10s --timeout=3s --retries=3 \
  CMD openclaw ready --timeout 2500 || exit 1
```

A running process can still report non-ready, for example when its listener is loopback-only or
its mounted workspace is unavailable. The readiness result names the failed condition and reason.

## Related

- [Gateway health and readiness](/gateway/health)
- [`openclaw gateway`](/cli/gateway)
- [`openclaw ready`](/cli/ready)
- [Trusted proxy authentication](/gateway/trusted-proxy-auth)
