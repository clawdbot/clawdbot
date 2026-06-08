---
title: "Native Windows - Native Onboarding, Config, and Credential Setup Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Native Windows - Native Onboarding, Config, and Credential Setup Maturity Note

## Summary

Native Windows onboarding is implemented through the shared CLI setup flow, with
Windows-specific health budgets and explicit Scheduled Task fallback messaging.
The feature is usable, but it is still caveated in docs and archive evidence
shows Windows onboarding can be slow or confusing when Gateway health, provider
catalog loading, or managed startup are involved.

## Category Scope

- `openclaw onboard` and `openclaw onboard --non-interactive` on native Windows.
- Local Gateway config, auth choice, gateway token/password SecretRef handling,
  workspace/bootstrap writes, and health checks.
- `--install-daemon`, `--skip-health`, and Windows-specific failure guidance.
- Separation between native Windows and WSL2 onboarding advice.

## Features

- openclaw onboard: openclaw onboard and openclaw onboard --non-interactive on native Windows
- Local Gateway config: Local Gateway config, auth choice, gateway token/password SecretRef handling, and local endpoint defaults.
- Daemon install flags: Daemon install flags for native Windows onboarding.
- Native-vs-WSL setup boundary: Setup boundary between native Windows Gateway and the recommended WSL2 path.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (72%)`
- Positive signals: onboarding docs and source cover interactive and
  non-interactive setup; Windows-specific timing constants and managed-startup
  hints exist; tests cover non-interactive gateway health and daemon install
  behavior.
- Negative signals: native Windows onboarding is still documented with caveats,
  and the real-environment proof trail is not as broad as macOS/Linux.
- Integration gaps: no current live native Windows scenario was found for
  install script -> onboarding -> daemon install -> Gateway health -> provider
  auth -> first agent turn.

## Quality Score

- Score: `Alpha (66%)`
- Gitcrawl reports: `Windows onboarding` returned issue #82594 for extremely
  slow model loading on Windows during onboarding and other Windows setup
  reports.
- Discrawl reports: native Windows summaries mention onboarding stabilization,
  longer Windows Gateway health budgets, and support confusion between native
  PowerShell and WSL2 setup commands.
- Good qualities: non-interactive setup fails closed for unresolved Gateway
  auth refs, has Windows-specific health budgets, and explicitly tells Windows
  users when managed startup uses Scheduled Tasks or Startup-folder fallback.
- Bad qualities: the setup path is still easy to run in the wrong environment,
  and provider/model discovery latency can make Windows onboarding feel broken.
- Excluded from quality: unit, integration, e2e, live, and runtime-flow test
  evidence is recorded only under Coverage and Evidence.

## Completeness Score

- Score: `Beta (72%)`
- Surface instructions: evaluated against `references/completeness/native-windows-cli-and-gateway.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for openclaw onboard, Local Gateway config, Daemon install flags, Native-vs-WSL setup boundary.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Add native Windows onboarding scenario proof for both `--install-daemon` and
  CLI-only `--skip-health` paths.
- Add sharper docs for choosing native PowerShell versus WSL2 before the user
  runs installer/onboarding commands.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/cli/onboard.md:81` documents
  non-interactive custom provider setup.
- `/Users/kevinlin/code/openclaw/docs/cli/onboard.md:138` documents Gateway
  token options and SecretRef behavior in non-interactive mode.
- `/Users/kevinlin/code/openclaw/docs/cli/onboard.md:164` states that
  non-interactive local setup waits for a reachable local Gateway unless
  `--skip-health` is passed.
- `/Users/kevinlin/code/openclaw/docs/cli/onboard.md:170` documents the native
  Windows managed-startup fallback.
- `/Users/kevinlin/code/openclaw/docs/platforms/windows.md:37` lists native
  onboarding caveats.

### Source

- `/Users/kevinlin/code/openclaw/src/cli/program/register.onboard.ts:91`
  registers the `openclaw onboard` command and flags.
- `/Users/kevinlin/code/openclaw/src/cli/program/register.onboard.ts:148`
  registers Gateway port/bind/auth flags.
- `/Users/kevinlin/code/openclaw/src/commands/onboard-non-interactive/local.ts:33`
  defines longer Windows daemon health budgets.
- `/Users/kevinlin/code/openclaw/src/commands/onboard-non-interactive/local.ts:262`
  invokes non-interactive daemon install.
- `/Users/kevinlin/code/openclaw/src/commands/onboard-non-interactive/local.ts:355`
  emits Windows-specific managed-startup guidance when health fails.

### Integration tests

- `/Users/kevinlin/code/openclaw/scripts/e2e/onboard-docker.sh` exercises the
  shared onboarding path in Docker.
- `/Users/kevinlin/code/openclaw/scripts/e2e/release-typed-onboarding-docker.sh`
  covers release onboarding scenarios.
- `/Users/kevinlin/code/openclaw/scripts/e2e/parallels-windows-smoke.sh:1`
  dispatches the native Windows smoke lane.

### Unit tests

- `/Users/kevinlin/code/openclaw/src/commands/onboard-non-interactive.gateway.test.ts`
  covers non-interactive Gateway setup, health, and daemon install mocks.
- `/Users/kevinlin/code/openclaw/src/commands/onboard-auth.config-shared.test.ts`
  covers onboarding auth config behavior.
- `/Users/kevinlin/code/openclaw/src/commands/onboard-non-interactive.gateway-health-auth.test.ts`
  covers Gateway health auth handling.
- `/Users/kevinlin/code/openclaw/src/cli/program/register.onboard.test.ts`
  covers CLI flag registration including daemon install flags.

### Gitcrawl queries

Query:

- `gitcrawl search openclaw/openclaw --query "native Windows onboarding install-daemon skip-health gateway health" --mode keyword --limit 5 --json`
- `gitcrawl search openclaw/openclaw --query "Windows onboarding" --mode keyword --limit 5 --json`

Results:

- The narrow native onboarding query returned 0 hits.
- `Windows onboarding` returned issue #82594 for slow Windows model loading
  during onboarding, plus setup/config related issue and PR signal.

### Discrawl queries

Query:

- `DISCRAWL_NO_AUTO_UPDATE=1 /Users/kevinlin/.local/bin/discrawl search --mode hybrid --limit 4 "native Windows onboarding install-daemon skip-health gateway health"`
- `DISCRAWL_NO_AUTO_UPDATE=1 /Users/kevinlin/.local/bin/discrawl search --mode hybrid --limit 4 "install.ps1 Windows PowerShell installer"`

Results:

- The narrow native onboarding query returned no direct hits.
- The installer query returned maintainer summaries that native Windows
  onboarding had stabilization work, startup progress indicators, and longer
  Gateway health budgets because Windows startup is slower/noisier than Linux.
