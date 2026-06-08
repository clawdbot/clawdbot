---
version: 3
---

# Gateway Runtime WebSocket Feature Matrix - Gateway lifecycle

## Summary

Runtime lifecycle and supervision is implemented across foreground `openclaw gateway` startup, supervised service install/start/stop/restart/status paths, platform service adapters, config reload planning, safe restart, and multiple-gateway isolation. Coverage is **Yes** because the repo has real Gateway/server flow proof for direct server startup, two concurrent gateway instances, daemon install integration, and macOS launchd lifecycle. The remaining weakness is uneven platform proof: Linux systemd and Windows Scheduled Task flows have strong mocked/unit coverage but not equivalent live supervised E2E coverage, and reload modes are covered mostly at handler/reloader level rather than by a full live Gateway edit/restart scenario.

## Features

- Foreground startup: Local foreground startup via `openclaw gateway`.
- Service installation: Supervised lifecycle installation on macOS, Linux user/systemd, and native Windows task scheduling.
- Restart and stop: Correct `restart` and `stop` behavior for supervised installs.
- Service status: Status behavior for supervised installs.
- Bind and port settings: Bind and port precedence across CLI flags, env vars, config, and persisted supervisor metadata.
- Config reload: Config reload modes: `off`, `hot`, `restart`, and `hybrid`.
- Multi-gateway isolation: Multiple-gateway isolation on one host, including config/state/workspace separation.

## Archive freshness

- `gitcrawl doctor --json`: `last_sync_at=2026-05-28T19:09:52.784704Z`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `api_supported=false`, `github_token_present=false`, `repository_count=2`.
- `discrawl status --json`: `generated_at=2026-05-30T00:04:12Z`, `state=current`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `share.needs_update=true`.

## Coverage

Score: **86**

Label: **Yes**

Positive signals:

- Foreground gateway startup is documented and implemented with explicit `--port`, `--bind`, `--token`, `--auth`, `--tailscale`, `--force`, and logging options in `docs/gateway/index.md:25`, `docs/gateway/index.md:40`, `src/cli/gateway-cli/run-command.ts:10`, and `src/cli/gateway-cli/run.ts:472`.
- Bind and port precedence are documented in `docs/gateway/index.md:111` and implemented by `resolveGatewayPort`, which checks `OPENCLAW_GATEWAY_PORT`, config, then default port in `src/config/paths.ts:262`.
- Supervised lifecycle is implemented through platform dispatch for macOS LaunchAgent, Linux user systemd, and Windows Scheduled Task in `src/daemon/service.ts:250`, with CLI lifecycle commands wired in `src/cli/daemon-cli/register-service-commands.ts:56`.
- Restart, stop, status, safe restart deferral, and not-loaded recovery have central lifecycle logic in `src/cli/daemon-cli/lifecycle-core.ts:374`, `src/cli/daemon-cli/lifecycle-core.ts:464`, `src/cli/daemon-cli/lifecycle.ts:151`, and `src/cli/daemon-cli/lifecycle.ts:275`.
- Config reload modes are documented in `docs/gateway/index.md:126` and `docs/gateway/configuration.md:550`, and implemented by the managed reloader in `src/gateway/server.impl.ts:1653`, `src/gateway/config-reload.ts:246`, and restart-required handlers in `src/gateway/server-reload-handlers.ts:518`.
- Multiple-gateway isolation is documented with separate ports, config, state, and workspaces in `docs/gateway/index.md:152`, backed by config/state overrides in `src/config/paths.ts:60`, `src/config/paths.ts:154`, and `src/config/paths.ts:193`.
- Real Gateway/server flow evidence exists: `test/gateway.multi.e2e.test.ts:27` starts two gateway instances and validates per-instance HTTP hooks and WebSocket node pairing; `src/gateway/server-network-runtime.e2e.test.ts:68` starts a real server with temp config/state and validates request behavior; `src/daemon/launchd.integration.e2e.test.ts:177` installs/restarts/stops/starts a real macOS LaunchAgent.

Negative signals:

- Linux systemd and Windows Scheduled Task supervision are represented mostly by unit/mocked tests, not by live service-manager E2E evidence matching launchd depth.
- Reload modes have strong unit and handler coverage, but no full integration proof found for editing config through a real Gateway and observing `off`, `hot`, `restart`, and `hybrid` behavior end to end.
- Archive evidence still shows operator-facing lifecycle pain around LaunchAgent self-update handoff, systemd update/restart behavior, Windows restart/stop hangs, stale hook relay recovery, and hot reload ambiguity.

