---
title: "Microsoft Teams - Channel Setup and Operations Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Microsoft Teams - Channel Setup and Operations Maturity Note

## Summary

Teams setup is well documented and backed by config/runtime source for bundled
plugin registration, environment variables, SecretRefs, client secrets,
certificate auth, and managed identity. Coverage stays Alpha because the audit
did not find a durable live tenant setup scorecard for Teams CLI app creation,
manifest upload, RSC/admin consent, app install, reinstall, and `teams app
doctor`.

## Normalization

Active category after channel taxonomy normalization.

- Normalized category: `Channel Setup and Operations`
- Merged from: `Setup and Diagnostics`, `Webhook and Delivery`
- Score carry-forward: conservative minimum of merged source category scores.

## Category Scope

Included in this category:

- Teams CLI app creation: Covers Microsoft Teams channel installation through `teams app create`, bot registration, manifest creation, credential generation, and setup verification.
- Bot registration and manifest upload: Covers Entra ID application registration, Azure Bot setup, Teams app manifest/RSC permissions, and Teams app package upload.
- Credential configuration: Covers CLIENT*ID, CLIENT_SECRET, TENANT_ID, `MSTEAMS*\*`environment variables, and OpenClaw`channels.msteams` credential configuration.
- Teams app install verification: Covers Teams install links, app installation in Teams, and `teams app doctor` verification after setup.
- Setup status: Covers Setup status across setup wizard status, credential prompts, env credential detection, setup docs, and related diagnostics and repair behavior.
- Probe and scope reporting: Covers Probe and scope reporting across setup wizard status, credential prompts, env credential detection, setup docs, and related diagnostics and repair behavior.
- Teams app doctor: Covers Teams app doctor across setup wizard status, credential prompts, env credential detection, setup docs, and related diagnostics and repair behavior.
- Webhook and health diagnostics: Covers Webhook and health diagnostics across setup wizard status, credential prompts, env credential detection, setup docs, and related diagnostics and repair behavior.
- Operator repair paths: Covers Operator repair paths across setup wizard status, credential prompts, env credential detection, setup docs, and related diagnostics and repair behavior.
- Text formatting and chunking: Covers Text formatting and chunking across outbound text chunking, markdown table conversion, payload media sequencing, semantic presentation rendering, and related outbound delivery and rendering behavior.
- Adaptive and presentation cards: Covers Adaptive and presentation cards across outbound text chunking, markdown table conversion, payload media sequencing, semantic presentation rendering, and related outbound delivery and rendering behavior.
- Progress streaming: Covers Progress streaming across outbound text chunking, markdown table conversion, payload media sequencing, semantic presentation rendering, and related outbound delivery and rendering behavior.
- Delivery receipts and errors: Covers Delivery receipts and errors across outbound text chunking, markdown table conversion, payload media sequencing, semantic presentation rendering, and related outbound delivery and rendering behavior.
- Queued and proactive replies: Covers Queued and proactive replies across outbound text chunking, markdown table conversion, payload media sequencing, semantic presentation rendering, and related outbound delivery and rendering behavior.
- Webhook Runtime: Covers Webhook Runtime across webhook server startup, SDK auth/JWT handling, bearer pre-gate, JSON body limits, and related webhook runtime, sdk lifecycle, and proactive cloud boundary behavior.
- SDK Lifecycle: Covers SDK Lifecycle across webhook server startup, SDK auth/JWT handling, bearer pre-gate, JSON body limits, and related webhook runtime, sdk lifecycle, and proactive cloud boundary behavior.
- Proactive Cloud Boundary: Covers Proactive Cloud Boundary across webhook server startup, SDK auth/JWT handling, bearer pre-gate, JSON body limits, and related webhook runtime, sdk lifecycle, and proactive cloud boundary behavior.
- Setup status: Covers Setup status across setup wizard status, credential prompts, env credential detection, setup docs, and related diagnostics and repair behavior
- Probe and scope reporting: Covers Probe and scope reporting across setup wizard status, credential prompts, env credential detection, setup docs, and related diagnostics and repair behavior
- Teams app doctor: Covers Teams app doctor across setup wizard status, credential prompts, env credential detection, setup docs, and related diagnostics and repair behavior
- Webhook and health diagnostics: Covers Webhook and health diagnostics across setup wizard status, credential prompts, env credential detection, setup docs, and related diagnostics and repair behavior
- Operator repair paths: Covers Operator repair paths across setup wizard status, credential prompts, env credential detection, setup docs, and related diagnostics and repair behavior
- Webhook Runtime: Covers Webhook Runtime across webhook server startup, SDK auth/JWT handling, bearer pre-gate, JSON body limits, and related webhook runtime, sdk lifecycle, and proactive cloud boundary behavior
- SDK Lifecycle: Covers SDK Lifecycle across webhook server startup, SDK auth/JWT handling, bearer pre-gate, JSON body limits, and related webhook runtime, sdk lifecycle, and proactive cloud boundary behavior
- Proactive Cloud Boundary: Covers Proactive Cloud Boundary across webhook server startup, SDK auth/JWT handling, bearer pre-gate, JSON body limits, and related webhook runtime, sdk lifecycle, and proactive cloud boundary behavior

