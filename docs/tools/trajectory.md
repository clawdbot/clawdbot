---
summary: "Export redacted trajectory bundles for debugging an OpenClaw agent session"
read_when:
  - Debugging why an agent answered, failed, or called tools a certain way
  - Exporting a support bundle for an OpenClaw session
  - Investigating prompt context, tool calls, runtime errors, or usage metadata
  - Disabling trajectory capture
title: "Trajectory bundles"
---

Trajectory capture is OpenClaw's per-session flight recorder. It records a
structured timeline for each agent run, then `/export-trajectory` packages the
current session into a redacted support bundle covering:

- The prompt, system prompt, and tools sent to the model
- Which transcript messages and tool calls led to an answer
- Whether the run timed out, aborted, compacted, or hit a provider error
- Which model, plugins, skills, and runtime settings were active
- Usage and prompt-cache metadata the provider returned

For a broad Gateway support report, start with
[`/diagnostics`](/gateway/diagnostics#chat-command) instead; it collects the
sanitized Gateway bundle and, for OpenAI Codex harness sessions, can send Codex
feedback to OpenAI after approval. Use `/export-trajectory` when you need the
detailed per-session prompt, tool, and transcript timeline.

## Quick start

Send in the active session (alias `/trajectory`):

```text
/export-trajectory
```

OpenClaw writes the bundle under the workspace:

```text
.openclaw/trajectory-exports/openclaw-trajectory-<session>-<timestamp>/
```

Pass a relative output directory name to override it:

```text
/export-trajectory bug-1234
```

The name resolves inside `.openclaw/trajectory-exports/`. Absolute paths and
`~` paths are rejected.

Trajectory bundles can contain prompts, model messages, tool schemas, tool
results, runtime events, and local paths, so the chat command always runs
through exec approval. Approve the export once when you intend to create the
bundle; do not use allow-all. In group chats, OpenClaw sends the approval
prompt and export result to the owner privately instead of posting trajectory
details back to the shared room.

For local inspection or support workflows, run the underlying CLI command
directly:

```bash
openclaw sessions export-trajectory --session-key "agent:main:telegram:direct:123" --workspace .
```

Other flags: `--output <path>` (directory name inside
`.openclaw/trajectory-exports`), `--store <path>` (session store override),
`--agent <id>` (agent id for store resolution), `--json` (structured output).

## Access

Trajectory export is an owner command. The sender must pass the normal command
authorization checks plus the owner check for the channel.

## What gets recorded

Trajectory capture is on by default for OpenClaw agent runs.

Runtime events include:

- `session.started`
- `trace.metadata`
- `context.compiled`
- `prompt.submitted`
- `model.fallback_step`, including the source model, next model, failure reason/detail, chain position, and whether the chain advanced, succeeded, or was exhausted
- `model.completed`
- `trace.artifacts`
- `session.ended`

Transcript events are reconstructed from the active session branch: user
messages, assistant messages, tool calls, tool results, compactions, model
changes, labels, and custom session entries.

Events are written as JSON Lines with this schema marker:

```json
{
  "traceSchema": "openclaw-trajectory",
  "schemaVersion": 1
}
```

## Bundle files

| File                  | Contents                                                                                       |
| --------------------- | ---------------------------------------------------------------------------------------------- |
| `manifest.json`       | Bundle schema, source files, event counts, and generated file list                             |
| `events.jsonl`        | Ordered runtime and transcript timeline                                                        |
| `session-branch.json` | Redacted active transcript branch and session header                                           |
| `metadata.json`       | OpenClaw version, OS/runtime, model, config snapshot, plugins, skills, and prompt metadata     |
| `artifacts.json`      | Final status, errors, usage, prompt cache, compaction count, assistant text, and tool metadata |
| `prompts.json`        | Submitted prompts and selected prompt-building details                                         |
| `system-prompt.txt`   | Latest compiled system prompt, when captured                                                   |
| `tools.json`          | Tool definitions sent to the model, when captured                                              |

`manifest.json` lists the files present in a given bundle; some files are
omitted when the session did not capture the corresponding runtime data.

## Capture storage

Runtime trajectory events are stored with the session in the per-agent SQLite
database. Exporting a trajectory materializes a redacted JSONL support bundle;
the live runtime capture is not a session-adjacent JSONL sidecar.

Legacy `.trajectory.jsonl` and `.trajectory-path.json` files may still appear
from older releases or explicit legacy-file exports. Session maintenance treats
those files as cleanup targets; active capture writes database rows.

## Disable capture

```bash
export OPENCLAW_TRAJECTORY=0
```

This disables runtime trajectory capture before starting OpenClaw.
`/export-trajectory` can still export the transcript branch, but runtime-only
data such as compiled context, provider artifacts, and prompt metadata may be
missing.

## Tune flush timeout

OpenClaw flushes runtime trajectory rows during agent cleanup. The default
cleanup timeout is 10,000 ms. On slow disks or large stores, set
`OPENCLAW_TRAJECTORY_FLUSH_TIMEOUT_MS` before starting OpenClaw:

```bash
export OPENCLAW_TRAJECTORY_FLUSH_TIMEOUT_MS=30000
```

This controls when OpenClaw logs an `openclaw-trajectory-flush` timeout and
continues; it does not change the trajectory size caps. To tune all agent
cleanup steps that do not pass an explicit timeout, set
`OPENCLAW_AGENT_CLEANUP_TIMEOUT_MS`.

## Privacy and limits

Trajectory bundles are for support and debugging, not public posting. OpenClaw
redacts sensitive values before writing export files:

- credentials and known secret-like payload fields
- image data
- local state paths
- workspace paths, replaced with `$WORKSPACE_DIR`
- home directory paths, where detected

The exporter also bounds input size:

- runtime capture: the live capture is a rolling window capped at 10 MiB, dropping the oldest events to make room for new ones; export accepts existing legacy runtime sidecar files up to 50 MiB
- session files: 50 MiB
- runtime events per export: 200,000
- total exported events: 250,000
- individual runtime event lines are truncated above 256 KiB

Review bundles before sharing them outside your team. Redaction is best-effort
and cannot know every application-specific secret.

## Troubleshooting

If the export has no runtime events:

- confirm OpenClaw was started without `OPENCLAW_TRAJECTORY=0`
- run another message in the session, then export again
- inspect `manifest.json` for `runtimeEventCount`

If the command rejects the output path:

- use a relative name like `bug-1234`
- do not pass `/tmp/...` or `~/...`
- keep the export inside `.openclaw/trajectory-exports/`

If the export fails with a size error, the session or sidecar exceeded the
export safety limits above. Start a new session or export a smaller
reproduction.

## Related

- [Diffs](/tools/diffs)
- [Session management](/concepts/session)
- [Exec tool](/tools/exec)
