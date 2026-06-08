---
title: "Google provider path - Gemini CLI OAuth Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Google provider path - Gemini CLI OAuth Maturity Note

## Summary

The Gemini CLI OAuth path exists as a first-class Google-provider runtime, with
provider registration, CLI backend invocation, OAuth login/refresh, legacy ref
migration, and usage normalization. Coverage is Beta because setup, docs,
source, and unit evidence are present, but live proof is limited and the path is
policy-sensitive. Quality is Alpha because archives show active auth-precedence,
proxy, session, security, and setup confusion, and the docs explicitly warn
that the route is unofficial.

## Category Scope

This category covers the `google-gemini-cli` provider, canonical `google/*`
model refs using `agentRuntime.id: "google-gemini-cli"`, legacy
`google-gemini-cli/*` refs, Gemini CLI command invocation, OAuth login/refresh,
token formatting, project-aware OAuth credentials, and CLI usage normalization.
It excludes direct Gemini API-key transport, Vertex, prompt cache, and
Gemini Live.

## Features

- CLI runtime selection: Covers CLI runtime selection across `google-gemini-cli` provider, canonical `google/*` model refs using `agentRuntime.id: "google-gemini-cli"`, legacy `google-gemini-cli/*` refs, Gemini CLI command invocation, and related gemini cli oauth behavior.
- OAuth login and refresh: Covers OAuth login and refresh across `google-gemini-cli` provider, canonical `google/*` model refs using `agentRuntime.id: "google-gemini-cli"`, legacy `google-gemini-cli/*` refs, Gemini CLI command invocation, and related gemini cli oauth behavior.
- Canonical Google model refs: Covers Canonical Google model refs across `google-gemini-cli` provider, canonical `google/*` model refs using `agentRuntime.id: "google-gemini-cli"`, legacy `google-gemini-cli/*` refs, Gemini CLI command invocation, and related gemini cli oauth behavior.
- CLI usage normalization: Covers CLI usage normalization across `google-gemini-cli` provider, canonical `google/*` model refs using `agentRuntime.id: "google-gemini-cli"`, legacy `google-gemini-cli/*` refs, Gemini CLI command invocation, and related gemini cli oauth behavior.
- OAuth diagnostics: Covers OAuth diagnostics across `google-gemini-cli` provider, canonical `google/*` model refs using `agentRuntime.id: "google-gemini-cli"`, legacy `google-gemini-cli/*` refs, Gemini CLI command invocation, and related gemini cli oauth behavior.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (72%)`
- Positive signals: Docs cover setup and warnings; source implements provider
  registration, runtime policy, CLI backend invocation, OAuth login/refresh, and
  usage fetching; unit tests cover model forward-compatibility, setup metadata,
  and OAuth local-login behavior.
- Negative signals: Live/e2e proof for actual OAuth login, token refresh, and
  CLI command execution is sparse and dependent on local host state.
- Integration gaps: No always-on live flow was found that proves OAuth profile
  selection, canonical `google/*` routing, CLI invocation, and usage reporting
  together.

## Quality Score

- Score: `Alpha (60%)`
- Gitcrawl reports: #79585 reports Gemini CLI OAuth profile ignored for
  canonical `google/*` models when `GEMINI_API_KEY` is present; #46184 reports
  OAuth failing behind an HTTP proxy on macOS; #53578 reports slow turns after
  upgrade; #54289 raises security concerns around unauthorized OAuth credential
  extraction; #67609 was closed after fixing OAuth requests routed to the wrong
  Google host.
- Discrawl reports: Archives show doctor/setup confusion around current runtime
  selection, fixed Cloud Code transport metadata, and prior orphaned/broken
  Gemini CLI OAuth setup.
- Good qualities: The source keeps OAuth token formatting, refresh behavior,
  CLI backend serialization, and provider runtime selection in explicit Google
  plugin code.
- Bad qualities: The path depends on host-local CLI installation, local OAuth
  state, Google account policy, and runtime-profile precedence, all of which are
  visible sources of operational fragility.
- Excluded from quality: Unit, integration, e2e, live, and real runtime-flow
  test presence or absence; those are Coverage inputs only.

## Completeness Score

- Score: `Beta (72%)`
- Surface instructions: evaluated against `references/completeness/google-provider-path.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for CLI runtime selection, OAuth login and refresh, Canonical Google model refs, CLI usage normalization, OAuth diagnostics.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- The OAuth route is unofficial and account-restriction-sensitive.
- Host-local Gemini CLI installation and login state are outside OpenClaw's
  direct control.
- Archive evidence shows auth-precedence and provider-profile selection remain
  confusing for users.
- Usage normalization is implemented, but live proof with real CLI output is
  not broad.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/providers/google.md:70` warns that the
  `google-gemini-cli` provider is an unofficial integration.
- `/Users/kevinlin/code/openclaw/docs/providers/google.md:89` documents
  Gemini CLI OAuth login and `--set-default`.
- `/Users/kevinlin/code/openclaw/docs/providers/google.md:102` documents the
  runtime policy shape for canonical `google/*` model refs.
- `/Users/kevinlin/code/openclaw/docs/providers/google.md:124` documents legacy
  `google-gemini-cli/*` model refs.
- `/Users/kevinlin/code/openclaw/docs/providers/google.md:439` documents Gemini
  CLI JSON usage normalization.
- `/Users/kevinlin/code/openclaw/docs/concepts/model-providers.md:217`
  documents `google-gemini-cli`, login, default model, and usage parsing.

### Source

- `/Users/kevinlin/code/openclaw/extensions/google/gemini-cli-provider.ts:13`
  declares the provider id `google-gemini-cli`.
- `/Users/kevinlin/code/openclaw/extensions/google/gemini-cli-provider.ts:27`
  registers provider docs, auth warning, config patch, dynamic model resolution,
  OAuth hooks, and usage snapshot fetching.
- `/Users/kevinlin/code/openclaw/extensions/google/cli-backend.ts:14` registers
  the Gemini CLI backend command and session arguments.
- `/Users/kevinlin/code/openclaw/extensions/google/gemini-auth.ts:3` parses
  OAuth JSON token credentials into Google headers.
- `/Users/kevinlin/code/openclaw/extensions/google/oauth.ts:17` implements
  Gemini CLI OAuth login with PKCE, localhost callback, and manual fallback.
- `/Users/kevinlin/code/openclaw/extensions/google/oauth.ts:96` refreshes
  Gemini CLI OAuth tokens.
- `/Users/kevinlin/code/openclaw/extensions/google/oauth-token-shared.ts:9`
  parses project-aware OAuth token JSON.

### Integration tests

- `/Users/kevinlin/code/openclaw/src/gateway/gateway-models.profiles.live.test.ts:2019`
  includes live provider-ref handling for `google-gemini-cli`.
- `/Users/kevinlin/code/openclaw/src/agents/models.profiles.live.test.ts:1323`
  runs live model-profile paths with Google/Gemini CLI special handling.
- No dedicated always-on live OAuth login and CLI command execution test was
  found for this audit.

### Unit tests

- `/Users/kevinlin/code/openclaw/extensions/google/provider-models.test.ts:41`
  covers Gemini CLI forward-compatible model resolution.
- `/Users/kevinlin/code/openclaw/extensions/google/setup-api.test.ts:21` covers
  Gemini CLI backend setup metadata.
- `/Users/kevinlin/code/openclaw/extensions/google/oauth.local-login.test.ts:3`
  covers local OAuth login callback behavior.
- `/Users/kevinlin/code/openclaw/src/utils/provider-utils.test.ts:36` covers
  Gemini CLI provider classification.

### Gitcrawl queries

Query: `gitcrawl search issues "Gemini CLI OAuth google-gemini-cli" -R openclaw/openclaw --state all`

Results:

- #79585 `google-gemini-cli OAuth profile is ignored for canonical google/* models when GEMINI_API_KEY is present`.
- #46184 OAuth fails behind HTTP proxy on macOS.
- #53578 slow per-turn behavior after upgrade.
- #84527 adds Antigravity CLI as a replacement direction.
- #68216 Gemini CLI provider fails to write workspace identity files.
- #66093 CLI session reset fallback regression.
- #54289 unauthorized OAuth credential extraction concern.

Query: `gitcrawl search issues "google-gemini-cli provider routes OAuth requests" -R openclaw/openclaw --state all`

Results:

- #67609 closed after fixing OAuth requests routed to `generativelanguage.googleapis.com` instead of `cloudcode-pa.googleapis.com`.

### Discrawl queries

Query: `discrawl search --limit 5 "Gemini CLI OAuth google-gemini-cli"`

Results:

- Returned setup/doctor confusion where the user had a current runtime of
  `google-gemini-cli` while their primary model path was different.
- Returned #67609 closure notes that current main uses Cloud Code transport
  metadata for Gemini CLI OAuth.
- Returned #65318 closure notes around previously orphaned/broken Gemini CLI
  OAuth setup in v2026.4.10.
