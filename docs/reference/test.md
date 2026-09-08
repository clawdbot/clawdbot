---
summary: "Index of the OpenClaw testing reference, one page per reader job"
read_when:
  - Running or fixing tests
title: "Tests"
---

- Full testing kit (suites, live, Docker): [Testing](/help/testing)
- Update and plugin package validation: [Testing updates and plugins](/help/testing-updates-plugins)

This page is an index. The testing reference is documented on six pages, one
per reader job. Open the page that matches your task.

| Page                                                           | Read it when                                                                       |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| [Run tests locally](/reference/test/local)                     | The routine local order, the core command table, and the local PR gate.            |
| [Control UI, TUI, and E2E lanes](/reference/test/lanes)        | Control UI, TUI, extension, Gateway, and live lane commands and fixture rules.     |
| [Docker test suites](/reference/test/docker)                   | The weighted Docker scheduler, its knobs, and the notable Docker lanes.            |
| [Test performance and benchmarks](/reference/test/performance) | Import profiling, CPU and heap profiles, shard timings, and the benchmark scripts. |
| [Test runner internals](/reference/test/runner-internals)      | Shared build locks, isolated test state and homes, and JSON report merging.        |
| [Remote test proof](/reference/test/remote-proof)              | When agents use Crabbox or Testbox, and the wrapper, lease, and trust rules.       |

## Where each section moved

Every section heading from the previous single-page version keeps its anchor
here, so an existing link such as `/reference/test#core-commands` still
resolves. Each entry points at the page that now holds the content.

- <a id="agent-default" />[Agent default](/reference/test/remote-proof#agent-default)
- <a id="crabbox-repository-setup" />[Crabbox repository setup](/reference/test/remote-proof#crabbox-repository-setup)
- <a id="routine-local-order" />[Routine local order](/reference/test/local#routine-local-order)
- <a id="core-commands" />[Core commands](/reference/test/local#core-commands)
- <a id="source-tests-and-subprocess-builds" />[Source tests and subprocess builds](/reference/test/local#source-tests-and-subprocess-builds)
- <a id="shared-test-state-and-process-helpers" />[Shared test state and process helpers](/reference/test/runner-internals#shared-test-state-and-process-helpers)
- <a id="control-ui%2C-tui%2C-and-extension-lanes" /><a id="control-ui-tui-and-extension-lanes" />[Control UI, TUI, and extension lanes](/reference/test/lanes#control-ui-tui-and-extension-lanes)
- <a id="real-gateway-control-ui-fixture-lifetimes" />[Real-Gateway Control UI fixture lifetimes](/reference/test/lanes#real-gateway-control-ui-fixture-lifetimes)
- <a id="retained-mocked-control-ui-proof" /><a id="retained-control-ui-proof" />[Retained Control UI proof](/reference/test/lanes#retained-control-ui-proof)
- <a id="screenshots-during-chromium-recordings" />[Screenshots during Chromium recordings](/reference/test/lanes#screenshots-during-chromium-recordings)
- <a id="gateway-and-e2e" />[Gateway and E2E](/reference/test/lanes#gateway-and-e2e)
- <a id="full-docker-suite-(pnpm-test%3Adocker%3Aall)" /><a id="full-docker-suite-pnpm-testdockerall" />[Full Docker suite](/reference/test/docker#full-docker-suite-pnpm-testdockerall)
- <a id="notable-docker-lanes" />[Notable Docker lanes](/reference/test/docker#notable-docker-lanes)
- <a id="sandbox-compatibility-lanes" />[Sandbox compatibility lanes](/reference/test/docker#sandbox-compatibility-lanes)
- <a id="local-pr-gate" />[Local PR gate](/reference/test/local#local-pr-gate)
- <a id="json-reports-across-native-processes" />[JSON reports across native processes](/reference/test/runner-internals#json-reports-across-native-processes)
- <a id="test-performance-tooling" />[Test performance tooling](/reference/test/performance#test-performance-tooling)
- <a id="benchmarks" />[Benchmarks](/reference/test/performance#benchmarks)
- <a id="model-latency-scripts-bench-model-ts" />[Model latency benchmark](/reference/test/performance#model-latency-scripts-bench-model-ts)
- <a id="cli-startup-scripts-bench-cli-startup-ts" />[CLI startup benchmark](/reference/test/performance#cli-startup-scripts-bench-cli-startup-ts)
- <a id="gateway-startup-scripts-bench-gateway-startup-ts" />[Gateway startup benchmark](/reference/test/performance#gateway-startup-scripts-bench-gateway-startup-ts)
- <a id="gateway-restart-scripts-bench-gateway-restart-ts" />[Gateway restart benchmark](/reference/test/performance#gateway-restart-scripts-bench-gateway-restart-ts)
- <a id="onboarding-e2e-(docker)" /><a id="onboarding-e2e-docker" />[Onboarding E2E (Docker)](/reference/test/docker#onboarding-e2e-docker)
- <a id="qr-import-smoke-(docker)" /><a id="qr-import-smoke-docker" />[QR import smoke (Docker)](/reference/test/docker#qr-import-smoke-docker)

## Related

- [Testing](/help/testing)
- [Testing live](/help/testing-live)
- [Testing updates and plugins](/help/testing-updates-plugins)
