---
summary: "Performance, QA Lab, CodeQL, maintenance jobs, and ClawSweeper forwarding"
title: "Scheduled and maintenance workflows"
read_when:
  - You are changing ClawSweeper dispatch or GitHub activity forwarding
  - You are triaging a nightly, scheduled, or maintenance workflow
---

## OpenClaw Performance

`OpenClaw Performance` is the product/runtime performance workflow. It runs daily on `main` and can be dispatched manually:

```bash
gh workflow run openclaw-performance.yml --ref main -f profile=diagnostic -f repeat=3
gh workflow run openclaw-performance.yml --ref main -f profile=smoke -f repeat=1 -f deep_profile=true -f live_openai_candidate=true
gh workflow run openclaw-performance.yml --ref main -f target_ref=v2026.5.2 -f profile=diagnostic -f repeat=3
```

Manual dispatch normally benchmarks the workflow ref. Set `target_ref` to benchmark a release tag or another branch with the current workflow implementation. Published report paths and latest pointers are keyed by the tested ref, and each `index.md` records the tested ref/SHA, workflow ref/SHA, Kova ref, profile, lane auth mode, model, repeat count, and scenario filters.

The workflow installs OCM from a pinned release and Kova from `openclaw/Kova` at the pinned `kova_ref` input, then runs three lanes:

- `mock-provider`: Kova diagnostic scenarios against a local-build runtime with deterministic fake OpenAI-compatible auth.
- `mock-deep-profile`: CPU/heap/trace profiling for startup, gateway, and agent-turn hotspots. Runs on schedule, or on dispatch with `deep_profile=true`.
- `live-openai-candidate`: a real OpenAI `openai/gpt-5.6-luna` agent turn. Selected on schedule, or on dispatch with `live_openai_candidate=true`. Candidates ineligible for live credentials are skipped. For a selected, eligible lane, missing `OPENAI_API_KEY` fails the lane rather than skipping it.

OpenClaw-native source probes run in the separate `source_performance` job, in parallel with the Kova lanes after `resolve_target`: gateway boot timing and memory across default, skipped-channel, internal-hook, and fifty-plugin startup cases; bundled plugin import RSS, repeated mock-OpenAI `channel-chat-baseline` hello loops, CLI startup commands against the booted gateway, and the SQLite state smoke performance probe. When the previous published mock-provider source report is available for the tested ref, the source summary compares current RSS and heap values against that baseline and marks large RSS increases as `watch`. The publisher includes these source artifacts in the `mock-provider` report bundle, with the Markdown summary at `source/index.md` and raw JSON beside it.

Every lane uploads its complete GitHub artifact, including CPU, heap, trace, and compressed diagnostic bundles. A separate publisher job downloads and validates those artifacts, then mints a short-lived ClawSweeper GitHub App token scoped only to `openclaw/clawgrit-reports` contents and passes it only to the Git push step. It commits `report.json`, `report.md`, `index.md`, source-probe artifacts, and bundle metadata/checksums under `openclaw-performance/<tested-ref>/<run-id>-<attempt>/<lane>/`; the full diagnostic archive stays in the linked Actions artifact. The publisher rejects any report file over 50 MB before attempting a push. The current tested-ref pointer is `openclaw-performance/<tested-ref>/latest-<lane>.json`. Scheduled runs and `profile=release` dispatches fail if app-token creation or report publication fails. Manual non-release dispatches keep publication advisory and retain the GitHub artifacts when authentication or publishing fails. The previous source baseline is fetched anonymously from the public reports repository, so a successful baseline fetch does not prove publisher authentication.

All explicit Performance workflow Git commands use the pinned Git lifecycle owner,
prepared in `RUNNER_TEMP` before each job's selected checkout. Target resolution,
Kova revision/install Git, source revision and baseline Git, and local publisher
operations remain unbounded. Only the initial reports fetch, each push, and each
reconciliation fetch have a 120-second deadline. The owner drains the entire Git
process tree before reads, checkout reuse, artifact consumers, outputs, or retry;
exclusive reports fetches reclaim only invocation-created locks after extinction.

Report preparation and all fetches are anonymous. The App token is created only
after a new report is prepared, removed from the environment immediately, and
passed as a masked Basic header to push commands alone; it never enters the remote
URL or repository config. A verified existing report succeeds before token creation.
Only a successful empty `ls-tree` lookup means a baseline or report is absent;
repository/read failures are terminal. Malformed baseline pointer JSON remains
advisory, as does an ordinary baseline fetch failure after verified cleanup.

