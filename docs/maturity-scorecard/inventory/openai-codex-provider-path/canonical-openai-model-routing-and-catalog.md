---
title: "OpenAI / Codex provider path - Model and Auth Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# OpenAI / Codex provider path - Model and Auth Maturity Note

## Summary

Canonical model routing is one of the better covered parts of the surface. Docs explicitly separate `openai`, `openai-codex`, the `codex` plugin, provider/model runtime policy, and `/codex` controls. Source has dedicated helpers for default Codex runtime selection, legacy ref detection, dynamic OpenAI and Codex catalog synthesis, context metadata, image-capable model repair, and doctor route repair. Quality remains Beta because archive evidence shows users still hit stale `openai-codex/*` route state and confuse provider, runtime, and auth names after updates.

## Category Scope

Included in this category:

- Canonical OpenAI Model Routing: Covers Canonical OpenAI Model Routing across user/operator-facing model route contract: canonical `openai/gpt-*` refs, legacy `openai-codex/*` model refs, model catalog rows, context limits, and related canonical openai model routing and catalog behavior.
- Catalog: Covers Catalog across user/operator-facing model route contract: canonical `openai/gpt-*` refs, legacy `openai-codex/*` model refs, model catalog rows, context limits, and related canonical openai model routing and catalog behavior.
- Codex OAuth Profiles: Covers Codex OAuth Profiles across `openai-codex` auth profiles, profile ordering, profile metadata repair, token refresh, account-id propagation, usage/cooldown handling, and auth selection for Codex-backed OpenAI agent turns.
- Subscription Usage: Covers Subscription Usage across `openai-codex` auth profiles, profile ordering, profile metadata repair, token refresh, account-id propagation, usage/cooldown handling, and auth selection for Codex-backed OpenAI agent turns.
- Doctor Diagnostics: Covers Doctor Diagnostics across operator-facing repair and diagnosis for OpenAI/Codex provider path problems: stale route migration, persisted session pins, runtime pins, auth-profile sidecars, profile metadata, status/probe output, and recovery commands.
- Operator Repair: Covers Operator Repair across operator-facing repair and diagnosis for OpenAI/Codex provider path problems: stale route migration, persisted session pins, runtime pins, auth-profile sidecars, profile metadata, status/probe output, and recovery commands.

## Features

