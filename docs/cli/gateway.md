---
summary: "OpenClaw Gateway CLI (`openclaw gateway`) — run, query, and discover gateways"
read_when:
  - Running the Gateway from the CLI (dev or servers)
  - Debugging Gateway auth, bind modes, and connectivity
  - Discovering gateways via Bonjour (local + wide-area DNS-SD)
title: "gateway"
---

# Gateway CLI

The Gateway is OpenClaw’s WebSocket server (channels, nodes, sessions, hooks).

Subcommands in this page live under `openclaw gateway …`.

Related docs:

- [/gateway/bonjour](/gateway/bonjour)
- [/gateway/discovery](/gateway/discovery)
- [/gateway/configuration](/gateway/configuration)

## Run the Gateway

Run a local Gateway process:

```bash
openclaw gateway
```

Foreground alias:

```bash
openclaw gateway run
```

Notes:

- By default, the Gateway refuses to start unless `gateway.mode=local` is set in `~/.openclaw/openclaw.json`. Use `--allow-unconfigured` for ad-hoc/dev runs.
- `openclaw onboard --mode local` and `openclaw setup` are expected to write `gateway.mode=local`. If the file exists but `gateway.mode` is missing, treat that as a broken or clobbered config and repair it instead of assuming local mode implicitly.
- If the file exists and `gateway.mode` is missing, the Gateway treats that as suspicious config damage and refuses to “guess local” for you.
- Binding beyond loopback without auth is blocked (safety guardrail).
- `SIGUSR1` triggers an in-process restart when authorized (`commands.restart` is enabled by default; set `commands.restart: false` to block manual restart, while gateway tool/config apply/update remain allowed).
- `SIGINT`/`SIGTERM` handlers stop the gateway process, but they don’t restore any custom terminal state. If you wrap the CLI with a TUI or raw-mode input, restore the terminal before exit.

### Options

- `--port <port>`: WebSocket port (default comes from config/env; usually `18789`).
- `--bind <loopback|lan|tailnet|auto|custom>`: listener bind mode.
- `--auth <token|password>`: auth mode override.
- `--token <token>`: token override (also sets `OPENCLAW_GATEWAY_TOKEN` for the process).
- `--password <password>`: password override. Warning: inline passwords can be exposed in local process listings.
- `--password-file <path>`: read the gateway password from a file.
- `--tailscale <off|serve|funnel>`: expose the Gateway via Tailscale.
- `--tailscale-reset-on-exit`: reset Tailscale serve/funnel config on shutdown.
- `--allow-unconfigured`: allow gateway start without `gateway.mode=local` in config. This bypasses the startup guard for ad-hoc/dev bootstrap only; it does not write or repair the config file.
- `--dev`: create a dev config + workspace if missing (skips BOOTSTRAP.md).
- `--reset`: reset dev config + credentials + sessions + workspace (requires `--dev`).
- `--force`: kill any existing listener on the selected port before starting.
- `--verbose`: verbose logs.
- `--cli-backend-logs`: only show CLI backend logs in the console (and enable stdout/stderr).
- `--ws-log <auto|full|compact>`: websocket log style (default `auto`).
- `--compact`: alias for `--ws-log compact`.
- `--raw-stream`: log raw model stream events to jsonl.
- `--raw-stream-path <path>`: raw stream jsonl path.

## Query a running Gateway

All query commands use WebSocket RPC.

Output modes:

- Default: human-readable (colored in TTY).
- `--json`: machine-readable JSON (no styling/spinner).
- `--no-color` (or `NO_COLOR=1`): disable ANSI while keeping human layout.

Shared options (where supported):

- `--url <url>`: Gateway WebSocket URL.
- `--token <token>`: Gateway token.
- `--password <password>`: Gateway password.
- `--timeout <ms>`: timeout/budget (varies per command).
- `--expect-final`: wait for a “final” response (agent calls).

Note: when you set `--url`, the CLI does not fall back to config or environment credentials.
Pass `--token` or `--password` explicitly. Missing explicit credentials is an error.

### `gateway health`

```bash
openclaw gateway health --url ws://127.0.0.1:18789
```

### `gateway usage-cost`

Fetch usage-cost summaries from session logs.

```bash
openclaw gateway usage-cost
openclaw gateway usage-cost --days 7
openclaw gateway usage-cost --json
```

Options:

- `--days <days>`: number of days to include (default `30`).

### `gateway status`

`gateway status` shows the Gateway service (launchd/systemd/schtasks) plus an optional probe of connectivity/auth capability.

```bash
openclaw gateway status
openclaw gateway status --json
openclaw gateway status --require-rpc
```

Options:

