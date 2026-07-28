---
summary: "Typed workflow runtime for OpenClaw with resumable approval gates."
title: Lobster
read_when:
  - You want deterministic multi-step workflows with explicit approvals
  - You need to resume a workflow without re-running earlier steps
---

Lobster runs multi-step tool pipelines as one deterministic tool call, with
explicit approval checkpoints and resume tokens. It sits one layer above
detached background work: for orchestrating flows across many detached tasks,
see [Task Flow](/automation/taskflow) (`openclaw tasks flow`); for the task
activity ledger, see [Background Tasks](/automation/tasks).

## Why

Without Lobster, a multi-step job means many round-trip tool calls, with the
model orchestrating every step. Lobster moves that orchestration into a typed
runtime:

- **One call instead of many**: a single Lobster tool call returns a structured
  result for the whole pipeline.
- **Approvals built in**: side effects (send, post, delete) halt the workflow
  until explicitly approved.
- **Resumable**: a halted workflow returns a token; approve and resume without
  re-running earlier steps.

Lobster is a small, constrained DSL rather than a general scripting language:
approve/resume is a durable, built-in primitive; pipelines are data (easy to
log, diff, replay, review); the tiny grammar limits "creative" code paths so
validation stays realistic; timeouts, output caps, sandbox checks, and
allowlists are enforced by the runtime, not by each script. Each step can still
call any CLI or script - generate `.lobster` files from other tooling if you
want a richer authoring language.

Without Lobster, a recurring email triage looks like:

```text
User: "Check my email and draft replies"
→ openclaw calls gmail.list
→ LLM summarizes
→ User: "draft replies to #2 and #5"
→ LLM drafts
→ User: "send #2"
→ openclaw calls gmail.send
(repeat daily, no memory of what was triaged)
```

With Lobster, the same job is one call that halts for approval and resumes:

```json
{ "action": "run", "pipeline": "email.triage --limit 20", "timeoutMs": 30000 }
```

```json
{
  "ok": true,
  "status": "needs_approval",
  "output": [{ "summary": "5 need replies, 2 need action" }],
  "requiresApproval": {
    "type": "approval_request",
    "prompt": "Send 2 draft replies?",
    "items": [],
    "resumeToken": "..."
  }
}
```

## How it works

OpenClaw runs Lobster workflows **in-process** using the bundled
`@clawdbot/lobster` package as an embedded runner. No external `lobster`
subprocess is spawned; the tool call returns a JSON envelope directly. If the
pipeline halts for approval, the envelope carries a resume token (or a short
approval ID) so you can continue later.

## Enable

Lobster is an **optional** plugin tool, not enabled by default. It ships
bundled, so no separate install step is required - just allow the tool:

```json
{
  "tools": {
    "alsoAllow": ["lobster"]
  }
}
```

Or per-agent:

```json
{
  "agents": {
    "list": [
      {
        "id": "main",
        "tools": {
          "alsoAllow": ["lobster"]
        }
      }
    ]
  }
}
```

<Note>
`alsoAllow` adds `lobster` on top of the active tool profile without
restricting other core tools. Use `tools.allow` only if you want a restrictive
allowlist mode instead.
</Note>

The tool is disabled entirely for sandboxed tool contexts.

