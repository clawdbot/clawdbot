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

Detects your install type (npm, pnpm, Bun, or git), fetches the latest version, runs `openclaw doctor`, and restarts a managed Gateway service.

```bash
openclaw update
```

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

`--channel beta` prefers the beta npm dist-tag, but falls back to stable/latest
when the beta tag is missing or its version is older than the latest stable
release. Use `--tag beta` for a one-off package update pinned to the raw npm
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

`--channel dev` gives a persistent moving GitHub `main` checkout. Package
installs reject the `--tag main` shorthand because the workspace checkout is
not a self-contained package artifact. Use `openclaw update --channel dev` to
switch to the supported checkout and build flow. Other explicit package specs
keep their package-manager behavior.

After a beta core update, eligible official npm plugins follow the exact installed
beta version, including one-off `--tag` updates from a stable installation.
For managed plugins, a missing beta release is a warning, not a failure: the
core update can still succeed while a plugin falls back to its recorded
default/latest release.

See [Release channels](/install/development-channels) for channel semantics.

## Retire update recovery data

Once you have verified the update and your conversations, preview retained
migration originals:

```bash
openclaw update cleanup --dry-run
```

Use the same profile and state/config overrides as the update, and check the
state directory printed in the report. The metadata-only preview can run while
the Gateway is active. To apply, stop that Gateway yourself, wait for other
SQLite maintenance to finish, then run `openclaw update cleanup`. Cleanup never
stops or restarts the Gateway. Confirmation defaults to **No**; automation must
explicitly pass `--yes`, including when using `--json`.

