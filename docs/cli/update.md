---
summary: "CLI reference for `openclaw update` (updates, repair, and recovery cleanup)"
read_when:
  - You want to update a source checkout safely
  - You are debugging `openclaw update` output or options
  - You want to inspect or retire migration recovery originals after an update
  - You need to understand `--update` shorthand behavior
title: "Update"
---

# `openclaw update`

Update OpenClaw and switch between stable/extended-stable/beta/dev channels.

If you installed via **npm/pnpm/bun** (global install, no git metadata),
updates go through the package-manager flow described in
[Updating](/install/updating).

## Usage

```bash
openclaw update
openclaw update status
openclaw update repair
openclaw update cleanup --dry-run
openclaw update wizard
openclaw update --channel extended-stable
openclaw update --channel beta
openclaw update --channel dev
openclaw update --tag beta
openclaw update --dry-run
openclaw update --no-restart
openclaw update --yes
openclaw update --accept-capabilities
openclaw update --json
openclaw --update
```

`openclaw --update` rewrites to `openclaw update` (useful for shells and
launcher scripts).

## Options

| Flag                                             | Description                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--no-restart`                                   | Skip restarting the Gateway service after a successful update. Package-manager updates that do restart verify the restarted service reports the expected version before the command succeeds.                                                                                                                                                 |
| `--channel <stable\|extended-stable\|beta\|dev>` | Set the update channel and persist it after core update success. Extended-stable is package-only.                                                                                                                                                                                                                                             |
| `--tag <dist-tag\|version\|spec>`                | Override the package target for this update only. It cannot be combined with an effective `extended-stable` channel, whose verified exact target is mandatory. Package installs reject the `main` shorthand; use `--channel dev` for the supported checkout and build flow. Other explicit package specs keep their package-manager behavior. |
| `--dry-run`                                      | Preview planned actions (channel/tag/target/restart flow) without writing config, installing, syncing plugins, or restarting.                                                                                                                                                                                                                 |
| `--json`                                         | Print machine-readable `UpdateRunResult` JSON. Includes `postUpdate.plugins.warnings` when a managed plugin needs repair, beta-channel plugin fallback details, and `postUpdate.plugins.integrityDrifts` when npm plugin artifact drift is detected during post-update sync.                                                                  |
| `--timeout <seconds>`                            | Per-step timeout. Default `1800`.                                                                                                                                                                                                                                                                                                             |
| `--yes`                                          | Skip confirmation prompts (for example downgrade confirmation).                                                                                                                                                                                                                                                                               |
| `--accept-capabilities`                          | Accept each plugin's reviewed capability changes during post-update sync. This acknowledges the exact staged capability surface; it does not disable capability checks or establish future trust.                                                                                                                                             |

There is no `--verbose` flag. Use `--dry-run` to preview planned actions,
`--json` for machine-readable results, and `openclaw update status --json`
for channel/availability only. Gateway console verbosity (`--verbose`) and
file log level (`logging.level: "debug"`/`"trace"`) are independent knobs; see
[Gateway logging](/gateway/logging).

Interactive updates show the current step and elapsed time. When output is
piped or captured in a log, each step prints its progress without animation.
Failed steps include the final diagnostics from both output streams; timeouts
are labeled explicitly. The final total includes plugin updates and requested
Gateway restart checks. `--json` keeps stdout machine-readable and does not
print progress steps.

`--yes` also skips the optional shell-completion setup prompt. Existing
completion profiles and caches are still repaired when needed; installing
completion in a new shell profile remains an interactive choice.

For source checkouts, `--dry-run` previews the update flow without fetching Git
refs or checking working-tree changes. The real update checks for uncommitted
changes before modifying the checkout. Use `openclaw update status` to inspect
the current branch, version, and update availability.

<Note>
In Nix mode (`OPENCLAW_NIX_MODE=1`), mutating `openclaw update` runs are disabled. Update the Nix source or flake input for this install instead; for nix-openclaw, use the agent-first [Quick Start](https://github.com/openclaw/nix-openclaw#quick-start). `openclaw update status` and `openclaw update --dry-run` remain read-only.
</Note>

<Warning>
Downgrades require confirmation because older versions can break configuration.
If the install has already migrated sessions to SQLite, restore archived legacy
transcript artifacts before starting an older file-backed version. See
[Doctor: Downgrading after session SQLite migration](/cli/doctor#downgrading-after-session-sqlite-migration).
</Warning>

## `update status`

Show the active update channel, git tag/branch/SHA (source checkouts only),
and update availability.

```bash
openclaw update status
openclaw update status --json
openclaw update status --timeout 10
```

| Flag                  | Default | Description                         |
| --------------------- | ------- | ----------------------------------- |
| `--json`              | `false` | Print machine-readable status JSON. |
| `--timeout <seconds>` | `3`     | Timeout for checks.                 |

For extended-stable package installs, status performs the same public selector
and exact-package verification as foreground update. It can report
`ahead of extended-stable` when the installed version is newer. JSON failures
include `registry.reason` (`selector_missing`, `selector_query_failed`,
`exact_package_mismatch`, or `unsupported_git_channel`).

## `update repair`

Rerun update finalization after the core package already changed but later
repair work did not finish cleanly. This is the supported recovery path when
`openclaw update` installed the new core package but post-core plugin sync,
managed npm plugin metadata, registry refresh, or doctor repair did not
converge.

```bash
openclaw update repair
openclaw update repair --channel beta
openclaw update repair --json
openclaw update repair --accept-capabilities
```

| Flag                                             | Description                                                                                                                                                                                                                                                         |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--channel <stable\|extended-stable\|beta\|dev>` | Persist the core update channel before repair. For extended-stable, eligible official npm plugins that follow bare/default or `latest` intent target the exact installed core version. Extended-stable repair is rejected on Git checkouts without changing config. |
| `--json`                                         | Print machine-readable finalization JSON.                                                                                                                                                                                                                           |
| `--timeout <seconds>`                            | Timeout for repair steps. Default `1800`.                                                                                                                                                                                                                           |
| `--yes`                                          | Skip confirmation prompts.                                                                                                                                                                                                                                          |
| `--accept-capabilities`                          | Accept each plugin's reviewed capability changes while repairing plugin state.                                                                                                                                                                                      |
| `--no-restart`                                   | Accepted for parity; repair never restarts the Gateway.                                                                                                                                                                                                             |

