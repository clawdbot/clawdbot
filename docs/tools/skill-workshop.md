---
summary: "Create and update workspace skills through Skill Workshop review"
read_when:
  - You want the agent to create or update a skill from chat
  - You need to review, apply, reject, or quarantine a generated skill draft
  - You are configuring Skill Workshop approval, autonomy, storage, or limits
  - You want to understand where self-learning proposals are reviewed
title: "Skill Workshop"
sidebarTitle: "Skill Workshop"
---

Skill Workshop is OpenClaw's governed path for creating and updating workspace
skills. Through this path, agents and operators create a **proposal** (pending
draft with content, target binding, scanner state, hashes, and rollback
metadata) that becomes a live skill only when applied.

Skill Workshop writes workspace skills only. It never touches bundled,
plugin, ClawHub, extra-root, managed, personal-agent, or system skills.

## How it works

- **Proposal first:** generated content is stored as `PROPOSAL.md`, not
  `SKILL.md`.
- **Apply is the only live write:** create, update, and revise never change
  active skills.
- **Workshop-owned updates:** creates target the workspace `skills/` root;
  updates are allowed only when an applied Workshop `create` proposal owns the
  workspace-relative skill directory. Handwritten and externally installed
  workspace skills remain read-only.
- **No clobber:** create fails if the target skill already exists.
- **Hash bound:** update proposals bind to the current target hash and go
  `stale` if the live skill changes before apply.
- **Scanner gated:** apply reruns the security scanner before writing. Only
  critical findings block apply; warn-level findings remain visible but do not
  block it.
- **Recoverable:** apply writes rollback metadata before touching live files.
- **Consistent surfaces:** chat, CLI, and Gateway all call the same service.

## Lifecycle

```text
create/update -> pending
revise        -> pending
evaluate      -> pending
apply         -> applied
reject        -> rejected
quarantine    -> quarantined
target change -> stale
```

Only a `pending` proposal can be revised, applied, rejected, or quarantined.

## Collection review

In `auto` mode, the Gateway starts one isolated collection-review session per
agent workspace each day. The session can only read skills and submit
one complete collection reconciliation. It keeps distinct useful skills,
rewrites weak ones, consolidates overlap, and drops junk or stale fragments.
Choosing `auto` intentionally authorizes those rewrites and drops without a
second approval **for Workshop-owned paths only**; `propose` and `off` do not
run collection review.

Every eligible workspace skill must be read and receive exactly one decision.
Skills without applied Workshop create provenance are read-only and must receive
`keep`; Workshop-owned skills may receive `keep`, `write`, or `drop`. A new
skill created during collection review is recorded as an automatically applied
`create` proposal, which makes that directory Workshop-owned. Disabled and
agent-filtered skills stay untouched.
Shared workspaces use the union of each agent's allowed skills only when
provider, model, and resolved auth identity match. Reconciliation must leave
every sharing agent at least one visible skill.
OpenClaw validates and scans every write before changing the workspace,
serializes collection edits with a workspace lease, and retains one backup
under the state directory. The changed collection appears in new agent runs;
running sessions keep their existing skill snapshot.

To undo the last completed cleanup, ask the agent to restore the skill
collection. It uses `skill_workshop` action `restore_collection` under the same
workspace lock. Restore refuses if any affected skill changed after cleanup.

The daily boundary is persisted per workspace, so Gateway restarts do not
repeat a successful review. Review is admitted only for collections of at most
200 skills and 240,000 total `SKILL.md` bytes. Larger collections stay unchanged.
The reconciled result must stay inside the same byte limit.

## Chat

Ask the agent for the skill you want; it calls `skill_workshop` and returns a
proposal id.

### Learn from recent work

Use `/learn` to route the current conversation or named sources into the best
matching pending proposal or live skill, creating a skill only when needed:

```text
/learn
/learn docs/runbook.md and https://example.com/guide; focus on recovery
```

With no request, `/learn` asks the agent to distill the reusable workflow from
the current conversation. With a request, the agent treats paths, URLs, pasted
notes, and conversation references as sources while honoring focus, scope, and
naming requirements. It gathers the sources with its existing tools, then calls
`skill_workshop` to revise a matching pending proposal, update a matching live
skill, or create a proposal when neither exists.

