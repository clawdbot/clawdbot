Closes #135299

## What Problem This Solves

Resolves an issue where users trying to repair a damaged OpenClaw installation using `openclaw doctor --fix` would encounter crash loops blocking recovery. Specifically:
1. Stopped systemd services were falsely flagged with `Gateway service ownership or shutdown could not be verified`.
2. Valid database tables were flagged as corrupt (`column-definition-drift`) due to harmless whitespace formatting differences in `sqlite_schema`.

*(Note: The legacy workspace migration conflict issue originally part of this report has already been resolved in main via commit 6c98e612).*

## Why This Change Was Made

The fixes allow the doctor tool to proceed gracefully:
- Adjusted `assertDoctorMaintenanceInspection` to immediately return if the target service is already verified `offline`, ignoring irrelevant ownership/mutation block checks.
- Altered `sqlite-schema-contract` validation to use `normalizeSqlWhitespace` on both expected and actual column definitions.

## User Impact

Users with damaged gateways or drifting plugin schema structures can now successfully run `openclaw doctor --fix` to completely recover and restart their services without getting stuck in a validation loop.

## Evidence

Unit tests pass locally.

### Real Behavior Proof

**1. Offline-Service Scenario**
Before:
```text
$ openclaw doctor --fix
Doctor could not enter maintenance. Stop the Gateway through its service owner before retrying.
Error: Gateway service ownership or shutdown could not be verified.
```
After:
```text
$ openclaw doctor --fix
Service is offline. Proceeding with maintenance...
OpenClaw plugin verification passed.
Gateway version: 2026.8.2
Runtime: stopped (pid -, state inactive)
Connectivity probe: ok
```

**2. Schema-Whitespace Scenario**
Before (with `consumed_event_id TEXT ` vs `consumed_event_id TEXT`):
```text
$ openclaw doctor --fix
- Corrupt schema detected: column-definition-drift on table.consumed_event_id
```
After:
```text
$ openclaw doctor --fix
Schema verification passed. (whitespace normalized)
```
