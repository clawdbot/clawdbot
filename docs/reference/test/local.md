---
summary: "Routine local test order, the core test commands, and the local PR gate"
title: "Run tests locally"
read_when:
  - You are running or fixing tests on your own machine
  - You need the local land and gate command list
---

## Routine local order

1. `pnpm test:changed` for changed-scope Vitest proof.
2. `pnpm test <path-or-filter>` for one file, directory, or explicit target.
3. `pnpm test` only when you intentionally need the full local Vitest suite.

The project runner prints wrapper usage for a sole `--help` or `-h` request.
Compound requests, including `--help --no-help`, follow native Vitest option semantics.

An existing UI directory target stays scoped to that directory, including when
combined with explicit E2E test files. Tests retain their owning shared, isolated,
or browser lane. UI source/support-file targets that need whole-lane coverage
(such as shared styles or setup files) still use that broader fallback; use a
directory or explicit test files when you want a bounded run.

When a one-shot routed run targets only explicit test-file paths, each selected
Vitest invocation must discover at least one test file. Excluding every selected
file fails even when the lane normally permits empty runs. To allow that outcome
intentionally, use `pnpm test <test-file-path> -- --passWithNoTests`. Use
`--passWithNoTests=false` to require nonempty discovery explicitly. Broader
selectors and source-derived selections retain their lane defaults.

An explicit `--config` run through `scripts/run-vitest.mjs` keeps its stricter
named-file policy and does not permit empty named-file runs. Plugin
`--allow-no-tests` and `--allow-empty-after-exclude` controls are unchanged.

Codex and other linked/sparse worktrees can run local tests and checks. When the
dependency install is ready, use the normal commands above. If pnpm would
reconcile a shared install, use the direct Node harnesses to bypass that
package-manager preflight:

- Bounded focused proof with ready dependencies:
  `node scripts/run-vitest.mjs <path-or-filter>`.
- Changed typecheck/lint/guard proof: `node scripts/check-changed.mjs`.

For remote-environment proof, invoke `node scripts/crabbox-wrapper.mjs`
directly. Avoid local `pnpm crabbox:run` in linked worktrees because pnpm may
reconcile dependencies before the remote wrapper starts.

## Core commands

Run the test toolchain on Node 22.22.3+, Node 24.15+, or Node 26+. Vitest 5
excludes Node 25 from its declared engine range; packaged OpenClaw runtime
support for Node 25.9+ is unchanged.

The test toolchain pins stable Vitest `5.0.0`, including its browser and coverage
packages. Use `describe(name, { concurrent: false }, callback)` for ordered
suites. Await asynchronous assertions, keep `vi.mock`/`vi.hoisted` at module
scope, and perform actions whose mock calls you assert inside the test.
OpenClaw sets `clearMocks: false`, so setup and `beforeAll` calls are preserved.
Clear or reset each assertion's owned mock actions explicitly as needed.
Name patterns spanning suites use `suite > test`; native JSON retains its
space-joined `fullName`, so evidence readers match `ancestorTitles` plus `title`.

Filesystem transform caching uses `test.fsModuleCache` and
`test.fsModuleCachePath`; the existing `OPENCLAW_VITEST_FS_MODULE_CACHE` and
`OPENCLAW_VITEST_FS_MODULE_CACHE_PATH` controls retain their ownership and
disable behavior. Cache-key plugins use `defineCacheKeyGenerator`.
Inline projects inherit root configuration in Vitest 5, including concatenated
setup and include arrays. The four UI E2E resource projects declare
`extends: false` because each supplies its complete inventory and setup.

Maintained JavaScript tooling wrappers and root package commands load TypeScript
through `scripts/tsx.mjs`, using tsx's ESM entry. This preserves native loading of
compiled ESM plugins and their import-only dependencies, including when loaded
through `require()`. Source TypeScript imports and tsconfig path aliases remain
available.

These launchers retain tsx's in-process transform cache and Node's module cache.
They skip tsx's shared disk cache before the loader starts, and child tooling
inherits that policy. This cache policy does not clean
existing temporary directories, Node or Vitest caches, or other global caches. Standalone
`pnpm ui:build` keeps native startup and applies the same preload to its post-build
validators; it does not require `TSX_DISABLE_CACHE` in the invoking shell. Raw
external `tsx` and `node --import tsx` invocations outside these launchers are unchanged.

