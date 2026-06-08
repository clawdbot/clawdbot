---
title: "Linux companion app - Gateway Connectivity Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Linux companion app - Gateway Connectivity Maturity Note

## Summary

The underlying Gateway connection, browser pairing, SSH/Tailscale remote access, and Linux systemd Gateway service paths are well documented, but they are not assembled into a supported native Linux companion app. Open PR and Discord evidence show Linux remote-mode work in progress, while current source still has no native Linux app client.

## Category Scope

Included in this category:

- Local Gateway attach and status: Local Gateway attach, start, and status behavior from a Linux app.
- Gateway pairing and auth: Gateway auth and device pairing from a native Linux client.
- Remote mode: Remote mode through direct URL, SSH tunnel, or Tailscale
- Local and remote resource boundaries: Local and remote resource boundaries for a Linux companion client.

## Features

- Local Gateway attach and status: Local Gateway attach, start, and status behavior from a Linux app.
- Gateway pairing and auth: Gateway auth and device pairing from a native Linux client.
- Remote mode: Remote mode through direct URL, SSH tunnel, or Tailscale
- Local and remote resource boundaries: Local and remote resource boundaries for a Linux companion client.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Experimental (8%)`
- Positive signals: Gateway auth, pairing, Linux systemd service, Control UI, and macOS remote mode have current docs and adjacent runtime coverage.
- Negative signals: no checked-in Linux companion app implements native connection, pairing, local mode, or remote mode.
- Integration gaps: no Linux native app connection/pairing/remote-mode smoke exists in the current source tree.

## Quality Score

- Score: `Experimental (35%)`
- Gitcrawl reports: direct `Linux companion gateway pairing remote local mode` search returned only a broad unrelated tracking PR; issue #75 and PR #59859/#61576 contain open Linux app connection claims.
- Discrawl reports: issue #75 comments include a Linux companion Remote Connection Mode milestone, but no supported release proof.
- Good qualities: the underlying Gateway and browser auth model is mature enough for a future Linux app to reuse.
- Bad qualities: docs do not state how a native Linux app should handle direct remote URL, SSH tunnel lifecycle, Tailscale identity, local resource access, or device identity persistence.
- Excluded from quality: unit, integration, e2e, live, and real runtime-flow test evidence is excluded from this Quality score.

## Completeness Score

- Score: `Experimental (8%)`
- Surface instructions: evaluated against `references/completeness/linux-companion-app.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Local Gateway attach and status, Gateway pairing and auth, Remote mode, Local and remote resource boundaries.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Define whether the Linux app starts a local Gateway, attaches only, or mirrors the macOS local/remote split.
- Define remote transport UX and local-resource fallback for a native Linux client.
- Add native Linux pairing, auth, reconnect, stale-token, and remote-mode docs.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/platforms/linux.md:36`: Linux Gateway service install is CLI-driven through `openclaw onboard --install-daemon`, `openclaw gateway install`, or `openclaw configure`.
- `/Users/kevinlin/code/openclaw/docs/platforms/linux.md:64`: Linux systemd user service setup is documented.
- `/Users/kevinlin/code/openclaw/docs/web/control-ui.md:34`: browser Control UI first connection usually requires device pairing approval.
- `/Users/kevinlin/code/openclaw/docs/web/control-ui.md:61`: local loopback browser connections are auto-approved while Tailnet/LAN/browser profiles have explicit pairing behavior.
- `/Users/kevinlin/code/openclaw/docs/platforms/macos.md:24`: macOS companion local and remote modes are documented; Linux has no equivalent native page.

### Source

- No `apps/linux` Gateway client or app-level remote-mode source exists in the current checkout.
- `/Users/kevinlin/code/openclaw/apps/macos/Sources/OpenClaw`: macOS has Gateway connection and remote tunnel source; this is adjacent reference, not Linux app source.
- `src/gateway` and `docs/web/control-ui.md` support browser/Gateway access independent of a Linux native app.

### Integration tests

- No native Linux app connection, pairing, or remote-mode integration test was found.
- Existing Gateway and Control UI tests cover the underlying protocol surface, not a Linux app client.

### Unit tests

- No Linux app connection or pairing unit test target was found.
- Adjacent shared OpenClawKit tests cover mobile/macOS client support, not Linux native source.

### Gitcrawl queries

Query:

- `gitcrawl search openclaw/openclaw --query "Linux companion gateway pairing remote local mode" --mode keyword --limit 8 --json`
- `gitcrawl search openclaw/openclaw --query "Linux Windows Clawdbot Apps issue 75" --mode keyword --limit 8 --json`
- `gitcrawl gh pr view 59859 --repo openclaw/openclaw --json number,title,state,author,updatedAt,body,headRefName,baseRefName,url`
- `gitcrawl gh pr view 61576 --repo openclaw/openclaw --json number,title,state,author,updatedAt,body,headRefName,baseRefName,url`

Results:

- The gateway/pairing/remote query returned only broad unrelated tracking PR #74163, not a landed Linux companion result.
- The issue #75 query returned broad Linux/Windows app tracking evidence.
- PR #59859 claims systemd integration, HTTP health probing, authenticated WebSocket connection, and local-vs-remote resource handling, but remains open.
- PR #61576 claims a typed WebSocket gateway client and device identity with ed25519 challenge signing, but remains open and early.

### Discrawl queries

Query:

- `DISCRAWL_NO_AUTO_UPDATE=1 /Users/kevinlin/.local/bin/discrawl search --mode hybrid --limit 6 "Linux companion gateway pairing remote local mode"`
- `DISCRAWL_NO_AUTO_UPDATE=1 /Users/kevinlin/.local/bin/discrawl search --mode hybrid --limit 6 "Linux Windows Clawdbot Apps issue 75"`

Results:

- The gateway/pairing/remote query returned no direct results.
- The issue #75 query returned an April 25 comment saying a Linux companion Remote Connection Mode milestone was being landed in a contributor track, including direct remote gateway URL, SSH local-forwarded remote gateway, parsing, validation, normalization, and status propagation.
