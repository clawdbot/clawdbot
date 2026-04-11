---
title: CI Pipeline
summary: "CI job graph, scope gates, and local command equivalents"
read_when:
  - You need to understand why a CI job did or did not run
  - You are debugging failing GitHub Actions checks
---

# CI Pipeline

The CI runs on every push to `main` and every pull request. It uses smart scoping to skip expensive jobs when only unrelated areas changed.

## Job Overview

| Job                      | Purpose                                                                                 | When it runs                        |
| ------------------------ | --------------------------------------------------------------------------------------- | ----------------------------------- |
| `preflight`              | Detect docs-only changes, changed scopes, changed extensions, and build the CI manifest | Always on non-draft pushes and PRs  |
| `security-fast`          | Private key detection, workflow audit via `zizmor`, production dependency audit         | Always on non-draft pushes and PRs  |
| `build-artifacts`        | Build `dist/` and the Control UI once, upload reusable artifacts for downstream jobs    | Node-relevant changes               |
| `checks-fast-core`       | Fast Linux correctness lanes such as bundled/plugin-contract/protocol checks            | Node-relevant changes               |
| `checks-node-extensions` | Full bundled-plugin test shards across the extension suite                              | Node-relevant changes               |
| `checks-node-core-test`  | Core Node test shards, excluding channel, bundled, contract, and extension lanes        | Node-relevant changes               |
| `extension-fast`         | Focused tests for only the changed bundled plugins                                      | When extension changes are detected |
| `check`                  | Main local gate in CI: `pnpm check` plus `pnpm build:strict-smoke`                      | Node-relevant changes               |
| `check-additional`       | Architecture, boundary, import-cycle guards plus the gateway watch regression harness   | Node-relevant changes               |
| `build-smoke`            | Built-CLI smoke tests and startup-memory smoke                                          | Node-relevant changes               |
| `checks`                 | Remaining Linux Node lanes: channel tests and push-only Node 22 compatibility           | Node-relevant changes               |
| `check-docs`             | Docs formatting, lint, and broken-link checks                                           | Docs changed                        |
| `skills-python`          | Ruff + pytest for Python-backed skills                                                  | Python-skill-relevant changes       |
| `checks-windows`         | Windows-specific test lanes                                                             | Windows-relevant changes            |
| `macos-node`             | macOS TypeScript test lane using the shared built artifacts                             | macOS-relevant changes              |
| `macos-swift`            | Swift lint, build, and tests for the macOS app                                          | macOS-relevant changes              |
| `android`                | Android build and test matrix                                                           | Android-relevant changes            |

## Fail-Fast Order

Jobs are ordered so cheap checks fail before expensive ones run:

1. `preflight` decides which lanes exist at all. The `docs-scope` and `changed-scope` logic are steps inside this job, not standalone jobs.
2. `security-fast`, `check`, `check-additional`, `check-docs`, and `skills-python` fail quickly without waiting on the heavier artifact and platform matrix jobs.
3. `build-artifacts` overlaps with the fast Linux lanes so downstream consumers can start as soon as the shared build is ready.
4. Heavier platform and runtime lanes fan out after that: `checks-fast-core`, `checks-node-extensions`, `checks-node-core-test`, `extension-fast`, `checks`, `checks-windows`, `macos-node`, `macos-swift`, and `android`.

Scope logic lives in `scripts/ci-changed-scope.mjs` and is covered by unit tests in `src/scripts/ci-changed-scope.test.ts`.
The separate `install-smoke` workflow reuses the same scope script through its own `preflight` job. It computes `run_install_smoke` from the narrower changed-smoke signal, so Docker/install smoke only runs for install, packaging, and container-relevant changes.

On pushes, the `checks` matrix adds the push-only `compat-node22` lane. On pull requests, that lane is skipped and the matrix stays focused on the normal test/channel lanes.

## Runners

| Runner                           | Jobs                                                                                                 |
| -------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `blacksmith-16vcpu-ubuntu-2404`  | `preflight`, `security-fast`, `build-artifacts`, Linux checks, docs checks, Python skills, `android` |
| `blacksmith-32vcpu-windows-2025` | `checks-windows`                                                                                     |
| `macos-latest`                   | `macos-node`, `macos-swift`                                                                          |

## Local Equivalents

```bash
pnpm check          # types + lint + format
pnpm build:strict-smoke
pnpm check:import-cycles
pnpm test:gateway:watch-regression
pnpm test           # vitest tests
pnpm test:channels
pnpm check:docs     # docs format + lint + broken links
pnpm build          # build dist when CI artifact/build-smoke lanes matter
```
