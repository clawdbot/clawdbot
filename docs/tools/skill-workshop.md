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
skills. Agents and operators never write `SKILL.md` directly through this
path — they create a **proposal** (pending draft with content, target
binding, scanner state, hashes, and rollback metadata) that becomes a live
skill only when applied.

Skill Workshop writes workspace skills only. It never touches bundled,
plugin, ClawHub, extra-root, managed, personal-agent, or system skills.

## How it works

- **Proposal first:** generated content is stored as `PROPOSAL.md`, not
  `SKILL.md`.
- **Apply is the only live write:** create, update, and revise never change
  active skills.
- **Workspace scoped:** creates target the workspace `skills/` root; updates
  are allowed only for writable workspace skills.
- **No clobber:** create fails if the target skill already exists.
- **Hash bound:** update proposals bind to the current target hash and go
  `stale` if the live skill changes before apply.
- **Scanner gated:** apply reruns the security scanner before writing.
- **Recoverable:** apply writes rollback metadata before touching live files.
- **Consistent surfaces:** chat, CLI, and Gateway all call the same service.

## Lifecycle

```text
create/update -> pending
revise        -> pending
apply         -> applied
reject        -> rejected
quarantine    -> quarantined
target change -> stale
```

Only a `pending` proposal can be revised, applied, rejected, or quarantined.

## Lifecycle curation

The Gateway tracks aggregate skill usage in the shared state database. Once a
day, it reviews skills created and applied by Skill Workshop. Skills unused for
more than 30 days become `stale`; after 90 days they become `archived` and are
left out of new agent skill snapshots. Archived skill files remain unchanged on
disk. Manually authored skills are never curated; only skills created by Skill
Workshop proposals enter lifecycle curation.

Pinned skills bypass lifecycle transitions. A stale skill returns to `active`
after it is used and the next sweep runs. Archived skills return only through an
explicit restore:

Lifecycle transitions and restores apply to new sessions; running sessions keep
their current skill snapshot.

```bash
openclaw skills curator status
openclaw skills curator pin <skill>
openclaw skills curator unpin <skill>
openclaw skills curator restore <skill>
```

All curator commands accept `--json`. Status also reports deterministic overlap
candidates as suggestions only; it never merges skills or calls a model.

## Chat

Ask the agent for the skill you want; it calls `skill_workshop` and returns a
proposal id.

### Learn from recent work

Use `/learn` to turn the current conversation or named sources into one
standards-guided skill proposal:

```text
/learn
/learn docs/runbook.md and https://example.com/guide; focus on recovery
```

With no request, `/learn` asks the agent to distill the reusable workflow from
the current conversation. With a request, the agent treats paths, URLs, pasted
notes, and conversation references as sources while honoring focus, scope, and
naming requirements. It gathers the sources with its existing tools, then calls
`skill_workshop` with `action: "create"`.

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

Iterate on a pending proposal:

```text
Show me the morning-catchup proposal.
Revise it to also flag anything marked urgent.
Apply the morning-catchup proposal.
```

Agent-initiated `apply`, `reject`, and `quarantine` show an approval prompt by
default. Set `skills.workshop.approvalPolicy` to `"auto"` to skip it in
trusted environments.

The prompt identifies the proposal id and target skill, and shows the proposal
description, support-file count, and body size. Approval requests are bounded
to finish before the agent tool watchdog. If no decision arrives before the
prompt expires, the lifecycle action does not run: the proposal stays pending
and unchanged. Decide later in the Skill Workshop UI or run
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

