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

The separately installed official `@openclaw/lobster` plugin runs Lobster
workflows **in-process** using its embedded `@clawdbot/lobster` runtime. No
external `lobster` subprocess is spawned; the tool call returns a JSON envelope
directly. If the pipeline halts for approval, the envelope carries a resume
token (or a short approval ID) so you can continue later.

## Enable

Lobster is an **optional** plugin tool, not installed or enabled by default.
Install the official plugin, then restart the Gateway:

```bash
openclaw plugins install @openclaw/lobster
openclaw gateway restart
```

After the Gateway restarts, allow the tool globally:

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
    "entries": {
      "main": {
        "default": true,
        "tools": {
          "alsoAllow": ["lobster"]
        }
      }
    }
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
    "entries": {
      "main": {
        "default": true,
        "tools": { "alsoAllow": ["llm-task"] }
      }
    }
  }
}
```

### Important limitation: embedded Lobster vs `openclaw.invoke`

The installed Lobster plugin runs workflows **in-process** inside the gateway.
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
| `maxStdoutBytes` | `512000`    | Aborts if captured stdout, stderr, or the embedded JSON result exceeds this size.                            |
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
runtime's managed [Task Flow](/automation/taskflow) API. The tool returns the
Lobster envelope with `flow` and `mutation` fields. `flow.revision` is the
persisted revision after a successful mutation, not the revision before
execution. Check `mutation.applied` for a state transition or
`mutation.cancelled` for cancellation. On errors, inspect the persisted flow
rather than assuming a failure write succeeded.

This mode requires a non-sandboxed tool context with a bound session. It records
a managed flow, not detached ACP/subagent tasks for each shell step. Neither
Task Flow nor a skill automatically replays arbitrary JavaScript. See
[Task Flow](/automation/taskflow) for runnable examples and child-linking.

Use this mode for workflows that pause for structured input. OpenClaw saves the
question, response schema, defaults, subject, working directory, and Lobster
resume token in the flow's `waitJson`. The existing Lobster runtime still owns
the executable checkpoint and validates answers; Task Flow stores its durable
reference. No separate input registry is required.

The plugin's included Lobster skill guides the agent to choose managed mode for
structured questions and recoverable reviews from the initial run. You do not
need to name Task Flow in the request. Ordinary pipelines remain available for
immediate work; do not rerun a started workflow just to switch modes, since that
can repeat effects.

For example, a workflow file can contain this input step:

```yaml
steps:
  - id: review
    input:
      prompt: Publish or revise the draft?
      responseSchema:
        type: object
        properties:
          decision:
            type: string
            enum: [publish, revise]
        required: [decision]
        additionalProperties: false
      defaults:
        decision: revise
```

Start it with a controller name and goal:

```json
{
  "action": "run",
  "pipeline": "review.lobster",
  "flowControllerId": "draft-review",
  "flowGoal": "Review the prepared draft"
}
```

When the result is `needs_input`, present `requiresInput.prompt` and collect
the user's answer. Defaults are suggestions, not consent. Do not invent an
answer or treat the schema as permission to perform an action.

#### Rediscover and answer a saved question

Call `status` without a flow ID to list this session's pending Lobster flows:

```json
{ "action": "status" }
```

The list contains up to 20 summaries. If `nextOffset` is returned, pass it as
`flowOffset` for the next page. Read the full question and current revision:

```json
{ "action": "status", "flowId": "<flowId>" }
```

Then answer using the revision just read:

```json
{
  "action": "resume",
  "flowId": "<flowId>",
  "flowExpectedRevision": 2,
  "responseJson": "{\"decision\":\"publish\"}"
}
```

`2` is illustrative; always use the returned `flow.revision`. Managed resume
reads the saved token and working directory, so neither needs to remain in the
conversation. For an approval wait, send `approve: true` or `approve: false`
instead of `responseJson`. To cancel an input wait, send `cancel: true` instead.
Send exactly one decision. If a token or approval ID is supplied, it must match
the saved checkpoint.

A schema-invalid answer leaves the flow waiting at a new revision. Read the
returned flow or call `status`, then submit the corrected answer. Stale managed,
concurrent, cancelled, and terminal resumes are rejected before dispatch.

#### Ownership, retention, and execution limits

- This mode requires a session-bound Task Flow runtime. Ownership follows the
  existing session key, not a browser tab or physical transcript file. Context
  compaction or reset with the same session key does not discard the wait; a
  different session key does not gain access by knowing the flow ID.
- Waiting flows have no seven-day expiry. Existing Task Flow maintenance may
  prune terminal flows after seven days. Both OpenClaw's state database and
  Lobster's checkpoint files must remain available to resume.
- A checkpoint in `waitJson` is ordinary authorized Task Flow state, not a
  secret vault. This does not add per-person reviewer assignment, a central
  Inbox item, a form UI, or notification routing.
- Task Flow claims govern managed calls, not direct Lobster CLI/runtime calls
  or legacy token-only approval resumes. Keep managed approvals on the managed
  resume path; resuming their raw tokens through ordinary mode bypasses Task
  Flow bookkeeping.
- `responseJson` is limited to 64 KiB. `status` uses `maxStdoutBytes` (default
  `512000`) and omits arbitrary `flowStateJson`. For larger saved questions,
  retry `status` with a larger `maxStdoutBytes`; schemas are never truncated.
  Managed runs and resumes persist complete checkpoints before limiting the
  tool reply. If the reply is too large, it returns an error with the flow ID,
  revision, and status so the saved question can be retrieved without replaying
  earlier steps. This does not bypass stdout/stderr limits while steps execute.
- Revision checks prevent duplicate managed dispatch and revalidate after
  asynchronous runner preparation. They do not make workflow effects and
  SQLite writes atomic. A crash after claiming a resume can leave a flow
  `running`, even if dispatch had not yet started. There is no durable dispatch
  receipt to distinguish that case from effects that ran before a crash. Inspect
  the flow by ID and reconcile effects manually; this adapter does not
  automatically reclaim or replay a claimed flow. Timeouts and runtime failures
  can also leave effects uncertain. Cancellation cannot undo effects or
  guarantee immediate interruption of already-running steps.
- Ordinary token-based approval mode is unchanged. Structured input requires
  managed mode from the initial `run`; it is not added to ordinary mode.

## Output envelope

Lobster returns a JSON envelope with these statuses:

- `ok` - finished successfully
- `needs_approval` - paused; `requiresApproval` carries a `resumeToken` and a
  short `approvalId`, either of which can resume the run
- `needs_input` - paused in managed mode; `requiresInput` carries the prompt,
  response schema, optional defaults and subject, and resume token
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
| `lobster runtime result exceeded maxStdoutBytes`              | The JSON result exceeded the cap. Raise `maxStdoutBytes` or reduce output.       |
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
