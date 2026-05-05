---
summary: "OpenClaw Gateway CLI (`openclaw gateway`) — run, query, and discover gateways"
read_when:
  - Running the Gateway from the CLI (dev or servers)
  - Debugging Gateway auth, bind modes, and connectivity
  - Discovering gateways via Bonjour (local + wide-area DNS-SD)
title: "Gateway"
sidebarTitle: "Gateway"
---

The Gateway is OpenClaw's WebSocket server (channels, nodes, sessions, hooks). Subcommands in this page live under `openclaw gateway …`.

<CardGroup cols={3}>
  <Card title="Bonjour discovery" href="/gateway/bonjour">
    Local mDNS + wide-area DNS-SD setup.
  </Card>
  <Card title="Discovery overview" href="/gateway/discovery">
    How OpenClaw advertises and finds gateways.
  </Card>
  <Card title="Configuration" href="/gateway/configuration">
    Top-level gateway config keys.
  </Card>
</CardGroup>

## Run the Gateway

Run a local Gateway process:

```bash
openclaw gateway
```

Foreground alias:

```bash
openclaw gateway run
```

<AccordionGroup>
  <Accordion title="Startup behavior">
    - By default, the Gateway refuses to start unless `gateway.mode=local` is set in `~/.openclaw/openclaw.json`. Use `--allow-unconfigured` for ad-hoc/dev runs.
    - `openclaw onboard --mode local` and `openclaw setup` are expected to write `gateway.mode=local`. If the file exists but `gateway.mode` is missing, treat that as a broken or clobbered config and repair it instead of assuming local mode implicitly.
    - If the file exists and `gateway.mode` is missing, the Gateway treats that as suspicious config damage and refuses to "guess local" for you.
    - Binding beyond loopback without auth is blocked (safety guardrail).
    - `SIGUSR1` triggers an in-process restart when authorized (`commands.restart` is enabled by default; set `commands.restart: false` to block manual restart, while gateway tool/config apply/update remain allowed).
    - `SIGINT`/`SIGTERM` handlers stop the gateway process, but they don't restore any custom terminal state. If you wrap the CLI with a TUI or raw-mode input, restore the terminal before exit.

  </Accordion>
</AccordionGroup>

### Options

<ParamField path="--port <port>" type="number">
  WebSocket port (default comes from config/env; usually `18789`).
</ParamField>
<ParamField path="--bind <loopback|lan|tailnet|auto|custom>" type="string">
  Listener bind mode.
</ParamField>
<ParamField path="--auth <token|password>" type="string">
  Auth mode override.
</ParamField>
<ParamField path="--token <token>" type="string">
  Token override (also sets `OPENCLAW_GATEWAY_TOKEN` for the process).
</ParamField>
<ParamField path="--password <password>" type="string">
  Password override.
</ParamField>
<ParamField path="--password-file <path>" type="string">
  Read the gateway password from a file.
</ParamField>
<ParamField path="--tailscale <off|serve|funnel>" type="string">
  Expose the Gateway via Tailscale.
</ParamField>
<ParamField path="--tailscale-reset-on-exit" type="boolean">
  Reset Tailscale serve/funnel config on shutdown.
</ParamField>
<ParamField path="--allow-unconfigured" type="boolean">
  Allow gateway start without `gateway.mode=local` in config. Bypasses the startup guard for ad-hoc/dev bootstrap only; does not write or repair the config file.
</ParamField>
<ParamField path="--dev" type="boolean">
  Create a dev config + workspace if missing (skips BOOTSTRAP.md).
</ParamField>
<ParamField path="--reset" type="boolean">
  Reset dev config + credentials + sessions + workspace (requires `--dev`).
</ParamField>
<ParamField path="--force" type="boolean">
  Kill any existing listener on the selected port before starting.
</ParamField>
<ParamField path="--verbose" type="boolean">
  Verbose logs.
</ParamField>
<ParamField path="--cli-backend-logs" type="boolean">
  Only show CLI backend logs in the console (and enable stdout/stderr).
</ParamField>
<ParamField path="--ws-log <auto|full|compact>" type="string" default="auto">
  Websocket log style.
