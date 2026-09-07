---
summary: "Local command equivalents, shrink-only ratchets, and Crabbox remote proof"
title: "Local checks and Testbox"
read_when:
  - You want to reproduce a CI lane on your own machine
  - You are producing Testbox or Crabbox proof for a pull request
---

## Local equivalents

The lint wrapper owns Go resource limits for current CI. It applies them on
hosts with fewer than eight available CPUs or less than 24 GiB of memory,
without applying lint defaults to declaration preparation. Explicit Go settings
remain inherited. Frozen revisions retain the workflow limits because their
wrappers can predate this policy.

Oxlint keeps `eslint/no-redeclare` enabled for JavaScript. For `.ts`, `.tsx`,
`.mts`, and `.cts`, `tsgo` owns declaration validity, including intentional
type/value pairs with the same public name. `eslint/no-var` remains enabled
for all source formats; the compiler does not reject every `var` redeclaration.

`eslint/no-eval` rejects direct and indirect evaluation by default. Only
`extensions/qa-lab/src/web-runtime.ts` allows indirect evaluation, because QA
scenario scripts need page-global declaration semantics that Playwright's
expression evaluation does not preserve. Direct evaluation remains an error
there. Tests that execute emitted browser scripts use isolated `node:vm`
contexts instead of process-global evaluation.

```bash
pnpm changed:lanes                            # inspect the local changed-lane classifier for origin/main...HEAD
pnpm check:changed                            # smart local check gate: changed formatting/typecheck/lint/guards by boundary lane
pnpm check                                    # fast local gate: prod tsgo + sharded lint + parallel fast guards
pnpm check:test-types
pnpm check:timed                              # same gate with per-stage timings
pnpm build:strict-smoke
pnpm check:architecture
pnpm test:gateway:watch-regression
OPENCLAW_TUI_PTY_INCLUDE_LOCAL=1 node scripts/run-vitest.mjs run --config test/vitest/vitest.tui-pty.config.ts
pnpm test                                     # vitest tests
pnpm test:changed                             # cheap smart changed Vitest targets
pnpm test:ui                                  # Control UI unit/browser suite
pnpm ui:i18n:check                            # generated Control UI locale parity (release gate)
pnpm native:i18n:baseline                     # update source-owned native extraction inventory
pnpm native:i18n:verify                       # source inventory + Android/Apple localization safety
pnpm native:i18n:check                        # strict translated/platform-generated parity (release gate)
pnpm test:channels
pnpm test:contracts:channels
pnpm check:docs                               # docs format + lint + broken links
pnpm build                                    # build dist when CI artifact/smoke checks matter
pnpm ios:build                                # generate and build the iOS app project
pnpm ci:timings                               # summarize the latest origin/main push CI run
pnpm ci:timings:recent                        # compare recent successful main CI runs
pnpm ci:timings:trend                         # 72h main baseline; latest 12h versus prior 12h
node scripts/ci-run-timings.mjs <run-id>      # summarize wall time, queue time, and slowest jobs
node scripts/ci-run-timings.mjs --latest-main # ignore issue/comment noise and choose origin/main push CI
node scripts/ci-run-timings.mjs --recent 10   # compare recent successful main CI runs
node scripts/ci-run-timings.mjs --trend-hours 72 --compare-hours 12 --detail-runs 100 --output .artifacts/ci-timings/trend.json
pnpm test:perf:groups --full-suite --allow-failures --output .artifacts/test-perf/baseline-before.json
pnpm test:perf:groups:compare .artifacts/test-perf/baseline-before.json .artifacts/test-perf/after-agent.json
pnpm test:startup:memory
pnpm test:extensions:memory -- --json .artifacts/openclaw-performance/source/mock-provider/extension-memory.json
pnpm perf:kova:summary --report .artifacts/kova/reports/mock-provider/report.json --output .artifacts/kova/summary.md
```

