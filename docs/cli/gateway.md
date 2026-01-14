---
summary: "Clawdbot Gateway CLI (`clawdbot gateway`) — run, query, and discover gateways"
read_when:
  - Running the Gateway from the CLI (dev or servers)
  - Debugging Gateway auth, bind modes, and connectivity
  - Discovering gateways via Bonjour (LAN + tailnet)
---

# Gateway CLI

The Gateway is Clawdbot’s WebSocket server (channels, nodes, sessions, hooks).

Subcommands in this page live under `clawdbot gateway …`.

Related docs:
- [/gateway/bonjour](/gateway/bonjour)
- [/gateway/discovery](/gateway/discovery)
- [/gateway/configuration](/gateway/configuration)

## Run the Gateway

Run a local Gateway process:

```bash
clawdbot gateway
```

Notes:
- By default, the Gateway refuses to start unless `gateway.mode=local` is set in `~/.clawdbot/clawdbot.json`. Use `--allow-unconfigured` for ad-hoc/dev runs.
- Binding beyond loopback without auth is blocked (safety guardrail).
- `SIGUSR1` triggers an in-process restart (useful without a supervisor).

### Options

- `--port <port>`: WebSocket port (default comes from config/env; usually `18789`).
- `--bind <loopback|lan|tailnet|auto>`: listener bind mode.
- `--auth <token|password>`: auth mode override.
- `--token <token>`: token override (also sets `CLAWDBOT_GATEWAY_TOKEN` for the process).
- `--password <password>`: password override (also sets `CLAWDBOT_GATEWAY_PASSWORD` for the process).
- `--tailscale <off|serve|funnel>`: expose the Gateway via Tailscale.
- `--tailscale-reset-on-exit`: reset Tailscale serve/funnel config on shutdown.
- `--allow-unconfigured`: allow gateway start without `gateway.mode=local` in config.
- `--dev`: create a dev config + workspace if missing (skips BOOTSTRAP.md).
- `--reset`: reset dev config + credentials + sessions + workspace (requires `--dev`).
- `--force`: kill any existing listener on the selected port before starting.
- `--verbose`: verbose logs.
- `--claude-cli-logs`: only show claude-cli logs in the console (and enable its stdout/stderr).
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

### `gateway health`

```bash
clawdbot gateway health --url ws://127.0.0.1:18789
```

### `gateway status`

`gateway status` is the “debug everything” command. It always probes:
- your configured remote gateway (if set), and
- localhost (loopback) **even if remote is configured**.

If multiple gateways are reachable, it prints all of them. Multiple gateways are supported when you use profiles for redundancy, but most installs still run a single gateway.

```bash
clawdbot gateway status
clawdbot gateway status --json
```

#### Remote over SSH (Mac app parity)

The macOS app “Remote over SSH” mode uses a local port-forward so the remote gateway (which may be bound to loopback only) becomes reachable at `ws://127.0.0.1:<port>`.

CLI equivalent:

```bash
clawdbot gateway status --ssh user@gateway-host
```

Options:
- `--ssh <target>`: `user@host` or `user@host:port` (port defaults to `22`).
- `--ssh-identity <path>`: identity file.
- `--ssh-auto`: pick the first discovered bridge host as SSH target (LAN/WAB only).

Config (optional, used as defaults):
- `gateway.remote.sshTarget`
- `gateway.remote.sshIdentity`

### `gateway call <method>`

Low-level RPC helper.

```bash
clawdbot gateway call status
clawdbot gateway call logs.tail --params '{"sinceMs": 60000}'
```

## Discover gateways (Bonjour)

`gateway discover` scans for Gateway bridge beacons (`_clawdbot-bridge._tcp`).

- Multicast DNS-SD: `local.`
- Unicast DNS-SD (Wide-Area Bonjour): `clawdbot.internal.` (requires split DNS + DNS server; see [/gateway/bonjour](/gateway/bonjour))

Only gateways with the **bridge enabled** will advertise the discovery beacon.

Wide-Area discovery records include (TXT):
- `gatewayPort` (WebSocket port, usually `18789`)
- `sshPort` (SSH port; defaults to `22` if not present)
- `tailnetDns` (MagicDNS hostname, when available)
- `cliPath` (optional hint for remote installs)

### `gateway discover`

```bash
clawdbot gateway discover
```

Options:
- `--timeout <ms>`: per-command timeout (browse/resolve); default `2000`.
- `--json`: machine-readable output (also disables styling/spinner).

Examples:

```bash
clawdbot gateway discover --timeout 4000
clawdbot gateway discover --json | jq '.beacons[].wsUrl'
```
