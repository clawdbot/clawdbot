---
title: "Windows via WSL2 - Wsl Networking and Portproxy Exposure Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Windows via WSL2 - Wsl Networking and Portproxy Exposure Maturity Note

## Summary

WSL networking is documented and partially supported by WSL2-aware runtime behavior, but it remains one of the main operator pain points. The docs explain changing WSL IPs, Windows `portproxy`, firewall rules, LAN listen addresses, and reachable Gateway URLs. Archive evidence still shows Tailscale, Android node, Chrome relay, Control UI, and portproxy failures where WSL's virtual network and Windows firewall make a correct OpenClaw setup hard to reach.

## Category Scope

- WSL virtual network and changing WSL IP.
- Windows `netsh interface portproxy` setup and refresh.
- Windows Firewall rules for forwarded ports.
- Gateway URLs that must be reachable from remote nodes.
- LAN versus loopback listen address semantics.
- WSL2-specific IPv4 network-family behavior.
- Tailscale/remote access only where it intersects WSL2 networking.

## Features

- WSL virtual network: WSL virtual network behavior and host/guest addressing.
- Windows portproxy setup: Windows netsh interface portproxy setup for exposing WSL services.
- Windows Firewall rules: Windows Firewall rules for WSL Gateway access.
- Reachable Gateway URLs: Gateway URLs that must be reachable from Windows, WSL2, and LAN clients.
- Loopback and LAN exposure: Loopback versus LAN listen behavior for WSL2 Gateway exposure.
- WSL2 IPv4 networking: WSL2-specific IPv4 network-family behavior.
- Tailscale remote access: Tailscale and remote access behavior where it intersects WSL2 networking.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (70%)`
- Positive signals: Windows docs include a portproxy runbook with PowerShell commands, firewall setup, refresh steps, and remote-node URL caveats; remote-access and exposure docs explain loopback/Tailscale/tunnel patterns; source handles WSL2 IPv4 selection.
- Negative signals: docs cover the manual path, but source does not own Windows portproxy lifecycle or Windows Firewall state.
- Integration gaps: no WSL2 networking e2e was found that proves Gateway reachability from Windows host, LAN device, tailnet device, and remote node after WSL IP changes.

## Quality Score

- Score: `Alpha (65%)`
- Gitcrawl reports: `WSL2 portproxy Gateway Windows host` returned PR #74163 with Microsoft issue refresh entries including Windows portproxy breakage and Windows platform gateway disconnects. `Windows WSL2 OpenClaw` returned issues #54669, #73152, #81873, #80336, #73836, and #86752 touching WSL2 reachability and Gateway responsiveness.
- Discrawl reports: WSL2 portproxy search returned Tailscale/Android reachability reports, WSL2 gateway/node-host relay failures, Chrome relay binding failures, and support guidance that raw portproxy and dual Tailscale setups are fragile.
- Good qualities: the docs are explicit about changing WSL IPs, firewall setup, and the difference between local-only and LAN listen addresses.
- Bad qualities: the product cannot reliably abstract Windows firewall, WSL networking mode, portproxy refresh, and tailnet routing; users still need multi-layer network troubleshooting.
- Excluded from quality: unit, integration, e2e, live, and runtime-flow test evidence is excluded from this Quality score.

## Completeness Score

- Score: `Beta (70%)`
- Surface instructions: evaluated against `references/completeness/windows-via-wsl2.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for WSL virtual network, Windows portproxy setup, Windows Firewall rules, Reachable Gateway URLs, Loopback and LAN exposure, WSL2 IPv4 networking, Tailscale remote access.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Need `doctor` or `status` checks that can identify stale portproxy targets and firewall blocks.
- Need a recommended WSL2 + Tailscale pattern in the Windows platform doc, not only general Tailscale guidance.
- Need live proof for Windows host, LAN device, and tailnet device reachability against a WSL2 Gateway.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/platforms/windows.md:138`: portproxy section explains WSL has its own virtual network.
- `/Users/kevinlin/code/openclaw/docs/platforms/windows.md:140`: docs state services inside WSL require forwarding a Windows port to the current WSL IP.
- `/Users/kevinlin/code/openclaw/docs/platforms/windows.md:152`: runbook gets the WSL IP using `wsl -d $Distro -- hostname -I`.
- `/Users/kevinlin/code/openclaw/docs/platforms/windows.md:155`: runbook adds a `netsh interface portproxy` v4-to-v4 rule.
- `/Users/kevinlin/code/openclaw/docs/platforms/windows.md:159`: runbook adds a Windows Firewall rule.
- `/Users/kevinlin/code/openclaw/docs/platforms/windows.md:176`: notes say remote nodes need a reachable Gateway URL, not `127.0.0.1`.
- `/Users/kevinlin/code/openclaw/docs/gateway/remote.md:15`: remote docs describe loopback bind plus Tailscale, trusted LAN/tailnet, or SSH forwarding.
- `/Users/kevinlin/code/openclaw/docs/gateway/security/exposure-runbook.md:24`: exposure runbook compares loopback, Tailscale Serve, tailnet/LAN bind, proxy, and public patterns.

### Source

- `/Users/kevinlin/code/openclaw/src/infra/net/undici-family-policy.ts:12`: WSL2 disables auto-family selection because WSL2 has unstable IPv6 connectivity.
- `/Users/kevinlin/code/openclaw/src/infra/wsl.ts:40`: WSL2 detection identifies Microsoft-standard WSL2 kernels.
- `/Users/kevinlin/code/openclaw/src/infra/browser-open.ts:68`: Linux browser open handling checks whether the process is running under WSL.

### Integration tests

- `/Users/kevinlin/code/openclaw/scripts/e2e/lib/gateway-network/client.mjs`: gateway-network e2e client exercises network reachability paths.
- `/Users/kevinlin/code/openclaw/scripts/e2e/gateway-network-docker.sh`: Docker gateway-network e2e exists for general network behavior, but not WSL2/Windows portproxy.

### Unit tests

- `/Users/kevinlin/code/openclaw/src/infra/net/undici-global-dispatcher.test.ts:621`: WSL2 disables `autoSelectFamily` in dispatcher setup.
- `/Users/kevinlin/code/openclaw/src/infra/net/fetch-guard.ssrf.test.ts`: SSRF/fetch guard tests use the WSL2 family policy mock.
- `/Users/kevinlin/code/openclaw/src/infra/net/ssrf.dispatcher.test.ts:129`: SSRF dispatcher tests reuse the global WSL2 auto-family policy for pinned dispatchers.

### Gitcrawl queries

Query:

- `gitcrawl search openclaw/openclaw --query "WSL2 portproxy Gateway Windows host" --mode keyword --limit 10 --json`
- `gitcrawl search openclaw/openclaw --query "Windows WSL2 OpenClaw" --mode keyword --limit 12 --json`

Results:

- Portproxy query returned PR #74163, including Microsoft issue refresh entries for Windows portproxy breakage and Windows platform gateway disconnects.
- Windows WSL2 OpenClaw query returned 12 hits including WSL/VM/Tailscale docs request #73152, browser profile issue #81873, IPv6/portproxy issue #54669, placeholder gateway reachability #80336, WSL2 gateway stall #61616, Docker/WSL2 event-loop starvation #86752, and Control UI/Gateway responsiveness reports.

### Discrawl queries

Query:

- `DISCRAWL_NO_AUTO_UPDATE=1 /Users/kevinlin/.local/bin/discrawl search --mode hybrid --limit 8 "WSL2 portproxy Gateway Windows host"`
- `DISCRAWL_NO_AUTO_UPDATE=1 /Users/kevinlin/.local/bin/discrawl search --mode hybrid --limit 8 "WSL2 systemd gateway install loginctl portproxy"`

Results:

- WSL2 portproxy query returned 8 hits, including WSL2 + Tailscale Android reachability failures, Chrome extension relay reports, WSL2 node-host pairing confusion, and guidance to use Windows-host-only Tailscale Serve or portproxy carefully.
- The broader systemd/install/portproxy query returned a support summary listing WSL2 networking, file I/O, auto-start, and Windows-native integration tradeoffs.