`update repair` runs `openclaw doctor --fix`, reloads the repaired config and
install records, syncs tracked plugins for the active update channel, updates
managed npm plugin installs, repairs missing configured plugin payloads,
refreshes the plugin registry, and writes converged install-record metadata.
It does not install a new core package and does not restart the Gateway.

With `--json`, stdout contains one JSON document. Doctor panels and other
diagnostics go to stderr, so stdout can be parsed directly. Failed doctor or
plugin finalization steps still exit non-zero.

Plugin artifacts that require capability consent are not installed without an
interactive review or explicit `--accept-capabilities`. `--yes` alone does not
accept capability changes, and JSON mode does not prompt. An unresolved review
preserves the previous plugin, exits non-zero, and blocks any requested Gateway
restart.

If the core package has already changed, run `openclaw update repair` in an
interactive terminal to review plugin capabilities. After reviewing the changes,
automation can use `openclaw update repair --accept-capabilities`. Acceptance
applies to each artifact's recomputed declared surface during this invocation;
it does not approve future capability additions.

## `update cleanup`

Retire migration recovery originals after you have verified that the upgrade and
session history work. Start with a preview, which can run while the Gateway is
active:

```bash
openclaw update cleanup --dry-run
openclaw --profile work update cleanup --dry-run --json
```

Cleanup targets the selected profile and `OPENCLAW_STATE_DIR` / `OPENCLAW_CONFIG_PATH`
overrides. It displays that state directory and does not redirect to a managed
service. Confirm the displayed directory is the installation you intend to clean.
`--dry-run` reads only configuration and recovery metadata, without opening
databases, taking a maintenance lock, loading plugins, or creating state.
Candidate bytes still require identity verification; historical artifacts are
listed separately as requiring verification. Protected and blocked artifacts
include reason codes.

Before applying, stop the Gateway for that same profile/state directory and wait
for other SQLite maintenance commands to finish. Cleanup requires exclusive
offline state ownership and never stops or restarts a service itself.

