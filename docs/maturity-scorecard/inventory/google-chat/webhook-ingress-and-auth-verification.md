---
title: "Google Chat - Webhook Auth Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Google Chat - Webhook Auth Maturity Note

## Summary

Webhook ingress has a relatively mature implementation for an Alpha surface: it uses the shared webhook request pipeline, rate limits by path and client IP, verifies bearer and add-on body tokens, validates payload shape, and logs rejection reasons. The score remains below Stable because archive evidence shows recent 401 loops, add-on payload parsing failures, and target-binding confusion, and because there is no live Google Chat webhook lane proving the complete Google-to-gateway path.

## Category Scope

Included in this category:

- Webhook path handling: Covers Webhook path handling across HTTP webhook request handler, path normalization, JSON/method requirements, pre-auth and post-auth body handling, and related webhook ingress and auth verification behavior.
- Standard Chat token verification: Covers Standard Chat token verification across HTTP webhook request handler, path normalization, JSON/method requirements, pre-auth and post-auth body handling, and related webhook ingress and auth verification behavior.
- Workspace add-on token verification: Covers Workspace add-on token verification across HTTP webhook request handler, path normalization, JSON/method requirements, pre-auth and post-auth body handling, and related webhook ingress and auth verification behavior.
- Audience and appPrincipal binding: Covers Audience and appPrincipal binding across HTTP webhook request handler, path normalization, JSON/method requirements, pre-auth and post-auth body handling, and related webhook ingress and auth verification behavior.
- Shared-path target selection: Covers Shared-path target selection across HTTP webhook request handler, path normalization, JSON/method requirements, pre-auth and post-auth body handling, and related webhook ingress and auth verification behavior.
- Auth rejection diagnostics: Covers Auth rejection diagnostics across HTTP webhook request handler, path normalization, JSON/method requirements, pre-auth and post-auth body handling, and related webhook ingress and auth verification behavior.

## Features

