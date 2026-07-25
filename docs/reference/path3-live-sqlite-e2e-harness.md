---
summary: "Design for live Gateway proof of the Path 3 SQLite session/transcript flip"
read_when:
  - You are proving the Path 3 SQLite storage flip against a live Gateway
  - You need to distinguish expected legacy JSONL drift from runtime failures
  - You are building or reviewing the agent-driven live SQLite E2E harness
title: "Path 3 live SQLite E2E harness"
---

The Path 3 live SQLite E2E harness proves the Gateway is using SQLite as the
canonical session and transcript store while legacy JSONL files remain
migration input or archive material. It is a maintainer proof harness, not a
normal user diagnostic.

After a Gateway has processed post-migration traffic, legacy JSONL parity is no
longer a valid runtime health signal. A healthy migrated Gateway can have
SQLite transcript rows that differ from legacy JSONL counts because new turns
should advance SQLite only. The live harness must therefore measure Gateway
behavior, SQLite row movement, legacy-file quiescence, and log health at each
step.

## Command shape

The intended live command is:

```bash
node scripts/path3-live-sqlite-e2e.mjs \
  --url http://127.0.0.1:18789 \
  --agent main \
  --session-key agent:main:path3-live-e2e:<timestamp> \
  --json
```

The command connects to an already running Gateway. It does not start, stop,
import, or re-run the migration unless an explicit migration mode is added
later. A CI or isolated-local variant can use
`test/helpers/openclaw-test-instance.ts`, but the live proof path should inspect
the actual operator Gateway and its real per-agent SQLite database.

## Isolated built-CLI proof

The built-CLI proof runner seeds an isolated legacy session store, starts the
rebuilt Gateway, and proves that startup imports hot legacy sessions into
SQLite before runtime reads begin. It must not run `openclaw doctor --fix`
before the first Gateway start, because that would prove the manual migration
path instead of the upgrade path users receive on first boot after the flip.

After startup import, the isolated proof may run
`openclaw doctor --session-sqlite inspect` and
`openclaw doctor --session-sqlite validate` as diagnostic evidence. Those
doctor commands are not the migration driver for the startup-upgrade proof.
Separate doctor-import scenarios should seed legacy transcript files plus
trajectory sidecars and verify doctor archives those artifacts while SQLite
remains canonical.

## Preflight

Preflight collects a baseline and fails before sending a proof turn if the
Gateway is not usable:

- `GET /health` and Gateway deep status must report a running, reachable
  Gateway.
- The CLI and Gateway versions must match the branch being tested.
- The harness records a log cursor for the active Gateway file log.
- The harness records per-agent SQLite table counts for `sessions`,
  `session_entries`, `transcript_events`, `transcript_event_identities`, and
  `session_routes`.
- The harness records `mtime`, `size`, and existence for legacy
  `sessions.json`, referenced JSONL files, and candidate proof-session JSONL
  paths.
- `lsof -p <gateway-pid>` must show SQLite DB/WAL/SHM handles and no hot
  `.jsonl` or `sessions.json` handles.

`openclaw doctor --session-sqlite validate` is informational only in live mode.
After post-flip traffic it may report expected drift against legacy files. The
harness should use doctor output for classification and migration inventory,
not as the runtime pass/fail oracle.

## Agent-driven scenario

The live scenario uses a dedicated proof session key and drives the Gateway
through public RPC paths wherever possible. One agent turn should be enough to
exercise ordinary persistence, but the full proof should cover the 3.1b seams
that previously required individual live checks:

- Ordinary chat turn: create or reuse the proof session, send a real agent
  prompt, wait for the final assistant result, and verify `chat.history` or
  equivalent Gateway projection.
- Transcript identity: verify the same marker appears in Gateway history and in
  SQLite transcript rows, including stable event identity rows when present.
- Session metadata accessors: read the proof session and selected existing live
  sessions through Gateway/session accessors and compare them to SQLite rows.
- Session patch projection: apply a reversible model/session metadata change on
  the proof session, then verify the projected row and Gateway response agree.
- Compaction checkpoint lifecycle: list, branch, and restore a checkpoint only
  on the proof session or a synthetic fixture session created by the harness.
- Restart recovery: run the safe recovery marker path against a controlled proof
  session or an isolated test instance; live mode may only run this step when
  the target session set is explicit and reversible.
- Cleanup lifecycle: delete or reset the proof session, then verify SQLite
  lifecycle rows and archived transcript state.

Transport-specific seams that cannot be exercised safely on the live operator
Gateway, such as WhatsApp or voice-call ingress, should use owner-level runtime
probes against the same SQLite contract rather than fake external transport.

## Per-step assertions

Each step snapshots before and after state and writes a structured assertion
record:

- SQLite row counts advance only where expected.
- Trajectory runtime rows advance for marker-backed proof sessions that record
  runtime events.
- The proof session row has the expected `session_id`, status, timestamps,
  metadata, and route rows.
- Gateway history/session projection matches the SQLite transcript tail.
- No proof-session JSONL file is created or modified.
- No proof-session `.trajectory.jsonl`, `.trajectory-path.json`, or
  marker-derived `trajectory/<session>.jsonl` sidecar is created.
- Existing legacy JSONL files and `sessions.json` remain unchanged unless the
  step is explicitly an offline migration or archive operation.
- The Gateway process does not open `.jsonl` or `sessions.json` handles.
- Logs since the previous cursor contain no `ERROR`, `FATAL`, `SQLITE_`,
  `no such column`, session-store unavailable, restart-recovery failure, or
  transcript-reconcile warning unless the scenario explicitly allowlists it.

The log scan is part of the pass/fail contract. A Gateway that answers health
checks but emits SQLite schema errors or repeated transcript reconcile failures
is not green for Path 3.

## Evidence artifact

The harness should write evidence under `.artifacts/path3-live-e2e/<timestamp>/`
and keep it out of git:

- `summary.json`: command args, Gateway version, result, failed assertion, and
  artifact paths.
- `sqlite-before.json` and `sqlite-after.json`: row counts and selected proof
  rows.
- `legacy-files.json`: legacy file existence, `mtime`, size, and whether each
  file changed.
- `gateway-log-scan.json`: cursor range, matched log lines, and allowlist
  decisions.
- `events.jsonl`: ordered per-step observations suitable for PR proof comments.

The PR proof should summarize these artifacts instead of pasting full
transcripts or private message content.

## Safety rules

- Live mode must never re-import legacy JSONL while the Gateway is running.
- Live mode must not mutate non-proof sessions except for explicitly selected,
  reversible repair probes.
- Any destructive or broad migration step requires a fresh backup of the
  affected SQLite DB and legacy session directory.
- Backups should be scoped to the touched agent DB/session directory and reused
  during one proof run to avoid unbounded disk growth.
- The cleanup step must leave no proof session, proof JSONL, or modified legacy
  file behind unless the caller passes `--keep-artifacts`.

## Passing result

A passing live run means the Gateway accepted a real agent-driven session flow,
all observed canonical state was in SQLite, legacy runtime files stayed
quiescent, and log health stayed clean for the measured window. It does not mean
legacy JSONL parity remains clean after live traffic; live drift is expected
once SQLite is the canonical store.
