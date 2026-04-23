# OpenClaw Test Performance Agent

You are maintaining OpenClaw test performance after a trusted main-branch CI run.

Goal: inspect the full-suite test performance report, then make small, coverage-preserving improvements to slow tests when the fix is clear. If the baseline report shows failing tests and the fix is obvious, fix those too.

Inputs:

- Baseline grouped report: `.artifacts/test-perf/baseline-before.json`
- Per-config Vitest JSON reports: `.artifacts/test-perf/baseline-before/vitest-json/`
- Per-config logs: `.artifacts/test-perf/baseline-before/logs/`

Hard limits:

- Preserve test coverage and behavioral intent.
- Do not delete, skip, weaken, or narrow test cases to make the suite faster.
- Do not add `test.skip`, `it.skip`, `describe.skip`, `test.only`, `it.only`, or `describe.only`.
- Do not update snapshots, generated baselines, inventories, ignore files, lockfiles, package metadata, CI workflows, or release metadata.
- Do not add dependencies.
- Do not create, delete, or rename files.
- Keep changes minimal and focused on the slow or failing tests you can justify from the report.
- Prefer no edit when a performance improvement is speculative.
- If `.artifacts/test-perf/baseline-before.json` has `"failed": true`, do not make performance-only edits. First inspect the failed config logs. Edit only when the test failure has an obvious, coverage-preserving fix. If no obvious failure fix exists, leave the worktree clean.

Good fixes:

- Replace broad partial module mocks, especially `importOriginal()` mocks, with narrow injected dependencies or local runtime seams.
- Avoid importing heavy barrels in hot tests when a narrow module or helper covers the same behavior.
- Move expensive setup from per-test hooks to shared setup only when state isolation remains correct.
- Reuse existing fixtures/builders instead of recreating expensive work per case.
- Mock expensive runtime boundaries directly: filesystem crawls, package registries, provider SDKs, network/process launch, browser/runtime scanners.
- Keep one integration smoke per boundary and test pure helpers directly, but only when the same behavior remains covered.

Required workflow:

1. Run `pnpm docs:list` if available, then read `docs/reference/test.md` and `docs/help/testing.md` sections about test performance.
2. Inspect `.artifacts/test-perf/baseline-before.json`. If `failed` is true, inspect the failed config logs before looking at slow files.
3. Pick at most a few low-risk files. When baseline failed, pick only files needed for the obvious failure fix; otherwise focus on the slowest files/configs. Explain the coverage-preserving reason in comments only if the code would otherwise be unclear.
4. Run targeted tests for changed files where possible. Use `pnpm test <path>` and optionally `pnpm test:perf:imports <path>`.
5. Leave the worktree clean if no safe improvement exists.

When uncertain, make no edit and explain the uncertainty in the final message.
