---
summary: "Updating OpenClaw safely (global install or source), plus rollback strategy"
read_when:
  - Updating OpenClaw
  - Something breaks after an update
title: "Updating"
---

Keep OpenClaw up to date.

For Docker, Podman, and Kubernetes image replacements, see
[Upgrading container images](/install/docker#upgrading-container-images). The
gateway runs startup-safe upgrade work before readiness and exits if mounted
state needs manual repair.

Before a significant update, [create a verified backup](#before-updating-create-a-verified-backup).
Automatic config copies and migration recovery originals are not a full-state
backup.

## Recommended: `openclaw update`

Detects your install type (npm, pnpm, Bun, or git), validates the candidate while
the old Gateway serves, then activates and verifies the update.

```bash
openclaw update
```

An already-installed package version or Git target SHA finishes as
`skipped` / `already-current` without stopping or restarting the Gateway.
An explicit `--channel` choice still becomes the saved update channel.
For targets that support candidate validation, Doctor lint, config and plugin planning, and a
canary boot on copied state finish before the service stops. The first activation
window contains the swap, required migrations, and service start. Plugin packages
download and sync while the core Gateway serves. A changed plugin snapshot then
requires a second measured activation window for full Doctor migrations under
exclusive maintenance, restart, and verification. Unchanged plugins do not run
another full Doctor pass. The final report records downtime and verification
results. See
[Validation and activation](/cli/update#validation-and-activation) for the checks.

Package updates also check npm availability for enabled configured plugins before
stopping the serving Gateway or replacing the installed core. Registry targets
are checked early; explicit package artifacts are checked using the privately
staged package version before rehearsal, live-state preparation, or activation.
The check uses the same plugin version rules as post-update synchronization, including release-cohort
tracking, beta selection, and extended-stable targets. A missing version or registry
error refuses the update with `plugin-target-unavailable`; registry-target
`--dry-run` reports the same refusal. For explicit artifacts, `--dry-run` does not
stage the package and reports that plugin availability checking remains pending.
Retry when the registry or mirror is ready, select an older available
core with `openclaw update --tag <version>`, or disable the affected plugin before
retrying. Extended-stable does not accept `--tag`; retry later or explicitly switch
channels. Bundled and path-installed plugins do not require registry requests.
This metadata check does not reserve downloads, so later download failures can
still require recovery.

Switch channels or target a specific version:

```bash
openclaw update --channel beta
openclaw update --channel extended-stable
openclaw update --channel dev
openclaw update --dry-run   # preview without applying
```

`openclaw update` has no `--verbose` flag (the installer does). For diagnostics use
`--dry-run` to preview planned actions, `--json` for structured results, or
`openclaw update status --json` to inspect channel and availability state.

`--channel beta` selects the newest version by semantic version order from the
beta and latest npm dist-tags. Use `--tag beta` for a one-off package update pinned to the raw npm
beta dist-tag instead.

A saved `update.channel` remains the channel for future updates, automatic
checks, and update status. For example, a one-off beta package on a saved stable
channel keeps checking stable afterward. Use `--channel beta` to subscribe to
beta updates. Plugins still follow the installed core version where required
for compatibility.

`--channel extended-stable` is package-only, and installation remains
foreground-only. OpenClaw reads the public npm `extended-stable` selector,
verifies the selected exact package, and installs that exact version. Missing
or inconsistent registry data fails closed; it never falls back to `latest`.
If the selected version is older than the installed version, the normal
downgrade confirmation still applies. The CLI persists the channel after a
successful core update; a direct
`npm install -g openclaw@extended-stable --allow-scripts=openclaw` does not
update `update.channel`, but a final extended-stable package version still
checks only the verified `extended-stable` selector for update availability.
That direct command is for npm 12 or npm 11.16+. On npm 11.15 and earlier,
omit `--allow-scripts=openclaw`.
After the core swap, eligible official npm and trusted official ClawHub plugins with bare/default or
`latest` intent converge to that exact core version. Exact pins and explicit
non-`latest` tags, third-party plugins, custom registries, and other sources remain unchanged.
Version-bound runtime plugins converge to the base release cohort when the
core is a correction release (for example, `YYYY.M.P-2` uses plugin
`YYYY.M.P`).
Catalog installs created by current OpenClaw versions retain that default
intent. Older records that contain only an exact version remain pinned because
OpenClaw cannot safely distinguish an old automatic pin from a user pin. For npm
installs, run `openclaw plugins update @openclaw/name` once on the extended-stable
channel to opt that plugin back into exact-core tracking.

`--channel dev` gives a persistent moving GitHub `main` checkout for npm-owned
package installs and existing Git checkouts. Package
installs reject the `--tag main` shorthand because the workspace checkout is
not a self-contained package artifact. Use `openclaw update --channel dev` to
switch to the supported checkout and build flow. Other explicit package specs
keep their package-manager behavior.

Managed npm plugins on the beta channel use the same newest-of-beta/latest
selection, including official plugins such as `@openclaw/codex`. An older beta
tag cannot hold a plugin behind the current stable release. Startup repair
leaves already-current packages in place so a no-op refresh does not require
another restart.

See [Release channels](/install/development-channels) for channel semantics.

### Updating from 2026.9.2 across a schema bump

Updates driven by OpenClaw 2026.9.2 can cross a shared-state schema bump normally.
The target applies the migration content while retaining the old published
schema version, so the old updater can finish its ledger writes and final
report. Doctor explains that schema content is applied and version publication
is deferred. The new Gateway runs on the migrated content during this interval.

Publication waits until every affected update run has been terminal for at least
five minutes. A running row that has not changed for more than 30 minutes counts
as abandoned for publication purposes only; this does not terminalize an
identityless update-history row. The Gateway watcher publishes after the deadline;
a later database open can also publish it. See the precise timing and residual
old-CLI limitation in [Database schemas](/reference/database-schemas#schema-bumps-and-older-updaters).

If an agent database also needs migration, required state metadata is missing,
or the state-content migration fails, Doctor instead reports
`update-schema-bump-unfenced` with database versions and manual update commands.
Let the failed update finish restoring the previous package. OpenClaw 2026.9.2
leaves the Gateway service stopped after failed post-install verification. Run
the manual update from a shell outside the Gateway, replacing `<target>` with
the exact target version from the refusal:

```bash
openclaw gateway stop
npm install -g openclaw@<target> --allow-scripts=openclaw
openclaw doctor --fix
openclaw gateway start
```

Run each command only after the previous one succeeds. On npm 11.15 and earlier,
omit `--allow-scripts=openclaw`. For a pnpm-owned install, replace the install
command with `pnpm add -g --allow-build=openclaw openclaw@<target>`; for Bun, use
`bun add -g --trust openclaw@<target>`.

Same-schema updates, earlier ledger-less updaters such as 2026.9.1, and fenced
transactional updaters from 2026.9.3 onward keep their existing behavior. The
fallback does not undo an earlier migration; if the database is already newer
than the restored package, install a compatible target and finish Doctor before
starting the Gateway.

### From chat

The OpenClaw owner can say "update" (the agent uses the `gateway` action
`update.run`) or send `/update`. The candidate validates while the old Gateway
serves, and an already-current update does not restart it. Update runs can send
these notices in that chat as the Gateway observes the recorded milestones:

1. An acknowledgement when the update is accepted.
2. `⏳ Restarting the gateway now (v<from> → v<to>)…` when activation is recorded before the Gateway stops.
3. `🔁 Back on v<to>, verifying…` when the new Gateway starts verification.
4. The final report, including successful updates.

Managed systemd or launchd updates can stop the Gateway before an intermediate
notice is delivered. The complete four-message sequence is not guaranteed for
those installations; the durable run report remains available after reconnect.

Runs with an internal origin session, including Control UI and webchat, receive
these notices directly in that session's transcript. Passing only `sessionKey`
is enough; the caller does not need to supply `deliveryContext`.
Before stopping the managed service, the updater waits for the serving Gateway
to finish its restart notice attempt. That wait is capped at 10 seconds so a
stalled notice cannot block activation.

The report includes the outcome, recorded phase durations, failed steps,
verification facts, and the next action when needed. A run sends each notice
at most once; an update that stops before restart sends only the notices for
phases it reached. If the update cannot start, the bot records and explains why
and provides the manual command when available.

Chat, CLI, Control UI, and automatic updates share a durable run ID. Use
`openclaw update status` to read the active or latest report, including after a
restart; `--json` exposes the `activeRun` and `lastRun` records. See
[Run history and reports](/cli/update#run-history-and-reports) for Gateway history
queries.

The sender must be in [`commands.ownerAllowFrom`](/tools/slash-commands#configuration).
`/update` also requires `commands.restart` (enabled by default).
Agents must never run `npm install -g openclaw` or stop the Gateway service
from a chat shell; use the update action so restart and notification stay coordinated.

## Stale update history

If update status stays in progress while the Gateway is healthy, check that no
update is still running. On the updated installation, run:

```bash
openclaw update repair
openclaw update status
```

For an inactive legacy row older than 30 minutes, repair verifies that the
running Gateway matches the installed version and build, then clears the stale
run without maintenance or a service restart. A new explicit `openclaw update`
can also supersede a single stale identityless row. Recent rows and recorded
live drivers are protected. Identityless rows are never cleared automatically;
the Control UI's configuration-write suspension clears after reconciliation.

OpenClaw 2026.9.2 does not reject a new CLI update because an older running row
exists: its [admission path](https://github.com/openclaw/openclaw/blob/v2026.9.2/src/cli/update-cli/update-command-run.ts#L77)
creates a new run, and its [ledger](https://github.com/openclaw/openclaw/blob/v2026.9.2/src/infra/update-run-ledger.ts#L250)
checks only for a duplicate run ID. Upgrade normally, then use the updated
`openclaw update repair` if the old history remains. A package-manager escape
is not required for this ledger defect. See [Update run history](/cli/update#run-history-and-reports).

## Retire update recovery data

Once you have verified the update and your conversations, preview retained
migration originals:

```bash
openclaw update cleanup --dry-run
```

Use the same profile and state/config overrides as the update, and check the
state directory printed in the report. The metadata-only preview can run while
the Gateway is active. To apply, stop that Gateway yourself, wait for other
SQLite maintenance to finish, and stop database readers such as session-listing
watchers. Keep them stopped until `openclaw update cleanup` exits; read-only
connections can change WAL/SHM sidecars and invalidate verification. Cleanup never
stops or restarts the Gateway. Confirmation defaults to **No**; automation must
explicitly pass `--yes`, including when using `--json`.

Cleanup permanently gives up rollback to eligible originals, including repaired
branches and old provider metadata. Current SQLite history, operator backups,
and protected or unknown artifacts remain. It is not a substitute for a
[pre-update backup](#before-updating-create-a-verified-backup). See
[Update cleanup](/cli/update#update-cleanup) for eligibility, JSON output, and
resuming interrupted deletion.
Private package, command-shim, and Git runtime backups remain owned by the update
transaction and are outside this migration cleanup. An interrupted entry in update
history does not block cleanup of otherwise eligible migration archives.

## Switch between npm and git installs

Installer-driven switches verify the replacement before the working owner is retired. Source wrappers are published atomically; same-path npm shim transitions use an identity-checked backup that is restored on failure, so a failed candidate leaves the previous command runnable. The `openclaw update` command prints its final success result only after post-core convergence and requested restart health checks succeed.

Candidate validation failures leave the old Gateway serving. After activation,
package recovery can restore the retained previous package only when the shared
and affected pre-existing per-agent database schema versions are unchanged and
configuration has not changed since the candidate’s activation Doctor pass. A database first created by the candidate is neutral only
at its supported schema version for that database kind. The restored
Gateway must pass the same runtime checks before recovery is reported as
complete. A schema migration prevents automatic package rollback; replacing
code cannot undo migrated state. Incomplete file rollback retains its backups
for inspection. See [Automatic rollback](/install/updating#automatic-schema-neutral-rollback).
If an older target does not support preserving the service definition, automatic
recovery stops and reports the error without retrying with weaker options. Repair
the reported failure, rerun `openclaw update`, and check `openclaw gateway status --deep`.
See [Failed update recovery](/gateway/restart-recovery#recovery-after-a-failed-update).

On macOS, if Doctor reports an installed but unloaded and disabled Gateway
LaunchAgent after an interrupted update, finish update verification or Doctor and
triage first. Then use the printed `openclaw gateway start` command, preserving
its profile and state/config or custom-label overrides. `doctor --fix` diagnoses
the disabled label but leaves an already-stopped Gateway stopped.

Use channels to change the install type. The updater keeps your state, config,
credentials, and workspace in `~/.openclaw`; it only changes which OpenClaw
code install the CLI and gateway use.

```bash
# npm package install -> editable git checkout
openclaw update --channel dev

# git checkout -> npm package install
openclaw update --channel stable
```

Preview the install-mode switch first:

```bash
openclaw update --channel dev --dry-run
openclaw update --channel stable --dry-run
```

`dev` ensures a git checkout, builds it, and installs the global CLI from that
checkout. The `stable`, `extended-stable`, and `beta` channels use package
installs. Extended-stable is rejected on a git checkout without mutating or
converting it. If the gateway is already installed, `openclaw update` refreshes
the service metadata and restarts it unless you pass `--no-restart`.

Automatic package-to-Git conversion currently requires an npm-owned package
symlink. A pnpm- or Bun-owned install rejects `--channel dev` before stopping
the Gateway; use the [Git installer](/install/installer) when changing that
installation's owner. Normal package-to-package updates keep using pnpm or Bun.

Git updates build the complete runtime, including plugins and the Control UI,
in a temporary candidate worktree. Dev updates preserve local commits by
rebasing the candidate before its build. The updater publishes that prepared
runtime during activation instead of repeating the build while stopped.
Candidate installs and nested build commands use a private pnpm virtual store,
so preparing an update cannot prune dependencies used by the serving Gateway.
The candidate's temporary workspace settings are restored before checking for
source changes; the live checkout's workspace settings are preserved.

For package installs with a managed Gateway service, `openclaw update` targets
the package root used by that service. If the shell `openclaw` command comes
from a different install, the updater prints both roots and the managed
service's Node path, and checks that Node version against the target release's
`engines.node` requirement before replacing the package.

## Source-checkout servers (reference script)

Teams running a gateway directly from a git checkout on a server can update it
with `scripts/update-gateway.sh` from inside that checkout. It is the reference
for a source-server update: it fails closed on all tracked local changes,
including build outputs, fast-forwards `main` (or rebases a local server branch
onto `origin/main`), installs dependencies with a frozen lockfile, builds clean,
and restarts the gateway only after the build succeeds.

Like `openclaw update`, the script builds runtime JavaScript, plugin assets, and
the Control UI without generating TypeScript declarations by default. Set
`OPENCLAW_RUN_NODE_SKIP_DTS_BUILD=0` when invoking the script if this checkout
also needs fresh declarations for plugin development.

This reference script requires **Corepack** and creates temporary shims without
global activation before fetching. After fetching, it freezes the target commit
and checks that its exact pnpm pin can run through those shims in a private probe
workspace. The probe contains only package-manager metadata, not the target's
dependencies, hooks, or configuration. Missing or invalid metadata, provisioning
failure, or a version mismatch stops before checkout update or restart; repair
the target pin or install a compatible Corepack, then retry.

The same fetched commit is used for fast-forward or rebase. This is a fetched-target
toolchain preflight, not a complete preflight of a rebased local branch or its
build, and the script does not roll back later install or build failures. Local
branch overrides remain in effect: install and build resolve the resulting
checkout's pin, which may differ from the probed target pin. Operators must verify
those overrides and maintain a recovery path. The same shim directory leads
nested commands' `PATH`, and child workspace and lockfile roots follow each
operation's directory. Bootstrap, install, or build failure prevents restart.
The hosted [installers](/install/installer) also support npm-owned temporary provisioning
when Corepack is unavailable; this server script deliberately requires Corepack.

<Warning>
A running older updater or server script keeps its old bootstrap code even if it
checks out files containing this repair. If that older entry point invokes
ambient pnpm, the operator must select a target-compatible pnpm launcher before
the first update across the pin change. Validate that launcher against both the
intended target and the known-good rollback ref before starting the update.
Updating target files alone does not repair an older running binary.
</Warning>

Generated output roots such as `dist`, `dist-runtime`, and package-local
`dist` directories must be real directories. Builds refuse symbolic-link roots
before reading or mutating their contents so cleanup cannot affect the link
target. Replace an output-root symlink with a real directory before updating or
building a source checkout.

```bash
ssh you@server 'cd /path/to/openclaw && scripts/update-gateway.sh'
```

Override the restart for custom service units, or skip it entirely:

```bash
OPENCLAW_UPDATE_RESTART_CMD='systemctl --user restart openclaw-gateway.service' scripts/update-gateway.sh
OPENCLAW_UPDATE_RESTART_CMD='' scripts/update-gateway.sh
```

For a plain single-user source install, prefer `openclaw update --channel dev`
instead — it manages the checkout, build, and gateway restart for you.

## Alternative: re-run the installer

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
```

Add `--no-onboard` to skip onboarding. To force a specific install type, pass
`--install-method git --no-onboard` or `--install-method npm --no-onboard`.

If `openclaw triage` cannot start after a failed npm package replacement, re-run
the installer. It runs the global package install directly and can recover a
partially updated npm install. Keep an unverified Gateway stopped while repairing it.

```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --install-method npm
```

Pin the recovery to a specific version or dist-tag with `--version`:

```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --install-method npm --version <version-or-dist-tag>
```

## Alternative: manual npm, pnpm, or bun

The npm command below is for npm 12 or npm 11.16+. On npm 11.15 and earlier,
omit `--allow-scripts=openclaw`.

```bash
npm i -g openclaw@latest --allow-scripts=openclaw
```

Prefer `openclaw update` for supervised installs: it can coordinate the package
swap with the running Gateway service. If you update manually on a supervised
install, stop the managed Gateway first. Package managers replace files in
place, and a running Gateway can otherwise try to load core or plugin files
mid-swap. Restart the Gateway after the package manager finishes so it picks up
the new install.

For a root-owned Linux system-global install, if `openclaw update` fails with
`EACCES`, recover with system npm while keeping the Gateway stopped for the
manual replacement. Use the same profile flags/environment you normally use for
that Gateway. Replace `/usr/bin/npm` with the system npm that owns the
root-owned global prefix on your host:

The npm command below follows the same version contract: use the flag on npm 12
or npm 11.16+, and omit it on npm 11.15 and earlier.

```bash
openclaw gateway stop
sudo /usr/bin/npm i -g openclaw@latest --allow-scripts=openclaw
openclaw gateway install --force
openclaw gateway restart
```

Then verify:

```bash
openclaw --version
curl -fsS http://127.0.0.1:18789/readyz
openclaw plugins list --json
openclaw gateway status --deep --json
openclaw doctor --lint --json
```

When `openclaw update` manages a global npm install, it installs the target
into a temporary npm prefix first. The candidate package validates the host
Node version during `preinstall`; OpenClaw verifies the packaged `dist` inventory
before swapping the clean package tree into the real global prefix. Pending
lifecycle work is recorded in `.openclaw-lifecycle-pending` at the package root,
outside the `dist` inventory. `postinstall` removes that marker after completion.
If package scripts were skipped, the CLI completes the pending lifecycle before
running any command, including `--version`; failure stops the command with
reinstall guidance. The updater probes the owning npm before mutation. On npm
11.15 and earlier it omits the unsupported lifecycle-policy flag. On npm 12 and
npm 11.16+, it approves only the candidate OpenClaw lifecycle; transitive
dependency scripts remain unapproved.
This avoids npm overlaying a new package onto stale files from the old one. If
the install command fails, OpenClaw retries once with `--omit=optional`, which
helps hosts where native optional dependencies cannot compile.

For local tarball targets on npm 12, the archive filename and every parent
directory must be comma-free. See [Installer path requirements](/install/installer).

OpenClaw-managed npm update and plugin-update commands also clear npm's
`min-release-age` supply-chain quarantine (or the older `before` config key)
for the child npm process. That policy exists for general protection, but an
explicit OpenClaw update means "install the selected release now."

```bash
pnpm add -g --allow-build=openclaw openclaw@latest
```

If pnpm 11 installed OpenClaw 2026.7.1, run that manual command once. That
release predates pnpm 11's isolated global-package layout, so its updater can
mistake another npm installation for the running CLI. Later releases retain
pnpm ownership and follow the replacement package root during updates. They
also use the owning manager's reported global bin directory and stop before
mutation when the available pnpm command reports another global root,
or when the invoking package is orphaned or not the only active OpenClaw
install there.

pnpm 12 retains the `global/v11` layout; the layout number does not need to match
the pnpm CLI major version.

If OpenClaw shares a pnpm global install group with another package, the
automatic updater stops before changing the group. Update the original
comma-separated group manually so its sibling packages and build policy stay
intact.

```bash
bun add -g --trust openclaw@latest
```

`--trust` allows OpenClaw's lifecycle scripts. The canonical `openclaw update`
path applies the same OpenClaw-only Bun trust when it owns the install.
On Windows, the staged updater rejects Bun installs before stopping the Gateway
because it cannot relocate Bun's binary launchers. Run
`bun add -g --trust openclaw@<resolved-target-version>` manually, then
`openclaw gateway restart`; verify with `openclaw update status`.

### Package lifecycle and operator state

Package lifecycle hooks validate the Node runtime and update only package-local
artifacts: the installed `dist` tree and lifecycle markers. Plugin-registry and
operator-state migration belong to Doctor, not package installation. Doctor also
removes genuinely dangling global plugin-runtime links, but preserves shared and
versioned runtime caches and valid links to them: other installs or profiles may
still use them. `openclaw update` still runs Doctor after installing the candidate;
after a manual package replacement, run `openclaw doctor --fix` before restarting
the Gateway.

`OPENCLAW_DISABLE_BUNDLED_PLUGIN_POSTINSTALL=1` skips package-local postinstall
cleanup, but still completes the lifecycle marker. It does not disable Doctor or
Gateway startup migrations.

<Warning>
Older packages, including `2026.8.1`, can migrate the state database during
installation even with that postinstall opt-out set. Back up before upgrading.
To evaluate an affected package without changing a working Gateway, use a
disposable environment with separate home, config, and state directories. A
different npm prefix alone does not isolate operator state.
</Warning>

### Advanced npm install topics

<AccordionGroup>
  <Accordion title="Read-only package tree">
    After package lifecycle completion, OpenClaw treats packaged global installs as read-only at runtime, even when the global package directory is writable by the current user. Plugin package installs live in OpenClaw-owned npm/git roots under the user config directory, and Gateway startup does not mutate the OpenClaw package tree.

    Some Linux npm setups install global packages under root-owned directories such as `/usr/lib/node_modules/openclaw`. OpenClaw supports that layout because plugin install/update commands write outside that global package directory.

  </Accordion>
  <Accordion title="Hardened systemd units">
    Give OpenClaw write access to its config/state roots so explicit plugin installs, plugin updates, and doctor cleanup can persist their changes:

    ```ini
    ReadWritePaths=/var/lib/openclaw /home/openclaw/.openclaw /tmp
    ```

  </Accordion>
  <Accordion title="Disk-space preflight">
    Before package updates and explicit plugin installs, OpenClaw tries a best-effort disk-space check for the target volume. Low space produces a warning with the checked path, but does not block the update because filesystem quotas, snapshots, and network volumes can change after the check. The actual package-manager install and post-install verification remain authoritative.
  </Accordion>
</AccordionGroup>

## Auto-updater

Off by default. Enable it in `~/.openclaw/openclaw.json`:

```json5
{
  update: {
    channel: "stable",
    auto: {
      enabled: true,
    },
  },
}
```

You can also choose the update channel and enable automatic updates from
**Settings → Updates** (`/settings/updates`) in the Control UI.
**Check for updates** controls the existing `update.checkOnStart` setting.
When it is off, **Automatic updates** is disabled but keeps your saved preference;
turning checks back on resumes discovery and any enabled automatic-update policy.
This does not change your separate feature-statistics preference.
Recorded failures on that page include typed **Check status** and **Retry
update** actions when the connected Gateway supports them. See [Update
troubleshooting](/install/update-troubleshooting) for reason codes, guided
recovery, CLI fallbacks, and diagnostics to collect.
For a `dev` git install, opening this page refreshes the tracked upstream and
shows whether the checkout is current, ahead, diverged, unavailable, or a
specific number of commits behind. It also shows exact and relative build,
verified install, and last-commit times. Existing checkouts show an unknown
install time until their next verified successful update.

Automatic installation requires a managed Gateway service that can hand off
the update and restart safely. A Gateway running directly in a terminal can
still show update hints, but it does not automatically replace its running
installation. Stop that Gateway, run `openclaw update`, and launch it again
afterward, or [install a managed service](/cli/gateway#manage-the-gateway-service) for
unattended updates.

| Channel           | Behavior                                                                                                                                                            |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stable`          | After a built-in delay with deterministic jitter for a spread rollout, announces an update campaign.                                                                |
| `extended-stable` | Checks for a read-only update hint on startup and every 24 hours when `checkOnStart` is enabled. Never applies automatically.                                       |
| `beta`            | Checks on a built-in interval and announces an update campaign as soon as a newer release is available.                                                             |
| `dev`             | With `auto.enabled`, git installs check hourly. When upstream commits are available, the Gateway announces an update campaign pinned to the exact announced commit. |

### Update campaigns

When an automatic update is due, the campaign waits for active work to finish,
then starts a one-minute countdown. Once that countdown starts, new work does
not reset it or return the campaign to waiting. A 15-minute hard deadline starts
the update even if work remains, using the normal restart drain and
session-recovery path. Open terminal sessions do not defer the countdown or
apply. The Gateway restart ends these process-local PTYs, and terminal sessions
are not recovered afterward.

An admin can use **Hold 1 h** once to postpone the campaign and shift its hard
deadline, or choose **Update now** from the sidebar update card or
**Settings → Updates**. For a `dev` git install, the campaign installs the exact
commit it announced. The displayed list previews up to five commits from that
fixed target and does not move if upstream `main` advances during the countdown.

Every failed apply ends the campaign so the UI does not remain on
**Updating…**. Failures after a managed-service handoff starts are also recorded
in the restart sentinel and surface after the Gateway returns.

`update.checkOnStart: false` disables all automatic update checks, feature
statistics, and update notices, even when `update.auto.enabled` is `true`.
`OPENCLAW_NO_AUTO_UPDATE=1` also disables automatic checks and applies.
External-supervisor mode disables automatic applies; startup update hints can
still run unless `update.checkOnStart` is also disabled. See
[Usage telemetry and update checks](/gateway/telemetry) for the information
sent by the daily check and optional anonymous feature statistics.

Disabling checks also cancels unfinished discovery and its campaign; a late
response from the previous settings cannot start an update afterward.

Gateway shutdown or replacement cancels unfinished update discovery and waits
for its Git processes and temporary preflight cleanup to settle. Updates already
handed off to the managed service updater remain under that separate updater’s
control.

The gateway also logs an update hint on startup (disable with
`update.checkOnStart: false`). Stored extended-stable selections use this
read-only hint path and the existing 24-hour hint interval, but never invoke
automatic installation, handoff, restart, stable delay/jitter, or beta polling.

Package-manager updates requested through the live Gateway control-plane
(`update.run`) do not replace the package tree inside the running Gateway
process. On managed service installs, the Gateway starts a detached handoff
that runs the normal `openclaw update --yes --json` CLI path. The old Gateway
keeps serving through candidate validation; the helper parks it only for
activation. The CLI swaps the package, applies required migrations, refreshes
service metadata, starts and verifies the Gateway, and recovers an
installed-but-unloaded macOS LaunchAgent when possible. If the Gateway cannot
make that handoff safely,
`update.run` reports a safe shell command instead of running the package
manager in-process.

When `update.run` has a routable chat session, the Gateway sends an update
acknowledgement before starting the handoff or in-process update. It waits up to
10 seconds for delivery; a failed chat send does not block the update. The RPC
response includes `ackDelivered` so clients can distinguish a delivered
acknowledgement from an unavailable or failed route. Restart, verification,
and completion notices follow the durable run state, as described in
[From chat](/install/updating#from-chat).

The Control UI includes its active session in the update request. Any run with an
existing internal/webchat origin session receives its report in that session's
transcript, whether or not the caller supplied a delivery context. Sessions with
an external delivery route receive a durable notice in that channel. Updates
without an originating session send their notice through the system main
session's external route when available. Otherwise, recovery keeps the
system-session wake without an outbound chat notice. Session-less recovery never
resumes a supplied continuation as another chat's turn.

The Control UI sidebar update card shows **Update Gateway** when it will start
this `update.run` flow directly. This covers browser-hosted Control UI, remote
Gateways, and manually managed local Gateways.

Manual updates started from the Control UI always ask first. The first click on
the sidebar update card or on **Settings → Updates → Update now** opens a
confirmation naming the target, the installed and available versions when known,
and the restart impact; it sends nothing until you choose **Update and restart**.
Cancel, Escape, and dismissing the dialog leave the Gateway untouched. Automatic
campaigns, the CLI, and `update.run` API clients are unaffected.

After confirmation, the dialog shows the live phase list, step details, and
verification results. It stays open during restart and resumes from the Gateway's
run record after reconnecting. Success and failure both leave a final report in
the dialog and **Settings → Updates**. See [Control UI updates](/web/control-ui/settings#updates).

In the signed macOS app, a local app-owned Gateway changes that card to
**Update Mac app + Gateway**. Sparkle updates the app first; after relaunch, the
app runs `openclaw update --tag <app-version> --json`, restarts its Gateway,
and verifies health in a setup-style progress window. The window appears only
when that managed Gateway needs update, repair, or installation; app-only updates relaunch
directly into the app. Failure details stay visible with Retry, [Update guide](/install/updating), and
[Discord](https://discord.gg/clawd) actions. The app never uses this coordinated
path for a remote or externally managed Gateway, never downgrades a newer
Gateway, and never overrides an `extended-stable` channel pin.

When the update succeeds, the app queues a one-time welcome event for the most
recent top-level direct session with a real user/channel interaction. Cron runs,
heartbeats, and background-only session updates do not move that selection. In
remote mode, the app updates only its local Mac node runtime and sends the event
only when the connected remote Gateway is at least as new as the app.

## After updating

Successful managed `openclaw update` runs already restart and verify the Gateway.
Use these steps after a manual installation or when checking a reported problem.

<Steps>

### Run doctor

```bash
openclaw doctor
```

Migrates config, audits DM policies, and checks gateway health. Doctor also compares active official plugins with the OpenClaw package the managed service will load after restart. Resolve any plugin restart-readiness warning before continuing. Details: [Doctor](/gateway/doctor)

If you use the unpacked Chrome extension, also run `openclaw browser doctor --browser-profile chrome`.
For a version-mismatch warning, reload the extension from `chrome://extensions`;
fully restart Chrome if the warning remains.

### Restart the gateway

```bash
openclaw gateway restart
```

### Verify

```bash
openclaw health
```

</Steps>

<a id="rollback" />
<a id="roll-back-a-package-install" />
<a id="roll-back-a-source-checkout" />
<a id="downgrading-across-the-session-sqlite-migration" />
<a id="restore-state-only-when-necessary" />
<a id="verify-the-rollback" />

## Downgrade

Verify the upgrade and your session history before retiring recovery originals
with `openclaw update cleanup`. Downgrading the package does not reverse config
or database migrations. Once state has migrated beyond the older release's
supported format, the supported recovery is to restore a verified pre-update
backup with its matching OpenClaw release.

Prefer `openclaw update` for upgrades and recovery. It validates the target,
runs required Doctor migrations, and verifies the activated Gateway. A raw
`npm i -g` replacement does not retain the previous package or run this recovery
workflow; use `openclaw update` or [create a backup first](#before-updating-create-a-verified-backup).

The updater retains the previous package during activation and keeps it when
failed recovery cannot prove a working installation. Migration recovery originals
remain until explicit [update cleanup](/cli/update#update-cleanup). These are
separate recovery mechanisms: cleanup does not manage package or Git runtime
backups, and retained migration originals are not a full pre-update backup.
Preserve every recovery location named in the update report until you have
verified the installation.

For a target that can read the current state, preview and use the managed
rollback path:

```bash
openclaw update --tag <known-good-version> --dry-run
openclaw update --tag <known-good-version>
```

The updater checks compatibility and asks for downgrade confirmation. If the
saved channel is `extended-stable`, add `--channel stable` for an exact one-off
tag. Supported targets finalize the config writer stamp, restart the service,
and verify the running version. Older targets may lack that finalization or
migration-continuation contract; follow the printed recovery guidance if
activation is refused. Do not bypass a newer-schema or newer-config refusal.

When the update report identifies retained originals, use the corresponding
[Doctor recovery command](/cli/doctor#session-sqlite-migration) before cleanup.
Restoring legacy session artifacts does not reverse SQLite schemas or restore
sessions created only in SQLite. If the older release cannot read the current
state, restore the pre-update backup using [Restore a full archive](/install/backups#restore-a-full-archive).
Keep the Gateway and other writers stopped throughout activation of the restored
state, and preserve the current state separately first: restoration discards
changes made since the backup. Reinstall the matching package through the
installation's package manager; a backup archive does not contain the package.

A complete recovery point must cover these together:

- The matching OpenClaw package version or source revision and built runtime.
- `openclaw.json`, including `meta.lastTouchedVersion`.
- `state/openclaw.sqlite` and every `agents/<id>/agent/openclaw-agent.sqlite`,
  including databases at configured paths outside the default layout.
- The workspaces, credentials, and retained originals needed by that installation.

Use `openclaw backup` for a verified, WAL-aware archive. Never copy only the
main `.sqlite` file from a live WAL database: committed data can still be in
`-wal`. Restore the verified consolidated database offline; do not mix it with
`-wal` or `-shm` files from another database generation. See [Backup](/cli/backup)
for archive coverage and omissions.

Versions with the [startup preflight repair](https://github.com/openclaw/openclaw/pull/141451)
leave configuration, databases, and migration inputs unchanged when preflight
refuses startup. A successful start can migrate state forward. An older binary may then refuse
both the database schema and the config's `meta.lastTouchedVersion`; changing
either version marker does not undo the migration. Repair the installed version
with `openclaw doctor --fix --non-interactive`, or use the backup recovery above.

During recovery, prevent an enabled [auto-updater](#auto-updater) from immediately
reapplying the newer release by setting `OPENCLAW_NO_AUTO_UPDATE=1` in the Gateway
environment.

After recovery, verify the running installation before cleanup:

```bash
openclaw --version
openclaw health
openclaw gateway status --deep --json
openclaw doctor --lint --json
openclaw update cleanup --dry-run
```

### Automatic schema-neutral rollback

If a newly activated package fails verification, `openclaw update` compares the
shared and affected per-agent SQLite `user_version` values with their
pre-activation values and checks that the config file still matches the content
reported by the candidate’s activation Doctor writer.
Databases first created during activation or verification are
schema-neutral when their version matches the candidate's supported version for
that database kind. A changed schema version or missing pre-existing database,
or a new database at a foreign version, still blocks rollback. Before restoring
code, the updater also checks that the previous package supports any new database;
unknown or incompatible support refuses rollback with `rollback-state-unverified`.
When both checks pass and the retained previous package was verified before the
update, it stops the candidate and restores the previous generation: package,
command shim, service definition, and exact pre-activation config bytes, including
the previous writer stamp. Config replacements use owner-only permissions (`0600`);
unchanged config needs no write. Owned, writable
service metadata is refreshed; protected service definitions are preserved.
The CLI verifies the restarted previous Gateway's service health, version/build
identity, plugins, channels, and `/readyz` again. Update verification does not use
model inference: the managed service must be running and own its port, and the
Gateway hello handshake must match the expected artifact.

The candidate’s own Doctor migrations in the main config file do not block rollback, including on
a fresh install’s first update. The updater retains the config immediately before
Doctor and verifies that Doctor consumed those captured bytes before making changes.
It also checks the current file against the output hash reported by Doctor’s writer.
Rollback restores the original bytes only while both hashes match. Restoration
holds the normal config writer lock and rechecks the hash after acquiring it. Operator edits
made after activation block restoration, including edits before Doctor reads the
config and between Doctor’s last write and the updater’s capture. Separate `$include` files must retain
their pre-activation configuration content; they are not restored by the root-file
snapshot. The existing intentional-recovery
allowance applies only to service commands, so the older-binary guard does not
block recovery; it is never saved in config or the service environment.

Successful recovery leaves the previous Gateway running and finishes the run as
`rolled-back`, with `after.version` set to the previous version and downtime
measured from service stop through verified recovery. The headline is
`↩️ OpenClaw update rolled back to <previous>: <reason>`, retaining the original
verification failure. The command still exits nonzero; recovery does not turn a
rejected candidate into a successful update.

Use `openclaw update status` for the recorded reason and `openclaw triage` to
diagnose a failed check. Recovery guidance reports whether the Gateway is running
or stopped from the latest service observation, even when a running candidate did
not pass verification. A restored Gateway must pass its own verification checks
before the run can finish as `rolled-back`.
Automatic triage never follows a verified rollback; it runs only when the update
ends failed.

If the config file changed after the activation Doctor pass or the databases are
not schema-neutral, rollback is refused with
`state-migrated-no-rollback`. For config edits, the next action names the file
whose changes blocked restoration. The updater attempts
[bounded unattended repair](/install/updating#unattended-repair-on-your-own-inference)
on the installed candidate, preserving migrated state. The same repair slot can
run if rollback itself fails, targeting the previous release if its package was
already restored. If repair cannot pass verification, the update
fails with the original reason and recorded repair attempts. Use `openclaw triage`
or the printed repair command before considering an older version.
Automatic rollback restores code and the captured config, not a full state snapshot.
The candidate's temporary migration-rehearsal snapshots are removed after
validation and do not replace your backup.
If the schema comparison cannot be completed, automatic rollback is refused
(`rollback-state-unverified`). The freshly installed candidate owns final
verification and reporting after migration,
preserving the same run ID and recorded activation steps.

For pnpm and Bun, changes to sibling global packages after staging refuse automatic rollback (`rollback-project-changed`) without restoring the shared project; keep a reachable candidate installed, otherwise keep the Gateway stopped and follow the report’s repair command.
A refusal before the live swap restarts the unchanged Gateway and preserves the sibling changes.

### Before updating: create a verified backup

`openclaw update` preserves an automatic pre-update config copy, but it does not
create a full state recovery point. Before a significant update, create one
explicitly:

```bash
mkdir -p ~/Backups/openclaw
openclaw backup create --output ~/Backups/openclaw --verify
```

The archive manifest records the OpenClaw version and the source paths included
in the backup. The archive can contain credentials, auth profiles, and channel
state, so store it with owner-only permissions and the same protection as the
live state directory. See [Backup](/cli/backup) for included and intentionally
omitted files.

For a byte-for-byte recovery point that includes volatile artifacts omitted by
the portable archive, stop the Gateway and use a filesystem, volume, or VM
snapshot provided by your platform. This matters for older file-backed installs:
the portable archive omits matching JSONL transcripts and logs even when they
are no longer being written.

When migrating large legacy histories, leave room for the original files, a
temporary SQLite spool, and the destination database/WAL simultaneously. SQLite
can be larger than the original JSONL; streaming import does not imply a fixed
RAM requirement or migration time. Check free space on both the system temporary
volume and the state volume. See [Session SQLite migration](/cli/doctor#session-sqlite-migration)
for staging and memory details.

## If you are stuck

Run `openclaw triage` in a terminal on the Gateway host, using the printed
installation-specific command or keeping the same profile and state/config
overrides. It opens the first directly launchable coding agent in this order:
Claude Code, Codex, OpenCode, then Pi. The agent receives local diagnostics and
any recorded failed-update outcome so it can repair the installation and verify
Gateway health, using its normal authentication, sandbox, and approval settings.
Use `openclaw triage --agent codex` to select a particular agent.

Failed interactive updates open triage automatically after updater cleanup and
pass the captured failure to the agent before fresh diagnostics can delay the
handoff. JSON, `--yes`, and non-interactive update invocations collect diagnostics
and print handoff commands without starting an agent. For diagnostic collection
alone, use `openclaw triage --non-interactive`; add `--update-result <path>` to
include a saved update-failure artifact. See [Triage](/cli/triage) for command
formatting and installation targeting.

Triage keeps the failed update's report intact. An update started during repair
creates its own history entry. After package replacement, restart commands run
from the updated installation. A restart accepted by the service owner can still
fail readiness checks; inspect `openclaw gateway status --deep` before retrying.

Keep a stopped, unverified Gateway stopped and preserve migrated state during
repair. A reachable candidate retained after a schema migration can continue
serving while you diagnose it.
The failed update retains its nonzero exit code even if the agent repairs it.

- For `openclaw update --channel dev` on source checkouts, the updater auto-bootstraps `pnpm` when needed. If you see a pnpm/corepack bootstrap error, install `pnpm` manually (or re-enable `corepack`) and rerun the update.
- Check: [Troubleshooting](/gateway/troubleshooting)
- Ask in Discord: [https://discord.gg/clawd](https://discord.gg/clawd)

### Unattended repair on your own inference

The updater enters the optional `repairing` phase when candidate Doctor lint,
config validation, plugin resolution, or canary startup fails. It repairs the
staged candidate and reruns the failed check while the old Gateway keeps serving.
Only a passing validation allows activation; otherwise the update fails and
discards the candidate without stopping the service.
Before activation, repair shares one disposable rehearsal state/config snapshot
across its turns and validation, then independently validates surviving candidate
changes before activation; configuration changes are never promoted and
stop as `repair-requires-config-change`, naming the changed top-level keys for
the operator to inspect with `openclaw triage` or apply with `openclaw doctor --fix`.

Git source updates keep the selected source revision. Repair may restore
dependencies, generated runtime files, or state, but a candidate with changed
tracked source fails before the Gateway stops; fix the source revision before retrying.

After activation, the updater can also enter `repairing` when verification fails
and config edits after the activation Doctor pass or a schema migration prevent rollback, or
when rollback itself fails. This repair targets the runtime that remains
installed and preserves migrated state. After each turn, the updater starts or
restarts a stopped or unhealthy service once, then reruns the service, version,
and `/readyz` checks. A verified candidate repair allows the run to succeed. If
rollback already restored the previous release, successful repair finishes
`rolled-back` and the command still exits nonzero. Otherwise the original failure
and repair summary remain in the final report.

During finalization on Windows, the updater restores Scheduled Task autostart
for activation and suspends it again if final verification fails. This ownership
survives the fresh-process handoff required after a state migration. See
[Failed update recovery](/gateway/restart-recovery#recovery-after-a-failed-update).

Repair uses the same embedded loop as `openclaw triage --run`, without a terminal
or an external coding-agent CLI. It uses the system-agent owner's default model,
its `model.fallbacks`, then other configured agents' authenticated routes,
skipping models without tool support and routes without usable authentication.
It reports unavailable inference instead of waiting for a login or approval
prompt. Operator-owned updates and explicit repair requests
replace interactive exec approval with a prompt-free run scoped to the installation
or staged candidate root (`fs.workspaceOnly: true`), preserving safe-bin and tool
allowlists and refusing explicit exec or repair-tool denies with `exec-denied-by-policy`
and an `openclaw triage` external handoff.

Chat-requested updates recheck the requester's command ownership before repair
effects and service activation. If configuration or plugin loading fails, the
update stops and records the load error. Fix that error before retrying; only a
successful policy check can report that the requester is no longer an owner.

The default limits are three turns, ten minutes total, five minutes per turn,
and 40 tool calls per turn. The updater supplies a validation check before the
first turn and after each attempt. Repair stops when validation succeeds, a
budget is reached, or a turn fails to improve the result; a regression is
reported as unrepaired. The model's `REPAIR_RESULT` summary does not replace
these checks.

The agent may diagnose and repair the target install or staged candidate and
its OpenClaw state, including running Doctor lint, `doctor --fix`, and health
checks. Its repair contract forbids changing credentials or auth stores,
deleting state or databases, package-manager writes outside the target root,
and service or Gateway lifecycle commands. The orchestrator retains control of
activation, restart, and rollback. The repair loop does not take snapshots or undo
changes. Attempts appear live in the Control UI's phase and step details and in
`openclaw update status`; the final report includes their summaries. JSON run
records retain the `repair` attempt list. Repairing stays hidden in the Control
UI when the run never entered that phase.

For an explicit repair using configured inference, run `openclaw triage --run`
in a terminal on the Gateway host. Interactive triage checks Doctor lint, runs
up to one embedded repair turn with time and tool-call limits, and checks Doctor
again. See [Triage](/cli/triage#installation-target-and-embedded-handoff) for the
repair contract, installation targeting, and validation results.

## Related

- [Install overview](/install): all installation methods.
- [Doctor](/gateway/doctor): health checks after updates.
- [Migrating](/install/migrating): major version migration guides.
