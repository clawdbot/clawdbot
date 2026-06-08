---
title: "Slack - Socket/http Transport and Runtime Lifecycle Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Slack - Socket/http Transport and Runtime Lifecycle Maturity Note

## Summary

Slack has both Socket Mode and HTTP Request URL transports implemented and documented, with reconnect policy, status snapshots, HTTP route registration, and QA live coverage for Socket Mode. Quality is below the other core Slack families because archive evidence contains recurring real-world Socket Mode failures: pong timeouts, reconnect crashes, zombie WSS hangs, multi-agent storms, and silent inbound loss.

## Category Scope

This category covers Socket Mode startup/reconnect/backoff, HTTP Request URL registration and signing-secret verification, transport mode selection, multi-account lifecycle, status/liveness, and runtime startup/skip behavior.

## Features

- Socket: Covers Socket across Socket Mode startup/reconnect/backoff, HTTP Request URL registration and signing-secret verification, transport mode selection, multi-account lifecycle, status/liveness, and runtime startup/skip behavior.
- HTTP transport: Covers HTTP Request URL registration, signing-secret verification, transport mode selection, multi-account lifecycle, status/liveness, and Slack HTTP runtime startup/skip behavior.
- Runtime Lifecycle: Covers Runtime Lifecycle across Socket Mode startup/reconnect/backoff, HTTP Request URL registration and signing-secret verification, transport mode selection, multi-account lifecycle, status/liveness, and runtime startup/skip behavior.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (77%)`
- Positive signals: Socket Mode startup, reconnect policy, HTTP mode validation, signing-secret requirements, webhook-path registration, account snapshots, and live Socket Mode channel canary behavior have explicit source and test coverage.
- Negative signals: HTTP mode has less live proof than Socket Mode, and live coverage does not exercise every network/proxy, multi-workspace, and reconnect failure mode.
- Integration gaps: Need live or replayed transport tests for HTTP Request URLs, proxy/NAT pong timeout behavior, stale-socket restart, 408 reconnect handling, and multi-account Socket Mode concurrency.

## Quality Score

- Score: `Alpha (68%)`
- Gitcrawl reports: `#62784`, `#81491`, `#58519`, `#59945`, `#83712`, `#77249`, and `#57852` show recurring Socket Mode pong/reconnect/silent-outage failure modes.
- Discrawl reports: Support threads describe Slack Socket Mode dropouts, 408 crashes, 5s/15s pong loops, and advice to use HTTP mode when container or firewall egress cannot keep WSS healthy.
- Good qualities: Docs now explain transport selection, HTTP URL fields, signing secrets, status probes, restart backoff, and transport-specific token requirements.
- Bad qualities: The live operator record still shows transport failures can leave Slack apparently configured while inbound events stop, which is a significant reliability and recovery risk.
- Excluded from quality: Unit-test count, live-lane breadth, and integration depth.

## Completeness Score

- Score: `Beta (77%)`
- Surface instructions: evaluated against `references/completeness/slack.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Socket, HTTP transport, Runtime Lifecycle.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Add HTTP Request URL live-lane coverage with request-signature verification and multi-account `webhookPath` collision checks.
- Add targeted reconnect simulations for 408 responses, event-loop starvation, zombie WSS, and multi-agent Socket Mode contention.
- Promote transport-health warnings into operator-visible status when probes succeed but event liveness is stale.

## Evidence

### Docs

- `docs/channels/slack.md` has a transport comparison table, Socket Mode and HTTP setup tabs, Socket Mode tuning, and troubleshooting for both connection styles.
- `docs/channels/slack.md` documents `clientPingTimeout`, `serverPingTimeout`, restart backoff, fast-fail auth errors, and HTTP `webhookPath` requirements.

### Source

- `extensions/slack/src/monitor/provider.ts` resolves Slack mode, bot/app/signing-secret credentials, starts Socket Mode, registers HTTP routes, logs reconnect attempts, and skips non-recoverable auth errors.
- `extensions/slack/src/http/registry.ts` and `extensions/slack/src/http/plugin-routes.ts` implement HTTP route registration and payload handling.
- `extensions/slack/src/account-inspect.ts` reports mode-specific credential status fields.
- `extensions/slack/src/monitor/reconnect-policy.ts` defines reconnect policy behavior.

### Integration tests

- `extensions/qa-lab/src/live-transports/slack/slack-live.runtime.ts` runs the Slack live QA lane over Socket Mode using SUT app/bot tokens.
- `docs/concepts/qa-e2e-automation.md` documents Slack live lane setup and the standard live scenarios.
- No equivalent live HTTP Request URL lane was found.

### Unit tests

- `extensions/slack/src/config-schema.test.ts` validates Socket Mode transport tuning and HTTP signing-secret requirements.
- `extensions/slack/src/monitor/provider.reconnect.test.ts` covers socket health state, disconnect states, retry copy, SDK-log detail, and max-attempt behavior.
- `extensions/slack/src/http/plugin-routes.test.ts` and `extensions/slack/src/http/registry.test.ts` cover HTTP route behavior.
- `extensions/slack/src/channel.test.ts` covers Socket Mode app-token requirements.

### Gitcrawl queries

Query:

- `gitcrawl search issues "Slack socket mode HTTP webhook signing secret reconnect" -R openclaw/openclaw --state all --json number,title,state,url,updatedAt --limit 10`
- `gitcrawl search openclaw/openclaw --query "slack socket mode" --json`

Results:

- The focused issue search returned `[]`.
- The broader query returned Socket Mode risks including `#62784` concurrent connections/pong timeout storm, `#81491` silent outage after failed reconnects, `#58519` event-loop starvation and silent message loss, `#59945` restart loop on redaction-sentinel error, `#83712` socket starvation during SQLite VACUUM, `#77249` zombie WSS requiring restart, and `#57852` 408 reconnect crash.

### Discrawl queries

Query:

- `DISCRAWL_NO_AUTO_UPDATE=1 /Users/kevinlin/.local/bin/discrawl search --limit 10 "Slack socket mode reconnect pong timeout"`

Results:

- Returned operational reports of Slack sockets dropping out after pong timeouts, 408 reconnect crashes, and guidance that HTTP mode may be more reliable for hostile proxy/container environments.