The native source gate covers catalog-owned macOS, iOS, and shared Apple source
roots. Linux-runnable source extraction requires explicit typed localized formats
(for example, `String(format: String(localized: "Expires in %lld minutes"), minutes)`
for an `Int`) instead of arbitrary Swift interpolation. Constrained inflected
count resources are supported on both platforms. Use explicit verbatim text for
user, system, or already-localized data.

## Surface ratchets

Two shrink-only budgets guard the configuration surface. Both fail CI on growth
until the budget file is consciously updated in the same PR, and both demand a
ratchet-down when cleanup lowers the real count.

- `config/env-var-count-budget.txt` caps the number of distinct `OPENCLAW_*`
  names in production source under `src/`, `packages/`, and `extensions/`
  (tests and QA Lab excluded). Checked by `node --import tsx scripts/check-env-var-count.mts`.
  Removing env vars: lower the number in the same PR. Adding one is a
  config-surface decision — justify it in the PR body.
- `docs/.generated/config-baseline.counts.json` caps the per-kind
  (core/channel/plugin) `openclaw.json` schema entry counts. Checked by
  `pnpm config:docs:check`; regenerate with `pnpm config:docs:gen` after any
  schema change.

## Local check gates and changed routing

### Config baseline count ratchet

`pnpm config:docs:check` rejects undocumented config-surface growth and corrupt or stale count snapshots. When a reviewed product change intentionally adds schema paths, run `pnpm config:docs:gen`, inspect the core/channel/plugin count deltas and generated SHA-256 files, and commit the conscious baseline bump with the schema, help, labels, migration, and tests. Do not hand-edit the counts file to bypass the ratchet.

Config authors must also tier new leaves for Settings. Add `advanced: false` or
`advanced: true` at the leaf, or place the key beneath an ancestor whose tier
all descendants should inherit. Unclassified roots fail the schema quality
test with copy-paste stubs; paths without an ancestor are advanced by default.
The curated common-leaf snapshot makes intentional tier changes visible in
review.

Local changed-lane logic lives in `scripts/changed-lanes.mjs` and is executed by `scripts/check-changed.mjs`. That local check gate is stricter about architecture boundaries than the broad CI platform scope:

- core production changes run core prod and core test typecheck plus core lint/guards;
- core test-only changes run only core test typecheck plus core lint;
- root TypeScript tests and support files run root test typecheck plus targeted type-aware lint within `test/tsconfig/tsconfig.test.root.json`; the discoverable `test/tsconfig.json` inherits that source-only program. It includes `.ts`, `.tsx`, `.d.mts`, and `.d.cts`, not ordinary `.mts`/`.cts`; fixtures and built-artifact Docker clients stay outside targeted root lint;
- extension production changes run extension prod and extension test typecheck plus extension lint;
- extension test-only changes run extension test typecheck plus extension lint;
- bundled channel manifests, package metadata, config schemas, UI hints, and generator owners also run the bundled channel config metadata drift check;
- config schema/help, bundled plugin metadata, relative-import dependencies of source schema entries, generator/selector owners, and tracked config baseline changes run `pnpm config:docs:check`, including baseline files mixed with ordinary docs; all-lane and release metadata plans include it once;
- public Plugin SDK or plugin-contract changes expand to extension typecheck because extensions depend on those core contracts (Vitest extension sweeps stay explicit test work);
- release metadata-only version bumps run targeted version/config/root-dependency checks;
- unknown root/config changes fail safe to all check lanes.

Schema dependency selection reuses the local relative-import graph, including re-exports and deleted leaf paths still referenced by surviving source. Shared SDK channel UI-hint and secret-input schema owners, plus the workspace sensitive-URL hint owner, are explicit roots across alias boundaries. Edits to their SDK facades are also selected without traversing unrelated facade runtime dependencies. This is not universal alias or computed-import resolution.