Integration gaps:

- No equivalent live Linux `systemd --user` install/start/stop/restart/status E2E was found.
- No equivalent live Windows Scheduled Task install/start/stop/restart/status E2E was found.
- No full live reload-mode matrix test was found for direct config edits plus Gateway restart/hot-apply behavior.

## Quality

Score: **82**

Label: **High**

### gitcrawl reports

- Open issue query `gitcrawl search issues "gateway restart lifecycle supervision" -R openclaw/openclaw --state open --json number,title,url,state --limit 10` returned 1 hit: #74363, "Subagent runs can be falsely marked failed/lost after clean gateway close or pending wait".
- Open issue query `gitcrawl search issues "gateway service launchd systemd schtasks install restart stop status" -R openclaw/openclaw --state open --json number,title,url,state --limit 10` returned 0 hits.
- Open issue query `gitcrawl search issues "gateway config reload hot restart hybrid" -R openclaw/openclaw --state open --json number,title,url,state --limit 10` returned 1 hit: #43803, "[BUG] config.patch still sends SIGUSR1 for hot-reloadable paths (browser.profiles.\*), bypassing reload mode".
- Open issue query `gitcrawl search issues "multiple gateways port config state workspace isolation" -R openclaw/openclaw --state open --json number,title,url,state --limit 10` returned 2 hits: #71216, "Config schema: add `sandbox`, `routing.rules`, `instances`, and `gateway.nodes.denyPaths`"; #64555, "[Bug]: WhatsApp credentials leak across `--profile` boundaries".
- Closed issue query `gitcrawl search issues "gateway launchd restart handoff not loaded restart stop status" -R openclaw/openclaw --state closed --json number,title,url,state --limit 10` returned #81894 and #85120 for macOS LaunchAgent self-update/restart failures.
- Closed issue query `gitcrawl search issues "gateway systemd service restart user unit linger XDG_RUNTIME_DIR" -R openclaw/openclaw --state closed --json number,title,url,state --limit 10` returned #40275, #44417, #65184, #32635, and #36495 for systemd status/install/restart/detection regressions.
- Closed issue query `gitcrawl search issues "gateway schtasks Windows scheduled task restart stop port" -R openclaw/openclaw --state closed --json number,title,url,state --limit 10` returned #69970, #52049, #72279, #52044, and #41047 for Windows scheduled-task stop/restart/control issues.
- Closed issue query `gitcrawl search issues "gateway port precedence OPENCLAW_GATEWAY_PORT --port gateway.port service args" -R openclaw/openclaw --state closed --json number,title,url,state --limit 10` returned 0 hits.

### discrawl reports

- Query `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 10 "gateway restart"` returned current maintainer/user discussion about stale native hook relay recovery requiring fresh sessions or Gateway/Codex app-server restart, plus low-spec VPS timeout and gateway slowness reports.
- Query `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 10 "gateway service launchd"` returned maintainer/clawtributor reports about v2026.5.12 self-update leaving macOS LaunchAgent installed but not loaded, stale update launchd jobs killing gateways, and PR discussion around `gateway stop` bootout behavior.
- Query `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 10 "gateway systemd"` returned reports about beta gateway unresponsive loops on systemd, `openclaw update` stopping a managed service during global install swap, systemd token handling, systemd user-unit restart plans, and memory drops after clean gateway restart.
- Query `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 10 "gateway hot reload"` returned reports that Discord/config changes can hot reload, but also maintainer guidance that some settings require next restart/reload and release-readout pain around gateway hot reload, CPU, liveness, and runtime-deps/plugin reload fallout.
- Query `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 10 "multiple gateways"` returned multiple-gateway docs sharing, rescue-agent discussion, cluster/topology questions, reports of running multiple gateways on one host, and archived GitHub commentary about state-dir/profile isolation expectations.

### Good qualities

- Lifecycle responsibilities are centralized: service-manager operations go through `src/daemon/service.ts:250`, lifecycle policy through `src/cli/daemon-cli/lifecycle-core.ts:374`, and command UX through `src/cli/daemon-cli/register-service-commands.ts:56`.
- Port and bind behavior has one config helper and service-command metadata fallback, reducing ambiguity between foreground and supervised starts (`src/config/paths.ts:262`, `src/cli/daemon-cli/lifecycle.ts:68`, `src/cli/daemon-cli/status.gather.ts:389`).
- Restart handling is cautious: safe restart supports RPC deferral, active-run draining, force intent after timeout, and stale PID/listener cleanup (`src/cli/daemon-cli/lifecycle.ts:151`, `src/cli/gateway-cli/run-loop.ts:560`).
- Config reload fails closed on invalid direct edits and separates hot-applicable changes from restart-required changes (`src/gateway/config-reload.ts:246`, `src/gateway/config-reload.ts:330`, `docs/gateway/configuration.md:547`).
- Platform-specific service behavior is separated into launchd, systemd, and schtasks adapters, keeping OS command construction, status parsing, and recovery behavior local to each runtime boundary.

