---
title: CLI - Onboarding and Auth Setup Maturity Note
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# CLI - Onboarding and Auth Setup Maturity Note

## Summary

The CLI has a broad onboarding and reconfiguration surface that covers workspace
setup, gateway mode, provider auth, SecretRef-backed storage, and remote versus
local gateway choices. Coverage is strong because the flows are well documented
and heavily tested; quality is lower than coverage because auth and remote/local
gateway splits remain subtle.

## Category Scope

This category covers `openclaw onboard`, `openclaw configure`, auth choices,
gateway auth persistence, and remote onboarding behavior. It does not cover
plugin/channel specifics or managed gateway service lifecycle.

## Features

- Guided onboarding: openclaw onboard walks through workspace, gateway, model auth, channels, skills, and health setup.
- Targeted reconfiguration: openclaw configure lets operators revisit only the sections they want to change after the initial setup.
- Auth choices: Onboarding and configure support API-key, OAuth, and other provider-specific auth choices.
- Gateway auth storage: Gateway token and password setup are documented, including SecretRef-managed storage behavior.
- Remote onboarding: Remote-gateway onboarding documents what is configured locally versus what must already exist on the remote host.

## Archive Freshness

- gitcrawl: `last_sync_at=2026-05-28T19:09:52.784704Z`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `repository_count=2`, `api_supported=false`, `github_token_present=false`.
- discrawl: `generated_at=2026-05-30T01:10:41Z`, `state=current`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `share.needs_update=true`.

## Coverage Score

- Score: `Stable (86%)`
- Positive signals:
  - `docs/cli/onboard.md`, `docs/cli/configure.md`, and `docs/start/onboarding-overview.md` document interactive, non-interactive, local, remote, OAuth, API-key, and SecretRef flows.
  - Onboarding and configure implementations are split into dedicated modules in `src/commands/onboard.ts`, `src/commands/onboard-interactive.ts`, `src/commands/onboard-non-interactive.ts`, `src/commands/configure.ts`, and `src/commands/configure.gateway-auth.ts`.
  - Gateway token persistence and SecretRef safeguards exist in `src/commands/gateway-install-token.ts`.
  - Remote onboarding behavior is directly exercised in `src/commands/onboard-remote.test.ts`.
- Negative signals:
  - Auth, provider, and remote/local gateway behavior spans many modules and configuration branches.
  - Real-environment proof is thinner than the command and config test surface.
- Integration gaps:
  - No dedicated full-flow e2e for onboarding a real remote gateway plus provider auth was found in the main repo.

## Quality Score

- Score: `Beta (78%)`
- Gitcrawl reports:
  - Query `gitcrawl search issues "onboard configure auth remote gateway" -R openclaw/openclaw --state open --json number,title,url,state --limit 5` returned one open hit: `#59165 RFC: Credential Provider Plugin`.
- Discrawl reports:
  - Query `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 5 "openclaw onboard auth remote gateway"` surfaced discussion around the old remote-token alignment failure mode and operator confusion when local and remote token surfaces diverge.
- Good qualities:
  - The docs explicitly distinguish local onboarding from remote onboarding.
  - SecretRef-managed gateway token handling fails closed instead of silently baking plaintext into service metadata.
  - Auth choice and provider-specific behavior are implemented through dedicated modules instead of scattered ad hoc prompts.
- Bad qualities:
  - Gateway auth and remote token semantics are subtle enough to have produced prior operator confusion.
  - The breadth of supported provider and auth combinations increases the chance of edge-case drift.
- Excluded from quality:
  - The onboarding and auth test files listed below provide coverage corroboration only.

## Known Gaps

- No repo-local e2e proof for a full remote-gateway onboarding journey was found.
- Provider breadth increases the long-tail maintenance burden of this surface.

## Evidence

### Docs

- `docs/cli/onboard.md`
- `docs/cli/configure.md`
- `docs/start/onboarding-overview.md`

### Source

- `src/commands/onboard.ts`
- `src/commands/onboard-interactive.ts`
- `src/commands/onboard-non-interactive.ts`
- `src/commands/configure.ts`
- `src/commands/configure.gateway-auth.ts`
- `src/commands/gateway-install-token.ts`

### Integration tests

- None found for a full remote-gateway plus provider-auth end-to-end flow.

### Unit tests

- `src/commands/onboard-remote.test.ts`
- `src/commands/onboard-auth.config-shared.test.ts`
- `src/commands/onboard-search.test.ts`
- `src/commands/onboard-non-interactive.gateway.test.ts`
- `src/commands/configure.gateway.test.ts`
- `src/commands/auth-choice.test.ts`

### Surface validation commands

- `none declared in taxonomy`: `pass` - CLI surface does not declare extra validation commands for scoring.

### Gitcrawl queries

Query:

- `gitcrawl search issues "onboard configure auth remote gateway" -R openclaw/openclaw --state open --json number,title,url,state --limit 5`

Results:

- `[{"number":59165,"state":"open","title":"RFC: Credential Provider Plugin","url":"https://github.com/openclaw/openclaw/issues/59165"}]`

### Discrawl queries

Query:

- `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 5 "openclaw onboard auth remote gateway"`

Results:

- Archive hits discuss the historical `gateway.remote.token` mismatch confusion and show that this area has needed careful explanation even when the immediate bug was later considered non-reproducible on current `main`.
