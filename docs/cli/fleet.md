---
summary: "CLI reference for provisioning and managing isolated per-tenant OpenClaw cells"
read_when:
  - You host multiple tenant trust domains on one machine
  - You need to create, inspect, upgrade, or remove fleet cells
title: "Fleet"
---

# `openclaw fleet`

`openclaw fleet` manages complete OpenClaw instances called **cells**. Each cell has its own Gateway, state, credentials, channel accounts, container, and loopback-only host port. Use one cell for each tenant trust boundary; do not use one shared Gateway as a hostile multi-tenant boundary.

Fleet is **experimental**. Command names, flags, output shapes, and the container profile can change between releases without a deprecation window while the surface settles.

Fleet supports Docker and Podman. The default image is `ghcr.io/openclaw/openclaw:latest`.

Fleet is tested on Linux and macOS hosts. Windows hosts are currently untested.

## Quick start

```bash
openclaw fleet create acme
openclaw fleet status acme
openclaw fleet list
```

`fleet create` prints the generated Gateway token once along with the cell URL. Store the token immediately, then configure each tenant's channel accounts inside that tenant's cell.

## Tenant IDs

Tenant IDs must match:

```text
^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$
```

This allows 1 to 40 lowercase letters, digits, and internal hyphens. An ID must start and end with a letter or digit. Uppercase letters, underscores, slashes, dots, whitespace, and traversal strings such as `../acme` are rejected.

The ID becomes part of the container name: `openclaw-cell-<tenant>`.

## `fleet create`

Create a cell and start it:

```bash
openclaw fleet create acme
```

Create a Podman cell on a fixed port without starting it:

```bash
openclaw fleet create acme \
  --runtime podman \
  --port 19125 \
  --no-start
```

Pass tenant-specific environment variables by repeating `--env`:

```bash
openclaw fleet create acme \
  --env TZ=America/Los_Angeles \
  --env OPENCLAW_DISABLE_BONJOUR=1
```

