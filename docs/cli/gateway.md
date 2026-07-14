---
summary: "OpenClaw Gateway CLI (`openclaw gateway`) — run, query, and discover gateways"
read_when:
  - Running the Gateway from the CLI (dev or servers)
  - Debugging Gateway auth, bind modes, and connectivity
  - Discovering gateways via Bonjour (local + wide-area DNS-SD)
title: "Gateway"
sidebarTitle: "Gateway"
---

The Gateway is OpenClaw's WebSocket server (channels, nodes, sessions, hooks). All subcommands below live under `openclaw gateway ...`.

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

```bash
openclaw gateway
openclaw gateway run   # equivalent, explicit form
```

<AccordionGroup>
  <Accordion title="Startup behavior">
    - Refuses to start unless `gateway.mode=local` is set in `~/.openclaw/openclaw.json`. Use `--allow-unconfigured` for ad-hoc/dev runs; it bypasses the guard without writing or repairing config.
    - `openclaw onboard --mode local` and `openclaw setup` write `gateway.mode=local`. If the config file exists but `gateway.mode` is missing, that is treated as damaged/clobbered config and the Gateway refuses to guess `local` for you — re-run onboarding, set the key manually, or pass `--allow-unconfigured`.
    - Binding beyond loopback without auth is blocked.
    - `--bind` values `lan`, `tailnet`, and `custom` resolve over IPv4-only paths today; IPv6-only bring-your-own-host setups need an IPv4 sidecar or proxy in front of the Gateway.
    - `SIGUSR1` triggers an in-process restart when authorized. `commands.restart` (default: enabled) gates externally-sent `SIGUSR1`; set it to `false` to block manual OS-signal restarts while still allowing restart via the `gateway restart` command, the gateway tool, and config-apply/update.
    - `SIGINT`/`SIGTERM` stop the process but do not restore custom terminal state — if you wrap the CLI in a TUI or raw-mode input, restore the terminal yourself before exit.

  </Accordion>
</AccordionGroup>

### Options

<ParamField path="--port <port>" type="number">
  WebSocket port (default from config/env; usually `18789`).
</ParamField>
<ParamField path="--bind <mode>" type="string">
  Bind mode: `loopback` (default), `lan`, `tailnet`, `auto`, `custom`.
</ParamField>
<ParamField path="--token <token>" type="string">
  Shared token for `connect.params.auth.token`. Defaults to `OPENCLAW_GATEWAY_TOKEN` when set.
</ParamField>
<ParamField path="--auth <mode>" type="string">
  Auth mode: `none`, `token`, `password`, `trusted-proxy`.
</ParamField>
<ParamField path="--password <password>" type="string">
  Password for `--auth password`.
</ParamField>
<ParamField path="--password-file <path>" type="string">
  Read the Gateway password from a file.
</ParamField>
<ParamField path="--tailscale <mode>" type="string">
  Tailscale exposure: `off`, `serve`, `funnel`.
</ParamField>
<ParamField path="--tailscale-reset-on-exit" type="boolean">
  Reset Tailscale serve/funnel config on shutdown.
</ParamField>
<ParamField path="--allow-unconfigured" type="boolean">
  Start without enforcing `gateway.mode=local`. Ad-hoc/dev bootstrap only; does not persist or repair config.
</ParamField>
<ParamField path="--dev" type="boolean">
  Create a dev config + workspace if missing (skips `BOOTSTRAP.md`).
</ParamField>
<ParamField path="--reset" type="boolean">
  Reset dev config, credentials, sessions, and workspace. Requires `--dev`.
</ParamField>
<ParamField path="--force" type="boolean">
  Kill any existing listener on the target port before starting.
</ParamField>
<ParamField path="--verbose" type="boolean">
  Verbose logging to stdout/stderr.
</ParamField>
<ParamField path="--cli-backend-logs" type="boolean">
  Only show CLI backend logs in the console (also enables stdout/stderr).
</ParamField>
<ParamField path="--ws-log <style>" type="string" default="auto">
  WebSocket log style: `auto`, `full`, `compact`.
</ParamField>
<ParamField path="--compact" type="boolean">
  Alias for `--ws-log compact`.
</ParamField>
<ParamField path="--raw-stream" type="boolean">
  Log raw model stream events to JSONL.
</ParamField>
<ParamField path="--raw-stream-path <path>" type="string">
  Raw stream JSONL path.
</ParamField>

