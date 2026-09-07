---
summary: "Shared build locks, isolated test state and homes, and JSON report merging"
title: "Test runner internals"
read_when:
  - A run leaked state, retained a lock, or lost a report
  - You need machine-readable results from a multi-project run
---

## Shared test state and process helpers

`build-all`, standalone tsdown builds, tsgo, SDK declaration preparation,
package-boundary checks, and dependent lint use checkout-local ownership at
`.artifacts/dist-artifacts.lock`. Ownership spans
cleanup, generation, cache restoration, and the checks consuming those outputs;
independent checkouts remain independent. Competing commands print a waiting
message and wait for a live owner without an acquisition deadline. Compiler and
build execution timeouts are unchanged. Standalone tsgo runs serialize, including
source-only checks; the core test shard runner retains its explicit concurrency
inside one owner. Do not delete `dist` manually while these commands are running.
An abrupt owner or nested wrapper exit, or unverified child cleanup, retains the
lock. A missing or unverifiable owner PID, or a recorded child-cleanup failure,
fails acquisition promptly without reclaiming anything. PID death does not prove
detached descendants stopped. Before manually removing an abandoned lock directory,
inspect its `owner.json` and verify all associated build, compiler, and lint
processes, including detached descendants, have stopped; then retry the command.

Lint reports its final failure on stderr after child joins and artifact ownership
have settled, including retained ownership when cleanup is uncertain. Standalone
Oxlint and its shard CLI end with `[oxlint] FAILED (exit N)`; `pnpm lint` owns the
whole pipeline and ends with one `[lint] FAILED (exit N)` instead. Shard progress
distinguishes `passed` from `failed (exit N)`, and stdout remains available for
machine-readable tool output. Successful runs have no failure trailer. Signals
forwarded during child execution and shard timeouts fail the command; whole-host
loss or `SIGKILL` of the reporting process can prevent a final line.

Local plugin lint consumes native SDK declarations in `packages/plugin-sdk/dist`.
The dedicated package-boundary compiler also consumes seven plugin API trees in
`.artifacts/extension-package-boundary/plugins`. Each declaration and compile
owner validates its consumed source content, inherited config, selected compiler,
and complete output inventory. Unrelated existing source or test edits retain
cache hits. Resolution-topology changes invalidate conservatively, including new
module candidates outside declared roots. Stale declarations get a full native
emit after clearing only their build-info file; the successful emitted inventory
then drives obsolete declaration pruning. Missing or tampered outputs invalidate
the owner. The content records live under
`.artifacts/extension-package-boundary`, outside packaged build cleanup. A warm run validates the records without emitting declarations.

Native declaration and package-boundary records accept only checkout-owned input
realpaths, including compiler libraries, inherited config, dependency links, and
package manifests. Local pnpm links remain supported when their targets stay
inside the checkout. The tsgo wrapper does not create or reuse a shared external
install; invocations from subdirectories still use the containing checkout as
the ownership boundary. Declared checkout junctions and platform path aliases map
to the same native root for validation and actual snapshot reads. Local declaration
preparation also aligns the compiler's `PWD` with its working directory so shell
aliases do not change emitted inventory paths. Native resolution itself is not
sandboxed: an ancestor install can still enter a successful compiler
receipt. Resolution can read an ancestor's candidate `package.json` while searching
for declarations, then resolve the import to checkout-local JavaScript. This can
happen with a complete local frozen install and no external source files in the
compiler Program; it does not by itself prove an undeclared dependency. Those
manifests still affect resolution and must remain in the receipt. The owner fails
with `Declaration input escapes checkout`, without publishing a success record or
pruning obsolete declarations. Warm records use the same input check.

Repair this at checkout provisioning: use a separate physical checkout whose
ancestor directories do not contain `node_modules`, with the same candidate source
(including any uncommitted changes) and its own `pnpm install --frozen-lockfile`.
Run declaration preparation and dependent lint or package-boundary checks in that
checkout, so the checks consume its freshly sealed receipts. A symlink to the
nested checkout, a repeated install there, or `nodeLinker: isolated` does not bound
native ancestor lookup. Do not alter the ancestor installation, add incidental
dependencies, filter compiler receipts, or transplant declarations to bypass the
checks. The pinned native compiler's filesystem callback API supports analysis,
not declaration and build-info emission; native validation does not automatically
create an isolated checkout.

