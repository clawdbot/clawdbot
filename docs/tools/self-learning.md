---
summary: "Turn corrections and successful work into reusable skills through Skill Workshop"
read_when:
  - You want OpenClaw to learn reusable procedures from completed conversations
  - You are choosing between off, propose, and auto self-learning modes
  - You need to understand self-learning safety, cost, privacy, or troubleshooting
title: "Self-learning"
sidebarTitle: "Self-learning"
---

Self-learning turns corrections and successful work into reusable skills. Skills
are the durable unit: they hold procedures that future sessions can discover and
follow. [Skill Workshop](/tools/skill-workshop) owns the agent's learned skills.

The default mode is `auto`. Background learning uses normal agent file tools to
maintain the Workshop directory, like weekly collection review. Choose `propose`
to stage drafts for review instead, or `off` to disable autonomous learning.

## Immediate repair

When the foreground agent discovers that a skill it used is wrong or incomplete,
it reads the current live skill and drafts a targeted patch through Skill
Workshop in the same turn. If the complete skill does not fit the selected
model's read budget, `prepare_patch` can authorize one non-empty unique exact
span and return bounded surrounding context. The next `patch` must quote that
same span, and the authorization expires after one attempt or any target change.
A second `prepare_patch` for that skill is rejected until the active authorization
is consumed or invalidated. A runtime usage receipt prevents foreground repair of
skills that the run did not use. Autonomous mode controls the outcome: `off`
disables the repair, `propose` leaves it pending for explicit review and apply,
and `auto` scans and applies it immediately. The repair still goes through
proposal storage, hash binding, the security scanner, and rollback capture.

Immediate repair changes the live skill for new sessions. It does not rewrite the
skill snapshot already loaded into the running session. The delayed experience
review remains a fallback for durable learning that the foreground agent did not
repair itself.

## Experience review

Every learning decision comes from a model reviewing real evidence, not a
template or pattern-matching path. The conversation and skill files are evidence,
not permission to resume tasks or execute the procedures under review.

After substantial work, OpenClaw can run one detached background review to find
a reusable recovery technique or a stable procedure that would remove at least
two future model or tool round trips. Deep turns the user interrupted qualify
too: the wrong path and its correction are exactly the evidence worth keeping.
The reviewer is told when a turn was interrupted and captures only procedures
that visibly worked before the stop. Turns that ended in a provider or prompt
error never schedule a review; that failure is transient environment noise, and
a review on the same model would likely hit it again.

Experience review starts only when all of these conditions hold:

- the foreground turn completed or was interrupted, but did not end in a
  provider or prompt error;
- the current turn used at least 10 model iterations;
- the run was an eligible foreground conversation, not cron, heartbeat, memory,
  overflow, hook, subagent, or review work;
- the runtime reported the resolved provider, model, and actual availability of
  `skill_workshop`;
- the system has been quiet for 30 seconds; and
- no agent or reply run is still active.

