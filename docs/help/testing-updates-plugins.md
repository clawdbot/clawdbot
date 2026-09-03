---
summary: "How OpenClaw validates update paths, package migrations, and plugin install/update behavior"
read_when:
  - Changing OpenClaw update, doctor, package acceptance, or plugin install behavior
  - Preparing or approving a release candidate
  - Debugging package update, plugin dependency cleanup, or plugin install regressions
title: "Testing: updates and plugins"
sidebarTitle: "Update and plugin tests"
---

Checklist for update and plugin validation: prove the installable package can
update real user state, repair stale legacy state through `doctor`, and still
install, load, update, and uninstall plugins from every supported source.

For the broader test runner map, see [Testing](/help/testing). For live provider
keys and network-touching suites, see [Testing live](/help/testing-live).

## What we protect

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
- Plugin npm dependencies install in one managed npm project per plugin,
  get scanned before trust, and get removed through `npm uninstall` during
  plugin uninstall so hoisted dependencies do not linger.
- Plugin update is a no-op when nothing changed: install records, resolved
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

`release:check` runs generated config/docs and plugin checks (config schema,
config docs baseline, plugin SDK exports and surface budget, plugin
versions/inventory), writes the package dist inventory, runs
`npm pack --dry-run`, rejects forbidden packed files, installs the tarball into
a temp prefix, runs postinstall, and smokes bundled channel entrypoints.

For a Plugin SDK change, compare the exact commits separately:

```bash
base_sha=$(git merge-base origin/main HEAD)
head_sha=$(git rev-parse HEAD)
pnpm plugin-sdk:api:diff -- --base "$base_sha" --head "$head_sha"
```

Release npm preflight uses the same readable diff against the prior published
dist-tag and prints the 8-character acknowledgement digest required when that
release changes the Plugin SDK API.

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
pnpm test:docker:update-restart-auth
pnpm test:docker:update-migration
```

Important lanes:

- `test:docker:plugins` covers plugin install smoke, local folder installs,
  local folder update skip behavior, local folders with preinstalled
  dependencies, `file:` package installs, git installs with CLI execution, git
  moving-ref updates, npm registry installs with hoisted transitive
  dependencies, npm update no-ops, malformed npm package metadata rejection,
  local ClawHub fixture installs and update no-ops, marketplace update behavior,
  and Claude-bundle enable/inspect. Set `OPENCLAW_PLUGINS_E2E_CLAWHUB=0` to
  keep the ClawHub block hermetic/offline.
- `test:docker:plugin-lifecycle-matrix` installs the candidate package in a bare
  container, runs an npm plugin through install, inspect, disable, enable,
  explicit upgrade, explicit downgrade, and uninstall after deleting the plugin
  code. It logs RSS and CPU metrics per phase.
- `test:docker:plugin-update` validates that an unchanged installed plugin does
  not reinstall or lose install metadata during `openclaw plugins update`.
- `test:docker:upgrade-survivor` installs the candidate tarball over a dirty
  old-user fixture, runs package update plus non-interactive doctor, then starts
  a loopback Gateway and checks state preservation.
- `test:docker:published-upgrade-survivor` first installs the latest stable release,
  configures it through a baked `openclaw config set` recipe, updates it to the
  candidate tarball, runs doctor, checks legacy cleanup, starts the Gateway, and
  probes `/healthz`, `/readyz`, and RPC status.
- `test:docker:update-restart-auth` installs the candidate package, starts a
  managed token-auth Gateway, unsets caller gateway auth env for
  `openclaw update --yes --json`, and requires the candidate update command to
  restart the Gateway before the normal probes.
- `test:docker:update-migration` is the cleanup-heavy published-update lane. It
  installs the latest stable release by default, starts from a configured
  Discord/Telegram-style user state, runs baseline
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

OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SPEC=openclaw@2026.7.1-2 \
OPENCLAW_UPGRADE_SURVIVOR_SCENARIO=sqlite-volume \
pnpm test:docker:published-upgrade-survivor
```

