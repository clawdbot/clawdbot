---
title: "Automation: cron, hooks, tasks, polling - Gmail Pub/Sub Watchers Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Automation: cron, hooks, tasks, polling - Gmail Pub/Sub Watchers Maturity Note

## Summary

Gmail PubSub integration is documented and has focused setup/runtime code, but it is one of the least mature automation components in this surface. It depends on Google Pub/Sub, `gog`, OpenClaw hooks, public HTTPS routing, and often Tailscale Funnel path mapping. Archive evidence shows real operator confusion and an open issue where Pub/Sub reaches the topic but OpenClaw does not process pushes in Docker plus Funnel.

## Category Scope

This category covers `openclaw webhooks gmail setup`, `hooks.gmail` config, `gog gmail watch start/serve`, watcher startup and renewal, Tailscale/Funnel routing, Gmail model/thinking overrides, push token handling, body inclusion limits, safe external-content handling, and routing Gmail events into mapped hook isolated runs.

## Features

- Gmail setup wizard: Covers Gmail setup wizard across `openclaw webhooks gmail setup`, `hooks.gmail` config, `gog gmail watch start/serve`, watcher startup and renewal, and related gmail pub/sub watchers behavior.
- Watcher start/serve: Covers Watcher start/serve across `openclaw webhooks gmail setup`, `hooks.gmail` config, `gog gmail watch start/serve`, watcher startup and renewal, and related gmail pub/sub watchers behavior.
- Tailscale/public routing: Covers Tailscale/public routing across `openclaw webhooks gmail setup`, `hooks.gmail` config, `gog gmail watch start/serve`, watcher startup and renewal, and related gmail pub/sub watchers behavior.
- Push token validation: Covers Push token validation across `openclaw webhooks gmail setup`, `hooks.gmail` config, `gog gmail watch start/serve`, watcher startup and renewal, and related gmail pub/sub watchers behavior.
- Gmail event routing: Covers Gmail event routing across `openclaw webhooks gmail setup`, `hooks.gmail` config, `gog gmail watch start/serve`, watcher startup and renewal, and related gmail pub/sub watchers behavior.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Alpha (65%)`
- Positive signals: Focused tests cover Gmail config resolution, setup helpers, watcher lifecycle, stale cancellation, process replacement, and CLI setup behavior. Docs explain both wizard and manual setup.
- Negative signals: The most important behavior is live external ingress through Google Pub/Sub and a public HTTPS endpoint, and the local evidence does not prove the full external path under Docker/Funnel/reverse-proxy variants.
- Integration gaps: Missing repeatable live or fixture-backed proof for Pub/Sub push payload -> `gog watch serve` -> OpenClaw hook -> isolated agent run, including token/path failures and renewal.

## Quality Score

- Score: `Alpha (58%)`
- Gitcrawl reports: Issue #77093 reports that Gmail Pub/Sub pushes reach the topic but OpenClaw's webhooks Gmail endpoint does not process real pushes in Docker plus Tailscale Funnel setup.
- Discrawl reports: Discord Gmail integration thread repeatedly drills into Tailscale Funnel path stripping, `serve.path`, `tailscale.path`, `tailscale.target`, and push token config, indicating setup is easy to misalign.
- Good qualities: Runtime config builder validates required token/account/topic/push-token fields, command builders keep sensitive flags known, watcher lifecycle guards stale cancellation and re-entry, and docs recommend wizard setup.
- Bad qualities: The component has many moving parts outside the Gateway process. Path/token/routing mistakes produce hard-to-debug failures, and the archive shows that the documented happy path is not enough for common Docker/Funnel deployments.
- Excluded from quality: Test inventory and runtime proof depth; they are coverage inputs only.

## Completeness Score

- Score: `Alpha (65%)`
- Surface instructions: evaluated against `references/completeness/automation-cron-hooks-tasks-polling.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Gmail setup wizard, Watcher start/serve, Tailscale/public routing, Push token validation, Gmail event routing.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Add a local integration harness that simulates Pub/Sub push envelopes and proves the full watcher-to-hook path.
- Docs should include side-by-side path examples for Tailscale Funnel prefix stripping versus direct reverse proxy.
- Setup diagnostics should check `hooks.gmail.serve.path`, `hooks.gmail.tailscale.path`, `hooks.gmail.tailscale.target`, public endpoint reachability, and hook token/push token alignment.