Publication allows exactly five pushes. Every failed push, including the fifth,
gets a 2/4/6/8/10-second backoff followed by one anonymous reconciliation fetch.
A fetched remote report proves success even after the fifth ambiguous push; direct
push success needs no fetch. Otherwise, attempts 1–4 replay the report commit on
detached `FETCH_HEAD` with `cherry-pick -X theirs`, preserving concurrent unique
reports while the current writer wins the latest pointer. There is no fifth-attempt
replay. Ordinary fetch failures warn and retry on attempts 1–4. Only typed Git
failure or timeout after verified cleanup permits recovery; owner setup, census,
cleanup failure, and cancellation stop before fallback, retry, replay, or success.
Full Release Validation continues to disable the publisher entirely and retains
performance evidence only as workflow artifacts.

### Vitest paired benchmark

The manual-only `vitest-pair` mode compares two exact commits with the workflow
implementation from the candidate commit:

```bash
gh workflow run openclaw-performance.yml \
  --ref <candidate-branch> \
  -f mode=vitest-pair \
  -f baseline_ref=<40-character-baseline-sha> \
  -f target_ref=<40-character-candidate-sha>
```

Both inputs must be lowercase full SHAs, `target_ref` must equal the workflow
SHA selected by `--ref`, and reruns are refused. Dispatch a fresh workflow run
instead of retrying an attempt. Kova, source probes, report publication, and
their artifact-only guard stay skipped in this mode. The benchmark job has
read-only repository permission, does not receive secrets, does not restore or
save Actions caches, and checks out the helper, candidate, and baseline with
credentials disabled.

The committed lane manifest covers representative core unit, Gateway, Control
UI jsdom, and worker-lifecycle tests. Both commits must expose identical
selected test/config paths and bytes and pass correctness before timing state
is created. Correctness also requires both sides to report the same normalized
test files, test identities, statuses, and counts. Every later run must match
that established execution digest. The harness then runs one excluded warmup
per side and lane, seven paired rounds with alternating side order and rotated
lane order, plus one separately labeled cold pair with fresh caches. Frozen
installs are setup and are never timed.

Each child has a fixed deadline and process-group owner. A separate 165-minute
harness deadline reserves 15 minutes inside the 180-minute job timeout for
cleanup, terminal-manifest finalization, and artifact upload. It aborts and joins
the active managed child before refusing further child starts. Every install,
correctness, warmup, measured, and cold process receives the exact pinned pnpm
executable through `npm_execpath`, with private Corepack and pnpm state; the
resolved executable and version are recorded in the environment and run
records.

The artifact includes raw logs, raw Vitest JSON reports, execution digests and
counts, GNU time user/system CPU, wall timing, environment and Git identities,
source/config hashes, per-run records, paired-ratio analysis, and a terminal
success or failure manifest. The workflow attempts finalization and artifact
upload after harness failures. Runner loss or external workflow cancellation
can still prevent those steps from running. Mutable pnpm and runtime caches stay
in an unuploaded scratch tree. Thresholds are fixed in
`scripts/vitest-pair-benchmark-lanes.json`. Acceptance uses the median of seven
per-round aggregate ratios, with each round weighted by total lane duration, and
fails above 5%. A critical lane fails only when its median measured ratio is
above 10% and its median paired delta is at least one second. The single cold
pair remains diagnostic evidence and never fails acceptance. The report claims
an improvement only when every representative lane's median clears the
improvement ratio and at least five of its seven pairs individually meet that
ratio. Otherwise it reports per-lane evidence without a broad improvement
claim. Artifacts use only the trusted workflow run ID and attempt in their name;
the exact baseline and candidate commits remain recorded inside the artifact.

## QA Lab

QA Lab has dedicated CI lanes outside the main smart-scoped workflow. Agentic parity is nested under the broad QA and release harnesses, not a standalone PR workflow. Use `Full Release Validation` with `rerun_group=qa-parity` when parity should ride with a broad validation run.

- The `QA-Lab - All Lanes` workflow runs nightly on `main` and on manual dispatch; it fans out mock parity plus live Matrix, Telegram, Discord, WhatsApp, and Slack jobs. Live jobs use the `qa-live-shared` environment; Telegram, Discord, WhatsApp, and Slack use Convex leases, while Matrix provisions disposable local credentials.
- Manual and scheduled aggregate runs retain the default `all` concurrency scope. Trusted release calls use separate `matrix` and `buzz` scopes so those lanes can run together for one target SHA; Matrix calls for the same SHA still serialize, while Buzz calls serialize across SHAs because they share pooled credentials.
- Release Matrix catalog validation runs on a 16-vCPU Blacksmith runner with a 90-minute job budget. Changes to that timeout, runner size, or concurrency require a matching workflow guard and exact-candidate release proof.
- `QA Profile Evidence` balances taxonomy category groups across eight isolated jobs, keeps non-isolating live channels on one shard, then asks QA Lab to merge their validated evidence into one attested `qa-evidence.json`. A timed-out or missing shard always fails aggregation; `allow_failures` applies only when every shard completed and produced valid evidence. Direct `Maturity scorecard` dispatches default `allow_failures` on so routine docs refreshes can publish accurate incomplete coverage, while reusable release calls remain strict by default.

