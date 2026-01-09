---
description: Run tests with optional coverage or pattern filter
allowed-tools: Bash(pnpm:*)
argument-hint: [--coverage] [pattern]
success-criteria: |
  - All tests run to completion
  - Report pass/fail count
  - If failed: show first failure details
---

# Run Tests

Run the test suite with optional flags.

**Arguments:** $ARGUMENTS

**Behavior:**
- If `--coverage` in arguments: run `pnpm test:coverage`
- If pattern provided: run `pnpm test --run $pattern`
- Otherwise: run `pnpm test --run`

**From CLAUDE.md:**
- Framework: Vitest with V8 coverage
- Thresholds: 70% lines/branches/functions/statements
- Naming: `*.test.ts` for unit, `*.e2e.test.ts` for integration

Report test results clearly. If tests fail, show the failure summary.

## Explore
- Test patterns: `src/**/*.test.ts`
- Coverage config: `vitest.config.ts`