Available scenarios: `base`, `acpx-openclaw-tools-bridge`, `feishu-channel`,
`bootstrap-persona`, `channel-post-core-restore`, `plugin-deps-cleanup`,
`configured-plugin-installs`, `stale-source-plugin-shadow`, `tilde-log-path`,
`meeting-transcripts-sqlite`, `versioned-runtime-deps`, `cron-scheduled-authority`,
and `sqlite-volume`. In aggregate runs,
`OPENCLAW_UPGRADE_SURVIVOR_SCENARIOS=reported-issues` expands the release-soak
fixtures but excludes the expensive `sqlite-volume` scenario. Use
`OPENCLAW_UPGRADE_SURVIVOR_SCENARIOS=far-reaching` to include it.

`auth-profile-v2026-7-2-beta-5` is explicitly selectable outside those aggregate
aliases. It imports the historical JSON credential fixture, verifies credentials
and auth ordering in the current shared store, and checks archived source bytes.
It does not test retention of credentials created in a published SQLite store.

The `sqlite-volume` scenario combines configured Matrix, Discord, and Telegram
plugin/channel state with 4,800 sessions, 23,890 transcript events, and 2,200
cron crawl jobs by default. For baselines that expose the plugin-state SDK, it
uses that installed SDK to create the released shared database and write 512
permanent records across two namespaces, then checks that every stored value
and timestamp survives. Older baselines without that API explicitly report
this part as not applicable. It also seeds account-scoped pairing requests and
allowlists, plus workspace identity, instructions, and memory files. It verifies
exact JSONL-to-SQLite and cron migration, legacy archival, database integrity,
account isolation, and workspace contents immediately after the update, before
any standalone Doctor repair can hide an incomplete migration. It then reads
sampled conversations through Gateway RPC, runs an idempotent Doctor pass, and
repeats the history and preservation checks after a Gateway restart.

This is a package-update test inside Docker. It does not prove container image
replacement or background update campaigns; see [Updating](/install/updating)
for those separate entry points. A required plugin capability consent remains
an explicit recovery step and is recorded in the survivor summary.

Scale the fixture with `OPENCLAW_UPGRADE_SURVIVOR_VOLUME_SESSIONS`,
`OPENCLAW_UPGRADE_SURVIVOR_VOLUME_EVENTS_PER_SESSION`, and
`OPENCLAW_UPGRADE_SURVIVOR_VOLUME_CRON_JOBS`. The default budget for the
idempotent Doctor pass is 60 seconds; override it with
`OPENCLAW_UPGRADE_SURVIVOR_VOLUME_IDEMPOTENCE_BUDGET_SECONDS` on slower hosts.

The manual `Update Migration` workflow defaults to the latest stable release
and updates it to the selected `package_ref` artifact (`main` by default).
Leave `baselines` blank to use that default. For an explicit historical replay
from every published stable release since 2026.4.23, pass
`baselines=all-since-2026.4.23`:

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

- `source=npm`: validate `openclaw@extended-stable`, `openclaw@beta`,
  `openclaw@latest`, or an exact published version.
- `source=ref`: pack a trusted branch, tag, or commit with the selected current
  harness.
- `source=url`: validate a public HTTPS tarball with required `package_sha256`.
  This path rejects URL credentials, non-default HTTPS ports, private/internal
  hostnames or DNS/IP results, special-use IP space, and unsafe redirects.
- `source=trusted-url`: validate an HTTPS tarball with required
  `package_sha256` and `trusted_source_id` against the maintainer-owned policy
  in `.github/package-trusted-sources.json`. Use this for enterprise/private
  mirrors instead of weakening `source=url` with an input-level allow-private
  switch. Bearer auth, when configured by policy, uses the fixed
  `OPENCLAW_TRUSTED_PACKAGE_TOKEN` secret.