- Canonical OpenAI Model Routing: Covers Canonical OpenAI Model Routing across user/operator-facing model route contract: canonical `openai/gpt-*` refs, legacy `openai-codex/*` model refs, model catalog rows, context limits, and related canonical openai model routing and catalog behavior.
- Catalog: Covers Catalog across user/operator-facing model route contract: canonical `openai/gpt-*` refs, legacy `openai-codex/*` model refs, model catalog rows, context limits, and related canonical openai model routing and catalog behavior.
- Codex OAuth Profiles: Covers Codex OAuth Profiles across `openai-codex` auth profiles, profile ordering, profile metadata repair, token refresh, account-id propagation, usage/cooldown handling, and auth selection for Codex-backed OpenAI agent turns.
- Subscription Usage: Covers Subscription Usage across `openai-codex` auth profiles, profile ordering, profile metadata repair, token refresh, account-id propagation, usage/cooldown handling, and auth selection for Codex-backed OpenAI agent turns.
- Doctor Diagnostics: Covers Doctor Diagnostics across operator-facing repair and diagnosis for OpenAI/Codex provider path problems: stale route migration, persisted session pins, runtime pins, auth-profile sidecars, profile metadata, status/probe output, and recovery commands.
- Operator Repair: Covers Operator Repair across operator-facing repair and diagnosis for OpenAI/Codex provider path problems: stale route migration, persisted session pins, runtime pins, auth-profile sidecars, profile metadata, status/probe output, and recovery commands.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Stable (82%)`
- Positive signals: Docs explain the naming map and route table; source has dedicated route/default helpers and provider plugins; unit and e2e tests cover model listing, route repair, and compatibility behavior.
- Negative signals: Full release-lane proof for every OpenAI/Codex catalog and route migration combination is not visible in one standard scorecard.
- Integration gaps: Upgrade survival for stale session pins and legacy refs is still proven by scattered doctor/runtime tests plus archive follow-up rather than a single release proof.

## Quality Score

- Score: `Beta (70%)`
- Gitcrawl reports: Open issues #87436, #80628, #84637, #87650, #84200, #84038, #83223, and #84252 all involve OpenAI/Codex route, runtime, text-verbosity, or doctor/status confusion.
- Discrawl reports: Discord discussion on 2026-05-17 describes `openai/gpt-5.5` incorrectly reaching direct OpenAI Responses because of stale provider/runtime/auth pins; a 2026-04-14 thread distinguishes `openai-codex/*` from `codex/*` harness usage.
- Good qualities: The source encodes the provider/runtime split instead of relying on string comments; docs give concrete recovery commands.
- Bad qualities: The naming is still easy to misread, and stale session state can override current config.
- Excluded from quality: Unit, integration, e2e, and live-test presence were used only as Coverage evidence.

## Completeness Score

- Score: `Stable (82%)`
- Surface instructions: evaluated against `references/completeness/openai-codex-provider-path.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Canonical OpenAI Model Routing, Catalog, Codex OAuth Profiles, Subscription Usage, Doctor Diagnostics, Operator Repair.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Route repair needs stronger release proof across persisted session state, auth-profile pins, and runtime pins.
- Operator output should make `openai/*`, `openai-codex/*`, and `codex/*` differences hard to miss.
- The score depends on current provider catalog behavior, which changes frequently.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/providers/openai.md` documents canonical `openai/*`, legacy `openai-codex/*` repair, the naming map, route summaries, GPT-5.5 context caps, and catalog recovery.
- `/Users/kevinlin/code/openclaw/docs/plugins/codex-harness.md` documents the recommended `openai/gpt-*` model refs, runtime selection, `/status` verification, and the distinction from ACP/acpx.
- `/Users/kevinlin/code/openclaw/docs/concepts/models.md` documents model/provider/runtime separation used by this path.

### Source

- `/Users/kevinlin/code/openclaw/src/agents/openai-codex-routing.ts` implements OpenAI provider detection, official-base-url defaulting to Codex runtime, auth provider selection, and route/provider normalization.
- `/Users/kevinlin/code/openclaw/extensions/openai/openai-provider.ts` synthesizes modern OpenAI GPT rows, context windows, media input, and Responses transport metadata.
- `/Users/kevinlin/code/openclaw/extensions/openai/openai-codex-provider.ts` normalizes Codex transport fields, synthesizes Codex model rows, restores image input capability, and exposes Codex usage/auth behavior.
- `/Users/kevinlin/code/openclaw/src/commands/doctor/shared/codex-route-warnings.ts` detects and repairs legacy `openai-codex/*` config and stale runtime/session route state.

### Integration tests

- `/Users/kevinlin/code/openclaw/src/commands/models.list.e2e.test.ts` exercises model list behavior, provider catalog rows, auth visibility, and catalog failure reporting.
- `/Users/kevinlin/code/openclaw/src/agents/embedded-agent-runner.run-embedded-agent.auth-profile-rotation.e2e.test.ts` covers model/provider fallback and auth-profile rotation behavior in embedded runs.
- `/Users/kevinlin/code/openclaw/src/gateway/gateway-codex-harness.live.test.ts` contains opt-in live Codex harness routing probes.

### Unit tests

- `/Users/kevinlin/code/openclaw/src/agents/model-runtime-policy.ts` is covered by adjacent runtime policy tests for model/provider runtime selection.
- `/Users/kevinlin/code/openclaw/extensions/openai/openai-provider.test.ts` and `extensions/openai/openai-codex-provider.test.ts` cover provider normalization and Codex model behavior.
- `/Users/kevinlin/code/openclaw/src/commands/doctor/shared/codex-route-warnings.test.ts` covers doctor repair of legacy Codex route state.

### Gitcrawl queries

Query: `gitcrawl --json search issues -R openclaw/openclaw "openai gpt-5.5 codex runtime openai/gpt openai-codex route doctor"`

Results:

- Returned open issues #87436, #80628, #84637, #87650, #84200, #84038, #83223, #84252, #81213, and #87168, including stale route recreation, protected-route drift, Codex runtime/model confusion, and doctor/status recovery failures.

Query: `gitcrawl --json search prs -R openclaw/openclaw "openai-codex doctor route auth profile Codex harness"`

Results:

- Returned PR #81700, `fix(auth): drop stale Codex OAuth routing`, plus adjacent provider-runtime work.

### Discrawl queries

Query: `discrawl search --limit 10 "openai gpt-5.5 codex runtime openai/gpt openai-codex route doctor"`

Results:

- Returned a 2026-05-17 maintainer discussion describing stale persisted route state and direct OpenAI Responses selection for `openai/gpt-5.5`, plus 2026-05-10 and 2026-05-09 notes around PR #80017 and OAuth-only config still reaching direct OpenAI API-key auth.

Query: `discrawl search --limit 10 "codex app-server harness thread compact /codex status native codex"`

Results:

- Returned a 2026-04-14 discussion distinguishing `openai-codex/*` as the Codex OAuth provider path from `codex/*` as the native app-server harness, including usage and compaction tradeoffs.
