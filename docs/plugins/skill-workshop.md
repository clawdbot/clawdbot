---
title: "Skill Workshop Plugin"
summary: "Experimental capture of reusable procedures as workspace skills with review, approval, quarantine, and hot skill refresh"
read_when:
  - You want agents to turn corrections or reusable procedures into workspace skills
  - You are configuring procedural skill memory
  - You are debugging skill_workshop tool behavior
  - You are deciding whether to enable automatic skill creation
---

# Skill Workshop Plugin

Skill Workshop is **experimental**. It is disabled by default, its capture
heuristics and reviewer prompts may change between releases, and automatic
writes should be used only in trusted workspaces after reviewing pending-mode
output first.

Skill Workshop is procedural memory for workspace skills. It lets an agent turn
reusable workflows, user corrections, hard-won fixes, and recurring pitfalls
into `SKILL.md` files under:

```text
<workspace>/skills/<skill-name>/SKILL.md
```

This is different from long-term memory:

- **Memory** stores facts, preferences, entities, and past context.
- **Skills** store reusable procedures the agent should follow on future tasks.
- **Skill Workshop** is the bridge from a useful turn to a durable workspace
  skill, with safety checks and optional approval.

Skill Workshop is useful when the agent learns a procedure such as:

- how to validate externally sourced animated GIF assets
- how to replace screenshot assets and verify dimensions
- how to run a repo-specific QA scenario
- how to debug a recurring provider failure
- how to repair a stale local workflow note

It is not intended for:

- facts like “the user likes blue”
- broad autobiographical memory
- raw transcript archiving
- secrets, credentials, or hidden prompt text
- one-off instructions that will not repeat

## Default State

The bundled plugin is **experimental** and **disabled by default** unless it is
explicitly enabled in `plugins.entries.skill-workshop`.

The plugin manifest does not set `enabledByDefault: true`. The `enabled: true`
default inside the plugin config schema applies only after the plugin entry has
already been selected and loaded.

Experimental means:

- the plugin is supported enough for opt-in testing and dogfooding
- proposal storage, reviewer thresholds, and capture heuristics can evolve
- pending approval is the recommended starting mode
- auto apply is for trusted personal/workspace setups, not shared or hostile
  input-heavy environments

## Enable

Minimal safe config:

```json5
{
  plugins: {
    entries: {
      "skill-workshop": {
        enabled: true,
        config: {
          autoCapture: true,
          approvalPolicy: "pending",
          reviewMode: "hybrid",
        },
      },
    },
  },
}
```

With this config:

- the `skill_workshop` tool is available
- explicit reusable corrections are queued as pending proposals
- threshold-based reviewer passes can propose skill updates
- no skill file is written until a pending proposal is applied

Use automatic writes only in trusted workspaces:

```json5
{
  plugins: {
    entries: {
      "skill-workshop": {
        enabled: true,
        config: {
          autoCapture: true,
          approvalPolicy: "auto",
          reviewMode: "hybrid",
        },
      },
    },
  },
}
```

`approvalPolicy: "auto"` still uses the same scanner and quarantine path. It
does not apply proposals with critical findings.

## Configuration

| Key                  | Default     | Range / values                              | Meaning                                                              |
| -------------------- | ----------- | ------------------------------------------- | -------------------------------------------------------------------- |
| `enabled`            | `true`      | boolean                                     | Enables the plugin after the plugin entry is loaded.                 |
| `autoCapture`        | `true`      | boolean                                     | Enables post-turn capture/review on successful agent turns.          |
| `approvalPolicy`     | `"pending"` | `"pending"`, `"auto"`                       | Queue proposals or write safe proposals automatically.               |
| `reviewMode`         | `"hybrid"`  | `"off"`, `"heuristic"`, `"llm"`, `"hybrid"` | Chooses explicit correction capture, LLM reviewer, both, or neither. |
| `reviewInterval`     | `15`        | `1..200`                                    | Run reviewer after this many successful turns.                       |
| `reviewMinToolCalls` | `8`         | `1..500`                                    | Run reviewer after this many observed tool calls.                    |
| `reviewTimeoutMs`    | `45000`     | `5000..180000`                              | Timeout for the embedded reviewer run.                               |
| `maxPending`         | `50`        | `1..200`                                    | Max pending/quarantined proposals kept per workspace.                |
| `maxSkillBytes`      | `40000`     | `1024..200000`                              | Max generated skill/support file size.                               |