## Features

- Teams CLI app creation: Covers Microsoft Teams channel installation through `teams app create`, bot registration, manifest creation, credential generation, and setup verification.
- Bot registration and manifest upload: Covers Entra ID application registration, Azure Bot setup, Teams app manifest/RSC permissions, and Teams app package upload.
- Credential configuration: Covers CLIENT*ID, CLIENT_SECRET, TENANT_ID, `MSTEAMS*\*`environment variables, and OpenClaw`channels.msteams` credential configuration.
- Teams app install verification: Covers Teams install links, app installation in Teams, and `teams app doctor` verification after setup.
- Setup status: Covers Setup status across setup wizard status, credential prompts, env credential detection, setup docs, and related diagnostics and repair behavior.
- Probe and scope reporting: Covers Probe and scope reporting across setup wizard status, credential prompts, env credential detection, setup docs, and related diagnostics and repair behavior.
- Teams app doctor: Covers Teams app doctor across setup wizard status, credential prompts, env credential detection, setup docs, and related diagnostics and repair behavior.
- Webhook and health diagnostics: Covers Webhook and health diagnostics across setup wizard status, credential prompts, env credential detection, setup docs, and related diagnostics and repair behavior.
- Operator repair paths: Covers Operator repair paths across setup wizard status, credential prompts, env credential detection, setup docs, and related diagnostics and repair behavior.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Alpha (58%)`
- Positive signals: Docs cover the Teams CLI quick setup, manual Azure Bot
  setup, credential config, RSC manifest permissions, app install links,
  manifest update/reinstall, Graph admin consent, and federated auth.
- Negative signals: No durable real-tenant install/admin scenario was found for
  `teams app create`, manifest upload, install, RSC grant, Graph admin consent,
  app reinstall, and `teams app doctor`.
- Integration gaps: Missing clean-room Teams tenant setup proof and missing
  repeated setup proof for client secret, certificate, and managed identity
  variants.

## Quality Score

- Score: `Alpha (64%)`
- Gitcrawl reports: Focused setup/manifest/tenant issue searches returned no
  direct hits; broad `msteams Microsoft Teams` search surfaced active Teams SDK,
  Graph tenant, member-info, attachment, and approval PRs.
- Discrawl reports: Broad Teams archive search showed maintainer desire for a
  Teams report and operator comments that Microsoft/Teams setup has many admin
  surfaces and settings.
- Good qualities: Docs are explicit about Teams CLI, manual Azure Bot setup,
  RSC permissions, manifest caveats, app reinstall, tenant credentials, and
  production auth alternatives.
- Bad qualities: The setup depends on preview Teams CLI behavior, Microsoft
  admin portals, app manifest cache/reinstall behavior, and tenant admin consent
  state that OpenClaw does not own.
- Excluded from quality: Unit-test count, runtime-flow breadth, and absence of
  live tests.

## Completeness Score

- Score: `Alpha (58%)`
- Surface instructions: evaluated against `references/completeness/microsoft-teams.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Teams CLI app creation, Bot registration and manifest upload, Credential configuration, Teams app install verification, Setup status, Probe and scope reporting, Teams app doctor, Webhook and health diagnostics, Operator repair paths.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Add a tenant setup scorecard that starts from a fresh Teams app and records
  CLI create, manifest upload, app install, RSC grants, Graph admin consent,
  app reinstall, and `teams app doctor`.
