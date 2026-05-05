---
summary: "CLI reference for `openclaw daemon` (legacy alias for gateway service management)"
read_when:
  - You still use `openclaw daemon ...` in scripts
  - You need service lifecycle commands (install/start/stop/restart/status)
title: "Daemon"
---

# `openclaw daemon`

Legacy alias for Gateway service management commands.

`openclaw daemon ...` maps to the same service control surface as `openclaw gateway ...` service commands.

## Usage

```bash
openclaw daemon status
openclaw daemon install
openclaw daemon start
openclaw daemon stop
openclaw daemon restart
openclaw daemon uninstall
```

## Subcommands

- `status`: show service install state and probe Gateway health
- `install`: install service (`launchd`/`systemd`/`schtasks`)
- `uninstall`: remove service
- `start`: start service
- `stop`: stop service
- `restart`: restart service

## Common options

- `status`: `--url`, `--token`, `--password`, `--timeout`, `--no-probe`, `--require-rpc`, `--deep`, `--json`
- `install`: `--port`, `--runtime <node|bun>`, `--token`, `--force`, `--json`
- `restart`: `--safe`, `--force`, `--wait <duration>`, `--json`
- lifecycle (`uninstall|start|stop`): `--json`

Notes:

- `status` resolves configured auth SecretRefs for probe auth when possible.
- If a required auth SecretRef is unresolved in this command path, `daemon status --json` reports `rpc.authWarning` when probe connectivity/auth fails; pass `--token`/`--password` explicitly or resolve the secret source first.
- If the probe succeeds, unresolved auth-ref warnings are suppressed to avoid false positives.
- `status --deep` adds a best-effort system-level service scan. When it finds other gateway-like services, human output prints cleanup hints and warns that one gateway per machine is still the normal recommendation.
- On Linux systemd installs, `status` token-drift checks include both `Environment=` and `EnvironmentFile=` unit sources.
- Drift checks resolve `gateway.auth.token` SecretRefs using merged runtime env (service command env first, then process env fallback).
- If token auth is not effectively active (explicit `gateway.auth.mode` of `password`/`none`/`trusted-proxy`, or mode unset where password can win and no token candidate can win), token-drift checks skip config token resolution.
- When token auth requires a token and `gateway.auth.token` is SecretRef-managed, `install` validates that the SecretRef is resolvable but does not persist the resolved token into service environment metadata.
- If token auth requires a token and the configured token SecretRef is unresolved, install fails closed.
- If both `gateway.auth.token` and `gateway.auth.password` are configured and `gateway.auth.mode` is unset, install is blocked until mode is set explicitly.
- On macOS, `install` keeps LaunchAgent plists owner-only and loads managed service environment values through an owner-only file and wrapper instead of serializing API keys or auth-profile env refs into `EnvironmentVariables`.
- If you intentionally run multiple gateways on one host, isolate ports, config/state, and workspaces; see [/gateway#multiple-gateways-same-host](/gateway#multiple-gateways-same-host).
- `restart --safe` asks the running Gateway to preflight active work and schedule one coalesced restart after active work drains. Plain `restart` keeps the existing service-manager behavior; `--force` remains the immediate override path.

## Prefer

Use [`openclaw gateway`](/cli/gateway) for current docs and examples.

## Related

- [CLI reference](/cli)
- [Gateway runbook](/gateway)