</ParamField>
<ParamField path="--compact" type="boolean">
  Alias for `--ws-log compact`.
</ParamField>
<ParamField path="--raw-stream" type="boolean">
  Log raw model stream events to jsonl.
</ParamField>
<ParamField path="--raw-stream-path <path>" type="string">
  Raw stream jsonl path.
</ParamField>

## Restart the Gateway

```bash
openclaw gateway restart
openclaw gateway restart --safe
openclaw gateway restart --force
```

`openclaw gateway restart --safe` asks the running Gateway to preflight active OpenClaw work before restarting. If queued operations, reply delivery, embedded runs, or task runs are active, the Gateway reports the blockers, coalesces duplicate safe restart requests, and restarts once the active work drains. Plain `restart` keeps the existing service-manager behavior for compatibility. Use `--force` only when you explicitly want the immediate override path.

<Warning>
Inline `--password` can be exposed in local process listings. Prefer `--password-file`, env, or a SecretRef-backed `gateway.auth.password`.
</Warning>

### Startup profiling

- Set `OPENCLAW_GATEWAY_STARTUP_TRACE=1` to log phase timings during Gateway startup, including per-phase `eventLoopMax` delay and plugin lookup-table timings for installed-index, manifest registry, startup planning, and owner-map work.
- Set `OPENCLAW_DIAGNOSTICS=timeline` with `OPENCLAW_DIAGNOSTICS_TIMELINE_PATH=<path>` to write a best-effort JSONL startup diagnostics timeline for external QA harnesses. You can also enable the flag with `diagnostics.flags: ["timeline"]` in config; the path is still env-provided. Add `OPENCLAW_DIAGNOSTICS_EVENT_LOOP=1` to include event-loop samples.
- Run `pnpm test:startup:gateway -- --runs 5 --warmup 1` to benchmark Gateway startup. The benchmark records first process output, `/healthz`, `/readyz`, startup trace timings, event-loop delay, and plugin lookup-table timing details.

## Query a running Gateway

All query commands use WebSocket RPC.

<Tabs>
  <Tab title="Output modes">
    - Default: human-readable (colored in TTY).
    - `--json`: machine-readable JSON (no styling/spinner).
    - `--no-color` (or `NO_COLOR=1`): disable ANSI while keeping human layout.

  </Tab>
  <Tab title="Shared options">
    - `--url <url>`: Gateway WebSocket URL.
    - `--token <token>`: Gateway token.
    - `--password <password>`: Gateway password.
    - `--timeout <ms>`: timeout/budget (varies per command).
    - `--expect-final`: wait for a "final" response (agent calls).

  </Tab>
</Tabs>

<Note>
When you set `--url`, the CLI does not fall back to config or environment credentials. Pass `--token` or `--password` explicitly. Missing explicit credentials is an error.
</Note>

### `gateway health`

```bash
openclaw gateway health --url ws://127.0.0.1:18789
```

The HTTP `/healthz` endpoint is a liveness probe: it returns once the server can answer HTTP. The HTTP `/readyz` endpoint is stricter and stays red while startup plugin sidecars, channels, or configured hooks are still settling. Local or authenticated detailed readiness responses include an `eventLoop` diagnostic block with event-loop delay, event-loop utilization, CPU core ratio, and a `degraded` flag.

### `gateway usage-cost`

Fetch usage-cost summaries from session logs.

```bash
openclaw gateway usage-cost
openclaw gateway usage-cost --days 7
openclaw gateway usage-cost --json
```

<ParamField path="--days <days>" type="number" default="30">
  Number of days to include.
</ParamField>

### `gateway stability`

Fetch the recent diagnostic stability recorder from a running Gateway.

```bash
openclaw gateway stability
openclaw gateway stability --type payload.large
openclaw gateway stability --bundle latest
openclaw gateway stability --bundle latest --export
openclaw gateway stability --json
```

<ParamField path="--limit <limit>" type="number" default="25">
  Maximum number of recent events to include (max `1000`).
</ParamField>
<ParamField path="--type <type>" type="string">
  Filter by diagnostic event type, such as `payload.large` or `diagnostic.memory.pressure`.
