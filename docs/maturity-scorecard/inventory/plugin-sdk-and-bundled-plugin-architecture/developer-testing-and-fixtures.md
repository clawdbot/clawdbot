---
title: Plugins - Testing Plugins Maturity Note
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Plugins - Testing Plugins Maturity Note

## Summary

This category is strong for in-repo bundled plugin authors. OpenClaw documents
focused testing helper subpaths, keeps the helper source organized by testing
role, and runs real plugin lifecycle, install, update, uninstall, and live
plugin flows on top of shared fixture infrastructure. Coverage is therefore
Stable: the repo has real runtime-flow proof that the fixture and developer-test
tooling supports the plugin architecture it is meant to exercise.

The main maturity limit is contract clarity at the package boundary. The docs
say these helpers are repo-local and not third-party package exports, the root
`openclaw` package excludes the helper dist files, but the private
`@openclaw/plugin-sdk` workspace package still exports the deprecated
`./testing` barrel. That mixed story, plus the open whole-surface SDK sprawl
issue, keeps Quality at low-Stable rather than Lovable.

## Category Scope

This category covers developer-facing testing utilities, fixture builders,
scoped test configuration, and runtime-flow proof for plugin test and fixture
workflows within the Plugins surface. It
includes `docs/plugins/sdk-testing.md`, `docs/plugins/sdk-subpaths.md`,
`src/plugin-sdk/test-fixtures.ts`, `src/plugin-sdk/test-env.ts`,
`src/plugin-sdk/plugin-test-runtime.ts`,
`src/plugin-sdk/channel-test-helpers.ts`, the deprecated
`src/plugin-sdk/testing.ts` compatibility barrel, the private
`packages/plugin-sdk/src/testing.ts` workspace export, fixture helpers under
`test/helpers`, scoped Vitest config under `test/vitest`, and plugin lifecycle
and fixture-driven Docker E2E flows under `scripts/e2e`.

It excludes scoring the business behavior of individual bundled plugins except
where those plugins are used as fixture subjects for install, lifecycle, or
runtime smoke flows. It also excludes third-party public-package support for the
focused helper subpaths because `docs/plugins/sdk-testing.md` explicitly marks
them as repo-local source entrypoints and the root `openclaw` package excludes
their dist artifacts.

## Features

- Test fixtures: Fixtures provide reusable plugin metadata and runtime test inputs.
- Local test environment: Plugin authors can set up the local test environment and scoped helper configuration for plugin testing.
- Plugin runtime harness: Plugin test harnesses cover authoring and runtime integration paths.
- Unit and integration scaffolds: Scoped test helpers and configuration support unit and integration testing for plugin surfaces.
- Docker lifecycle suites: Docker-based end-to-end scripts validate packaged plugin lifecycle flows.
- Smoke tests: Local and packaged smoke tests catch broken installs before release.

## Archive Freshness

- gitcrawl: shared plugin-surface archive snapshot from `gitcrawl doctor --json`
  succeeded with `last_sync_at` `2026-05-28T19:09:52.784704Z`,
  `thread_count` `29810`, `open_thread_count` `11181`, and `db_path`
  `/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`.
- discrawl: shared plugin-surface archive snapshot from `discrawl status --json`
  succeeded with `generated_at` `2026-05-30T00:38:20Z`, `state` `current`,
  `summary` `1487536 messages across 25831 channels`, and `last_sync_at`
  `2026-05-29T19:27:40Z`.

## Coverage Score

- Score: `Stable (84%)`
- Positive signals:
  - `scripts/e2e/plugins-docker.sh` and `scripts/e2e/lib/plugins/sweep.sh` run
    real plugin install, inspect, update, and uninstall flows across tgz,
    local-directory, `file:`, npm-registry, git, marketplace, and ClawHub
    fixture cases.
  - `scripts/e2e/lib/plugins/fixtures.sh` centralizes fixture plugin creation,
    tarball packing, temporary registry setup, trust recording, and cleanup, so
    the major plugin lifecycle E2Es share one maintained fixture substrate.
  - `scripts/e2e/bundled-plugin-install-uninstall-docker.sh` and
    `scripts/e2e/lib/bundled-plugin-install-uninstall/sweep.sh` install bundled
    plugins, optionally run runtime smoke checks, uninstall them, and assert
    removal.
  - `scripts/e2e/plugin-lifecycle-matrix-docker.sh` and
    `scripts/e2e/lib/plugin-lifecycle-matrix/sweep.sh` cover install, inspect,
    disable, enable, upgrade, downgrade, and missing-code uninstall phases with
    packaged OpenClaw entrypoints.
  - `scripts/e2e/codex-npm-plugin-live-docker.sh` runs a packaged OpenClaw +
    Codex plugin live flow that installs and enables the plugin, verifies
    plugin state, performs an agent turn, and validates uninstall behavior.