Local changed-test routing lives in `scripts/test-projects.test-support.mts` and is intentionally cheaper than `check:changed`: direct test edits run themselves, source edits prefer explicit mappings, then sibling tests and import-graph dependents. Shared group-room delivery config is one of the explicit mappings: changes to the group visible-reply config, source reply delivery mode, or the message-tool system prompt route through the core reply tests plus Discord and Slack delivery regressions so a shared default change fails before the first PR push. Use `OPENCLAW_TEST_CHANGED_BROAD=1 pnpm test:changed` only when the change is harness-wide enough that the cheap mapped set is not a trustworthy proxy.

## Testbox validation

Crabbox is the repo-owned remote-box wrapper for maintainer Linux proof. Agent
sessions run trusted development tests, changed gates, typecheck/lint, and
builds locally by default. They use Crabbox when the environment is part of the
proof: clean-machine, install/package, Docker, E2E, live, desktop, cross-OS, or
CI-parity work, or when the operator explicitly requests remote proof. Crabbox
is not generic compute offload. `.crabbox.yaml` defaults remote proof to
`blacksmith-testbox`. Its configured workflow hydrates provider and agent
credentials, so untrusted contributor or fork code must use secretless fork CI
or sanitized direct AWS Crabbox instead.
Blacksmith Testbox proof requires Crabbox 0.48.0 or newer. That release binds
stop and reuse to exact local claims, fences cleanup against ownership changes,
retains failed-cleanup state for recovery, and reconciles terminal state before
dropping local ownership. Older binaries are rejected before OpenClaw acquires
or reuses Testbox capacity.
The check workflow hydrates its pinned dispatch commit with a depth-1 checkout;
the changed gate later reconstructs the exact merge base and synced final tree.
Sanitized AWS runs set `CRABBOX_ENV_ALLOW=CI`, pass
`--no-hydrate`, and use a fresh temporary remote `HOME`; this prevents the repo
`OPENCLAW_*` allowlist and existing auth profiles from reaching untrusted code.
They use a newly warmed lease dedicated to that untrusted source, never a
trusted or previously hydrated lease. Launch an installed trusted Crabbox
binary from a clean trusted `main` checkout and fetch only the remote PR with
`--fresh-pr`; never execute the untrusted checkout's wrapper or config locally.
Unset `CRABBOX_AWS_INSTANCE_PROFILE` and fail closed unless resolved
`aws.instanceProfile` is empty. Before any install/test, use trusted
absolute-path tools to require an IMDSv2 token, prove the IAM credentials
endpoint returns 404, and compare remote `git rev-parse HEAD` to the full
reviewed PR head SHA. Bind the lease to that SHA and stop/rewarm on head change.
Upload trusted `scripts/crabbox-untrusted-bootstrap.sh` from clean `main`
alongside `--fresh-pr`; it installs pinned Node/pnpm, verifies the SHA and
package-manager pin, isolates `HOME`, installs dependencies, then executes the
requested test.
When an image supplies `/opt/crabbox/toolchain-archives`, the bootstrap copies
the matching Node, pnpm wrapper, and pnpm native archives into private temporary
storage and verifies the copied bytes against digests in the trusted script.
It still extracts fresh Node and Corepack installations on every invocation;
existing executables, adjacent checksums, and completion markers are not trust
anchors. Missing or invalid cached archives use the authenticated download path.
A candidate cannot advance the package-manager pin; update the trusted bootstrap
and its digest anchors when advancing the toolchain.

Trusted Linux hydration uses the shared Node compatibility selector and can
seed a job-private Corepack home from the same authenticated pnpm archives.
These runtime archives do not replace the frozen-lockfile dependency install
or change the dependency-store cache keys.

Unset all `CRABBOX_TAILSCALE*` overrides, force `--network public
--tailscale=false`, clear exit-node/LAN flags, and require `crabbox inspect` to
report public networking with no Tailscale state before uploading any script.
Owned AWS/Hetzner capacity also remains the fallback for Blacksmith outages,
quota issues, or explicit owned-capacity testing.