## Evidence

### Docs

- `docs/automation/cron-jobs.md#gmail-pubsub-integration` documents wizard setup, manual Google project/topic setup, watcher auto-start, and Gmail model/thinking overrides.
- `docs/automation/gmail-pubsub.md` redirects to the scheduled-tasks Gmail PubSub section.
- `docs/cli/webhooks.md` documents the `openclaw webhooks gmail setup` command surface.

### Source

- `src/hooks/gmail.ts` builds Gmail hook runtime config, token generation, hook URLs, `gog` watch start/serve args, Tailscale config, and topic parsing.
- `src/hooks/gmail-watcher.ts`, `src/hooks/gmail-watcher-lifecycle.ts`, and `src/hooks/gmail-watcher-errors.ts` manage watcher process lifecycle and errors.
- `src/hooks/gmail-setup-utils.ts`, `src/hooks/gmail-ops.ts`, and `src/cli/webhooks-cli.ts` implement setup and CLI behavior.
- `src/gateway/hooks-mapping.ts` defines the Gmail preset mapping, and `src/agents/model-selection-shared.ts` resolves Gmail hook model overrides.

### Integration tests

- No full live Google Pub/Sub integration test was found in the audited tree.
- `src/hooks/gmail-watcher-lifecycle.test.ts` and `src/hooks/gmail-watcher.test.ts` are closest to integration-style process lifecycle tests for the watcher.

### Unit tests

- `src/hooks/gmail.test.ts`, `src/hooks/gmail-setup-utils.test.ts`, `src/hooks/gmail-watcher.test.ts`, and `src/hooks/gmail-watcher-lifecycle.test.ts` cover config, setup helpers, watcher cancellation, and process replacement.
- `src/cli/webhooks-cli.test.ts` covers CLI setup behavior.
- `src/agents/openclaw-gateway-tool.test.ts` covers protected config paths such as `hooks.gmail.allowUnsafeExternalContent`.

### Gitcrawl queries

Query:

`gitcrawl search openclaw/openclaw --query "gmail pubsub watcher hooks gmail model" --json --limit 5`

Results:

- Issue #77093 reports Gmail Pub/Sub push reaching the topic but OpenClaw not processing real pushes in Docker plus Tailscale Funnel setup.

Fallback query:

`gitcrawl search openclaw/openclaw --query "Gmail PubSub Funnel" --json --limit 5`

Results:

- Issue #77093 is again the matching result, specifically mentioning Docker plus Tailscale Funnel.

### Discrawl queries

Query:

`/Users/kevinlin/.local/bin/discrawl search --mode hybrid --limit 5 "gmail pubsub watcher hooks gmail model"`

Results:

- No matching Discord messages returned for this exact query.

Fallback query:

`/Users/kevinlin/.local/bin/discrawl search --mode hybrid --limit 5 "Gmail PubSub Funnel"`

Results:

- Discord Gmail integration thread explains that Tailscale Serve is not enough for Google Pub/Sub callbacks; Funnel or another public HTTPS URL is required.
- Same thread gives concrete `gog gmail watch serve` args and warns that Funnel can strip `/gmail-pubsub`, requiring `serve.path="/"` unless the target explicitly preserves the path.
- Same thread recommends checking `hooks.gmail.serve.path`, `hooks.gmail.tailscale.path`, `hooks.gmail.tailscale.target`, and `hooks.gmail.pushToken`.