- Add scenario proof for certificate and managed-identity auth.
- Add failure-mode examples for blocked RSC permissions, sideload restrictions,
  stale manifest cache, and missing admin consent.

## Evidence

### Docs

- `docs/channels/msteams.md` documents bundled install, Teams CLI setup,
  manual Azure Bot setup, credential config, app install, app doctor, RSC
  permissions, manifest examples/caveats, Graph permissions, and troubleshooting.
- `docs/plugins/reference/msteams.md` identifies package `@openclaw/msteams`,
  install route, and channel surface.
- `docs/gateway/config-channels.md` links the `channels.msteams` config section
  back to the full Teams docs.

### Source

- `extensions/msteams/openclaw.plugin.json` registers plugin id `msteams`,
  channel `msteams`, and `MSTEAMS_APP_ID`, `MSTEAMS_APP_PASSWORD`,
  `MSTEAMS_TENANT_ID` env vars.
- `src/config/types.msteams.ts` defines credentials, cloud, webhook, auth,
  SecretInput, federated certificate, managed identity, access, routing,
  media, Graph, delegated auth, and SSO config.
- `extensions/msteams/src/token.ts` resolves config/env credentials, client
  secret auth, certificate auth, managed identity, and delegated token storage.
- `extensions/msteams/src/setup-core.ts` implements setup status and credential
  prompting.

### Integration tests

- `src/secrets/runtime-external-channel-audit.test.ts` covers runtime external
  channel SecretRef handling for `MSTEAMS_APP_PASSWORD`.
- No dedicated Teams real-tenant setup, manifest, admin consent, app install,
  or `teams app doctor` scenario was found by `rg`.

### Unit tests

- `extensions/msteams/src/token.test.ts` covers secret, env, certificate,
  managed identity, and backward-compatible credential resolution.
- `extensions/msteams/src/setup-surface.test.ts` covers setup status, env
  credential prompts, and config writeback.
- `extensions/msteams/src/channel.test.ts` covers config schema defaults and
  cloud/service URL validation.

### Gitcrawl queries

Query:

- `gitcrawl search issues "msteams Microsoft Teams app manifest tenant admin auth Graph SSO" -R openclaw/openclaw --state all --json number,title,state,url,updatedAt --limit 10`
- `gitcrawl search openclaw/openclaw --query "msteams setup Teams CLI manifest tenant credentials" --json --limit 10`
- `gitcrawl search openclaw/openclaw --query "msteams Microsoft Teams" --json --limit 10`

Results:

- The focused issue and setup keyword searches returned `[]`.
- The broad search returned active Teams PRs/issues including `#76262` Teams SDK
  migration, `#67174/#87169` Graph tenant work, `#78839` member-info action
  gate, `#66327` approval cards, and `#67177/#85845` attachment Graph shares.

### Discrawl queries

Query:

- `DISCRAWL_NO_AUTO_UPDATE=1 /Users/kevinlin/.local/bin/discrawl search --limit 10 "msteams setup manifest tenant admin install"`
- `DISCRAWL_NO_AUTO_UPDATE=1 /Users/kevinlin/.local/bin/discrawl search --limit 10 "Microsoft Teams"`

Results:

- The focused setup query returned no lines.
- The broad Microsoft Teams query returned maintainer/operator discussion about
  demand for a Teams report and the difficulty of getting Teams bots running
  across Microsoft admin surfaces.