</ParamField>
<ParamField path="--since-seq <seq>" type="number">
  Include only events after a diagnostic sequence number.
</ParamField>
<ParamField path="--bundle [path]" type="string">
  Read a persisted stability bundle instead of calling the running Gateway. Use `--bundle latest` (or just `--bundle`) for the newest bundle under the state directory, or pass a bundle JSON path directly.
</ParamField>
<ParamField path="--export" type="boolean">
  Write a shareable support diagnostics zip instead of printing stability details.
</ParamField>
<ParamField path="--output <path>" type="string">
  Output path for `--export`.
</ParamField>

<AccordionGroup>
  <Accordion title="Privacy and bundle behavior">
    - Records keep operational metadata: event names, counts, byte sizes, memory readings, queue/session state, channel/plugin names, and redacted session summaries. They do not keep chat text, webhook bodies, tool outputs, raw request or response bodies, tokens, cookies, secret values, hostnames, or raw session ids. Set `diagnostics.enabled: false` to disable the recorder entirely.
    - On fatal Gateway exits, shutdown timeouts, and restart startup failures, OpenClaw writes the same diagnostic snapshot to `~/.openclaw/logs/stability/openclaw-stability-*.json` when the recorder has events. Inspect the newest bundle with `openclaw gateway stability --bundle latest`; `--limit`, `--type`, and `--since-seq` also apply to bundle output.

  </Accordion>
</AccordionGroup>

### `gateway diagnostics export`

Write a local diagnostics zip that is designed to attach to bug reports. For the privacy model and bundle contents, see [Diagnostics Export](/gateway/diagnostics).

```bash
openclaw gateway diagnostics export
openclaw gateway diagnostics export --output openclaw-diagnostics.zip
openclaw gateway diagnostics export --json
```

<ParamField path="--output <path>" type="string">
  Output zip path. Defaults to a support export under the state directory.
</ParamField>
<ParamField path="--log-lines <count>" type="number" default="5000">
  Maximum sanitized log lines to include.
</ParamField>
<ParamField path="--log-bytes <bytes>" type="number" default="1000000">
  Maximum log bytes to inspect.
</ParamField>
<ParamField path="--url <url>" type="string">
  Gateway WebSocket URL for the health snapshot.
</ParamField>
<ParamField path="--token <token>" type="string">
  Gateway token for the health snapshot.
</ParamField>
<ParamField path="--password <password>" type="string">
  Gateway password for the health snapshot.
</ParamField>
<ParamField path="--timeout <ms>" type="number" default="3000">
  Status/health snapshot timeout.
</ParamField>
<ParamField path="--no-stability-bundle" type="boolean">
  Skip persisted stability bundle lookup.
</ParamField>
<ParamField path="--json" type="boolean">
  Print the written path, size, and manifest as JSON.
</ParamField>

The export contains a manifest, a Markdown summary, config shape, sanitized config details, sanitized log summaries, sanitized Gateway status/health snapshots, and the newest stability bundle when one exists.

It is meant to be shared. It keeps operational details that help debugging, such as safe OpenClaw log fields, subsystem names, status codes, durations, configured modes, ports, plugin ids, provider ids, non-secret feature settings, and redacted operational log messages. It omits or redacts chat text, webhook bodies, tool outputs, credentials, cookies, account/message identifiers, prompt/instruction text, hostnames, and secret values. When a LogTape-style message looks like user/chat/tool payload text, the export keeps only that a message was omitted plus its byte count.

### `gateway status`

`gateway status` shows the Gateway service (launchd/systemd/schtasks) plus an optional probe of connectivity/auth capability.

```bash
openclaw gateway status
openclaw gateway status --json
openclaw gateway status --require-rpc
```

<ParamField path="--url <url>" type="string">
  Add an explicit probe target. Configured remote + localhost are still probed.
</ParamField>
<ParamField path="--token <token>" type="string">
  Token auth for the probe.
</ParamField>
<ParamField path="--password <password>" type="string">
  Password auth for the probe.
</ParamField>
<ParamField path="--timeout <ms>" type="number" default="10000">
  Probe timeout.
