---
summary: "How to run tests locally (vitest) and when to use force/coverage modes"
read_when:
  - Running or fixing tests
title: "Tests"
---

- Full testing kit (suites, live, Docker): [Testing](/help/testing)
- Update and plugin package validation: [Testing updates and plugins](/help/testing-updates-plugins)

## Agent default

Agent sessions run trusted development tests, changed gates, typecheck/lint,
and builds locally by default, broadening only when the touched contract
requires it. Never execute untrusted repository tooling locally. Use Crabbox
when the environment is part of the proof: clean-machine, install/package,
Docker, E2E, live, desktop, or cross-platform work, or when the operator
explicitly requests remote proof. Do not use Crabbox merely as generic compute
offload. The configured Testbox workflow hydrates credentials, so untrusted
contributor or fork code must use secretless fork CI or sanitized direct AWS
Crabbox instead.

Do not pre-warm for anticipated work. Acquire the backend lazily when the
first environment-sensitive command is ready, reuse the returned `tbx_...` id
for later remote commands, sync the current checkout on every run, and stop it
before handoff.

After the first successful reuse, the wrapper records the lease's base,
dependency, and Testbox workflow fingerprint under `.crabbox/testbox-leases/`.
Source-only edits keep reusing the warmed box. A changed merge base, lockfile,
package-manager input, wrapper, or Testbox workflow fails closed and requires a
fresh lease. Every run still syncs the current checkout.
`OPENCLAW_TESTBOX_ALLOW_STALE=1` is only for intentional diagnostics, not
release proof.

Local test commands below are the normal trusted development path. Keep proof
proportional to the touched contract.

For untrusted proof, lazily warm with `--provider aws`. Every run must set
`CRABBOX_ENV_ALLOW=CI`, pass `--provider aws --no-hydrate`, and use
a fresh temporary remote `HOME` before installing dependencies or running
tests. Use a newly warmed lease dedicated to that untrusted source; never reuse
a trusted or previously hydrated lease. Launch an installed trusted Crabbox
binary from a clean trusted `main` checkout and fetch only the remote PR with
`--fresh-pr`; never execute the untrusted checkout's wrapper or config locally.
Unset `CRABBOX_AWS_INSTANCE_PROFILE` and fail closed unless resolved
`aws.instanceProfile` is empty. Before any install/test, use trusted
absolute-path tools to require an IMDSv2 token, prove the IAM credentials
endpoint returns 404, and verify remote `git rev-parse HEAD` equals the full
reviewed PR head SHA. Bind the lease to that SHA and stop/rewarm when the head
changes. Upload trusted `scripts/crabbox-untrusted-bootstrap.sh` from clean
`main` alongside `--fresh-pr`; it installs pinned Node/pnpm, verifies the SHA
and package-manager pin, isolates `HOME`, installs dependencies, then executes
the requested test. If the broker cannot prove no role or no remote PR exists,
use secretless fork CI. Do not use `hydrate-github`, `--no-sync`, or a
credential-hydrated Testbox workflow.
Unset all `CRABBOX_TAILSCALE*` overrides, force `--network public
--tailscale=false`, clear exit-node/LAN flags, and require `crabbox inspect` to
report public networking with no Tailscale state before uploading any script.

## Crabbox repository setup