### Bad qualities

- Cross-platform operator behavior is uneven because launchd, systemd, and schtasks expose different failure modes and recovery paths, which makes status and restart outcomes harder to reason about across operating systems.
- The archive shows repeated historical regressions in exactly this family: systemd install/status detection, Windows stop/restart hangs or duplicate processes, and LaunchAgent update handoff failures.
- Reload behavior remains subtle enough that both GitHub and Discord show confusion or bugs around when hot reload applies versus when restart is required.
- Multiple-gateway isolation is documented and implemented around per-process paths, ports, and workspaces, but profile/credential boundary reports and first-class `instances` requests show users expect stronger topology and config affordances.

## Known gaps

- Implemented capability context: local foreground startup, platform service abstractions, lifecycle commands, safe restart, port/bind precedence, reload modes, multiple-gateway isolation, and Gateway docs/troubleshooting coverage are all present in the cited docs and source.
- GitHub #71216 requests config schema additions including `instances`, suggesting demand for more first-class multi-gateway/multi-instance configuration.
- GitHub #64555 reports credential leakage across `--profile` boundaries, adjacent to the multiple-gateway isolation contract.
- Discord `multiple gateways` searches show users asking about rescue agents, multiple nodes/gateways, SSH tunneling to more than one gateway, and whether multiple gateways are necessary.
- Discord lifecycle searches show maintainers/users needing clearer recovery for stale hook relays, LaunchAgent self-update handoff, systemd update/restart, and hot reload/restart expectations.
- No direct source/docs mismatch was found for the cited foreground startup, service lifecycle, reload modes, or multiple-gateway setup; the `instances` request is an expectation gap rather than a documented-but-missing behavior in current Gateway docs.

## Evidence

### Docs

- `docs/gateway/index.md:25`: foreground local startup examples for `openclaw gateway --port 18789`, `--verbose`, and `--force`.
- `docs/gateway/index.md:65`: config reload watches the active config path and defaults to `gateway.reload.mode="hybrid"`.
- `docs/gateway/index.md:71`: runtime model: one always-on process, multiplexed port, loopback default, auth required by default.
- `docs/gateway/index.md:111`: port/bind precedence and supervisor metadata behavior.
- `docs/gateway/index.md:126`: reload mode table for `off`, `hot`, `restart`, and `hybrid`.
- `docs/gateway/index.md:152`: multiple gateways on one host require isolated port, config, state, and workspace.
- `docs/gateway/configuration.md:534`: Gateway watches direct config edits and rejects invalid/destructive changes.
- `docs/gateway/configuration.md:550`: reload modes and hot-applicable versus restart-required config behavior.
- `docs/cli/gateway.md:112`: restart variants including safe restart, skip deferral, and force.
- `docs/cli/gateway.md:267`: `gateway status`, `--probe`, and `--deep` semantics for launchd/systemd/schtasks scans.
- `docs/cli/gateway.md:496`: service install/start/stop/restart behavior and token/SecretRef handling.
- `docs/cli/daemon.md:13`: legacy daemon commands map to gateway service commands across launchd, systemd, and schtasks.
- `docs/gateway/troubleshooting.md:424`: status/deep troubleshooting for stopped runtime, config mismatch, port conflicts, extra services, and stale metadata.
- `docs/gateway/troubleshooting.md:547`: invalid direct config edits keep the active runtime config instead of partially applying.

### Source

