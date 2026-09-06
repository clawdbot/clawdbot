---
name: update-team-server
description: "Update the operator-configured Team server unattended through its canonical deployment owner; verify serving code, supported migrations, session continuity, and recovery without duplicating the hourly scheduler."
---

# Update Team server

Keep Team current automatically. Routine deployments, controlled interruptions, and supported upstream-owned migrations are already authorized for this workflow; do not request another routine approval. This is a repository operator skill, not a bundled runtime skill or a deployer implementation.

## Resolve the owner

Read the operator-provided private deployment runbook before acting. Resolve and verify the host, access, canonical deployment command, service, hourly timer, lock, journal, release pointers, backup destination, and recovery contract from that configuration. Never guess access or copy private connection details, credentials, state, or receipts into public output.

Verify installed owner capabilities against their current source; this skill does not install a migration phase. Missing access or a safe capability is a concrete blocker: repair through the existing owner within authority, or report what remains unavailable. Never invent success or bypass a denial. Keep source/PR repairs in separate worktrees; do not delay an otherwise safe prepared update for them.

## Deploy through one owner

1. Keep the existing hourly timer enabled and active as the sole cadence. Never pause it for proof or create another scheduler/deployer. Inspect the active invocation, lock, and journal; observe an active owner instead of duplicating it. Resolve retained journals through canonical recovery before requesting a new deployment. Do not clear failed status to manufacture idleness.
2. When idle, request the configured updater service using its documented command. The canonical owner alone controls deployment, Gateway lifecycle, rollback, and recovery. Do not substitute direct restarts, partial build overlays, or an in-place source build.
3. Keep the incumbent serving while the owner freezes official upstream `main`, builds the complete release off-path, validates it, and seals it. Check runtime-user disk/quota headroom, not just host free space.
4. Use the owner's genuine, unexpired maintenance authority bound to the incumbent generation. Allow controlled interruption after its configured drain budget; active agents and PTYs are not indefinite vetoes. Pending terminal persistence still blocks interruption. Never relabel DRAINING as READY. Bound shutdown, migration, startup, and verification separately; the drain budget is not total downtime.

## Cross schemas safely

Before stopping writers, identify the exact incumbent/candidate reader contracts, supported Doctor migration, and durable phase/recovery owner. Package versions and numeric schema ceilings alone are insufficient. Require the owner to prove these gates before mutation:

- A complete database inventory, including configured external agent roots and registered stores; verified WAL-aware backups covering that inventory and protected state. Check backup omissions and sanitization: a portable export is not necessarily a full recovery image. Doctor does not create the backup.
- The original pre-cutover session-preservation witness, retained through recovery; a filtered session-list page, empty baseline, or fresh-current witness cannot prove historical continuity.
- Stopped writers and maintenance authority fencing new claims. Only the candidate's supported upstream Doctor flow performs migration; assess its full repair scope, not a presumed single-table operation.
- Per-database integrity, physical schema, `PRAGMA user_version`, `schema_meta`, ownership, registry, and candidate runtime-readiness checks before and after migration. One successful database or healthy HTTP cannot prove all-agent readiness.

Transactions may commit per database, leaving mixed schemas or stale registry metadata after interruption. Once any database advances beyond the old reader's contract, never automatically restart that old reader, even when candidate verification fails. Preserve the journal and backups; continue through the canonical forward-recovery owner until every store is ready. Before mutation, a safe refusal leaves the incumbent serving. No custom schema SQL, version-marker edits, downgrade, or wholesale backup restoration.

Read [database contracts](https://docs.openclaw.ai/reference/database-schemas) and [backup semantics](https://docs.openclaw.ai/cli/backup); their general recovery examples do not expand this workflow's authority.

## Verify and recover

Require the exact invocation's successful deployment receipt, matching new serving/build SHA, stable process generation, RPC, health/startup/readiness, configured channels, unchanged protected policy/identities, and original-witness verification. Reuse the owner's real model-marker receipt; do not send duplicate marker turns. Require journal resolution and an active hourly timer. Supervisor success, a skip, healthy old code, or same-release recovery is not a new deployment.

Bracket live checks with generation and owner-phase checks; never run ordinary RPCs across an active fence or pause the timer for a quiet proof window. Preserve failed outcomes and unresolved journals; do not delete evidence or retry blindly. Use only the owner's compatibility-checked recovery and cleanup, preserving referenced releases, backups, ordinary sessions, unrelated state, and dirty workspaces.

Let [Gateway restart recovery](https://docs.openclaw.ai/gateway/restart-recovery) resume eligible work; do not duplicate it manually. PTYs end, unsaved work may be lost, and recovery budgets/quarantine remain: neither universal recovery nor exactly-once execution is promised.

Report the invocation outcome, observed serving SHA, migration/readiness and continuity proof, recovery phase, and any exact blocker privately. No credential rotation, release publication, security-policy weakening, or unrelated mutations are authorized.
