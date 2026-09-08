---
summary: "CI job graph, scope gates, release umbrellas, and local command equivalents"
title: "CI pipeline"
read_when:
  - You need to understand why a CI job did or did not run
  - You are debugging a failing GitHub Actions check
  - You are coordinating a release validation run or rerun
  - You are changing ClawSweeper dispatch or GitHub activity forwarding
---

This page is an index. CI is documented on nine pages, one per reader
job. Open the page that matches your task.

For the published-upgrade regression gate, see [selection and routing](/ci/scope-and-routing#scope-and-routing), [runner budgets](/ci/capacity#runner-registration-budget), and [Package Acceptance baselines](/ci/release-validation#suite-profiles). Weekly validation is listed under [Update Migration](/ci/scheduled-workflows#update-migration).

Docs-only `main` pushes skip CI. Every canonical `main` push admitted by the CI workflow selects the published-upgrade regression gate.

| Page                                                           | Read it when                                                                                                        |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| [CI pipeline jobs](/ci/pipeline)                               | The job table, the fail-fast order, and the Control UI size budgets.                                                |
| [Watch a CI run](/ci/watching-runs)                            | Wait on one pull request head, recover a stuck run, and pass the evidence gate.                                     |
| [CI checkout ownership](/ci/checkout)                          | Shared checkout anchors, fetch retry budgets, and trusted action policy.                                            |
| [CI scope and routing](/ci/scope-and-routing)                  | Why a job did or did not run: changed-scope detection and manual dispatch.                                          |
| [CI runner classes](/ci/runners)                               | Trust-based runner routing, Blacksmith classes, and runner backend modes.                                           |
| [CI capacity and shard weights](/ci/capacity)                  | The runner registration budget and the measured timings behind shard packing.                                       |
| [Release validation workflows](/ci/release-validation)         | Full Release Validation, live and E2E shards, Package Acceptance, install smoke, Docker E2E, and Plugin Prerelease. |
| [Scheduled and maintenance workflows](/ci/scheduled-workflows) | OpenClaw Performance, QA Lab, CodeQL, the maintenance jobs, and ClawSweeper activity forwarding.                    |
| [Local checks and Testbox](/ci/local-proof)                    | Reproduce a lane locally, keep the shrink-only ratchets, and run Crabbox or Testbox proof.                          |

## Where each section moved

Every section heading from the previous single-page version keeps its anchor here, so an existing link such as `/ci#pipeline-overview` still resolves. Each entry points at the page that now holds the content.

- <a id="pipeline-overview" />[Pipeline overview](/ci/pipeline#pipeline-overview)
- <a id="fail-fast-order" />[Fail-fast order](/ci/pipeline#fail-fast-order)
- <a id="control-ui-size-budgets" />[Control UI size budgets](/ci/pipeline#control-ui-size-budgets)
- <a id="watching-pull-request-ci" />[Watching pull request CI](/ci/watching-runs#watching-pull-request-ci)
- <a id="recover-an-existing-pr-run-first" />[Recover an existing PR run first](/ci/watching-runs#recover-an-existing-pr-run-first)
- <a id="pr-context-and-evidence" />[PR context and evidence](/ci/watching-runs#pr-context-and-evidence)
- <a id="checkout-ownership" />[Checkout ownership](/ci/checkout#checkout-ownership)
- <a id="scope-and-routing" />[Scope and routing](/ci/scope-and-routing#scope-and-routing)
- <a id="measured-shard-weights" />[Measured shard weights](/ci/capacity#measured-shard-weights)
- <a id="clawsweeper-activity-forwarding" />[ClawSweeper activity forwarding](/ci/scheduled-workflows#clawsweeper-activity-forwarding)
- <a id="manual-dispatches" />[Manual dispatches](/ci/scope-and-routing#manual-dispatches)
- <a id="windows-testbox-probe" />[Windows Testbox Probe](/ci/scope-and-routing#windows-testbox-probe)
- <a id="runners" />[Runners](/ci/runners#runners)
- <a id="blacksmith-runner-capacity" />[Blacksmith runner capacity](/ci/runners#blacksmith-runner-capacity)
- <a id="runner-backend-modes" />[Runner backend modes](/ci/runners#runner-backend-modes)
- <a id="runner-registration-budget" />[Runner registration budget](/ci/capacity#runner-registration-budget)
- <a id="surface-ratchets" />[Surface ratchets](/ci/local-proof#surface-ratchets)
- <a id="local-equivalents" />[Local equivalents](/ci/local-proof#local-equivalents)
- <a id="openclaw-performance" />[OpenClaw Performance](/ci/scheduled-workflows#openclaw-performance)
- <a id="vitest-paired-benchmark" />[Vitest paired benchmark](/ci/scheduled-workflows#vitest-paired-benchmark)
- <a id="full-release-validation" />[Full Release Validation](/ci/release-validation#full-release-validation)
- <a id="live-and-e2e-shards" />[Live and E2E shards](/ci/release-validation#live-and-e2e-shards)
- <a id="package-acceptance" />[Package Acceptance](/ci/release-validation#package-acceptance)
- <a id="jobs" />[Jobs](/ci/release-validation#jobs)
- <a id="candidate-sources" />[Candidate sources](/ci/release-validation#candidate-sources)
- <a id="suite-profiles" />[Suite profiles](/ci/release-validation#suite-profiles)
- <a id="legacy-compatibility-windows" />[Legacy compatibility windows](/ci/release-validation#legacy-compatibility-windows)
- <a id="examples" />[Examples](/ci/release-validation#examples)
- <a id="install-smoke" />[Install smoke](/ci/release-validation#install-smoke)
- <a id="local-docker-e2e" />[Local Docker E2E](/ci/release-validation#local-docker-e2e)
- <a id="tunables" />[Tunables](/ci/release-validation#tunables)
- <a id="reusable-livee2e-workflow" />[Reusable live/E2E workflow](/ci/release-validation#reusable-live/e2e-workflow)
- <a id="release-path-chunks" />[Release-path chunks](/ci/release-validation#release-path-chunks)
- <a id="plugin-prerelease" />[Plugin Prerelease](/ci/release-validation#plugin-prerelease)
- <a id="qa-lab" />[QA Lab](/ci/scheduled-workflows#qa-lab)
- <a id="codeql" />[CodeQL](/ci/scheduled-workflows#codeql)
- <a id="security-categories" />[Security categories](/ci/scheduled-workflows#security-categories)
- <a id="platform-specific-security-shards" />[Platform-specific security shards](/ci/scheduled-workflows#platform-specific-security-shards)
- <a id="critical-quality-categories" />[Critical Quality categories](/ci/scheduled-workflows#critical-quality-categories)
- <a id="maintenance-workflows" />[Maintenance workflows](/ci/scheduled-workflows#maintenance-workflows)
- <a id="dependency-audit" />[Dependency Audit](/ci/scheduled-workflows#dependency-audit)
- <a id="docs-agent" />[Docs Agent](/ci/scheduled-workflows#docs-agent)
- <a id="duplicate-prs-after-merge" />[Duplicate PRs After Merge](/ci/scheduled-workflows#duplicate-prs-after-merge)
- <a id="local-check-gates-and-changed-routing" />[Local check gates and changed routing](/ci/local-proof#local-check-gates-and-changed-routing)
- <a id="config-baseline-count-ratchet" />[Config baseline count ratchet](/ci/local-proof#config-baseline-count-ratchet)
- <a id="testbox-validation" />[Testbox validation](/ci/local-proof#testbox-validation)

## Related

- [Install overview](/install)
- [Release channels](/install/development-channels)
