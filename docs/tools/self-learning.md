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
follow. Every learned skill flows through [Skill Workshop](/tools/skill-workshop),
the same governed proposal, scan, apply, and lifecycle path used for explicit
skill authoring.

The default mode is `auto`. OpenClaw captures strong learning signals and applies
them through the normal scanner-gated Workshop service without asking for
approval. Choose `propose` to review every capture before it becomes active, or
`off` to disable autonomous capture.

## Immediate repair

When the foreground agent discovers that a skill it used is wrong or incomplete,
it reads the current live skill and drafts a targeted patch through Skill
Workshop in the same turn. A runtime usage receipt prevents foreground repair of
skills that the run did not use. Autonomous mode controls the outcome: `off`
disables the repair, `propose` leaves it pending for explicit review and apply,
and `auto` scans and applies it immediately. The repair still goes through
proposal storage, hash binding, the security scanner, and rollback capture.

Immediate repair changes the live skill for new sessions. It does not rewrite the
skill snapshot already loaded into the running session. The delayed experience
review remains a fallback for durable learning that the foreground agent did not
repair itself.

## Experience review

Every autonomous capture is authored by a model reviewing real evidence. There
is no template or pattern-matching path: content that reaches a proposal was
written by the reviewer against the Workshop authoring standards, never copied
from conversation text.

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
Only one experience review runs at a time. The foreground answer is never delayed.

The reviewer continues the finished turn from the same transcript prefix. This
lets the provider reuse the foreground prompt cache. Its appended review message
and tool results never enter the foreground transcript or session record.

The reviewer is detached and biased toward small, well-evidenced captures. It
receives an authoritative receipt of the skills the foreground run actually
read or command-invoked, plus a bounded workspace skill list. It prefers a used
writable skill when that skill governs the learning, then another existing
skill, and creates a new skill only when nothing covers the class.

Before changing an existing skill, the reviewer reads its current body. Both
update forms bind the proposal to that content hash. An oversized skill can be
rewritten only when the result is shorter. Autonomous `SKILL.md` results stay at
or below 10,000 characters. Longer reference and examples move into bundled
files. The reviewer sees the foreground tool schemas, but only `skill_workshop`
can execute. The reviewed transcript is evidence, not instructions.

Workshop-authored skills can apply automatically. Updates to user-authored skills
stay pending with a reason for operator review. Each review gets one attempt.
A failure is logged and dropped instead of retrying the turn.

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

| Mode      | Capture behavior                                                                                                              |
| --------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `off`     | Does not create experience-review captures.                                                                                   |
| `propose` | Creates or revises pending proposals. Nothing applies automatically.                                                          |
| `auto`    | Applies autonomous creates and Workshop-authored updates. User-authored updates stay pending for review. This is the default. |

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

Automatic learning uses the same apply path as an operator-approved Workshop
proposal. It does not give the isolated reviewer new tools or a way to bypass
lifecycle checks.

Every learned skill receives these controls:

- **Security scan at apply:** Workshop reruns the scanner immediately before the
  live write. A critical finding quarantines the proposal instead of applying it.
- **Workshop-owned writes:** creates target the selected workspace. Only updates
  to skills created by Workshop apply automatically. User-authored updates stay
  pending. Bundled, plugin, managed, system, and extra-root skills remain read-only.
- **Hash binding:** update proposals bind to the current live skill and go stale
  if that target changes before apply.
- **Lean cap:** autonomous results stay at or below 10,000 characters. A skill
  already above the cap can only become shorter.
- **Rollback metadata:** apply records the prior skill and support-file contents
  before the live write.
- **Collection review:** once a week in `auto` mode, an isolated model session
  reads the skills it intends to change. Externally owned skills stay untouched; only
  Workshop-owned paths can be rewritten or dropped. Collection-created skills
  receive automatically applied `create` proposal records.
- **Collection backup:** review validates and scans every rewrite before changing
  the workspace, keeps one recoverable collection backup, and restores it if a
  write fails.
- **Authoring standards:** learned skills use class-level names, trigger-first
  descriptions, evidence-backed steps, and token-efficient language.