Parallel project runs on macOS and Linux reuse filesystem transforms within
exclusive worker slots, with separate directories for each Vitest configuration.
A slot stays owned through preflight, retries, and verified child/group completion;
uncertain cleanup retires it. Explicit isolated cache paths, serial and watch runs,
and Windows retain their existing cache ownership. Concurrent invocations still
need separate cache roots.

Control UI builds report size budgets without enforcing them. Run
`pnpm ui:check-performance` after a build to enforce absolute budgets, or
`pnpm ui:check-performance:base <base-commit-sha>` to build and compare both
revisions with the same toolchain. See [Control UI size budgets](/ci/pipeline#control-ui-size-budgets).

### Source tests and subprocess builds

Non-watch runs through `pnpm test` or `scripts/run-vitest.mjs` keep Vitest tests
and runtime parents on TypeScript. Importing a declared subprocess entrypoint
compiles the fixed test entry set and its workspace dependencies into one fresh
invocation directory under `.artifacts/vitest-workers/`.

The ten declared application entries run as plain Node JavaScript without a
TypeScript loader: SQLite read-only snapshots, database verification, Tailscale
route ownership, the service relay, its POSIX and Windows anchors, the memory
plugin's KNN child, session transcript archive and reconciliation workers, and
managed GitHub credential resolution. The same generation also compiles the fake-backend TUI
fixture's four runtime roots together: the real TUI, embedded reply producer,
reply metadata reader, and outbound normalizer. Shared chunks preserve their
module and WeakMap identity. Generated TUI fixtures remain `.mts` files: Node
launches them with `--import tsx` for their own syntax, while Bun handles that
syntax natively without the Node loader. Only their runtime imports change.
Existing package build entry paths and Vitest source parents stay unchanged. The
CLI fork-recovery regression also compiles the real CLI entry and its concurrent
rebind's session accessor and binding helper together. Both processes use the same
runtime graph while retaining the durable-write race and process-exit assertions.
Doctor process output tests with bundled plugins disabled reuse that compiled CLI
inside one lazily created package fixture per test run, keeping real UI checks on
fixture-owned assets and each scenario’s state separate. Standalone and watch runs
use live source inside the same fixture. Other
Worker-thread entries and arbitrary source CLI fixtures remain outside this declared set.

The session-title and child-link retention tests declare their title-reader,
session-utils, and listing roots in this same generation. Each fresh
heap-measurement child runs their JavaScript without spending its execution
deadline on TypeScript imports.

Automatic-triage process fixtures share this generation for admission, failure handling, execution, process identity, and respawn checks. Compilation finishes before readiness deadlines begin, so children load prepared JavaScript. The detached helper uses the same sealed lease runtime as the installed package.

Preparation is lazy across both projects and shards. Config imports, listing
tests, and tiny tests that do not import these declarations do not load the
subprocess compiler or compile workers. A shard that needs a declaration requests the
outer runner's single build through its existing Node IPC channel during module
collection, before fixture hooks and readiness deadlines. Every finite invocation
that needs a declaration pays for this fixed entry set; preparation timing is
reported separately from child execution. The runner starts one short-lived native
Node or Bun compiler child and joins it before returning the verified manifest to
borrowers. The compiler module graph lives in that child, not the long-lived runner
or Vitest worker. No shard can select a different build graph or adopt another invocation's output. The outer
runner retains the generation until child close and process-group cleanup
finish, then verifies it before reporting success. Verification reads every recorded
input and output with bounded asynchronous I/O, keeping the runner responsive during
large shutdown scans. The invocation owner verifies each borrower's preparation
before replying and verifies again after all borrowers close; Vitest does not repeat
these scans inside each shard or during its concurrent pool shutdown. Standalone
Vitest and watch runs retain source execution: compilation, verification, and artifact
deletion require the repository runner's ownership.
A lost owner or failed build fails the run.
Disposal cancels pending compilation and joins it, every borrower, and outstanding
preparation requests before asynchronously removing the directory. Signal handlers
remain active through removal, even when large generations take time to delete.
Borrower completion does not wait for compilation, so an early child exit can reach that cancellation path. An uncertain compiler or borrower join retains the
generation and fails the run. Abnormal termination can also leave an unused
directory; later runs never adopt it.

Every preparation compiles current source; checkout `dist/` is neither an input
nor a fallback. Build errors, missing artifacts, and changes to recorded build
inputs fail the run. Compilation includes the native subprocess fixtures before
they impose resource limits. Third-party dependencies remain external except for
the always-bundled OpenClaw packages. fs-safe remains external so its native loader
resolves the optional platform package from fs-safe's own dependency scope, including
nested pnpm installs. Compiled workers use that same installed package; they do not
copy native binaries. The default stays off, and the existing `off`/`auto`/`require`
opt-ins retain their behavior. Sealed portable worker bundles use guarded JavaScript
only and explicitly disable native loading.

Watch mode deliberately keeps the existing live-source path, including tsx for
Node subprocesses and native TypeScript handling for Bun. It creates no prepared generation, so a new child launch
reads current source rather than reusing a compiled snapshot. Existing Vitest
watch dependency tracking still determines when tests rerun.

Test wrapper runs end with a short `[test] passed|failed|skipped ... in ...` summary; Vitest's own duration line stays the per-shard detail.

A failed invocation ends with one `[test] FAILED (exit N)` line after child
processes, cleanup, and report publication settle. Direct `run-vitest.mts` calls
use `[vitest]` instead. Nested runners retain their diagnostics and exit status;
the top-level CLI owns the final failure line. Successful runs emit no failure
trailer.

| Command                                           | What it does                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm test`                                       | Explicit file/directory targets route through scoped Vitest lanes. Untargeted runs are full-suite proof: fixed shard groups expand to leaf configs for local parallel execution, with the expected shard fanout printed before starting. The extension group always expands to per-extension shard configs instead of one giant root-project process. |
| `pnpm test:changed`                               | Cheap smart changed-test run: precise targets from direct test edits, sibling `*.test.ts` files, explicit source mappings, and the local import graph. Broad/config/package changes are skipped unless they map to precise tests.                                                                                                                     |
| `OPENCLAW_TEST_CHANGED_BROAD=1 pnpm test:changed` | Explicit broad changed-test run; use when a test harness/config/package edit should fall back to Vitest's broader changed-test behavior.                                                                                                                                                                                                              |
| `pnpm test:force`                                 | Frees the configured OpenClaw gateway port (default `18789`), then runs the full suite with an isolated gateway port so server tests do not collide with a running instance.                                                                                                                                                                          |
| `pnpm test:coverage`                              | Emits an informational V8 coverage report for the default unit lane (`vitest.unit.config.ts`); no coverage thresholds are enforced.                                                                                                                                                                                                                   |
| `pnpm test:coverage:changed`                      | Unit coverage only for files changed since `origin/main`.                                                                                                                                                                                                                                                                                             |
| `pnpm changed:lanes`                              | Shows the architectural lanes triggered by the diff against `origin/main`.                                                                                                                                                                                                                                                                            |
| `pnpm check:changed`                              | Runs the local changed formatting/typecheck/lint/guard plan, including targeted Vitest owner tests for selected paths. Use `pnpm test:changed` or `pnpm test <target>` for additional test proof matching the touched contract.                                                                                                                       |

`pnpm check:changed` also runs the mobile protocol-event coverage guard when
changes affect the gateway event catalog or constants, scanned mobile sources,
coverage declarations, or the guard, its execution helpers, and its routing.
All-lane checks include it too. Every gateway event must have a handler or an
explicitly approved non-consumption declaration for each mobile client. To run
only this guard, use `pnpm check:protocol-coverage`.

For native app changes, `pnpm check:changed` uses platform scope to select lint:
Android selects `pnpm android:lint` (the Gradle ktlint checks), while Apple app
changes retain Swift lint. Android-only changes do not select Swift lint or its
missing-tool notice. Android framework/resource lint and runtime tests remain
separate checks; Kotlin lint does not replace them.

Remote filesystem fixtures that execute GNU `stat` and `readlink` run locally
only on Linux. The shared leading-`@` file-tool scenario
also runs against a portable remote-only bridge on every platform. Native
Python helper coverage remains separate, including macOS; these fixture gates
do not restrict the [SSH backend's Gateway host](/gateway/sandboxing#ssh-backend).

## Local PR gate

For local PR land/gate checks, run:

- `pnpm check:changed`
- `pnpm check`
- `pnpm check:test-types`
- `pnpm build`
- `pnpm test`
- `pnpm check:docs`

If `pnpm test` flakes on a loaded host, rerun once before treating it as a regression, then isolate with `pnpm test <path/to/test>`. For memory-constrained hosts:

- `OPENCLAW_VITEST_MAX_WORKERS=1 pnpm test`
- `OPENCLAW_VITEST_FS_MODULE_CACHE_PATH=/tmp/openclaw-vitest-cache pnpm test:changed`
