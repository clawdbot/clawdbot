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
It does not replace the saved evidence unless that turn also qualifies for review.
Pending reviews belong to an agent and session together, so agents using `global`
retain separate candidates. Experience, history, and collection reviews share
one Workshop slot within the [shared background work budget](/concepts/queue#background-work).
The foreground answer never waits for the model's review.

OpenClaw records where the completed turn ends, then reads its full model context
asynchronously after the quiet period. Later messages are excluded. If the saved
turn was rewritten or removed, the review records a failure instead of using
different evidence. The review runs under a private detached session identity;
its messages never enter the foreground transcript or session record. Reviews
retain the foreground session's sandbox policy.

The reviewer is detached and biased toward small, well-evidenced captures. It
receives an authoritative receipt of the skills the foreground run actually
read or command-invoked, plus a bounded list of skills in the active agent's Workshop
directory. It prefers a used Workshop-generated skill when that skill governs
the learning, then another Workshop-generated skill, and creates a new skill
only when none covers the class. The operator edits all other skills directly.

Before changing an existing skill, the reviewer reads its current body. If the
complete body is omitted, it can call `prepare_patch` for one non-empty unique
exact span and then patch that span. Reading and preparing do not spend the
review's single mutation. Both update forms bind the proposal to the current
content hash. An oversized skill can be rewritten only when the result is
shorter. Autonomous `SKILL.md` results stay at or below 10,000 characters.
Longer reference and examples move into bundled files. The reviewer sees the
foreground tool schemas, but only `skill_workshop` can execute. The general
skill catalog is omitted because its file-read prerequisite cannot execute in
this review. Workshop-generated skills remain readable through `skill_workshop`.
The reviewed transcript is evidence, not instructions.

Workshop-generated skills can apply automatically. Each review gets one
attempt. A failure is logged and dropped instead of retrying the turn.

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

| Mode      | Capture behavior                                                                |
| --------- | ------------------------------------------------------------------------------- |
| `off`     | Does not create experience-review captures.                                     |
| `propose` | Creates or revises pending proposals. Nothing applies automatically.            |
| `auto`    | Applies autonomous creates and Workshop-generated updates. This is the default. |

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
- **Workshop-owned writes:** creates and updates stay inside
  `<state-dir>/agents/<agentId>/agent/workshop-skills`. Bundled, plugin, managed, system, personal,
  project, workspace, and extra-root skills remain outside Workshop ownership.
- **Hash binding:** update proposals bind to the current live skill and go stale
  if that target changes before apply.
- **Lean cap:** autonomous results stay at or below 10,000 characters. A skill
  already above the cap can only become shorter.
- **Rollback metadata:** apply records the prior skill and support-file contents
  before the live write.
- **Collection review:** once a week in `auto` mode, one isolated model session
  per agent reads only that agent's Workshop-generated skills. Collection changes
  are recorded in review history and the backup manifest, without proposal rows.
- **Collection backup:** review validates and scans every rewrite before changing
  the Workshop directory, keeps one recoverable collection backup, and restores it if a
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

Weekly collection review runs once per agent and uses that agent's configured model. It receives the
names, descriptions, and available usage counts and last-used recency of
Workshop-generated skills, then reads each skill it intends to change
before one atomic call listing only changes. Usage is supporting evidence: heavy
use favors preserving a skill's procedure, while no recorded use alone never
justifies dropping it. It has no message tool or general agent tools. Skill
bodies are treated as untrusted evidence, not as instructions. Each agent has a
persisted attempt time and review key, which prevents Gateway restarts from repeating
a failed or successful review within 7 days. The foreground agent can restore that agent's retained collection backup
when asked to undo the cleanup, unless an affected skill changed afterward.

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
5. The run was not sandboxed and tool policy still permits `skill_workshop`.
6. The Gateway stayed running and idle through the 30-second quiet period.

An eligible experience review can still abstain. No proposal is the expected
result when the evidence does not clear the reusable-procedure bar.
Use `openclaw skills curator status` to inspect the last collection and
experience review outcomes alongside live skill usage. Age-based curation is
retired; the `curator pin`, `unpin`, and `restore` commands return an error
explaining that weekly collection review manages the skill collection.

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