The resulting proposal stays `pending`; `/learn` never applies it. Review and
apply it through the normal approval flow or with `openclaw skills workshop`.

Create:

```text
Make a skill called morning-catchup that runs my Monday inbox routine.
```

Update an existing workspace skill:

```text
Update trip-planning to also check seat maps before booking.
```

If a skill used in the current turn proves wrong or incomplete, the agent reads
the live skill and creates a targeted patch proposal. A runtime receipt limits
this flow to skills used in that run. Autonomous mode `off` disables repair,
`propose` leaves the patch pending until explicitly applied, and `auto` scans and
applies it immediately. The repaired skill is loaded by new sessions; the
running session keeps its original skill snapshot.

Iterate on a pending proposal:

```text
Show me the morning-catchup proposal.
Revise it to also flag anything marked urgent.
Apply the morning-catchup proposal.
```

Agent-initiated `apply`, `reject`, and `quarantine` run without an additional
approval prompt by default. Set `skills.workshop.approvalPolicy` to `"pending"`
to require operator approval before those actions.

When approval is required, the prompt identifies the proposal id and target
skill, and shows the proposal description, support-file count, and body size.
Approval requests are bounded to finish before the agent tool watchdog. If no
decision arrives before the prompt expires, the lifecycle action does not run:
the proposal stays pending and unchanged. Decide later in the Skill Workshop UI or run
`openclaw skills workshop apply|reject|quarantine <proposal-id>`. Agents should
not retry an expired lifecycle action in a loop.

## CLI

```bash
# Create
openclaw skills workshop propose-create \
  --name morning-catchup \
  --description "Daily inbox catch-up: triage, archive, surface, draft, plan" \
  --proposal ./PROPOSAL.md

# Update an existing workspace skill
openclaw skills workshop propose-update trip-planning --proposal ./PROPOSAL.md

# List and inspect
openclaw skills workshop list
openclaw skills workshop inspect <proposal-id>

# Revise before approval
openclaw skills workshop revise <proposal-id> --proposal ./PROPOSAL.md

# Run installed plugin evaluators against the exact current draft
openclaw skills workshop evaluate <proposal-id>

# Close out
openclaw skills workshop apply <proposal-id>
openclaw skills workshop reject <proposal-id> --reason "Duplicate"
openclaw skills workshop quarantine <proposal-id> --reason "Needs security review"
```

Every subcommand takes `--agent <id>` (target workspace; defaults to
cwd-inferred, then the default agent) and `--json` (structured output).
`propose-create`, `propose-update`, and `revise` also take `--goal <text>` and
`--evidence <text>` to record proposal context alongside `--proposal`.
`evaluate` runs through the live Gateway plugin registry, snapshots the current
proposal revision before dispatch, and accepts `--correlation-id <id>` for external
orchestration.

## Plugin evaluation and lifecycle hooks

Gateway plugins can extend Skill Workshop without owning proposal storage or
live skill writes:

- `skill_proposal_evaluate` receives an exact candidate bundle and, for update
  proposals, the complete baseline skill. It returns attributed findings,
  metrics, and an optional `pass`, `revise`, or `block` decision.
- `skill_proposal_changed` observes durable `created`, `revised`,
  `evaluation_completed`, `applied`, `rejected`, `quarantined`, and `stale`
  events.
- `skill_changed` observes committed live skill `created`, `updated`, and
  `removed` events from Workshop and supported install/uninstall paths.

Evaluations are explicit from the CLI, Control UI, Gateway
`skills.proposals.evaluate` method, or agent `skill_workshop` action. Results
are stored on the exact proposal revision and in the append-only proposal event
ledger. Evaluator failures remain attributed results; only a completed
`decision: "block"` prevents apply. Apply also revalidates the evaluated target
tree, so any live skill asset drift requires a fresh evaluation.

The lifecycle supports external optimization loops without embedding one.
Controllers can consume `skills.proposals.events.list`, evaluate an exact
`revisionHash`, revise with `expectedRevisionHash` and `correlationId`, then continue
from the returned event sequence. OpenClaw does not schedule, auto-revise, or
decide when such a loop should stop.

## Proposal content

While pending, the proposal is stored as `PROPOSAL.md` with proposal-only
frontmatter:

```markdown
---
name: "morning-catchup"
description: "Daily inbox catch-up: triage, archive, surface, draft, plan"
status: proposal
version: "v1"
date: "2026-05-30T00:00:00.000Z"
---
```

On apply, Skill Workshop writes the active `SKILL.md` and removes the
proposal-only fields: `status`, proposal `version`, and proposal `date`.

## Support files

Use `--proposal-dir` when the proposed skill needs files beside
`PROPOSAL.md`:

```bash
openclaw skills workshop propose-create \
  --name weekly-update \
  --description "Friday wrap-up: stats, highlights, next week's top three" \
  --proposal-dir ./weekly-update-proposal
```

The directory must contain `PROPOSAL.md`. Support files must live under
`assets/`, `examples/`, `references/`, `scripts/`, or `templates/`. Skill
Workshop scans, hashes, and stores them with the proposal, then writes them
beside the live `SKILL.md` only on apply.

Rejected support-file paths: absolute paths, hidden path segments, path
traversal, overlapping paths, executable files, non-UTF-8 text, null bytes,
and paths outside the standard support folders.

## Agent tool

The model uses `skill_workshop` with one required `action`:
`create | read | patch | update | revise | list | inspect | evaluate | apply | reject | quarantine`.
Other parameters apply depending on the action:

| Parameter                  | Used by                                                          | Notes                                                                |
| -------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------- |
| `name`                     | `create`, `inspect`, `revise`                                    | Required for `create`; resolves a pending proposal by name otherwise |
| `description`              | `create`, `update`, `revise`                                     | Max 160 bytes                                                        |
| `skill_name`               | `read`, `patch`, `update`                                        | Existing skill name or key                                           |
| `old_string`, `new_string` | `patch`                                                          | Exact current text and its replacement; read the skill first         |
| `proposal_content`         | `create`, `update`, `revise`                                     | Required for create/update; omit on revise to preserve the body      |
| `support_files`            | `create`, `update`, `revise`                                     | Array of `{ path, content }`                                         |
| `goal`, `evidence`         | `create`, `update`, `revise`                                     | Free-text context                                                    |
| `proposal_id`              | `inspect`, `revise`, `evaluate`, `apply`, `reject`, `quarantine` | Target proposal                                                      |
| `expected_revision_hash`   | `evaluate`, `apply`, `reject`, `quarantine`                      | Rejects a stale orchestration step                                   |
| `correlation_id`           | `evaluate`, `revise`, `apply`, `reject`, `quarantine`            | External run or experiment correlation                               |
| `reason`                   | `apply`, `reject`, `quarantine`                                  | Optional                                                             |
| `query`, `status`, `limit` | `list`                                                           | Filter/paginate; `limit` max 50, default 20                          |

Agents must use `skill_workshop` for generated skill work and must not create or
change skill or proposal files directly. This rule is advisory and
prompt-enforced. A hard guard is not currently possible at the tool-policy seam.

<Note>
`skill_workshop` is a built-in agent tool and is included in
`tools.profile: "coding"`. If a stricter policy hides it, add
`skill_workshop` to the active `tools.allow` list, or use
`tools.alsoAllow: ["skill_workshop"]` when the scope uses a profile without an
explicit `tools.allow`. Sandboxed runs do not construct the host-side
Skill Workshop tool, so run proposal review actions from a normal host-side
agent session or the CLI.
</Note>

## Self-learning

After substantial work, an isolated background review can turn corrections and
successful procedures into Workshop proposals; see
[Self-learning](/tools/self-learning). Set `skills.workshop.autonomous.mode` to
`propose` to create pending proposals, or to `auto` to apply scanner-approved
captures through the normal Workshop service. The Control UI Workshop tab shows
whether self-learning is on; use the config setting to choose all three modes.

### Scan past sessions

The Control UI can review older work without enabling autonomous self-learning.
Open **Plugins → Workshop** and select **Find skill ideas**. The scan starts with
the newest eligible sessions and reviews a bounded window of substantial work.
It skips cron, heartbeat, hook, subagent, ACP, plugin-owned, and internal review
sessions, plus conversations with fewer than six model turns.

The reviewer uses the selected agent's configured model and receives a
secret-redacted, size-bounded transcript bundle. It applies the same conservative
bar as experience review: a concrete recovery pattern or a stable procedure that
would remove at least two future model or tool calls. Routine work and one-off
facts should produce no proposal.