- Negative signals:
  - The strongest runtime proof is whole-plugin lifecycle and fixture-driven E2E
    behavior, not dedicated package-boundary proof for each focused testing
    helper family.
  - `docs/plugins/sdk-testing.md` explicitly says the focused testing helper
    subpaths are repo-local source entrypoints for bundled plugin tests rather
    than third-party package exports, so this category does not yet show broad
    external-consumer proof.
  - The root `openclaw` package excludes `dist/plugin-sdk/test-env.js`,
    `dist/plugin-sdk/test-fixtures.js`, `dist/plugin-sdk/plugin-test-runtime.js`,
    `dist/plugin-sdk/channel-test-helpers.js`, and `dist/plugin-sdk/testing.js`,
    which means the category's coverage is intentionally concentrated on in-repo
    developer flows.
- Integration gaps:
  - Add a recurring smoke that exercises representative focused helper families
    through the intended repo-local entrypoints so helper-table drift is caught
    by runtime proof, not only by unit tests and large plugin E2Es.
  - Add generated validation or example smoke for
    `docs/plugins/sdk-testing.md` so documented helper imports and example
    snippets cannot silently drift from source.
  - Decide whether the deprecated private `@openclaw/plugin-sdk/testing` export
    should keep existing as a supported compatibility seam or be fully fenced
    away from new developer-test usage.

Coverage labels:

- `Lovable`: 95-100
- `Stable`: 80-95
- `Beta`: 70-80
- `Alpha`: 50-70
- `Experimental`: 0-50

At shared boundaries, choose the higher maturity label.

Coverage measures integration, e2e, live, or real runtime-flow evidence across
the category. Unit tests can provide supporting context but never make a feature covered by
themselves.

## Quality Score

- Score: `Stable (81%)`
- Gitcrawl reports:
  - Query `gitcrawl search openclaw/openclaw --query "plugin sdk testing harness fixture" --json`
    returned 4 keyword hits. The relevant category signal was open issue
    `#80219`, `[plugin sdk] Consolidate author surface, lifecycle semantics, and
export sprawl`, whose body explicitly counts `23` test-ish and contract or
    mock families and recommends freezing or de-emphasizing wide compatibility
    surfaces such as `testing`.
  - Query `gitcrawl search openclaw/openclaw --query "plugin sdk e2e docker fixture" --json`
    returned 1 keyword hit: open PR `#87141`,
    `fix(plugin): harden schema and metadata fuzz boundaries`. That is a
    hardening signal for plugin-SDK-adjacent test and fixture behavior, not
    evidence of broad developer-testing instability.
  - Query `gitcrawl threads openclaw/openclaw --numbers 80219,87141 --include-closed --json`
    confirmed `#80219` is still open as a whole-surface architecture debt item
    and `#87141` is an active hardening change with added plugin-SDK-adjacent
    test coverage.
- Discrawl reports:
  - Query `discrawl --json search "plugin sdk testing harness fixture" --limit 5`
    returned `null`.
  - Query `discrawl --json search "plugin sdk testing" --limit 5` returned 5
    broad hits. The only mildly relevant result was a 2026-05-16 maintainer
    status message mentioning RTT test work plus ongoing plugin SDK, upgrade,
    and npm issues or PRs; it did not describe a direct defect in the helper or
    fixture surface. I therefore treat current Discrawl evidence as neutral.
- Good qualities:
  - `docs/plugins/sdk-testing.md` is explicit about intended use: focused helper
    imports for new bundled-plugin tests, repo-local-only status for those
    helpers, and deprecation of the broad `plugin-sdk/testing` barrel.
  - The helper source is organized by role rather than as one opaque utility
    bag: `test-fixtures`, `test-env`, `plugin-test-runtime`, and
    `channel-test-helpers` each have clear responsibilities.
  - `test/vitest/vitest.plugin-sdk.config.ts` and
    `test/vitest/vitest.plugin-sdk-light.config.ts` give the category explicit
    scoped lanes for full and light Plugin SDK test work.
  - The root package inventory and exclusion rules make the repo-local contract
    explicit by excluding test-helper dist files from the main `openclaw`
    package inventory.
- Bad qualities:
  - `src/plugin-sdk/testing.ts` remains a very broad deprecated compatibility
    barrel that re-exports many unrelated helpers, runtime seams, and internal
    test utilities.
  - The private workspace package `@openclaw/plugin-sdk` still exports
    `./testing`, and `packages/plugin-sdk/src/testing.ts` simply re-exports the
    broad compatibility barrel. That keeps accidental dependency risk alive even
    though the docs steer new code away from it.
  - The root `openclaw` package and the private workspace package tell different
    stories about testing-helper availability, which makes package-boundary
    expectations harder to reason about.
  - The open whole-surface architecture issue `#80219` reinforces that this
    category still sits inside a larger SDK sprawl and compatibility-debt
    cleanup effort.