- **Bounded failure:** an automatic apply is attempted once. A normal apply
  failure leaves the proposal pending, while a scanner-critical proposal is
  quarantined. OpenClaw does not retry in a loop.

Reject a pending miscapture with one command:

```bash
openclaw skills workshop reject <proposal-id> --reason "Not reusable"
```

Applied captures remain visible in `openclaw skills workshop list` and retain
their rollback metadata. The weekly collection review can later improve, merge,
or remove them. This makes
approval-free learning reversible and observable rather than silent.

Residual risk remains: learned content comes from conversation and tool output,
and the scanner blocks recognized dangerous patterns, not every possible piece
of bad advice. Review `openclaw skills workshop list` when in doubt.

## Runtime support

Delayed experience review requires the runtime to report its resolved model and
actual `skill_workshop` availability. The embedded runner and Codex app-server
harness report those facts; Codex also reports its exact model-iteration count.
Other CLI-backed runtimes fail closed until they provide the same runtime facts.
`/learn` does not depend on delayed review and continues to work on those
runtimes.

## Cost and privacy

Experience review adds one bounded model run on the configured provider only
after a substantial turn, not after every message. The review can make more
than one provider request while it inspects or drafts its single proposal.

The review forks the foreground transcript in memory and appends one small user
message. It uses the same provider, model, auth profile, session identity,
bootstrap context, skills prompt, and tool schemas. The provider can reuse the
finished turn's cached request prefix. Review writes remain detached.

The reviewer reuses the foreground provider, model, and available auth identity,
with model fallbacks disabled. Provider pricing and data-handling terms apply to
the additional run.

Weekly collection review also uses the configured agent model. It receives the
names, descriptions, and ownership state of eligible workspace skills, then reads each
skill it intends to change before one atomic call listing only changes. Disabled and
agent-filtered skills stay untouched. Shared workspaces use the union of each
agent's allowed skills only when provider, model, and resolved auth identity
match. Reconciliation must leave every sharing agent at least one visible skill.
It has no message tool or general agent tools. Skill bodies are treated as
untrusted evidence, not as instructions. A persisted per-workspace attempt time
prevents Gateway restarts from repeating a failed or successful review within 7 days. The
foreground agent can restore the one retained collection backup when asked to
undo the cleanup, unless an affected skill changed afterward.

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

| Setting                                    | Default  | Effect                                                                                                                   |
| ------------------------------------------ | -------- | ------------------------------------------------------------------------------------------------------------------------ |
| `skills.workshop.autonomous.mode`          | `"auto"` | Chooses capture behavior; `auto` also enables weekly collection review.                                                  |
| `skills.workshop.approvalPolicy`           | `"auto"` | Controls prompts for normal agent-initiated lifecycle calls. It never expands the isolated reviewer tool surface.        |
| `skills.workshop.maxPending`               | `50`     | Caps pending and quarantined proposals per workspace.                                                                    |
| `skills.workshop.maxSkillBytes`            | `40000`  | Caps proposal body size in bytes.                                                                                        |
| `skills.workshop.allowSymlinkTargetWrites` | `false`  | Allows apply through explicitly trusted workspace skill symlinks. Capture itself does not widen the trusted target list. |

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
5. The run was not sandboxed and tool policy still permits `skill_workshop`.
6. The Gateway stayed running and idle through the 30-second quiet period.

An eligible experience review can still abstain. No proposal is the expected
result when the evidence does not clear the reusable-procedure bar.
Use `openclaw skills curator status` to inspect the last collection and
experience review outcomes.

### Doctor reports that Workshop is hidden

In `propose` and `auto` modes, `openclaw doctor` checks whether the default agent
tool policy permits `skill_workshop`. Apply the reported `tools.allow` or
`tools.alsoAllow` change, or set the autonomous mode to `off`.

### A proposal remains pending in auto mode

Automatic apply runs once. Inspect the proposal and its scanner state:

```bash
openclaw skills workshop inspect <proposal-id>
```

A user-authored target or normal write failure leaves it pending for manual review. A critical
scanner result moves it to quarantine. Fix the cause and apply manually; do not
build a retry loop around automatic capture.

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
