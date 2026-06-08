---
title: "Security, auth, pairing, and secrets - Credential and Secret Hygiene Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Security, auth, pairing, and secrets - Credential and Secret Hygiene Maturity Note

## Summary

OpenClaw has a strong SecretRef and redaction system: supported credentials can move out of plaintext config, startup and reload use resolved runtime snapshots, audit reports plaintext/unresolved/shadowed residues, and UI/config snapshots use redaction sentinels. Coverage is Stable because docs and source are broad and runtime proof spans resolution, audits, redaction, gateway auth surfaces, plugin/channel targets, and apply/configure flows. Quality is Beta because operators still frequently discover plaintext residues, OAuth legacy residues are intentionally out of scope, and some unsupported surfaces require careful interpretation.

## Category Scope

Included in this category:

- Provider Auth Profiles: Covers Provider Auth Profiles across provider credentials and auth health as a security/secrets surface: API keys, OAuth profiles, `auth-profiles.json`, auth order, and related provider auth profiles and api key health behavior.
- API Key Health: Covers API Key Health across provider credentials and auth health as a security/secrets surface: API keys, OAuth profiles, `auth-profiles.json`, auth order, and related provider auth profiles and api key health behavior.
- Secrets Storage: Covers Secrets Storage across SecretRef contract and providers, runtime secret snapshots, gateway auth SecretRefs, auth-profile and generated model residues, and related secrets storage, redaction, and configuration hygiene behavior.
- Redaction: Covers Redaction across SecretRef contract and providers, runtime secret snapshots, gateway auth SecretRefs, auth-profile and generated model residues, and related secrets storage, redaction, and configuration hygiene behavior.
- Configuration Hygiene: Covers Configuration Hygiene across SecretRef contract and providers, runtime secret snapshots, gateway auth SecretRefs, auth-profile and generated model residues, and related secrets storage, redaction, and configuration hygiene behavior.

## Features