- `--url <url>`: add an explicit probe target. Configured remote + localhost are still probed.
- `--token <token>`: token auth for the probe.
- `--password <password>`: password auth for the probe.
- `--timeout <ms>`: probe timeout (default `10000`).
- `--no-probe`: skip the connectivity probe (service-only view).
- `--deep`: scan system-level services too.
- `--require-rpc`: upgrade the default connectivity probe to a read probe and exit non-zero when that read probe fails. Cannot be combined with `--no-probe`.

Notes:

- `gateway status` stays available for diagnostics even when the local CLI config is missing or invalid.
- Default `gateway status` proves service state, WebSocket connect, and the auth capability visible at handshake time. It does not prove read/write/admin operations.
- `gateway status` resolves configured auth SecretRefs for probe auth when possible.
- If a required auth SecretRef is unresolved in this command path, `gateway status --json` reports `rpc.authWarning` when probe connectivity/auth fails; pass `--token`/`--password` explicitly or resolve the secret source first.
- If the probe succeeds, unresolved auth-ref warnings are suppressed to avoid false positives.
- Use `--require-rpc` in scripts and automation when a listening service is not enough and you need read-scope RPC calls to be healthy too.
- `--deep` adds a best-effort scan for extra launchd/systemd/schtasks installs. When multiple gateway-like services are detected, human output prints cleanup hints and warns that most setups should run one gateway per machine.
- Human output includes the resolved file log path plus the CLI-vs-service config paths/validity snapshot to help diagnose profile or state-dir drift.
- On Linux systemd installs, service auth drift checks read both `Environment=` and `EnvironmentFile=` values from the unit (including `%h`, quoted paths, multiple files, and optional `-` files).
- Drift checks resolve `gateway.auth.token` SecretRefs using merged runtime env (service command env first, then process env fallback).
- If token auth is not effectively active (explicit `gateway.auth.mode` of `password`/`none`/`trusted-proxy`, or mode unset where password can win and no token candidate can win), token-drift checks skip config token resolution.

### `gateway probe`

`gateway probe` is the “debug everything” command. It always probes:

- your configured remote gateway (if set), and
- localhost (loopback) **even if remote is configured**.

If you pass `--url`, that explicit target is added ahead of both. Human output labels the
targets as:

- `URL (explicit)`
- `Remote (configured)` or `Remote (configured, inactive)`
- `Local loopback`

If multiple gateways are reachable, it prints all of them. Multiple gateways are supported when you use isolated profiles/ports (e.g., a rescue bot), but most installs still run a single gateway.

```bash
openclaw gateway probe
openclaw gateway probe --json
```

Interpretation:

- `Reachable: yes` means at least one target accepted a WebSocket connect.
- `Capability: read-only|write-capable|admin-capable|pairing-pending|connect-only` reports what the probe could prove about auth. It is separate from reachability.
- `Read probe: ok` means read-scope detail RPC calls (`health`/`status`/`system-presence`/`config.get`) also succeeded.
- `Read probe: limited - missing scope: operator.read` means connect succeeded but read-scope RPC is limited. This is reported as **degraded** reachability, not full failure.
- Exit code is non-zero only when no probed target is reachable.

JSON notes (`--json`):

- Top level:
  - `ok`: at least one target is reachable.
  - `degraded`: at least one target had scope-limited detail RPC.
  - `capability`: best capability seen across reachable targets (`read_only`, `write_capable`, `admin_capable`, `pairing_pending`, `connected_no_operator_scope`, or `unknown`).
  - `primaryTargetId`: best target to treat as the active winner in this order: explicit URL, SSH tunnel, configured remote, then local loopback.
  - `warnings[]`: best-effort warning records with `code`, `message`, and optional `targetIds`.
  - `network`: local loopback/tailnet URL hints derived from current config and host networking.
  - `discovery.timeoutMs` and `discovery.count`: the actual discovery budget/result count used for this probe pass.
- Per target (`targets[].connect`):
  - `ok`: reachability after connect + degraded classification.
  - `rpcOk`: full detail RPC success.
  - `scopeLimited`: detail RPC failed due to missing operator scope.
- Per target (`targets[].auth`):
  - `role`: auth role reported in `hello-ok` when available.
  - `scopes`: granted scopes reported in `hello-ok` when available.
  - `capability`: the surfaced auth capability classification for that target.

Common warning codes:

- `ssh_tunnel_failed`: SSH tunnel setup failed; the command fell back to direct probes.
- `multiple_gateways`: more than one target was reachable; this is unusual unless you intentionally run isolated profiles, such as a rescue bot.
- `auth_secretref_unresolved`: a configured auth SecretRef could not be resolved for a failed target.
- `probe_scope_limited`: WebSocket connect succeeded, but the read probe was limited by missing `operator.read`.