</ParamField>
<ParamField path="--no-probe" type="boolean">
  Skip the connectivity probe (service-only view).
</ParamField>
<ParamField path="--deep" type="boolean">
  Scan system-level services too.
</ParamField>
<ParamField path="--require-rpc" type="boolean">
  Upgrade the default connectivity probe to a read probe and exit non-zero when that read probe fails. Cannot be combined with `--no-probe`.
</ParamField>

<AccordionGroup>
  <Accordion title="Status semantics">
    - `gateway status` stays available for diagnostics even when the local CLI config is missing or invalid.
    - Default `gateway status` proves service state, WebSocket connect, and the auth capability visible at handshake time. It does not prove read/write/admin operations.
    - Diagnostic probes are non-mutating for first-time device auth: they reuse an existing cached device token when one exists, but they do not create a new CLI device identity or read-only device pairing record just to check status.
    - `gateway status` resolves configured auth SecretRefs for probe auth when possible.
    - If a required auth SecretRef is unresolved in this command path, `gateway status --json` reports `rpc.authWarning` when probe connectivity/auth fails; pass `--token`/`--password` explicitly or resolve the secret source first.
    - If the probe succeeds, unresolved auth-ref warnings are suppressed to avoid false positives.
    - Use `--require-rpc` in scripts and automation when a listening service is not enough and you need read-scope RPC calls to be healthy too.
    - `--deep` adds a best-effort scan for extra launchd/systemd/schtasks installs. When multiple gateway-like services are detected, human output prints cleanup hints and warns that most setups should run one gateway per machine.
    - `--deep` also reports a recent Gateway supervisor restart handoff when the service process exited cleanly for an external supervisor restart.
    - Human output includes the resolved file log path plus the CLI-vs-service config paths/validity snapshot to help diagnose profile or state-dir drift.

  </Accordion>
  <Accordion title="Linux systemd auth-drift checks">
    - On Linux systemd installs, service auth drift checks read both `Environment=` and `EnvironmentFile=` values from the unit (including `%h`, quoted paths, multiple files, and optional `-` files).
    - Drift checks resolve `gateway.auth.token` SecretRefs using merged runtime env (service command env first, then process env fallback).
    - If token auth is not effectively active (explicit `gateway.auth.mode` of `password`/`none`/`trusted-proxy`, or mode unset where password can win and no token candidate can win), token-drift checks skip config token resolution.

  </Accordion>
</AccordionGroup>

### `gateway probe`

`gateway probe` is the "debug everything" command. It always probes:

- your configured remote gateway (if set), and
- localhost (loopback) **even if remote is configured**.

If you pass `--url`, that explicit target is added ahead of both. Human output labels the targets as:

- `URL (explicit)`
- `Remote (configured)` or `Remote (configured, inactive)`
- `Local loopback`

<Note>
If multiple gateways are reachable, it prints all of them. Multiple gateways are supported when you use isolated profiles/ports (e.g., a rescue bot), but most installs still run a single gateway.
</Note>

```bash
openclaw gateway probe
openclaw gateway probe --json
```