For an explicitly authorized admin-only PR landing fallback, set
`OPENCLAW_PR_GATES_REMOTE=crabbox-aws` before `scripts/pr prepare-gates`.
The mode does not replace the default hosted aggregate gate. After the exact
prep head is pushed, the wrapper synchronously dispatches the protected-main
publisher. That trusted workflow checksum-installs Crabbox v0.46, resolves its
service principal through `/v1/whoami`, then runs sanitized brokered AWS with
`umask 022`, the canonical untrusted bootstrap, `pnpm build`, `pnpm check`, and
a fail-closed PR-derived test plan. The existing changed-test owner evaluates
every executable changed path independently and must resolve each one to
concrete matched test files; broad fallback, skipped paths, config targets,
deleted executable paths, and partial plans are refused. Explicit docs and
`AGENTS.md`/`CLAUDE.md` instruction surfaces may produce a zero-test plan.
The exact PR base SHA, head SHA, bootstrap hash, and deterministic plan digest
are bound into the broker command. The AWS lease uses a 90-minute idle timeout
and 240-minute TTL. The `pr-crabbox-gate-publisher.yml` workflow accepts an open draft
because proof runs during prepare-push, then rereads the live same-repository
PR and the exact active organization-admin membership object using the repo-native
GitHub App token with `Members(read)` (the repository-scoped workflow token is
not treated as org authority), validates its newly created authenticated broker
run under the same service token, ordered complete events, canonical command
and bootstrap upload hash, and
publishes the distinct `openclaw/crabbox-gate` only for the exact proven
base/head/plan binding. The publisher also proves that the PR base is the merge
base of its immutable protected-main workflow SHA and adds that workflow SHA to
the strict check summary. Before and after the remote run, it proves that a
candidate live `main` is identical to or descended from that workflow SHA, then
rereads the ref and requires the candidate to remain unchanged. A descendant
advance during the long remote run is allowed; movement inside either
comparison-and-reread window fails closed.
Retained broker logs are validated when non-empty but are optional because
released Crabbox v0.46 can report zero retained log bytes after a successful
run. Only after the publisher and exact-head check succeed does the local
wrapper derive `.local/gates.env` provider/run/lease/URL recovery metadata from
the trusted summary; those fields are not publication authority.

The fallback never replaces or republishes `openclaw/ci-gate`. Native merge
verification still rejects draft PRs and permits the server ruleset bypass only
when the Crabbox check is
completed successfully by GitHub Actions on the prepared SHA, its bound workflow
SHA is an ancestor of a stable final live protected-main snapshot, the authenticated
actor is still an active organization admin, and the sole unsatisfied required
check is the normal CI gate with a recognized hosted-runner infrastructure
failure represented by GitHub-owned job metadata with no executed workflow
steps and no assigned `runner_name`. Job logs are never authority because PR
code controls their text. Missing or mismatched checks, cancellation,
action-required or stale conclusions, an assigned runner, any failed or executed
workflow step, unknown runner backends, pending contexts, and additional
required-check failures remain blocking. Only workflow `startup_failure` or an
unacquired zero-step hosted job with `failure`/`timed_out` qualifies. The native
flow repeats the full bypass verification immediately before the admin squash
request and pins the prepared head with `--match-head-commit`. GitHub exposes
no expected-base-OID merge precondition, so the final main read minimizes but
cannot atomically eliminate a base movement race. Landing proof must compare
the squash parent with that final main snapshot, not the older workflow SHA.
The Crabbox merge path stores this comparison in
`.local/merge-crabbox-parent-audit.json`, includes it in the completion comment,
and reports any intervening main movement after the already-completed merge
without claiming atomic prevention.

Agents do not pre-warm for anticipated work. Acquire a Testbox lazily when the
first environment-sensitive command is ready, reuse the returned `tbx_...` id
for later remote commands, sync the current checkout on every run, and stop it
before handoff.

