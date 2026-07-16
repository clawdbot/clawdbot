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

| Profile         | Use when                                         | Additional required evidence                                                                                                            |
| --------------- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `local`         | Running a foreground or local Gateway            | The workspace is writable.                                                                                                              |
| `container`     | Exposing the Gateway directly from a container   | The workspace is writable and the effective listener is not loopback-only.                                                              |
| `reverse-proxy` | Running behind a trusted identity proxy          | The workspace is writable, trusted-proxy auth is active, an identity header is configured, and at least one proxy source is trusted.    |
| `node-mode`     | Controlling one or more paired execution targets | The workspace is writable and at least one target is paired, connected, command-approved, and available through a live control channel. |

Profiles add requirements to the universal Gateway lifecycle conditions. They do not generate or
repair configuration, choose restart policy, or replace explicit `gateway.readiness` criteria.

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

## Runtime identity

Hosts may attach readiness evidence to a logical runtime and one process or container incarnation:

```bash
openclaw gateway run \
  --hosting-profile container \
  --runtime-id tenant-42/scout-primary \
  --incarnation-id container-7f3a
```

`OPENCLAW_RUNTIME_ID` and `OPENCLAW_INCARNATION_ID` provide the same values through the
environment. OpenClaw defaults the logical runtime ID to `local` and generates an incarnation ID
when they are omitted.

Readiness, health, and status report the selected profile and activation identity. Use
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
