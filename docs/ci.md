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

| Page | Read it when |
| --- | --- |
| [CI pipeline jobs](/ci/pipeline) | The job table, the fail-fast order, and the Control UI size budgets. |
| [Watch a CI run](/ci/watching-runs) | Wait on one pull request head, recover a stuck run, and pass the evidence gate. |
| [CI checkout ownership](/ci/checkout) | Shared checkout anchors, fetch retry budgets, and trusted action policy. |
| [CI scope and routing](/ci/scope-and-routing) | Why a job did or did not run: changed-scope detection and manual dispatch. |
| [CI runner classes](/ci/runners) | Trust-based runner routing, Blacksmith classes, and runner backend modes. |
| [CI capacity and shard weights](/ci/capacity) | The runner registration budget and the measured timings behind shard packing. |
| [Release validation workflows](/ci/release-validation) | Full Release Validation, live and E2E shards, Package Acceptance, install smoke, Docker E2E, and Plugin Prerelease. |
| [Scheduled and maintenance workflows](/ci/scheduled-workflows) | OpenClaw Performance, QA Lab, CodeQL, the maintenance jobs, and ClawSweeper activity forwarding. |
| [Local checks and Testbox](/ci/local-proof) | Reproduce a lane locally, keep the shrink-only ratchets, and run Crabbox or Testbox proof. |

## Related

- [Install overview](/install)
- [Development channels](/install/development-channels)