Recommended profiles:

```json5
// Conservative: explicit tool use only, no automatic capture.
{
  autoCapture: false,
  approvalPolicy: "pending",
  reviewMode: "off",
}
```

```json5
// Review-first: capture automatically, but require approval.
{
  autoCapture: true,
  approvalPolicy: "pending",
  reviewMode: "hybrid",
}
```

```json5
// Trusted automation: write safe proposals immediately.
{
  autoCapture: true,
  approvalPolicy: "auto",
  reviewMode: "hybrid",
}
```

```json5
// Low-cost: no reviewer LLM call, only explicit correction phrases.
{
  autoCapture: true,
  approvalPolicy: "pending",
  reviewMode: "heuristic",
}
```

## Capture Paths

Skill Workshop has three capture paths.

### Tool Suggestions

The model can call `skill_workshop` directly when it sees a reusable procedure
or when the user asks it to save/update a skill.

This is the most explicit path and works even with `autoCapture: false`.

### Heuristic Capture

When `autoCapture` is enabled and `reviewMode` is `heuristic` or `hybrid`, the
plugin scans successful turns for explicit user correction phrases:

- `next time`
- `from now on`
- `remember to`
- `make sure to`
- `always ... use/check/verify/record/save/prefer`
- `prefer ... when/for/instead/use`
- `when asked`

The heuristic creates a proposal from the latest matching user instruction. It
uses topic hints to choose skill names for common workflows:

- animated GIF tasks -> `animated-gif-workflow`
- screenshot or asset tasks -> `screenshot-asset-workflow`
- QA or scenario tasks -> `qa-scenario-workflow`
- GitHub PR tasks -> `github-pr-workflow`
- fallback -> `learned-workflows`

Heuristic capture is intentionally narrow. It is for clear corrections and
repeatable process notes, not for general transcript summarization.

### LLM Reviewer

When `autoCapture` is enabled and `reviewMode` is `llm` or `hybrid`, the plugin
runs a compact embedded reviewer after thresholds are reached.

The reviewer receives:

- the recent transcript text, capped to the last 12,000 characters
- up to 12 existing workspace skills
- up to 2,000 characters from each existing skill
- JSON-only instructions

The reviewer has no tools:

- `disableTools: true`
- `toolsAllow: []`
- `disableMessageTool: true`

It can return:

```json
{ "action": "none" }
```

or one skill proposal:

```json
{
  "action": "create",
  "skillName": "media-asset-qa",
  "title": "Media Asset QA",
  "reason": "Reusable animated media acceptance workflow",
  "description": "Validate externally sourced animated media before product use.",
  "body": "## Workflow\n\n- Verify true animation.\n- Record attribution.\n- Store a local approved copy.\n- Verify in product UI before final reply."
}
```

It can also append to an existing skill:

```json
{
  "action": "append",
  "skillName": "qa-scenario-workflow",
  "title": "QA Scenario Workflow",
  "reason": "Animated media QA needs reusable checks",
  "description": "QA scenario workflow.",
  "section": "Workflow",
  "body": "- For animated GIF tasks, verify frame count and attribution before passing."
}
```

Or replace exact text in an existing skill:

```json
{
  "action": "replace",
  "skillName": "screenshot-asset-workflow",
  "title": "Screenshot Asset Workflow",
  "reason": "Old validation missed image optimization",
  "oldText": "- Replace the screenshot asset.",
  "newText": "- Replace the screenshot asset, preserve dimensions, optimize the PNG, and run the relevant validation gate."
}
```

