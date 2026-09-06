---
summary: "Create Workshop-generated skills and profile-owned personal skills through Skill Workshop"
read_when:
  - You want the agent to create or update a skill from chat
  - You need to review, apply, reject, or quarantine a generated skill draft
  - You are configuring Skill Workshop approval, autonomy, storage, or limits
  - You want to understand where self-learning proposals are reviewed
title: "Skill Workshop"
sidebarTitle: "Skill Workshop"
---

Skill Workshop is OpenClaw's governed path for creating and updating its own
generated skills. Through this path, agents and operators create a **proposal** (pending
draft with content, target binding, scanner state, hashes, and rollback
metadata) that becomes a live skill only when applied.

By default, Skill Workshop writes only under the active agent's
`<state-dir>/agents/<agentId>/agent/workshop-skills`. When `agents.entries.<id>.agentDir` is
configured, it writes under `<agentDir>/workshop-skills` instead. Operators edit
bundled, plugin, ClawHub, extra-root, managed, personal-agent, project, and
workspace skills through their owning tools or files. The same authoring tool
also supports [personal library skills](/tools/skills#personal-skills-on-a-shared-gateway)
when the Gateway supplies an authorized library target; those operations publish
managed revisions rather than Workshop proposals.

Workshop storage is installation-managed and separate from the session
workspace and managed skill library. `OPENCLAW_STATE_DIR` selects the state
directory; `~/.openclaw` is the default.

## Personal library authoring

On a shared Gateway, ask the agent normally: **Create a skill for me that
summarizes a reviewed change list.** The authenticated requester owns the
result, even when another person created or owns the session. No separate
authoring mode or identity argument is required. A single administrator keeps
the Workshop workflow by default; explicitly ask for a personal-library skill
when that is the intended destination.

Personal create and update operations publish complete managed revisions after
validation and scanning. The response identifies the skill and revision and
explains when it becomes available. Publication does not replace the current
session's selection: ask to attach or refresh it explicitly for the next turn.
Read before updating: the response includes the human-facing `slug`, generated
command `name`, revision, and personal edit permission. The update parameter
`name` means the slug, not the command name. Omit `name` or `proposal_content`
on update to preserve them.

For personal model operations, `files` contains named support-file upserts;
omitting it or passing `[]` preserves all other files. Omitted executable flags
are preserved too. Use `delete_files` to intentionally remove exact supporting
paths. Duplicate or conflicting edits and removal of `SKILL.md` are rejected;
change its full body with `proposal_content`. Operator `skills.library.save`
continues to replace the complete bundle.

Use `read` with `artifact_path` to read one whole UTF-8 support file, defaulting
to `SKILL.md`. Binary or oversized artifacts produce a visible omission and
direct you to My skills or the CLI; they are never returned as partial
instructions or a base64 dump. Personal authoring has no pending-draft action:
unsolicited improvements are suggestions, not publications.

Personal mutations require a current, authenticated human turn. Autonomous
reviews, cron jobs, and child runs do not acquire fresh personal authoring
permission. If a different person steers an active authoring turn, send a fresh
attributed message before publishing. Sharing makes a skill usable by the team;
only an administrator can transfer its management ownership to the team.

## How it works

The following lifecycle applies to Workshop proposals:

- **Proposal first:** generated content is stored as `PROPOSAL.md`, not
  `SKILL.md`.
- **Apply is the only live write:** create, update, and revise never change
  active skills.
- **Directory-owned updates:** creates and updates stay inside
  `<state-dir>/agents/<agentId>/agent/workshop-skills`. A skill is Workshop-owned
  exactly when it is contained in that agent's directory.
- **No clobber:** create fails if the target already exists in that agent's
  Workshop directory. Skills from other sources are never changed.
  For same-named skills, [loading order](/tools/skills#loading-order) determines
  which definition is used.
- **Hash bound:** update proposals bind to the current target hash and go
  `stale` if the live skill changes before apply.
- **Scanner gated:** apply reruns the security scanner before writing. Only
  critical findings block apply; warn-level findings remain visible but do not
  block it.
- **Recoverable:** apply writes rollback metadata before touching live files.
- **Revision atomic:** create and revise flush a complete immutable proposal
  generation, publish it with an atomic rename, then sync its parent directory
  where supported before publishing the SQLite record and event together.
  Process interruption exposes either the complete previous generation or the
  complete new one.
- **Consistent surfaces:** chat, CLI, and Gateway all call the same service.

## Review in the Control UI

Open **Plugins → Workshop** and select the agent whose skills you want to inspect.

- **Skills** opens by default and lists the skills currently installed in that
  agent's Workshop directory. Skills with instruction changes appear first.
  Select one to compare its saved applied instructions with the current skill.
  Unchanged skills show their current instructions.
- **Suggestions** contains pending proposals that you can evaluate, revise,
  apply, or reject.

Past applied, rejected, quarantined, and stale proposals remain available through
CLI and Gateway inspection. They are not listed as a separate Control UI section
or counted as installed skills.

Comparisons use retained applied versions, not a complete edit timeline.
Relative dates identify the saved baseline, not when later edits occurred.
Supporting files and frontmatter are not compared. Missing versions and shortened
diffs are labeled; no historical content is reconstructed.
If the preview omits changed lines, the current instructions remain readable.

Removing an installed skill does not remove its proposal history. Reading a
historical draft does not restore or reinstall it. Handwritten and externally
installed skills remain on their owning skills surfaces.

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

In `auto` mode, the Gateway maintains one weekly automation per agent. It is
a normal isolated agent turn: cron owns scheduling, cancellation, and run
history. `propose` and `off` disable these reviews.

The reviewer reads and edits the agent's Workshop directory with normal file
tools. Directory listings are paged to fit the selected model instead of putting
every file path into the initial prompt. The reviewer follows each continuation
before changing that directory.
Skill contents are review material, not active instructions. It keeps useful
procedures, simplifies bloated skills, consolidates overlap, and removes obsolete
files. Absence of use in the current run never justifies removal. Usage tracking
and experience review remain active; weekly cleanup does not receive a separate
usage table.

The file tools stay rooted at the Workshop directory. Shell commands use the
operator's existing cron execution and approval policy; enabling review does not
grant additional shell access. An approval-required policy can refuse unattended
shell commands; a full-access policy permits them. File discovery does not need a shell.

Reviews require the embedded runtime. If an enabled sandbox has
`workspaceAccess: "ro"` or `"none"`, the turn refuses to run rather than editing
a disposable copy. A writable sandbox uses the agent's Workshop directory.
Sandbox backends must support directory reads to provide shell-free discovery.
Bundled backends use their existing filesystem permissions for these reads.

### Changes and recovery

Collection review follows normal agent file-edit semantics. Completed edits
remain if a later step fails or the turn is cancelled. There is no collection-wide
transaction, post-turn scanner, automatic rollback, or separate review history
writer. This also prevents a failed review from restoring an old tree over
concurrent operator edits. Per-skill proposal validation, scanning, and apply
behavior described above are unchanged.

The reviewer ends with a summary of changes and removal reasons, or why no change
was needed. Find it in the automation's run history. Reviews do not announce into
a conversation. Future sessions load changed skills; running sessions retain
their existing instruction snapshot.

Existing collection backups are preserved. The `restore_collection` action
can restore a retained backup from the previous review implementation, but new
reviews do not create collection backups. The `history` action reads those
historical review records; current results belong to automation history.
Restore refuses to overwrite affected skills changed after that backup.

### When an older backup cannot be restored automatically

Restore also refuses when it cannot completely read the included content in a
current result tree or its saved original, including content beyond sixteen path
components. This leaves the current skill files and retained backup intact. Older
backups may contain hashes that omitted deeper files, so deleting that content
from the current tree cannot make the backup verifiable. A skill dropped by the
cleanup can still be restored to its absent path, including deep support files.
Do not edit backup hashes or delete or flatten live files merely to make restore pass.

For operator-led recovery:

1. Pause writes to the agent's Workshop, including collection review, before comparing or restoring files.
2. Locate the backup under
   `<agentDir>/skill-workshop/collection-backups/<backup-id>/`.
   Its `manifest.json` identifies the affected Workshop-relative directories in
   `skillDirs` and `resultSkillDirs`.
3. Create a new private inspection directory outside the Workshop and state
   directory. Copy the entire backup directory, including `manifest.json` and
   all saved content, into it. Current backups use `skills/`; history-only imports
   use `history/workspace/`. Separately copy each existing affected current directory
   into a `current/` subtree, preserving its Workshop-relative path. Include hidden
   files and all nested content. If any file cannot be copied, stop rather than use
   a partial copy.
4. Compare the inspection copies to select the intended content. Keep the live
   tree and original backup unchanged during review, and retain unedited copies
   of both versions before carrying out any operator-approved recovery.

Retained legacy backups may instead live under
`<state-dir>/skill-workshop/collection-backups/<workspace-hash>/<backup-id>/`
and contain a `workspace/` subtree. Preserve that original layout in inspection
copies; do not rewrite the manifest to make an old backup look current.

## Chat

For Workshop authoring, ask the agent for the skill you want; it calls
`skill_workshop` and returns a proposal id. Personal library authoring instead
returns the managed publication receipt described above.

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

When the actual turn supports only personal publication, including paired-node
personal CLI authoring, `/learn` stops without changing a skill. Ask normally
for explicit personal creation if you want to publish a revision, or use the
existing administrator UI or CLI for Workshop proposal review. Personal
pending drafts are not currently supported.

Create:

```text
Make a skill called morning-catchup that runs my Monday inbox routine.
```

Update an existing Workshop-generated skill:

```text
Update trip-planning to also check seat maps before booking.
```

If a skill used in the current turn proves wrong or incomplete, the agent reads
the live skill and creates a targeted patch proposal. When the complete skill
does not fit the selected model's read budget, the agent can prepare one unique
exact span and review its bounded surrounding context before patching it. A
runtime receipt limits this flow to skills used in that run. Autonomous mode
`off` disables repair, `propose` leaves the patch pending until explicitly
applied, and `auto` scans and applies it immediately. The repaired skill is
loaded by new sessions; the running session keeps its original skill snapshot.

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

# Update an existing Workshop-generated skill
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

Every subcommand takes `--agent <id>` (agent context; defaults to
cwd-inferred, then the default agent) and `--json` (structured output).
Proposals and generated skill targets are scoped to the selected agent.
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

Directory drafts must be completely readable and fit within eight path
components, including the filename. Evaluator bundles require all included target
content to be readable and within sixteen path components. Root `.clawhub`,
`.clawdhub`, and `.openclaw` metadata entries are excluded; those names nested
elsewhere remain included. Unreadable included directories or deeper content
produce an error. Fix the reported directory or reduce its nesting, then retry.
For a collection restore failure, follow the
[manual recovery guidance](#when-an-older-backup-cannot-be-restored-automatically)
instead of restructuring the live tree.

## Agent tool

For personal library operations, `skill_workshop` exposes
`list | read | create | update | share | unshare | transfer | activate | remove | rollback`.
The Gateway chooses the authorized namespace. When Workshop authoring is also
available, `target: "personal"` selects the personal library. Reads return a
stable skill ID and revision. Updates require `skill_id` and `expected_revision`;
omit `proposal_content` to preserve the instructions. Use `files` for named
support-file upserts and `delete_files` for explicit removals. Unmentioned
support files are preserved. Large instructions are returned whole or explicitly
omitted with directions to the operator workflow; binary supporting content is
not injected into model context.

For Workshop proposals, the tool uses one required `action`:
`create | read | prepare_patch | patch | update | revise | list | inspect | evaluate | apply | reject | quarantine | history | restore_collection`.
Other Workshop parameters apply depending on the action:

| Parameter                  | Used by                                                          | Notes                                                                 |
| -------------------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------- |
| `name`                     | `create`, `inspect`, `revise`                                    | Required for `create`; resolves a pending proposal by name otherwise  |
| `description`              | `create`, `update`, `revise`                                     | Max 160 bytes                                                         |
| `skill_name`               | `read`, `prepare_patch`, `patch`, `update`                       | Existing skill name or key                                            |
| `old_string`               | `prepare_patch`, `patch`                                         | Exact current text; prepare it when the complete skill cannot be read |
| `new_string`               | `patch`                                                          | Replacement for the exact current text                                |
| `proposal_content`         | `create`, `update`, `revise`                                     | Required for create/update; omit on revise to preserve the body       |
| `support_files`            | `create`, `update`, `revise`                                     | Array of `{ path, content }`                                          |
| `goal`, `evidence`         | `create`, `update`, `revise`                                     | Free-text context                                                     |
| `proposal_id`              | `inspect`, `revise`, `evaluate`, `apply`, `reject`, `quarantine` | Target proposal                                                       |
| `artifact_path`            | `inspect`                                                        | `PROPOSAL.md` or one listed support-file path                         |
| `expected_revision_hash`   | `evaluate`, `apply`, `reject`, `quarantine`                      | Rejects a stale orchestration step                                    |
| `correlation_id`           | `evaluate`, `revise`, `apply`, `reject`, `quarantine`            | External run or experiment correlation                                |
| `reason`                   | `apply`, `reject`, `quarantine`                                  | Optional                                                              |
| `query`, `status`, `limit` | `list`                                                           | Filter/paginate; `limit` max 50, default 20                           |

`read` and `prepare_patch` return the resolved `skillName`. Reuse that name as
`skill_name` in follow-up calls; a metadata `skillKey` can match a different
skill's exact name. Update proposals and revisions preserve the existing skill's
frontmatter name.

Only one prepared patch span may be active per skill. A second
`prepare_patch` is rejected until a `patch` attempt consumes or invalidates the
active authorization.

`inspect` returns proposal metadata, a bounded artifact manifest, and one
complete artifact when it fits the selected model's context budget. It selects
`PROPOSAL.md` by default. Set `artifact_path` to read one support file
separately. When the selected artifact does not fit, the result omits its body,
reports the original size, and points to smaller per-artifact reads or the
unbounded operator CLI command shown above.

Agents must use `skill_workshop` for generated skill work and must not create or
change skill or proposal files directly. This rule is advisory and
prompt-enforced. A hard guard is not currently possible at the tool-policy seam.

<Note>
`skill_workshop` is a built-in agent tool and is included in
`tools.profile: "coding"`. If a stricter policy hides it, add
`skill_workshop` to the active `tools.allow` list, or use
`tools.alsoAllow: ["skill_workshop"]` when the scope uses a profile without an
explicit `tools.allow`. Sandboxed runs do not construct the host-side
Workshop proposal tool. When an authorized personal-library capability is
available, sandbox and cloud runs use its Gateway-backed authoring surface
instead; the library and database are not mounted writable into the worker.
Use a normal host-side session or the CLI for Workshop proposal review.
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

In `propose` and `auto` modes, OpenClaw can review one finished substantial turn
after the agent system becomes idle. It records the finished turn's boundary and
reads that turn's model context asynchronously with the same provider and model.
It omits the general skill catalog
whose read prerequisite cannot execute in this restricted run. Review transcript
and session metadata changes stay detached. It can draft one pending create, patch, or update.
In `auto` mode, creates and Workshop-generated updates use the scanner-gated
apply path. A failed review is logged and dropped after one attempt.

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
      approvalPolicy: "auto",
      maxPending: 50,
      maxSkillBytes: 40000,
    },
  },
}
```

| Setting           | Default  | Effect                                                                                                                                                                           |
| ----------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `autonomous.mode` | `"auto"` | `"off"` disables autonomous capture, `"propose"` creates pending captures, and `"auto"` applies captures and runs weekly cleanup that can rewrite or drop Workshop-owned skills. |
| `approvalPolicy`  | `"auto"` | `"auto"` skips an additional prompt for agent-initiated `apply`, `reject`, or `quarantine` (the agent still has to call the action). `"pending"` requires approval.              |
| `maxPending`      | `50`     | Caps pending and quarantined proposals per agent (1-200).                                                                                                                        |
| `maxSkillBytes`   | `40000`  | Caps manual and foreground proposal body size in bytes (1024-200000). Autonomous results have a 10,000-character cap.                                                            |

In `propose` and `auto` modes, an isolated run of the selected model decides whether the
completed trajectory clears the evidence-gated proposal bar. The foreground model is not prompted
to learn before it replies. The background reviewer preserves the foreground run as proposal
provenance, cannot access general agent tools, and cannot make lifecycle decisions. In `auto`
mode, the capture pipeline applies every autonomous proposal only after the isolated run
completes. The reviewer may read or prepare an exact span before its single mutation.
Existing-skill changes require a complete read receipt or prepared exact-span authority, plus
content-hash binding, before they are eligible for that apply step. The review starts
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
| `skills.workshop.read`             | `operator.read`  |
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

`skills.proposals.list` includes `installedSkills`, the current Workshop inventory
for the selected agent. Each entry contains `name`, `skillKey`, and `description`.
The separate `proposals` array remains the proposal history and pending queue.

`skills.workshop.read` accepts `name` and optional `agentId`. It returns the
current installed skill's `name`, `skillKey`, `description`, and complete `content`.
An unknown agent or a skill outside that agent's Workshop inventory returns an
error. It never reads a retained proposal as a substitute for a missing skill.

`skills.curator.status` reports live skill usage recorded from trusted
`skill.used` events, retained pre-cron collection review records, and per-workspace
experience review outcomes. Current collection reviews use automation run history.
Age-based skill lifecycle curation is retired.
`skills.curator.pin`, `skills.curator.unpin`, and `skills.curator.restore` remain
registered for existing clients, but always return an error explaining that the
weekly collection review now manages the skill collection.

`requestRevision` is Gateway-only (no CLI or agent-tool equivalent): it
forwards free-text revision instructions to the owning agent's chat session
instead of replacing `PROPOSAL.md` directly, for UIs that ask the agent to
revise rather than submit literal new content.

`historyStatus` and `historyScan` are Control UI support methods. `historyScan`
accepts `direction: "older" | "newer"`; it always leaves results as pending
proposals.

## Storage

```text
<state-dir>/
  state/openclaw.sqlite
  agents/<agentId>/
    agent/workshop-skills/<skill-name>/
      SKILL.md
      assets/
      examples/
      references/
      scripts/
      templates/
  skill-workshop/proposals/<proposal-id>/
    generations/<generation-id>/
      PROPOSAL.md
      assets/
      examples/
      references/
      scripts/
      templates/
