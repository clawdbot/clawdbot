---
name: test-audit
description: "Invoke whenever writing, changing, reviewing, or sweeping tests. Authoring gate for new tests plus audit workflow for low-value, implementation-coupled, or duplicative tests and the test-only production seams they demand."
---

# Test Audit

Two modes, one value bar. Authoring mode gates every new or changed test at
write time. Audit mode runs focused sweeps of tests that re-assert source,
duplicate stronger proof, couple behavior to implementation, or keep test-only
production seams alive. Continue broad audits as separate coherent follow-up
PRs; optimize for confidence, not deletion count.

## Authoring gate

Before adding any test, answer four questions; a missing answer means do not
add it yet:

1. What observable behavior, invariant, or independent contract does it protect?
2. What credible regression makes it fail?
3. Why does existing coverage not already catch that failure? Prefer extending a
   table-driven case or shared fixture over a near-duplicate test; consolidate
   duplicated setup in the same change.
4. Does it need a production seam (export, flag, wrapper, injection hook) that no
   production caller needs? If yes, move the test to the real boundary instead.

A test that would break under behavior-preserving refactoring is asserting
implementation, not behavior; rewrite it at the owning boundary before landing
it.

Bug regression tests must fail on the pre-fix code for the intended reason and
pass after the owner-boundary repair. A regression test that never demonstrably
failed proves the mock, not the fix.

## Value bar

Tests justify their maintenance cost by protecting behavior, a credible
regression, or an independently meaningful contract. A test that must change
for behavior-preserving source reorganization is suspect, not automatically
deletable.

Before judging a candidate, read the complete test and production owner, its
entry point, callers, callees, sibling implementations, overlapping tests, CI
routing, and relevant history. Read root and scoped `AGENTS.md` files first.
When the test claims dependency-backed behavior, inspect the dependency source
or types directly.

## Discovery

Keep discovery read-only and report evidence before editing. For broad scope,
run parallel discovery lanes when available:

- core and packages (`src/`, `packages/`);
- plugins (`extensions/`);
- UI, apps, scripts, and tooling;
- a cross-cutting pattern sweep.

Prefer a few high-confidence candidates over a large speculative inventory.
Look for:

- assertion-free coverage probes;
- self-comparisons and identity copiers;
- copied fixtures, inventories, manifests, or export lists;
- exact source, import, or string greps;
- private predicate or call-shape tests duplicated at real boundaries;
- duplicate invocations of the same contract;
- provider-local replays of shared helpers;
- tests whose only purpose is preserving test-only exports, globals, or wrappers;
- dead production code whose only callers are tests.

## Retention bar

Keep a test when it independently enforces a public API, plugin SDK, protocol,
config, migration, storage, security, platform, default, prompt-byte, generated
cross-language, package, release, or architecture contract. Also keep:

- call ordering when order is observable behavior;
- regressions with a credible failure mode;
- source inspection when it is the cheapest independent guard.

Static or slow is not a deletion reason. A test that resembles implementation
may still be the independent contract; prove otherwise before removing it.

## Candidate evidence

Record every field below before editing. A missing field means the candidate is
not ready for deletion:

- exact test name and location;
- what failure it can actually detect;
- non-test callers of the covered production or support seam;
- stronger remaining owner-boundary proof, or why no proof is needed;
- relevant history and the reason the test or seam exists;
- production or test-support deletion unlocked;
- risk and the focused validation command.

## Edit shape

Choose one coherent owner-boundary batch. Delete obsolete test-only exports,
globals, wrappers, and dead production paths instead of preserving aliases.
Move retained regressions to their canonical owners. Consolidate repeated
package or dependency assertions into one generic contract.

Prefer net-negative production LOC. Do not add replacement tests that restate
the same implementation, and do not convert uncertain candidates into cleanup
to increase deletion counts.

## Validation

Never edit source or tests while Vitest is running in the checkout. Follow
`$openclaw-testing`; route heavy proof through its `$crabbox` rules.

1. Run the smallest owner and sibling tests with
   `node scripts/run-vitest.mjs <path-or-filter>`.
2. For removed source greps or plan assertions, run the executable script or
   dry-run that owns the real contract.
3. Run targeted formatting, then `git diff --check`.
4. Classify with
   `node scripts/check-changed.mjs --dry-run -- <changed-paths>`, then run the
   actual changed gate required by repository policy.
5. Inspect `git diff --numstat`; report production/tooling separately from
   tests and test support.
6. After final audit edits, run mandatory `$autoreview`.

## Landing and continuation

Commit, push, open a PR, or land only when authorized. Use
`$openclaw-pr-maintainer` and the repository `scripts/pr` flow. Land one
coherent PR at a time; after landing, refresh from current `main` and rerun
read-only discovery for the next high-confidence batch.

## Handoff

Report:

- root cause and removed low-value categories;
- production owner simplifications;
- retained false positives and why they remain valuable;
- focused and full proof actually run;
- production versus test LOC;
- PR and merge state;
- named follow-ups.