Crabbox-backed Blacksmith runs warm, claim, sync, run, report, and clean up
one-shot Testboxes. Native Blacksmith owns synchronization; Crabbox's direct
SSH sync controls and mass-deletion sanity checks do not run on this delegated
path.

Crabbox also terminates a local Blacksmith CLI invocation that stays in the
sync phase for more than five minutes without post-sync output. Set
`CRABBOX_BLACKSMITH_SYNC_TIMEOUT_MS=0` to disable that guard, or use a larger
millisecond value for unusually large local diffs.

Before a first run, check the wrapper from the repo root:

```bash
node scripts/crabbox-wrapper.mjs run --help | sed -n '1,120p'
```

The repo wrapper validates the selected Crabbox binary and provider before running. In Codex worktrees or linked/sparse checkouts, avoid the local `pnpm crabbox:run` script because pnpm may reconcile dependencies before Crabbox starts; invoke the node wrapper directly instead:

```bash
node scripts/crabbox-wrapper.mjs run --provider blacksmith-testbox --timing-json --shell -- "pnpm test <path-or-filter>"
```

When using the sibling checkout, rebuild the ignored local binary before timing or proof work:

```bash
version="$(git -C ../crabbox describe --tags --always --dirty | sed 's/^v//')" \
  && go build -C ../crabbox -trimpath -ldflags "-s -w -X github.com/openclaw/crabbox/internal/cli.version=${version}" -o bin/crabbox ./cmd/crabbox
```

The `blacksmith:` block in `.crabbox.yaml` already pins the org, workflow, job, and ref defaults, so the explicit flags below are optional. Explicit clean-machine changed-gate parity:

```bash
pnpm crabbox:run -- --provider blacksmith-testbox \
  --blacksmith-org openclaw \
  --blacksmith-workflow .github/workflows/ci-check-testbox.yml \
  --blacksmith-job check \
  --blacksmith-ref main \
  --idle-timeout 90m \
  --ttl 240m \
  --timing-json \
  --shell -- \
  "corepack pnpm check:changed"
```

Focused test rerun when clean-machine behavior is part of the proof:

```bash
pnpm crabbox:run -- --provider blacksmith-testbox \
  --idle-timeout 90m \
  --ttl 240m \
  --timing-json \
  --shell -- \
  "corepack pnpm test <path-or-filter>"
```

Full suite on an explicitly requested clean machine:

```bash
pnpm crabbox:run -- --provider blacksmith-testbox \
  --idle-timeout 90m \
  --ttl 240m \
  --timing-json \
  --shell -- \
  "corepack pnpm test"
```

Read the final JSON summary. The useful fields are `provider`, `leaseId`,
`syncDelegated`, `exitCode`, `commandMs`, and `totalMs`. For delegated
Blacksmith Testbox runs, the Crabbox wrapper exit code and JSON summary are the
command result. The linked GitHub Actions run owns hydration and keepalive; it
can finish as `cancelled` when the Testbox is stopped externally after the SSH
command has already returned. Treat that as a cleanup/status artifact unless
the wrapper `exitCode` is non-zero or the command output shows a failed test.
One-shot Blacksmith-backed Crabbox runs should stop the Testbox automatically;
if a run is interrupted or cleanup is unclear, inspect live boxes and stop only
the boxes you created:

```bash
blacksmith testbox list --all
blacksmith testbox status --id <tbx_id>
blacksmith testbox stop --id <tbx_id>
```

Use reuse only when you intentionally need multiple commands on the same hydrated box:

```bash
node scripts/crabbox-wrapper.mjs run --provider blacksmith-testbox --id <tbx_id> --timing-json --shell -- "corepack pnpm test <path-or-filter>"
pnpm crabbox:stop -- <tbx_id>
```

Reuse the lease, not stale source. Blacksmith Testbox owns sync, including
reused `--id` runs. Do not pass `--no-sync`: the wrapper rejects it before
lease handling or delegation. A fingerprint cache hit is not a no-sync guarantee.