A later foreground completion in the same session restarts the quiet period.
It does not replace the saved evidence unless that turn also qualifies for review.
Pending reviews belong to an agent and session together, so agents using `global`
retain separate candidates. Experience and history reviews share
one Workshop slot within the [shared background work budget](/concepts/queue#background-work).
The foreground answer never waits for the model's review.

OpenClaw records where the completed turn ends, then reads its full model context
asynchronously after the quiet period. The reviewer connects earlier requirements
and corrections with observed results across that retained conversation, even
when the latest turn is routine. Later messages are excluded. If the saved
turn was rewritten or removed, the review records a failure instead of using
different evidence. The review runs under a private detached session identity;
its messages never enter the foreground transcript or session record. Reviews
retain the foreground session's sandbox policy.

In `auto` mode, the reviewer uses ordinary directory, file, patch, and shell
tools under the source session's permissions. It can inspect complete skills and
supporting files, correct several connected files, and verify the result. Its
file tools are rooted at the Workshop directory; shell commands retain the
operator's existing approval policy. An enabled sandbox must provide writable
access to that directory. The run uses the normal configured agent timeout.

The reviewer shares the weekly collection's maintenance instructions: audit
before editing, give a procedure one home, preserve distinct tasks, and verify
the resulting files. New learning should replace a misleading rule or strengthen
an existing one rather than append another copy. A covered lesson needs no edit.
The runtime receipt identifies skills actually used in the foreground turn;
ordinary directory reads discover the current collection without a separate
clipped inventory.

In `propose` mode, only `skill_workshop` executes. The reviewer can inspect and
read before staging one create, patch, update, or revision. Existing proposal
read/hash/size validation remains in effect. The draft stays pending even if the
operator enables automatic learning during that review.

Each review gets one attempt. A failure is recorded instead of retried. Automatic
maintenance records `completed` when the agent run succeeds; that status is not
a claim that a file changed. Completed file edits survive later failure or
cancellation, and future sessions receive a refreshed skill snapshot. Source
session deletion, replacement, or a permission-mode change fences retained tools.

Good candidates include:

- a reliable recovery after repeated tool or model failures;
- a durable user correction or standing instruction ("from now on," "always,"
  "never," "stop doing X"), embedded as a procedure step in the skill governing
  that work;
- a non-obvious ordering constraint that prevented a recurring error;
- a stable multi-step workflow that required repeated discovery; or
- a reusable preflight that would avoid several future calls.

The reviewer should abstain for:

- routine successful work or a one-time request;
- personal facts and simple preferences;
- transient environment or service failures;
- generic advice without concrete supporting evidence;
- unsupported negative claims; or
- secrets and credential material.

## Mode policy

| Mode      | Capture behavior                                                             |
| --------- | ---------------------------------------------------------------------------- |
| `off`     | Does not create experience-review captures.                                  |
| `propose` | Creates or revises pending proposals. Nothing applies automatically.         |
| `auto`    | Maintains Workshop skills with normal agent file tools. This is the default. |

Set the mode with the CLI:

```bash
openclaw config set skills.workshop.autonomous.mode auto
openclaw config set skills.workshop.autonomous.mode propose
openclaw config set skills.workshop.autonomous.mode off
```

Or edit `~/.openclaw/openclaw.json`:

```json5
{
  skills: {
    workshop: {
      autonomous: {
        mode: "auto",
      },
    },
  },
}
```

Changing the mode does not alter existing proposals or applied skills. Manual
history review, `/learn`, and explicit Workshop requests remain available in all
three modes.

## Why auto is safe to default

Automatic background learning follows the same normal file-edit semantics as
weekly collection maintenance:

- **Workshop ownership:** file tools stay in
  `<state-dir>/agents/<agentId>/agent/workshop-skills`. Other skill roots remain
  outside the maintenance task.
- **Existing permissions:** the run preserves the source session's permission
  mode, tool restrictions, and shell approval policy. Conversation evidence does
  not grant extra access.
- **Independent lifecycle:** foreground work does not await the review. Gateway
  drain and source invalidation close the review's authority.
- **Editorial judgment:** the agent reads complete relevant files, preserves
  useful meaning, and checks its changes rather than targeting a size or count.

Direct maintenance does not create proposals, run a post-turn scanner, or record
automatic rollback snapshots. Use backups for recovery from unwanted direct
edits. Explicit proposals and immediate foreground repair retain their existing
scanner, hash binding, size validation, and rollback metadata.

Reject a pending miscapture with one command:

```bash
openclaw skills workshop reject <proposal-id> --reason "Not reusable"
```

Proposal captures remain visible in `openclaw skills workshop list`. Direct
maintenance changes appear in the installed Workshop skills, not as proposal
records. Weekly review results remain in automation history; retained legacy
backups keep their [restore path](/tools/skill-workshop#changes-and-recovery).

Residual risk remains: an agent can make an incorrect edit. Inspect installed
skills in Workshop, or choose `propose` when every capture needs human review.

## Runtime support

Delayed experience review requires the runtime to report its resolved model and
actual `skill_workshop` availability. The embedded runner and Codex app-server
harness report those facts; Codex also reports its exact model-iteration count.
Other CLI-backed runtimes fail closed until they provide the same runtime facts.
`/learn` does not depend on delayed review and continues to work on those
runtimes.

## Cost and privacy

Experience review adds one model run on the configured provider only after a
substantial turn, not after every message. The review can make several requests
while it inspects, edits, and verifies skills.

The review creates a detached view of the foreground model context and appends
one small user message. Storage-only native prompt payloads stay in the original
transcript, whose stored bytes the review does not change. It uses a private
detached session identity while preserving the
foreground provider, model, auth profile, bootstrap context, tool schemas, and
prompt-cache affinity. Removing unavailable skill guidance changes the prompt,
so only compatible prefixes can be reused. The review never becomes part of
the foreground session.

The reviewer reuses the foreground provider, model, and available auth identity,
with model fallbacks disabled. Provider pricing and data-handling terms apply to
the additional run.

Weekly [collection review](/tools/skill-workshop#collection-review) uses the
agent's configured model and normal cron scheduling. Skill bodies remain review
material, not active instructions. Completed edits persist; there is no
collection-wide transaction or automatic rollback.

Manual history scan uses a separate bounded path. It reviews up to 20 substantial
sessions with at least six model turns, redacts recognized secrets, bounds the
transcript bundle, and can create or revise at most three pending proposals. It
stores cursor and coverage metadata in the shared state database without copying
transcript content into scan state.

<Warning>
  Experience review and manual history scan can send eligible conversation
  content, including tool inputs and results, to the configured model provider.
  Choose a provider and mode that match the workspace privacy and data-handling
  requirements.
</Warning>

## Review and revert learning

List and inspect every pending, applied, rejected, quarantined, or stale capture:

```bash
openclaw skills workshop list
openclaw skills workshop inspect <proposal-id>
```

Stop a pending capture from becoming active or quarantine it for safety review:

```bash
openclaw skills workshop reject <proposal-id> --reason "Too specific"
openclaw skills workshop quarantine <proposal-id> --reason "Needs security review"
```

Use `/learn` when you want an explicit proposal from the current conversation or
named sources:

```text
/learn
/learn docs/runbook.md; focus on recovery
```

`/learn` first revises a matching pending proposal or updates a matching live
skill. It creates a new pending proposal only when no skill owns the procedure,
and never auto-applies the result.

To review older work manually, open **Plugins -> Workshop** in Control UI and
select **Find skill ideas**. Each click reviews one bounded window and leaves any
result pending regardless of autonomous mode.

## Configuration reference

| Setting                           | Default  | Effect                                                                                                            |
| --------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------- |
| `skills.workshop.autonomous.mode` | `"auto"` | Chooses capture behavior; `auto` also enables weekly collection review.                                           |
| `skills.workshop.approvalPolicy`  | `"auto"` | Controls prompts for normal agent-initiated lifecycle calls. It never expands the isolated reviewer tool surface. |
| `skills.workshop.maxPending`      | `50`     | Caps pending and quarantined proposals per agent.                                                                 |
| `skills.workshop.maxSkillBytes`   | `40000`  | Caps proposal body size in bytes.                                                                                 |

See [Skills config](/tools/skills-config#workshop-skills-workshop) for ranges and
the complete `skills.*` schema.

## Troubleshooting

### No capture appears

Check the following:

1. `skills.workshop.autonomous.mode` is `propose` or `auto` in the active Gateway
   config.
2. The turn reached at least 10 model iterations without ending in a provider or
   prompt error.
3. The conversation is eligible foreground work.
4. The runtime reported the resolved model and actual `skill_workshop`
   availability.
5. Tool policy permits Workshop. Automatic maintenance also needs normal file
   access; an enabled sandbox must expose its Workshop directory as writable.
6. The Gateway stayed running and idle through the 30-second quiet period.

An eligible experience review can still abstain. No proposal is the expected
result when the evidence does not clear the reusable-procedure bar.
Use `openclaw skills curator status` to inspect experience review outcomes and
live skill usage. Current weekly collection results are in automation run history;
Curator retains only the earlier collection records. Age-based curation is retired;
the `curator pin`, `unpin`, and `restore` commands return an error explaining that
weekly collection review manages the skill collection.

### Doctor reports that Workshop is hidden

In `propose` and `auto` modes, `openclaw doctor` checks whether the default agent
tool policy permits `skill_workshop`. Apply the reported `tools.allow` or
`tools.alsoAllow` change, or set the autonomous mode to `off`.

### A proposal remains pending in auto mode

Automatic apply runs once. Inspect the proposal and its scanner state:

```bash
openclaw skills workshop inspect <proposal-id>
```

A normal write failure leaves it pending for manual review. A critical scanner
result moves it to quarantine. Fix the cause and apply manually; do not build a
retry loop around automatic capture.

### Too many low-value captures appear

Switch to `propose` to review every capture, or `off` to disable autonomous
capture:

```bash
openclaw config set skills.workshop.autonomous.mode propose
openclaw config set skills.workshop.autonomous.mode off
```

Existing proposals and applied skills remain visible after the mode changes.

## Related

- [Skill Workshop](/tools/skill-workshop) for proposal lifecycle and storage
- [Creating skills](/tools/creating-skills) for hand-authored skills
- [Skills config](/tools/skills-config) for every `skills.*` setting
- [Skills CLI](/cli/skills) for Workshop commands
