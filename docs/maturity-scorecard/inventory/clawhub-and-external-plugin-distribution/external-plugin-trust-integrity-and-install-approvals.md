---
title: "ClawHub - External Plugin Trust, Integrity, and Install Approvals Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# ClawHub - External Plugin Trust, Integrity, and Install Approvals Maturity Note

## Summary

External plugin trust is explicit and comparatively robust: docs warn that
installing a plugin is equivalent to running code, ClawHub install verifies
artifact hashes, npm install checks integrity drift, and install-time scans can
block dangerous code. Coverage is Beta because there is strong unit/runtime
coverage but less live registry proof. Quality is Stable because the
implementation is fail-closed in the important places and the trust boundary is
plainly documented.

## Category Scope

- Operator trust model for installing and enabling external code.
- ClawHub archive and ClawPack digest verification.
- npm integrity drift and managed install checks.
- Built-in dangerous-code scanner and break-glass override semantics.
- ClawHub publishing review/hidden-release behavior as upstream trust signal.

## Features

- Operator trust model for installing: Operator trust model for installing and enabling external code
- ClawHub archive: ClawHub archive and ClawPack digest verification
- npm integrity drift: npm integrity drift and managed install checks
- Built-in dangerous-code scanner: Built-in dangerous-code scanner and break-glass override semantics
- ClawHub publishing review/hidden-release behavior as upstream: ClawHub publishing review/hidden-release behavior as upstream trust signal

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (78%)`
- Positive signals: docs, source, and tests cover trust warnings, install
  scanner hooks, ClawHub artifact verification, fallback file verification,
  npm integrity drift, and publish review hiding.
- Negative signals: no live malicious-plugin, ClawHub scan-block, or production
  registry hidden-release proof was found in the OpenClaw repo.
- Integration gaps: external install approvals are CLI/local policy decisions,
  not a full marketplace attestation flow.

## Quality Score

- Score: `Stable (80%)`
- Good qualities: integrity checks fail closed, unsafe install overrides do not
  bypass plugin policy blocks or scanner failures, official trusted-source
  handling is explicit, and Security docs place plugins inside the Gateway TCB.
- Bad qualities: the operator must still choose whether to trust third-party
  code, and local break-glass options can override critical scan findings on the
  user's own machine.
- Excluded from quality: unit, integration, e2e, live, and runtime-flow test
  evidence is counted only under Coverage, not Quality.

## Completeness Score

- Score: `Beta (78%)`
- Surface instructions: evaluated against `references/completeness/clawhub-and-external-plugin-distribution.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Operator trust model for installing, ClawHub archive, npm integrity drift, Built-in dangerous-code scanner, ClawHub publishing review/hidden-release behavior as upstream.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Add live proof for a ClawHub release hidden by registry scan and then unhidden
  after verification.
- Add operator-facing install summary that shows source trust, verification
  tier, integrity facts, and policy decisions before enabling runtime code.

## Evidence

### Docs

- `docs/tools/plugin.md:66`: docs tell users to treat plugin installs like running code.
- `docs/cli/plugins.md:159`: `--dangerously-force-unsafe-install` only bypasses built-in scanner blocks and not plugin policy blocks or scan failures.
- `docs/cli/plugins.md:228`: ClawHub installs verify digest headers, artifact digests, npm integrity, and shasum metadata.
- `docs/clawhub/publishing.md:56`: release flow starts security checks and hides releases until review and verification finish.
- `SECURITY.md:145`: plugins/extensions are part of the Gateway trusted computing base.

### Source

- `src/plugins/install-security-scan.ts:48`: scans bundle install sources.
- `src/plugins/install-security-scan.ts:63`: scans package install sources.
- `src/plugins/install-security-scan.ts:82`: scans installed package dependency trees.
- `src/plugins/clawhub.ts:1164`: verifies ClawPack digest, npm integrity, and shasum fields.
- `src/plugins/clawhub.ts:1204`: falls back to strict `files[]` verification when needed.

### Integration tests

- No live ClawHub scan-block or malicious-plugin integration test was found.
- `scripts/e2e/lib/plugin-lifecycle-matrix/sweep.sh:41`: exercises real package install/update mechanics used after source trust is accepted.

### Unit tests

- `src/plugins/clawhub.test.ts:678`: rejects ClawPack artifacts when the download digest does not match metadata.
- `src/plugins/clawhub.test.ts:1102`: fails closed when hash metadata is unrecognized.
- `src/plugins/clawhub.test.ts:1322`: rejects downloaded archives whose hash drifts from metadata.
- `src/plugins/update.test.ts:1792`: aborts exact pinned npm updates on integrity drift by default.

### Gitcrawl queries

Query:

- `gitcrawl search openclaw/openclaw --query "plugin install security scan integrity approval untrusted malicious plugin" --limit 5 --json`
- `gitcrawl search openclaw/openclaw --query "unsafe plugin install security scan trusted source" --limit 5 --json`

Results:

- Both queries returned no hits, so GitHub archive evidence did not add live bug/regression signal for this trust path.

### Discrawl queries

Query:

- `DISCRAWL_NO_AUTO_UPDATE=1 /Users/kevinlin/.local/bin/discrawl search --mode hybrid --limit 5 "plugin install security scan trust approval"`

Results:

- Returned no hits, so Discord archive evidence did not add live operator proof for install approvals.