Packaged SDK declarations belong to one staged owner shared by full, package, and
`ciArtifacts` builds. It serializes the two canonical tsdown SDK groups on a miss
and caches their complete staged generation. Each successful compiler supplies its
source membership through a private staged receipt; missing receipts or inputs
changed during compilation prevent publication. The shared input snapshot policy
validates consumed bytes, inherited configuration, generator and manifest inputs,
and resolution topology without starting a compiler on hits. Cache hits restore
into fresh staging and pass the same entry and relative declaration closure checks
before publication.
All tsdown declaration builds (the eight SDK/unified groups, workspace packages,
and the AI package) resolve source and dependency realpaths within their checkout.
Ancestor installs are invisible to TypeScript lookup; selected declaration paths
that escape through symlinks or bundler resolution fail the build. Each checkout
needs its own installed declaration inputs, including compiler libraries. Local
pnpm links are supported when their targets remain inside the checkout; shared
external installs are not. Actual compiler receipts remain unfiltered, and input
changes still prevent publication. Runtime module resolution is unchanged;
native tsgo uses the separate receipt-admission policy above.

Local preparation never overwrites packaged declarations or writes workspace
forwarding bridges.

Plugin SDK declaration preparation and `scripts/run-tsgo.mjs` require child work
to finish before reporting success. On POSIX, each verifies its own managed
process group: leftover children are terminated and the command fails instead of
allowing artifact stamps or downstream checks to proceed. Windows retains normal
joined-launcher completion because strict group verification is unsupported there.
This does not detect descendants that deliberately leave the managed groups.

`run-vitest` (including project shards), plugin batches, `test-live`
(including live shards), `run-vitest-profile`, and the TUI PTY watcher give each
Vitest invocation an owned temporary namespace through `TMPDIR`, `TMP`, and `TEMP`.
Before Vitest starts, isolated invocations also receive native `HOME` and
`USERPROFILE` inside that namespace. This protects home fallbacks used by worker
threads, named builtin imports, and import-time captures; changing only a worker's
JavaScript `process.env` does not change native thread home lookup. Per-worker and
per-test fixture homes remain separate. Installed Corepack and Playwright browser
caches retain their caller-selected locations.

Live-aware setup still loads the original profile and stages live state when
requested. A bounded invocation artifact carries the original home to that setup;
it does not grant live access, and hermetic setup never consults it. Known
hermetic selections ignore ambient live and real-home flags. Known wholly
live-aware selections retain explicit `OPENCLAW_LIVE_USE_REAL_HOME` behavior.
An explicitly real-home live invocation is refused before config loading if its
selection mixes home policies or cannot be classified, including custom configs
and ambiguous project selectors. Run hermetic tests without `LIVE`,
`OPENCLAW_LIVE_TEST`, `OPENCLAW_LIVE_GATEWAY`, and `OPENCLAW_LIVE_USE_REAL_HOME`
using `node scripts/run-vitest.mjs <test-path>`, then run the intended live
selection separately using `node scripts/test-live.mts -- <live-test-path>`.
The launcher does not split runs or change watch, filter, or report semantics.

The namespace contains isolated homes, their JIT caches, SDK/shared-home allocation
roots, and fallback SQLite state; its lifetime spans shared-worker files and module
resets. On POSIX detached launches, the parent removes
only that namespace after its child process group has stopped, output pipes
have closed, and nested resource owners have released their pending claims,
including passing and failing runs, child crashes, caught `SIGINT`/`SIGTERM`
signals, and watchdog termination where supported. Explicit state, profile output,
and mirror artifacts outside the namespace remain untouched. Failed or unverified
group joins or unresolved nested claims retain the namespace and report the exact
path for manual recovery. Nested namespaces, fixture lifetimes, and managed commands
register ephemeral filesystem ownership before admitting work. Release requires
positive completion evidence; caught cleanup failures, module resets, worker exit,
or an intermediate runner crash cannot release a pending claim or its ancestors.
Managed commands keep their existing close-based completion contract unless strict
tree verification is requested; failed finalization never releases ownership.
Stop all remaining writers before manually removing the reported exact directory.
Windows and non-detached launches allocate the same isolated native home, but retain
their namespace and enclosing claims with a diagnostic after child exit and pipe
closure because descendant completion cannot be verified. Raw external invocations do not gain
this boundary. Forced parent or supervisor death (such as `SIGKILL`) can prevent
cleanup; unregistered descendants that intentionally escape the owned group remain
outside this contract. The wrappers do
not sweep old directories or infer ownership from names, ages, or PIDs.
This is home isolation, not a filesystem sandbox: explicit absolute paths,
`os.userInfo()` account lookup, children with stripped or replaced home variables,
and intentionally real-home live execution remain outside its protection.

