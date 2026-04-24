---
name: optimizetests
description: Optimize OpenClaw slow tests, imports, misplaced coverage, and CI wall time without dropping coverage.
---

# Optimize Tests

Goal: real OpenClaw test/runtime speedups with coverage intact. Do not add shards,
skip assertions, weaken gates, or tune runner flags as the main fix.

## Runbook

1. Read `docs/help/testing.md`, `docs/ci.md`, and the scoped `AGENTS.md` files
   for any subtree you will edit.
2. Establish evidence before edits:
   - Full ranking: `pnpm test:perf:groups --full-suite --allow-failures --output .artifacts/test-perf/<name>.json`
   - Targeted file: `timeout 240 /usr/bin/time -l pnpm test <file> --maxWorkers=1 --reporter=verbose`
   - Import suspicion: add `OPENCLAW_VITEST_IMPORT_DURATIONS=1 OPENCLAW_VITEST_PRINT_IMPORT_BREAKDOWN=1`
3. Attack highest-return hotspots first:
   - broad barrels or `importActual()` in hot tests
   - per-test `vi.resetModules()` plus fresh imports
   - expensive gateway/server/client setup where reset/reuse proves same behavior
   - core tests asserting extension-owned behavior
   - duplicated fixture construction or contract assertions
4. Prefer production-quality fixes:
   - narrow runtime seams over broad mocks
   - pure helpers for static parsing/metadata
   - injected deps over module resets
   - extension-owned tests for bundled plugin/provider/channel behavior
5. After each change, rerun the same benchmark and the proving test lane. Record
   before/after wall time, Vitest duration, and max RSS when available.
6. Run `pnpm check:changed`; run broader gates (`pnpm check`, `pnpm test`,
   `pnpm build`) when touched surfaces require them.
7. Commit scoped changes with `scripts/committer "<conventional message>" <paths...>`.
   Push when requested. If CI is red, inspect with `gh run list/view`, fix, push,
   repeat until current CI is green or a blocker is proven unrelated.

## Output

End with the pushed commit(s), before/after timings, gates run, current CI state,
and any remaining tail lanes that need separate optimization.
