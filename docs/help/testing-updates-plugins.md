---
summary: "How OpenClaw validates update paths, package migrations, and plugin install/update behavior"
read_when:
  - Changing OpenClaw update, doctor, package acceptance, or plugin install behavior
  - Preparing or approving a release candidate
  - Debugging package update, plugin dependency cleanup, or plugin install regressions
title: "Testing: updates and plugins"
sidebarTitle: "Update and plugin tests"
---

This is the dedicated checklist for update and plugin validation. The goal is
simple: prove the installable package can update real user state, repair stale
legacy state through `doctor`, and still install, load, update, and uninstall
plugins from the supported sources.

For the broader test runner map, see [Testing](/help/testing). For live provider
keys and network-touching suites, see [Testing live](/help/testing-live).

## What we protect

Update and plugin tests protect these contracts:

- A package tarball is complete, has a valid `dist/postinstall-inventory.json`,
  and does not depend on unpacked repo files.
- A user can move from an older published package to the candidate package
  without losing config, agents, sessions, workspaces, plugin allowlists, or
  channel config.
- `openclaw doctor --fix --non-interactive` owns legacy cleanup and repair
  paths. Startup should not grow hidden compatibility migrations for stale
  plugin state.
- Plugin installs work from local directories, git repos, npm packages, and the
  ClawHub registry path.
- Plugin npm dependencies are installed in the managed npm root, scanned before
  trust, and removed through npm during uninstall so hoisted dependencies do not
  linger.
- Plugin update is stable when nothing changed: install records, resolved
  source, installed dependency layout, and enabled state stay intact.

## Local proof during development

Start narrow:

```bash
pnpm changed:lanes --json
pnpm check:changed
pnpm test:changed
```

For plugin install, uninstall, dependency, or package-inventory changes, also
run the focused tests that cover the edited seam:

```bash
pnpm test src/plugins/uninstall.test.ts src/infra/package-dist-inventory.test.ts test/scripts/package-acceptance-workflow.test.ts
```

Before any package Docker lane consumes a tarball, prove the package artifact:

```bash
pnpm release:check
```

`release:check` runs config/docs/API drift checks, writes the package dist
inventory, runs `npm pack --dry-run`, rejects forbidden packed files, installs
the tarball into a temp prefix, runs postinstall, and smokes bundled channel
entrypoints.

## Docker lanes

The Docker lanes are the product-level proof. They install or update a real
package inside Linux containers and assert behavior through CLI commands,
Gateway startup, HTTP probes, RPC status, and filesystem state.

Use focused lanes while iterating:

```bash
pnpm test:docker:plugins
pnpm test:docker:plugin-lifecycle-matrix
pnpm test:docker:plugin-update
pnpm test:docker:upgrade-survivor
pnpm test:docker:published-upgrade-survivor
pnpm test:docker:update-migration
```

Important lanes:

- `test:docker:plugins` validates plugin install smoke, local folder installs,
  local folder update skip behavior, local folders with preinstalled
  dependencies, `file:` package installs, git installs with CLI execution, git
  moving-ref updates, npm registry installs with hoisted transitive
  dependencies, npm update no-ops, local ClawHub fixture installs and update
  no-ops, marketplace update behavior, and Claude-bundle enable/inspect. Set
  `OPENCLAW_PLUGINS_E2E_CLAWHUB=0` to keep the ClawHub block hermetic/offline.
- `test:docker:plugin-lifecycle-matrix` installs the candidate package in a bare
  container, runs an npm plugin through install, inspect, disable, enable,
  explicit upgrade, explicit downgrade, and uninstall after deleting the plugin
  code. It logs RSS and CPU metrics for each phase.
- `test:docker:plugin-update` validates that an unchanged installed plugin does
  not reinstall or lose install metadata during `openclaw plugins update`.
- `test:docker:upgrade-survivor` installs the candidate tarball over a dirty
  old-user fixture, runs package update plus non-interactive doctor, then starts
  a loopback Gateway and checks state preservation.
- `test:docker:published-upgrade-survivor` first installs a published baseline,
  configures it through a baked `openclaw config set` recipe, updates it to the
  candidate tarball, runs doctor, checks legacy cleanup, starts the Gateway, and
  probes `/healthz`, `/readyz`, and RPC status.
- `test:docker:update-migration` is the cleanup-heavy published-update lane. It
  starts from a configured Discord/Telegram-style user state, runs baseline
  doctor so configured plugin dependencies have a chance to materialize, seeds
  legacy plugin dependency debris for a configured packaged plugin, updates to
  the candidate tarball, and requires post-update doctor to remove the legacy
  dependency roots.

Useful published-upgrade survivor variants:

```bash
OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SPEC=openclaw@2026.4.23 \
OPENCLAW_UPGRADE_SURVIVOR_SCENARIO=versioned-runtime-deps \
pnpm test:docker:published-upgrade-survivor

OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SPEC=openclaw@latest \
OPENCLAW_UPGRADE_SURVIVOR_SCENARIO=bootstrap-persona \
pnpm test:docker:published-upgrade-survivor
```

Available scenarios are `base`, `feishu-channel`, `bootstrap-persona`,
`plugin-deps-cleanup`, `configured-plugin-installs`, `tilde-log-path`, and
`versioned-runtime-deps`. In aggregate runs,
`OPENCLAW_UPGRADE_SURVIVOR_SCENARIOS=reported-issues` expands to all reported
issue-shaped scenarios, including the configured-plugin install migration.

