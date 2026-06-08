---
title: "Microsoft Teams - Webhook Runtime, SDK Lifecycle, and Proactive Cloud Boundary Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Microsoft Teams - Webhook Runtime, SDK Lifecycle, and Proactive Cloud Boundary Maturity Note

## Summary

The Teams webhook/runtime path is one of the stronger Teams families. Source
uses the Teams SDK for auth and typed activities, has explicit HTTP hardening,
and validates proactive `serviceUrl` boundaries across public and non-public
clouds. Coverage is Beta because there is local server/runtime proof and docs
claim public cloud live validation, but current non-public cloud and proactive
operation proof is not durable live evidence.

## Category Scope

This category covers webhook server startup, SDK auth/JWT handling, bearer
pre-gate, JSON body limits, typed invoke handlers, legacy endpoint forwarding,
poll/file-consent/signin/feedback/activity routing, server timeouts, shutdown,
stored conversation references, proactive sends/edits/deletes, and service URL
boundaries for Public, GCC, GCC High, DoD, and China/21Vianet.

## Features

- Webhook Runtime: Covers Webhook Runtime across webhook server startup, SDK auth/JWT handling, bearer pre-gate, JSON body limits, and related webhook runtime, sdk lifecycle, and proactive cloud boundary behavior.
- SDK Lifecycle: Covers SDK Lifecycle across webhook server startup, SDK auth/JWT handling, bearer pre-gate, JSON body limits, and related webhook runtime, sdk lifecycle, and proactive cloud boundary behavior.
- Proactive Cloud Boundary: Covers Proactive Cloud Boundary across webhook server startup, SDK auth/JWT handling, bearer pre-gate, JSON body limits, and related webhook runtime, sdk lifecycle, and proactive cloud boundary behavior.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (70%)`
- Positive signals: Docs say the SDK-backed path is live-validated for public
  cloud, and local server/runtime tests cover the webhook, lifecycle, timeouts,
  cloud validation, proactive references, and SDK auth seams.
- Negative signals: No durable public-cloud or sovereign-cloud scenario report
  was found for send/edit/delete, file consent, card, poll, and queued proactive
  operations.
- Integration gaps: Missing live proof for GCC, GCC High, DoD, China, and
  stored-reference refresh after cloud/service URL changes.

## Quality Score

- Score: `Beta (70%)`
- Gitcrawl reports: `#76262` reworked Teams onto the Teams SDK and called out
  streaming/card/edit/delete/SSO fixes; focused service URL issue searches
  returned no direct issue hits.
- Discrawl reports: Broad `msteams` search returned maintainer review concern
  for the large Teams SDK migration and prior cautions around JSON auth, invoke
  response semantics, stored `serviceUrl` routing, and release-age bypass.
- Good qualities: Runtime validates auth before dispatch, bounds request bodies,
  centralizes typed invoke routing, applies server timeouts, fails closed for
  unsupported service URLs, and stores tenant/service reference data for
  proactive sends.
- Bad qualities: The SDK migration is large and recent; public cloud is the only
  documented live-validated cloud, while non-public cloud support is mostly
  source/doc backed.
- Excluded from quality: Test breadth, local server test count, and lack of
  live e2e coverage.

## Completeness Score

- Score: `Beta (70%)`
- Surface instructions: evaluated against `references/completeness/microsoft-teams.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Webhook Runtime, SDK Lifecycle, Proactive Cloud Boundary.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Add a public-cloud live scenario that covers inbound DM, inbound channel,
  proactive reply, edit/delete, card, file consent, and queued final reply.
- Add non-public cloud contract scenarios or explicit unsupported-state checks.
- Add release notes that explain the Teams SDK migration compatibility boundary.

## Evidence

### Docs

- `docs/channels/msteams.md` documents webhook timeouts, proactive messaging,
  public cloud live validation, non-public cloud `cloud` and `serviceUrl`
  config, accepted proactive hosts, China behavior, and service URL refresh
  requirements.

### Source

- `extensions/msteams/src/monitor.ts` starts the Express webhook, pre-gates
  missing Bearer auth, bounds JSON body size, delegates to the Teams SDK,
  registers typed card/file-consent/signin/feedback/activity handlers, applies
  webhook timeouts, and exposes shutdown.
- `extensions/msteams/src/sdk.ts` loads Teams SDK auth and token-provider
  integration.
- `extensions/msteams/src/cloud.ts` resolves cloud config and validates
  proactive service URL boundaries.
- `extensions/msteams/src/sdk-proactive.ts` builds SDK conversation references,
  validates stored/configured service URLs, and sends/updates/deletes proactive
  activities.
- `extensions/msteams/src/bot-framework-service-url.ts` normalizes Bot
  Framework service URLs.

### Integration tests

- `extensions/msteams/src/monitor.test.ts` exercises a local HTTP server/socket
  path for webhook timeout behavior.
- No durable real Teams public-cloud or sovereign-cloud e2e scenario file was
  found by `rg`.

### Unit tests

- `extensions/msteams/src/cloud.test.ts` covers service URL and cloud boundary
  validation.
- `extensions/msteams/src/sdk-proactive.test.ts` covers proactive reference
  handling.
- `extensions/msteams/src/monitor.lifecycle.test.ts` covers typed handlers and
  auth gate routing.
- `extensions/msteams/src/auth-coverage.test.ts` covers token validation seams.

### Gitcrawl queries

Query:

- `gitcrawl search issues "msteams Teams serviceUrl webhook proactive send cloud USGov DoD China" -R openclaw/openclaw --state all --json number,title,state,url,updatedAt --limit 10`
- `gitcrawl search openclaw/openclaw --query "msteams file consent serviceUrl" --json --limit 10`

Results:

- The focused service URL issue search returned `[]`.
- The broader service URL query returned `#76262`, "fix(msteams): rebase
  TeamsSDK patterns to simplify Teams Integration".

### Discrawl queries

Query:

- `DISCRAWL_NO_AUTO_UPDATE=1 /Users/kevinlin/.local/bin/discrawl search --limit 10 "msteams serviceUrl proactive public cloud GCC China"`
- `DISCRAWL_NO_AUTO_UPDATE=1 /Users/kevinlin/.local/bin/discrawl search --limit 10 "msteams"`

Results:

- The focused service URL query returned no lines.
- The broad `msteams` query returned Teams SDK migration review discussion,
  including maintainer caution about auth parsing, invoke responses, stored
  service URL routing, and needing real Teams tenant smoke tests.