Prefer `append` or `replace` when a relevant skill already exists. Use `create`
only when no existing skill fits.

## Proposal Lifecycle

Every generated update becomes a proposal with:

- `id`
- `createdAt`
- `updatedAt`
- `workspaceDir`
- optional `agentId`
- optional `sessionId`
- `skillName`
- `title`
- `reason`
- `source`: `tool`, `agent_end`, or `reviewer`
- `status`
- `change`
- optional `scanFindings`
- optional `quarantineReason`

Proposal statuses:

- `pending` - waiting for approval
- `applied` - written to `<workspace>/skills`
- `rejected` - rejected by operator/model
- `quarantined` - blocked by critical scanner findings

State is stored per workspace under the Gateway state directory:

```text
<stateDir>/skill-workshop/<workspace-hash>.json
```

Pending and quarantined proposals are deduplicated by skill name and change
payload. The store keeps the newest pending/quarantined proposals up to
`maxPending`.

## Tool Reference

The plugin registers one agent tool:

```text
skill_workshop
```

### `status`

Count proposals by state for the active workspace.

```json
{ "action": "status" }
```

Result shape:

```json
{
  "workspaceDir": "/path/to/workspace",
  "pending": 1,
  "quarantined": 0,
  "applied": 3,
  "rejected": 0
}
```

### `list_pending`

List pending proposals.

```json
{ "action": "list_pending" }
```

To list another status:

```json
{ "action": "list_pending", "status": "applied" }
```

Valid `status` values:

- `pending`
- `applied`
- `rejected`
- `quarantined`

### `list_quarantine`

List quarantined proposals.

```json
{ "action": "list_quarantine" }
```

Use this when automatic capture appears to do nothing and the logs mention
`skill-workshop: quarantined <skill>`.

### `inspect`

Fetch a proposal by id.

```json
{
  "action": "inspect",
  "id": "proposal-id"
}
```

### `suggest`

Create a proposal. With `approvalPolicy: "pending"`, this queues by default.

```json
{
  "action": "suggest",
  "skillName": "animated-gif-workflow",
  "title": "Animated GIF Workflow",
  "reason": "User established reusable GIF validation rules.",
  "description": "Validate animated GIF assets before using them.",
  "body": "## Workflow\n\n- Verify the URL resolves to image/gif.\n- Confirm it has multiple frames.\n- Record attribution and license.\n- Avoid hotlinking when a local asset is needed."
}
```

Force a safe write:

```json
{
  "action": "suggest",
  "apply": true,
  "skillName": "animated-gif-workflow",
  "description": "Validate animated GIF assets before using them.",
  "body": "## Workflow\n\n- Verify true animation.\n- Record attribution."
}
```

Force pending even in `approvalPolicy: "auto"`:

```json
{
  "action": "suggest",
  "apply": false,
  "skillName": "screenshot-asset-workflow",
  "description": "Screenshot replacement workflow.",
  "body": "## Workflow\n\n- Verify dimensions.\n- Optimize the PNG.\n- Run the relevant gate."
}
```

Append to a section:

```json
{
  "action": "suggest",
  "skillName": "qa-scenario-workflow",
  "section": "Workflow",
  "description": "QA scenario workflow.",
  "body": "- For media QA, verify generated assets render and pass final assertions."
}
```

Replace exact text:

```json
{
  "action": "suggest",
  "skillName": "github-pr-workflow",
  "oldText": "- Check the PR.",
  "newText": "- Check unresolved review threads, CI status, linked issues, and changed files before deciding."
}
```

### `apply`

Apply a pending proposal.

```json
{
  "action": "apply",
  "id": "proposal-id"
}
```

`apply` refuses quarantined proposals:

```text
quarantined proposal cannot be applied
```

### `reject`

Mark a proposal rejected.