- `source=artifact`: reuse a tarball uploaded by another Actions run.

Full Release Validation uses `source=artifact` by default, built from the
resolved release SHA. For post-publish proof, pass
`package_acceptance_package_spec=openclaw@YYYY.M.PATCH` so the same upgrade matrix
targets the shipped npm package instead.

Release checks call Package Acceptance with the package/update/restart/plugin set:

```text
doctor-switch update-channel-switch skill-install update-corrupt-plugin upgrade-survivor published-upgrade-survivor root-managed-vps-upgrade update-restart-auth plugins-offline plugin-update plugin-binding-command-escape
```

When release soak is enabled (forced on for `release_profile=stable` and
`full`), they also pass:

```text
published_upgrade_survivor_scenarios=reported-issues
telegram_mode=mock-openai
```

This keeps package migration, update channel switching, corrupt managed-plugin
tolerance, stale plugin dependency cleanup, offline plugin coverage, plugin
update behavior, and Telegram package QA on the same resolved artifact without
making the default release package gate walk every published release.

Routine release proof resolves npm `latest` once to an exact stable package
before Docker fanout and runs every `reported-issues` scenario against that
baseline. The candidate remains the selected package-under-test tarball.

For manual historical coverage, `last-stable-4` selects four recent stable
npm-published releases. Exact versions, `all-since-2026.4.23`, and
`release-history` remain available through `published_upgrade_survivor_baselines`.
Use those overrides when replaying a historical migration, rather than adding
old releases to every routine release run.

When multiple published-upgrade survivor baselines are selected, the reusable
Docker workflow shards each baseline into its own targeted runner job. Each
baseline shard still runs the selected scenario set, but logs and artifacts stay
per-baseline and wall time is bounded by the slowest shard instead of one large
serial job.

Run a package profile manually when validating a candidate before release:

```bash
gh workflow run package-acceptance.yml \
  --ref main \
  -f workflow_ref=main \
  -f source=npm \
  -f package_spec=openclaw@beta \
  -f suite_profile=package \
  -f published_upgrade_survivor_scenarios=reported-issues \
  -f telegram_mode=mock-openai
```

For a published extended-stable canary, set
`package_spec=openclaw@extended-stable`. Package Acceptance resolves that
selector into an exact tarball before the Docker lanes run.

Use `suite_profile=product` when the release question includes MCP channels,
cron/subagent cleanup, OpenAI web search, or OpenWebUI. Use `suite_profile=full`
only when you need full Docker release-path coverage.

## Release default

For release candidates, the default proof stack is:

1. `pnpm check:changed` and `pnpm test:changed` for source-level regressions.
2. `pnpm release:check` for package artifact integrity.
3. Package Acceptance `package` profile or the release-check custom package
   lanes for install/update/restart/plugin contracts.
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
repair, then prove it with `upgrade-survivor`, `published-upgrade-survivor`, or
`update-restart-auth` when the update command owns the restart.

## Adding coverage

When changing update or plugin behavior, add coverage at the lowest layer that
can fail for the right reason:

- Pure path or metadata logic: unit test beside the source.
- Package inventory or packed-file behavior: `package-dist-inventory` or tarball
  checker test.
- CLI install/update behavior: Docker lane assertion or fixture.
- Published-release migration behavior: `published-upgrade-survivor` scenario.
- Update-owned restart behavior: `update-restart-auth`.
- Registry/package source behavior: `test:docker:plugins` fixture or ClawHub
  fixture server.
- Dependency layout or cleanup behavior: assert both runtime execution and the
  filesystem boundary. npm dependencies may be hoisted inside the plugin's
  managed npm project, so tests should prove that project is scanned/cleaned
  instead of assuming only the plugin package-local `node_modules` tree.

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
  config recipe coverage.

Prefer rerunning the failed exact lane with the same package artifact over
rerunning the whole release umbrella.
