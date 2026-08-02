---
summary: "CLI reference for `openclaw commitments` (inspect and dismiss inferred follow-ups)"
read_when:
  - You want to inspect inferred follow-up commitments
  - You want to dismiss pending check-ins
  - You are auditing what heartbeat may deliver
title: "`openclaw commitments`"
---

Inspect and dismiss records left by the retired inferred commitments experiment.
OpenClaw no longer creates or delivers new commitments, but keeps the maintenance
command so upgrades can audit and clean up existing SQLite rows.

With no subcommand, `openclaw commitments` lists pending commitments.

## Usage

```bash
openclaw commitments [--all] [--agent <id>] [--status <status>] [--json]
openclaw commitments list [--all] [--agent <id>] [--status <status>] [--json]
openclaw commitments dismiss <id...> [--json]
```

## Options

- `--all`: show all statuses instead of only pending commitments.
- `--agent <id>`: filter to one agent id.
- `--status <status>`: filter by status. Values: `pending`, `sent`,
  `dismissed`, `snoozed`, or `expired`. Unknown values exit with an error.
  The `snoozed` status is reserved: no built-in flow currently snoozes a
  commitment; snoozed records can appear only when imported from legacy state.
- `--json`: output machine-readable JSON.

`dismiss` marks the given commitment ids as `dismissed`.

## Examples

List pending commitments:

```bash
openclaw commitments
```

List every stored commitment:

```bash
openclaw commitments --all
```

Filter to one agent:

```bash
openclaw commitments --agent main
```

Filter by status:

```bash
openclaw commitments --status dismissed
```

Dismiss one or more commitments:

```bash
openclaw commitments dismiss cm_abc123 cm_def456
```

Export as JSON:

```bash
openclaw commitments --all --json
```

## Output

Text output prints the commitment count, the shared SQLite database path, any active filters,
and one row per commitment:

- commitment id
- status
- kind (`event_check_in`, `deadline_check`, `care_check_in`, or `open_loop`)
- earliest due time
- scope (agent/channel/target)
- suggested check-in text

JSON output includes the count, the active status and agent filters, the
shared SQLite database path, and the full stored records.

### Dismissal output

`dismiss` changes only active `pending` or `snoozed` commitments. Missing,
already dismissed, sent, and expired commitments remain unchanged. Duplicate
IDs are ignored after their first occurrence, and results preserve request order.

When every requested commitment is dismissed, `--json` returns:

```json
{ "dismissed": ["cm_abc123", "cm_def456"] }
```

When a request includes stale or inactive IDs, the command reports both results
and exits with status `1`:

```json
{ "dismissed": ["cm_abc123"], "notDismissed": ["cm_missing", "cm_expired"] }
```

If no requested commitment can be dismissed, the command still exits with status
`1`:

```json
{ "dismissed": [], "notDismissed": ["cm_missing"] }
```

## Related

- [Inferred commitments](/concepts/commitments)
- [Memory overview](/concepts/memory)
- [Heartbeat](/gateway/heartbeat)
- [Scheduled tasks](/automation/cron-jobs)