#### Remote over SSH (Mac app parity)

The macOS app “Remote over SSH” mode uses a local port-forward so the remote gateway (which may be bound to loopback only) becomes reachable at `ws://127.0.0.1:<port>`.

CLI equivalent:

```bash
openclaw gateway probe --ssh user@gateway-host
```

Options:

- `--ssh <target>`: `user@host` or `user@host:port` (port defaults to `22`).
- `--ssh-identity <path>`: identity file.
- `--ssh-auto`: pick the first discovered gateway host as SSH target from the resolved
  discovery endpoint (`local.` plus the configured wide-area domain, if any). TXT-only
  hints are ignored.

Config (optional, used as defaults):

- `gateway.remote.sshTarget`
- `gateway.remote.sshIdentity`

### `gateway call <method>`

Low-level RPC helper.

```bash
openclaw gateway call status
openclaw gateway call logs.tail --params '{"sinceMs": 60000}'
```

Options:

- `--params <json>`: JSON object string for params (default `{}`)
- `--url <url>`
- `--token <token>`
- `--password <password>`
- `--timeout <ms>`
- `--expect-final`
- `--json`

Notes:

- `--params` must be valid JSON.
- `--expect-final` is mainly for agent-style RPCs that stream intermediate events before a final payload.

## Manage the Gateway service

```bash
openclaw gateway install
openclaw gateway start
openclaw gateway stop
openclaw gateway restart
openclaw gateway uninstall
```

Command options:

- `gateway status`: `--url`, `--token`, `--password`, `--timeout`, `--no-probe`, `--require-rpc`, `--deep`, `--json`
- `gateway install`: `--port`, `--runtime <node|bun>`, `--token`, `--force`, `--json`
- `gateway uninstall|start|stop|restart`: `--json`

Notes:

- `gateway install` supports `--port`, `--runtime`, `--token`, `--force`, `--json`.
- When token auth requires a token and `gateway.auth.token` is SecretRef-managed, `gateway install` validates that the SecretRef is resolvable but does not persist the resolved token into service environment metadata.
- If token auth requires a token and the configured token SecretRef is unresolved, install fails closed instead of persisting fallback plaintext.
- For password auth on `gateway run`, prefer `OPENCLAW_GATEWAY_PASSWORD`, `--password-file`, or a SecretRef-backed `gateway.auth.password` over inline `--password`.
- In inferred auth mode, shell-only `OPENCLAW_GATEWAY_PASSWORD` does not relax install token requirements; use durable config (`gateway.auth.password` or config `env`) when installing a managed service.
- If both `gateway.auth.token` and `gateway.auth.password` are configured and `gateway.auth.mode` is unset, install is blocked until mode is set explicitly.
- Lifecycle commands accept `--json` for scripting.

## Discover gateways (Bonjour)

`gateway discover` scans for Gateway beacons (`_openclaw-gw._tcp`).

- Multicast DNS-SD: `local.`
- Unicast DNS-SD (Wide-Area Bonjour): choose a domain (example: `openclaw.internal.`) and set up split DNS + a DNS server; see [/gateway/bonjour](/gateway/bonjour)

Only gateways with Bonjour discovery enabled (default) advertise the beacon.

Wide-Area discovery records include (TXT):

- `role` (gateway role hint)
- `transport` (transport hint, e.g. `gateway`)
- `gatewayPort` (WebSocket port, usually `18789`)
- `sshPort` (optional; clients default SSH targets to `22` when it is absent)
- `tailnetDns` (MagicDNS hostname, when available)
- `gatewayTls` / `gatewayTlsSha256` (TLS enabled + cert fingerprint)
- `cliPath` (remote-install hint written to the wide-area zone)

### `gateway discover`

```bash
openclaw gateway discover
```

Options:

- `--timeout <ms>`: per-command timeout (browse/resolve); default `2000`.
- `--json`: machine-readable output (also disables styling/spinner).

Examples:

```bash
openclaw gateway discover --timeout 4000
openclaw gateway discover --json | jq '.beacons[].wsUrl'
```

Notes:

- The CLI scans `local.` plus the configured wide-area domain when one is enabled.
- `wsUrl` in JSON output is derived from the resolved service endpoint, not from TXT-only
  hints such as `lanHost` or `tailnetDns`.
- On `local.` mDNS, `sshPort` and `cliPath` are only broadcast when
  `discovery.mdns.mode` is `full`. Wide-area DNS-SD still writes `cliPath`; `sshPort`
  stays optional there too.