<Warning>
Cleanup permanently removes the selected rollback originals, including branches
and metadata intentionally removed by a verified repair. Doctor restore cannot
recreate them afterward. Keep them, or preserve an independent backup containing
them, if you still need that rollback path. Current SQLite history stays in place.
</Warning>

```bash
openclaw update cleanup
openclaw update cleanup --yes --json
```

Interactive confirmation defaults to **No**. JSON mode never prompts or grants
consent; unattended deletion requires `--yes`. Consent does not override
ownership, file identity, or dependency checks. Applicable flags (`--dry-run`,
`--yes`, and `--json`) work before or after `cleanup`; update-only flags
`--channel`, `--tag`, `--timeout`, `--no-restart`, and `--accept-capabilities`
are rejected.

Only owner-recorded recovery artifacts with complete import evidence are
eligible. Unknown or unimported history, malformed inputs, trajectories,
forensic corrupt databases, operator backups, and unmanifested artifacts stay
protected. Old manifests are verified offline where possible; missing evidence
is a reason to retain an artifact. Cleanup has no automatic expiration policy.

The JSON result contains `stateDir`, `status`, `artifacts`, and `totals`. Each
artifact reports its path, run ids, logical bytes, outcome, and reason. Totals
separate candidates, verification-required, protected, blocked, and removed
bytes. Removal failures exit nonzero. Keep the recovery manifests and rerun
cleanup to finish recorded interrupted work; a retry does not delete a recreated
file. Removed logical bytes do not promise
equivalent physical space reclamation on cloned or snapshotted filesystems.
When a path cannot be inspected, its logical size comes from recorded artifact
metadata when available. Cleanup records durable intent before removal and uses
exclusive no-copy publication. Failures are reported; retries reconcile file
operations that already completed. Manifest files are synchronized before removal;
parent directories are synchronized where supported. Windows does not provide the
same parent-directory durability guarantee.

