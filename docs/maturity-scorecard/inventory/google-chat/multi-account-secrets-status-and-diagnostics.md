---
title: "Google Chat - Multi Account Secrets Status and Diagnostics Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Google Chat - Multi Account Secrets Status and Diagnostics Maturity Note

## Summary

Google Chat account, SecretRef, and status plumbing is broad but still Alpha. The source supports top-level and account-scoped service accounts, env/file/inline credentials, shared defaults, SecretRef runtime assignment, status probes, config issues for missing audience fields, and mutable allowlist warnings. The maturity drag is that real Google Chat setup failures still surface as nuanced auth/runtime problems, and no live probe suite proves multi-account SecretRef behavior against Google APIs.

## Category Scope

This note covers `accounts`, `defaultAccount`, top-level and account credential inheritance, service account SecretRefs, runtime config assignments, env fallback, status snapshots, `channels status --probe`, Google Chat API probe, missing audience/audienceType issues, mutable allowlist warnings, directory peer/group listing, and operator diagnostics. It excludes the setup wizard details, webhook auth internals, and downstream message delivery behavior after an account is running.

## Features

- Account resolution: Covers Account resolution across `accounts`, `defaultAccount`, top-level and account credential inheritance, service account SecretRefs, and related multi account secrets status and diagnostics behavior.
- Service account SecretRefs: Covers Service account SecretRefs across `accounts`, `defaultAccount`, top-level and account credential inheritance, service account SecretRefs, and related multi account secrets status and diagnostics behavior.
- Env file and inline credentials: Covers Env file and inline credentials across `accounts`, `defaultAccount`, top-level and account credential inheritance, service account SecretRefs, and related multi account secrets status and diagnostics behavior.
- Channel status and probes: Covers Channel status and probes across `accounts`, `defaultAccount`, top-level and account credential inheritance, service account SecretRefs, and related multi account secrets status and diagnostics behavior.
- Directory and mutable-id diagnostics: Covers Directory and mutable-id diagnostics across `accounts`, `defaultAccount`, top-level and account credential inheritance, service account SecretRefs, and related multi account secrets status and diagnostics behavior.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Alpha (66%)`
- Positive signals: Unit tests cover default account resolution, env credential fallback, account-specific shared defaults, top-level credential inheritance, disabled account behavior, SecretRef registry entries, inactive secret warnings, status setup, directory listing, and status/probe fields.
- Negative signals: I found no live multi-account Google Chat proof covering two accounts on shared/different webhook paths, account-specific serviceAccountRef resolution, and real `channels status --probe` behavior against Google Chat API.
- Integration gaps: Add a live multi-account probe with one default/env account and one named SecretRef/file account, including disabled-account secrets, shared audience defaults, account-specific webhook path override, and status issue assertions.

## Quality Score

- Score: `Alpha (64%)`
- Gitcrawl reports: `gitcrawl search issues "Google Chat serviceAccount SecretRef setup"` returned no direct hits, but #77307 shows credential/auth regressions can break the entire channel, and appPrincipal/audience issues have a recent support trail. #58514 and #65007 show status can say HTTP accepted while space messages still do not produce useful runtime behavior.
- Discrawl reports: `discrawl search "Google Chat DMs work spaces" --limit 10` returned a config where `channels status --probe` reported Google Chat enabled/configured/running/works while the user still reported no useful message handling. `discrawl search "Google Chat setup service account audience" --limit 10` returned setup/auth debugging where the status path alone was not enough to identify the principal/audience problem.
- Good qualities: Account merging is explicit, SecretRef assignment entries are registered for top-level and account paths, disabled accounts produce inactive secret warnings, status summaries include credential source and audience fields, and the probe calls `spaces` with a service-account token through the same guarded API path.
- Bad qualities: Status can prove credentials and a shallow API call without proving webhook delivery, space admission, thread behavior, or action/media scopes. Multi-account configs inherit defaults in subtle ways, and unresolved SecretRefs intentionally fail outside active runtime snapshots, which can surprise CLI/action users.
- Excluded from quality: Unit, integration, e2e, live, and runtime-flow test presence/depth were not used to raise or lower this Quality score.

## Completeness Score

- Score: `Alpha (66%)`
- Surface instructions: evaluated against `references/completeness/google-chat.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Account resolution, Service account SecretRefs, Env file and inline credentials, Channel status and probes, Directory and mutable-id diagnostics.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Add status probes that distinguish credential health, webhook auth health, last inbound webhook, last accepted space/DM, and last dropped access-policy reason.
- Add live multi-account SecretRef proof for account-scoped service accounts and shared webhook/audience defaults.
- Include action/media OAuth capability in status so service-account-only limitations are visible before tool use.
- Improve CLI copy for unresolved SecretRefs outside an active gateway runtime snapshot.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/channels/googlechat.md`: documents `serviceAccount`, `serviceAccountFile`, `serviceAccountRef`, per-account refs, `audienceType`, `audience`, `webhookPath`, status/probe troubleshooting, and `plugins.entries.googlechat.enabled`.
- `/Users/kevinlin/code/openclaw/docs/gateway/secrets.md`: documents SecretRef behavior and Google Chat compatibility behavior.
- `/Users/kevinlin/code/openclaw/docs/reference/secretref-credential-surface.md`: lists `channels.googlechat.serviceAccount` and `channels.googlechat.accounts.*.serviceAccount`.
- `/Users/kevinlin/code/openclaw/docs/gateway/health.md`: lists Google Chat among channels with health monitor overrides.

### Source

- `/Users/kevinlin/code/openclaw/extensions/googlechat/src/accounts.ts`: resolves account IDs, shared defaults, env fallback for default account, per-account credential sources, and SecretRef errors outside runtime snapshots.
- `/Users/kevinlin/code/openclaw/extensions/googlechat/src/secret-contract.ts`: registers Google Chat service-account SecretRef targets and collects runtime config assignments with inactive-account warnings.
- `/Users/kevinlin/code/openclaw/extensions/googlechat/src/channel.ts`: builds computed account status, status issues for missing audience/audienceType, probe behavior, config adapters, directory adapter, and secret registry wiring.
- `/Users/kevinlin/code/openclaw/extensions/googlechat/src/api.ts`: implements `probeGoogleChat` through the Chat API `spaces` endpoint.
- `/Users/kevinlin/code/openclaw/extensions/googlechat/src/doctor.ts`: collects mutable allowlist warnings for DM and group fields.

### Integration tests

- No dedicated live Google Chat multi-account/SecretRef/status scenario was found under `/Users/kevinlin/code/openclaw/extensions/qa-lab` or `qa/scenarios`.
- `/Users/kevinlin/code/openclaw/src/secrets/runtime-external-channel-audit.test.ts`: includes Google Chat service-account surfaces in external channel secret auditing.
- `/Users/kevinlin/code/openclaw/src/secrets/target-registry.fast-path.test.ts`: covers the Google Chat service-account target registry fast path.

### Unit tests

- `/Users/kevinlin/code/openclaw/extensions/googlechat/src/setup.test.ts`: covers account resolution, env fallback, default-account and named-account inheritance, shared defaults, disabled accounts, and status wiring.
- `/Users/kevinlin/code/openclaw/extensions/googlechat/src/secret-contract.test.ts`: covers SecretRef target entries and runtime assignment behavior.
- `/Users/kevinlin/code/openclaw/extensions/googlechat/src/doctor-contract.test.ts`: covers legacy config/doctor compatibility rules.
- `/Users/kevinlin/code/openclaw/extensions/googlechat/src/channel.test.ts`: covers directory listing, status-adjacent adapters, target resolution, and account threading through sends.

### Gitcrawl queries

Query:

`gitcrawl search issues "Google Chat serviceAccount SecretRef setup" --repo openclaw/openclaw --limit 15 --json number,title,state,updatedAt,url`

Results:

- Returned no direct issue hits. This is neutral after successful archive freshness checks; status/setup risk came from broader Google Chat auth and delivery issues.

Query:

`gitcrawl gh issue view 77307 --repo openclaw/openclaw --json number,title,state,updatedAt,url,body`

Results:

- Returned open #77307, a regression report where Google Chat sends failed with `unsupported_grant_type`, showing credential/auth path fragility.

Query:

`gitcrawl gh issue view 58514 --repo openclaw/openclaw --json number,title,state,updatedAt,url,body`

Results:

- Returned open #58514, where HTTP requests were received and DMs worked, but group sessions were not created, showing shallow configured/running status is not enough.

### Discrawl queries

Query:

`/Users/kevinlin/.local/bin/discrawl search "Google Chat DMs work spaces" --limit 10`

Results:

- Returned a real config and status output showing Google Chat `enabled, configured, running, dm:pairing, works` while the user still reported messages not triggering useful logs.

Query:

`/Users/kevinlin/.local/bin/discrawl search "Google Chat setup service account audience" --limit 10`

Results:

- Returned setup/auth support discussion around service-account JSON, audience, and appPrincipal, demonstrating status and docs need to make principal/audience state more actionable.
