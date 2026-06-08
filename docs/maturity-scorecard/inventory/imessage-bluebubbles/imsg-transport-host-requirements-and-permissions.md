---
title: "iMessage / BlueBubbles - imsg Transport, Host Requirements, and Permissions Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# iMessage / BlueBubbles - imsg Transport, Host Requirements, and Permissions Maturity Note

## Summary

The transport and host-requirements component is Beta. The supported runtime is
clear: OpenClaw spawns `imsg rpc` over stdio on a signed-in macOS Messages host
or through a transparent SSH wrapper. Documentation and source cover the main
operator controls, but the component is capped by live macOS state: Full Disk
Access, Automation, SIP/private API bridge status, remote wrapper behavior, and
`watch.subscribe` readiness can still fail outside repository-controlled tests.

## Category Scope

This note covers local and remote `imsg rpc`, `cliPath`, `dbPath`,
`remoteHost`, Full Disk Access, Automation, private API bridge probing, RPC
capability detection, and status/probe behavior. Out of scope: DM/group policy,
message actions after the bridge is available, and BlueBubbles config
translation.

## Features

- Run local imsg: Covers Run local imsg across local and remote `imsg rpc`, `cliPath`, `dbPath`, `remoteHost`, and related imsg transport, host requirements, and permissions behavior.
- Run through SSH wrapper: Covers Run through SSH wrapper across local and remote `imsg rpc`, `cliPath`, `dbPath`, `remoteHost`, and related imsg transport, host requirements, and permissions behavior.
- Grant macOS permissions: Covers Grant macOS permissions across local and remote `imsg rpc`, `cliPath`, `dbPath`, `remoteHost`, and related imsg transport, host requirements, and permissions behavior.
- Probe runtime health: Covers Probe runtime health across local and remote `imsg rpc`, `cliPath`, `dbPath`, `remoteHost`, and related imsg transport, host requirements, and permissions behavior.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (72%)`
- Positive signals:
  - The docs specify the host contract, SSH wrapper shape, permission model,
    private API bridge, and status probe flow.
  - Source has a dedicated RPC client, private API probe, account-scoped status
    probe, non-mac default guard, and clearer Full Disk Access error promotion.
  - Unit coverage exercises status/probe behavior, configured `cliPath` and
    `dbPath`, bridge method support, and `watch.subscribe` startup retry.
  - Gateway status tests exercise plugin-owned `channels.status` probe dispatch.
- Negative signals:
  - No live macOS/imsg test lane was found that proves an actual Messages host,
    TCC permissions, Automation, SSH wrapper, and private API probe together.
  - Field evidence includes open/recent `imsg rpc` timeout and permission
    failures.
  - Remote wrapper correctness is documented and guarded, but not exhaustively
    proven across shell buffering, launchd, SSH identity, and Mac sleep states.
- Integration gaps:
  - Add a gated live Mac lane that runs `imsg rpc --help`, `imsg status --json`,
    `openclaw channels status --probe`, basic send, and `watch.subscribe`.
  - Add remote SSH-wrapper proof with `remoteHost` attachment fetch and no local
    default `chat.db` fallback.

## Quality Score

- Score: `Beta (70%)`
- Gitcrawl reports:
  - `imsg rpc timeout gateway` returned open issue #87263, "5.22: imsg rpc watch.subscribe timeout on every gateway start - iMessage channel dead".
  - `iMessage private API` returned open issue #84329 about outbound sends preferring configurable IMCore transport when private API support exists, plus #79610 about benign Apple AddressBook stderr logged at error level.
  - Earlier archive search also surfaced #79289 for remote SSH Automation permission selection and #78049/#69799 around TCC/Full Disk Access service context.
- Discrawl reports:
  - `iMessage Full Disk Access Automation cliPath dbPath` returned a support thread advising Full Disk Access for the process running Gateway/`imsg`, Automation for Messages, and hard-setting `cliPath`/`dbPath`.
  - `imsg rpc timeout gateway` returned Discord snippets with `imsg rpc not ready` loops and readiness degradation.
  - Narrow queries for `channels status probe imsg private API` returned no snippets.
- Good qualities:
  - The operator contract is explicit and not hidden behind BlueBubbles server
    semantics.
  - The code separates RPC reachability, private API availability, and action
    capability detection.
  - Errors around Full Disk Access and RPC startup have dedicated handling rather
    than surfacing as generic child-process failures.
- Bad qualities:
  - The runtime depends on macOS permissions and private API bridge state outside
    OpenClaw's control.
  - Remote execution depends on transparent stdio behavior that operators can
    easily break with wrappers or shell filters.
  - Active archive reports show the transport can be the reason the whole
    iMessage channel appears dead even when config looks correct.
- Excluded from quality:
  - Unit, integration, e2e, live, and runtime-flow test evidence is recorded
    under Coverage only.

## Completeness Score

- Score: `Beta (72%)`
- Surface instructions: evaluated against `references/completeness/imessage-bluebubbles.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Run local imsg, Run through SSH wrapper, Grant macOS permissions, Probe runtime health.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Live host proof is missing from the repository evidence.
- TCC and Automation failures remain operator-sensitive.
- The private API bridge can fall out after Messages or OS changes and requires
  reprobe or `imsg launch` repair.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/channels/imessage.md:10`: supported deployments use `imsg` on a signed-in macOS Messages host or an SSH wrapper from Linux/Windows.
- `/Users/kevinlin/code/openclaw/docs/channels/imessage.md:19`: status is native external CLI integration; Gateway spawns `imsg rpc` over stdio.
- `/Users/kevinlin/code/openclaw/docs/channels/imessage.md:122`: wrappers must behave like transparent long-lived JSON-RPC stdio pipes.
- `/Users/kevinlin/code/openclaw/docs/channels/imessage.md:130`: buffering wrappers can look like `imsg rpc timeout` outages.
- `/Users/kevinlin/code/openclaw/docs/channels/imessage.md:139`: Full Disk Access is required for the process running OpenClaw/`imsg`.
- `/Users/kevinlin/code/openclaw/docs/channels/imessage.md:140`: Automation permission is required to send through Messages.app.
- `/Users/kevinlin/code/openclaw/docs/channels/imessage.md:141`: advanced actions require SIP/private API setup.
- `/Users/kevinlin/code/openclaw/docs/gateway/config-channels.md:598`: off-Mac Gateways should set `cliPath` to an SSH wrapper.
- `/Users/kevinlin/code/openclaw/docs/gateway/config-channels.md:637`: `remoteHost` enables SCP attachment fetching for SSH wrappers.

### Source

- `/Users/kevinlin/code/openclaw/extensions/imessage/src/client.ts:95`: RPC client spawns the configured `cliPath`.
- `/Users/kevinlin/code/openclaw/extensions/imessage/src/client.ts:126`: child stdin error handling prevents dead `imsg` processes from crashing Gateway on async EPIPE.
- `/Users/kevinlin/code/openclaw/extensions/imessage/src/probe.ts:164`: private API probe inspects `send-rich --help` for attachment support.
- `/Users/kevinlin/code/openclaw/extensions/imessage/src/probe.ts:213`: probe materializes private API status from `imsg status --json`.
- `/Users/kevinlin/code/openclaw/extensions/imessage/src/probe.ts:292`: RPC probe calls `chats.list` through the same client path.
- `/Users/kevinlin/code/openclaw/extensions/imessage/src/monitor/monitor-provider.ts:241`: runtime resolves explicit or auto-detected `remoteHost`.
- `/Users/kevinlin/code/openclaw/extensions/imessage/src/monitor/monitor-provider.ts:989`: monitor starts `watch.subscribe` with attachment and reaction options.
- `/Users/kevinlin/code/openclaw/extensions/imessage/src/monitor/monitor-provider.ts:1013`: startup retries transient `watch.subscribe` failures.

### Integration tests

- `/Users/kevinlin/code/openclaw/src/gateway/server-methods/channels.status.test.ts:213`: a plugin-owned iMessage status probe is registered in Gateway channel status handling.
- `/Users/kevinlin/code/openclaw/src/gateway/server-methods/channels.status.test.ts:223`: `channels.status --probe` calls the iMessage probe once.
- `/Users/kevinlin/code/openclaw/src/commands/health.test.ts:323`: health output includes the iMessage configured/probe state.
- No live macOS/imsg integration lane was found for this component.

### Unit tests

- `/Users/kevinlin/code/openclaw/extensions/imessage/src/status.test.ts:46`: refuses to spawn `imsg rpc` in test environments.
- `/Users/kevinlin/code/openclaw/extensions/imessage/src/status.test.ts:54`: promotes Full Disk Access RPC banners to a public probe error.
- `/Users/kevinlin/code/openclaw/extensions/imessage/src/status.test.ts:188`: fails fast for default local `imsg` probes on non-mac hosts.
- `/Users/kevinlin/code/openclaw/extensions/imessage/src/status.test.ts:206`: status probe uses account-scoped `cliPath` and `dbPath`.
- `/Users/kevinlin/code/openclaw/extensions/imessage/src/probe.test.ts:23`: method support follows the explicit RPC method list.
- `/Users/kevinlin/code/openclaw/extensions/imessage/src/monitor.watch-subscribe-retry.test.ts:81`: transient `watch.subscribe` startup timeouts are retried.

### Gitcrawl queries

Query:

`gitcrawl search openclaw/openclaw --query "imsg rpc timeout gateway" --json --limit 6`

Results:

- Open issue #87263: `5.22: imsg rpc watch.subscribe timeout on every gateway start - iMessage channel dead`.

Query:

`gitcrawl search openclaw/openclaw --query "iMessage private API" --json --limit 6`

Results:

- Open issue #84329 about outbound sends preferring configurable IMCore transport when private API support is available.
- Open issue #79610 about benign Apple AddressBook stderr logged at error level on the standard imsg private API path.

### Discrawl queries

Query:

`/Users/kevinlin/.local/bin/discrawl search "iMessage Full Disk Access Automation cliPath dbPath" --limit 6`

Results:

- Discord support thread `Probe failed - Error: imsg rpc exited (code 1)` on 2026-02-17 recommended fixing Full Disk Access, Automation, and hard-setting `cliPath`/`dbPath`.

Query:

`/Users/kevinlin/.local/bin/discrawl search "imsg rpc timeout gateway" --limit 6`

Results:

- Discord snippets reported `imsg rpc not ready` loops, channel exits, and readiness degradation during Gateway churn.
