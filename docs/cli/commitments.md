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

Find snoozed commitments:

```bash
openclaw commitments --status snoozed
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

## Related

- [Inferred commitments](/concepts/commitments)
- [Memory overview](/concepts/memory)
- [Heartbeat](/gateway/heartbeat)
- [Scheduled tasks](/automation/cron-jobs)
