---
title: "Native Windows - Networking Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Native Windows - Networking Maturity Note

## Summary

Windows host networking is documented, but it is the thinnest part of this
surface. The docs explain WSL2 virtual networking, Windows `netsh portproxy`,
Firewall rules, and reachable Gateway URLs. Source coverage mostly comes from
shared Gateway networking/status logic rather than Windows-specific end-to-end
flows. Archive evidence shows portproxy and WSL2-to-Windows node connectivity
remain confusing for operators.

## Category Scope

Included in this category:

- Native Windows host binding: Native Windows host binding and Gateway exposure behavior.
- netsh interface portproxy: netsh interface portproxy, Windows Firewall rules, and WSL IP refresh
- Gateway status and probe output: Gateway status and probe output that helps operators verify Windows networking.
- Loopback, LAN, and WSL boundary: Boundaries between loopback, LAN, and WSL exposure modes.

## Features

- Native Windows host networking: Native Windows host binding and Gateway exposure behavior.
- netsh interface portproxy: netsh interface portproxy, Windows Firewall rules, and WSL IP refresh
- Gateway status and probe output: Gateway status and probe output that helps operators verify Windows networking.
- Loopback, LAN, and WSL boundary: Boundaries between loopback, LAN, and WSL exposure modes.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Alpha (58%)`
- Positive signals: docs provide concrete WSL2 portproxy and Firewall commands;
  Gateway docs cover bind modes, auth guards, Tailscale, SSH, and status/probe
  commands; source includes shared Gateway network/status/probe logic.
- Negative signals: Windows-specific network proof is mostly documentation and
  support reports rather than scenario tests.
- Integration gaps: no current live proof was found for WSL2 Gateway reachability
  from Windows native node hosts, LAN clients through portproxy, Firewall rule
  setup, portproxy refresh after WSL restart, or remote node pairing over that
  path.

## Quality Score

- Score: `Alpha (56%)`
- Gitcrawl reports: WSL/portproxy queries returned issue/PR signal that Windows
  `portproxy` can break silently and that Gateway reachability needs clearer
  docs across WSL/VM/Tailscale setups.
- Discrawl reports: WSL2 support threads describe Windows node hosts failing to
  attach to a WSL2 Gateway even after portproxy, SSH tunnel, and trusted-proxy
  attempts.
- Good qualities: the docs do not hide the virtual-networking issue and provide
  executable commands for port forwarding and Firewall access.
- Bad qualities: operators must reason about multiple address spaces and
  security modes; the support trail shows that the current docs are not enough
  to make mixed Windows/WSL node setups predictable.
- Excluded from quality: unit, integration, e2e, live, and runtime-flow test
  evidence is recorded only under Coverage and Evidence.

## Completeness Score

- Score: `Alpha (58%)`
- Surface instructions: evaluated against `references/completeness/native-windows-cli-and-gateway.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Native Windows host networking, netsh interface portproxy, Gateway status and probe output, Loopback, LAN, and WSL boundary.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Add a Windows/WSL2 network scenario covering Gateway in WSL2, node host on
  Windows, portproxy refresh, Firewall rule, status output, and successful node
  connection.
- Add diagnostic commands that tell the user whether a Gateway URL is reachable
  from Windows native clients versus only from inside WSL2.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/platforms/windows.md:138` explains that
  WSL has its own virtual network and may need Windows port forwarding.
- `/Users/kevinlin/code/openclaw/docs/platforms/windows.md:155` provides the
  `netsh interface portproxy add` command.
- `/Users/kevinlin/code/openclaw/docs/platforms/windows.md:159` provides the
  Windows Firewall rule.
- `/Users/kevinlin/code/openclaw/docs/platforms/windows.md:176` clarifies that
  remote nodes need a reachable Gateway URL, not `127.0.0.1`.
- `/Users/kevinlin/code/openclaw/docs/gateway/index.md:111` documents Gateway
  port and bind precedence.
- `/Users/kevinlin/code/openclaw/docs/cli/gateway.md:139` documents querying a
  running Gateway over WebSocket RPC.

### Source

- `/Users/kevinlin/code/openclaw/src/commands/gateway-status.ts:38` implements
  status probing.
- `/Users/kevinlin/code/openclaw/src/commands/gateway-status/helpers.ts`
  resolves Gateway status targets and network hints.
- `/Users/kevinlin/code/openclaw/src/gateway/net.ts` implements Gateway network
  helpers including Windows-specific cases.
- `/Users/kevinlin/code/openclaw/src/shared/gateway-bind-url.ts` handles Gateway
  bind URL resolution.

### Integration tests

- `/Users/kevinlin/code/openclaw/scripts/e2e/gateway-network-docker.sh`
  exercises shared Gateway network behavior in Docker.
- `/Users/kevinlin/code/openclaw/test/scripts/gateway-network-client.test.ts`
  covers the Gateway network client harness.

### Unit tests

- `/Users/kevinlin/code/openclaw/src/gateway/net.test.ts` covers Gateway
  networking behavior, including Windows platform branches.
- `/Users/kevinlin/code/openclaw/src/shared/gateway-bind-url.test.ts` covers
  bind URL resolution.
- `/Users/kevinlin/code/openclaw/src/commands/status.gateway-connection.test.ts`
  covers Gateway status connection messaging.
- `/Users/kevinlin/code/openclaw/src/gateway/server-discovery.test.ts` covers
  Gateway discovery behavior.

### Gitcrawl queries

Query:

- `gitcrawl search openclaw/openclaw --query "Windows portproxy gateway remote access WSL" --mode keyword --limit 5 --json`
- `gitcrawl search openclaw/openclaw --query "WSL2 Windows gateway systemd portproxy" --mode keyword --limit 5 --json`

Results:

- Both queries returned PR #74163 with Windows platform issue references,
  including `portproxy v4tov4 breaks silently` and Windows Gateway disconnect
  reports.

### Discrawl queries

Query:

- `DISCRAWL_NO_AUTO_UPDATE=1 /Users/kevinlin/.local/bin/discrawl search --mode hybrid --limit 4 "Windows portproxy gateway remote access WSL"`
- `DISCRAWL_NO_AUTO_UPDATE=1 /Users/kevinlin/.local/bin/discrawl search --mode hybrid --limit 4 "WSL2 Windows gateway systemd portproxy"`

Results:

- The Windows portproxy query returned no direct hits.
- The WSL2 query returned support reports about needing portproxy/mirrored
  networking and a thread where a Windows Node Host could not connect reliably
  to a Gateway running inside WSL2 despite portproxy and SSH tunnel attempts.