Environment keys use letters, digits, and underscores and cannot start with a digit. Values must be single-line because Fleet passes them through a protected runtime environment file. Fleet rejects attempts to override the managed container-path and Gateway-token variables listed under [Storage and container layout](#storage-and-container-layout).

### Create options

| Option                    | Default                               | Description                                                                                    |
| ------------------------- | ------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `--image <ref>`           | `ghcr.io/openclaw/openclaw:latest`    | Container image for the cell.                                                                  |
| `--runtime <runtime>`     | `docker`                              | Container CLI: `docker` or `podman`.                                                           |
| `--port <number>`         | Automatically allocated from `19100`  | Loopback host port. An explicitly selected port must not belong to another registered cell.    |
| `--memory <value>`        | `2g`                                  | Container memory limit in Docker/Podman syntax.                                                |
| `--cpus <value>`          | `2`                                   | Container CPU limit.                                                                           |
| `--disk <size>`           | None                                  | Cap the container writable layer when the storage backend supports quotas.                     |
| `--network <mode>`        | `bridge`                              | Outbound network mode: `bridge` or `internal`.                                                 |
| `--pids-limit <number>`   | `512`                                 | Maximum number of processes in the container.                                                  |
| `--env <KEY=VALUE>`       | None                                  | Pass an environment variable to the cell. Repeat for multiple values.                          |
| `--gateway-token <value>` | Random 32-character hexadecimal token | Use a supplied Gateway token instead of generating one. See [Token handling](#token-handling). |
| `--no-start`              | Cell starts                           | Create the container without starting it.                                                      |
| `--json`                  | Human-readable output                 | Print machine-readable output.                                                                 |

Automatic allocation selects the first unused registry port at or above `19100`. Fleet rejects duplicate tenant IDs and explicit ports already assigned to another cell.

Image references are passed as one container-runtime argument. Empty references and values beginning with `-` are rejected so an image cannot be interpreted as a Docker or Podman option.

The selected Docker or Podman endpoint must be local. Fleet rejects remote Docker contexts, `DOCKER_HOST` endpoints, and remote Podman services before reserving a port or creating local state; remote cell hosts need a separate storage and endpoint contract and are deferred from this MVP.

When Fleet starts a new cell, create waits up to about a minute for its Gateway to answer `/healthz`. If the cell does not become healthy, Fleet leaves its container and registry row intact for `fleet status`, `fleet logs`, or explicit removal. `--no-start` skips this health gate. The generated Gateway token of an unhealthy new cell is not lost - it remains in the container environment (`docker|podman inspect`), and because the cell has served no traffic yet, `fleet rm --force` followed by a fresh create is always a safe alternative.

### Pinning by digest

Create and upgrade accept digest-pinned image references such as `--image ghcr.io/openclaw/openclaw@sha256:<digest>`. Fleet passes the image reference through verbatim to Docker or Podman, which lets an operator keep a cell on immutable image bytes instead of a moving tag.

The create result includes the tenant ID, container name, host port, Gateway token, and local URL. Even in JSON output, treat the result as secret-bearing because it contains the token.

### Disk limits

`--disk` limits only the container writable layer. The bind-mounted per-tenant state and auth directories remain host storage; use host filesystem project quotas when those directories also need a hard limit.

| Runtime/storage backend | `--disk` support                                                             |
| ----------------------- | ---------------------------------------------------------------------------- |
| Docker overlay2 on XFS  | Requires the XFS `pquota` mount option.                                      |
| Docker btrfs or zfs     | Supported by the storage driver.                                             |
| Podman overlay          | Requires XFS backing storage.                                                |
| Other backends          | Container creation fails with the daemon error and Fleet's backend guidance. |

### Egress policy

| Mode       | Docker                                                                                                | Podman                                                                              |
| ---------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `bridge`   | Supported; outbound egress is unrestricted by default.                                                | Supported; outbound egress is unrestricted by default.                              |
| `internal` | Rejected because Docker does not preserve the published loopback Gateway port on an internal network. | Supported; the loopback Gateway remains published while outbound egress is blocked. |

For Docker, keep the bridge mode and enforce outbound policy with host firewall rules such as the `DOCKER-USER` chain.

## `fleet list`

List cells in tenant-ID order:

```bash
openclaw fleet list
openclaw fleet ls
openclaw fleet list --json
```

The table contains:

| Column    | Meaning                                                                                                                                                                                                                                                                               |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tenant`  | Tenant ID.                                                                                                                                                                                                                                                                            |
| `state`   | Live container state from Docker or Podman inspection. `unknown` means the runtime was unavailable, or a container with the cell's name exists but its Fleet ownership labels do not match the registry record (a collision or tampering signal — inspect it manually before acting). |
| `port`    | Loopback host port mapped to the cell Gateway.                                                                                                                                                                                                                                        |
| `image`   | Recorded container image.                                                                                                                                                                                                                                                             |
| `created` | Cell creation time.                                                                                                                                                                                                                                                                   |

Registry rows remain visible when Docker or Podman is unavailable; only live state becomes `unknown`.

## `fleet status`

Inspect one cell:

```bash
openclaw fleet status acme
openclaw fleet status acme --json
```

Status combines the fleet registry row, live container inspection, and a short best-effort request to:

```text
http://127.0.0.1:<host-port>/healthz
```

The health result is `ok`, `failed`, or `skipped`. `/healthz` proves Gateway liveness, not full readiness of every configured channel or plugin. The probe is skipped when there is no usable local endpoint to check.

## `fleet logs`

Stream a cell's container logs directly to the terminal:

```bash
openclaw fleet logs acme
openclaw fleet logs acme --follow
openclaw fleet logs acme --tail 200
openclaw fleet logs acme --since 10m
```

Fleet verifies the registered container's ownership labels before reading any logs, so it refuses a foreign container using the expected cell name. Press Ctrl-C to end `--follow` without treating the operator stop as a command failure. Log output is piped through a redaction filter that replaces the cell's current Gateway token with `<redacted>` before anything reaches the terminal.

`fleet logs` has no `--json` mode because container logs are a raw stdout/stderr stream. For scripts, bound the output with `--tail` and use ordinary shell redirection or pipelines.

## `fleet start`, `fleet stop`, and `fleet restart`

Control an existing cell with its recorded runtime:

```bash
openclaw fleet start acme
openclaw fleet stop acme
openclaw fleet restart acme
```

These commands operate on the registered container name. They fail if the tenant is unknown or the recorded runtime cannot perform the operation.

## `fleet upgrade`

Re-pull the recorded image and replace the cell container:

```bash
openclaw fleet upgrade acme
```

Move the cell to another image:

```bash
openclaw fleet upgrade acme --image ghcr.io/openclaw/openclaw:<version>
```

Upgrade pulls the target image, inspects the existing container and per-cell network, stops and removes the container, then recreates and starts it. The replacement preserves the same host port, data directories, per-cell bridge network, runtime profile, resource limits, restart policy, Fleet-managed environment, and values originally supplied with `--env`. Mounted state survives container replacement; image-default environment can change with the target image.

The replacement is committed only after its Gateway answers `/healthz` on the cell's loopback port, matching the health contract the official compose file uses. A replacement that exits, crash-loops, or fails to become healthy within about a minute is removed and the previous container is restored, so a broken image does not take down a working cell.

The Gateway token is intentionally not stored in the fleet registry. Before removing the old container, Fleet reads its environment and carries `OPENCLAW_GATEWAY_TOKEN` into the replacement. Do not manually remove the old container before an upgrade if the token exists nowhere else you control.

## `fleet backup` and `fleet restore`

Back up one stopped cell:

```bash
openclaw fleet stop acme
openclaw fleet backup acme --out ./acme.tgz
```

Restore that archive into the registered cell:

```bash
openclaw fleet restore acme --from ./acme.tgz
```

These are host-operator-privileged commands. Archives contain tenant state and auth secrets, are created with mode `0600`, and must be stored like credentials. Backup refuses a running cell so SQLite state is captured consistently. Restore refuses a running cell unless `--force` is supplied, replaces only that tenant's state, rotates the Gateway token, and prints the new token once. Fleet backs up one tenant at a time; all-tenant backup is a separate operator action.

Both commands accept `--max-bytes <bytes>` to bound archived or extracted file data, and both apply the same fixed one-million budget of archive path segments so metadata-only archive bombs cannot exhaust host inodes and every accepted backup stays restorable. Backup accepts `--out <path>` and both commands support `--json`.

Archives contain regular files and directories only. Backup never follows or stores symlinks, hard links, sockets, or device nodes; skipped counts are reported in the result. Restore rejects archives containing any other entry type. Recreatable symlink trees such as workspace `node_modules` must be reinstalled inside the cell after a restore.

## `fleet doctor`

Audit every cell or one tenant without changing runtime or filesystem state:

```bash
openclaw fleet doctor
openclaw fleet doctor acme --json
```

Doctor checks runtime locality, ownership labels, health, hardening, resource limits, loopback port binding, token presence, network ownership and egress mode, and private state-directory permissions. Warnings describe stopped cells or ownership differences; any failed finding sets a nonzero process exit code.

## `fleet rm`

Remove a stopped cell from the runtime and registry while keeping tenant data:

```bash
openclaw fleet rm acme
```

A running container requires `--force`:

```bash
openclaw fleet rm acme --force
```

Permanently remove the cell data as well:

```bash
openclaw fleet rm acme --purge-data --force
```

Fleet removes the cell container before removing its dedicated bridge network. `--purge-data` requires `--force`. Before recursive deletion, Fleet resolves both Fleet-owned roots and both per-tenant directories. Each target must be the exact expected tenant leaf, strictly inside its root, and not a symlink. These containment checks prevent a corrupted registry path or cross-tenant symlink from redirecting deletion elsewhere.

Purge is retryable when an exact expected tenant directory is already absent. This lets a later invocation finish cleanup after a partial filesystem failure without relaxing the path checks for directories that still exist.

## Storage and container layout

Cell state and auth-profile encryption keys use separate per-tenant host paths under the active OpenClaw state directory:

```text
<state-dir>/fleet/cells/<tenant>/
<state-dir>/fleet/auth-profile-secrets/<tenant>/
```

The first directory is mounted at `/home/node/.openclaw`. The second is mounted at `/home/node/.config/openclaw`, matching the official Docker setup's encryption-key mount. The encryption key is therefore not exposed beneath the ordinary state mount or included when only the cell-state directory is backed up or shared. Both directories survive normal removal and upgrade; `fleet rm --purge-data --force` deletes both after separate containment checks.

Before first start, Fleet initializes the cell config with `gateway.mode=local`, token auth, the LAN container bind, and Control UI origins for the allocated host port. The token value is not written to that config; it remains in the container environment.

Fleet pins the official image's container paths with these environment values:

| Variable                 | Container value                      |
| ------------------------ | ------------------------------------ |
| `HOME`                   | `/home/node`                         |
| `OPENCLAW_HOME`          | `/home/node`                         |
| `OPENCLAW_STATE_DIR`     | `/home/node/.openclaw`               |
| `OPENCLAW_CONFIG_PATH`   | `/home/node/.openclaw/openclaw.json` |
| `OPENCLAW_WORKSPACE_DIR` | `/home/node/.openclaw/workspace`     |
| `OPENCLAW_GATEWAY_TOKEN` | Generated or supplied cell token     |

The official image defaults to the non-root `node` user with UID 1000. Fleet keeps the private `0700` bind mounts writable without making them world-accessible. Rootful Docker runs the cell with the invoking non-root UID and GID; rootless Docker uses container UID 0, which maps to the invoking unprivileged host user inside the daemon's user namespace. Podman uses `keep-id` with the invoking UID and GID. When Fleet itself runs as root against a rootful runtime, it retains the image user and assigns the initial mount files to UID/GID 1000.

On SELinux hosts, Docker and Podman mounts receive a private `:Z` relabel. If you restore or relocate cell data, keep the bind-mounted paths writable by the effective container user. The profile is rootless-friendly, but Docker or Podman must already be configured for rootless operation on the host; Fleet does not convert a rootful daemon into a rootless one.

## Security profile

Fleet applies the following profile to every cell:

| Control              | Applied profile                                      | Why                                                                                    |
| -------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Linux capabilities   | `--cap-drop=ALL`                                     | The Gateway is a Node.js process and needs no added Linux capabilities.                |
| Privilege escalation | `--security-opt no-new-privileges`                   | Prevents processes from gaining privileges through setuid or setgid binaries.          |
| Init process         | `--init`                                             | Reaps descendant processes and forwards container lifecycle signals.                   |
| Process limit        | `--pids-limit 512` by default                        | Bounds fork and process exhaustion.                                                    |
| Memory limit         | `--memory 2g` by default                             | Bounds cell memory use.                                                                |
| CPU limit            | `--cpus 2` by default                                | Bounds cell CPU use.                                                                   |
| Writable-layer disk  | Optional `--disk`                                    | Bounds the container layer when the runtime storage backend supports quotas.           |
| Restart policy       | `--restart unless-stopped`                           | Restarts a failed cell without overriding an intentional stop.                         |
| Host publishing      | `127.0.0.1:<host-port>:18789` only                   | Keeps the Gateway off wildcard host interfaces.                                        |
| Cell network         | One bridge or Podman internal network per cell       | Separates container-IP traffic and optionally blocks Podman outbound egress.           |
| Container identity   | Host-matched user mapping                            | Keeps private bind mounts writable without granting world access.                      |
| Persistent state     | Per-cell mounts; no shared state mount               | Keeps tenant config, credentials, sessions, and workspaces in that tenant's data tree. |
| Container command    | `node dist/index.js gateway --bind lan --port 18789` | Listens on the container network so the loopback-only host port mapping can reach it.  |

Fleet never mounts `/var/run/docker.sock`, uses `--privileged` or host networking, or adds capabilities. The per-cell bridge is a cross-cell separation boundary, not an outbound firewall: cells retain the network egress needed for providers and channels. Front the loopback port with a proxy, SSH tunnel, or tailnet configuration that matches your deployment. `http://127.0.0.1:<port>` is directly reachable only from the Fleet host.

This profile separates tenant containers, but it does not protect tenants from the Fleet operator, the container runtime administrator, or a compromised host. See [Multi-tenant hosting](/gateway/multi-tenant-hosting) for the complete trust model and stronger isolation options.

## Token handling

By default, `fleet create` generates a cryptographically random 32-character hexadecimal Gateway token and prints it once in the create result. Store it in your approved secret manager and avoid capturing create output in logs.

`--gateway-token` places a custom token in the local process arguments, which may be retained in shell history or visible in process listings. Prefer the generated token unless an existing secret-management workflow requires a supplied value.

The token and every value passed with `--env` live in the container environment. Fleet writes them to a short-lived mode-`0600` environment file, passes only that file's path to Docker or Podman, and removes it after the runtime command finishes. Values explicitly typed in `openclaw fleet create --gateway-token ...` or `--env KEY=VALUE` can still be visible in the outer `openclaw` process arguments and shell history.

Container environment values are not hidden from the trusted host operator: Docker or Podman administrators can read them with container inspection. Fleet's "shown once" note describes normal CLI output, not resistance to a host administrator.

## Related

- [Multi-tenant hosting](/gateway/multi-tenant-hosting)
- [Docker](/install/docker)
- [Podman](/install/podman)
- [Gateway security](/gateway/security)