Sync success is not proof of source identity. Verify the materialized Git tree
before exact-candidate proof. Keep QA evidence outside the synced checkout and
download it before another run. Do not bypass security exclusions, accept a
mismatched tree, or silently switch providers.

Untrusted contributor/fork code must use
`CRABBOX_ENV_ALLOW=CI`, `--provider aws --no-hydrate`, and a fresh
temporary remote `HOME` for every command; install dependencies inside that
sanitized command before testing. Reuse only a newly warmed lease dedicated to
the same untrusted source; never a trusted or previously hydrated lease. Never
execute the untrusted checkout's wrapper or config locally: launch the installed
trusted Crabbox binary from clean trusted `main` and pass `--fresh-pr` on every
run. Keep `CRABBOX_AWS_INSTANCE_PROFILE` unset, reject a non-empty resolved
instance profile, require a trusted remote IMDS no-role proof, and verify the
reviewed head SHA before install/test. Bind the lease to that SHA; stop and
rewarm after any head change. If no remote PR exists, use secretless fork CI.
Never select `hydrate-github` or the credential-hydrated Blacksmith workflow
for untrusted source.

If Crabbox is the broken layer but Blacksmith itself works, use direct
Blacksmith only for diagnostics such as `list`, `status`, and cleanup. Fix the
Crabbox path before treating a direct Blacksmith run as maintainer proof.

If `blacksmith testbox list --all` and `blacksmith testbox status` work but new
warmups sit `queued` with no IP or Actions run URL after a couple of minutes,
treat it as Blacksmith provider, queue, billing, or org-limit pressure. Stop the
queued ids you created, avoid starting more Testboxes, and move the proof to the
owned Crabbox capacity path below while someone checks the Blacksmith dashboard,
billing, and org limits.

Escalate to owned Crabbox capacity only when Blacksmith is down, quota-limited, missing the needed environment, or owned capacity is explicitly the goal:

```bash
CRABBOX_CAPACITY_REGIONS=eu-west-1,eu-west-2,eu-central-1,us-east-1,us-west-2 \
  pnpm crabbox:warmup -- --provider aws --class standard --market on-demand --idle-timeout 90m
pnpm crabbox:hydrate -- --provider aws --id <cbx_id-or-slug>
pnpm crabbox:run -- --provider aws --id <cbx_id-or-slug> --timing-json --shell -- "pnpm check:changed"
pnpm crabbox:stop -- --provider aws <cbx_id-or-slug>
```

Under AWS pressure, avoid `class=beast` unless the task really needs 48xlarge-class CPU. A `beast` request starts at 192 vCPUs and is the easiest way to trip regional EC2 Spot or On-Demand Standard quota. The repo-owned `.crabbox.yaml` defaults to `class: standard`, on-demand market, and `capacity.hints: true` so brokered AWS leases print selected region/market, quota pressure, Spot fallback, and high-pressure class warnings. Use `fast` for heavier broad checks, `large` only after standard/fast are not enough, and `beast` only for exceptional CPU-bound lanes such as full-suite or all-plugin Docker matrices, explicit release/blocker validation, or high-core performance profiling. Do not use `beast` for `pnpm check:changed`, focused tests, docs-only work, ordinary lint/typecheck, small E2E repros, or Blacksmith outage triage. Use `--market on-demand` for capacity diagnosis so Spot market churn is not mixed into the signal.

`.crabbox.yaml` owns provider, sync, and GitHub Actions hydration defaults. Crabbox sync never transfers `.git`, so the hydrated Actions checkout keeps its own remote Git metadata instead of syncing maintainer-local remotes and object stores, and the repo config additionally excludes local runtime/build artifacts (such as `.artifacts` and test reports) that should never be transferred. `.github/workflows/crabbox-hydrate.yml` owns checkout, Node/pnpm setup, `origin/main` fetch, and the non-secret environment handoff for owned-cloud `crabbox run --id <cbx_id>` commands.

## Related

- [Install overview](/install)
- [Release channels](/install/development-channels)