- Provider Auth Profiles: Covers Provider Auth Profiles across provider credentials and auth health as a security/secrets surface: API keys, OAuth profiles, `auth-profiles.json`, auth order, and related provider auth profiles and api key health behavior.
- API Key Health: Covers API Key Health across provider credentials and auth health as a security/secrets surface: API keys, OAuth profiles, `auth-profiles.json`, auth order, and related provider auth profiles and api key health behavior.
- Secrets Storage: Covers Secrets Storage across SecretRef contract and providers, runtime secret snapshots, gateway auth SecretRefs, auth-profile and generated model residues, and related secrets storage, redaction, and configuration hygiene behavior.
- Redaction: Covers Redaction across SecretRef contract and providers, runtime secret snapshots, gateway auth SecretRefs, auth-profile and generated model residues, and related secrets storage, redaction, and configuration hygiene behavior.
- Configuration Hygiene: Covers Configuration Hygiene across SecretRef contract and providers, runtime secret snapshots, gateway auth SecretRefs, auth-profile and generated model residues, and related secrets storage, redaction, and configuration hygiene behavior.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Stable (84%)`
- Positive signals: The secrets docs are detailed; source includes a dedicated runtime snapshot system, audit scanner, target registry, SecretRef schema, config redaction, and gateway methods; tests cover many credential targets and failure modes.
- Negative signals: Coverage of external credential managers and real exec SecretRef provider integrations is less visible than env/file/static paths, and the audit model intentionally cannot cover arbitrary unsupported files.
- Integration gaps: Add recurring operator scenario proof for migrating gateway auth, channel tokens, provider keys, plugin config secrets, generated models residues, and runtime reload on macOS/Linux/Docker.

## Quality Score

- Score: `Beta (76%)`
- Gitcrawl reports: The exact issue query returned no local issue rows. The relevant PR/comment archive evidence instead appears in Discord, including review on MCP URL-like plaintext false negatives.
- Discrawl reports: The exact Discord query found repeated real `secrets audit` outputs with plaintext gateway tokens, channel tokens, generated model API keys, `.env` keys, unresolved refs, and OAuth legacy residue; maintainers explain migration order and caveats.
- Good qualities: SecretRefs fail fast for active unresolved refs, reload is atomic, audit has structured findings and exit codes, config snapshots use redaction sentinels, and docs explicitly state that SecretRefs are not process isolation.
- Bad qualities: Operators still need to understand plaintext residues, generated model files, OAuth residue, unsupported surfaces, and SecretRef provider availability; audit false negatives for embedded credentials in URL-like values were still under review.
- Excluded from quality: Coverage breadth, unit-test breadth, and integration-test depth are scored only under Coverage.

## Completeness Score

- Score: `Stable (84%)`
- Surface instructions: evaluated against `references/completeness/security-auth-pairing-and-secrets.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Provider Auth Profiles, API Key Health, Secrets Storage, Redaction, Configuration Hygiene.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- SecretRef migration is opt-in and does not make readable plaintext files safe.
- OAuth credentials remain a distinct residue class outside static SecretRef migration.
- Some URL-like or plugin-specific credential shapes require ongoing target-registry and audit updates.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/gateway/secrets.md` documents SecretRef runtime snapshots, active-surface filtering, provider contracts, gateway auth diagnostics, file/exec provider safety, and migration limits.
- `/Users/kevinlin/code/openclaw/docs/cli/secrets.md` documents audit, configure, apply, reload, exit codes, plan behavior, and no-rollback plaintext scrubbing.
- `/Users/kevinlin/code/openclaw/docs/reference/secretref-credential-surface.md` and `/Users/kevinlin/code/openclaw/docs/reference/secret-placeholder-conventions.md` document supported credential targets and placeholder conventions.
- `/Users/kevinlin/code/openclaw/docs/gateway/security/audit-checks.md` documents config, auth-profile, credentials-dir, log-file, hook-token, and logging redaction checks.

### Source

- `/Users/kevinlin/code/openclaw/src/secrets/runtime.ts` prepares and activates resolved runtime snapshots.
- `/Users/kevinlin/code/openclaw/src/secrets/audit.ts` scans config, auth profiles, generated model stores, `.env`, unresolved refs, shadowing, and legacy residues.
- `/Users/kevinlin/code/openclaw/src/secrets/target-registry.ts` and `/Users/kevinlin/code/openclaw/src/secrets/target-registry-data.ts` define supported secret-bearing surfaces.
- `/Users/kevinlin/code/openclaw/src/config/redact-snapshot.ts` redacts sensitive config values and uses `__OPENCLAW_REDACTED__` for safe UI round trips.
- `/Users/kevinlin/code/openclaw/src/logging/redact.ts` and `/Users/kevinlin/code/openclaw/src/logging/diagnostic-support-redaction.ts` provide log and diagnostic redaction.

### Integration tests

- `/Users/kevinlin/code/openclaw/src/secrets/runtime.auth.integration.test.ts` and `/Users/kevinlin/code/openclaw/src/secrets/runtime.gateway-auth.integration.test.ts` cover runtime secret activation with auth surfaces.
- `/Users/kevinlin/code/openclaw/src/secrets/runtime-config-collectors-channels.test.ts` and `/Users/kevinlin/code/openclaw/src/secrets/runtime-config-collectors-plugins.test.ts` cover channel and plugin secret collectors.
- `/Users/kevinlin/code/openclaw/src/secrets/runtime-web-tools-public-artifacts.runtime.ts`, `/Users/kevinlin/code/openclaw/src/secrets/runtime-web-tools-manifest.runtime.ts`, and `/Users/kevinlin/code/openclaw/src/secrets/runtime-manifest.runtime.ts` cover runtime/plugin manifest surfaces.
- `/Users/kevinlin/code/openclaw/src/cli/secrets-cli.test.ts` covers CLI secret command behavior.

### Unit tests

- `/Users/kevinlin/code/openclaw/src/secrets/audit.test.ts`, `/Users/kevinlin/code/openclaw/src/secrets/apply.test.ts`, `/Users/kevinlin/code/openclaw/src/secrets/configure.test.ts`, `/Users/kevinlin/code/openclaw/src/secrets/resolve.test.ts`, and `/Users/kevinlin/code/openclaw/src/secrets/ref-contract.test.ts` cover audit, apply, configure, resolution, and SecretRef schema.
- `/Users/kevinlin/code/openclaw/src/config/redact-snapshot.test.ts`, `/Users/kevinlin/code/openclaw/src/config/redact-snapshot.raw.test.ts`, and `/Users/kevinlin/code/openclaw/src/config/sessions/transcript-append-redact.test.ts` cover redaction.
- `/Users/kevinlin/code/openclaw/src/logging/log-tail-redaction.test.ts`, `/Users/kevinlin/code/openclaw/src/logging/logger-redaction-behavior.test.ts`, and `/Users/kevinlin/code/openclaw/src/logging/redact.test.ts` cover log redaction.
- `/Users/kevinlin/code/openclaw/src/gateway/server-methods/secrets.test.ts` covers Gateway secrets methods.

### Gitcrawl queries

Query: `gitcrawl --json search issues -R openclaw/openclaw "SecretRef secrets audit plaintext credentials redaction"`

Results:

- Returned `[]` in the current local issue archive.

Query: `gitcrawl --json search prs -R openclaw/openclaw "SecretRef secrets audit plaintext credentials redaction"`

Results:

- Returned `[]` in the current local PR archive.

### Discrawl queries

Query: `DISCRAWL_NO_AUTO_UPDATE=1 /Users/kevinlin/.local/bin/discrawl search --limit 10 "SecretRef secrets audit plaintext credentials redaction"`

Results:

- Returned no visible rows.

Query: `DISCRAWL_NO_AUTO_UPDATE=1 /Users/kevinlin/.local/bin/discrawl search --limit 10 "SecretRef plaintext credentials audit"`

Results:

- Found multiple March-April support cases with `secrets audit` plaintext findings for `gateway.auth.token`, channel tokens, plugin API keys, generated `models.json` keys, `.env` keys, unresolved refs, and OAuth legacy residue.
- Found a review comment on PR #69417 noting that URL-like MCP env/header values with embedded credentials could be missed by audit if checked only as URLs.