Scheduled, manual, and release Matrix checks use the deterministic mock provider so the live transport contract is isolated from model latency and normal provider-plugin startup. Telegram release checks use the same deterministic model boundary. The live transport gateway disables memory search because QA parity covers memory behavior separately; provider connectivity is covered by the separate live model, native provider, and Docker provider suites.

`OpenClaw Release Checks` also runs the release-critical QA Lab lanes before release approval; its QA parity gate runs the candidate and baseline packs as parallel lane jobs, then downloads both artifacts into a small report job for the final parity comparison.

For normal PRs, follow scoped CI/check evidence instead of treating parity as a required status.

## CodeQL

The `CodeQL` workflow is intentionally a narrow first-pass security scanner, not the full repository sweep. Daily, manual, `main` push, and non-draft pull request guard runs scan Actions workflow code plus the highest-risk JavaScript/TypeScript surfaces with high-confidence security queries filtered to high/critical `security-severity`.

The pull request guard stays light: it only starts for changes under `.github/actions`, `.github/codeql`, `.github/workflows`, `packages`, `scripts`, `src`, or process-owning bundled plugin runtime paths, and it runs the same high-confidence security matrix as the scheduled workflow. Android and macOS CodeQL stay out of PR defaults.

### Security categories

| Category                                          | Surface                                                                                                                             |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `/codeql-security-high/core-auth-secrets`         | Auth, secrets, sandbox, cron, and gateway baseline                                                                                  |
| `/codeql-security-high/channel-runtime-boundary`  | Core channel implementation contracts plus the channel plugin runtime, gateway, Plugin SDK, secrets, audit touchpoints              |
| `/codeql-security-high/network-ssrf-boundary`     | Core SSRF, IP parsing, network guard, web-fetch, and Plugin SDK SSRF policy surfaces                                                |
| `/codeql-security-high/mcp-process-tool-boundary` | MCP servers, process execution helpers, outbound delivery, and agent tool-execution gates                                           |
| `/codeql-security-high/process-exec-boundary`     | Local shell, process spawn helpers, subprocess-owning bundled plugin runtimes, and workflow script glue                             |
| `/codeql-security-high/plugin-trust-boundary`     | Plugin install, loader, manifest, registry, package-manager install, source-loading, and Plugin SDK package contract trust surfaces |

### Platform-specific security shards

- `CodeQL Android Critical Security` — scheduled Android security shard. Builds the Android app manually for CodeQL on the smallest Blacksmith Linux runner accepted by workflow sanity. Uploads under `/codeql-critical-security/android`.
- `CodeQL macOS Critical Security` — weekly/manual macOS security shard. Builds the macOS app manually for CodeQL on GitHub-hosted macOS, filters dependency build results out of uploaded SARIF, and uploads under `/codeql-critical-security/macos`. Kept outside daily defaults because macOS build dominates runtime even when clean.

### Critical Quality categories

`CodeQL Critical Quality` is the matching non-security shard. It runs only error-severity, non-security JavaScript/TypeScript quality queries over narrow high-value surfaces on GitHub-hosted Linux runners so quality scans do not spend Blacksmith runner-registration budget. Its pull request guard is intentionally smaller than the scheduled profile: non-draft PRs run only the matching shards for the surfaces they touch, from thirteen PR-routable shards — `agent-runtime-boundary`, `channel-runtime-boundary`, `config-boundary`, `core-auth-secrets`, `gateway-runtime-boundary`, `mcp-process-runtime-boundary`, `memory-runtime-boundary`, `network-runtime-boundary`, `plugin-boundary`, `plugin-sdk-package-contract`, `plugin-sdk-reply-runtime`, `provider-runtime-boundary`, and `session-diagnostics-boundary`. `ui-control-plane` and `web-media-runtime-boundary` stay out of PR runs. CodeQL config and quality workflow changes run the full PR shard set (the network runtime shard keys off its own CodeQL config files and network-owning source paths).

Manual dispatch accepts:

```text
profile=all|agent-runtime-boundary|config-boundary|core-auth-secrets|channel-runtime-boundary|gateway-runtime-boundary|memory-runtime-boundary|mcp-process-runtime-boundary|network-runtime-boundary|plugin-boundary|plugin-sdk-package-contract|plugin-sdk-reply-runtime|provider-runtime-boundary|session-diagnostics-boundary
```

The narrow profiles are teaching/iteration hooks for running one quality shard in isolation.

On pull requests, the network runtime shard starts with a fast diff scan. Sensitive
socket imports/calls and proxy-policy tokens, edits to its queries/config/fixtures, and
changes to the Codex transport select full CodeQL analysis in the same PR job.
Absent or null patches for monitored non-test sources also select full analysis;
metadata fetch or parse failures stop shard selection rather than silently skipping it.
Known ordinary diffs keep the fast path. The full path runs semantic query tests before
analysis, including coverage of the configured `packages/net-policy/src` directory
and preservation of exact owner/function allowances and test-path exclusions.
Full analysis fails the job on any SARIF finding or missing SARIF output; a
sensitive diff is a routing signal, not a finding.

| Category                                                | Surface                                                                                                                                                           |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/codeql-critical-quality/core-auth-secrets`            | Auth, secrets, sandbox, cron, and gateway security boundary code                                                                                                  |
| `/codeql-critical-quality/config-boundary`              | Config schema, migration, normalization, and IO contracts                                                                                                         |
| `/codeql-critical-quality/gateway-runtime-boundary`     | Gateway protocol schemas and server method contracts                                                                                                              |
| `/codeql-critical-quality/channel-runtime-boundary`     | Core channel and bundled channel plugin implementation contracts                                                                                                  |
| `/codeql-critical-quality/agent-runtime-boundary`       | Command execution, model/provider dispatch, auto-reply dispatch and queues, and ACP control-plane runtime contracts                                               |
| `/codeql-critical-quality/mcp-process-runtime-boundary` | MCP servers and tool bridges, process supervision helpers, and outbound delivery contracts                                                                        |
| `/codeql-critical-quality/memory-runtime-boundary`      | Memory host SDK, memory runtime facades, memory Plugin SDK aliases, memory runtime activation glue, and memory doctor commands                                    |
| `/codeql-critical-quality/network-runtime-boundary`     | Network policy package, raw socket and proxy-capture runtime, SSH tunnel, gateway lock, JSONL socket, and push transport surfaces                                 |
| `/codeql-critical-quality/session-diagnostics-boundary` | Reply queue internals, session delivery queues, outbound session binding/delivery helpers, diagnostic event/log bundle surfaces, and session doctor CLI contracts |
| `/codeql-critical-quality/plugin-sdk-reply-runtime`     | Plugin SDK inbound reply dispatch, reply payload/chunking/runtime helpers, channel reply options, delivery queues, and session/thread binding helpers             |
| `/codeql-critical-quality/provider-runtime-boundary`    | Model catalog normalization, provider auth and discovery, provider runtime registration, provider defaults/catalogs, and web/search/fetch/embedding registries    |
| `/codeql-critical-quality/ui-control-plane`             | Control UI bootstrap, local persistence, gateway control flows, and task control-plane runtime contracts                                                          |
| `/codeql-critical-quality/web-media-runtime-boundary`   | Core web fetch/search, media IO, media understanding, image-generation, and media-generation runtime contracts                                                    |
| `/codeql-critical-quality/plugin-boundary`              | Loader, registry, public-surface, and Plugin SDK entrypoint contracts                                                                                             |
| `/codeql-critical-quality/plugin-sdk-package-contract`  | Published package-side Plugin SDK source and plugin package contract helpers                                                                                      |

Quality stays separate from security so quality findings can be scheduled, measured, disabled, or expanded without obscuring security signal. Swift, Python, and bundled-plugin CodeQL expansion should be added back as scoped or sharded follow-up work only after the narrow profiles have stable runtime and signal.

## Maintenance workflows

### Dependency Audit

`Dependency Audit` runs the production lockfile audit daily at 07:23 UTC and on
manual dispatch. It stays separate from PR CI and fails on findings, unavailable
advisories, or invalid data. Each dependency graph is submitted as one request;
release checks keep their product and tooling graphs separate.

Both ordinary CI and this strict audit publish the outcome, package count,
duration, timestamp, and bounded failure reason in the job summary. A completed
npm check covers npm bulk advisories only, not every upstream advisory source.

The triage owner is **@steipete**. Investigate failed scheduled runs and rerun
the strict workflow to confirm recovery:

```bash
gh workflow run dependency-audit.yml --repo openclaw/openclaw --ref main
```

GitHub sends scheduled-run notifications to the workflow creator or the latest
cron editor, subject to that account's Actions notification settings. Keep those
notifications enabled when taking ownership; a summary mention does not send an
alert. See [GitHub's workflow notification rules](https://docs.github.com/en/actions/concepts/workflows-and-actions/notifications-for-workflow-runs).

For local reproduction, run
`node scripts/pre-commit/pnpm-audit-prod.mjs --audit-level=high`. Adding `--ci`
selects a shorter 30-second diagnostic budget but preserves exit codes: 0 means
no matching findings, 1 means findings or an error, and 2 means incomplete coverage.
Ordinary CI, scheduled audits, and local hooks propagate every non-zero exit.

### Docs Agent

The `Docs Agent` workflow is an event-driven Codex maintenance lane for keeping existing docs aligned with recently landed changes. It has no pure schedule: a successful non-bot push CI run on `main` can trigger it, and manual dispatch can run it directly. Workflow-run invocations skip when `main` has moved on or when another eligible Docs Agent workflow-run invocation was created in the last hour. Canceled and skipped workflow conclusions are excluded from both hourly cadence and review-base selection; active runs with no conclusion still count. When admitted, the agent reviews the commit range from the previous eligible invocation's source SHA to current `main`.

History eligibility tracks workflow attempts, not completed docs reviews: a gate-rejected attempt that finishes successfully remains eligible history.

### Duplicate PRs After Merge

The `Duplicate PRs After Merge` workflow is a manual maintainer workflow for post-land duplicate cleanup. It defaults to dry-run and only closes explicitly listed PRs when `apply=true`. Before mutating GitHub, it verifies that the landed PR is merged and that each duplicate has either a shared referenced issue or overlapping changed hunks.

```bash
gh workflow run duplicate-after-merge.yml \
  -f landed_pr=70532 \
  -f duplicate_prs='70530,70592' \
  -f apply=true
