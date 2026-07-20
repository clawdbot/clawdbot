---
summary: "Deep troubleshooting runbook for gateway, channels, automation, nodes, and browser"
read_when:
  - The troubleshooting hub pointed you here for deeper diagnosis
  - You need stable symptom based runbook sections with exact commands
title: "Troubleshooting"
sidebarTitle: "Troubleshooting"
---

This is the deep runbook. Start at [/help/troubleshooting](/help/troubleshooting) for the fast triage flow first.

## Command ladder

Run in this order:

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

Healthy signals:

- `openclaw gateway status` shows `Runtime: running`, `Connectivity probe: ok`, and a `Capability: ...` line.
- `openclaw doctor` reports no blocking config/service issues.
- `openclaw channels status --probe` shows live per-account transport status and, where supported, `works` or `audit ok`.

## After an update

Use when an update finishes but the Gateway is down, channels are empty, or model calls fail with 401s.

```bash
openclaw status --all
openclaw update status --json
openclaw gateway status --deep
openclaw doctor --fix
openclaw gateway restart
```

Look for:

- `Update restart` in `openclaw status` / `openclaw status --all`. Pending or failed handoffs include the next command to run.
- `plugin load failed: dependency tree corrupted; run openclaw doctor --fix` under Channels: the channel config still exists, but plugin registration failed before the channel could load.
- Provider 401s after re-auth: `openclaw doctor --fix` checks for stale per-agent OAuth auth shadows and removes old copies so all agents resolve the current shared profile.

## Split brain installs and newer config guard

Use when a gateway service unexpectedly stops after an update, or logs show one `openclaw` binary is older than the version that last wrote `openclaw.json`.

OpenClaw stamps config writes with `meta.lastTouchedVersion`. Read-only commands can inspect a config written by a newer OpenClaw, but process and service mutations refuse to run from an older binary. Blocked actions: gateway service start/stop/restart/uninstall, forced service reinstall, service-mode gateway startup, and `gateway --force` port cleanup.

```bash
which openclaw
openclaw --version
openclaw gateway status --deep
openclaw config get meta.lastTouchedVersion
```

<Steps>
  <Step title="Fix PATH">
    Fix `PATH` so `openclaw` resolves to the newer install, then rerun the action.
  </Step>
  <Step title="Reinstall the gateway service">
    Reinstall the intended gateway service from the newer install:

    ```bash
    openclaw gateway install --force
    openclaw gateway restart
    ```

  </Step>
  <Step title="Remove stale wrappers">
    Remove stale system package or old wrapper entries that still point at an old `openclaw` binary.
  </Step>
</Steps>

<Warning>
For intentional downgrade or emergency recovery only, set `OPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS=1` for the single command. Leave it unset for normal operation.
</Warning>

## Protocol mismatch after rollback

Use when logs keep printing `protocol mismatch` after a downgrade or rollback. An older Gateway is running, but a newer local client process is still reconnecting with a protocol range the older Gateway cannot speak.

```bash
openclaw --version
which -a openclaw
openclaw gateway status --deep
openclaw doctor --deep
openclaw logs --follow
```

Look for:

- `protocol mismatch ... client=... v<version> min=<n> max=<n> expected=<n>` in Gateway logs.
- `Established clients:` in `openclaw gateway status --deep` or `Gateway clients` in `openclaw doctor --deep`: active TCP clients connected to the Gateway port, with PIDs and command lines when the OS allows it.
- A client process whose command line points at the newer OpenClaw install or wrapper you rolled back from.

Fix:

1. Stop or restart the stale OpenClaw client process shown by `gateway status --deep`.
2. Restart apps or wrappers that embed OpenClaw: local dashboards, editors, app-server helpers, or long-running `openclaw logs --follow` shells.
3. Re-run `openclaw gateway status --deep` or `openclaw doctor --deep` and confirm the stale client PID is gone.

Do not make an older Gateway accept a newer incompatible protocol. Protocol bumps protect the wire contract; rollback recovery is a process/version cleanup problem.

## Skill symlink skipped as path escape

Use when logs include:

```text
Skipping escaped skill path outside its configured root: ... reason=symlink-escape
```

Every skill root is a containment boundary. A symlink under `~/.agents/skills`, `<workspace>/.agents/skills`, `<workspace>/skills`, or `~/.openclaw/skills` is skipped when its real target resolves outside that root, unless the target is explicitly trusted.

Inspect the link:

```bash
ls -l ~/.agents/skills/<name>
realpath ~/.agents/skills/<name>
openclaw config get skills.load
```

If the target is intentional, configure both the direct skill root and the allowed symlink target:

```json5
{
  skills: {
    load: {
      extraDirs: ["~/Projects/manager/skills"],
      allowSymlinkTargets: ["~/Projects/manager/skills"],
    },
  },
}
```

Then start a new session or wait for the skills watcher to refresh. Restart the gateway if the running process predates the config change.

Do not use broad targets such as `~`, `/`, or a whole synced project folder. Keep `allowSymlinkTargets` scoped to the real skill root that contains trusted `SKILL.md` directories.

If Skill Workshop apply should also write through those trusted symlinked workspace skill paths, enable `skills.workshop.allowSymlinkTargetWrites`. Keep it disabled for read-only shared skill roots.

Related:

- [Skills config](/tools/skills-config#symlinked-skill-roots)
- [Configuration examples](/gateway/configuration-examples#symlinked-sibling-skill-repo)

## Anthropic 429 extra usage required for long context

Use when logs/errors include: `HTTP 429: rate_limit_error: Extra usage is required for long context requests`.

```bash
openclaw logs --follow
openclaw models status
openclaw config get agents.defaults.models
```

Look for:

- Selected Anthropic model is a GA-capable 1M Claude 4.x model (Opus 4.6/4.7/4.8, Sonnet 4.6), or the model config still carries legacy `params.context1m: true`.
- Current Anthropic credential is not eligible for long-context usage.
- Requests fail only on long sessions/model runs that need the 1M context path.

Fix options:

<Steps>
  <Step title="Use a standard context window">
    Switch to a standard-window model, or remove legacy `context1m` from older
    model config that is not GA-capable for 1M context.
  </Step>
  <Step title="Use an eligible credential">
    Use an Anthropic credential that is eligible for long-context requests, or switch to an Anthropic API key.
  </Step>
  <Step title="Configure fallback models">
    Configure fallback models so runs continue when Anthropic long-context requests are rejected.
  </Step>
</Steps>

Related:

- [Anthropic](/providers/anthropic)
- [Token use and costs](/reference/token-use)
- [Why am I seeing HTTP 429 from Anthropic?](/help/faq-first-run#why-am-i-seeing-http-429-ratelimiterror-from-anthropic)

## Upstream 403 blocked responses

Use when an upstream LLM provider returns a generic `403` such as `Your request was blocked`.

Do not assume this is always an OpenClaw configuration issue. The response can come from an upstream security layer such as a CDN, WAF, bot-management rule, or reverse proxy in front of an OpenAI-compatible endpoint.

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
```

Look for:

- Multiple models under the same provider failing the same way.
- HTML or generic security text instead of a normal provider API error.
- Provider-side security events for the same request time.
- A tiny direct `curl` probe succeeding while normal SDK-shaped requests fail.

Fix the provider-side filtering first when evidence points to a WAF/CDN block. Prefer a narrowly scoped allow or skip rule for the API path OpenClaw uses, and avoid disabling protection for the whole site.

<Warning>
A successful minimal `curl` does not guarantee that real SDK-style requests will pass through the same upstream security layer.
</Warning>

Related:

- [OpenAI-compatible endpoints](/gateway/configuration-reference#openai-compatible-endpoints)
- [Provider configuration](/providers)
- [Logs](/logging)

## Local OpenAI-compatible backend passes direct probes but agent runs fail

Use when:

- `curl ... /v1/models` works.
- Tiny direct `/v1/chat/completions` calls work.
- OpenClaw model runs fail only on normal agent turns.

```bash
curl http://127.0.0.1:1234/v1/models
curl http://127.0.0.1:1234/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"<id>","messages":[{"role":"user","content":"hi"}],"stream":false}'
openclaw infer model run --model <provider/model> --prompt "hi" --json
openclaw logs --follow
```

Look for:

- Direct tiny calls succeed, but OpenClaw runs fail only on larger prompts.
- `model_not_found` or 404 errors even though direct `/v1/chat/completions` works with the same bare model id.
- Backend errors about `messages[].content` expecting a string.
- Intermittent `incomplete turn detected ... stopReason=stop payloads=0` warnings with an OpenAI-compatible local backend.
- Backend crashes that appear only with larger prompt-token counts or full agent runtime prompts.

<AccordionGroup>
  <Accordion title="Common signatures">
    - `model_not_found` with a local MLX/vLLM-style server: verify `baseUrl` includes `/v1`, `api` is `"openai-completions"` for `/v1/chat/completions` backends, and `models.providers.<provider>.models[].id` is the bare provider-local id. Select it with the provider prefix once, for example `mlx/mlx-community/Qwen3-30B-A3B-6bit`; keep the catalog entry as `mlx-community/Qwen3-30B-A3B-6bit`.
    - `messages[...].content: invalid type: sequence, expected a string`: backend rejects structured Chat Completions content parts. Fix: set `models.providers.<provider>.models[].compat.requiresStringContent: true`.
    - `validation.keys` or allowed message keys like `["role","content"]`: backend rejects OpenAI-style replay metadata on Chat Completions messages. Fix: set `models.providers.<provider>.models[].compat.strictMessageKeys: true`.
    - `incomplete turn detected ... stopReason=stop payloads=0`: the backend completed the Chat Completions request but returned no user-visible assistant text for that turn. OpenClaw retries replay-safe empty OpenAI-compatible turns once; persistent failures usually mean the backend is emitting empty/non-text content or suppressing final-answer text.
    - Direct tiny requests succeed, but OpenClaw agent runs fail with backend/model crashes (for example Gemma on some `inferrs` builds): OpenClaw transport is likely already correct; the backend is failing on the larger agent-runtime prompt shape.
    - Failures shrink after disabling tools but do not disappear: tool schemas were part of the pressure, but the remaining issue is still upstream model/server capacity or a backend bug.

  </Accordion>
  <Accordion title="Fix options">
    1. Set `compat.requiresStringContent: true` for string-only Chat Completions backends.
    2. Set `compat.strictMessageKeys: true` for strict Chat Completions backends that only accept `role` and `content` on each message.
    3. Set `compat.supportsTools: false` for models/backends that cannot handle OpenClaw's tool schema surface reliably.
    4. Lower prompt pressure where possible: smaller workspace bootstrap, shorter session history, lighter local model, or a backend with stronger long-context support.
    5. If tiny direct requests keep passing while OpenClaw agent turns still crash inside the backend, treat it as an upstream server/model limitation and file a repro there with the accepted payload shape.
  </Accordion>
</AccordionGroup>

Related:

- [Configuration](/gateway/configuration)
- [Local models](/gateway/local-models)
- [OpenAI-compatible endpoints](/gateway/configuration-reference#openai-compatible-endpoints)

## No replies

If channels are up but nothing answers, check routing and policy before reconnecting anything.

```bash
openclaw status
openclaw channels status --probe
openclaw pairing list --channel <channel> [--account <id>]
openclaw config get channels
openclaw logs --follow
```

Look for:

- Pairing pending for DM senders.
- Group mention gating (`requireMention`, `mentionPatterns`).
- Channel/group allowlist mismatches.

Common signatures:

- `drop guild message (mention required` → group message ignored until mention.
- `pairing request` → sender needs approval.
- `blocked` / `allowlist` → sender/channel was filtered by policy.

Related:

- [Channel troubleshooting](/channels/troubleshooting)
- [Groups](/channels/groups)
- [Pairing](/channels/pairing)

## Dashboard control UI connectivity

When the dashboard/control UI will not connect, validate URL, auth mode, and secure context assumptions.

```bash
openclaw gateway status
openclaw status
openclaw logs --follow
openclaw doctor
openclaw gateway status --json
```

Look for:

- Correct probe URL and dashboard URL.
- Auth mode/token mismatch between client and gateway.
- HTTP usage where device identity is required.

If a local browser cannot connect to `127.0.0.1:18789` after an update, first recover the local Gateway service and confirm it is serving the dashboard:

```bash
openclaw gateway restart
lsof -i :18789
curl http://127.0.0.1:18789
```

If `curl` returns OpenClaw HTML, the Gateway is working and the remaining issue is likely browser cache, an old deep link, or stale tab state. Open `http://127.0.0.1:18789` directly and navigate from the dashboard. If restart does not leave the service running, run `openclaw gateway start` and recheck `openclaw gateway status`.

<AccordionGroup>
  <Accordion title="Connect / auth signatures">
    - `device identity required` → non-secure context or missing device auth.
    - `origin not allowed` → browser `Origin` is not in `gateway.controlUi.allowedOrigins` (or you are connecting from a non-loopback browser origin without an explicit allowlist).
    - `device nonce required` / `device nonce mismatch` → client is not completing the challenge-based device auth flow (`connect.challenge` + `device.nonce`).
    - `device signature invalid` / `device signature expired` → client signed the wrong payload (or stale timestamp) for the current handshake.
    - `AUTH_TOKEN_MISMATCH` with `canRetryWithDeviceToken=true` → client can do one trusted retry with cached device token.
    - That cached-token retry reuses the cached scope set stored with the paired device token. Explicit `deviceToken` / explicit `scopes` callers keep their requested scope set instead.
    - `AUTH_SCOPE_MISMATCH` → the device token was recognized, but its approved scopes do not cover this connect request; re-pair or approve the requested scope contract instead of rotating a shared gateway token.
    - Outside that retry path, connect auth precedence is explicit shared token/password first, then explicit `deviceToken`, then stored device token, then bootstrap token.
    - On the async Tailscale Serve Control UI path, failed attempts for the same `{scope, ip}` are serialized before the limiter records the failure. Two bad concurrent retries from the same client can therefore surface `retry later` on the second attempt instead of two plain mismatches.
    - `too many failed authentication attempts (retry later)` from a browser-origin loopback client → repeated failures from that same normalized `Origin` are locked out temporarily; another localhost origin uses a separate bucket.
    - Repeated `unauthorized` after that retry → shared token/device token drift; refresh token config and re-approve/rotate device token if needed.
    - `gateway connect failed:` → wrong host/port/url target.

  </Accordion>
</AccordionGroup>

### Auth detail codes quick map

Use `error.details.code` from the failed `connect` response to pick the next action:

| Detail code                  | Meaning                                                                                                                                                                                      | Recommended action                                                                                                                                                                                                                                                                       |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AUTH_TOKEN_MISSING`         | Client did not send a required shared token.                                                                                                                                                 | Paste/set token in the client and retry. For dashboard paths: `openclaw config get gateway.auth.token` then paste into Control UI settings.                                                                                                                                              |
| `AUTH_TOKEN_MISMATCH`        | Shared token did not match gateway auth token.                                                                                                                                               | If `canRetryWithDeviceToken=true`, allow one trusted retry. Cached-token retries reuse stored approved scopes; explicit `deviceToken` / `scopes` callers keep requested scopes. If still failing, run the [token drift recovery checklist](/cli/devices#token-drift-recovery-checklist). |
| `AUTH_DEVICE_TOKEN_MISMATCH` | Cached per-device token is stale or revoked.                                                                                                                                                 | Rotate/re-approve device token using [devices CLI](/cli/devices), then reconnect.                                                                                                                                                                                                        |
| `AUTH_SCOPE_MISMATCH`        | Device token is valid, but its approved role/scopes do not cover this connect request.                                                                                                       | Re-pair the device or approve the requested scope contract; do not treat this as shared-token drift.                                                                                                                                                                                     |
| `PAIRING_REQUIRED`           | Device identity needs approval. Check `error.details.reason` for `not-paired`, `scope-upgrade`, `role-upgrade`, or `metadata-upgrade`, and use `requestId` / `remediationHint` when present. | Approve pending request: `openclaw devices list` then `openclaw devices approve <requestId>`. Scope/role upgrades use the same flow after you review the requested access.                                                                                                               |

<Note>
Direct loopback backend RPCs authenticated with the shared gateway token/password should not depend on the CLI's paired-device scope baseline. If subagents or other internal calls still fail with `scope-upgrade`, verify the caller is using `client.id: "gateway-client"` and `client.mode: "backend"` and is not forcing an explicit `deviceIdentity` or device token.
</Note>

Device auth v2 migration check:

```bash
openclaw --version
openclaw doctor
openclaw gateway status
```

If logs show nonce/signature errors, update the connecting client and verify it:

<Steps>
  <Step title="Wait for connect.challenge">
    Client waits for the gateway-issued `connect.challenge`.
  </Step>
  <Step title="Sign the payload">
    Client signs the challenge-bound payload.
  </Step>
  <Step title="Send the device nonce">
    Client sends `connect.params.device.nonce` with the same challenge nonce.
  </Step>
</Steps>

If `openclaw devices rotate` / `revoke` / `remove` is denied unexpectedly:

- Paired-device token sessions can manage only **their own** device unless the caller also has `operator.admin`.
- `openclaw devices rotate --scope ...` can only request operator scopes that the caller session already holds.

Related:

- [Configuration](/gateway/configuration) (gateway auth modes)
- [Control UI](/web/control-ui)
- [Devices](/cli/devices)
- [Remote access](/gateway/remote)
- [Trusted proxy auth](/gateway/trusted-proxy-auth)

## Gateway service not running

Use when the service is installed but the process does not stay up.

```bash
openclaw gateway status
openclaw status
openclaw logs --follow
openclaw doctor
openclaw gateway status --deep   # also scan system-level services
```

Look for:

- `Runtime: stopped` with exit hints.
- Service config mismatch (`Config (cli)` vs `Config (service)`).
- Port/listener conflicts.
- Extra launchd/systemd/schtasks installs when `--deep` is used.
- `Other gateway-like services detected (best effort)` cleanup hints.

<AccordionGroup>
  <Accordion title="Common signatures">
    - `Gateway start blocked: set gateway.mode=local` or `existing config is missing gateway.mode` → local gateway mode is not enabled, or the config file was clobbered and lost `gateway.mode`. Fix: set `gateway.mode="local"` in your config, or re-run `openclaw onboard --mode local` / `openclaw setup` to restamp the expected local-mode config. If you are running OpenClaw via Podman, the default config path is `~/.openclaw/openclaw.json`.
    - `refusing to bind gateway ... without auth` → non-loopback bind without a valid gateway auth path (token/password, or trusted-proxy where configured).
    - `another gateway instance is already listening` / `EADDRINUSE` → port conflict.
    - `Other gateway-like services detected (best effort)` → stale or parallel launchd/systemd/schtasks units exist. Most setups should keep one gateway per machine; if you do need more than one, isolate ports + config/state/workspace. See [/gateway#multiple-gateways-same-host](/gateway#multiple-gateways-same-host).
    - `System-level OpenClaw gateway service detected` from doctor → a systemd system unit exists while the user-level service is missing. Remove or disable the duplicate before allowing doctor to install a user service, or set `OPENCLAW_SERVICE_REPAIR_POLICY=external` if the system unit is the intended supervisor.
    - `Gateway service port does not match current gateway config` → the installed supervisor still pins the old `--port`. Run `openclaw doctor --fix` or `openclaw gateway install --force`, then restart the gateway service.

  </Accordion>
</AccordionGroup>

Related:

- [Background exec and process tool](/gateway/background-process)
- [Configuration](/gateway/configuration)
- [Doctor](/gateway/doctor)

## macOS gateway silently stops responding, then resumes when you touch the dashboard

Use when channels (Telegram, WhatsApp, etc.) on a macOS host go quiet for minutes to hours at a time, and the gateway appears to come back the moment you open the Control UI, SSH in, or otherwise interact with the host. There is usually no obvious symptom in `openclaw status` because by the time you look the gateway is alive again.

```bash
ls ~/.openclaw/logs/stability/ | tail -5
openclaw gateway stability --bundle latest
pmset -g log | grep -iE "sleep|wake|maintenance" | tail -50
launchctl print gui/$UID/ai.openclaw.gateway | grep -E "state|last exit|runs"
```

Look for:

- One or more `*-uncaught_exception.json` bundles in `~/.openclaw/logs/stability/` with `error.code` set to a transient network code such as `ENETDOWN`, `ENETUNREACH`, `EHOSTUNREACH`, or `ECONNREFUSED`.
- `pmset -g log` lines like `Entering Sleep state due to 'Maintenance Sleep'` or `en0 driver is slow (msg: WillChangeState to 0)` aligned with the crash timestamps. Power Nap / Maintenance Sleep briefly puts the Wi-Fi driver into state 0; any outbound `connect()` that lands in that window can fail with `ENETDOWN` even on a host that otherwise has full network connectivity.
- `launchctl print` output showing `state = not running` with multiple recent `runs` and an exit code, especially when the gap between crash and the next launch is on the order of an hour rather than seconds. macOS launchd applies an undocumented respawn-protection gate after a crash burst that can stop honoring `KeepAlive=true` until an external trigger such as interactive login, dashboard connection, or `launchctl kickstart` re-arms it.

Common signatures:

- A stability bundle whose `error.code` is `ENETDOWN` or a sibling code, with the call stack pointing into Node `net` `lookupAndConnect` / `Socket.connect`. OpenClaw `2026.5.26` and newer classify these as benign transient network errors so they no longer propagate to the top-level uncaught handler; if you are on an older release, upgrade first.
- Long quiet periods that end the instant you connect to the Control UI or SSH into the host: the user-visible activity is what re-arms launchd's respawn gate, not anything the dashboard does to the gateway.
- `runs` count incrementing across the day with no corresponding `received SIG*; shutting down` line in `~/Library/Logs/openclaw/gateway.log`: clean shutdowns log a signal; transient crashes do not.

What to do:

1. **Upgrade the gateway** if you are running a release before `2026.5.26`. After upgrading, future `ENETDOWN` errors are logged as warnings instead of terminating the process.
2. **Reduce maintenance sleep activity** on Mac mini / desktop hosts meant to run as always-on servers:

   ```bash
   sudo pmset -a sleep 0 disksleep 0 standby 0 powernap 0
   ```

   This significantly reduces, but does not entirely eliminate, the underlying driver flap. The system can still perform some maintenance sleeps for TCP keepalive and mDNS upkeep regardless of these flags.

3. **Add a liveness watchdog** so a future crash burst that gets parked by launchd is caught quickly:

   ```bash
   # Example launchd-aware liveness check, suitable for a 5-minute cron or LaunchAgent
   state=$(launchctl print gui/$UID/ai.openclaw.gateway 2>/dev/null | awk -F'= ' '/state =/ {print $2; exit}')
   if [ "$state" != "running" ]; then
     launchctl kickstart -k gui/$UID/ai.openclaw.gateway
   fi
   ```

   The point is to externally re-arm the respawn gate; `KeepAlive=true` alone is not sufficient on macOS after a crash burst.

Related:

- [macOS platform notes](/platforms/macos)
- [Logging](/logging)
- [Doctor](/gateway/doctor)

## macOS launchd supervisor loop with duplicate gateway/node LaunchAgents

Use this when a macOS install keeps restarting every few seconds, `openclaw`
health checks flap between healthy and unavailable, and channel dispatch stalls
even though the service appears to be running.

This was observed on older installs where both `ai.openclaw.gateway` and
`ai.openclaw.node` LaunchAgents were active and each injected
`OPENCLAW_LAUNCHD_LABEL`. In that state OpenClaw can detect launchd
supervision, try to hand restart back to launchd, and fall into a fast
`EADDRINUSE`/respawn loop instead of one stable gateway process.

```bash
for i in 1 2 3 4; do
  ps aux | grep 'openclaw.*index.js' | grep -v grep | awk '{print $2}'
  sleep 10
done

openclaw gateway status --deep
openclaw node status
launchctl print gui/$UID/ai.openclaw.gateway | grep -E 'state|last exit|runs'
tail -n 80 ~/Library/Logs/openclaw/gateway.log
```

Look for:

- More than one gateway PID across the 30-second sample instead of one stable
  process.
- `EADDRINUSE`, `another gateway instance is already listening`, or repeated
  restart/handoff lines in `gateway.log`.
- Both `~/Library/LaunchAgents/ai.openclaw.gateway.plist` and
  `~/Library/LaunchAgents/ai.openclaw.node.plist` loaded at the same time on a
  host that should only run one managed gateway service.

What to do:

1. If this host should only run the Gateway service, remove the managed node
   service through OpenClaw. **Skip this step** if you actively rely on the node
   service for remote node features; uninstalling it stops those features on
   this host:

   ```bash
   openclaw node uninstall
   ```

2. Install a persistent Gateway wrapper that clears the inherited launchd
   markers before starting OpenClaw. Use the supported `--wrapper` option; do
   not edit the generated file under `~/.openclaw/service-env/`, because service
   reinstall, update, and doctor repair regenerate that file:

   ```bash
   mkdir -p ~/.local/bin
   cat >~/.local/bin/openclaw-launchd-workaround <<'EOF'
   #!/bin/sh
   set -eu
   unset OPENCLAW_LAUNCHD_LABEL LAUNCH_JOB_LABEL LAUNCH_JOB_NAME XPC_SERVICE_NAME || true
   exec openclaw "$@"
   EOF
   chmod 700 ~/.local/bin/openclaw-launchd-workaround

   openclaw gateway install \
     --wrapper ~/.local/bin/openclaw-launchd-workaround \
     --force
   ```

   `gateway install` persists the wrapper path across forced reinstalls,
   updates, and doctor repairs.

3. Verify that the Gateway is stable and serving RPC, not merely listening:

   ```bash
   openclaw gateway status --deep --require-rpc

   for i in 1 2 3 4; do
     ps aux | grep 'openclaw.*index.js' | grep -v grep | awk '{print $2}'
     sleep 10
   done
   ```

   The PID sample should show one stable process instead of a rotating set of
   PIDs, and inbound channel dispatch should resume.

4. After upgrading to a release where the underlying dual-LaunchAgent loop is
   fixed, remove the workaround and reinstall the normal managed service:

   ```bash
   OPENCLAW_WRAPPER= openclaw gateway install --force
   rm ~/.local/bin/openclaw-launchd-workaround
   ```

Related:

- [macOS platform notes](/platforms/mac/bundled-gateway)
- [Doctor](/gateway/doctor)
- [Gateway CLI](/cli/gateway)

## Gateway exits during high memory use

Use when the Gateway disappears under load, the supervisor reports an OOM-style restart, or logs mention `critical memory pressure bundle written`.

```bash
openclaw gateway status --deep
openclaw logs --follow
openclaw gateway stability --bundle latest
openclaw gateway diagnostics export
```

Look for:

- `Reason: diagnostic.memory.pressure.critical` in the latest stability bundle.
- `Memory pressure:` with `critical/rss_threshold`, `critical/heap_threshold`, or `critical/rss_growth`.
- `V8 heap:` values near the heap limit.
- `Largest session files:` entries such as `agents/<agent>/sessions/<session>.jsonl` or `sessions/<session>.jsonl`.
- Linux cgroup memory counters when the gateway runs inside a container or memory-limited service.

Common signatures:

- `critical memory pressure bundle written` appears shortly before restart → OpenClaw captured a pre-OOM stability bundle. Inspect it with `openclaw gateway stability --bundle latest`.
- `memory pressure: level=critical` appears in gateway logs → OpenClaw detected critical memory pressure and recorded the available in-process memory facts.
- `Largest session files:` points at a very large redacted transcript path → reduce retained session history, inspect session growth, or move old transcripts out of the active store before restarting.
- `V8 heap:` used bytes are close to the heap limit → lower prompt/session pressure or reduce concurrent work first. For a managed service, inspect `Gateway heap:` in `openclaw gateway status`; if it says `not set`, regenerate old service metadata with `openclaw gateway install --force`. Ambient shell `NODE_OPTIONS` is intentionally ignored. Use an explicit supervisor-level heap override only after confirming the sustained workload and leaving enough native-memory headroom.
- `Memory pressure: critical/rss_growth` → memory grew quickly inside one sampling window. Check the latest logs for a large import, runaway tool output, repeated retries, or a batch of queued agent work.
- Critical memory pressure appears in logs but no bundle exists → capture `openclaw gateway diagnostics export` after the event for the available operational evidence.

The stability bundle is payload-free. It includes operational memory evidence and redacted relative file paths, not message text, webhook bodies, credentials, tokens, cookies, or raw session ids. Attach the diagnostics export to bug reports instead of copying raw logs.

Related:

- [Gateway health](/gateway/health)
- [Diagnostics export](/gateway/diagnostics)
- [Sessions](/cli/sessions)

## Gateway rejected invalid config

Use when Gateway startup fails with `Invalid config` or hot reload logs say it skipped an invalid edit.

```bash
openclaw logs --follow
openclaw config file
openclaw config validate
openclaw doctor
```

Look for:

- `Invalid config at ...`
- `config reload skipped (invalid config): ...`
- `Config write rejected: ...`
- A timestamped `openclaw.json.rejected.*` file beside the active config.
- A timestamped `openclaw.json.clobbered.*` file if `doctor --fix` repaired a broken direct edit.
- OpenClaw keeps the latest 32 `.clobbered.*` files for each config path and rotates older ones.

<AccordionGroup>
  <Accordion title="What happened">
    - The config did not validate during startup, hot reload, or an OpenClaw-owned write.
    - Gateway startup fails closed instead of rewriting `openclaw.json`.
    - Hot reload skips invalid external edits and keeps the current runtime config active.
    - OpenClaw-owned writes reject invalid/destructive payloads before commit and save `.rejected.*`.
    - `openclaw doctor --fix` owns repair. It can remove non-JSON prefixes or restore the last-known-good copy while preserving the rejected payload as `.clobbered.*`.
    - When many repairs happen for one config path, OpenClaw rotates older `.clobbered.*` files so the newest repaired payload is still available.

  </Accordion>
  <Accordion title="Inspect and repair">
    ```bash
    CONFIG="$(openclaw config file)"
    ls -lt "$CONFIG".clobbered.* "$CONFIG".rejected.* 2>/dev/null | head
    diff -u "$CONFIG" "$(ls -t "$CONFIG".clobbered.* 2>/dev/null | head -n 1)"
    openclaw config validate
    openclaw doctor
    ```
  </Accordion>
  <Accordion title="Common signatures">
    - `.clobbered.*` exists → doctor preserved a broken external edit while repairing the active config.
    - `.rejected.*` exists → an OpenClaw-owned config write failed schema or clobber checks before commit.
    - `Config write rejected:` → the write tried to drop required shape, shrink the file sharply, or persist invalid config.
    - `config reload skipped (invalid config):` → a direct edit failed validation and was ignored by the running Gateway.
    - `Invalid config at ...` → startup failed before Gateway services booted.
    - `missing-meta-vs-last-good`, `gateway-mode-missing-vs-last-good`, or `size-drop-vs-last-good:*` → an OpenClaw-owned write was rejected because it lost fields or size compared with the last-known-good backup.
    - `Config last-known-good promotion skipped` → the candidate contained redacted secret placeholders such as `***`.

  </Accordion>
  <Accordion title="Fix options">
    1. Run `openclaw doctor --fix` to let doctor repair prefixed/clobbered config or restore last-known-good.
    2. Copy only the intended keys from `.clobbered.*` or `.rejected.*`, then apply them with `openclaw config set` or `config.patch`.
    3. Run `openclaw config validate` before restarting.
    4. If you edit by hand, keep the full JSON5 config, not just the partial object you wanted to change.
  </Accordion>
</AccordionGroup>

Related:

- [Config](/cli/config)
- [Configuration: hot reload](/gateway/configuration#config-hot-reload)
- [Configuration: strict validation](/gateway/configuration#strict-validation)
- [Doctor](/gateway/doctor)

## Gateway probe warnings

Use when `openclaw gateway probe` reaches something, but still prints a warning block.

```bash
openclaw gateway probe
openclaw gateway probe --json
openclaw gateway probe --ssh user@gateway-host
```

Look for:

- `warnings[].code` and `primaryTargetId` in JSON output.
- Whether the warning is about SSH fallback, multiple gateways, missing scopes, or unresolved auth refs.

Common signatures:

- `SSH tunnel failed to start; falling back to direct probes.` → SSH setup failed, but the command still tried direct configured/loopback targets.
- `multiple reachable gateway identities detected` → distinct gateways answered, or OpenClaw could not prove reachable targets are the same gateway. An SSH tunnel, proxy URL, or configured remote URL to the same gateway is treated as one gateway with multiple transports, even when transport ports differ.
- `Read-probe diagnostics are limited by gateway scopes (missing operator.read)` → connect worked, but detail RPC is scope-limited; pair device identity or use credentials with `operator.read`.
- `Gateway accepted the WebSocket connection, but follow-up read diagnostics failed` → connect worked, but the full diagnostic RPC set timed out or failed. Treat this as a reachable Gateway with degraded diagnostics; compare `connect.ok` and `connect.rpcOk` in `--json` output.
- `Capability: pairing-pending` or `gateway closed (1008): pairing required` → the gateway answered, but this client still needs pairing/approval before normal operator access.
- Unresolved `gateway.auth.*` / `gateway.remote.*` SecretRef warning text → auth material was unavailable in this command path for the failed target.

Related:

- [Gateway](/cli/gateway)
- [Multiple gateways on the same host](/gateway#multiple-gateways-same-host)
- [Remote access](/gateway/remote)

## Channel connected, messages not flowing

If channel state is connected but message flow is dead, focus on policy, permissions, and channel specific delivery rules.

```bash
openclaw channels status --probe
openclaw pairing list --channel <channel> [--account <id>]
openclaw status --deep
openclaw logs --follow
openclaw config get channels
```

Look for:

- DM policy (`pairing`, `allowlist`, `open`, `disabled`).
- Group allowlist and mention requirements.
- Missing channel API permissions/scopes.

Common signatures:

- `mention required` → message ignored by group mention policy.
- `pairing` / pending approval traces → sender is not approved.
- `missing_scope`, `not_in_channel`, `Forbidden`, `401/403` → channel auth/permissions issue.

Related:

- [Channel troubleshooting](/channels/troubleshooting)
- [Discord](/channels/discord)
- [Telegram](/channels/telegram)
- [WhatsApp](/channels/whatsapp)

## Cron and heartbeat delivery

If cron or heartbeat did not run or did not deliver, verify scheduler state first, then delivery target.

```bash
openclaw cron status
openclaw cron list
openclaw cron runs --id <jobId> --limit 20
openclaw system heartbeat last
openclaw logs --follow
```

Look for:

- Cron enabled and next wake present.
- Job run history status (`ok`, `skipped`, `error`).
- Heartbeat skip reasons (`quiet-hours`, `requests-in-flight`, `cron-in-progress`, `lanes-busy`, `alerts-disabled`, `empty-heartbeat-file`, `no-tasks-due`).

<AccordionGroup>
  <Accordion title="Common signatures">
    - `cron: scheduler disabled; jobs will not run automatically` → cron disabled.
    - `cron: timer tick failed` → scheduler tick failed; check file/log/runtime errors.
    - `heartbeat skipped` with `reason=quiet-hours` → outside active hours window.
    - `heartbeat skipped` with `reason=empty-heartbeat-file` → `HEARTBEAT.md` exists but only contains blank, comment, header, fence, or empty-checklist scaffolding, so OpenClaw skips the model call.
    - `heartbeat skipped` with `reason=no-tasks-due` → `HEARTBEAT.md` contains a `tasks:` block, but none of the tasks are due on this tick.
    - `heartbeat: unknown accountId` → invalid account id for heartbeat delivery target.
    - `heartbeat skipped` with `reason=dm-blocked` → heartbeat target resolved to a DM-style destination while `agents.defaults.heartbeat.directPolicy` (or per-agent override) is set to `block`.

  </Accordion>
</AccordionGroup>

Related:

- [Heartbeat](/gateway/heartbeat)
- [Scheduled tasks](/automation/cron-jobs)
- [Scheduled tasks: troubleshooting](/automation/cron-jobs#troubleshooting)

## Node paired, tool fails

If a node is paired but tools fail, isolate foreground, permission, and approval state.

```bash
openclaw nodes status
openclaw nodes describe --node <idOrNameOrIp>
openclaw approvals get --node <idOrNameOrIp>
openclaw logs --follow
openclaw status
```

Look for:

- Node online with expected capabilities.
- OS permission grants for camera/mic/location/screen.
- Exec approvals and allowlist state.

Common signatures:

- `NODE_BACKGROUND_UNAVAILABLE` → node app must be in foreground.
- `*_PERMISSION_REQUIRED` / `LOCATION_PERMISSION_REQUIRED` → missing OS permission.
- `SYSTEM_RUN_DENIED: approval required` → exec approval pending.
- `SYSTEM_RUN_DENIED: allowlist miss` → command blocked by allowlist.

Related:

- [Exec approvals](/tools/exec-approvals)
- [Node troubleshooting](/nodes/troubleshooting)
- [Nodes](/nodes/index)

## Browser tool fails

Use when browser tool actions fail even though the gateway itself is healthy.

```bash
openclaw browser status
openclaw browser start --browser-profile openclaw
openclaw browser profiles
openclaw logs --follow
openclaw doctor
```

Look for:

- Whether `plugins.allow` is set and includes `browser`.
- Valid browser executable path.
- CDP profile reachability.
- Local Chrome availability for `existing-session` / `user` profiles.

<AccordionGroup>
  <Accordion title="Plugin / executable signatures">
    - `unknown command "browser"` or `unknown command 'browser'` → the bundled browser plugin is excluded by `plugins.allow`.
    - Browser tool missing / unavailable while `browser.enabled=true` → `plugins.allow` excludes `browser`, so the plugin never loaded.
    - `Failed to start Chrome CDP on port` → browser process failed to launch.
    - `browser.executablePath not found` → configured path is invalid.
    - `browser.cdpUrl must be http(s) or ws(s)` → the configured CDP URL uses an unsupported scheme such as `file:` or `ftp:`.
    - `browser.cdpUrl has invalid port` → the configured CDP URL has a bad or out-of-range port.
    - `Playwright is not available in this gateway build; '<feature>' is unsupported.` → the current gateway install lacks the core browser runtime dependency; reinstall or update OpenClaw, then restart the gateway. ARIA snapshots and basic page screenshots can still work, but navigation, AI snapshots, CSS-selector element screenshots, and PDF export stay unavailable.

  </Accordion>
  <Accordion title="Chrome MCP / existing-session signatures">
    - `Could not find DevToolsActivePort for chrome` → Chrome MCP existing-session could not attach to the selected browser data dir yet. Open the browser inspect page, enable remote debugging, keep the browser open, approve the first attach prompt, then retry. If signed-in state is not required, prefer the managed `openclaw` profile.
    - `No browser tabs found for profile="user"` → the Chrome MCP attach profile has no open local Chrome tabs.
    - `Remote CDP for profile "<name>" is not reachable` → the configured remote CDP endpoint is not reachable from the gateway host.
    - `Browser attachOnly is enabled ... not reachable` or `Browser attachOnly is enabled and CDP websocket ... is not reachable` → attach-only profile has no reachable target, or the HTTP endpoint answered but the CDP WebSocket still could not be opened.

  </Accordion>
  <Accordion title="Element / screenshot / upload signatures">
    - `fullPage is not supported for element screenshots` → screenshot request mixed `--full-page` with `--ref` or `--element`.
    - `element screenshots are not supported for existing-session profiles; use ref from snapshot.` → Chrome MCP / `existing-session` screenshot calls must use page capture or a snapshot `--ref`, not CSS `--element`.
    - `existing-session file uploads do not support element selectors; use ref/inputRef.` → Chrome MCP upload hooks need snapshot refs, not CSS selectors.
    - `existing-session file uploads currently support one file at a time.` → send one upload per call on Chrome MCP profiles.
    - `existing-session dialog handling does not support timeoutMs.` → dialog hooks on Chrome MCP profiles do not support timeout overrides.
    - `existing-session type does not support timeoutMs overrides.` → omit `timeoutMs` for `act:type` on `profile="user"` / Chrome MCP existing-session profiles, or use a managed/CDP browser profile when a custom timeout is required.
    - `response body is not supported for existing-session profiles yet.` → `responsebody` still requires a managed browser or raw CDP profile.
    - Stale viewport / dark-mode / locale / offline overrides on attach-only or remote CDP profiles → run `openclaw browser stop --browser-profile <name>` to close the active control session and release Playwright/CDP emulation state without restarting the whole gateway.

  </Accordion>
</AccordionGroup>

Related:

- [Browser (OpenClaw-managed)](/tools/browser)
- [Browser troubleshooting](/tools/browser-linux-troubleshooting)

## If you upgraded and something suddenly broke

Most post-upgrade breakage is config drift or stricter defaults now being enforced.

<AccordionGroup>
  <Accordion title="1. Auth and URL override behavior changed">
    ```bash
    openclaw gateway status
    openclaw config get gateway.mode
    openclaw config get gateway.remote.url
    openclaw config get gateway.auth.mode
    ```

    What to check:

    - If `gateway.mode=remote`, CLI calls may be targeting remote while your local service is fine.
    - Explicit `--url` calls do not fall back to stored credentials.

    Common signatures:

    - `gateway connect failed:` → wrong URL target.
    - `unauthorized` → endpoint reachable but wrong auth.

  </Accordion>
  <Accordion title="2. Bind and auth guardrails are stricter">
    ```bash
    openclaw config get gateway.bind
    openclaw config get gateway.auth.mode
    openclaw config get gateway.auth.token
    openclaw gateway status
    openclaw logs --follow
    ```

    What to check:

    - Non-loopback binds (`lan`, `tailnet`, `custom`) need a valid gateway auth path: shared token/password auth, or a correctly configured non-loopback `trusted-proxy` deployment.
    - Old keys like `gateway.token` do not replace `gateway.auth.token`.

    Common signatures:

    - `refusing to bind gateway ... without auth` → non-loopback bind without a valid gateway auth path.
    - `Connectivity probe: failed` while runtime is running → gateway alive but inaccessible with current auth/url.

  </Accordion>
  <Accordion title="3. Pairing and device identity state changed">
    ```bash
    openclaw devices list
    openclaw pairing list --channel <channel> [--account <id>]
    openclaw logs --follow
    openclaw doctor
    ```

    What to check:

    - Pending device approvals for dashboard/nodes.
    - Pending DM pairing approvals after policy or identity changes.

    Common signatures:

    - `device identity required` → device auth not satisfied.
    - `pairing required` → sender/device must be approved.

  </Accordion>
</AccordionGroup>

If the service config and runtime still disagree after checks, reinstall service metadata from the same profile/state directory:

```bash
openclaw gateway install --force
openclaw gateway restart
```

Related:

- [Authentication](/gateway/authentication)
- [Background exec and process tool](/gateway/background-process)
- [Node pairing](/gateway/pairing)

## Related

- [Doctor](/gateway/doctor)
- [FAQ](/help/faq)
- [Gateway runbook](/gateway)