- `src/cli/gateway-cli/run-command.ts:10`: command options for local foreground gateway startup.
- `src/cli/gateway-cli/run.ts:472`: config loading, port parsing, and effective port selection.
- `src/cli/gateway-cli/run.ts:575`: bind validation and service-mode stale PID cleanup.
- `src/cli/gateway-cli/run.ts:597`: `--force` kills existing listeners and waits for port bindability.
- `src/config/paths.ts:60`: `OPENCLAW_STATE_DIR` override.
- `src/config/paths.ts:154`: `OPENCLAW_CONFIG_PATH` config override.
- `src/config/paths.ts:262`: gateway port resolution from env, config, then default.
- `src/daemon/service.ts:250`: macOS launchd, Linux systemd, and Windows schtasks service registry.
- `src/cli/daemon-cli/register-service-commands.ts:56`: service lifecycle command registration.
- `src/cli/daemon-cli/install.ts:86`: install resolves gateway port and blocks future-version configs.
- `src/cli/daemon-cli/install.ts:220`: service plan creation and install.
- `src/cli/daemon-cli/lifecycle.ts:68`: lifecycle port resolution from service command args, env, and config.
- `src/cli/daemon-cli/lifecycle.ts:151`: safe restart RPC and deferral handling.
- `src/cli/daemon-cli/lifecycle.ts:253`: stop fallback for unmanaged gateway process.
- `src/cli/daemon-cli/lifecycle.ts:275`: restart validation, recovery, force/wait handling, and health checks.
- `src/cli/daemon-cli/lifecycle-core.ts:374`: core stop behavior.
- `src/cli/daemon-cli/lifecycle-core.ts:464`: core restart behavior.
- `src/cli/daemon-cli/status.gather.ts:389`: status port/probe resolution from service metadata and config.
- `src/gateway/server.impl.ts:1653`: managed config reloader starts after server ready.
- `src/gateway/config-reload.ts:86`: managed config reloader state and debounce handling.
- `src/gateway/config-reload.ts:246`: reload mode decision logic.
- `src/gateway/config-reload.ts:330`: pending snapshot apply/promote path and invalid snapshot handling.
- `src/gateway/server-reload-handlers.ts:518`: restart-required config changes emit restart intent with active-work deferral.
- `src/gateway/server-reload-handlers.ts:605`: managed reload handlers are wired only for full gateway state.
- `src/cli/gateway-cli/run-loop.ts:99`: gateway run loop primes lifecycle runtime and handles startup/restart.
- `src/cli/gateway-cli/run-loop.ts:560`: restart drain waits for active tasks/runs or force-aborts on timeout.

### Integration tests

- `test/gateway.multi.e2e.test.ts:27`: starts two gateway instances and validates per-instance HTTP hook delivery plus WebSocket node pairing.
- `src/gateway/server-network-runtime.e2e.test.ts:68`: starts a real Gateway server with temp config/state and validates direct request behavior.
- `src/cli/daemon-cli/install.integration.test.ts:39`: daemon install integration harness with temp home/state/config.
- `src/cli/daemon-cli/install.integration.test.ts:76`: install fails closed when required token SecretRef is unresolved.
- `src/cli/daemon-cli/install.integration.test.ts:110`: install refuses future-version config writes.
- `src/cli/daemon-cli/install.integration.test.ts:136`: install auto-mints token and does not embed it into service env.
- `src/daemon/launchd.integration.e2e.test.ts:177`: real launchd service install/restart/KeepAlive/stop/start/restart proof on Darwin.

### Unit tests

- `src/gateway/config-reload.test.ts:507`: default reload settings are hybrid with 300 ms debounce.
- `src/gateway/config-reload.test.ts:688`: reloader retries missing snapshots and reloads when the file reappears.
- `src/gateway/config-reload.test.ts:934`: rejected hot reload does not promote external config edits.
- `src/gateway/server-reload-handlers.test.ts:635`: restart-required `gateway.port` changes defer while work is active.
- `src/gateway/server-reload-handlers.test.ts:722`: default restart deferral timeout is 300 seconds.
- `src/cli/gateway-cli/run-loop.test.ts:592`: restart timeout intent skips a second drain and aborts active runs.
- `src/daemon/systemd.test.ts:153`: systemd availability and bus-repair/fallback behavior.
- `src/daemon/systemd.test.ts:607`: profile-specific and custom systemd unit path behavior.
- `src/daemon/systemd.test.ts:780`: systemd `EnvironmentFile` parsing and source tracking.
- `src/daemon/schtasks.install.test.ts:85`: Windows Scheduled Task install quotes/escapes command args/env and reads them back.
- `src/daemon/schtasks.install.test.ts:169`: Windows Scheduled Task install rejects line breaks in command args/env/descriptions.
- `src/daemon/schtasks.test.ts:75`: Windows Scheduled Task status parsing for running/stopped/unknown.
- `src/daemon/schtasks.test.ts:140`: Windows task script path selection for default/profile/custom state.
- `src/daemon/schtasks.stop.test.ts:110`: Windows stop cleanup kills lingering gateway listeners and handles force kill.
- `src/cli/daemon-cli/status.gather.test.ts:428`: deep status reuses service command environment and surfaces recent restart handoffs.