One scan can create or revise at most three pending proposals. It cannot apply,
reject, quarantine, or edit a live skill. The Workshop shows cumulative coverage,
for example **20 sessions reviewed · Jun 18–today · 2 ideas found**. Select
**Scan earlier work** to continue from the persisted oldest-session cursor. After
the available history is exhausted, the action becomes **Scan new work**.

Historical review is manual even when
`skills.workshop.autonomous.mode` is `off`. Each click starts a model run,
so provider pricing and data-handling terms apply. The cursor and coverage counts
are stored in the shared OpenClaw state database; transcript content is not copied
into scan state.

In `propose` and `auto` modes, OpenClaw can also perform a conservative review after successful,
substantial work and after the whole agent system becomes idle. The review receives an
authoritative receipt of skills the foreground run actually used. It can draft at most one pending
proposal: a new skill, a patch or full-body rewrite of an existing workspace skill, or a revision
of a pending proposal. Existing skills must be read before either update form, and the proposal is
bound to that exact content hash. The reviewer never writes a live skill directly and cannot
apply, reject, or quarantine a proposal. In `auto` mode, the orchestrating pipeline applies every
autonomous result afterward through the normal scanner-gated service, without operator review.

See [Self-learning](/tools/self-learning) for enablement, eligibility, privacy and cost details,
the proposal threshold, and troubleshooting.

## Approval and autonomy

```json5
{
  skills: {
    workshop: {
      autonomous: {
        mode: "auto",
      },
      allowSymlinkTargetWrites: false,
      approvalPolicy: "auto",
      maxPending: 50,
      maxSkillBytes: 40000,
    },
  },
}
```

| Setting                    | Default  | Effect                                                                                                                                                                          |
| -------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `autonomous.mode`          | `"auto"` | `"off"` disables autonomous capture, `"propose"` creates pending captures, and `"auto"` applies captures and runs daily cleanup that can rewrite or drop Workshop-owned skills. |
| `allowSymlinkTargetWrites` | `false`  | Lets apply write through workspace skill symlinks whose real target is listed in `skills.load.allowSymlinkTargets`.                                                             |
| `approvalPolicy`           | `"auto"` | `"auto"` skips an additional prompt for agent-initiated `apply`, `reject`, or `quarantine` (the agent still has to call the action). `"pending"` requires approval.             |
| `maxPending`               | `50`     | Caps pending and quarantined proposals per workspace (1-200).                                                                                                                   |
| `maxSkillBytes`            | `40000`  | Caps proposal body size in bytes (1024-200000).                                                                                                                                 |

In `propose` and `auto` modes, an isolated run of the selected model decides whether the
completed trajectory clears the evidence-gated proposal bar. The foreground model is not prompted
to learn before it replies. The background reviewer preserves the foreground run as proposal
provenance, cannot access general agent tools, and cannot make lifecycle decisions. In `auto`
mode, the capture pipeline applies every autonomous proposal only after the isolated run
completes. Existing-skill changes require a complete read receipt and content-hash binding before
they are eligible for that apply step. The review starts
only when the foreground runtime reports its resolved model
and that `skill_workshop` was actually available. Restrictive or unknown tool policy therefore
fails closed and creates no proposal.

See [Self-learning](/tools/self-learning) for the complete autonomous review behavior and safety
model.

Proposal descriptions are always capped at 160 bytes, independent of
`maxSkillBytes`.

## Gateway methods

| Method                             | Scope            |
| ---------------------------------- | ---------------- |
| `skills.proposals.list`            | `operator.read`  |
| `skills.proposals.inspect`         | `operator.read`  |
| `skills.proposals.historyStatus`   | `operator.read`  |
| `skills.proposals.historyScan`     | `operator.admin` |
| `skills.proposals.create`          | `operator.admin` |
| `skills.proposals.update`          | `operator.admin` |
| `skills.proposals.revise`          | `operator.admin` |
| `skills.proposals.requestRevision` | `operator.admin` |
| `skills.proposals.apply`           | `operator.admin` |
| `skills.proposals.reject`          | `operator.admin` |
| `skills.proposals.quarantine`      | `operator.admin` |
| `skills.curator.status`            | `operator.read`  |
| `skills.curator.pin`               | `operator.admin` |
| `skills.curator.unpin`             | `operator.admin` |
| `skills.curator.restore`           | `operator.admin` |

