---
summary: "Recover from failed OpenClaw updates in the Control UI or CLI"
read_when:
  - An OpenClaw update failed
  - The Gateway did not report a final update result
title: "Update troubleshooting"
---

Failed updates enter built-in triage after update recovery settles. In an
interactive terminal, OpenClaw collects sanitized diagnostics and opens the
[triage agent picker](/cli/triage). With `--yes`, `--json`, or no interactive
terminal, it prepares diagnostics and handoff commands without launching an
agent. The original update failure and exit status remain authoritative;
diagnostics do not turn a failed update into a successful one.

In the Control UI, a failed attempt opens **Ask OpenClaw** with its recorded
details and asks it to investigate before retrying. A lost connection or
verification timeout is presented as an unknown outcome. The tab remembers the
latest 32 investigated attempt identities, scoped to their Gateway and profile.
Status checks, switching between those scopes, and reloading the same tab do not
automatically send those investigations again. If the browser cannot read or
save that history, the failure details remain visible without an automatic
diagnostic request. Ask OpenClaw manually or run `openclaw triage` on the host.
If the Gateway or agent is
unavailable, use `openclaw triage` on the Gateway host. Automatic diagnosis keeps
your unsent composer draft, including when its conversation session must restart.

**Control UI → Settings → Updates** keeps the latest recorded attempt visible,
including its time, before/after identities, reason code, failing step, and
bounded diagnostic detail. A version or revision verification failure stays
visible when a status check rereads the same attempt. An unknown verification
outcome resolves when the expected version or revision arrives, or when the
same attempt reports its final failure or cancellation. A newer recorded attempt
can also replace it. Intentional cancellations, already-current installs, and
updates still in progress do not start triage.

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
- `preflight-insufficient-space`: free space on the filesystems containing
  preflight staging (the checkout's `.artifacts` area on POSIX) and the
  package-manager store, then retry. The updater stops on
  confirmed ENOSPC instead of trying older commits; it does not delete shared
  package-manager stores. See [Git checkout flow](/cli/update#git-checkout-flow)
  for staging placement and the older published-updater limitation.
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
openclaw triage
```

Use `openclaw update --dry-run` to preview a new attempt. If a package update
failed after installation began, follow the installer recovery steps in
[Updating](/install/updating#alternative-re-run-the-installer).

If the installed CLI is damaged or the filesystem cannot write diagnostics,
automatic triage reports that failure and preserves the original update error.
Repair the installed command, then run `openclaw triage`. Managed updates retain
their detached helper log even when the Gateway cannot start; the recorded
outcome points to the available diagnostics or the failed collection attempt.
Restart notices summarize the diagnostic outcome. Saved artifact paths and exact,
installation-specific recovery commands remain in the host command output or
managed update helper log rather than the notice sent to an agent or channel.

If the updater crashes or is killed after the Gateway stops, the Gateway stays
stopped unless the updater completed and verified recovery. Inspect
`openclaw gateway status --deep`, repair the reported dependency or installation
failure, and rerun `openclaw update`. A failed Git dependency install restores
and rebuilds the previous runtime before allowing an automatic restart. Restarts
after verified recovery still check the installed configuration, service ownership,
and Gateway health.

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