### gitcrawl queries

- `gitcrawl search issues "gateway restart lifecycle supervision" -R openclaw/openclaw --state open --json number,title,url,state --limit 10`
  - Result: `[{"number":74363,"state":"open","title":"Subagent runs can be falsely marked failed/lost after clean gateway close or pending wait","url":"https://github.com/openclaw/openclaw/issues/74363"}]`
- `gitcrawl search issues "gateway service launchd systemd schtasks install restart stop status" -R openclaw/openclaw --state open --json number,title,url,state --limit 10`
  - Result: `[]`
- `gitcrawl search issues "gateway config reload hot restart hybrid" -R openclaw/openclaw --state open --json number,title,url,state --limit 10`
  - Result: `[{"number":43803,"state":"open","title":"[BUG] config.patch still sends SIGUSR1 for hot-reloadable paths (browser.profiles.*), bypassing reload mode","url":"https://github.com/openclaw/openclaw/issues/43803"}]`
- `gitcrawl search issues "multiple gateways port config state workspace isolation" -R openclaw/openclaw --state open --json number,title,url,state --limit 10`
  - Result: #71216 open issue "Config schema: add `sandbox`, `routing.rules`, `instances`, and `gateway.nodes.denyPaths`"; #64555 open issue "[Bug]: WhatsApp credentials leak across `--profile` boundaries".
- `gitcrawl search issues "gateway launchd restart handoff not loaded restart stop status" -R openclaw/openclaw --state closed --json number,title,url,state --limit 10`
  - Result: #81894 closed issue "v2026.5.12 agent-invoked self-update can leave macOS LaunchAgent unloaded or fail before package swap"; #85120 closed issue "[Bug]: in-band `openclaw update` on macOS LaunchAgent can stop the gateway supervising it".
- `gitcrawl search issues "gateway systemd service restart user unit linger XDG_RUNTIME_DIR" -R openclaw/openclaw --state closed --json number,title,url,state --limit 10`
  - Result: #40275 closed issue "[Bug]: openclaw gateway restart fails while user systemd service works via systemctl --user (service shown as disabled/stopped inconsistently)"; #44417 closed issue "Bug: systemctl --user detection fails and hangs during `sudo -u` due to SUDO_USER fallback"; #65184 closed issue "[Bug]: openclaw gateway install may fail with \"Unit file openclaw-gateway.service does not exist\" on migrated root + systemd --user installs"; #32635 closed issue "Bug: gateway install fails on fresh Linux servers - execFileUtf8 clobbers systemctl stdout"; #36495 closed issue "[Bug] Gateway install regression in 2026.3.2: `is-enabled` exit code `not-found` treated as \"systemctl unavailable\"".
- `gitcrawl search issues "gateway schtasks Windows scheduled task restart stop port" -R openclaw/openclaw --state closed --json number,title,url,state --limit 10`
  - Result: #69970 closed issue "[Bug]: Windows auto-update restart script hangs indefinitely on `schtasks /End`, leaves zombie cmd.exe and flashing Terminal window"; #52049 closed issue "Bug: gateway stop doesn't terminate node.exe process on Windows"; #72279 closed issue "[Bug] [Windows] openclaw update still hangs with stuck findstr on 2026.4.24 - prior fixes (#57682, #44693, #27802, #41804) are incomplete"; #52044 closed issue "Bug: gateway restart spawns duplicate processes on Windows (3 windows)"; #41047 closed issue "[Bug]: OpenClaw Dashboard Control UI fails to send gateway token (token_missing) while gateway/runtime remain healthy".
- `gitcrawl search issues "gateway port precedence OPENCLAW_GATEWAY_PORT --port gateway.port service args" -R openclaw/openclaw --state closed --json number,title,url,state --limit 10`
  - Result: `[]`

### discrawl queries