The shared [Crabbox skill](https://github.com/openclaw/agent-skills/tree/main/skills/crabbox)
owns portable lease, trust, sync, and cleanup procedures. This section owns the
OpenClaw wrapper and workflow inputs. Routine task-needed Crabbox/Testbox use
and task-owned worktrees do not require another confirmation; preserve unrelated
work and existing credential, production, budget, and publication boundaries.

Run trusted OpenClaw remote proof through the wrapper from the repository root:

```bash
node scripts/crabbox-wrapper.mjs run --help
```

Read `.crabbox.yaml` and the resolved provider before running. The repository
default is `blacksmith-testbox`, with `.github/workflows/ci-check-testbox.yml`
owning its prepared environment. Direct providers use
`.github/workflows/crabbox-hydrate.yml`. Keep the resolved provider unless the
requested proof requires another environment; capacity or hydration failure
does not make a different provider equivalent.

The direct `.github/workflows/windows-blacksmith-testbox.yml` workflow runs
native Windows. The wrapper's Blacksmith adapter supports Linux only; explicit
`--provider blacksmith-testbox` prevents automatic Azure routing but does not
enable Windows support. Blacksmith CLI 0.4.57 targets `runner` and has no native
username override, so supported CLI sync/run on this Windows image remains
blocked. Native SSH inspection with the per-Testbox key is not CLI end-to-end
proof.

The wrapper checks an executable sibling `../crabbox/bin/crabbox`, then `PATH`,
then the sibling of the Git common checkout. Verify the selected binary and
its source rather than trusting a directory name. If it needs repair or is
missing, use a clean task-owned checkout of
[Crabbox](https://github.com/openclaw/crabbox), build `./cmd/crabbox` into a
task-owned binary directory, and leave other checkouts and the operator's
installed binary untouched. The existing
`OPENCLAW_CRABBOX_WRAPPER_IGNORE_REPO_BINARY=1` setting skips the first sibling
candidate; a task binary on `PATH` then takes precedence over the common-checkout
candidate. A dirty or occupied sibling is not a reason to stop and ask.

For a selected trusted Testbox lane:

```bash
node scripts/crabbox-wrapper.mjs run --timing-json -- \
  CI=1 NODE_OPTIONS=--max-old-space-size=4096 \
  OPENCLAW_TEST_PROJECTS_PARALLEL=6 OPENCLAW_VITEST_MAX_WORKERS=1 \
  OPENCLAW_TESTBOX=1 OPENCLAW_TESTBOX_REMOTE_RUN=1 \
  pnpm test <path-or-filter>
```

For several commands, warm once with
`node scripts/crabbox-wrapper.mjs warmup --keep --timing-json`, save the returned
lease ID, and reuse it with `run --id <tbx_id>`. Stop the owned lease with
`node scripts/crabbox-wrapper.mjs stop --id <tbx_id>`; stop has no `--timing-json`.

- Warm from the task checkout. Claims belong to checkout paths; `--reclaim`
  deliberately transfers that ownership and never changes repository identity.
  Sparse staging uses the wrapper's ownership path. Do not sync or reclaim
  while another command owns the lease.
- Wrapper reuse requires the local SSH key created by Crabbox. A missing key
  requires a fresh warmup. Leases created directly by Blacksmith remain usable
  through `blacksmith testbox run --id <tbx_id>`, not Crabbox wrapper reuse.
- Every native Testbox run syncs again, including reused leases. `--no-sync`
  cannot preserve a remote baseline. Compare revisions in separate remote
  worktrees within one synced command; never switch refs in the synced root.
- Compound remote shell commands use `bash -lc`, not `sh -lc`; hydration can
  depend on Bash declarations. Testbox's workflow owns Chromium, so do not pass
  Crabbox `--browser` to that provider.
- Keep the lease fingerprint checks described above. No stale-lease override
  for release proof. Direct-provider flags such as `--fresh-pr`, `--full-resync`,
  `--script*`, `--env-helper`, capture/download flags, and `--stop-after` are not
  a substitute for the delegated Testbox workflow.

The native Windows Testbox idle monitor uses the running `sshd` service's local
listener ports, not Blacksmith's externally forwarded SSH port. Established SSH
connections keep the job alive; the `~/.testbox-last-activity` modification time
covers short commands between the 30-second polls. Once neither indicates recent
activity, the configured idle timeout still ends the job.

The shared skill's command placeholders map to the focused commands in this
guide. Its trusted bootstrap is `scripts/crabbox-untrusted-bootstrap.sh`; the
untrusted path above invokes the installed trusted CLI, never the PR's wrapper.
For an explicitly selected local-container lane, the existing example image is
`node:24-bookworm` and the install command is
`corepack pnpm install --frozen-lockfile --store-dir .pnpm-store`, followed by
the chosen test. Keep `--no-hydrate` and a repository-local dependency store
when host caches cannot cross filesystems. The OpenClaw broker login endpoint
is `https://crabbox.openclaw.ai`; normal brokered validation does not require
asking for AWS keys.

Live Gateway, channel, and agent-turn proof uses an isolated
`OPENCLAW_STATE_DIR`, a free port, and the real user path. Test-only plugin
artifacts may use `OPENCLAW_ALLOW_PLUGIN_INSTALL_OVERRIDES=1`; that does not make
them official installs. Before sharing WebVNC, inspect a screenshot of the
working app. Keep proof media out of the product repository and compare source
hashes before and after generator runs. If a final timing result is written but
portal synchronization hangs, interrupt only the task wrapper and independently
verify lease cleanup; never stop the operator's Gateway.

## Routine local order

1. `pnpm test:changed` for changed-scope Vitest proof.
2. `pnpm test <path-or-filter>` for one file, directory, or explicit target.
3. `pnpm test` only when you intentionally need the full local Vitest suite.

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
Existing package build entry paths and Vitest source parents stay unchanged. Other
Worker-thread entries and arbitrary source CLI fixtures remain outside this declared set.

The session-title retention test declares its title-reader and session-utils roots
in this same generation. Each fresh heap-measurement child runs their JavaScript
without spending its execution deadline on TypeScript imports.

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

Packaged SDK declarations belong to one staged owner shared by full, package, and
`ciArtifacts` builds. It serializes the two canonical tsdown SDK groups on a miss
and caches their complete staged generation. Each successful compiler supplies its
source membership through a private staged receipt; missing receipts or inputs
changed during compilation prevent publication. The shared input snapshot policy
validates consumed bytes, inherited configuration, generator and manifest inputs,
and resolution topology without starting a compiler on hits. Cache hits restore
into fresh staging and pass the same entry and relative declaration closure checks
before publication.
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

## Control UI, TUI, and extension lanes

- **Control UI E2E:** `pnpm test:ui:e2e` runs the Vitest + Playwright lane, usually against a mocked Gateway WebSocket. Four resource groups retain two execution phases: `ui-e2e-bundled` and `ui-e2e-standalone` run first with at most two workers total; `ui-e2e-serial` and `ui-e2e-serial-standalone` then share one worker. The two bundle consumers lazily share one temporary UI bundle/preview until the invocation closes. Standalone projects own their fixture, source, or custom-build servers; selecting only standalone suites avoids the shared bundle build. Every selected project receives Chromium metadata, and new E2E files default to parallel bundled ownership. The root config retains the full discovery inventory: `ui/src/**/*.e2e.test.ts` plus the QA Lab media-transcript real-Gateway suite. Shared mocks/controls live in `ui/src/test-helpers/control-ui-e2e.ts`. Some suites start isolated real Gateways; `OPENCLAW_UI_E2E_SKIP_REAL_GATEWAY=1` excludes them. `pnpm test:e2e` includes this lane, with no additional CI jobs for resource groups. Use Testbox/Crabbox only when clean Linux/browser parity is part of the proof. In a linked worktree, `node scripts/run-vitest.mjs run --config test/vitest/vitest.ui-e2e.config.ts --configLoader runner ui/src/e2e/chat-flow.messaging.e2e.test.ts` avoids pnpm dependency reconciliation for a targeted local run.
- **TUI PTY tests:** `node scripts/run-vitest.mjs run --config test/vitest/vitest.tui-pty.config.ts` runs the fast fake-backend PTY lane. `OPENCLAW_TUI_PTY_INCLUDE_LOCAL=1` or `pnpm tui:pty:test:watch --mode local` runs the slower `tui --local` smoke, which mocks only the external model endpoint. CI also sets `OPENCLAW_TUI_PTY_USE_BUILT_CLI=1` after building `dist/`; use that flag only when exact-head built artifacts already exist. Assert stable visible text or fixture calls, not raw ANSI snapshots.
- `pnpm test:extensions` and `pnpm test extensions` run all extension/plugin shards. Heavy channel plugins, the browser plugin, and OpenAI run as dedicated shards; other plugin groups stay batched. `pnpm test extensions/<id>` runs one bundled plugin lane.
- **Browser native host:** `node scripts/run-vitest.mjs extensions/browser/src/browser/extension-install.native-host.e2e.test.ts` runs the real native messaging launcher on macOS or Linux against built dist with synthetic installation state; it does not launch Chrome or a Gateway. Windows skips this POSIX process proof because [native bootstrap uses manual pairing there](/tools/chrome-extension#requirements). The E2E owner prepares artifacts before workers. With an already-built candidate, prefix the command with `OPENCLAW_E2E_USE_PREBUILT_DIST=1` to reuse it; missing artifacts fail the test. This case belongs to `pnpm test:e2e`, not the browser source shard or untargeted `pnpm test` unit suite. Linux CI runs it explicitly in `build-artifacts` and validates a JSON report proving the exact named test passed. The workflow skips only frozen historical checkouts missing this test file; that skip is unavailable proof, not a pass or coverage.
- Source files with sibling tests map to that sibling before falling back to wider directory globs. Helper edits under `src/channels/plugins/contracts/test-helpers`, `src/plugin-sdk/test-helpers`, and `src/plugins/contracts` use a local import graph to run importing tests instead of broad-running every shard when the dependency path is precise.
- Contract directory targets fan out to their contract lanes: `pnpm test src/channels/plugins/contracts` runs the four channel contract configs and `pnpm test src/plugins/contracts` runs the plugin contracts config, since the generic `channels`/`plugins` projects exclude `contracts/**`.
- `auto-reply` splits into three dedicated configs (`core`, `top-level`, `reply`) so the reply harness does not dominate the lighter top-level status/token/helper tests.
- Selected `plugin-sdk` and `commands` test files route through dedicated light lanes that keep only `test/setup.ts`, leaving runtime-heavy cases on their existing lanes.
- Base Vitest config defaults to `pool: "threads"` and `isolate: false`, with the shared non-isolated runner enabled across repo configs.
- `pnpm test:channels` runs `vitest.channels.config.ts`.

### Retained mocked Control UI proof

For startup ownership changes, exercise authenticated hello before browser recovery migration finishes. Project and environment discovery can start from hello; migration completion must not refetch those catalogs or invalidate an admitted start. Keep changed-owner, process-restart, and late-result fences covered separately. Count storage reads by key around rerenders, typing, and streaming without recording credential values. Compare route payload bytes and loaded module closures separately from timings; CSS ownership changes also need retained screenshots and computed-style or geometry checks across New session and Chat.

Ordinary mocked browser screenshots, recordings, and reports use fresh directories
for each test attempt or standalone capture invocation. The Node-only
`createControlUiE2eArtifactDir(scope, parentDir?)` helper in
`ui/src/test-helpers/control-ui-e2e-artifacts.ts` prints the actual allocated path.
An explicit parent wins; otherwise it uses the trimmed existing
`OPENCLAW_UI_E2E_ARTIFACT_DIR`, then the repository's `.artifacts/control-ui-e2e`
parent. Existing feature-specific directory controls and script output arguments
select parents, with unique children beneath them. Explicit screenshot filename
controls preserve the basename and print the relocated path.

Keep capture gates independent from allocation: `OPENCLAW_CAPTURE_UI_PROOF`,
`OPENCLAW_UI_E2E_RECORD`, and output-presence gates retain their existing meanings.
Allocate during scenario execution or `beforeEach`, and pass the same owner to
shared capture helpers so screenshots, reports, and video stay together. Distinguish
stage names within an attempt. Close the browser context before finalizing video.

Successful and failed evidence is retained. Cleanup is manual: remove only exact
directories that you own and have finished reviewing. Never recursively delete
the shared parent before a replay. Disposable build/media fixtures and temporary
raw video have their own cleanup. New captures cannot recover overwritten evidence;
do not describe a replay as recovery of lost files.

Timeout diagnostics allocate fresh children beneath the existing
`OPENCLAW_UI_E2E_DIAGNOSTIC_DIR` or default timeout directory, keeping each PNG and
JSON report together. Mantis allocates an invocation directory for setup logs,
capture attempts, and its report; the builder preserves each attempt's relative
paths and refuses to overwrite an existing report.

Separate output owners remain: real-Gateway suites, `chat-outbox-*`, and
`chat-attachment-read-lifecycle`. Do not assume those owners have the ordinary
mocked proof retention guarantee.

## Gateway and E2E

- Gateway tests are included in the untargeted `pnpm test` full suite; run them alone with `pnpm test:gateway`.
- `pnpm test:e2e`: repo E2E aggregate = `pnpm test:e2e:gateway && pnpm test:e2e:agent-plugin-gateway && pnpm test:ui:e2e`.
- `pnpm test:e2e:gateway`: gateway end-to-end smoke tests (multi-instance WS/HTTP/node pairing). Defaults to `threads` + `isolate: false` with one worker in `vitest.e2e.config.ts`; opt into parallelism with `OPENCLAW_E2E_WORKERS=<n>` (capped at 16), and enable verbose logs with `OPENCLAW_E2E_VERBOSE=1`.
  Broad runs prepare the shared runtime once, then use four sequential Vitest shards in fresh processes to bound worker memory. The worker limit applies within each process; ordinary test failures are retained while remaining shards finish. Explicit filters, watch mode, caller-supplied shards, coverage, and report-output options keep one direct invocation.
- `pnpm test:live`: provider live tests (Claude/Minimax/DeepSeek/z.ai/etc, gated by `*.live.test.ts`). Requires API keys and `LIVE=1` (or `OPENCLAW_LIVE_TEST=1`) to unskip; verbose output with `OPENCLAW_LIVE_TEST_QUIET=0`.

## Full Docker suite (`pnpm test:docker:all`)

Builds the shared live-test image, packs OpenClaw once as an npm tarball, builds/reuses a bare Node/Git runner image plus a functional image that installs that tarball into `/app`, then runs Docker smoke lanes through a weighted scheduler. `scripts/package-openclaw-for-docker.mjs` is the stable local/CI package packer entrypoint and validates the tarball plus `dist/postinstall-inventory.json` before Docker consumes it.

- Bare image (`OPENCLAW_DOCKER_E2E_BARE_IMAGE`): installer/update/plugin-dependency lanes; mounts the prebuilt tarball instead of copied repo sources.
- Functional image (`OPENCLAW_DOCKER_E2E_FUNCTIONAL_IMAGE`): normal built-app functionality lanes.
- Lane definitions: `scripts/lib/docker-e2e-scenarios.mts`. Planner: `scripts/lib/docker-e2e-plan.mts`. Executor: `scripts/test-docker-all.mjs`.
- `node scripts/test-docker-all.mjs --plan-json` emits the scheduler-owned CI plan (lanes, image kinds, package/live-image needs, state scenarios, credential checks) without building or running Docker.

Scheduling knobs (env vars, defaults in parentheses):

| Env var                                                                                                         | Default             | Purpose                                                                                                                                                                                                                                                                                    |
| --------------------------------------------------------------------------------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `OPENCLAW_DOCKER_ALL_PARALLELISM`                                                                               | 10                  | Process slots.                                                                                                                                                                                                                                                                             |
| `OPENCLAW_DOCKER_ALL_TAIL_PARALLELISM`                                                                          | 10                  | Provider-sensitive tail pool.                                                                                                                                                                                                                                                              |
| `OPENCLAW_DOCKER_ALL_LIVE_LIMIT`                                                                                | 9                   | Heavy live-provider lane cap.                                                                                                                                                                                                                                                              |
| `OPENCLAW_DOCKER_ALL_NPM_LIMIT`                                                                                 | 5                   | npm-resource lane cap.                                                                                                                                                                                                                                                                     |
| `OPENCLAW_DOCKER_ALL_SERVICE_LIMIT`                                                                             | 7                   | Service-resource lane cap.                                                                                                                                                                                                                                                                 |
| `OPENCLAW_DOCKER_ALL_LIVE_CLAUDE_LIMIT` / `_CODEX_LIMIT` / `_GEMINI_LIMIT` / `_DROID_LIMIT` / `_OPENCODE_LIMIT` | 4                   | Per-provider heavy-lane caps.                                                                                                                                                                                                                                                              |
| `OPENCLAW_DOCKER_ALL_LIVE_OPENAI_LIMIT` / `_TELEGRAM_LIMIT`                                                     | 1                   | Narrower per-provider caps.                                                                                                                                                                                                                                                                |
| `OPENCLAW_DOCKER_ALL_WEIGHT_LIMIT` / `OPENCLAW_DOCKER_ALL_DOCKER_LIMIT`                                         | -                   | Override for larger hosts.                                                                                                                                                                                                                                                                 |
| `OPENCLAW_DOCKER_ALL_START_STAGGER_MS`                                                                          | 2000                | Delay between lane starts, avoids local Docker daemon create storms.                                                                                                                                                                                                                       |
| `OPENCLAW_DOCKER_ALL_LANE_TIMEOUT_MS`                                                                           | 7,200,000 (120 min) | Per-lane fallback timeout; selected live/tail lanes use tighter caps.                                                                                                                                                                                                                      |
| `OPENCLAW_DOCKER_ALL_LIVE_RETRIES`                                                                              | 1                   | Retries for transient live-provider failures.                                                                                                                                                                                                                                              |
| `OPENCLAW_DOCKER_ALL_DRY_RUN`                                                                                   | off                 | Print the lane manifest without running Docker.                                                                                                                                                                                                                                            |
| `OPENCLAW_DOCKER_ALL_STATUS_INTERVAL_MS`                                                                        | 30000               | Active-lane status print interval.                                                                                                                                                                                                                                                         |
| `OPENCLAW_DOCKER_ALL_TIMINGS`                                                                                   | on                  | Reuse `.artifacts/docker-tests/lane-timings.json` for longest-first ordering; set to `0` to disable.                                                                                                                                                                                       |
| `OPENCLAW_DOCKER_ALL_LIVE_MODE`                                                                                 | -                   | `skip` for deterministic/local lanes only, `only` for live-provider lanes only. Aliases: `pnpm test:docker:local:all`, `pnpm test:docker:live:all`. Live-only mode merges main and tail live lanes into one longest-first pool so provider buckets pack Claude/Codex/Gemini work together. |
| `OPENCLAW_LIVE_CLI_BACKEND_SETUP_TIMEOUT_SECONDS`                                                               | 180                 | CLI backend Docker setup timeout.                                                                                                                                                                                                                                                          |

Env var pattern for resource caps is `OPENCLAW_DOCKER_ALL_<RESOURCE>_LIMIT` (resource name uppercased, non-alphanumerics collapsed to `_`).

Other behavior: the runner preflights Docker by default, cleans stale OpenClaw E2E containers, shares provider CLI tool caches between compatible lanes, and stops scheduling new pooled lanes after the first failure unless `OPENCLAW_DOCKER_ALL_FAIL_FAST=0` is set. If one lane exceeds the effective weight/resource cap on a low-parallelism host, it can still start from an empty pool and run alone until it releases capacity. Per-lane logs, `summary.json`, `failures.json`, and phase timings write under `.artifacts/docker-tests/<run-id>/`; use `pnpm test:docker:timings <summary.json>` to inspect slow lanes and `pnpm test:docker:rerun <run-id|summary.json|failures.json>` to print cheap targeted rerun commands.

### Notable Docker lanes

| Command                                                                                      | Verifies                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm test:docker:browser-cdp-snapshot`                                                      | Chromium-backed source E2E container with raw CDP + isolated Gateway; `browser doctor --deep` CDP role snapshots include link URLs, cursor-promoted clickables, iframe refs, and frame metadata.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `pnpm test:docker:skill-install`                                                             | Installs the packed tarball in a bare Docker runner with `skills.install.allowUploadedArchives: false`, resolves a current skill slug from live ClawHub search, installs via `openclaw skills install`, and verifies `SKILL.md`, `.clawhub/origin.json`, `.clawhub/lock.json`, and `skills info --json`.                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `pnpm test:docker:live-cli-backend:claude`, `:claude:resume`, `:claude:cache`, `:claude:mcp` | Focused CLI backend live probes; `:claude:cache` settles the no-tool prompt shape, then requires at least 90% prompt-cache reuse on the following dirty-workspace resume and on the steady resume after a thinking-level change. Gemini has matching `:resume` and `:mcp` aliases.                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `pnpm test:docker:openwebui`                                                                 | Dockerized OpenClaw + Open WebUI: sign in, check `/api/models`, run a real proxied chat through `/api/chat/completions`. Requires a usable live model key and pulls an external image; not expected to be CI-stable like the unit/e2e suites.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `pnpm test:docker:mcp-channels`                                                              | Seeded Gateway container plus a client container spawning `openclaw mcp serve`: routed conversation discovery, transcript reads, attachment metadata, live event queue behavior, outbound send routing, and Claude-style channel + permission notifications over the real stdio bridge (assertion reads raw stdio MCP frames directly).                                                                                                                                                                                                                                                                                                                                                                                                               |
| `pnpm test:docker:upgrade-survivor`                                                          | Installs the packed tarball over a dirty old-user fixture, runs package update plus non-interactive doctor without live provider/channel keys, starts a loopback Gateway, checks agents/channel config/plugin allowlists/workspace/session state/stale legacy plugin dependency state/startup/RPC status survive.                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `pnpm test:docker:published-upgrade-survivor`                                                | Installs `openclaw@latest` by default, seeds realistic existing-user files, configures via a baked `openclaw config set` recipe, updates to the packed tarball, runs non-interactive doctor, writes `.artifacts/upgrade-survivor/summary.json`, checks `/healthz`, `/readyz`, RPC status. Override with `OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SPEC`, expand a matrix with `OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SPECS`, or add scenario fixtures with `OPENCLAW_UPGRADE_SURVIVOR_SCENARIOS=reported-issues` (includes `configured-plugin-installs` and `stale-source-plugin-shadow`). Package Acceptance exposes these as `published_upgrade_survivor_baseline(s)` / `_scenarios` and resolves meta tokens like `last-stable-4` or `all-since-2026.4.23`. |
| `pnpm test:docker:update-migration`                                                          | Published-upgrade survivor harness in the `plugin-deps-cleanup` scenario, starting at the latest stable release by default. The `Update Migration` workflow pins that baseline before fanout; pass `baselines=all-since-2026.4.23` for an explicit historical cleanup replay.                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `pnpm test:docker:plugins`                                                                   | Install/update smoke for local path, `file:`, npm registry packages with hoisted dependencies, git moving refs, ClawHub fixtures, marketplace updates, and Claude-bundle enable/inspect.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

### Sandbox compatibility lanes

| Command                                      | Verifies                                                                                                                                                                                                                                                           |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm test:e2e:openshell`                    | Real OpenShell gateway, isolated control-plane workspace, custom image, remote and mirrored filesystems, eight-way mixed exec/file stress, exact host/remote inventories, failure recovery, SSH cleanup, protected host metadata, and deny/allow network policies. |
| `pnpm test:docker:package-install`           | Packed OpenClaw npm artifact installation into a clean global prefix, then CLI version and help startup from the installed package.                                                                                                                                |
| `pnpm test:docker:openai-web-search-minimal` | Mocked TLS endpoint with a private test CA, isolated Gateway startup, and web-search request handling through the configured certificate trust path.                                                                                                               |
| `pnpm test:docker:browser-cdp-snapshot`      | Chromium startup, raw CDP connectivity, isolated Gateway browser commands, doctor output, and accessibility snapshot roles.                                                                                                                                        |
| `pnpm test:docker:kitchen-sink-rpc`          | Installed plugin commands and catalog tools, read-only Gateway RPC traversal, authentication boundaries, channel lifecycle, and resource ceilings.                                                                                                                 |
| `pnpm test:docker:kitchen-sink-plugin`       | Packaged and registry plugin install flows, plugin execution, expected unsupported-version failures, ClawHub fallback, and npm-to-ClawHub migration.                                                                                                               |

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

## Test performance tooling

- `pnpm test:perf:imports`: enables Vitest import-duration + import-breakdown reporting, while still using scoped lane routing for explicit file/directory targets. `pnpm test:perf:imports:changed` scopes the same profiling to files changed since `origin/main`.
- `pnpm test:perf:changed:bench -- --ref <git-ref>` benchmarks the routed changed-mode path against the native root-project run for the same committed git diff; `pnpm test:perf:changed:bench -- --worktree` benchmarks the current worktree change set without committing first.
- `pnpm test:perf:profile:main` writes a CPU profile for the Vitest main thread; `pnpm test:perf:profile:runner` writes CPU + heap profiles for each unit worker. Both print their output directory (a temporary directory by default). Use `-- --output-dir <dir>` or `OPENCLAW_VITEST_PROFILE_DIR` to retain profiles at a chosen location.
- `pnpm test:perf:groups --full-suite --allow-failures --output .artifacts/test-perf/baseline-before.json`: runs every full-suite Vitest leaf config serially and writes grouped duration data plus per-config JSON/log artifacts. Full-suite reports isolate files by default so retained module graphs and GC pauses from earlier files are not charged to later assertions; pass `-- --no-isolate` only when intentionally profiling shared-worker accumulation. `pnpm test:perf:groups:compare .artifacts/test-perf/baseline-before.json .artifacts/test-perf/after-agent.json` compares grouped reports after a performance-focused change.
- Full, extension, and include-pattern shard runs update local timing data in `.artifacts/vitest-shard-timings.json`; later whole-config runs use those timings to balance slow and fast shards. Include-pattern CI shards append the shard name to the timing key, which keeps filtered shard timings visible without replacing whole-config timing data. Set `OPENCLAW_TEST_PROJECTS_TIMINGS=0` to ignore the local timing artifact.
- `pnpm ci:timings:refit`: regenerate committed `config/ci-test-timings.json` from the last five successful main CI runs; add `--dry-run` to preview the changed-entry table. This file owns per-file UI E2E and per-profile compact-group weights, unlike the gitignored `.artifacts/vitest-shard-timings.json` whole-config timing cache. Independent CI shards use only the committed weights, never that cache. See [CI timing refits](/ci#measured-shard-weights) for the daily refresh and sampling rules.

Runner profiling preserves the selected `forks` or `threads` pool, isolation, environment, and custom runners extending Vitest's `TestRunner`. Capture starts in a Node preload before Vitest worker imports, spans all files assigned to that worker, and finishes both profile files in awaited worker cleanup before teardown is acknowledged. It does not depend on exit-time profile flushing. Root global setup configures every selected project without replacing its reporters or setup. Main capture spans Vitest/Vite startup through run completion and close. Process termination before cleanup, bootstrap failures before runner construction, and teardown timeouts can still prevent output. Browser/VM pools, custom runners without `onCleanupWorkerContext`, and additional native `--cpu-prof`/`--heap-prof` flags are rejected for runner profiling.

Forward Vitest options after the profiler separator. Forwarded options use Vitest's native CLI validation before loading config. Config-only settings, such as `runner` and `globalSetup`, belong in the Vitest config file, not CLI flags. For example:

```bash
pnpm test:perf:profile:runner -- --output-dir .artifacts/profiles -- --config test/vitest/vitest.unit.config.ts --pool threads
```

`pnpm test:extensions:memory` profiles built plugin index entries from `dist/extensions` (including nested `dist` output) and package-local `extensions/<id>/dist` output; TypeScript source entries are excluded. Root artifacts take precedence when both builds exist. Selecting an already-built plugin with `--extension <id>` reuses its output without requiring unrelated plugin builds; build the plugin package first if its output is not supplied by `pnpm build`.

Native imports also need the plugin's declared dependencies and a resolvable `openclaw` host package. The profiler does not install or link dependencies: missing dependencies remain import failures in the JSON report and cause a nonzero exit.

## Benchmarks

<Accordion title="Model latency (scripts/bench-model.ts)">

```bash
pnpm tsx scripts/bench-model.ts --runs 10
```

Optional env: `MINIMAX_API_KEY`, `MINIMAX_BASE_URL`, `MINIMAX_MODEL`, `ANTHROPIC_API_KEY`. Default prompt: "Reply with a single word: ok. No punctuation or extra text."

</Accordion>

<Accordion title="CLI startup (scripts/bench-cli-startup.ts)">

```bash
pnpm test:startup:bench
pnpm test:startup:bench:smoke
pnpm test:startup:bench:save
pnpm test:startup:bench:update
pnpm test:startup:bench:check
pnpm tsx scripts/bench-cli-startup.ts --runs 12
pnpm tsx scripts/bench-cli-startup.ts --preset real --case status --case gatewayStatus --runs 3
pnpm tsx scripts/bench-cli-startup.ts --entry openclaw.mjs --entry-secondary dist/entry.js --preset all
```

Presets:

- `startup`: `--version`, `--help`, `health`, `health --json`, `status --json`, `status`
- `real`: `health`, `status`, `status --json`, `sessions`, `sessions --json`, `tasks --json`, `tasks list --json`, `tasks audit --json`, `agents list --json`, `gateway status`, `gateway status --json`, `gateway health --json`, `config get gateway.port`
- `all`: both presets combined

Output includes `sampleCount`, avg, p50, p95, min/max, exit-code/signal distribution, and max RSS per command. `--cpu-prof-dir` / `--heap-prof-dir` write V8 profiles per run.

Saved output: `pnpm test:startup:bench:smoke` writes `.artifacts/cli-startup-bench-smoke.json`; `pnpm test:startup:bench:save` writes `.artifacts/cli-startup-bench-all.json` (`runs=5 warmup=1`). Checked-in fixture: `test/fixtures/cli-startup-bench.json`, refreshed by `pnpm test:startup:bench:update`, compared by `pnpm test:startup:bench:check`.

</Accordion>

<Accordion title="Gateway startup (scripts/bench-gateway-startup.ts)">

Defaults to the built CLI entry at `dist/entry.js`; run `pnpm build` first. Pass `--entry scripts/run-node.mjs` to measure the source runner instead, and keep those results separate from built-entry baselines.

```bash
pnpm test:startup:gateway -- --runs 5 --warmup 1
pnpm test:startup:gateway -- --case skipChannels --case fiftyPlugins --runs 5
node --import tsx scripts/bench-gateway-startup.ts --case default --runs 5 --output .artifacts/gateway-startup.json
node --import tsx scripts/bench-gateway-startup.ts --case incidentCombined --runs 5 --warmup 1 --timeout-ms 60000 --output .artifacts/gateway-startup-incident.json
```

Case ids: `default`, `skipChannels` (channel startup skipped), `oneInternalHook`, `allInternalHooks`, `fiftyPlugins` (50 manifest plugins), `fiftyStartupLazyPlugins` (50 startup-lazy manifest plugins), `incidentDatabase`, `incidentNullMetadata`, `incidentWorkspace`, `incidentPackagedPlugins`, and `incidentCombined`.

The incident cases are opt-in because each sample builds an isolated, non-sensitive load fixture: current global and agent databases, 100,000 retained audit rows with freelist fragmentation, eight agent workspaces containing 80,000 files (about 800 MB), and the packaged plugin inventory. Run the combined case only on a clean machine with enough free disk space; the fixture directory is removed after each sample. `incidentCombined` fails when `/healthz` p95 reaches 30 seconds or `/readyz` p95 reaches 60 seconds.

Output includes first process output, `/healthz`, `/readyz`, HTTP listen log time, Gateway ready log time, CPU time, CPU core ratio, max RSS, heap, startup trace metrics, event-loop delay, and plugin lookup-table detail metrics. The script sets `OPENCLAW_GATEWAY_STARTUP_TRACE=1` in the child Gateway environment.

`/healthz` is liveness (HTTP server can answer). `/readyz` is usable readiness (startup plugin sidecars, channels, and ready-critical post-attach work have settled). Startup hooks dispatch asynchronously and are not part of the readiness guarantee. Ready log time is the Gateway's internal timestamp, useful for process-side attribution but not a substitute for the external `/readyz` probe.

Use JSON output or `--output` when comparing changes. Use `--cpu-prof-dir` only after trace output points at import, compile, or CPU-bound work that phase timings alone cannot explain.

</Accordion>

<Accordion title="Gateway restart (scripts/bench-gateway-restart.ts)">

macOS and Linux only (uses SIGUSR1 for in-process restarts; fails immediately on Windows). Same built-entry default and `--entry scripts/run-node.mjs` override as gateway startup above.

```bash
pnpm test:restart:gateway -- --case skipChannels --runs 1 --restarts 5
pnpm test:restart:gateway -- --case default --runs 3 --restarts 3 --warmup 1
```

Case ids: `skipChannels`, `skipChannelsAcpxProbe` (ACPX startup probe on), `skipChannelsNoAcpxProbe` (probe off), `default`, `fiftyPlugins`.

Output includes next `/healthz`, next `/readyz`, downtime, restart ready timing, CPU, RSS, startup trace metrics for the replacement process, and restart trace metrics for signal handling, active-work drain, close phases, next start, ready timing, and memory snapshots. The script sets `OPENCLAW_GATEWAY_STARTUP_TRACE=1` and `OPENCLAW_GATEWAY_RESTART_TRACE=1`.

Use this benchmark when a change touches restart signaling, close handlers, startup-after-restart, sidecar shutdown, service handoff, or readiness after restart. Start with `skipChannels` to isolate Gateway mechanics from channel startup; use `default` or plugin-heavy cases only after the narrow case explains the restart path. Trace metrics are attribution hints, not verdicts — judge a restart change from multiple samples, the matching owner span, `/healthz`/`/readyz` behavior, and the user-visible restart contract.

</Accordion>

## Onboarding E2E (Docker)

Optional; only needed for containerized onboarding smoke tests. Full cold-start flow in a clean Linux container:

```bash
scripts/e2e/onboard-docker.sh
```

Drives the interactive wizard via a pseudo-tty, verifies config/workspace/session state, then starts the gateway and runs `openclaw health`.

## QR import smoke (Docker)

Ensures the maintained QR runtime helper loads under the supported Docker Node runtimes (Node 24 default, Node 22 compatible):

```bash
pnpm test:docker:qr
```

## Related

- [Testing](/help/testing)
- [Testing live](/help/testing-live)
- [Testing updates and plugins](/help/testing-updates-plugins)