If you need the standalone Lobster CLI for development or external pipelines
(outside the embedded gateway runner), install it from the
[Lobster repo](https://github.com/openclaw/lobster) and put `lobster` on
`PATH`.

## Pattern: small CLI + JSON pipes + approvals

Build tiny commands that speak JSON, then chain them into one Lobster call.
(Example command names below - swap in your own.)

```bash
inbox list --json
inbox categorize --json
inbox apply --json
```

```json
{
  "action": "run",
  "pipeline": "exec --json --shell 'inbox list --json' | exec --stdin json --shell 'inbox categorize --json' | exec --stdin json --shell 'inbox apply --json' | approve --preview-from-stdin --limit 5 --prompt 'Apply changes?'",
  "timeoutMs": 30000
}
```

If the pipeline requests approval, resume with the token:

```json
{
  "action": "resume",
  "token": "<resumeToken>",
  "approve": true
}
```

Example: map input items into tool calls:

```bash
gog.gmail.search --query 'newer_than:1d' \
  | openclaw.invoke --tool message --action send --each --item-key message --args-json '{"provider":"telegram","to":"..."}'
```

## JSON-only LLM steps (llm-task)

For a **structured LLM step** inside a workflow, enable the optional
`llm-task` plugin tool and call it from Lobster:

```json
{
  "plugins": {
    "entries": {
      "llm-task": { "enabled": true }
    }
  },
  "agents": {
    "list": [
      {
        "id": "main",
        "tools": { "alsoAllow": ["llm-task"] }
      }
    ]
  }
}
```

### Important limitation: embedded Lobster vs `openclaw.invoke`

The bundled Lobster plugin runs workflows **in-process** inside the gateway.
In that embedded mode, `openclaw.invoke` does **not** automatically inherit a
gateway URL/auth context for nested OpenClaw CLI tool calls.

That means this pattern is **not currently reliable in the embedded runner**:

```lobster
openclaw.invoke --tool llm-task --action json --args-json '{ ... }'
```

Use the example below only when running the **standalone Lobster CLI** in an
environment where `openclaw.invoke` is already configured with the correct
gateway/auth context.

```lobster
openclaw.invoke --tool llm-task --action json --args-json '{
  "prompt": "Given the input email, return intent and draft.",
  "thinking": "low",
  "input": { "subject": "Hello", "body": "Can you help?" },
  "schema": {
    "type": "object",
    "properties": {
      "intent": { "type": "string" },
      "draft": { "type": "string" }
    },
    "required": ["intent", "draft"],
    "additionalProperties": false
  }
}'
```

If you are using the embedded Lobster plugin today, prefer either:

- a direct `llm-task` tool call outside Lobster, or
- non-`openclaw.invoke` steps inside the Lobster pipeline until a supported
  embedded bridge is added.

See [LLM Task](/tools/llm-task) for details and configuration options.

## Workflow files (.lobster)

Lobster can run YAML/JSON workflow files with `name`, `args`, `steps`, `env`,
`condition`, and `approval` fields. Set `pipeline` to the file path in the tool
call.

```yaml
name: inbox-triage
args:
  tag:
    default: "family"
steps:
  - id: collect
    command: inbox list --json
  - id: categorize
    command: inbox categorize --json
    stdin: $collect.stdout
  - id: approve
    command: inbox apply --approve
    stdin: $categorize.stdout
    approval: required
  - id: execute
    command: inbox apply --execute
    stdin: $categorize.stdout
    condition: $approve.approved
```

Notes:

- `stdin: $step.stdout` and `stdin: $step.json` pass a prior step's output.
- `condition` (or `when`) can gate steps on `$step.approved`.

### Injected environment variables

Every step shell inherits the parent environment plus these Lobster-injected
variables, so commands can reference resolved workflow args without embedding
raw values into the command string:

- `LOBSTER_ARG_<NAME>` - one per workflow arg. The name is uppercased with each
  run of non-alphanumeric characters collapsed to `_`, so arg `user-id` becomes
  `LOBSTER_ARG_USER_ID`.
- `LOBSTER_ARGS_JSON` - every resolved arg as a single JSON string.

That is the complete injected set. There are **no** per-step output variables
such as `LOBSTER_STEP_<id>_STDOUT` or `LOBSTER_STEP_<id>_JSON_<field>`; shells
treat those names as unset, so parameter-expansion defaults can hide the error.
Read a prior step's output through step references instead - `$step.stdout`,
`$step.json`, or `$step.json.<field>` - in a `stdin:`, `env:`, or `condition:`
value. (`LOBSTER_STATE_DIR` is a separate runtime setting for the state
directory, not a per-run arg.)

## Tool parameters

### `run`

```json
{
  "action": "run",
  "pipeline": "gog.gmail.search --query 'newer_than:1d' | email.triage",
  "cwd": "workspace",
  "timeoutMs": 30000,
  "maxStdoutBytes": 512000
}
```

Run a workflow file with args:

```json
{
  "action": "run",
  "pipeline": "/path/to/inbox-triage.lobster",
  "argsJson": "{\"tag\":\"family\"}"
}
```

| Field            | Default     | Notes                                                                                                        |
| ---------------- | ----------- | ------------------------------------------------------------------------------------------------------------ |
| `pipeline`       | required    | Inline pipeline string, or a path ending in `.lobster`/`.yaml`/`.yml`/`.json` for a workflow file.           |
| `cwd`            | gateway cwd | Relative working directory; must resolve inside the gateway working directory (absolute paths are rejected). |
| `timeoutMs`      | `20000`     | Aborts the run if exceeded.                                                                                  |
| `maxStdoutBytes` | `512000`    | Aborts the run if captured stdout or stderr exceeds this size.                                               |
| `argsJson`       | -           | JSON string of args for a workflow file (ignored for inline pipelines).                                      |

### `resume`

```json
{
  "action": "resume",
  "token": "<resumeToken>",
  "approve": true
}
```

`resume` accepts either `token` (the full resume token from `requiresApproval`)
or `approvalId` (the short id from the same object) - use whichever the halted
run returned. `approve` is required.

### Managed Task Flow mode

Passing `flowControllerId` and `flowGoal` on `run` (or `flowId` and
`flowExpectedRevision` on `resume`) drives the call through the plugin
runtime's managed [Task Flow](/automation/taskflow) API instead of returning
a bare envelope: OpenClaw creates or resumes a durable flow record, applies the
Lobster envelope to it (`waiting` on approval, `succeeded`/`failed` on
completion), and returns `{ ok, envelope, flow, mutation }`. This mode requires
a bound Task Flow runtime and is intended for plugin/controller code that needs
durable flow state across gateway restarts, not typical ad hoc agent use.

## Output envelope

Lobster returns a JSON envelope with one of three statuses:

- `ok` - finished successfully
- `needs_approval` - paused; `requiresApproval` carries a `resumeToken` and a
  short `approvalId`, either of which can resume the run
- `cancelled` - explicitly denied or cancelled

The tool surfaces the envelope in both `content` (pretty JSON) and `details`
(raw object).

## Approvals

If `requiresApproval` is present, inspect the prompt and decide:

- `approve: true` - resume and continue side effects
- `approve: false` - cancel and finalize the workflow

Use `approve --preview-from-stdin --limit N` to attach a JSON preview to
approval requests without custom jq/heredoc glue. Resume state is stored as
small JSON files under the Lobster state directory (`~/.lobster/state` by
default, override with `LOBSTER_STATE_DIR`); the token itself only encodes a
pointer to that state, not the full pipeline state.

## OpenProse

OpenProse pairs well with Lobster: use `/prose` to orchestrate multi-agent
prep, then run a Lobster pipeline for deterministic approvals. If a Prose
program needs Lobster, allow the `lobster` tool for sub-agents via
`tools.subagents.tools`. See [OpenProse](/prose).

## Safety

- **Local in-process only** - workflows execute inside the gateway process; no
  network calls from the plugin itself.
- **No secrets** - Lobster doesn't manage OAuth; it calls OpenClaw tools that
  do.
- **Sandbox-aware** - disabled when the tool context is sandboxed.
- **Hardened** - timeouts and output caps enforced by the embedded runner.

## Troubleshooting

| Error                                                         | Cause / fix                                                                      |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `lobster runtime timed out`                                   | Pipeline exceeded `timeoutMs`. Increase it or split the pipeline.                |
| `lobster stdout exceeded maxStdoutBytes` (or `stderr`)        | Captured output exceeded the cap. Raise `maxStdoutBytes` or reduce output.       |
| `run --args-json must be valid JSON`                          | `argsJson` (workflow-file runs) failed to parse. Fix the JSON string.            |
| `lobster runtime failed` (or another `runtime_error` message) | The embedded runtime returned an error envelope. Check gateway logs for details. |

## Learn more

- [Plugins](/tools/plugin)
- [Plugin tool authoring](/plugins/building-plugins#registering-agent-tools)

## Case study: community workflows

One public example: a "second brain" CLI + Lobster pipelines that manage three
Markdown vaults (personal, partner, shared). The CLI emits JSON for stats,
inbox listings, and stale scans; Lobster chains those commands into workflows
like `weekly-review`, `inbox-triage`, `memory-consolidation`, and
`shared-task-sync`, each with approval gates. AI handles judgment
(categorization) when available and falls back to deterministic rules when
not.

- Thread: [https://x.com/plattenschieber/status/2014508656335770033](https://x.com/plattenschieber/status/2014508656335770033)
- Repo: [https://github.com/bloomedai/brain-cli](https://github.com/bloomedai/brain-cli)

## Related

- [Automation](/automation) - all automation mechanisms
- [Tools Overview](/tools) - all available agent tools