# Close out
openclaw skills workshop apply <proposal-id>
openclaw skills workshop reject <proposal-id> --reason "Duplicate"
openclaw skills workshop quarantine <proposal-id> --reason "Needs security review"
```

Every subcommand takes `--agent <id>` (target workspace; defaults to
cwd-inferred, then the default agent) and `--json` (structured output).
`propose-create`, `propose-update`, and `revise` also take `--goal <text>` and
`--evidence <text>` to record proposal context alongside `--proposal`.

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
`create | update | revise | list | inspect | apply | reject | quarantine`.
Other parameters apply depending on the action:

| Parameter                  | Used by                                              | Notes                                                                |
| -------------------------- | ---------------------------------------------------- | -------------------------------------------------------------------- |
| `name`                     | `create`, `inspect`, `revise`                        | Required for `create`; resolves a pending proposal by name otherwise |
| `description`              | `create`, `update`, `revise`                         | Max 160 bytes                                                        |
| `skill_name`               | `update`                                             | Existing skill name or key                                           |
| `proposal_content`         | `create`, `update`, `revise`                         | Stored as `PROPOSAL.md`; capped by `skills.workshop.maxSkillBytes`   |
| `support_files`            | `create`, `update`, `revise`                         | Array of `{ path, content }`                                         |
| `goal`, `evidence`         | `create`, `update`, `revise`                         | Free-text context                                                    |
| `proposal_id`              | `inspect`, `revise`, `apply`, `reject`, `quarantine` | Target proposal                                                      |
| `reason`                   | `apply`, `reject`, `quarantine`                      | Optional                                                             |
| `query`, `status`, `limit` | `list`                                               | Filter/paginate; `limit` max 50, default 20                          |

Agents must use `skill_workshop` for generated skill work. They must not
create or change proposal files through `write`, `edit`, `exec`, shell
commands, or direct filesystem operations.

<Note>
`skill_workshop` is a built-in agent tool and is included in
`tools.profile: "coding"`. If a stricter policy hides it, add
`skill_workshop` to the active `tools.allow` list, or use
`tools.alsoAllow: ["skill_workshop"]` when the scope uses a profile without an
explicit `tools.allow`. Sandboxed runs do not construct the host-side
Skill Workshop tool, so run proposal review actions from a normal host-side
agent session or the CLI.
</Note>

## Suggested skills

OpenClaw detects durable instructions such as “next time,” “remember to,” and reactive corrections
when an interactive turn ends, including failed turns. On the next turn, the agent offers to save
the most recent detected workflow through `skill_workshop`; the user decides whether to create a
proposal. This built-in suggestion does not create or change a skill by itself. Enable
`skills.workshop.autonomous.enabled` to create pending proposals directly instead. In the Control
UI, the Workshop tab offers the same setting as a **Self-learning** toggle in the page header, and
as an enable button on the empty proposal board.

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
`skills.workshop.autonomous.enabled` is `false`. Each click starts a model run,
so provider pricing and data-handling terms apply. The cursor and coverage counts
are stored in the shared OpenClaw state database; transcript content is not copied
into scan state.

With autonomous capture enabled, OpenClaw can also perform a conservative review after successful,
substantial work and after the whole agent system becomes idle. That isolated review can create or
revise at most one pending proposal. It cannot update a live skill or apply, reject, or quarantine a
proposal, even when `approvalPolicy` is `"auto"`.

See [Self-learning](/tools/self-learning) for enablement, eligibility, privacy and cost details,
the proposal threshold, and troubleshooting.

## Approval and autonomy

```json5
{
  skills: {
    workshop: {
      autonomous: {
        enabled: false,
      },
      allowSymlinkTargetWrites: false,
      approvalPolicy: "pending",
      maxPending: 50,
      maxSkillBytes: 40000,
    },
  },
}
```

| Setting                    | Default     | Effect                                                                                                                                                                 |
| -------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `autonomous.enabled`       | `false`     | Creates pending proposals from explicit corrections and, after an idle delay, substantial completed work with reusable recovery or meaningful round-trip savings.      |
| `allowSymlinkTargetWrites` | `false`     | Lets apply write through workspace skill symlinks whose real target is listed in `skills.load.allowSymlinkTargets`.                                                    |
| `approvalPolicy`           | `"pending"` | `"pending"` requires an approval prompt before agent-initiated `apply`, `reject`, or `quarantine`. `"auto"` skips the prompt (the agent still has to call the action). |
| `maxPending`               | `50`        | Caps pending and quarantined proposals per workspace (1-200).                                                                                                          |
| `maxSkillBytes`            | `40000`     | Caps proposal body size in bytes (1024-200000).                                                                                                                        |

Autonomous capture recognizes prospective rules (for example, “from now on”) and reactive
corrections (for example, “that’s not what I asked”). It groups new instructions by topic into up
to three proposals per turn, routes vocabulary matches to existing writable workspace skills, and
revises its own pending proposal when another correction targets the same skill.

For successful substantial work without an explicit correction, an isolated run of the selected
model decides whether the completed trajectory clears the conservative proposal bar. The
foreground model is not prompted to learn before it replies. The background reviewer preserves the
foreground run as proposal provenance, cannot access general agent tools, and cannot make lifecycle
decisions. The review starts only when the foreground runtime reports both its exact resolved model
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

`requestRevision` is Gateway-only (no CLI or agent-tool equivalent): it
forwards free-text revision instructions to the owning agent's chat session
instead of replacing `PROPOSAL.md` directly, for UIs that ask the agent to
revise rather than submit literal new content.

`historyStatus` and `historyScan` are Control UI support methods. `historyScan`
accepts `direction: "older" | "newer"`; it always leaves results as pending
proposals.

## Storage

```text
<OPENCLAW_STATE_DIR>/skill-workshop/
  proposals.json
  proposals/<proposal-id>/
    proposal.json
    PROPOSAL.md
    rollback.json
    assets/
    examples/
    references/
    scripts/
    templates/
```

Default state directory: `~/.openclaw`.

- `proposal.json`: canonical proposal record.
- `proposals.json`: fast listing index, rebuildable from proposal folders.
- `PROPOSAL.md`: pending skill proposal.
- `rollback.json`: recovery metadata written before apply changes live files.

## Limits

| Limit                           | Value                                                                |
| ------------------------------- | -------------------------------------------------------------------- |
| Description                     | 160 bytes                                                            |
| Proposal body                   | `skills.workshop.maxSkillBytes` (default 40,000; hard ceiling 1 MiB) |
| Support files                   | 64 per proposal                                                      |
| Support file size               | 256 KiB each, 2 MiB total                                            |
| Pending + quarantined proposals | `skills.workshop.maxPending` per workspace (default 50)              |

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

When autonomous capture is enabled, `openclaw doctor` runs the
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
