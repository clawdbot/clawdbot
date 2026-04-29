---
summary: "Export redacted trajectory bundles for debugging an OpenClaw agent session"
read_when:
  - Debugging why an agent answered, failed, or called tools a certain way
  - Exporting a support bundle for an OpenClaw session
  - Investigating prompt context, tool calls, runtime errors, or usage metadata
  - Disabling or relocating trajectory capture
title: "Trajectory bundles"
---

Trajectory capture is OpenClaw's per-session flight recorder. It records a
structured timeline for each agent run, then `/export-trajectory` packages the
current session into a redacted support bundle.

Use it when you need to answer questions like:

- What prompt, system prompt, and tools were sent to the model?
- Which transcript messages and tool calls led to this answer?
- Did the run time out, abort, compact, or hit a provider error?
- Which model, plugins, skills, and runtime settings were active?
- What usage and prompt-cache metadata did the provider return?

If you are filing a broad support report for a live Gateway issue, start with
[`/diagnostics`](/gateway/diagnostics#chat-command). Diagnostics collects the
sanitized Gateway bundle and, for OpenAI Codex harness sessions, can also send
Codex feedback to OpenAI servers after approval. Use `/export-trajectory` when
you specifically need the detailed per-session prompt, tool, and transcript
timeline.

## Quick start

Send this in the active session:

```text
/export-trajectory
```

Alias:

```text
/trajectory
```

OpenClaw writes the bundle under the workspace:

```text
.openclaw/trajectory-exports/openclaw-trajectory-<session>-<timestamp>/
```

You can choose a relative output directory name:

```text
/export-trajectory bug-1234
```

The custom path is resolved inside `.openclaw/trajectory-exports/`. Absolute
paths and `~` paths are rejected.

Trajectory bundles can contain prompts, model messages, tool schemas, tool
results, runtime events, and local paths. The chat slash command therefore runs
through exec approval every time. Approve the export once when you intend to
create the bundle; do not use allow-all. In group chats, OpenClaw sends the
approval prompt and export result to the owner privately instead of posting the
trajectory details back to the shared room.

For local inspection or support workflows, you can also run the approved command
path directly:

```bash
openclaw sessions export-trajectory --session-key "agent:main:telegram:direct:123" --workspace .
```

## Access

Trajectory export is an owner command. The sender must pass the normal command
authorization checks and owner checks for the channel.

## What gets recorded

Trajectory capture is on by default for OpenClaw agent runs.

Runtime events include:

- `session.started`
- `trace.metadata`
- `context.compiled`
- `prompt.submitted`
- `model.fallback_step`, including the source model, next model, failure reason/detail, chain position, and whether fallback advanced, succeeded, or exhausted the chain
- `model.completed`
- `trace.artifacts`
- `session.ended`

Transcript events are also reconstructed from the active session branch:

- user messages
- assistant messages
- tool calls
- tool results
- compactions
- model changes
- labels and custom session entries

Events are written as JSON Lines with this schema marker:

```json
{
  "traceSchema": "openclaw-trajectory",
  "schemaVersion": 1
}
```

## Bundle files

An exported bundle can contain:

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

`manifest.json` lists the files present in that bundle. Some files are omitted
when the session did not capture the corresponding runtime data.

## Capture location

By default, runtime trajectory events are written beside the session file:

```text
<session>.trajectory.jsonl
```

OpenClaw also writes a best-effort pointer file beside the session:

```text
<session>.trajectory-path.json
```

Set `OPENCLAW_TRAJECTORY_DIR` to store runtime trajectory sidecars in a
dedicated directory:

```bash
export OPENCLAW_TRAJECTORY_DIR=/var/lib/openclaw/trajectories
```

When this variable is set, OpenClaw writes one JSONL file per session id in that
directory.

Session maintenance removes trajectory sidecars when their owning session entry
is pruned, capped, or evicted by the sessions disk budget. Runtime files outside
the sessions directory are removed only when the pointer target still proves it
belongs to that session.

## Disable capture

Set `OPENCLAW_TRAJECTORY=0` before starting OpenClaw:

```bash
export OPENCLAW_TRAJECTORY=0
```

This disables runtime trajectory capture. `/export-trajectory` can still export
the transcript branch, but runtime-only files such as compiled context,
provider artifacts, and prompt metadata may be missing.

## Privacy and limits

Trajectory bundles are designed for support and debugging, not public posting.
OpenClaw redacts sensitive values before writing export files:

- credentials and known secret-like payload fields
- image data
- local state paths
- workspace paths, replaced with `$WORKSPACE_DIR`
- home directory paths, where detected

The exporter also bounds input size:

- runtime sidecar files: 50 MiB
- session files: 50 MiB
- runtime events: 200,000
- total exported events: 250,000
- individual runtime event lines are truncated above 256 KiB

Review bundles before sharing them outside your team. Redaction is best-effort
and cannot know every application-specific secret.

## Troubleshooting

If the export has no runtime events:

- confirm OpenClaw was started without `OPENCLAW_TRAJECTORY=0`
- check whether `OPENCLAW_TRAJECTORY_DIR` points to a writable directory
- run another message in the session, then export again
- inspect `manifest.json` for `runtimeEventCount`

If the command rejects the output path:

- use a relative name like `bug-1234`
- do not pass `/tmp/...` or `~/...`
- keep the export inside `.openclaw/trajectory-exports/`

If the export fails with a size error, the session or sidecar exceeded the
export safety limits. Start a new session or export a smaller reproduction.

## Related

- [Diffs](/tools/diffs)
- [Session management](/concepts/session)
- [Exec tool](/tools/exec)