`--claude-cli-logs` is a deprecated alias for `--cli-backend-logs`.

For `--bind custom`, set `gateway.customBindHost` to an IPv4 address. Any address other than `127.0.0.1` or `0.0.0.0` also requires `127.0.0.1` on the same port for same-host clients; startup fails if either listener cannot bind. Wildcard `0.0.0.0` does not add a separate required alias. IPv6-only bring-your-own-host setups need an IPv4 sidecar or proxy in front of the Gateway.

## Restart the Gateway

```bash
openclaw gateway restart
openclaw gateway restart --safe
openclaw gateway restart --safe --skip-deferral
openclaw gateway restart --force
openclaw gateway restart --wait 30s
```

`--safe` asks the running Gateway to preflight active work and schedule one coalesced restart after that work drains. The wait is bounded by `gateway.reload.deferralTimeoutMs` (default: 5 minutes / `300000`); when the budget expires the restart is forced. Set `deferralTimeoutMs: 0` to wait indefinitely (with periodic still-pending warnings) instead of forcing. `--safe` cannot combine with `--force` or `--wait`.

`--skip-deferral` bypasses the active-work deferral gate on a safe restart, so the Gateway restarts immediately even with reported blockers. It requires `--safe` — use it when a deferral is stuck on a runaway task.

`--wait <duration>` overrides the drain budget for a plain (non-safe) restart. Accepts bare milliseconds or unit suffixes `ms`, `s`, `m`, `h`, `d` (e.g. `30s`, `5m`, `1h30m`); `--wait 0` waits indefinitely. Not compatible with `--force` or `--safe`.

`--force` skips the active-work drain and restarts immediately. Plain `restart` (no flags) keeps the existing service-manager restart behavior.

<Warning>
Inline `--password` can be exposed in local process listings. Prefer `--password-file`, env, or a SecretRef-backed `gateway.auth.password`.
</Warning>

### Gateway profiling

- `OPENCLAW_GATEWAY_STARTUP_TRACE=1` logs phase timings during startup, including per-phase `eventLoopMax` delay and plugin lookup-table timings (installed-index, manifest registry, startup planning, owner-map work).
- `OPENCLAW_GATEWAY_RESTART_TRACE=1` logs restart-scoped `restart trace:` lines: signal handling, active-work drain, shutdown phases, next start, ready timing, and memory metrics.
- `OPENCLAW_DIAGNOSTICS=timeline` with `OPENCLAW_DIAGNOSTICS_TIMELINE_PATH=<path>` writes a best-effort JSONL startup diagnostics timeline for external QA harnesses (equivalent to config `diagnostics.flags: ["timeline"]`; the path is still env-only). Add `OPENCLAW_DIAGNOSTICS_EVENT_LOOP=1` to include event-loop samples.
- `pnpm build` then `pnpm test:startup:gateway -- --runs 5 --warmup 1` benchmarks Gateway startup against the built CLI entry: first process output, `/healthz`, `/readyz`, startup trace timings, event-loop delay, and plugin lookup-table timing.
- `pnpm build` then `pnpm test:restart:gateway -- --case skipChannels --runs 1 --restarts 5` benchmarks in-process restart on macOS or Linux (not supported on Windows; restart requires `SIGUSR1`). Uses `SIGUSR1`, enables both traces in the child process, and records next `/healthz`, next `/readyz`, downtime, ready timing, CPU, RSS, and restart trace metrics.
- `/healthz` is liveness; `/readyz` is usable readiness. Treat trace lines and benchmark output as owner-attribution signal, not a complete performance conclusion from one span or sample.

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
    - `--timeout <ms>`: timeout/budget (default varies per command; see each command below).
    - `--expect-final`: wait for a "final" response (agent calls).

  </Tab>
</Tabs>

<Note>
When you set `--url`, the CLI does not fall back to config or environment credentials. Pass `--token` or `--password` explicitly. Missing explicit credentials is an error.
</Note>

### `gateway health`

```bash
openclaw gateway health --url ws://127.0.0.1:18789
openclaw gateway health --port 18789
```

`/healthz` is a liveness probe: it returns as soon as the server can answer HTTP. `/readyz` is stricter and stays red while startup plugin sidecars, channels, or configured hooks are still settling. Local or authenticated detailed `/readyz` responses include an `eventLoop` diagnostic block (delay, utilization, CPU-core ratio, `degraded` flag).