The `skills.curator.*` methods remain for lifecycle state written by older
releases. Daily collection review does not use age, pin, or overlap state.

`requestRevision` is Gateway-only (no CLI or agent-tool equivalent): it
forwards free-text revision instructions to the owning agent's chat session
instead of replacing `PROPOSAL.md` directly, for UIs that ask the agent to
revise rather than submit literal new content.

`historyStatus` and `historyScan` are Control UI support methods. `historyScan`
accepts `direction: "older" | "newer"`; it always leaves results as pending
proposals.

## Storage

```text
<OPENCLAW_STATE_DIR>/
  state/openclaw.sqlite
  skill-workshop/proposals/<proposal-id>/
    PROPOSAL.md
    assets/
    examples/
    references/
    scripts/
    templates/
```

Default state directory: `~/.openclaw`.

- `state/openclaw.sqlite`: canonical proposal records, lifecycle status, origin attribution, and apply rollback metadata.
- `PROPOSAL.md`: pending skill proposal.
- Support files remain beside `PROPOSAL.md` so operators can review the proposed skill as a normal directory.

`openclaw doctor --fix` imports the previous `proposals.json`, `proposal.json`, and
`rollback.json` metadata into SQLite after verifying each proposal, then removes
the migrated JSON files. If an agent's configured workspace changes, its earlier
proposals remain listed with a previous-workspace marker instead of disappearing.

## Limits

| Limit                           | Value                                                                        |
| ------------------------------- | ---------------------------------------------------------------------------- |
| Description                     | 160 bytes                                                                    |
| Proposal body                   | `skills.workshop.maxSkillBytes` (default 40,000; hard ceiling 200,000 bytes) |
| Support files                   | 64 per proposal                                                              |
| Support file size               | 256 KiB each, 2 MiB total                                                    |
| Pending + quarantined proposals | `skills.workshop.maxPending` per workspace (default 50)                      |

## Troubleshooting

| Problem                                        | Resolution                                                                                                                                                                                                  |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Skill proposal description is too large`      | Shorten `description` to 160 bytes or less.                                                                                                                                                                 |
| `Skill proposal content is too large`          | Shorten the proposal body or raise `skills.workshop.maxSkillBytes`.                                                                                                                                         |
| `Target skill changed after proposal creation` | Revise the proposal against the current target, or create a new proposal.                                                                                                                                   |
| `Proposal scan failed`                         | Inspect scanner findings, then revise or quarantine the proposal.                                                                                                                                           |
| `untrusted symlink target`                     | Configure `skills.load.allowSymlinkTargets` and enable `skills.workshop.allowSymlinkTargetWrites` only for intentional shared skill roots.                                                                  |
| `Support file paths must be under one of...`   | Move support files under `assets/`, `examples/`, `references/`, `scripts/`, or `templates/`.                                                                                                                |
| Proposal does not show in list                 | Check the selected `--agent` workspace and `OPENCLAW_STATE_DIR`.                                                                                                                                            |
| Agent cannot call `skill_workshop`             | Check the active tool policy and run mode. `coding` includes the tool; restrictive `tools.allow` policies must list it explicitly, and sandboxed runs must use a normal host-side agent session or the CLI. |

### Tool-policy diagnostic

In `propose` and `auto` modes, `openclaw doctor` runs the
`core/doctor/skill-workshop-tool-policy` check for the default agent. If policy
hides `skill_workshop`, the warning names the first excluding config layer and
the exact `allow` or `alsoAllow` change to make. Older runbooks may still use
`openclaw plugins inspect skill-workshop`; that command now explains that Skill
Workshop is built in and prints the same policy hint when applicable.

## Related

- [Skills](/tools/skills) for load order, precedence, and visibility
- [Self-learning](/tools/self-learning) for conservative post-run skill proposals
- [Creating skills](/tools/creating-skills) for hand-written `SKILL.md`
  basics
- [Skills config](/tools/skills-config) for the full `skills.workshop` schema
- [Skills CLI](/cli/skills) for `openclaw skills` commands
