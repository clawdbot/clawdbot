---
summary: "CLI reference for `openclaw daemon` (legacy alias for gateway service management)"
read_when:
  - You still use `openclaw daemon ...` in scripts
  - You need service lifecycle commands (install/start/stop/restart/status)
title: "Daemon"
---

# `openclaw daemon`

Legacy alias for Gateway service management. `openclaw daemon ...` maps to the same service-control commands as `openclaw gateway ...`. Prefer [`openclaw gateway`](/cli/gateway) for current docs and examples.

## Usage

```bash
openclaw daemon status
openclaw daemon install
openclaw daemon start
openclaw daemon stop
openclaw daemon restart
openclaw daemon uninstall
```

## Subcommands and options

| Subcommand  | Options                                                                                          |
| ----------- | ------------------------------------------------------------------------------------------------ |
| `status`    | `--url`, `--token`, `--password`, `--timeout`, `--no-probe`, `--require-rpc`, `--deep`, `--json` |
| `install`   | `--port`, `--runtime <node>`, `--token`, `--wrapper <path>`, `--force`, `--json`                 |
| `uninstall` | `--json`                                                                                         |
| `start`     | `--json`                                                                                         |
| `stop`      | `--json`, `--disable` (launchd only: persistently suppress KeepAlive/RunAtLoad until next start) |
| `restart`   | `--force`, `--safe`, `--skip-deferral`, `--wait <duration>`, `--json`                            |

- `status`: shows service install state (launchd/systemd/schtasks) and probes Gateway health.
- `install`: installs the service; `--force` reinstalls/overwrites an existing install.
- `restart --safe`: asks the running Gateway to preflight active work and schedule one coalesced restart after work drains, bounded to 5 minutes. When that budget expires, the restart is forced anyway. Plain `restart` uses the service manager directly; `--force` is the immediate override.
- `restart --safe --skip-deferral`: bypasses the active-work deferral gate so the Gateway restarts immediately even when blockers are reported. Requires `--safe`.

## Notes

- `status` resolves configured auth SecretRefs for probe auth when possible. If a required SecretRef is unresolved, `status --json` reports `rpc.authWarning`; pass `--token`/`--password` explicitly or resolve the secret source first. Unresolved-auth warnings are suppressed once the probe otherwise succeeds.
- `status --deep` adds a best-effort system-level scan for other gateway-like services (prints cleanup hints; one Gateway per machine is still the recommendation) and runs config validation in plugin-aware mode, surfacing plugin manifest warnings that the fast default path skips.
- On Linux systemd installs, token-drift checks inspect both `Environment=` and `EnvironmentFile=` unit sources.
- Token-drift checks resolve `gateway.auth.token` SecretRefs using merged runtime env (service command env first, then process env). If token auth is not effectively active (`gateway.auth.mode` of `password`/`none`/`trusted-proxy`, or unset with password able to win), config token resolution is skipped.
- `install` validates a SecretRef-managed `gateway.auth.token` is resolvable but never persists the resolved value into service environment metadata; if it can't resolve, install fails closed.
- If both `gateway.auth.token` and `gateway.auth.password` are configured and `gateway.auth.mode` is unset, `install` blocks until you set the mode explicitly.
- On macOS, `install` keeps LaunchAgent plists and the generated env file/wrapper owner-only (mode `0600`/`0700`) instead of embedding secrets in `EnvironmentVariables`.
- Running multiple Gateways on one host: isolate ports, config/state, and workspaces. See [Multiple gateways](/gateway#multiple-gateways-same-host).

## Related

- [CLI reference](/cli)
- [Gateway runbook](/gateway)