<ParamField path="--port <port>" type="number">
  Target a local loopback Gateway on this port. Overrides `OPENCLAW_GATEWAY_URL` and `OPENCLAW_GATEWAY_PORT` for this call.
</ParamField>

### `gateway usage-cost`

Fetch usage-cost summaries from session logs.

```bash
openclaw gateway usage-cost
openclaw gateway usage-cost --days 7
openclaw gateway usage-cost --agent work --json
openclaw gateway usage-cost --all-agents
openclaw gateway usage-cost --json
```

<ParamField path="--days <days>" type="number" default="30">
  Number of days to include.
</ParamField>
<ParamField path="--agent <id>" type="string">
  Scope the summary to one configured agent id.
</ParamField>
<ParamField path="--all-agents" type="boolean">
  Aggregate across all configured agents. Cannot combine with `--agent`.
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
  Maximum recent events to include (max `1000`).
</ParamField>
<ParamField path="--type <type>" type="string">
  Filter by diagnostic event type, e.g. `payload.large` or `diagnostic.memory.pressure`.
</ParamField>
<ParamField path="--since-seq <seq>" type="number">
  Include only events after a diagnostic sequence number.
</ParamField>
<ParamField path="--bundle [path]" type="string">
  Read a persisted stability bundle instead of calling the running Gateway. `--bundle latest` (or bare `--bundle`) picks the newest bundle under the state directory; you can also pass a bundle JSON path directly.
</ParamField>
<ParamField path="--export" type="boolean">
  Write a shareable support diagnostics zip instead of printing stability details.
</ParamField>
<ParamField path="--output <path>" type="string">
  Output path for `--export`.
</ParamField>

<AccordionGroup>
  <Accordion title="Privacy and bundle behavior">
    - Records keep operational metadata: event names, counts, byte sizes, memory readings, queue/session state, approval ids, channel/plugin names, and redacted session summaries. They exclude chat text, webhook bodies, tool outputs, raw request/response bodies, tokens, cookies, secret values, hostnames, and raw session ids. Set `diagnostics.enabled: false` to disable the recorder entirely.
    - Fatal Gateway exits, shutdown timeouts, and restart startup failures write the same diagnostic snapshot to `~/.openclaw/logs/stability/openclaw-stability-*.json` when the recorder has events. Inspect the newest bundle with `openclaw gateway stability --bundle latest`; `--limit`, `--type`, and `--since-seq` apply to bundle output too.

  </Accordion>
</AccordionGroup>

### `gateway diagnostics export`

Write a local diagnostics zip designed for bug reports. For the privacy model and bundle contents, see [Diagnostics Export](/gateway/diagnostics).

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

The export bundles: `manifest.json` (file inventory), `summary.md` (Markdown summary), `diagnostics.json` (top-level config/logs/discovery/stability/status/health summary), `config/sanitized.json`, `status/gateway-status.json`, `health/gateway-health.json`, `logs/openclaw-sanitized.jsonl`, and `stability/latest.json` when a bundle exists.

It is designed to be shared. It keeps operational details useful for debugging — safe log fields, subsystem names, status codes, durations, configured modes, ports, plugin/provider ids, non-secret feature settings, and redacted operational log messages — and omits or redacts chat text, webhook bodies, tool outputs, credentials, cookies, account/message identifiers, prompt/instruction text, hostnames, and secret values. When a log message looks like user/chat/tool payload text (e.g. "user said", "chat text", "tool output", "webhook body"), the export keeps only the fact that a message was omitted plus its byte count.

### `gateway status`

Shows the Gateway service (launchd/systemd/schtasks) plus an optional connectivity/auth probe.

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
  Upgrade the connectivity probe to a read probe and exit non-zero if it fails. Cannot combine with `--no-probe`.
</ParamField>

