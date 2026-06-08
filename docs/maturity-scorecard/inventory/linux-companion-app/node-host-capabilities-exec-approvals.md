---
title: "Linux companion app - Node-host Capabilities, Desktop Tools, and Exec Approvals Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Linux companion app - Node-host Capabilities, Desktop Tools, and Exec Approvals Maturity Note

## Summary

OpenClaw has a cross-platform headless node host and a rich macOS companion app node model, but there is no supported Linux companion app to provide native UI-context approvals or desktop capability prompts. Archive evidence includes a Linux node-host approval bug where the absence of a Linux companion app mattered directly.

## Category Scope

- Linux native node identity and capability advertisement.
- `system.run`, `system.notify`, `system.which`, and app-mediated approvals.
- Desktop tools such as screen, camera, notifications, Canvas, and local command execution.
- Adjacent out-of-scope surfaces: headless node host, macOS companion app node mode, Gateway-host exec.

## Features

- Linux native node identity: Linux native node identity and capability advertisement
- Host command execution: Host command execution through system.run and related desktop tools.
- Desktop tools: Desktop tools such as screen, camera, notifications, Canvas, and local command execution

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Experimental (2%)`
- Positive signals: headless node host docs and exec-approval docs exist for cross-platform command execution.
- Negative signals: no Linux companion app exists to own native prompts, local UI-context command execution, or desktop capability approvals.
- Integration gaps: no Linux companion node-host capability or app-mediated exec approval proof exists in the current source tree.

## Quality Score

- Score: `Experimental (22%)`
- Gitcrawl reports: query returned open issues for TOTP approvals and allowlist races plus broad tracking references; issue #47512 specifically describes Linux node-host approval failure due to missing Linux companion approval socket.
- Discrawl reports: support discussions describe macOS companion app permissions and `system.run` behavior, and Linux/Windows users are directed to headless node host or other nodes for hardware capabilities.
- Good qualities: the underlying exec approval and headless node host models are documented and security-conscious.
- Bad qualities: Linux has no app-mediated approval UX, no native permission map, no desktop capability ownership, and no docs explaining how a future Linux app should differ from headless node host.
- Excluded from quality: unit, integration, e2e, live, and real runtime-flow test evidence is excluded from this Quality score.

## Completeness Score

- Score: `Experimental (2%)`
- Surface instructions: evaluated against `references/completeness/linux-companion-app.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Linux native node identity, Host command execution, Desktop tools.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Define whether Linux companion app owns a UI approval socket or delegates to the headless node host.
- Define Linux capability names, permission map semantics, and user prompts.
- Add app-specific docs for `system.run`, notifications, screen/camera/media, and approval fallback behavior.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/nodes/index.md:413`: headless node host is cross-platform and exposes `system.run` / `system.which`.
- `/Users/kevinlin/code/openclaw/docs/nodes/index.md:427`: pairing is still required for headless node hosts.
- `/Users/kevinlin/code/openclaw/docs/tools/exec.md:73`: gateway/node approvals are controlled by `~/.openclaw/exec-approvals.json`.
- `/Users/kevinlin/code/openclaw/docs/tools/exec.md:74`: `node` requires a paired node, companion app, or headless node host.
- `/Users/kevinlin/code/openclaw/docs/tools/exec-approvals.md:38`: if companion app UI is unavailable, prompt-style approvals fall back, defaulting to deny.
- `/Users/kevinlin/code/openclaw/docs/platforms/macos.md:52`: macOS companion app presents itself as a node with Canvas, Camera, Screen, and System commands.

### Source

- `/Users/kevinlin/code/openclaw/src/agents/bash-tools.exec-host-node-phases.ts:104`: node exec requires a paired node.
- `/Users/kevinlin/code/openclaw/src/agents/bash-tools.exec-host-node-phases.ts:130`: node exec requires a node that supports `system.run`.
- `/Users/kevinlin/code/openclaw/src/node-host/invoke-system-run.ts:627`: macOS app exec host handoff is app-specific; no Linux equivalent appears in current source.
- No `apps/linux` app-side approval host, desktop tool host, or permission prompt source exists in the current checkout.

### Integration tests

- No Linux companion app node capability or exec approval integration test was found.
- Existing node-host and exec tests exercise generic gateway/node behavior, not a native Linux app approval UI.

### Unit tests

- `/Users/kevinlin/code/openclaw/src/node-host/invoke-system-run.test.ts`: node-host `system.run` tests exist for generic behavior.
- No Linux companion app approval unit tests were found.

### Gitcrawl queries

Query:

- `gitcrawl search openclaw/openclaw --query "Linux companion system.run exec approvals node host" --mode keyword --limit 8 --json`
- `gitcrawl gh issue view 47512 --repo openclaw/openclaw --json number,title,state,author,updatedAt,body,url`

Results:

- The feature query returned open issue #67440 for optional TOTP on exec approvals, open issue #44749 for allowlist race behavior, and broad tracking PR #74163 mentioning headless node host exec approvals.
- Issue #47512 is titled `nodes run with arguments always denied on Linux node host: SYSTEM_RUN_DENIED: approval requires a stable executable path`; its body states the root appears to be that `exec-approvals.sock` is never created on Linux and there is no Linux equivalent of the macOS companion app to handle this socket.

### Discrawl queries

Query:

- `DISCRAWL_NO_AUTO_UPDATE=1 /Users/kevinlin/.local/bin/discrawl search --mode hybrid --limit 6 "Linux companion system.run exec approvals node host"`

Results:

- The query returned issue #47512 with the Linux node-host denial details, a support explanation of the macOS companion app as the node/permissions/exec approval surface, and a hardware-access support answer explaining that without a native companion app users should use other nodes or headless node host paths.