<AccordionGroup>
  <Accordion title="Interpretation">
    - `Reachable: yes` means at least one target accepted a WebSocket connect.
    - `Capability: read-only|write-capable|admin-capable|pairing-pending|connect-only` reports what the probe could prove about auth. It is separate from reachability.
    - `Read probe: ok` means read-scope detail RPC calls (`health`/`status`/`system-presence`/`config.get`) also succeeded.
    - `Read probe: limited - missing scope: operator.read` means connect succeeded but read-scope RPC is limited. This is reported as **degraded** reachability, not full failure.
    - `Read probe: failed` after `Connect: ok` means the Gateway accepted the WebSocket connection, but follow-up read diagnostics timed out or failed. This is also **degraded** reachability, not an unreachable Gateway.
    - Like `gateway status`, probe reuses existing cached device auth but does not create first-time device identity or pairing state.
    - Exit code is non-zero only when no probed target is reachable.

  </Accordion>
  <Accordion title="JSON output">
    Top level:

    - `ok`: at least one target is reachable.
    - `degraded`: at least one target accepted a connection but did not complete full detail RPC diagnostics.
    - `capability`: best capability seen across reachable targets (`read_only`, `write_capable`, `admin_capable`, `pairing_pending`, `connected_no_operator_scope`, or `unknown`).
    - `primaryTargetId`: best target to treat as the active winner in this order: explicit URL, SSH tunnel, configured remote, then local loopback.
    - `warnings[]`: best-effort warning records with `code`, `message`, and optional `targetIds`.
    - `network`: local loopback/tailnet URL hints derived from current config and host networking.
    - `discovery.timeoutMs` and `discovery.count`: the actual discovery budget/result count used for this probe pass.

    Per target (`targets[].connect`):

    - `ok`: reachability after connect + degraded classification.
    - `rpcOk`: full detail RPC success.
    - `scopeLimited`: detail RPC failed due to missing operator scope.

    Per target (`targets[].auth`):

    - `role`: auth role reported in `hello-ok` when available.
    - `scopes`: granted scopes reported in `hello-ok` when available.
    - `capability`: the surfaced auth capability classification for that target.

  </Accordion>
  <Accordion title="Common warning codes">
    - `ssh_tunnel_failed`: SSH tunnel setup failed; the command fell back to direct probes.
    - `multiple_gateways`: more than one target was reachable; this is unusual unless you intentionally run isolated profiles, such as a rescue bot.
    - `auth_secretref_unresolved`: a configured auth SecretRef could not be resolved for a failed target.
    - `probe_scope_limited`: WebSocket connect succeeded, but the read probe was limited by missing `operator.read`.

  </Accordion>
</AccordionGroup>

#### Remote over SSH (Mac app parity)

The macOS app "Remote over SSH" mode uses a local port-forward so the remote gateway (which may be bound to loopback only) becomes reachable at `ws://127.0.0.1:<port>`.

CLI equivalent:

```bash
openclaw gateway probe --ssh user@gateway-host
```

<ParamField path="--ssh <target>" type="string">
  `user@host` or `user@host:port` (port defaults to `22`).
</ParamField>
<ParamField path="--ssh-identity <path>" type="string">
  Identity file.
</ParamField>
<ParamField path="--ssh-auto" type="boolean">
  Pick the first discovered gateway host as SSH target from the resolved discovery endpoint (`local.` plus the configured wide-area domain, if any). TXT-only hints are ignored.
</ParamField>

Config (optional, used as defaults):

- `gateway.remote.sshTarget`
- `gateway.remote.sshIdentity`

### `gateway call <method>`

Low-level RPC helper.

```bash
openclaw gateway call status
openclaw gateway call logs.tail --params '{"sinceMs": 60000}'
```

<ParamField path="--params <json>" type="string" default="{}">
  JSON object string for params.
</ParamField>
<ParamField path="--url <url>" type="string">
  Gateway WebSocket URL.
</ParamField>
<ParamField path="--token <token>" type="string">
  Gateway token.
</ParamField>
<ParamField path="--password <password>" type="string">
  Gateway password.
</ParamField>
<ParamField path="--timeout <ms>" type="number">
  Timeout budget.
</ParamField>
<ParamField path="--expect-final" type="boolean">
  Mainly for agent-style RPCs that stream intermediate events before a final payload.
</ParamField>
<ParamField path="--json" type="boolean">
  Machine-readable JSON output.
</ParamField>

<Note>
`--params` must be valid JSON.
</Note>

## Manage the Gateway service

```bash
openclaw gateway install
openclaw gateway start
openclaw gateway stop
openclaw gateway restart
openclaw gateway uninstall
```

### Install with a wrapper

Use `--wrapper` when the managed service must start through another executable, for example a
secrets manager shim or a run-as helper. The wrapper receives the normal Gateway args and is
responsible for eventually exec'ing `openclaw` or Node with those args.

```bash
cat > ~/.local/bin/openclaw-doppler <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
exec doppler run --project my-project --config production -- openclaw "$@"
EOF
chmod +x ~/.local/bin/openclaw-doppler

openclaw gateway install --wrapper ~/.local/bin/openclaw-doppler --force
openclaw gateway restart
```