Doctor restore reports intentionally disposed originals and pending cleanup
explicitly. Neither update nor cleanup creates an automatic full-state backup;
these recovery originals are **not a full pre-upgrade backup**. See
[Before updating: create a verified backup](/install/updating#before-updating-create-a-verified-backup)
for backup coverage and [Doctor recovery](/cli/doctor#session-sqlite-migration)
for restoring retained originals.

## `update wizard`

Interactive flow to pick an update channel and confirm whether to restart the
Gateway afterward (defaults to restart). Selecting `dev` without a git
checkout offers to create one.

The channel picker reads the local install identity without checking Git
freshness or dependencies. Those checks run when you apply the update; use
`openclaw update status` to inspect availability first.

| Flag                    | Default | Description                                                  |
| ----------------------- | ------- | ------------------------------------------------------------ |
| `--timeout <seconds>`   | `1800`  | Timeout for each update step.                                |
| `--accept-capabilities` | `false` | Accept reviewed plugin capability changes during the update. |

## What it does

Switching channels explicitly (`--channel ...`) also keeps the install method
aligned:

- `dev` -> ensures a git checkout (default `~/openclaw`, or
  `$OPENCLAW_HOME/openclaw` when `OPENCLAW_HOME` is set; override with
  `OPENCLAW_GIT_DIR`), updates it, and installs the global CLI from that
  checkout.
- `stable` -> installs from npm using `latest`.
- `extended-stable` -> resolves the public npm `extended-stable` selector,
  verifies the exact selected package, and installs that exact version. It
  does not fall back to another selector and is rejected for Git checkouts.
- `beta` -> prefers npm dist-tag `beta`, falling back to `latest` when beta is
  missing or older than the current stable release.

### Restart handoff

The Gateway core auto-updater (when enabled via config) launches the CLI
update path outside the live Gateway request handler. Control-plane
`update.run` package-manager updates and supervised git-checkout updates use
the same managed-service handoff instead of replacing the package tree or
rebuilding `dist/` inside the live Gateway process: the Gateway starts a
detached helper and exits, and that helper runs `openclaw update --yes --json`
from outside the Gateway process tree. If the handoff is unavailable,
`update.run` returns a structured response with the safe shell command to run
manually.

Stored extended-stable selections receive read-only startup and 24-hour update
hints when `update.checkOnStart` is enabled. These checks never apply an update,
start a handoff, restart the Gateway, use stable delay/jitter, or use beta
polling cadence. Explicit foreground updates, bare foreground updates with
stored `update.channel: "extended-stable"`, on-demand status, and their managed
Gateway handoff remain supported.

When a local managed Gateway service is installed and restart is enabled,
package-manager and git-checkout updates stop the running service before
replacing the package tree or mutating the checkout/build output. The updater
then refreshes service metadata, restarts the service, and verifies the
restarted Gateway before reporting `Gateway: restarted and verified.`.
Doctor repair and plugin validation run before restart; a verified restart
does not run another Doctor from the old updater process.
Package-manager updates additionally verify the restarted Gateway reports the
expected package version; git-checkout updates verify gateway health and
service readiness after the rebuild.

Code updates do not require permission to rewrite the native service definition.
On Linux, sealed or unverified definition-write authority skips metadata refresh,
even when metadata is stale. An inspectable service owned by the updated install
still uses its native manager for restart and health/version verification.
Activation runs the updated CLI with `gateway restart --preserve-definition` so
its own version guards apply and automatic repair stays disabled. If the target
CLI does not support that option, it rejects activation before repair. The code
update stays installed, but the command exits nonzero with the activation error
(on stderr in JSON mode). A service stopped for the update may remain stopped.
Run `openclaw gateway status --deep` and ask the deployment owner to restart it
through its native manager or repair stale metadata; do not retry without the
preservation option unless definition repair is intended.

Shell installers do not establish the same service ownership proof. If their
service refresh is denied, they report code installation success, leave the
service untouched, and print guidance to inspect ownership and restart manually.

If service inspection is unavailable, a restart-enabled code update refuses to
mutate the checkout or package tree; it does not assume that no service exists.
Run `openclaw gateway status --deep` and retry when access is restored. Use
`--no-restart` only after manually stopping the Gateway, then restart it
manually after the update. Services owned by another install remain untouched.

Package-manager updates normally keep using the Node binary recorded in the
managed service. If that Node cannot run the target release, but the current
CLI Node can and the service is proven to belong to the package being updated,
a restart-enabled update uses the current Node for finalization and rewrites
the service metadata to that runtime. `--no-restart` cannot repair service
metadata, so the same runtime mismatch stops before package mutation.

On macOS, the post-update check also verifies the LaunchAgent is
loaded/running for the active profile and the configured loopback port is
healthy. If the plist is installed but launchd is not supervising it, OpenClaw
re-bootstraps the LaunchAgent automatically and reruns the health/version/
channel readiness checks (a fresh bootstrap loads the `RunAtLoad` job directly,
so recovery does not immediately `kickstart -k` the newly spawned Gateway).
When preserving a definition, native restart/bootstrap runs without file repair;
a failed native activation or health check does not trigger a later plist rewrite. If
the Gateway still does not become healthy, the command exits non-zero and
prints the restart log path plus restart, reinstall, and package rollback
instructions.

If restart cannot run, the command prints `Gateway: restart skipped (...)` or
`Gateway: restart failed: ...` with guidance to inspect the service and restart manually.
With `--no-restart`, package replacement or git rebuild still runs, but the
managed service is not stopped or restarted, so the running Gateway keeps old
code until you restart it manually.

### Control-plane response shape

When `update.run` runs through the Gateway control plane on a package-manager
install or supervised git checkout, the handler reports handoff initiation
separately from the CLI update that continues after the Gateway exits:

- `ok: true`, `result.status: "skipped"`,
  `result.reason: "managed-service-handoff-started"`, and
  `handoff.status: "started"`: the Gateway created the managed-service handoff
  and scheduled its own restart so the detached helper can run
  `openclaw update --yes --json` outside the live service process.
- `ok: false`, `result.reason: "managed-service-handoff-unavailable"`, and
  `handoff.status: "unavailable"`: OpenClaw could not find a supervising
  service boundary and durable service identity for a safe handoff (for
  example, systemd handoff requires the `OPENCLAW_SYSTEMD_UNIT` unit identity,
  not just ambient systemd process markers). The response includes
  `handoff.command`, the shell command to run from outside the Gateway.
- `ok: false`, `result.reason: "managed-service-handoff-failed"`: the Gateway
  tried to create the handoff but could not spawn the detached helper.

The `sentinel` payload is written before the Gateway exits, and the CLI
handoff updates that same restart sentinel after the managed-service restart
health checks complete. During the handoff, the sentinel can carry
`stats.reason: "restart-health-pending"` with no success continuation; the
restarted Gateway polls it and fires the continuation only after the CLI has
verified service health and rewritten the sentinel with the final `ok` result.
`openclaw status` and `openclaw status --all` show an `Update restart` row
while that sentinel is pending or failed, and `update.status` refreshes and
returns the latest sentinel.

## Git checkout flow

### Channel selection

- `stable`: checkout the latest non-beta tag, then build and doctor.
- `beta`: prefer the latest `-beta` tag, falling back to the latest stable tag
  when beta is missing or older.
- `dev`: checkout `main`, then fetch and rebase.
- `extended-stable`: unsupported for Git checkouts; no checkout mutation
  occurs.

### Update steps

<Steps>
  <Step title="Verify clean worktree">
    Requires no uncommitted changes.
  </Step>
  <Step title="Switch channel">
    Switches to the selected channel (tag or branch).
  </Step>
  <Step title="Fetch upstream">
    Dev only.
  </Step>
  <Step title="Preflight build (dev only)">
    Installs dependencies, builds, and validates config in a temporary worktree. On POSIX, staging uses a private directory in the checkout's existing ignored `.artifacts` area. By default, the full workspace stays on the checkout filesystem, not a potentially small system temporary filesystem. An existing `.artifacts` redirect is honored as an operator storage choice, just like the build cache. Existing checkout, parent, and artifact directory permissions are not changed. Windows keeps its short system-drive staging path.

    The updater attempts to remove staging before changing the live checkout; cleanup failures remain visible in the update result. If an interruption leaves staging behind, artifact-area staging does not dirty the checkout or block the next update's clean check.

    If a candidate fails, walks back up to 10 commits to find the newest buildable commit. Confirmed ENOSPC storage failures stop immediately with `preflight-insufficient-space`; free space on the preflight staging and package-manager store filesystems before retrying. Shared package-manager stores are not deleted. Content-addressed declaration outputs from the successful candidate are reused by the final checkout build; rebased source changes automatically invalidate the affected cache groups. Set `OPENCLAW_UPDATE_PREFLIGHT_LINT=1` to also run lint during this preflight; lint runs in constrained serial mode because user update hosts are often smaller than CI runners.

    The updater already running owns staging. Updating to a commit with this repair cannot change an older published updater's first hop; that default path requires a published baseline containing the repair.

  </Step>
  <Step title="Rebase">
    Rebases onto the selected commit (dev only).
  </Step>
  <Step title="Install dependencies">
    Uses the repo package manager. For pnpm checkouts, the updater bootstraps `pnpm` on demand (via `corepack` first, then a temporary npm installation of the target checkout’s exact pnpm version) instead of running `npm run build` inside a pnpm workspace. If pnpm bootstrap still fails, the updater stops early with a package-manager-specific error instead of trying `npm run build` in the checkout.
  </Step>
  <Step title="Build checkout">
    Builds the gateway and Control UI once in the final checkout. The updater runs the standalone Control UI build only when a target build omitted those assets or doctor later removes them.
  </Step>
  <Step title="Run doctor">
    `openclaw doctor` runs as the final safe-update check.
  </Step>
  <Step title="Sync plugins">
    Syncs plugins to the active channel. Dev uses bundled plugins; stable and beta use npm. Updates tracked plugin installs.
  </Step>
</Steps>

### Plugin sync details

After a beta core update, eligible official npm plugins with a default/latest
catalog target try the exact installed core version. This also applies to a
one-off `--tag <beta-version>` while the configured channel is stable, including
when plugin synchronization resumes in a fresh process. Other default-line npm
and ClawHub plugins on the beta channel try their plugin `@beta` tag.

If the selected beta plugin release is unavailable, OpenClaw falls back to the
default/latest spec and reports a warning naming the requested and used targets.
For npm plugins, this also applies when the selected beta package fails install
validation. These fallback warnings do not fail the core update. Ordinary exact
pins and explicit tags retain their selector; trusted official records can
refresh from the catalog during bulk synchronization, as with
[`plugins update --all`](/cli/plugins#update).

<Warning>
If an exact pinned npm plugin update resolves to an artifact whose integrity differs from the stored install record, `openclaw update` aborts that plugin artifact update instead of installing it. Reinstall or update the plugin explicitly only after verifying you trust the new artifact.
</Warning>

<Note>
Post-update plugin sync failures that are scoped to a managed plugin and that the sync path can route around (for example an unreachable npm registry for a non-essential plugin) are reported as warnings after the core update succeeds. The JSON result keeps top-level update `status: "ok"` and reports `postUpdate.plugins.status: "warning"` with `openclaw update repair` and `openclaw plugins inspect <id> --runtime --json` guidance. Unexpected updater or sync exceptions still fail the update result. Fix the plugin install or update error, then rerun `openclaw update repair`. When a failed update leaves a managed plugin unusable, OpenClaw disables its runtime entry and resets active slots without changing the operator-authored `plugins.allow` or `plugins.deny` policy.

After the per-plugin sync step, `openclaw update` runs a mandatory **post-core convergence** pass before the gateway restarts: it repairs missing configured plugin payloads, validates each _active_ tracked install record on disk, and statically verifies its `package.json` is parseable and its declared `openclaw.extensions` entries are loadable. When a package does not declare OpenClaw extensions, the check instead verifies any explicitly declared npm `main`. Failures from this pass, and an invalid config snapshot, return `postUpdate.plugins.status: "error"` and flip the top-level update `status` to `"error"`, so `openclaw update` exits non-zero and the gateway is _not_ restarted with an unverified plugin set. The error includes structured `postUpdate.plugins.warnings[].guidance` lines pointing at `openclaw update repair` and `openclaw plugins inspect <id> --runtime --json`. Disabled plugin entries and records that are not trusted-source-linked official sync targets are skipped here (mirroring the `skipDisabledPlugins` policy used by the missing-payload check), so a stale disabled plugin record cannot block an otherwise valid update.

When the updated Gateway starts, plugin loading is verify-only: startup does not run package managers or mutate dependency trees. Package-manager `update.run` restarts are handed to the CLI managed-service path, so the package swap happens outside the old Gateway process and the service health checks decide whether the update can be reported as complete.
</Note>

After an extended-stable core update succeeds, post-core plugin integrity and
convergence target eligible official npm plugins at the exact installed core
version. For default/`latest` intent, OpenClaw does not query plugin
`@extended-stable` or fall back to npm `latest`; it derives the package version
from the installed core. Explicit version pins, explicit non-`latest` tags,
third-party packages, and non-npm sources keep their existing intent.

For package-manager installs, `openclaw update` resolves the target package
version before invoking the package manager. npm global installs use a staged
install: OpenClaw installs the new package into a temporary npm prefix,
lets the candidate package validate the host Node version during `preinstall`,
and verifies the packaged `dist` inventory there. A packed completion guard
stays outside that inventory until `preinstall` succeeds, so package managers
that skip lifecycle scripts also stop before activation. On npm 12 and newer,
the updater approves only the candidate OpenClaw lifecycle; transitive
dependency scripts remain blocked. OpenClaw then swaps the clean package tree
into the real global prefix. If verification fails, post-update doctor, plugin
sync, and restart work do not run from the suspect tree. Even when the
installed version already matches the target, the command refreshes the
global package install, then runs plugin sync, a core-command completion
refresh, and restart work. This keeps packaged sidecars and channel-owned
plugin records aligned with the installed OpenClaw build, while leaving full
plugin-command completion rebuilds to explicit
`openclaw completion --write-state` runs.

## Related

- `openclaw doctor` (offers to run update first on git checkouts)
- [Development channels](/install/development-channels)
- [Updating](/install/updating)
- [CLI reference](/cli)