```json
{
  "action": "reject",
  "id": "proposal-id"
}
```

### `write_support_file`

Write a supporting file inside an existing or proposed skill directory.

Allowed top-level support directories:

- `references/`
- `templates/`
- `scripts/`
- `assets/`

Example:

```json
{
  "action": "write_support_file",
  "skillName": "release-workflow",
  "relativePath": "references/checklist.md",
  "body": "# Release Checklist\n\n- Run release docs.\n- Verify changelog.\n"
}
```

Support files are workspace-scoped, path-checked, byte-limited by
`maxSkillBytes`, scanned, and written atomically.

## Skill Writes

Skill Workshop writes only under:

```text
<workspace>/skills/<normalized-skill-name>/
```

Skill names are normalized:

- lowercased
- non `[a-z0-9_-]` runs become `-`
- leading/trailing non-alphanumerics are removed
- max length is 80 characters
- final name must match `[a-z0-9][a-z0-9_-]{1,79}`

For `create`:

- if the skill does not exist, Skill Workshop writes a new `SKILL.md`
- if it already exists, Skill Workshop appends the body to `## Workflow`

For `append`:

- if the skill exists, Skill Workshop appends to the requested section
- if it does not exist, Skill Workshop creates a minimal skill then appends

For `replace`:

- the skill must already exist
- `oldText` must be present exactly
- only the first exact match is replaced

All writes are atomic and refresh the in-memory skills snapshot immediately, so
the new or updated skill can become visible without a Gateway restart.

## Safety Model

Skill Workshop has a safety scanner on generated `SKILL.md` content and support
files.

Critical findings quarantine proposals:

| Rule id                                | Blocks content that...                                                |
| -------------------------------------- | --------------------------------------------------------------------- |
| `prompt-injection-ignore-instructions` | tells the agent to ignore prior/higher instructions                   |
| `prompt-injection-system`              | references system prompts, developer messages, or hidden instructions |
| `prompt-injection-tool`                | encourages bypassing tool permission/approval                         |
| `shell-pipe-to-shell`                  | includes `curl`/`wget` piped into `sh`, `bash`, or `zsh`              |
| `secret-exfiltration`                  | appears to send env/process env data over the network                 |

Warn findings are retained but do not block by themselves:

| Rule id              | Warns on...                      |
| -------------------- | -------------------------------- |
| `destructive-delete` | broad `rm -rf` style commands    |
| `unsafe-permissions` | `chmod 777` style permission use |

Quarantined proposals:

- keep `scanFindings`
- keep `quarantineReason`
- appear in `list_quarantine`
- cannot be applied through `apply`

To recover from a quarantined proposal, create a new safe proposal with the
unsafe content removed. Do not edit the store JSON by hand.

## Prompt Guidance

When enabled, Skill Workshop injects a short prompt section that tells the agent
to use `skill_workshop` for durable procedural memory.

The guidance emphasizes:

- procedures, not facts/preferences
- user corrections
- non-obvious successful procedures
- recurring pitfalls
- stale/thin/wrong skill repair through append/replace
- saving reusable procedure after long tool loops or hard fixes
- short imperative skill text
- no transcript dumps

The write mode text changes with `approvalPolicy`:

- pending mode: queue suggestions; apply only after explicit approval
- auto mode: apply safe workspace-skill updates when clearly reusable

## Costs and Runtime Behavior

Heuristic capture does not call a model.

LLM review uses an embedded run on the active/default agent model. It is
threshold-based so it does not run on every turn by default.

The reviewer:

- uses the same configured provider/model context when available
- falls back to runtime agent defaults
- has `reviewTimeoutMs`
- uses lightweight bootstrap context
- has no tools
- writes nothing directly
- can only emit a proposal that goes through the normal scanner and
  approval/quarantine path

If the reviewer fails, times out, or returns invalid JSON, the plugin logs a
warning/debug message and skips that review pass.

## Operating Patterns