- Webhook path handling: Covers Webhook path handling across HTTP webhook request handler, path normalization, JSON/method requirements, pre-auth and post-auth body handling, and related webhook ingress and auth verification behavior.
- Standard Chat token verification: Covers Standard Chat token verification across HTTP webhook request handler, path normalization, JSON/method requirements, pre-auth and post-auth body handling, and related webhook ingress and auth verification behavior.
- Workspace add-on token verification: Covers Workspace add-on token verification across HTTP webhook request handler, path normalization, JSON/method requirements, pre-auth and post-auth body handling, and related webhook ingress and auth verification behavior.
- Audience and appPrincipal validation: Covers Audience and appPrincipal binding across HTTP webhook request handler, path normalization, JSON/method requirements, pre-auth and post-auth body handling, and related webhook ingress and auth verification behavior.
- Shared-path target selection: Covers Shared-path target selection across HTTP webhook request handler, path normalization, JSON/method requirements, pre-auth and post-auth body handling, and related webhook ingress and auth verification behavior.
- Auth rejection diagnostics: Covers Auth rejection diagnostics across HTTP webhook request handler, path normalization, JSON/method requirements, pre-auth and post-auth body handling, and related webhook ingress and auth verification behavior.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (70%)`
- Positive signals: Unit tests exercise the shared webhook pipeline wiring, rate-limit key derivation behind trusted proxies, add-on payload conversion, missing-token rejection, target selection when one candidate fails and another verifies, appPrincipal warnings, and google-auth transport hardening. The source uses shared ingress helpers rather than a raw bespoke HTTP handler.
- Negative signals: Coverage is mostly unit-level and simulated. There is no dedicated live/e2e test that receives a real Google Chat request from Google, verifies real JWT/cert behavior, and dispatches a real event through the gateway under public HTTPS exposure.
- Integration gaps: Add a live webhook proof for standard Chat and Workspace add-on payloads, covering both `audienceType: "app-url"` and `project-number`, with expected auth rejection logs for missing/incorrect `appPrincipal`.

## Quality Score

- Score: `Alpha (68%)`
- Gitcrawl reports: #65007 is open for add-on payload parsing rejecting valid space events and wildcard group allowlist behavior. Closed/recent #35095, #53888, #57542, #67786, and #71078 show app-url auth, appPrincipal, and silent 401 failures were a real support pattern. #77307 reports a regression where Google Chat message send failed with `unsupported_grant_type` after short patches did not address the issue.
- Discrawl reports: `discrawl search "Google Chat appPrincipal" --limit 10` returned multiple issue comments and review notes confirming the appPrincipal/JWT `sub` requirement confused operators and that logging/warnings were added later. `discrawl search "Google Chat setup service account audience" --limit 10` returned a Discord help thread debugging persistent 401s and add-on issuer/cert questions.
- Good qualities: The implementation authenticates before full body reads when a header bearer is present, uses a small pre-auth body budget for add-on tokens, logs explicit rejection reasons only when all candidates fail, uses shared target/auth helpers, supports shared webhook paths, and guards Google auth/cert fetches with an allowlisted SSRF policy and response-size limits.
- Bad qualities: The product contract is still nuanced: standard Chat issuer tokens, add-on issuer tokens, `app-url` audiences, `project-number` audiences, numeric principal bindings, and public webhook path exposure can all fail differently. Archive reports show these failures historically looked like generic 401 or `invalid payload` loops until recent logging improvements.
- Excluded from quality: Unit, integration, e2e, live, and runtime-flow test presence/depth were not used to raise or lower this Quality score.

## Completeness Score

- Score: `Beta (70%)`
- Surface instructions: evaluated against `references/completeness/google-chat.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Webhook path handling, Standard Chat token verification, Workspace add-on token verification, Audience and appPrincipal validation, Shared-path target selection, Auth rejection diagnostics.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Add live auth proof for both standard Chat API payloads and Workspace add-on payloads.
- Make auth failure output point to the exact Google Cloud field that should supply `appPrincipal`.
- Keep webhook docs and startup warnings synchronized with the exact `verifyGoogleChatRequest` branches.
- Add release smoke for public-path-only exposure so operators do not accidentally expose dashboard routes alongside `/googlechat`.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/channels/googlechat.md`: explains public HTTPS webhook exposure, Tailscale/Caddy/Cloudflare path-only routing, Google Chat bearer token verification, `audienceType`, `audience`, add-on pre-auth support, session routing, and webhook troubleshooting.
- `/Users/kevinlin/code/openclaw/docs/gateway/config-channels.md`: documents `channels.googlechat` fields including `audienceType`, `audience`, `webhookPath`, and `webhookUrl`.
- `/Users/kevinlin/code/openclaw/docs/gateway/security/index.md`: references Google Chat mutable-name matching controls.

### Source

- `/Users/kevinlin/code/openclaw/extensions/googlechat/src/monitor-webhook.ts`: normalizes webhook paths, uses shared request guards, limits pre-auth add-on body reads, parses add-on payloads into standard events, verifies targets, logs auth rejection reasons, and dispatches accepted events asynchronously.
- `/Users/kevinlin/code/openclaw/extensions/googlechat/src/auth.ts`: verifies app-url ID tokens, project-number signed JWTs, Chat issuer tokens, add-on issuer tokens, and expected add-on principals.
- `/Users/kevinlin/code/openclaw/extensions/googlechat/src/google-auth.runtime.ts`: restricts Google auth fetches to Google host suffixes, preserves proxy/mTLS behavior, limits response bodies, validates credential endpoint fields, and avoids process-global gaxios mutation.
- `/Users/kevinlin/code/openclaw/extensions/googlechat/src/monitor-routing.ts`: registers and selects webhook targets by normalized path.
- `/Users/kevinlin/code/openclaw/extensions/googlechat/src/gateway.ts`: starts per-account webhook monitors and records runtime path/status metadata.

### Integration tests

- No dedicated live Google Chat webhook test was found under `/Users/kevinlin/code/openclaw/extensions/qa-lab` or `qa/scenarios`.
- `/Users/kevinlin/code/openclaw/test/scripts/bundled-plugin-build-entries.test.ts`: covers Google Chat as a bundled/external plugin build entry, which protects packaging but does not prove live webhook auth.

### Unit tests

- `/Users/kevinlin/code/openclaw/extensions/googlechat/src/monitor-webhook.test.ts`: covers shared pipeline wiring, rate-limit keys, add-on payload conversion, missing-token rejection, warning copy, and shared-path target selection.
- `/Users/kevinlin/code/openclaw/extensions/googlechat/src/monitor.webhook-routing.test.ts`: covers webhook target routing and registration behavior.
- `/Users/kevinlin/code/openclaw/extensions/googlechat/src/google-auth.runtime.test.ts`: covers SSRF-guarded auth fetches, proxy/mTLS translation, response limits, isolated transports, header normalization, and service-account validation.
- `/Users/kevinlin/code/openclaw/extensions/googlechat/src/google-auth.runtime.test.ts` and `/Users/kevinlin/code/openclaw/extensions/googlechat/src/doctor-contract.test.ts`: provide auth/config regression coverage adjacent to the webhook path.

### Gitcrawl queries

Query:

`gitcrawl search issues "Google Chat invalid payload" --repo openclaw/openclaw --limit 15 --json number,title,state,updatedAt,url`

Results:

- Returned open #65007, `Google Chat add-on payload parsing rejects valid space events and wildcard group allowlist still blocks senders`, updated 2026-05-19.

Query:

`gitcrawl gh issue view 71078 --repo openclaw/openclaw --json number,title,state,updatedAt,url,body`

Results:

- Returned closed #71078, `Observability gap: verifyGoogleChatRequest reject reasons are swallowed; missing appPrincipal presents as opaque 401`, updated 2026-04-27.

Query:

`gitcrawl gh issue view 77307 --repo openclaw/openclaw --json number,title,state,updatedAt,url,body`

Results:

- Returned open #77307, a Google Chat regression report where a previously working channel failed with `unsupported_grant_type` after upgrading between 2026-04-29 and 2026-05-02.

### Discrawl queries

Query:

`/Users/kevinlin/.local/bin/discrawl search "Google Chat appPrincipal" --limit 10`

Results:

- Returned issue comments and PR discussion for #35095, #67786, #57542, and #71078 explaining that `appPrincipal` must be the JWT `sub` numeric value, not the service-account email, and that silent auth failures were later addressed with warnings and rejection logs.

Query:

`/Users/kevinlin/.local/bin/discrawl search "Google Chat setup service account audience" --limit 10`

Results:

- Returned a setup/debug thread where a user traced persistent 401s to add-on issuer/cert handling and audience/appPrincipal behavior.