- `src/test-utils/openclaw-test-state.ts`: use from Vitest when a test needs an isolated `HOME`, `OPENCLAW_STATE_DIR`, `OPENCLAW_CONFIG_PATH`, config fixture, workspace, agent dir, or auth-profile store.
- `pnpm test:env-mutations:report`: non-blocking report of tests/harnesses that mutate `HOME`, `OPENCLAW_STATE_DIR`, `OPENCLAW_CONFIG_PATH`, `OPENCLAW_WORKSPACE_DIR`, or related env keys directly. Use it to find migration candidates for the shared test-state helper.
- `test/helpers/openclaw-test-instance.ts`: process-level E2E tests needing a running Gateway, CLI env, log capture, and cleanup in one place.
- Docker/Bash E2E lanes that source `scripts/lib/docker-e2e-image.sh` can pass `docker_e2e_test_state_shell_b64 <label> <scenario>` into the container and decode it with `scripts/lib/openclaw-e2e-instance.sh`; multi-home scripts can pass `docker_e2e_test_state_function_b64` and call `openclaw_test_state_create <label> <scenario>` in each flow. `node --import tsx scripts/lib/openclaw-test-state.mts -- create --label <name> --scenario <name> --env-file <path> --json` writes a sourceable host env file (the `--` before `create` keeps newer Node runtimes from treating `--env-file` as a Node flag). Lanes that launch a Gateway can source `scripts/lib/openclaw-e2e-instance.sh` for entrypoint resolution, mock OpenAI startup, foreground/background launch, readiness probes, state env export, log dumps, and process cleanup.

`createOpenClawTestState` selects and owns temporary paths and process environment
selectors. It is not filesystem sandboxing and does not stop external producers.
Await its asynchronous `restoreEnv()`; stop and join required producers before
restoring selectors or removing state. Runtime reproductions of state-selection
leaks require enforced storage isolation, such as a VM or container without access
to operator stores, not merely temporary `HOME` or state-directory overrides.

## JSON reports across native processes

For a multi-project or chunked run, explicitly request native JSON with an output
file, for example:

```bash
pnpm test test/vitest/vitest.unit-fast-isolated.config.ts test/vitest/vitest.agents-embedded-agent.config.ts --reporter=verbose --reporter=json --outputFile=.artifacts/test-results.json
```

The project runner and plugin batch runner give each attempt separate native JSON
and blob files, then publish the requested JSON from Vitest's native report merge.
They print a companion `<output>.reports-<unique>` directory. Keep that directory:
it contains original reports, per-attempt coverage files when coverage is enabled,
and an `index.json` with child exit codes, signals, timeouts and unstarted work.
Only the accepted retry attempt contributes to the aggregate.
Blob reports are exact-version artifacts. Rerun child reports with the current
Vitest version before merging artifacts produced by another version.

The aggregate preserves the accepted case inventory, but is not a lossless
replacement for the originals. Native merging does not restore snapshot summaries
or JSON `coverageMap`, and its `startTime` is the merge time. Passing snapshot tests
still succeed. Read native originals for those details and the index for process
outcomes: JSON `success` does not encode every wrapper or unhandled-error failure.
Separate built-in coverage reports remain per attempt in the companion directory.
Custom coverage providers/reporters and coverage reporter tuple options require
separate invocations with unique destinations.

A complete failed-test aggregate is retained with a failing command exit. Missing
or invalid evidence, cancellation, unstarted required work, or publication failure
does not publish a complete aggregate; an existing output file is not proof of the
new run. The diagnostic prints the retained report-set location. Report sets are
not automatically swept.

Overlapping selections can share native task IDs, so merging them can replace
independent failure details even when case counts match. Such report sets retain
their originals and fail publication. Select each configuration once, or run
overlapping selections separately with distinct output files.

This ownership applies to explicit CLI JSON file requests with named, file-based
Node projects and native console reporters. Scalar `--outputFile` and
`--outputFile.json` both work. Config-owned reporter options, other file formats,
custom reporters and inline/browser project composition require separate native
invocations with unique output destinations. Do not assume those outputs are
aggregated. Single-process and console-only runs keep their existing native behavior.
Native help and other non-test controls stay with the child CLI and do not allocate
report sets. `run --version` still runs tests, as it does in native Vitest.
Config-only reporters are not intercepted: multiple children can still overwrite
the same configured file. Run those configurations separately with distinct paths;
adding `--reporter=json` alone does not override a reporter tuple's own `outputFile`.