- Excluded from quality:
  - I did not raise or lower Quality because of unit, integration, e2e, live,
    or runtime-flow test coverage.
  - The blocked surface validation commands below are treated as a local
    environment blocker, not as category-quality evidence.

Quality labels:

- `Lovable`: 95-100
- `Stable`: 80-95
- `Beta`: 70-80
- `Alpha`: 50-70
- `Experimental`: 0-50

At shared boundaries, choose the higher maturity label.

Quality must not use unit, integration, e2e, live, or real runtime test coverage
as a scoring input.

## Known Gaps

- Align the package-boundary story for testing helpers: either retire the
  private `@openclaw/plugin-sdk/testing` export, or document exactly who should
  rely on it and under what compatibility guarantees.
- Add generated doc-to-source validation or example smoke for
  `docs/plugins/sdk-testing.md` and `docs/plugins/sdk-subpaths.md` so helper
  import guidance stays synchronized with source and package rules.
- Add a narrow recurring repo-local smoke for representative testing-helper
  families rather than relying mostly on large lifecycle E2Es plus unit-level
  supporting signal.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/plugins/sdk-testing.md` documents the
  focused helper imports, marks them repo-local for bundled plugin tests, and
  deprecates the broad `openclaw/plugin-sdk/testing` barrel for new usage.
- `/Users/kevinlin/code/openclaw/docs/plugins/sdk-subpaths.md` catalogs testing
  helper subpaths and labels `plugin-sdk/testing` as a repo-local deprecated
  compatibility barrel.
- `/Users/kevinlin/code/openclaw/docs/help/testing.md` lists the relevant
  Docker plugin lifecycle and plugin install/update test lanes that exercise the
  shared fixture infrastructure.

### Source

- `/Users/kevinlin/code/openclaw/src/plugin-sdk/test-fixtures.ts` groups generic
  CLI runtime capture, sandbox, bundled-plugin path, transcript, terminal, and
  typed-case fixtures.
- `/Users/kevinlin/code/openclaw/src/plugin-sdk/test-env.ts` groups environment,
  fetch, HTTP server, temp-home, temp-dir, time, and provider-usage helpers.
- `/Users/kevinlin/code/openclaw/src/plugin-sdk/plugin-test-runtime.ts` groups
  plugin runtime, registry, setup wizard, and provider registration helpers.
- `/Users/kevinlin/code/openclaw/src/plugin-sdk/channel-test-helpers.ts` groups
  channel lifecycle, directory, status, outbound-delivery, and runtime-mock
  helpers.
- `/Users/kevinlin/code/openclaw/src/plugin-sdk/testing.ts` is the deprecated
  broad compatibility barrel that still re-exports many unrelated helper seams.
- `/Users/kevinlin/code/openclaw/packages/plugin-sdk/src/testing.ts` re-exports
  the deprecated compatibility barrel, and
  `/Users/kevinlin/code/openclaw/packages/plugin-sdk/package.json` still exports
  `./testing`.
- `/Users/kevinlin/code/openclaw/package.json` and
  `/Users/kevinlin/code/openclaw/src/infra/package-dist-inventory.ts` exclude
  the repo-local testing helper dist files from the main `openclaw` package
  inventory.

### Integration tests

- `/Users/kevinlin/code/openclaw/scripts/e2e/plugins-docker.sh` and
  `/Users/kevinlin/code/openclaw/scripts/e2e/lib/plugins/sweep.sh` exercise
  fixture-driven plugin install, inspect, update, uninstall, and runtime checks
  across multiple plugin source forms.
- `/Users/kevinlin/code/openclaw/scripts/e2e/lib/plugins/fixtures.sh`
  centralizes fixture writing, tarball packing, fake npm registry setup, trust
  recording, and cleanup used by the plugin E2E flows.
- `/Users/kevinlin/code/openclaw/scripts/e2e/bundled-plugin-install-uninstall-docker.sh`
  and
  `/Users/kevinlin/code/openclaw/scripts/e2e/lib/bundled-plugin-install-uninstall/sweep.sh`
  validate bundled plugin install and uninstall plus optional runtime smoke.
- `/Users/kevinlin/code/openclaw/scripts/e2e/plugin-lifecycle-matrix-docker.sh`
  and
  `/Users/kevinlin/code/openclaw/scripts/e2e/lib/plugin-lifecycle-matrix/sweep.sh`
  validate install, inspect, disable, enable, upgrade, downgrade, and
  missing-code uninstall for packaged plugin flows.
- `/Users/kevinlin/code/openclaw/scripts/e2e/codex-npm-plugin-live-docker.sh`
  validates a packaged OpenClaw + Codex plugin live install and agent-turn flow.
- `/Users/kevinlin/code/openclaw/packages/sdk/src/package.e2e.test.ts` and
  `/Users/kevinlin/code/openclaw/packages/sdk/src/index.e2e.test.ts` provide
  adjacent packaged-consumer proof for the broader SDK surface, even though the
  testing helper subpaths themselves are repo-local.

### Unit tests

- `/Users/kevinlin/code/openclaw/test/vitest/vitest.plugin-sdk.config.ts`
  defines the scoped `plugin-sdk` lane for `src/plugin-sdk/**/*.test.ts`.
- `/Users/kevinlin/code/openclaw/test/vitest/vitest.plugin-sdk-light.config.ts`
  defines the lighter `plugin-sdk-light` lane without full OpenClaw runtime
  setup.
- `/Users/kevinlin/code/openclaw/test/vitest-scoped-config.test.ts` and
  `/Users/kevinlin/code/openclaw/test/vitest-light-paths.test.ts` validate the
  scoped Plugin SDK lane wiring and light-path routing.
- `/Users/kevinlin/code/openclaw/test/openclaw-npm-postpublish-verify.test.ts`
  and `/Users/kevinlin/code/openclaw/src/infra/package-dist-inventory.ts`
  validate the exclusion and packaging rules for repo-local testing helper
  artifacts.

### Surface validation commands

- `pnpm plugin-sdk:check-exports`: `blocked` - relevant because it would verify
  the checked-in Plugin SDK export inventory, including deprecated compatibility
  seams, but local validation never reached command-specific checks because
  dependency installation failed with 403 registry auth errors for
  `@microsoft/teams.cards` and `@microsoft/teams.api`, including
  `No authorization header was set for the request`.
- `pnpm plugin-sdk:api:check`: `blocked` - relevant because it would detect
  drift in the current exported Plugin SDK surface, including legacy testing
  seams, but the same local dependency-auth failure blocked execution before
  real validation.
- `pnpm plugin-sdk:surface:check`: `blocked` - relevant because it would measure
  public and deprecated SDK surface growth, including compatibility barrels, but
  the same local dependency-auth failure blocked execution before real
  validation.
- `pnpm plugins:boundary-report:ci`: `blocked` - relevant because it would fail
  on cross-owner reserved imports and due compatibility debt, which matters for
  broad testing-helper barrels, but the same local dependency-auth failure
  blocked execution before real validation.
- `pnpm release:plugins:npm:check`: `blocked` - relevant because it would
  validate plugin npm release readiness and packaging assumptions adjacent to the
  fixture-driven plugin lifecycle flows, but the same local dependency-auth
  failure blocked execution before real validation.
- `pnpm release:plugins:clawhub:check`: `blocked` - relevant because it would
  validate ClawHub plugin release readiness for flows exercised by fixture-based
  plugin install and lifecycle tests, but the same local dependency-auth failure
  blocked execution before real validation.

### Gitcrawl queries

Query: `gitcrawl search openclaw/openclaw --query "plugin sdk testing harness fixture" --json`

Results:

- 4 keyword hits.
- The relevant hit was open issue `#80219`, which explicitly calls out test-ish,
  contract, mock, and compatibility surface sprawl in the Plugin SDK.
