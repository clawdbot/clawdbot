---
summary: "Recover from failed OpenClaw updates in the Control UI or CLI"
read_when:
  - An OpenClaw update failed
  - The Gateway did not report a final update result
title: "Update troubleshooting"
---

Start in **Control UI → Settings → Updates**. The page reads the latest recorded
update attempt from the connected Gateway and shows its time, target, reason
code, failing step, and bounded diagnostic detail.

Control UI remediation uses typed product actions only. It leads with an
authenticated Gateway or native action when the connected UI has the required
capability and scope, preserves confirmations for disruptive operations, and
keeps terminal commands as secondary host-side fallbacks. It never parses
localized guidance or executes an arbitrary command string.

## Recover in the Control UI

1. Select **Check status** when the Gateway restarted, disconnected, or did not
   report a final result. This reads `update.status`; it does not start another
   update. Recovery controls stay disabled while the check is pending, and a
   rejected request appears as an error on the page.
2. Open **View details** and address the recorded failing step. Diagnostic text
   is bounded and redacted for display; use Gateway logs when more context is
   required.
3. Select **Retry update** only after the cause is resolved. The Control UI uses
   the normal confirmed update flow and states that running sessions are
   interrupted while the Gateway restarts.

The controls require a connected Gateway, support for the corresponding typed
Gateway method, and administrator scope. When those conditions are not met, use
the CLI fallback on the Gateway host.

## Reason codes

- `dirty`, `no-upstream`: repair the source checkout before retrying.
- `deps-install-failed`, `build-failed`, `ui-build-failed`: inspect the failing
  step, fix the dependency or build error, then retry.
- `global-install-failed`: retry after checking package-manager ownership and
  permissions. Re-run the installer if the package install is incomplete.
- `doctor-failed`: run Doctor on the Gateway host, resolve its findings, then
  retry.
- `restart-disabled`, `restart-unavailable`: restore a supported supervisor or
  enable Gateway restarts before retrying.
- `restart-unhealthy`, `restart-revision-mismatch`,
  `restart-revision-unavailable`: inspect Gateway service health and its install
  root before retrying.
- `managed-service-handoff-*`: check status first. If the handoff stopped, use
  the CLI on the Gateway host to preserve the full diagnostic output.

Unknown reason codes remain visible. Check the Gateway logs before retrying.

## CLI fallback

Run these commands on the Gateway host, not on the computer that merely has the
Control UI open:

```bash
openclaw update status --json
openclaw doctor --non-interactive
openclaw update
```

Use `openclaw update --dry-run` to preview a new attempt. If a package update
failed after installation began, follow the installer recovery steps in
[Updating](/install/updating#alternative-re-run-the-installer).

## Rollback boundary

Do not restore state as the first response to an update failure. First reinstall
known-good code while preserving current state. Restore a verified pre-update
state snapshot only when older code cannot read the current config or database.
See [Rollback](/install/updating#rollback).

## Support diagnostics

Collect the following without posting credentials, raw config, or unredacted
process output:

- OpenClaw version and install type;
- update timestamp, target, phase, and reason code from Settings → Updates;
- the bounded failure detail shown by **View details**;
- `openclaw update status --json`;
- `openclaw gateway status --deep --json`;
- relevant redacted Gateway log lines.