You can also set the wrapper through the environment. `gateway install` validates that the path is
an executable file, writes the wrapper into service `ProgramArguments`, and persists
`OPENCLAW_WRAPPER` in the service environment for later forced reinstalls, updates, and doctor
repairs.

```bash
OPENCLAW_WRAPPER="$HOME/.local/bin/openclaw-doppler" openclaw gateway install --force
openclaw doctor
```

To remove a persisted wrapper, clear `OPENCLAW_WRAPPER` while reinstalling:

```bash
OPENCLAW_WRAPPER= openclaw gateway install --force
openclaw gateway restart
```

<AccordionGroup>
  <Accordion title="Command options">
    - `gateway status`: `--url`, `--token`, `--password`, `--timeout`, `--no-probe`, `--require-rpc`, `--deep`, `--json`
    - `gateway install`: `--port`, `--runtime <node|bun>`, `--token`, `--wrapper <path>`, `--force`, `--json`
    - `gateway restart`: `--safe`, `--force`, `--wait <duration>`, `--json`
    - `gateway uninstall|start|stop`: `--json`

  </Accordion>
  <Accordion title="Lifecycle behavior">
    - Use `gateway restart` to restart a managed service. Do not chain `gateway stop` and `gateway start` as a restart substitute; on macOS, `gateway stop` intentionally disables the LaunchAgent before stopping it.
    - `gateway restart --safe` asks the running Gateway to preflight active OpenClaw work and defer the restart until reply delivery, embedded runs, and task runs drain. `--safe` cannot be combined with `--force` or `--wait`.
    - `gateway restart --wait 30s` overrides the configured restart drain budget for that restart. Bare numbers are milliseconds; units such as `s`, `m`, and `h` are accepted. `--wait 0` waits indefinitely.
    - `gateway restart --force` skips the active-work drain and restarts immediately. Use it when an operator has already inspected the listed task blockers and wants the gateway back now.
    - Lifecycle commands accept `--json` for scripting.

  </Accordion>
  <Accordion title="Auth and SecretRefs at install time">
    - When token auth requires a token and `gateway.auth.token` is SecretRef-managed, `gateway install` validates that the SecretRef is resolvable but does not persist the resolved token into service environment metadata.
    - If token auth requires a token and the configured token SecretRef is unresolved, install fails closed instead of persisting fallback plaintext.
    - For password auth on `gateway run`, prefer `OPENCLAW_GATEWAY_PASSWORD`, `--password-file`, or a SecretRef-backed `gateway.auth.password` over inline `--password`.
    - In inferred auth mode, shell-only `OPENCLAW_GATEWAY_PASSWORD` does not relax install token requirements; use durable config (`gateway.auth.password` or config `env`) when installing a managed service.
    - If both `gateway.auth.token` and `gateway.auth.password` are configured and `gateway.auth.mode` is unset, install is blocked until mode is set explicitly.

  </Accordion>
</AccordionGroup>

## Discover gateways (Bonjour)

`gateway discover` scans for Gateway beacons (`_openclaw-gw._tcp`).

- Multicast DNS-SD: `local.`
- Unicast DNS-SD (Wide-Area Bonjour): choose a domain (example: `openclaw.internal.`) and set up split DNS + a DNS server; see [Bonjour](/gateway/bonjour).

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

<ParamField path="--timeout <ms>" type="number" default="2000">
  Per-command timeout (browse/resolve).
</ParamField>
<ParamField path="--json" type="boolean">
  Machine-readable output (also disables styling/spinner).
</ParamField>

Examples:

```bash
openclaw gateway discover --timeout 4000
openclaw gateway discover --json | jq '.beacons[].wsUrl'
```

<Note>
- The CLI scans `local.` plus the configured wide-area domain when one is enabled.
- `wsUrl` in JSON output is derived from the resolved service endpoint, not from TXT-only hints such as `lanHost` or `tailnetDns`.
- On `local.` mDNS, `sshPort` and `cliPath` are only broadcast when `discovery.mdns.mode` is `full`. Wide-area DNS-SD still writes `cliPath`; `sshPort` stays optional there too.

</Note>

## Related

- [CLI reference](/cli)
- [Gateway runbook](/gateway)