Use Skill Workshop when the user says:

- “next time, do X”
- “from now on, prefer Y”
- “make sure to verify Z”
- “save this as a workflow”
- “this took a while; remember the process”
- “update the local skill for this”

Good skill text:

```markdown
## Workflow

- Verify the GIF URL resolves to `image/gif`.
- Confirm the file has multiple frames.
- Record source URL, license, and attribution.
- Store a local copy when the asset will ship with the product.
- Verify the local asset renders in the target UI before final reply.
```

Poor skill text:

```markdown
The user asked about a GIF and I searched two websites. Then one was blocked by
Cloudflare. The final answer said to check attribution.
```

Reasons the poor version should not be saved:

- transcript-shaped
- not imperative
- includes noisy one-off details
- does not tell the next agent what to do

## Debugging

Check whether the plugin is loaded:

```bash
openclaw plugins list --enabled
```

Check proposal counts from an agent/tool context:

```json
{ "action": "status" }
```

Inspect pending proposals:

```json
{ "action": "list_pending" }
```

Inspect quarantined proposals:

```json
{ "action": "list_quarantine" }
```

Common symptoms:

| Symptom                               | Likely cause                                                                        | Check                                                                |
| ------------------------------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Tool is unavailable                   | Plugin entry is not enabled                                                         | `plugins.entries.skill-workshop.enabled` and `openclaw plugins list` |
| No automatic proposal appears         | `autoCapture: false`, `reviewMode: "off"`, or thresholds not met                    | Config, proposal status, Gateway logs                                |
| Heuristic did not capture             | User wording did not match correction patterns                                      | Use explicit `skill_workshop.suggest` or enable LLM reviewer         |
| Reviewer did not create a proposal    | Reviewer returned `none`, invalid JSON, or timed out                                | Gateway logs, `reviewTimeoutMs`, thresholds                          |
| Proposal is not applied               | `approvalPolicy: "pending"`                                                         | `list_pending`, then `apply`                                         |
| Proposal disappeared from pending     | Duplicate proposal reused, max pending pruning, or was applied/rejected/quarantined | `status`, `list_pending` with status filters, `list_quarantine`      |
| Skill file exists but model misses it | Skill snapshot not refreshed or skill gating excludes it                            | `openclaw skills` status and workspace skill eligibility             |

Relevant logs:

- `skill-workshop: queued <skill>`
- `skill-workshop: applied <skill>`
- `skill-workshop: quarantined <skill>`
- `skill-workshop: heuristic capture skipped: ...`
- `skill-workshop: reviewer skipped: ...`
- `skill-workshop: reviewer found no update`

## QA Scenarios

Repo-backed QA scenarios:

- `qa/scenarios/plugins/skill-workshop-animated-gif-autocreate.md`
- `qa/scenarios/plugins/skill-workshop-pending-approval.md`
- `qa/scenarios/plugins/skill-workshop-reviewer-autonomous.md`

Run the deterministic coverage:

```bash
pnpm openclaw qa suite \
  --scenario skill-workshop-animated-gif-autocreate \
  --scenario skill-workshop-pending-approval \
  --concurrency 1
```

Run reviewer coverage:

```bash
pnpm openclaw qa suite \
  --scenario skill-workshop-reviewer-autonomous \
  --concurrency 1
```

The reviewer scenario is intentionally separate because it enables
`reviewMode: "llm"` and exercises the embedded reviewer pass.

## When Not To Enable Auto Apply

Avoid `approvalPolicy: "auto"` when:

- the workspace contains sensitive procedures
- the agent is working on untrusted input
- skills are shared across a broad team
- you are still tuning prompts or scanner rules
- the model frequently handles hostile web/email content

Use pending mode first. Switch to auto mode only after reviewing the kind of
skills the agent proposes in that workspace.

## Related Docs

- [Skills](/tools/skills)
- [Plugins](/tools/plugin)
- [Testing](/reference/test)