<AccordionGroup>
  <Accordion title="Status semantics">
    - Stays available for diagnostics even when the local CLI config is missing or invalid.
    - Default output proves service state, WebSocket connect, and the auth capability visible at handshake time — not read/write/admin operations.
    - Probes are non-mutating for first-time device auth: they reuse an existing cached device token when one exists, but never create a new CLI device identity or read-only pairing record just to check status.
    - Resolves configured auth SecretRefs for probe auth when possible. If a required SecretRef is unresolved, `--json` reports `rpc.authWarning` when probe connectivity/auth fails; pass `--token`/`--password` explicitly or fix the secret source. Unresolved-auth warnings are suppressed once the probe succeeds.
    - JSON output includes `gateway.version` when the running Gateway reports it; `--require-rpc` can fall back to the `status.runtimeVersion` RPC payload if the handshake probe cannot supply version metadata.
    - Use `--require-rpc` in scripts/automation when a listening service is not enough and you need read-scope RPC to be healthy too.
    - `--deep` scans for extra launchd/systemd/schtasks installs; when multiple gateway-like services are found, human output prints cleanup hints (usually run one gateway per machine) and reports a recent supervisor restart handoff when relevant.
    - `--deep` also runs config validation in plugin-aware mode (`pluginValidation: "full"`) and surfaces plugin manifest warnings (e.g. missing channel config metadata). Default `gateway status` keeps the fast read-only path that skips plugin validation.
    - Human output includes the resolved file log path plus CLI-vs-service config paths/validity to help diagnose profile or state-dir drift.

  </Accordion>
  <Accordion title="Linux systemd auth-drift checks">
    - Service auth drift checks read both `Environment=` and `EnvironmentFile=` from the unit (including `%h`, quoted paths, multiple files, and optional `-` files).
    - Resolves `gateway.auth.token` SecretRefs using merged runtime env (service command env first, then process env fallback).
    - Token-drift checks skip config token resolution when token auth is not effectively active (`gateway.auth.mode` explicitly `password`/`none`/`trusted-proxy`, or mode unset where password can win and no token candidate can win).

  </Accordion>
</AccordionGroup>

### `gateway probe`

The "debug everything" command. It always probes:

- your configured remote gateway (if set), and
- localhost (loopback), **even if remote is configured**.

Passing `--url` adds that explicit target ahead of both. Human output labels targets `URL (explicit)`, `Remote (configured)` / `Remote (configured, inactive)`, and `Local loopback`.

<Note>
If multiple probe targets are reachable, all are printed. An SSH tunnel, TLS/proxy URL, and configured remote URL can point at the same gateway even with different transport ports; `multiple_gateways` is reserved for distinct or identity-ambiguous reachable gateways. Running multiple gateways is supported for isolated profiles (e.g. a rescue bot), but most installs run a single gateway.
</Note>

```bash
openclaw gateway probe
openclaw gateway probe --json
openclaw gateway probe --port 18789
```

<ParamField path="--port <port>" type="number">
  Use this port for the local loopback probe target and SSH tunnel remote port. Without `--url`, this selects only the local loopback target instead of configured gateway environment URL, environment port, or remote targets.
</ParamField>

<AccordionGroup>
  <Accordion title="Interpretation">
    - `Reachable: yes` means at least one target accepted a WebSocket connect.
    - `Capability: read-only|write-capable|admin-capable|pairing-pending|connect-only` reports what the probe could prove about auth, separate from reachability.
    - `Read probe: ok` means read-scope detail RPC calls (`health`/`status`/`system-presence`/`config.get`) also succeeded.
    - `Read probe: limited - missing scope: operator.read` means connect succeeded but read-scope RPC is limited. Reported as **degraded** reachability, not full failure.
    - `Read probe: failed` after `Connect: ok` means the WebSocket connected but follow-up read diagnostics timed out or failed — also **degraded**, not unreachable.
    - Like `gateway status`, probe reuses existing cached device auth but does not create first-time device identity or pairing state.
    - Exit code is non-zero only when no probed target is reachable.

  </Accordion>
  <Accordion title="JSON output">
    Top level:

    - `ok`: at least one target is reachable.
    - `degraded`: at least one target accepted a connection but did not complete full detail RPC diagnostics.
    - `capability`: best capability seen across reachable targets (`read_only`, `write_capable`, `admin_capable`, `pairing_pending`, `connected_no_operator_scope`, or `unknown`).
    - `primaryTargetId`: best target to treat as the active winner, in order: explicit URL, SSH tunnel, configured remote, local loopback.
    - `warnings[]`: best-effort warning records with `code`, `message`, optional `targetIds`.
    - `network`: local loopback/tailnet URL hints derived from current config and host networking.
    - `discovery.timeoutMs` / `discovery.count`: the actual discovery budget/result count used for this probe pass.

    Per target (`targets[].connect`): `ok` (reachability + degraded classification), `rpcOk` (full detail RPC success), `scopeLimited` (detail RPC failed on missing operator scope).

    Per target (`targets[].auth`): `role` and `scopes` reported in `hello-ok` when available, plus the surfaced `capability` classification.

  </Accordion>
  <Accordion title="Common warning codes">
    - `ssh_tunnel_failed`: SSH tunnel setup failed; the command fell back to direct probes.
    - `multiple_gateways`: distinct gateway identities were reachable, or OpenClaw could not prove reachable targets are the same gateway. An SSH tunnel, proxy URL, or configured remote URL to the same gateway does not trigger this.
    - `auth_secretref_unresolved`: a configured auth SecretRef could not be resolved for a failed target.
    - `probe_scope_limited`: WebSocket connect succeeded, but the read probe was limited by missing `operator.read`.
    - `local_tls_runtime_unavailable`: local Gateway TLS is enabled but OpenClaw could not load the local certificate fingerprint.

  </Accordion>