Full update migration is intentionally separate from Full Release CI. Use the
manual `Update Migration` workflow when the release question is "can every
published stable release from 2026.4.23 onward update to this candidate and
clean up plugin dependency debris?":

```bash
gh workflow run update-migration.yml \
  --ref main \
  -f workflow_ref=main \
  -f package_ref=main \
  -f baselines=all-since-2026.4.23 \
  -f scenarios=plugin-deps-cleanup
```

## Package Acceptance

Package Acceptance is the GitHub-native package gate. It resolves one candidate
package into a `package-under-test` tarball, records version and SHA-256, then
runs reusable Docker E2E lanes against that exact tarball. The workflow harness
ref is separate from the package source ref, so current test logic can validate
older trusted releases.

Candidate sources:

- `source=npm`: validate `openclaw@beta`, `openclaw@latest`, or an exact
  published version.
- `source=ref`: pack a trusted branch, tag, or commit with the selected current
  harness.
- `source=url`: validate an HTTPS tarball with required `package_sha256`.
- `source=artifact`: reuse a tarball uploaded by another Actions run.

Full Release Validation uses `source=artifact` by default, built from the
resolved release SHA. For post-publish proof, pass
`package_acceptance_package_spec=openclaw@YYYY.M.D` so the same upgrade matrix
targets the shipped npm package instead.

Release checks call Package Acceptance with the package/update/plugin set:

```text
doctor-switch update-channel-switch upgrade-survivor published-upgrade-survivor plugins-offline plugin-update
```

They also pass:

```text
published_upgrade_survivor_baselines=all-since-2026.4.23
published_upgrade_survivor_scenarios=reported-issues
telegram_mode=mock-openai
```

This keeps package migration, update channel switching, stale plugin dependency
cleanup, offline plugin coverage, plugin update behavior, and Telegram package
QA on the same resolved artifact.

`all-since-2026.4.23` is the Full Release CI upgrade sample: every stable npm-published release from `2026.4.23` through `latest`. For exhaustive published
update migration coverage, use `all-since-2026.4.23` in the separate Update
Migration workflow instead of Full Release CI. `release-history` remains
available for manual wider sampling when you also want the legacy pre-date
anchor.

Run a package profile manually when validating a candidate before release:

```bash
gh workflow run package-acceptance.yml \
  --ref main \
  -f workflow_ref=main \
  -f source=npm \
  -f package_spec=openclaw@beta \
  -f suite_profile=package \
  -f published_upgrade_survivor_baselines=all-since-2026.4.23 \
  -f published_upgrade_survivor_scenarios=reported-issues \
  -f telegram_mode=mock-openai
```

Use `suite_profile=product` when the release question includes MCP channels,
cron/subagent cleanup, OpenAI web search, or OpenWebUI. Use `suite_profile=full`
only when you need full Docker release-path coverage.

## Release default

For release candidates, the default proof stack is:

1. `pnpm check:changed` and `pnpm test:changed` for source-level regressions.
2. `pnpm release:check` for package artifact integrity.
3. Package Acceptance `package` profile or the release-check custom package
   lanes for install/update/plugin contracts.
4. Cross-OS release checks for OS-specific installer, onboarding, and platform
   behavior.
5. Live suites only when the changed surface touches provider or hosted-service
   behavior.

On maintainer machines, broad gates and Docker/package product proof should run
in Testbox unless explicitly doing local proof.

## Legacy compatibility

Compatibility leniency is narrow and time boxed:

- Packages through `2026.4.25`, including `2026.4.25-beta.*`, may tolerate
  already-shipped package metadata gaps in Package Acceptance.
- The published `2026.4.26` package may warn for local build metadata stamp
  files already shipped.
- Later packages must satisfy modern contracts. The same gaps fail instead of
  warning or skipping.

Do not add new startup migrations for these old shapes. Add or extend a doctor
repair, then prove it with `upgrade-survivor` or `published-upgrade-survivor`.

## Adding coverage

When changing update or plugin behavior, add coverage at the lowest layer that
can fail for the right reason:

- Pure path or metadata logic: unit test beside the source.
- Package inventory or packed-file behavior: `package-dist-inventory` or tarball
  checker test.
- CLI install/update behavior: Docker lane assertion or fixture.
- Published-release migration behavior: `published-upgrade-survivor` scenario.
- Registry/package source behavior: `test:docker:plugins` fixture or ClawHub
  fixture server.
- Dependency layout or cleanup behavior: assert both runtime execution and the
  filesystem boundary. npm dependencies may be hoisted under the managed npm
  root, so tests should prove the root is scanned/cleaned instead of assuming a
  package-local `node_modules` tree.

Keep new Docker fixtures hermetic by default. Use local fixture registries and
fake packages unless the point of the test is live registry behavior.

## Failure triage

Start with the artifact identity:

- Package Acceptance `resolve_package` summary: source, version, SHA-256, and
  artifact name.
- Docker artifacts: `.artifacts/docker-tests/**/summary.json`,
  `failures.json`, lane logs, and rerun commands.
- Upgrade survivor summary: `.artifacts/upgrade-survivor/summary.json`,
  including baseline version, candidate version, scenario, phase timings, and
  recipe steps.

Prefer rerunning the failed exact lane with the same package artifact over
rerunning the whole release umbrella.