```

Unless overridden, `<state-dir>` is `~/.openclaw`.

- `state/openclaw.sqlite`: canonical proposal records and provenance, the active
  generation reference, proposal status, recorded skill usage, collection and
  experience review outcomes, and apply rollback metadata.
- Each generation contains one `PROPOSAL.md` and all of that revision's support
  files. Revision publication never overwrites the active generation in place.
- Generation files are flushed before publication. After the complete bundle is
  renamed into place, OpenClaw syncs the `generations/` parent directory where
  the platform supports directory flushing, before committing SQLite state.
  Platforms that report directory synchronization as unsupported retain atomic
  rename and process-interruption safety, but do not claim power-loss durability
  for that directory entry.
- Support files remain beside their generation's `PROPOSAL.md` so operators can
  review the proposed skill as a normal directory.

Proposals created by older releases can still reference the earlier root-level
`PROPOSAL.md` layout. The stored record identifies that bundle directly; the
next successful revision moves the proposal onto the generation layout and
retires the previous bundle.

Startup and `openclaw doctor --fix` use the same Workshop migration. It imports
the previous `proposals.json`, `proposal.json`, and `rollback.json` metadata into
SQLite after verifying each proposal, then removes the migrated JSON files.
It moves applied legacy Workshop creates into `workshop-skills`, retargets
eligible pending creates, and marks outside updates stale before normal use.
Pending updates follow their relocated skill in the same database commit.
Interrupted moves resume without discarding those pending updates.
If older workspace setup files remain, run `openclaw doctor --fix`.
Startup defers the affected skill moves and backup conversion until Doctor
has imported that workspace state.
The migration infers each legacy proposal's owner from its row, origin metadata,
or a unique workspace owner. Ambiguous ownership, or an owner that is no
longer in the agent roster, stays in place and becomes stale.
Legacy collection backups move under the owner agent's backup root together
with their post-cleanup snapshot. A dropped skill remains restorable when its
saved review and create proposal prove its owner, original path, and backup.
Backups without enough ownership evidence remain history-only; their legacy
files stay in place, and restore reports why it cannot use them. Completed
history archives do not block migration of the remaining backups.
If cleanup stops after publishing a restorable backup, the next migration
verifies the saved manifest and all copied files before removing the old copy.
Skills that were symlinked into a workspace stay where they are as workspace
skills; the migration marks their proposals stale instead of moving them.

If moving the skills empties a workspace, migration retires obsolete
workspace-survival evidence only when saved pre-move facts prove that the same
directory contained only those skills and every moved file is intact.
Missing or replaced workspaces, ordinary project files, and newer workspace
attestations keep their protection.

## Limits

| Limit                           | Value                                                                        |
| ------------------------------- | ---------------------------------------------------------------------------- |
| Description                     | 160 bytes                                                                    |
| Proposal body                   | `skills.workshop.maxSkillBytes` (default 40,000; hard ceiling 200,000 bytes) |
| Autonomous `SKILL.md`           | 10,000 characters, or strictly shorter when already over the cap             |
| Support files                   | 64 per proposal                                                              |
| Support file size               | 256 KiB each, 2 MiB total                                                    |
| Pending + quarantined proposals | `skills.workshop.maxPending` per agent (default 50)                          |

## Troubleshooting

| Problem                                        | Resolution                                                                                                                                                                                                  |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Skill proposal description is too large`      | Shorten `description` to 160 bytes or less.                                                                                                                                                                 |
| `Skill proposal content is too large`          | Shorten the proposal body or raise `skills.workshop.maxSkillBytes`.                                                                                                                                         |
| `Target skill changed after proposal creation` | Revise the proposal against the current target, or create a new proposal.                                                                                                                                   |
| `Proposal scan failed`                         | Inspect scanner findings, then revise or quarantine the proposal.                                                                                                                                           |
| `Support file paths must be under one of...`   | Move support files under `assets/`, `examples/`, `references/`, `scripts/`, or `templates/`.                                                                                                                |
| Proposal does not show in list                 | Check the selected agent and `OPENCLAW_STATE_DIR`.                                                                                                                                                          |
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
