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

Failed update and repair attempts enter [recovery triage](/cli/update#recover-a-failed-update)
after service recovery and cleanup finish.
A verified rollback does not start triage: the previous generation is running
again, and the report keeps the failing check as the reason.

After a final interactive update failure, **Diagnose update failure** and
**Report update failure** are separate choices. Reporting first shows the exact
sanitized issue body and defaults confirmation to **No**. After confirmation,
OpenClaw checks the GitHub CLI's active `github.com` account with a silent,
read-only request before issue creation. Fallback and pending outcomes retain the
sanitized report locally; a confirmed issue keeps only its durable issue URL.
If the CLI is missing or that check cannot confirm authentication, OpenClaw
provides a prefilled issue link without starting issue creation. If the exact
report exceeds the browser URL limit, OpenClaw keeps the sanitized body locally
and returns to the action menu, where reporting can be chosen and confirmed
again. A report preparation or submission
error also returns to that menu; Diagnose runs only when selected explicitly.
In the Control UI, an interrupted
pre-create preparation becomes retryable after its local reservation expires.
After an uncertain creation result, OpenClaw checks for an issue matching the
exact report. If neither a verified issue URL nor a definitive rejection is
available, the report stays pending with no replay link because an issue may
already exist.
`--yes`, `--json`, non-interactive runs, and managed-service handoffs never
submit a report.

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
for channel, availability, and the latest durable update report. Gateway console verbosity (`--verbose`) and
file log level (`logging.level: "debug"`/`"trace"`) are independent knobs; see
[Gateway logging](/gateway/logging).

Interactive updates show phase transitions, the current step, and elapsed time.
The phases match the Control UI: requested, staging, validating, optional
repairing, activating, restarting, verifying, and finished. When output is
piped or captured in a log, progress prints without animation. `repairing` can
follow failed candidate validation or failed post-activation verification when
rollback is unsafe or has failed; successful repair returns to validation or
verification. The Control UI shows this optional phase only after it starts.
Failed steps include the final diagnostics from both output streams; timeouts
are labeled explicitly. The final report includes the outcome, recorded phase durations, failed steps,
verification facts, and recovery guidance. `--json` keeps stdout machine-readable and does not
print progress steps.

When switching from a dev checkout to a package, the updater replaces npm's
install link and leaves the external checkout untouched. If activation fails,
restoring that link and its launchers does not verify the mutable checkout's
runtime. Recovery stays unverified and does not authorize an automatic restart;
inspect the checkout and recovery report before restarting it.

`--yes` also skips the optional shell-completion setup prompt. Existing
completion profiles and caches are still repaired when needed; installing
completion in a new shell profile remains an interactive choice.

`--tag` changes only this package update. A saved `update.channel` continues to
govern later foreground and automatic updates, even after a one-off beta
install. Use `--channel` to change that policy.

For source checkouts, `--dry-run` previews the update flow without fetching Git
refs or checking working-tree changes. The real update checks for uncommitted
changes before modifying the checkout. Use `openclaw update status` to inspect
the current branch, version, and update availability.

<Note>
In Nix mode (`OPENCLAW_NIX_MODE=1`), mutating `openclaw update` runs are disabled. Update the Nix source or flake input for this install instead; for nix-openclaw, use the agent-first [Quick Start](https://github.com/openclaw/nix-openclaw#quick-start). `openclaw update status` remains read-only. `openclaw update --dry-run` previews the flow and records a skipped run without changing the installation.
</Note>

<Warning>
Downgrades require confirmation because older versions can break configuration.
If the install has already migrated sessions to SQLite, restore archived legacy
transcript artifacts before starting an older file-backed version. See
[Doctor: Downgrading after session SQLite migration](/cli/doctor#downgrading-after-session-sqlite-migration).
</Warning>

## Recover a failed update

After a failed interactive update or repair, OpenClaw finishes cleanup and
opens [Triage](/cli/triage). Triage immediately starts the first directly
launchable coding agent on `PATH`, in this order: Claude Code, Codex, OpenCode,
then Pi. It passes the captured update failure directly and leaves fresh Doctor
checks and diagnostics collection to the agent, so a broken installation does
not delay the handoff. The agent keeps its existing authentication, sandbox, and
approval settings.

The agent starts in the operator's original working directory, or their OS home
if that directory is no longer accessible. The failed installation's resolved
state, config, and default workspace paths remain pinned for the repair.

Updates using `--yes`, `--json`, or a non-interactive session (including piped
input or output) collect diagnostics and print handoff commands without starting
an external coding agent. The updater's earlier
[unattended repair slot](/install/updating#unattended-repair-on-your-own-inference)
can still run on configured inference. With `--json`, triage output goes to stderr so stdout retains
the original update result. Diagnostic collection failures never hide the update
failure.

For a background or Control UI failure, use the installation-specific command
printed on the Gateway host. Printed commands use PowerShell on Windows and
POSIX shells on macOS, Linux, and WSL. When running triage manually, keep the same
profile and state/config overrides:

```bash
openclaw triage
openclaw triage --agent codex
```

Use `openclaw triage --non-interactive` to collect diagnostics without starting
an agent. Add `--update-result <path>` to include a saved update-failure artifact.

Validation failures leave the serving Gateway untouched. If stopping the managed
service unloads it and then fails before activation, OpenClaw attempts to restore
the verified original runtime after rechecking service ownership. After activation, a
failed verification can [restore the previous package](/cli/update#validation-and-activation)
when database schemas are unchanged and the config file still matches the
candidate’s activation Doctor output. Preserve migrated state and
history; replacing the code alone cannot undo a migration. The original
failed update still exits nonzero after the agent finishes, even if the repair
succeeds.

Dry runs and commands rejected by the initial argument, external-supervisor,
state-store ownership, handoff identity, or immutable-config checks do not
collect diagnostics or start an agent. Once those checks pass, failed metadata,
schema, runtime, and managed-service checks enter triage even when installation
is blocked. This includes an update that cannot safely stop its parent Gateway
process. Diagnosis preserves that refusal: it does not stop the Gateway, retry
the update, or bypass safety checks. See
[Update troubleshooting](/install/update-troubleshooting).

## `update status`

Show the active update channel, git tag/branch/SHA (source checkouts only),
update availability, and the active or most recent update report.

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

## Run history and reports

Every admitted update has a durable `runId`, including updates requested from
chat, the Control UI, the CLI, and automatic update campaigns. Dry-run previews
and updates refused after admission keep a skipped or failed record with their
reason. CLI invocations rejected before admission leave state untouched. The same ID follows
the detached updater and the restarted Gateway, so reconnecting does not lose
the outcome. Post-core finalization children report back to their parent without
creating a separate update run, including when an older updater cannot forward
a run ID.

Triage preserves the original update report. Any update launched during repair
gets a separate `runId`.

`openclaw update --json` includes `runId` and the `run` record. `openclaw update status --json`
includes `activeRun` when a run is active and `lastRun` when history exists.
When the active row has been inactive for more than 30 minutes and its recorded
driver is verifiably dead, status also reports `abandonedRun` with its `runId`
and reconciliation `rule`. Status remains read-only: the stored row stays in
`activeRun` until the Gateway or explicit repair commits the outcome.
Identityless rows are never reconciled automatically, even when their only
step is `requested/in_progress`. For stale identityless rows, JSON includes
`staleRun` with `runId` and `guidance`; human status and Doctor preflight report
"no activity since &lt;time&gt;; if no update is running, run `openclaw update repair`
or start a new `openclaw update`".

An explicit new `openclaw update` (including `--dry-run`) supersedes the old row
only when it is the sole active run, has no recorded driver identity, and has
had no activity for more than 30 minutes. Admission atomically finishes that
row as `failed` with reason `superseded` and a retained `reconcile:superseded`
step, then creates the new run. Recent rows and rows with recorded identities
are preserved. Inherited update continuations and automatic campaigns do not
supersede legacy history. Configuration writes remain suspended until the
active row is reconciled.

OpenClaw 2026.9.2 can admit a new CLI update while an older row remains running;
the stale row does not block updater admission. Upgrade normally, then run
`openclaw update repair` from the updated installation if status still shows the
old run. See [Updating](/install/updating#stale-update-history).

Human output, chat completion notices, the Control UI update view, and the
`openclaw status` update line use the same report, including on success. The report shows recorded facts; an absent verification fact
means that check has not been observed.

Gateway clients with `operator.admin` can inspect history:

```bash
openclaw gateway call update.runs.list --params '{"limit":10}'
openclaw gateway call update.runs.get --params '{"runId":"<run-id>"}'
```

`update.runs.list` returns `{ runs }`; `limit` defaults to 20 and is capped at 100. `update.runs.get` returns `{ run }`, with `run: null` when the ID is unknown. `update.status` retains its existing
fields and adds optional `activeRun` and `lastRun` records. While a run is active,
the Gateway broadcasts `update.run.changed` with `runId`, `phase`, `status`, and
`updatedAtMs`. Reconnect and read the row to recover changes missed during restart.

Native service-stop observations do not advance the update's recorded phase.
If the Control UI cannot read fresh progress, it shows the read error alongside
the last recorded run; use **Check status** to retry without starting another update.

Phases are `requested`, `staging`, `validating`, optional `repairing`, `activating`,
`restarting`, `verifying`, and `finished`. Status is `running`, `succeeded`,
`failed`, `rolled-back`, or `skipped`. Repair may also follow `verifying` when
automatic rollback cannot complete. Phase timings, repair attempts, and
verification facts are included only when observed. Chat reports are limited to 1,500 characters;
`update.runs.get` preserves the bounded record for detailed inspection.

Current updaters record their process identities and refresh the ledger
every 30 seconds during long build, install, and finalization phases. The Gateway checks for
abandoned runs at startup and while following active updates. After more than
30 minutes without step or heartbeat activity, verifiably dead recorded drivers
allow the Gateway to finish the run as `failed` with reason `abandoned` and a
`reconcile:abandoned` step naming the rule. A live, unreadable, or foreign-host
driver prevents reconciliation. Each helper or finalization child records its
own identity and retains earlier drivers, because detached children can outlive
their parent. If process identity recording is unavailable, the update continues
with one warning and the run requires explicit recovery. Known parent identities
remain protected, and automatic reconciliation stays disabled for that run.
Heartbeat write errors warn once per driver run and do not interrupt a running
build, install, or finalization phase.

Historical rows without a driver identity require explicit `update repair` or
a new operator-started `openclaw update`.
An old `requested` row alone does not prove that its updater exited: the 2026.9.2
updater can still be waiting on package-manager or registry preflight before it
records its first staging step. Stop an unrecorded old updater before explicitly
recovering its stale row. See [Database schemas](/reference/database-schemas#update-run-ledger).

The run records `downtimeMs` from the service stop request until a Gateway is
verified running. Staging, candidate validation, and pre-activation repair are excluded. Verification
records include service PID/port, version/build identity, settled health,
plugin activation errors, channel readiness, and `/readyz`.

With transactional updaters from 2026.9.3 onward, a fresh process from the
candidate completes verification after a live database migration and writes the
final outcome to the same run. It carries forward the activation steps; a schema
upgrade does not create a separate report or let the old updater reopen the
newer database.

The 2026.9.2 updater keeps its own completion path. For shared-state migrations,
the candidate applies schema content but delays version publication until every
affected terminal run is at least five minutes old, or each still-running row
has been unchanged for more than 30 minutes. Doctor reports the deferral; the
new Gateway already uses the migrated content and publishes the version after
the deadline. Pending agent-database migrations, missing state metadata, and
failed content migrations still produce `update-schema-bump-unfenced` with
[manual update commands](/install/updating#updating-from-2026.9.2-across-a-schema-bump).
See [Database schemas](/reference/database-schemas#schema-bumps-and-older-updaters)
for exact publication rules and the remaining risk to a stalled old CLI's final
report.

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

| Flag                                             | Description                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--channel <stable\|extended-stable\|beta\|dev>` | Persist the core update channel before repair. For extended-stable, eligible official npm and trusted official ClawHub plugins that follow bare/default or `latest` intent target the exact installed core version. Extended-stable repair is rejected on Git checkouts without changing config. |
| `--json`                                         | Print machine-readable finalization JSON.                                                                                                                                                                                                                                                        |
| `--timeout <seconds>`                            | Override each repair phase deadline in seconds. Defaults vary by phase (see below).                                                                                                                                                                                                              |
| `--yes`                                          | Skip confirmation prompts.                                                                                                                                                                                                                                                                       |
| `--accept-capabilities`                          | Accept each plugin's reviewed capability changes while repairing plugin state.                                                                                                                                                                                                                   |
| `--no-restart`                                   | Accepted for parity; repair never restarts the Gateway.                                                                                                                                                                                                                                          |

`update repair` first inspects stale update history. When the installed Gateway
generation is healthy and the only remaining problem is an inactive ledger row,
repair records `failed` / `abandoned` and exits successfully without Doctor,
maintenance, or a service stop. It also acknowledges a Gateway-reconciled row
once within 30 minutes of reconciliation. Later repair invocations use full
finalization, so historical recovery cannot suppress plugin convergence.
Explicit recovery permits identityless historical rows only
after more than 30 minutes of inactivity; a recorded live or uninspectable driver
still blocks recovery. JSON output identifies reconciled run IDs in
`reconciledRuns`, with `status: "ok"`, `mode: "repair"`, and `restart: false`.

Explicit channel or capability changes and known incomplete post-core work use
full finalization. Recorded activation, restart, verification, or finalization steps require
that convergence even if the Gateway has already reconciled the run. Repair
checks newer abandoned history as well as active rows; an older stale row cannot
hide unfinished work from a newer update. If the bounded history inspection is
incomplete, repair also uses full finalization. If that
work needs maintenance while the managed service is
running, stop the service through its owner before retrying. Doctor cannot stop
or restart the service on the update parent's behalf.
Successful full finalization then reconciles the selected stale rows before
reporting completion. Failed convergence leaves the selected rows intact. If any
selected run resumes before reconciliation, the whole selection is preserved.
Full finalization JSON includes `reconciledRuns` when stale rows were selected
for recovery, listing the IDs reconciled by that invocation.

For full finalization, `update repair` runs `openclaw doctor --fix`, reloads the repaired config and
install records, syncs tracked plugins for the active update channel, updates
managed npm plugin installs, repairs missing configured plugin payloads,
refreshes the plugin registry, and writes converged install-record metadata.
Configured runtime plugins whose versions follow OpenClaw are checked against
the newly installed core during post-update repair, even when the updater process
started on the previous version.
It does not install a new core package and does not restart the Gateway.
Human output ends with a finalization result that distinguishes completion,
completion with warnings, and failure.

When repair finds a configured npm plugin payload but cannot recover its install
record, it reinstalls from the selected registry source, using the active channel
or exact version pin. This requires registry access; if verification fails, repair
preserves the existing payload and does not publish a new install record.
Registry verification and any required capability review finish before the
repaired install record is published.

When a bundled plugin moves to an external package, failed relocation reports
that the replacement payload was not installed and preserves the underlying error.
Resolve that error before retrying with `openclaw update repair`.
Doctor and update repair reinstall configured payloads with missing package files
or a reported missing runtime entry;
an empty directory is not a successful installation. Rollback removes empty
managed npm projects after staged files are cleaned up. Doctor preserves external
companion packages and their install records even when a source checkout also
contains a bundled-discovery copy of the same plugin. Repair diagnostics must identify the recorded
package root; a broken same-ID source copy does not trigger replacement of a
healthy managed package.

With `--json`, stdout contains one JSON document. Doctor panels and other
diagnostics go to stderr, so stdout can be parsed directly. Failed doctor or
plugin finalization steps still exit non-zero.

Finalization (including the supervisor-facing `update finalize` command) records
phase starts and finishes immediately on stderr and in the update run ledger.
The defaults are 30 seconds for preflight admission, config validation, config backup, and completion
cache work; 120 seconds for Doctor migrations; 600 seconds for plugin registry
and installation work; and 180 seconds for post-plugin Doctor and validation.
`--timeout` overrides each phase budget.

A phase deadline produces exit code 1 and JSON with `status: "failed"`,
`stuckPhase`, `elapsedMs`, `error`, and the existing `phaseTimings` array. Owned
command trees are stopped before the finalizer exits so the supervisor can
recover. Preserve the phase diagnostic when reporting a stalled update.
Shared CLI disposers have individual five-second deadlines. If the finalizer
remains alive ten seconds after its terminal JSON, stderr and the ledger
record active resource types and unsettled disposer names, then the process
exits with its recorded outcome. A retained handle cannot withhold the
supervisor's result indefinitely.
Human repair can still wait for a recovery choice or repair agent; its exit grace
starts after recovery finishes. Completion-cache refresh remains best effort
when its child can be stopped within the phase budget. A phase that exceeds its
overall deadline still fails finalization.

Plugin artifacts that require capability consent are not installed without an
interactive review or explicit `--accept-capabilities`. `--yes` alone does not
accept capability changes, and JSON mode does not prompt. An unresolved review
preserves the previous plugin, exits non-zero, and blocks any requested Gateway
restart. This also applies when a bundled plugin moves to an external package or
a missing configured plugin has no install record yet. Automatic repair can
report a deferred replacement as a notice when a usable, enabled artifact remains
installed; that retained artifact still undergoes payload validation.

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
for other SQLite maintenance commands to finish. Stop database readers too,
including watchers that repeatedly run `openclaw sessions --all-agents --json`,
and keep them stopped until cleanup exits. Read-only SQLite connections can
create or change WAL/SHM sidecars, invalidating cleanup's destination check even
when session content is unchanged. If cleanup reports `Recovery destination
database changed; preview cleanup again.`, stop those readers, preview again,
and retry. Cleanup requires exclusive offline state ownership and never stops
or restarts a service itself.

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
Private package, command-shim, and Git runtime backups remain owned by the update
transaction and are outside this migration cleanup. An interrupted entry in update
history does not block cleanup of otherwise eligible migration archives.

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

### Validation and activation

If the resolved package version equals the installed version without changing
the selected channel or installation method, or the Git target SHA equals
`HEAD`, the run finishes `skipped` with reason `already-current`. A same-version
explicit `--channel` or installation-method change finishes successfully.
Neither path stops or restarts the Gateway unless the installation method
changes. Read-only plugin convergence checks can still report repair needs; use
`openclaw update repair` to apply them.

For targets that support candidate validation, the old Gateway keeps serving through `staging` and
`validating`. The updater uses the candidate entrypoint for Doctor lint
(`doctor --lint --json --severity-min error`), config validation, and read-only
plugin resolution and compatibility planning. It also rehearses migrations and
boots a canary with copied configuration and verified SQLite snapshots in an
isolated temporary state directory. The copied database registry points to the
copied agent databases. Installed plugin payloads and their dependencies are also
copied; the rehearsal install records point to those copies, and their OpenClaw
host links target the staged candidate. The live plugin files and host links stay
unchanged. Channels, cron, automatic updates, and other side services are
suppressed in this canary.

Schema checks also use private SQLite copies so inspection does not create or
modify WAL sidecars beside live databases. Each schema inspection has a
30-second deadline; if compatibility cannot be verified, rollback is refused.

The canary binds a free loopback port and must report `/startupz` as `started`,
then `/readyz` as ready within a five-minute total budget. Failure records the
phase, elapsed time, and bounded diagnostics; the canary process group and
temporary state are cleaned up. This proves candidate startup on copied state;
live channel and provider behavior are checked after activation.
Targets that predate migration continuation record runtime validation as
unavailable and use the current updater's existing finalization path. A present
continuation entry with an invalid schema contract still refuses activation.
The database-schema preflight still refuses incompatible downgrades. These older
targets do not support automatic schema-neutral rollback; see
[Downgrade finalization](/install/updating#roll-back-a-package-install).

Candidate Doctor, config, plugin, or canary validation failures enter a bounded
`repairing` phase using configured inference. The updater reruns the failed
check after each attempt and activates only after it passes. Failed or unavailable
repair discards the candidate and leaves the serving Gateway untouched.
Pre-activation repair uses disposable rehearsal state and configuration, then
independently validates surviving candidate changes before activation, and
`repair-requires-config-change` reports changed top-level keys that require
operator-run `openclaw doctor --fix` or `openclaw triage`; post-activation repair
uses the live installation. See
[Unattended repair](/install/updating#unattended-repair-on-your-own-inference) for
budgets, permitted repairs, and attempt reports.

Only `activating` stops the managed service. Its offline work includes the package
or checkout swap, required `doctor --fix` migrations, and state compatibility
inspection, followed by service start
in `restarting`. Update verification does not use model inference. In `verifying`,
the updater checks that the managed service is running and owns its port, requires
the normal 12-probe health settle and a Gateway hello handshake matching the
expected version and Git build identity, checks for plugin activation errors and
channel readiness, and requires HTTP 200 from `/readyz`.

A candidate can be running while verification fails. Recovery guidance uses the
latest observed service state and names the running version when known; an
earlier activation stop does not mean the service remains stopped.

Plugin packages download and sync after the core Gateway is serving. When the
plugin snapshot changes, the updater stops the service for a second measured
activation window, runs the required full Doctor migration pass under exclusive
maintenance, then restarts and verifies the final snapshot. Unchanged plugins
use read-only validation and readiness checks without another full Doctor pass.

The previous package tree remains available until activation or package restoration
is verified. If activation fails before a working package is confirmed and rollback
cannot be verified, finalization retains the backup and reports its location. Keep
that backup and repair the installation before restarting, including for older
targets without migration continuation. Automatic rollback requires that retained package, its pre-update verification, unchanged
config content since the activation Doctor pass, and unchanged pre-existing shared and affected per-agent
SQLite `user_version` values. A database first created during activation or
verification is schema-neutral only at the candidate's supported version for its
database kind; a missing pre-existing database or a new database at a foreign
version blocks rollback. Newly created databases must also be readable by the
previous package; unknown or incompatible support refuses rollback with
`rollback-state-unverified`. The updater restores the previous generation and verifies
it running before finishing `rolled-back`, preserving the failing check as its
reason. See [Automatic rollback](/install/updating#automatic-schema-neutral-rollback)
for the restoration and package-manager guards. The candidate’s own Doctor
migrations in the main config file do not block rollback, including on a fresh
install’s first update. Separate `$include` files must retain their pre-activation
configuration content. Doctor must have consumed the captured pre-update config,
and the current file must match its reported output. Restoration holds the normal config writer lock and
rechecks the captured hash before writing.
When needed, rollback replaces the main config with the exact bytes captured before
Doctor and owner-only permissions (`0600`), including the previous writer stamp.
Operator edits made after activation block
restoration, including edits before Doctor reads the config or after its last write; the next action names the changed config file. A failure alone does not
authorize restarting the candidate.

If the config file changed after the activation Doctor pass or the databases are
not schema-neutral, automatic rollback is refused with
`state-migrated-no-rollback`. The updater enters `repairing` on the installed
candidate, also used if rollback itself fails. If the previous package was
already restored, repair targets that version. Between repair attempts, the
updater starts or restarts a stopped or unhealthy service once and reruns the
post-restart verification checks. Successful verification finishes the run as
`succeeded` for the candidate, or `rolled-back` for the restored release with a
nonzero command exit. Failed repair preserves the original failure and attempt summaries.
Use the recorded diagnostics and [Triage](/cli/triage) for remaining failures,
preserving migrated state. These temporary validation
snapshots are not a full-state backup; see [Rollback](/install/updating#rollback).
If schema state cannot be verified, rollback is refused with
`rollback-state-unverified`; unknown state never counts as schema-neutral.

### Restart handoff

When an agent runs `openclaw update` inside a systemd user service or macOS
LaunchAgent Gateway, the CLI hands the update to the same managed-service helper
before stopping the Gateway. It prints the helper log path and follow-up commands
for update status and Gateway health, then exits; this acknowledges the handoff,
not a completed update. The helper launches staging and validation outside the
Gateway process tree while the old Gateway keeps serving, including during
bounded candidate repair. It parks the Gateway
only when the orchestrator reaches `activating`, then completes the existing
commit-or-cancel handoff. Keep stdout connected to the agent: stopping the service
can terminate the surrounding exec shell (SIGTERM or exit 143), including commands
chained after the update. After a handoff result, use the printed follow-up commands
for the final outcome. Plain terminal updates remain synchronous, and `--no-restart`
does not authorize stopping the agent's Gateway.

The Gateway core auto-updater requires a managed service restart path. It hands
the CLI update to a detached helper before activation. A foreground
Gateway keeps update hints but leaves installation and activation to the
operator: stop it, run `openclaw update`, then launch it again.

Control-plane `update.run` package-manager updates and supervised git-checkout updates use
the same managed-service handoff instead of replacing the package tree or
rebuilding `dist/` inside the live Gateway process: the Gateway starts a
detached helper, which runs `openclaw update --yes --json` from outside the
Gateway process tree. The Gateway exits only after candidate validation succeeds
and activation begins. If the handoff is unavailable,
`update.run` returns a structured response with the safe shell command to run
manually.

Stored extended-stable selections receive read-only startup and 24-hour update
hints when `update.checkOnStart` is enabled. These checks never apply an update,
start a handoff, restart the Gateway, use stable delay/jitter, or use beta
polling cadence. Explicit foreground updates, bare foreground updates with
stored `update.channel: "extended-stable"`, on-demand status, and their managed
Gateway handoff remain supported.

With a local managed service and restart enabled, candidate validation precedes
the stop as described above. The updater reports `Gateway: restarted and verified.`
only after the restarted service passes verification. Plugin-owned readiness
checks run against an isolated state snapshot and do not run interactive setup,
download models, or change config. Readiness owners are selected before their
health APIs load, so unrelated optional Doctor checks cannot interrupt the gate.
Selected checks remain mandatory, including when a required artifact is missing.

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

On Linux without a service manager, updates proceed when native inspection proves
the service is absent and the selected Gateway has no active lock or listener.
The command reports that there is no Gateway to restart. Existing service files,
manager runtime state, or failed filesystem inspection still require service access.

If service inspection is unavailable or installation ownership is unresolved,
the update refuses to mutate the checkout or package tree, including with
`--no-restart`. It cannot assess another service-owned profile's databases from
the invoking profile alone. Run `openclaw gateway status --deep` and retry when
ownership can be inspected. Proven-absent services and inspectable stopped
services remain supported. Services owned by another install remain untouched.

The published 2026.8.2 CLI also refuses updates on service-less Linux installs.
Use `openclaw update --no-restart` for that upgrade after confirming that no Gateway
is running; the new CLI cannot fix the old CLI's pre-update inspection.

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
separately from the CLI update that continues in the detached helper:

- `ok: true`, `result.status: "skipped"`,
  `result.reason: "managed-service-handoff-started"`, and
  `handoff.status: "started"`: the Gateway created the managed-service handoff
  so the detached helper can run `openclaw update --yes --json` outside the live
  service process. The old Gateway stays available during validation; this
  response does not mean the service has stopped or the update has completed.
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
while that sentinel is pending or failed. `update.status` retains the latest
sentinel and also returns the durable run record. The sentinel carries
`stats.runId`; the run record remains available after notice delivery consumes
the sentinel.

## Git checkout flow

### Channel selection

- `stable`: select the latest non-beta tag.
- `beta`: prefer the latest `-beta` tag, falling back to the latest stable tag
  when beta is missing or older.
- `dev`: fetch `main` and rebase the candidate.
- `extended-stable`: unsupported for Git checkouts; no checkout mutation
  occurs.

### Update steps

<Steps>
  <Step title="Verify clean worktree">
    Requires no uncommitted changes.
  </Step>
  <Step title="Resolve the target">
    Selects the channel's tag or branch and fetches upstream as needed. If the resolved target SHA equals `HEAD`, finishes `skipped` with reason `already-current` before staging or stopping the service.
  </Step>
  <Step title="Build a candidate">
    Stable, beta, and dev updates install dependencies and build in a temporary worktree while the old Gateway serves. Dev rebases the candidate first so local commits are preserved and the build validates the exact source that will be activated. On POSIX, staging uses a private directory in the checkout's existing ignored `.artifacts` area. By default, the full workspace stays on the checkout filesystem, not a potentially small system temporary filesystem. An existing `.artifacts` redirect is honored as an operator storage choice, just like the build cache. Existing checkout, parent, and artifact directory permissions are not changed. Windows keeps its short system-drive staging path. Only dev updates walk back through earlier commits; stable and beta updates validate their selected target.

    The updater prepares the built runtime on the destination filesystem and removes the temporary Git worktree registration before changing the live checkout. Cleanup failures remain visible in the update result. If an interruption leaves staging behind, artifact-area staging does not dirty the checkout or block the next update's clean check.

    Dev can walk back up to 10 commits to find the newest buildable candidate. Confirmed ENOSPC storage failures stop immediately with `preflight-insufficient-space`; free space on the preflight staging and package-manager store filesystems before retrying. Shared package-manager stores are not deleted. Update builds skip TypeScript declaration generation by default. Set `OPENCLAW_RUN_NODE_SKIP_DTS_BUILD=0` to explicitly request declarations. Set `OPENCLAW_UPDATE_PREFLIGHT_LINT=1` to also run source lint during this preflight; lint runs in constrained serial mode because user update hosts are often smaller than CI runners.

    The updater already running owns staging. Updating to a commit with this repair cannot change an older published updater's first hop; that default path requires a published baseline containing the repair.

    Uses the repo package manager. For pnpm checkouts, the updater bootstraps `pnpm` on demand (via `corepack` first, then a temporary npm installation of the target checkout’s exact pnpm version) instead of running `npm run build` inside a pnpm workspace. If pnpm bootstrap still fails, the updater stops early with a package-manager-specific error instead of trying `npm run build` in the checkout.

  </Step>
  <Step title="Validate the candidate">
    Runs candidate Doctor lint, config and plugin planning, and the isolated migration rehearsal and canary described above. Validation failure leaves the old Gateway serving.
  </Step>
  <Step title="Activate and verify">
    Stops the managed service, checks out the exact candidate SHA, publishes the prepared runtime, and runs required Doctor migrations. It starts and verifies the Gateway without reinstalling dependencies or rebuilding the checkout during downtime.

    If restoring the previous Git runtime fails, the Gateway stays stopped and the failed rollback step records the filesystem error. Pending originals remain in sibling `<runtime>.openclaw-update-<id>.tmp/previous` directories. Preserve those backups and repair the installation before restarting; cleanup does not delete an unrestored original.

  </Step>
  <Step title="Sync plugins">
    With the core serving, syncs plugins to the active channel. Dev uses bundled plugins; stable and beta use npm or ClawHub while preserving recorded source choices. A changed plugin snapshot uses the second maintenance and verification window described above; unchanged plugins do not run another full Doctor pass.
  </Step>
</Steps>

### Plugin sync details

On stable updates, a configured OpenClaw-owned official plugin with no install
record is repaired from the selected core release cohort. This also applies to
`doctor --fix` after an earlier upgrade lost a formerly bundled plugin. Admission
checks that package target before stopping the Gateway; post-core reconciliation
installs it before restart. Existing install records retain their source and
selector policy. Verified official packages use the existing
[capability-consent exemption](/plugins/manage-plugins#capability-consent).

Managed npm plugins on the beta channel select the newest version by semantic
version order from their `beta` and `latest` dist-tags, using the same policy as
the core updater. This includes official plugins with a default/latest catalog
target and managed `@beta` selectors. OpenClaw installs the exact inspected
version and retains the recorded selector for future updates.

ClawHub plugins on the beta channel try their own `@beta` tag. If that release
is unavailable, OpenClaw falls back to the default/latest spec and reports a
warning naming the requested and used targets.
Integrity, compatibility, trust, install-policy, and capability-consent failures
do not trigger fallback. Availability fallback warnings do not fail the core
update. Ordinary exact versions, ranges, and explicit tags other than `beta`
retain their selector.
Doctor can refresh a stale official runtime plugin that is bound to the current
OpenClaw release cohort. That repair stays on the recorded registry, verifies
the replacement artifact, and records its exact version if the npm install was
previously pinned.
Already-current runtime plugins are kept in place; a no-op startup repair does
not reinstall the package or invalidate the migration checkpoint.

<Warning>
If an exact pinned npm plugin update resolves to an artifact whose integrity differs from the stored install record, `openclaw update` aborts that plugin artifact update instead of installing it. Reinstall or update the plugin explicitly only after verifying you trust the new artifact.
</Warning>

<Note>
Post-update plugin sync failures that are scoped to a managed plugin and that the sync path can route around (for example an unreachable npm registry for a non-essential plugin) are reported as warnings after the core update succeeds. The JSON result keeps top-level update `status: "ok"` and reports `postUpdate.plugins.status: "warning"` with `openclaw update repair` and `openclaw plugins inspect <id> --runtime --json` guidance. Unexpected updater or sync exceptions still fail the update result. Fix the plugin install or update error, then rerun `openclaw update repair`. When a failed update leaves a managed plugin unusable, OpenClaw disables its runtime entry and resets active slots without changing the operator-authored `plugins.allow` or `plugins.deny` policy.

After the core Gateway is serving, `openclaw update` runs mandatory **post-core convergence**: it repairs missing configured plugin payloads, validates each _active_ tracked install record on disk, and statically verifies its `package.json` is parseable and its declared `openclaw.extensions` entries are loadable. When a package does not declare OpenClaw extensions, the check instead verifies any explicitly declared npm `main`. Failures from this pass, and an invalid config snapshot, return `postUpdate.plugins.status: "error"` and flip the top-level update `status` to `"error"`, so `openclaw update` exits nonzero and does not restart with the unverified plugin set. The error includes structured `postUpdate.plugins.warnings[].guidance` lines pointing at `openclaw update repair` and `openclaw plugins inspect <id> --runtime --json`. Disabled plugin entries and records that are not trusted-source-linked official sync targets are skipped here (mirroring the `skipDisabledPlugins` policy used by the missing-payload check), so a stale disabled plugin record cannot block an otherwise valid update. A changed plugin snapshot completes the exclusive Doctor maintenance, restart, and runtime verification sequence described above before the run succeeds.

When the updated Gateway starts, plugin loading is verify-only: startup does not run package managers or mutate dependency trees. Package-manager `update.run` restarts are handed to the CLI managed-service path, so the package swap happens outside the old Gateway process and the service health checks decide whether the update can be reported as complete.
</Note>

After an extended-stable core update succeeds, post-core plugin integrity and
convergence target eligible official npm and trusted official ClawHub plugins at the exact installed core
version. For default/`latest` intent, OpenClaw does not query plugin
`@extended-stable` or fall back to npm `latest`; it derives the package version
from the installed core. Explicit version pins, explicit non-`latest` tags,
third-party packages, custom registries, and other sources keep their existing intent.

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
sync, and restart work do not run from the suspect tree.

Staging uses a unique `.openclaw.update-stage-*` directory inside the target
global `node_modules`, separate from disposable npm rename leftovers. Each
attempt tries to remove only its own staging prefix; leftover cleanup does not
reclaim these stages. If an interrupted update leaves one behind, confirm that
no updater is still using it before removing that exact directory. This separation
does not make simultaneous package swaps safe.

A matching installed version is an `already-current` no-op. Real updates also
refresh core-command completion; full plugin-command completion rebuilds remain explicit
`openclaw completion --write-state` runs.

pnpm and Bun on macOS/Linux stage their owning global project and launchers,
preserving the manager's manifests, locks, and sibling packages for rollback.
Concurrent changes to that global project stop activation. Windows Bun updates
are rejected before the service stops because its binary launchers cannot be
relocated by the staged updater; use the owning Bun manager for a
[manual update](/install/updating#alternative-manual-npm-pnpm-or-bun).
Switching a pnpm- or Bun-owned package install to Git with `--channel dev` is
also rejected before activation. Staged source-checkout exposure currently
requires an npm-owned package symlink; package-to-package updates remain
supported through the owning manager.

## Related

- `openclaw doctor` (offers to run update first on git checkouts)
- [Development channels](/install/development-channels)
- [Updating](/install/updating)
- [CLI reference](/cli)