- The other hits were adjacent harness or gateway/runtime PRs rather than direct
  defects in this category.

Query: `gitcrawl search openclaw/openclaw --query "plugin sdk e2e docker fixture" --json`

Results:

- 1 keyword hit.
- The hit was open PR `#87141`, an active hardening change for malformed plugin
  schema and metadata boundary handling with Plugin SDK-adjacent tests.

Query: `gitcrawl threads openclaw/openclaw --numbers 80219,87141 --include-closed --json`

Results:

- `#80219` remains open and recommends freezing or de-emphasizing broad
  compatibility surfaces such as `testing`.
- `#87141` remains open and documents targeted hardening plus added tests rather
  than a systemic fixture-surface regression.

### Discrawl queries

Query: `discrawl --json search "plugin sdk testing harness fixture" --limit 5`

Results:

- `null`.
- With current archive freshness recorded above, I treat this as neutral rather
  than positive.

Query: `discrawl --json search "plugin sdk testing" --limit 5`

Results:

- 5 broad hits.
- The only mildly relevant hit was a 2026-05-16 maintainer status note saying
  current focus included RTT test work plus plugin SDK, upgrade, and npm issues
  or PRs.
- I did not find a direct maintainer or user archive report describing a broken
  helper subpath or fixture workflow in this category.
