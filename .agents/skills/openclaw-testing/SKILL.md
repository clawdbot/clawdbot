---
name: openclaw-testing
description: Choose proportional OpenClaw tests and checks, diagnose failures, and route environment-sensitive or release proof to its owner.
---

# OpenClaw Testing

Prove the changed contract with the smallest meaningful check, complete required
checks, then finish. Broaden or repeat only for new changes, failures, or
unresolved risks. Do not add tests that merely mirror reversible, low-impact
implementation changes; use `$test-audit` when authoring or reviewing tests.

For ordinary local tests, start at `docs/reference/test.md#routine-local-order`
and `#core-commands`; read `docs/ci.md` when CI scope or runner behavior matters. Follow the touched subtree's `AGENTS.md`.

## Select The Proof

Trusted development tests, changed checks, typecheck/lint, and builds run
locally, including broader suites when the contract warrants them. Remote
compute is for isolation, clean installation, packaging, Docker, live services,
desktop/platform behavior, or an explicit operator request.

| Change or question                             | Starting point                                                                   |
| ---------------------------------------------- | -------------------------------------------------------------------------------- |
| Runtime defect                                 | Reproduce narrowly; rerun that proof after the repair, plus relevant siblings    |
| Trusted source diff                            | `pnpm changed:lanes --json`, `pnpm check:changed`, focused tests                 |
| Public SDK/plugin contract                     | Changed checks plus representative consumer tests; no automatic all-plugin sweep |
| Build output, lazy imports, package boundaries | Include `pnpm build`                                                             |
| Workflow                                       | `git diff --check` and `pnpm check:workflows`                                    |
| Documentation only                             | Relevant docs/link/format sanity and `git diff --check`; no runtime tests        |

For specialized proof, load only the selected route:

- Remote leases and credentials: [`$crabbox`](../crabbox/SKILL.md), with the
  OpenClaw bootstrap binding below.
- Package installation, plugin package trust, Docker/live lane selection or
  reruns: [Package And Docker Proof](references/package-and-docker.md).
- Release candidates, full-validation dispatch, evidence identity or recovery:
  [`$release-openclaw-ci`](../release-openclaw-ci/SKILL.md). A narrow green rerun
  does not itself authorize publication. Do not substitute moving `main` for
  the recorded candidate or Tooling SHA.
- Plugin release matrix: [`$release-openclaw-plugin-testing`](../release-openclaw-plugin-testing/SKILL.md).
- New or changed Docker lanes: [`$openclaw-docker-e2e-authoring`](../openclaw-docker-e2e-authoring/SKILL.md).
- Channel/UI behavior: the relevant channel proof skill or
  [`$control-ui-e2e`](../control-ui-e2e/SKILL.md); mock-Gateway boundary proof is
  valid when it covers the changed path. State concrete live-proof gaps.

## Source And State Boundaries

Untrusted contributor/fork tooling must never execute locally, including its
wrapper or config. Use secretless fork CI or sanitized direct AWS under
`$crabbox`; never credential-hydrated Testbox. Credentialed execution requires
maintainer approval after review, and never hydrates an untrusted lease.

For untrusted OpenClaw AWS proof, supply the clean trusted `main` copy of
`scripts/crabbox-untrusted-bootstrap.sh` as Crabbox's
`<trusted-bootstrap-script>`. Bind the fresh lease and `--fresh-pr` checkout to
the reviewed full head SHA. The trusted bootstrap verifies that SHA, the IMDSv2
no-role boundary, and the package-manager pin before installing into an isolated
`HOME`. Keep `CRABBOX_ENV_ALLOW=CI`, `--no-hydrate`, no instance role, and no
Tailscale. A moved head needs a fresh lease; missing no-role proof or no remote
PR means secretless CI. Read the Crabbox untrusted procedure before allocation.

For trusted remote proof, use `node scripts/crabbox-wrapper.mjs` with the
resolved provider; do not silently switch providers or bypass sync/security
exclusions. Save and reuse task-owned leases, verify the materialized candidate,
keep evidence outside the synced checkout, and stop owned leases at handoff.

Use isolated state and a free port. Never restart, edit, or test against an
operator Gateway or real data without explicit per-task approval. Do not kill
unrelated processes or reconcile a shared dependency install while jobs use it.

## Local Commands

```bash
pnpm changed:lanes --json
pnpm check:changed
pnpm test <path-or-filter>
pnpm test:changed
```

`check:changed` selects formatting, typecheck, lint, and guard work and may run
targeted owner Vitest tests. Inspect its plan with
`node scripts/check-changed.mjs --dry-run -- <paths...>`; it is not the full test
suite. `test:changed` chooses direct tests, mapped/sibling tests, and import
dependents; shared harness/config edits can need explicit targets or the broad
fallback `OPENCLAW_TEST_CHANGED_BROAD=1 pnpm test:changed`.
`pnpm verify` runs the full `check` and then `test` when that scope is justified.

Use repository wrappers rather than raw Vitest so project routing and setup
remain correct. If dependencies are ready in a linked worktree, these bypass
pnpm dependency reconciliation:

```bash
node scripts/check-changed.mjs
node scripts/run-vitest.mjs <path-or-filter>
```

Concurrent test/check commands must not share a Vitest filesystem module cache:
serialize them, group tests in one invocation, or give each command a distinct
`OPENCLAW_VITEST_FS_MODULE_CACHE_PATH`. Checks can schedule Vitest too.
For worker-sensitive failures, `OPENCLAW_VITEST_MAX_WORKERS=1 pnpm test <path>`
provides a focused serial probe; do not make a forced environment the repair.

## CI Failures

```bash
gh run list --branch <branch> --limit 10 --json databaseId,headSha,status,conclusion,url
gh run view <run-id> --json status,conclusion,headSha,url,jobs
gh run view <run-id> --job <failed-job-id> --log
```

Bind the diagnosis to the exact SHA and job. Check whether cancellation means a
newer same-branch run superseded it. Fetch relevant failed logs once and reuse
them; prefer exact run/job state over a stale PR rollup. Separate product,
harness, infrastructure, and credential failures before choosing a retry.

For prompt snapshot drift that passes on macOS, reproduce in CI's Linux/Node
environment before regenerating; a local pass cannot override failing CI bytes.
Fix related failures and rerun the affected proof. Route unrelated failures with
evidence rather than broadening this task automatically.