</AccordionGroup>

#### Remote over SSH (Mac app parity)

The macOS app "Remote over SSH" mode uses a local port-forward so a loopback-only remote gateway becomes reachable at `ws://127.0.0.1:<port>`.

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

Config defaults (optional): `gateway.remote.sshTarget`, `gateway.remote.sshIdentity`.

### `gateway call <method>`

Low-level RPC helper.

```bash
openclaw gateway call status
openclaw gateway call logs.tail --params '{"limit": 200}'
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
<ParamField path="--timeout <ms>" type="number" default="10000">
  Timeout budget.
</ParamField>
<ParamField path="--expect-final" type="boolean">
  Mainly for agent-style RPCs that stream intermediate events before a final payload.
</ParamField>
<ParamField path="--json" type="boolean">
  Machine-readable JSON output.
</ParamField>

<Note>
`--params` must be valid JSON, and each method validates its own param shape (extra/misnamed fields are rejected).
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

Use `--wrapper` when the managed service must start through another executable, for example a secrets manager shim or a run-as helper. The wrapper receives the normal Gateway args and is responsible for eventually exec'ing `openclaw` or Node with those args.

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

You can also set the wrapper through the environment. `gateway install` validates that the path is an executable file, writes the wrapper into the service `ProgramArguments`, and persists `OPENCLAW_WRAPPER` in the service environment for later forced reinstalls, updates, and doctor repairs.

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
    - `gateway install`: `--port`, `--runtime <node>` (default: `node`), `--token`, `--wrapper <path>`, `--force`, `--json`
    - `gateway restart`: `--safe`, `--skip-deferral`, `--force`, `--wait <duration>`, `--json`
    - `gateway uninstall|start`: `--json`
    - `gateway stop`: `--disable`, `--json`

  </Accordion>
  <Accordion title="Lifecycle behavior">
    - Use `gateway restart` to restart a managed service. Do not chain `gateway stop` and `gateway start` as a restart substitute.
    - On macOS, `gateway stop` uses `launchctl bootout` by default, which removes the LaunchAgent from the current boot session without persisting a disable — KeepAlive auto-recovery stays active for future crashes and `gateway start` re-enables cleanly without a manual `launchctl enable`. Pass `--disable` to persistently suppress KeepAlive and RunAtLoad so the gateway does not respawn until the next explicit `gateway start`; use this when a manual stop should survive reboots.
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
- Unicast DNS-SD (wide-area Bonjour): choose a domain (example: `openclaw.internal.`) and set up split DNS + a DNS server; see [Bonjour](/gateway/bonjour).

Only gateways with Bonjour discovery enabled (default) advertise the beacon.

TXT hints on every beacon: `role` (gateway role hint), `transport` (transport hint, e.g. `gateway`), `gatewayPort` (WebSocket port, usually `18789`), `tailnetDns` (MagicDNS hostname, when available), `gatewayTls` / `gatewayTlsSha256` (TLS enabled + cert fingerprint). `sshPort` and `cliPath` are published only in full discovery mode (`discovery.mdns.mode: "full"`; default is `"minimal"`, which omits them — clients then default SSH targets to port `22`).

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
- Scans `local.` plus the configured wide-area domain when one is enabled.
- `wsUrl` in JSON output is derived from the resolved service endpoint, not from TXT-only hints such as `lanHost` or `tailnetDns`.
- `discovery.mdns.mode` controls `sshPort`/`cliPath` publication on both `local.` mDNS and wide-area DNS-SD (see above).

</Note>

## Related

- [CLI reference](/cli)
- [Gateway runbook](/gateway)
