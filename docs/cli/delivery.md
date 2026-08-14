---
summary: "Inspect, compact, purge, and safely resubmit retained delivery failures"
read_when:
  - A session or outbound delivery is dead-lettered
  - You need to remove sensitive failed-delivery detail without breaking idempotency
title: "Delivery failures"
---

# `openclaw delivery failures`

OpenClaw keeps failed outbound and session deliveries separate from the live
retry queue. The failure record can retain diagnostic or recovery detail for a
bounded time while its compact tombstone continues to own a stable delivery ID.

## List failure metadata

```bash
openclaw delivery failures list
openclaw delivery failures list --queue outbound-prepared-v1 --limit 50
openclaw delivery failures list --json
openclaw delivery failures list --exact-ids
```

The default limit is 100 and the hard maximum is 500. Output includes queue,
age, detail state, replay classification, fence policy, reason code, and retry
count. It never includes the message or payload, route, target, account,
session key, media path, or raw provider error.

Stable identifiers can contain routing identity, so human and JSON output use
a repeatable SHA-256 fingerprint by default. Pass `--exact-ids` only when an
exact identifier is needed for a follow-up command. Producer-bounded fences
similarly show an `idPrefixFingerprint` by default; `--exact-ids` also reveals
their exact producer prefix.

## Preview or apply retention cleanup

```bash
openclaw delivery failures purge
openclaw delivery failures purge --queue session
openclaw delivery failures purge --apply --yes
```

`purge` is a dry run by default. Apply mode deletes only expired diagnostic
rows whose policy has no fence, plus producer-bounded fences after their
authored age or producer-local count limit expires. Unexpired producer-bounded,
permanent, and owner-managed records keep their ownership tombstone while
sensitive detail is compacted. Dry-run and apply use the same bounded row set;
`--queue` and `--limit` scope both modes identically.

There is no option to force-break a fence. Without `--yes`, apply mode prompts
in an interactive terminal and refuses in JSON or other non-interactive use.

Logical compaction clears payload-bearing JSON, raw errors, and denormalized
session/channel/target/account metadata. SQLite can continue to reserve the
freed pages inside the database file. To return free pages to the filesystem,
stop the Gateway and run [`openclaw doctor --state-sqlite compact`](/cli/doctor#shared-state-sqlite-compaction).

## Safely resubmit one failure

```bash
openclaw delivery failures resubmit <id>
openclaw delivery failures resubmit <id> --queue session
openclaw delivery failures resubmit <id> --queue outbound-prepared-v1
openclaw delivery failures resubmit <id> --url ws://127.0.0.1:18789 --token <token>
```

`resubmit` requires a running, reachable Gateway and accepts the standard
Gateway client options: `--url`, `--token`, `--password`, and `--timeout`. The
Gateway performs the failed-to-pending transition and immediately schedules an
eligible session row in its live delivery runtime. If the runtime is still
starting or immediate scheduling fails after that durable transition, the
command reports that the row remains queued for startup recovery. A connection
or authentication failure occurs before the row changes.

Session and outbound queues have independent ID namespaces. If both own the
same ID, an unqualified resubmit is refused; rerun with the exact `--queue`
namespace shown by `openclaw delivery failures list --exact-ids`.

Success means **queued for recovery**, not delivered. Outbound rows are picked
up by the Gateway's bounded outbound recovery interval; the command does not
claim recipient delivery or start a second recovery loop.

Generic resubmit is intentionally narrow. Outbound rows require an explicit
pre-side-effect classification, a full canonical prepared payload, no durable
owner or stable fence, and every queue-owned media file. Session rows require
full detail, no owner, no delivery-start or settlement marker, and no ambiguity.
The Gateway's failed-to-pending transition is atomic, so a second invocation
does not submit the same row again.

Stable outbound IDs and claimed session producers retain failed ownership even
when successful sends would not keep a completion receipt.

OpenClaw refuses cross-queue ambiguity, compacted, ambiguous, owner-managed,
legacy-unknown, migration-namespace, missing-media, and stale-owner rows.
Subagent completion failures remain under their owner commands:

```bash
openclaw tasks retry <task-id>
openclaw tasks dismiss <task-id>
```

## Backups and retained bytes

Global SQLite snapshots remove every delivery queue row before publishing the
snapshot, including pending work, failed fences, and completion or idempotency
receipts. Restoring one is not an exactly-once delivery continuation; the
sanitized artifact deliberately chooses privacy and no-replay portability over
queue continuity. A normal state backup can contain the live database, so
protect it like other sensitive OpenClaw state. Logical retention and SQLite
file-size reclamation are separate operations; use the explicit doctor
compaction flow when physical reclamation is required.

## Related

- [`openclaw health`](/cli/health)
- [`openclaw doctor`](/cli/doctor)
- [Restart recovery](/gateway/restart-recovery)