```

### Update Migration

`Update Migration` runs the expanded published-upgrade baseline set weekly on
Sunday at 03:17 UTC and on manual dispatch. It keeps both `plugin-deps-cleanup`
and `legacy-operator-state`, with no provider secrets. Its separate
non-canceling schedule group coalesces pending runs and cannot cancel manual
validation. See [Package Acceptance suite profiles](/ci/release-validation#suite-profiles)
for runtime baseline resolution, per-baseline grouping, the 78–90
runner-minute weekly planning allowance, and the successful-upgrade requirements.
[Runner registration budgets](/ci/capacity#runner-registration-budget) account
for the weekly burst separately from PR and main admission.

## ClawSweeper activity forwarding

`.github/workflows/clawsweeper-dispatch.yml` is the target-side bridge from OpenClaw repository activity into ClawSweeper. It does not check out or execute untrusted pull request code. The workflow creates a GitHub App token from `CLAWSWEEPER_APP_PRIVATE_KEY`, then dispatches compact `repository_dispatch` payloads to `openclaw/clawsweeper`.

The workflow has three lanes:

- `clawsweeper_item` for exact issue and pull request review requests;
- `clawsweeper_comment` for explicit ClawSweeper commands in issue comments;
- `github_activity` for general GitHub activity that the ClawSweeper agent may inspect.

The `github_activity` lane forwards normalized metadata only: event type, action, actor, repository, item number, URL, title, state, and short excerpts for comments or reviews when present. It intentionally avoids forwarding the full webhook body. The receiving workflow in `openclaw/clawsweeper` is `.github/workflows/github-activity.yml`, which posts the normalized event to the OpenClaw Gateway hook for the ClawSweeper agent.

Main pushes remain `github_activity` observations. They do not produce hosted per-commit reports or commit Check Runs.

General activity is observation, not delivery-by-default. The ClawSweeper agent receives the Discord target in its prompt and should post to `#clawsweeper` only when the event is surprising, actionable, risky, or operationally useful. Routine opens, edits, bot churn, duplicate webhook noise, and normal review traffic should result in `NO_REPLY`.

Treat GitHub titles, comments, bodies, review text, branch names, and commit messages as untrusted data throughout this path. They are input for summarization and triage, not instructions for the workflow or agent runtime.

Barnacle treats bug-labeled issues as verification candidates rather than inactivity-close candidates. It may add the `stale` label, which dispatches one exact ClawSweeper review, but it cannot close that issue. ClawSweeper may then apply an evidence-backed resolution; a proven fix on current `main` closes as completed, while current or inconclusive bugs stay open. The stale workflow also audits recent close events and fails when a Barnacle identity closes a bug as `not_planned`.

## Related

- [Install overview](/install)
- [Release channels](/install/development-channels)
