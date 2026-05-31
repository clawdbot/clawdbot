---
summary: "Create and update workspace skills through Skill Workshop review"
read_when:
  - You want the agent to create or update a skill from chat
  - You need to review, apply, reject, or quarantine a generated skill draft
  - You are configuring Skill Workshop approval, autonomy, storage, or limits
title: "Skill Workshop"
sidebarTitle: "Skill Workshop"
---

Skill Workshop is OpenClaw's governed path for creating and updating workspace
skills.

Agents and operators do not write active `SKILL.md` files directly through this
path. They create a **proposal** first. A proposal is a pending draft containing
the proposed skill content, target binding, scanner state, hashes, support-file
metadata, and rollback metadata. It becomes a live skill only when applied.

Skill Workshop writes workspace skills only. It does not mutate bundled,
plugin, ClawHub, extra-root, managed, personal-agent, or system skills.

## How it works

- **Proposal first:** generated skill content is stored as `PROPOSAL.md`, not
  `SKILL.md`.
- **Apply is the only live write:** create, update, and revise do not change
  active skills.
- **Workspace scoped:** creates target the workspace `skills/` root. Updates
  are allowed only for writable workspace skills.
- **No clobber:** create fails if the target skill already exists.
- **Hash bound:** update proposals bind to the current target hash and become
  stale if the live skill changes before apply.
- **Scanner gated:** apply reruns scanning before writing.
- **Recoverable:** apply writes rollback metadata before changing live files.
- **Consistent surfaces:** chat, CLI, and Gateway all call the same Skill
  Workshop service.

## Lifecycle

```text
create/update -> pending
revise        -> pending
apply         -> applied
reject        -> rejected
quarantine    -> quarantined
target change -> stale
```

Only `pending` proposals can be revised, applied, rejected, or quarantined.

## Chat

Ask the agent for the skill you want. The agent calls `skill_workshop` and
returns a proposal id.

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

By default, agent-initiated `apply`, `reject`, and `quarantine` show an
approval prompt before they run. Set `skills.workshop.approvalPolicy` to
`"auto"` to skip the prompt for trusted environments.

## CLI

Create a new skill proposal:

```bash
openclaw skills workshop propose-create \
  --name morning-catchup \
  --description "Daily inbox catch-up: triage, archive, surface, draft, plan" \
  --proposal ./PROPOSAL.md
```

Create an update proposal for an existing workspace skill:

```bash
openclaw skills workshop propose-update trip-planning --proposal ./PROPOSAL.md
```

List and inspect:

```bash
openclaw skills workshop list
openclaw skills workshop inspect <proposal-id>
```

Revise before approval:

```bash
openclaw skills workshop revise <proposal-id> --proposal ./PROPOSAL.md
```

Close out the proposal:

```bash
openclaw skills workshop apply <proposal-id>
openclaw skills workshop reject <proposal-id> --reason "Duplicate"
openclaw skills workshop quarantine <proposal-id> --reason "Needs security review"
```

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

On apply, Skill Workshop writes the active `SKILL.md` and removes proposal-only
fields: `status`, proposal `version`, and proposal `date`.

## Support files

Use `--proposal-dir` when the proposed skill needs files beside `PROPOSAL.md`:

```bash
openclaw skills workshop propose-create \
  --name weekly-update \
  --description "Friday wrap-up: stats, highlights, next week's top three" \
  --proposal-dir ./weekly-update-proposal
```

The directory must contain `PROPOSAL.md`. Support files must be under:

- `assets/`
- `examples/`
- `references/`
- `scripts/`
- `templates/`

Skill Workshop scans, hashes, and stores support files with the proposal. They
are written beside the live `SKILL.md` only on apply.

Rejected support-file paths include absolute paths, hidden path segments, path
traversal, overlapping paths, executable files from proposal directories,
non-UTF-8 text, null bytes, and files outside the standard support folders.

## Agent tool

The model uses `skill_workshop`:

```text
action: create | update | revise | list | inspect | apply | reject | quarantine
```

Agents must use `skill_workshop` for generated skill work. They must not create
or change proposal files through `write`, `edit`, `exec`, shell commands, or
direct filesystem operations.

## Approval and autonomy

```json5
{
  skills: {
    workshop: {
      autonomous: {
        enabled: false,
      },
      approvalPolicy: "pending",
      maxPending: 50,
      maxSkillBytes: 40000,
    },
  },
}
```

- `autonomous.enabled`: allows OpenClaw to create pending proposals from durable
  conversation signals after successful turns. Default: `false`.
- `approvalPolicy: "pending"`: requires an approval prompt before
  agent-initiated `apply`, `reject`, or `quarantine`.
- `approvalPolicy: "auto"`: skips that approval prompt. The agent must still
  call the action.
- `maxPending`: caps pending and quarantined proposals per workspace.
- `maxSkillBytes`: caps proposal body size. Default: `40000`.

Proposal descriptions are always capped at 160 bytes.

## Gateway methods

```text
skills.proposals.list
skills.proposals.inspect
skills.proposals.create
skills.proposals.update
skills.proposals.revise
skills.proposals.apply
skills.proposals.reject
skills.proposals.quarantine
```

Read-only methods require `operator.read`. Mutating methods require
`operator.admin`.

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

- Description: 160 bytes.
- Proposal body: `skills.workshop.maxSkillBytes` (default 40,000).
- Support files: 64 per proposal.
- Support file size: 256 KB each, 2 MB total.
- Pending and quarantined proposals: `skills.workshop.maxPending` per workspace
  (default 50).

## Troubleshooting

| Problem                                        | Resolution                                                                                   |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `Skill proposal description is too large`      | Shorten `description` to 160 bytes or less.                                                  |
| `Skill proposal content is too large`          | Shorten the proposal body or raise `skills.workshop.maxSkillBytes`.                          |
| `Target skill changed after proposal creation` | Revise the proposal against the current target, or create a new proposal.                    |
| `Proposal scan failed`                         | Inspect scanner findings, then revise or quarantine the proposal.                            |
| `Support file paths must be under one of...`   | Move support files under `assets/`, `examples/`, `references/`, `scripts/`, or `templates/`. |
| Proposal does not show in list                 | Check the selected `--agent` workspace and `OPENCLAW_STATE_DIR`.                             |

## Related

- [Skills](/tools/skills) for load order, precedence, and visibility
- [Creating skills](/tools/creating-skills) for hand-written `SKILL.md`
  basics
- [Skills config](/tools/skills-config) for the full `skills.workshop` schema
- [Skills CLI](/cli/skills) for `openclaw skills` commands