Cleanup permanently gives up rollback to eligible originals, including repaired
branches and old provider metadata. Current SQLite history, operator backups,
and protected or unknown artifacts remain. It is not a substitute for a
[pre-update backup](#before-updating-create-a-verified-backup). See
[Update cleanup](/cli/update#update-cleanup) for eligibility, JSON output, and
resuming interrupted deletion.

## Switch between npm and git installs

Installer-driven switches verify the replacement before the working owner is retired. Source wrappers are published atomically; same-path npm shim transitions use an identity-checked backup that is restored on failure, so a failed candidate leaves the previous command runnable. The `openclaw update` command prints its final success result only after post-core convergence and requested restart health checks succeed.

If a CLI update fails after installing a verified replacement, recovery uses the
newly installed CLI to restart the Gateway it stopped, preserving the managed
service definition. A failure preparing the staging directory, before package
hooks can run, can recover the verified original installation. Package-manager
and lifecycle commands can change configuration or state even in a temporary
prefix. After they start, a rejected staged candidate or a fully restored package
and launcher no longer authorizes automatic restart. Only complete candidate
verification, including the required nonblocking Doctor result, permits activation.
This deliberately limits automatic recovery after hooks; file rollback does not
roll back state. Incomplete file rollback retains its backups for inspection.
If an older target does not support preserving the service definition, automatic
recovery stops and reports the error without retrying with weaker options. Repair
the reported failure, rerun `openclaw update`, and check `openclaw gateway status --deep`.
See [Failed update recovery](/gateway/restart-recovery#recovery-after-a-failed-update).

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

Dev updates build the complete runtime, including plugins and the Control UI,
without generating TypeScript declarations. Preflight still validates the
candidate, and the final checkout is rebuilt after checkout or rebase. Ordinary
`pnpm build` and package builds continue to generate declarations.

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
Node version during `preinstall`; only then does OpenClaw verify the packaged
`dist` inventory and swap the clean package tree into the real global prefix. A
packed completion guard is omitted from the expected inventory and removed only
after `preinstall` succeeds, so skipped lifecycle scripts also fail before the
swap. The updater probes the owning npm before mutation. On npm 11.15 and
earlier it omits the unsupported lifecycle-policy flag. On npm 12 and npm
11.16+, it approves only the candidate OpenClaw lifecycle; transitive
dependency scripts remain unapproved.
This avoids npm overlaying a new package onto stale files from the old one. If
the install command fails, OpenClaw retries once with `--omit=optional`, which
helps hosts where native optional dependencies cannot compile.

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

### Advanced npm install topics

<AccordionGroup>
  <Accordion title="Read-only package tree">
    OpenClaw treats packaged global installs as read-only at runtime, even when the global package directory is writable by the current user. Plugin package installs live in OpenClaw-owned npm/git roots under the user config directory, and Gateway startup does not mutate the OpenClaw package tree.

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

The gateway also logs an update hint on startup (disable with
`update.checkOnStart: false`). Stored extended-stable selections use this
read-only hint path and the existing 24-hour hint interval, but never invoke
automatic installation, handoff, restart, stable delay/jitter, or beta polling.

Package-manager updates requested through the live Gateway control-plane
(`update.run`) do not replace the package tree inside the running Gateway
process. On managed service installs, the Gateway starts a detached handoff,
exits, and lets the normal `openclaw update --yes --json` CLI path stop the
service, replace the package, refresh service metadata, restart, verify the
Gateway version and reachability, and recover an installed-but-unloaded macOS
LaunchAgent when possible. If the Gateway cannot make that handoff safely,
`update.run` reports a safe shell command instead of running the package
manager in-process.

The Control UI sidebar update card shows **Update Gateway** when it will start
this `update.run` flow directly. This covers browser-hosted Control UI, remote
Gateways, and manually managed local Gateways.

Manual updates started from the Control UI always ask first. The first click on
the sidebar update card or on **Settings → Updates → Update now** opens a
confirmation naming the target, the installed and available versions when known,
and the restart impact; it sends nothing until you choose **Update and restart**.
Cancel, Escape, and dismissing the dialog leave the Gateway untouched. Automatic
campaigns, the CLI, and `update.run` API clients are unaffected.

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

<Steps>

### Run doctor

```bash
openclaw doctor
```

Migrates config, audits DM policies, and checks gateway health. Details: [Doctor](/gateway/doctor)

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

## Rollback

Rollback has two layers:

1. Reinstall older OpenClaw code while keeping the current state.
2. Restore pre-update state only when the older code cannot use a migrated
   config or database.

Start with a code-only rollback. Restoring state discards changes made after
the backup.

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

### Roll back a package install

List published versions, then preview and install the known-good version:

```bash
npm view openclaw versions --json
openclaw update --tag <known-good-version> --dry-run
openclaw update --tag <known-good-version>
```

`openclaw update --tag` is preferred over a direct package-manager install. It
detects the downgrade, asks for confirmation, runs managed plugin convergence
and compatibility checks against the installed target, refreshes service
metadata, restarts the Gateway, and verifies the running version. If the stored
channel is `extended-stable`, use
`--channel stable --tag <known-good-version>` because exact one-off tags cannot
be combined with the `extended-stable` selector.

Downgrade finalization runs in the installed target when it supports the update
handoff. After successful validation, current targets save the configuration with
their own version, including when a one-off `--tag` leaves the channel unchanged.
This allows later Gateway restarts without an older-binary override. Older targets
that lack this finalization behavior can still refuse service activation because
the configuration records a newer writer; follow the reported recovery guidance.

Package updates stage and verify the candidate before activation. If the
filesystem swap or command-shim replacement fails, OpenClaw restores the old
package automatically. After a successful swap, a later Gateway health failure
reports the previous version and manual rollback instructions instead of
automatically replacing the package again.

If the CLI update path is unavailable, use the same package manager and install
scope that own the current Gateway:

The npm command below is for npm 12 or npm 11.16+. On npm 11.15 and earlier,
omit `--allow-scripts=openclaw`.

```bash
openclaw gateway stop
npm i -g openclaw@<known-good-version> --allow-scripts=openclaw
openclaw gateway install --force
openclaw gateway restart
```

For a pnpm-owned install, use
`pnpm add -g --allow-build=openclaw openclaw@<known-good-version>` instead. For
a Bun-owned install, use
`bun add -g --trust openclaw@<known-good-version>`; `--trust` allows OpenClaw's
lifecycle scripts. During incident recovery, prevent an enabled auto-updater
from immediately applying a newer release by setting
`OPENCLAW_NO_AUTO_UPDATE=1` in the Gateway environment.

### Roll back a source checkout

Use a clean checkout and select a known-good tag or commit. First verify that
your Corepack bootstrap supports that ref's pnpm pin as described in
[Source-checkout servers](#source-checkout-servers-reference-script):

```bash
git fetch --all --tags
git checkout --detach <known-good-tag-or-commit>
(
  pnpm_shims="$(mktemp -d "${TMPDIR:-/tmp}/openclaw-pnpm.XXXXXX")" || exit
  trap 'rm -rf "$pnpm_shims"' EXIT
  corepack enable --install-directory "$pnpm_shims" pnpm || exit
  export PATH="$pnpm_shims:$PATH"
  export NPM_CONFIG_WORKSPACE_DIR="$PWD" npm_config_workspace_dir="$PWD"
  export PNPM_CONFIG_LOCKFILE_DIR="$PWD" pnpm_config_lockfile_dir="$PWD"
  "$pnpm_shims/pnpm" install --frozen-lockfile || exit
  "$pnpm_shims/pnpm" build
) && openclaw gateway restart
```

To return to latest: `git checkout main && git pull`.

Before candidate Doctor starts, the updater can return a Git checkout to its
previous branch and SHA after dependency, build, or UI build failure, then verify
its rebuilt runtime. Once Doctor starts, failures retain the candidate: switching
code back cannot undo configuration or database migrations. Inspect the failed
checks before selecting an older commit, and verify that it supports your state.

### Downgrading across the session SQLite migration

Before starting an older file-backed OpenClaw release, use the current CLI to
restore archived legacy transcript artifacts:

```bash
openclaw gateway stop
openclaw doctor --session-sqlite restore --session-sqlite-all-agents
```

This does not delete SQLite data. Sessions created after the SQLite migration
exist only in SQLite and will not appear to the older runtime. See
[Downgrading after session SQLite migration](/cli/doctor#downgrading-after-session-sqlite-migration).

### Restore state only when necessary

If the older code cannot read a newer config or database schema, stop the
Gateway and restore the verified pre-update filesystem, volume, or VM snapshot.
Preserve the current state separately before restoring because this removes
changes made after the snapshot.

Restore a broad archive to a fresh staging directory with the current CLI:

```bash
openclaw backup restore <archive.tar.gz> --target <fresh-directory>
```

The command verifies the archive and its SQLite databases before extraction.
Activation remains an explicit offline step: stop the Gateway, move the
restored asset tree into place or point `OPENCLAW_STATE_DIR` at the restored
state asset, run `openclaw doctor`, then restart.

Treat a state restore as time travel. Ratcheting channel credentials, especially
WhatsApp, can desynchronize and require relinking. Approvals and
delivery/dedupe state roll back too, and plugin `node_modules` trees are not
archived. See [Restore a full archive](/install/backups#restore-a-full-archive)
for the complete activation and recovery sequence. `openclaw backup sqlite
restore` likewise writes a verified database to a fresh target; activating that
target remains an explicit offline operator step.

### Verify the rollback

```bash
openclaw --version
openclaw health
openclaw plugins list --json
openclaw gateway status --deep --json
openclaw doctor --lint --json
```

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

Keep an unverified Gateway stopped and preserve migrated state during repair.
The failed update retains its nonzero exit code even if the agent repairs it.

- For `openclaw update --channel dev` on source checkouts, the updater auto-bootstraps `pnpm` when needed. If you see a pnpm/corepack bootstrap error, install `pnpm` manually (or re-enable `corepack`) and rerun the update.
- Check: [Troubleshooting](/gateway/troubleshooting)
- Ask in Discord: [https://discord.gg/clawd](https://discord.gg/clawd)

## Related

- [Install overview](/install): all installation methods.
- [Doctor](/gateway/doctor): health checks after updates.
- [Migrating](/install/migrating): major version migration guides.