- `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 10 "gateway restart"`
  - Result hits:
    - `[maintainers] Molty, 2026-05-27T21:43:06Z`: docs update said `/new` workaround is insufficient if `Native hook relay unavailable` returns; restart Codex app-server/OpenClaw Gateway.
    - `[users-helping-users] Rabid Neon, 2026-05-27T20:23:52Z`: recurring `Native hook relay unavailable` after restart; suspected stale gateway/native pairing.
    - `[maintainers] 2026-05-27T18:13:58Z`: `Native hook relay unavailable` means stale retained hook config; recovery is fresh session or restart OpenClaw Gateway/Codex app-server.
    - `[maintainers] 2026-05-27T17:56:24Z`: same stale hook relay class; desired fix is stable per-session relay IDs and re-registration on resume.
    - `[general] COOL, 2026-05-27T11:12:05Z`: gateway marginally slower, not only a simple gateway restart.
    - `[general] Peetiegonzalez, 2026-05-27T00:32:13Z`: intermittent Codex timeout blocker on low-spec VPS.
- `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 10 "gateway service launchd"`
  - Result hits:
    - `[clawtributors] BK, 2026-05-14T19:07:43Z`: v2026.5.12 self-update across three macOS LaunchAgent instances left one updated package with LaunchAgent installed/not loaded and one still beta.8; workaround used SSH plus `gateway status --deep` and restart.
    - `[clawtributors] BK, 2026-05-14T16:46:42Z`: stale `ai.openclaw.update.beta8` launchd job repeatedly killed gateway; status/doctor did not notice sibling updater job.
    - `[clawtributors] Rizz, 2026-05-06T18:40:22Z`: PR #78412 fixes `gateway stop` bootout default and unnecessary kickstart.
    - `[maintainers] Vincent K, 2026-04-30T09:28:42Z`: asked whether the feature would need its own launchd agent.
    - `[general] Yis, 2026-04-27T16:23:22Z`: upgrade cache reset involved `gateway stop` and launchd behavior.
- `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 10 "gateway systemd"`
  - Result hits:
    - `[clawtributors] Schwi, 2026-05-24T22:54:20Z`: 2026.5.24-beta.1 gateway unresponsive loop on systemd; systemd performance config changed behavior.
    - `[clawtributors] Schwi, 2026-05-24T19:39:55Z`: `openclaw update` stopped the managed gateway service, failed global install swap, then restarted systemd service.
    - `[clawtributors] samzong, 2026-05-20T05:26:17Z`: PR #84408 moved node systemd gateway token out of unit files into a mode-600 env file.
    - `[clawtributors] JeffJHunter, 2026-05-18T20:31:23Z`: update plan discussed systemd user unit stop/restart behavior.
    - `[maintainers] brokemac79, 2026-05-18T20:18:53Z`: clean gateway restart dropped RSS significantly.
    - `[ct-helping] Julian Engel, 2026-05-09T07:01:24Z`: systemd issue for krill user; gateway worked but `gateway start` failed.
    - `[maintainers] 2026-05-05T20:07:35Z`: pressing issue listed gateway token in Linux node daemon units.
- `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 10 "gateway hot reload"`
  - Result hits:
    - `[general] Pinched-Nerve, 2026-05-23T18:06:43Z`: logs showed Discord config change detected, channel restarted, and `config hot reload applied`.
    - `[maintainers] 2026-05-17T02:45:08Z`: maintainer changed live config but noted effect may wait for restart/reload if not hot-reloaded.
    - `[general] 0xCyda, 2026-05-02T02:27:35Z`: gateway hot-reloads messages config; restart only if file watching/reload is disabled.
    - `[maintainers] 2026-05-01T16:15:25Z`: maintainer did not restart gateway and noted non-hot settings would apply at next restart/reload.
    - `[maintainers] Molty, 2026-05-01T00:12:06Z`: release readout listed gateway hot/CPU/liveness/event-loop delay and runtime-deps/plugin reload/install-loop fallout.
- `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 10 "multiple gateways"`
  - Result hits:
    - `[general] BK, 2026-05-15T00:37:18Z`: "Setup your rescue agent" with docs link `https://docs.openclaw.ai/gateway/multiple-gateways`.
    - `[users-helping-users] manjax, 2026-05-13T14:31:12Z`: described one gateway with multiple nodes and asked about Kubernetes multiple-gateway flexibility.
    - `[general] Hikaru, 2026-05-10T06:50:18Z`: asked why multiple gateways are needed.
    - `[general] K, 2026-05-01T01:02:06Z`: running multiple gateways on one host; asked whether one SSH tunnel to two gateways caused dropped connections.
    - `[shell-society] disciplined, 2026-04-30T17:04:18Z`: shared multiple-gateway docs link.
    - `[users-helping-users] Miky_The_Great, 2026-04-26T16:00:12Z`: wanted multiple agents/subagents; solution involved two gateways and a separate Telegram bot, which the user wanted to avoid.
