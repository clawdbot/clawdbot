---
doc-schema-version: 1
summary: "Host multiple tenant trust domains as one isolated OpenClaw Gateway cell per tenant"
read_when:
  - You are hosting OpenClaw for multiple users or organizations
  - You need to choose an isolation boundary for tenant workloads
title: "Multi-tenant hosting"
---

# Multi-tenant hosting

OpenClaw's default security model is one trusted operator boundary per Gateway, not hostile multi-tenant isolation inside one shared Gateway. Hosting users or organizations that do not share a trust boundary therefore means running a separate complete OpenClaw instance for each tenant.

`openclaw fleet` calls each isolated instance a **cell**. A cell is a full Gateway in a hardened container with its own state, credentials, workspace, channel accounts, token, and loopback-only host port.

Fleet is **experimental**: its commands, flags, and container profile can change between releases without a deprecation window.

Fleet is tested on Linux and macOS hosts. Windows hosts are currently untested.

## Why each tenant needs a cell

An authenticated operator inside one Gateway has a trusted control-plane role. Session IDs select routing; they do not authorize one tenant against another. Agent sandboxing can reduce the effect of untrusted content and tool execution, but it does not turn one shared Gateway into a tenant authorization boundary.

Use one cell per tenant so each trust domain has a separate Gateway process, container, persistent state tree, and Gateway credential. This follows the [Gateway security model](/gateway/security): do not co-locate mutually untrusted users in one OpenClaw process or one OS user.

## Architecture

The Fleet CLI is a host-side lifecycle supervisor. It records cells in the OpenClaw state database and asks a local Docker or Podman runtime to create, inspect, start, stop, replace, and remove their containers. Remote runtime endpoints are not supported because Fleet's bind paths and loopback URLs belong to the local host. Fleet does not proxy tenant messages and does not add a shared application-level data path between cells.

Each cell runs the official `ghcr.io/openclaw/openclaw` image on its own user-defined bridge network. Separate bridges prevent direct container-IP traffic between cells while retaining outbound NAT access for providers and channels. Outbound egress is unrestricted by default. Podman cells can use `--network internal` to block egress while preserving the published loopback Gateway port. Docker internal networks break that published port, so Fleet rejects the combination; enforce Docker egress policy with host firewall rules such as the `DOCKER-USER` chain instead. The cell Gateway listens on port `18789` inside the container, while the runtime publishes it only to `127.0.0.1:<allocated-port>` on the host. An operator can place an approved reverse proxy, SSH tunnel, or tailnet in front of that loopback endpoint when remote access is needed.

Persistent Gateway state comes from `<state-dir>/fleet/cells/<tenant>/` and is mounted at `/home/node/.openclaw`. Auth-profile encryption keys come from the separate `<state-dir>/fleet/auth-profile-secrets/<tenant>/` host path and are mounted at `/home/node/.config/openclaw`, matching the official [Docker persistence layout](/install/docker#storage-and-persistence). The key is not nested beneath the ordinary state mount. Per-tenant channel accounts terminate inside the cell that owns them; Fleet does not provide a shared channel account or inbound message router.

The official image defaults to the non-root `node` user with UID 1000. Fleet uses host-compatible user mappings so private bind mounts stay writable: Podman uses `keep-id`, rootful Docker uses the invoking non-root identity, and rootless Docker maps container root to the unprivileged daemon user. Docker and Podman apply a private `:Z` relabel when host SELinux is active. The container profile avoids privileged host features and is rootless-friendly, but rootless operation is a host runtime choice and prerequisite, not something Fleet enables automatically.

## Trust boundary

Multi-tenancy protects tenants from each other. The Fleet operator and the host are trusted by every tenant. Resistance to a compromised host is a non-goal.

This means a host administrator can inspect container configuration and environment, read mounted cell data, replace images, or enter containers. Gateway tokens and values passed with `--env` are visible to an administrator through Docker or Podman inspection. Use host controls, administrative access policy, monitoring, backups, and an approved secret manager accordingly.

The baseline prevents accidental wildcard network exposure and removes common container escalation primitives, but it does not make an untrusted host safe.

## Isolation ladder

Choose the boundary that matches the tenants you host:

1. **Hardened container baseline.** Fleet drops all Linux capabilities, enables `no-new-privileges`, applies PID, memory, CPU, and optional writable-layer disk limits, uses separate persistent mounts and per-cell networks, and publishes only to host loopback. Bridge networking leaves egress unrestricted; use Podman `--network internal` or Docker host firewall policy when a cell must not initiate outbound connections. This is the default profile for tenants that trust the operator and host.
2. **Stronger container or VM isolation.** For higher-risk workloads, configure Docker or Podman to use a stronger OCI isolation runtime such as gVisor or Kata Containers, or place cells in microVMs. This is runtime or infrastructure configuration; Fleet's `--runtime docker|podman` option chooses the container CLI, not the OCI isolation backend. See Docker's [alternative container runtimes](https://docs.docker.com/engine/daemon/alternative-runtimes/) and the [Docker VM runtime guide](/install/docker-vm-runtime).
3. **Separate machines for hostile tenants.** Do not co-locate hostile tenants in one OpenClaw process or OS user. When tenants do not trust the same host operator or need a stronger administrative boundary, use separate VMs or physical hosts with separate runtime administration.

No rung in this ladder changes the OpenClaw application trust model: one Gateway remains one trusted operator domain.

## Quick start

Create a cell. The command prints a generated Gateway token once, so store it immediately:

```bash
openclaw fleet create acme
```

Open the reported `http://127.0.0.1:<port>` URL on the Fleet host, authenticate with that tenant's token, and configure provider credentials and channel accounts inside the cell.

Check the container state and Gateway liveness:

```bash
openclaw fleet status acme
```

Upgrade while preserving the host port, mounted data, resource profile, user-supplied environment, and Gateway token:

```bash
openclaw fleet upgrade acme
```

Remove the container and registry row while retaining tenant data:

```bash
openclaw fleet rm acme --force
```

To delete persistent tenant data too, add `--purge-data`. Purge requires `--force`, is irreversible, and performs a resolved-path containment check before deleting anything:

```bash
openclaw fleet rm acme --purge-data --force
```

See the [`openclaw fleet` CLI reference](/cli/fleet) for every command and option.

## Current scope

Fleet does not provide these surfaces:

- Shared channel accounts or a shared ingress router
- Slimmed-down per-tenant host processes instead of complete OpenClaw instances
- Remote cell hosts managed by one supervisor
- A tenant self-service portal, billing plane, or delegated administration UI

These capabilities need explicit identity, routing, authorization, and failure-domain contracts. Do not approximate them by sharing one Gateway or its credentials across tenants. Fleet is a single-host lifecycle supervisor; multi-machine, identity-governed fleets require a separate control-plane layer.

## Related

- [`openclaw fleet`](/cli/fleet)
- [Gateway security](/gateway/security)
- [Multiple gateways](/gateway/multiple-gateways)
- [Docker](/install/docker)
- [Podman](/install/podman)
