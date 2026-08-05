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
`off` to keep only the suggestion nudge.

## Capture paths

OpenClaw uses two complementary capture paths.

### Deterministic correction capture

When an interactive turn ends, OpenClaw looks for durable instructions such as
"from now on," "next time," and direct corrections to a failed approach. This
path is deterministic and does not start another model run. It can:

- group related instructions into up to three focused skills;
- route a correction to a matching writable workspace skill;
- revise its own related pending proposal; and
- capture after a failed turn because the user instruction remains useful even
  when the work did not complete.

Detection is intentionally heuristic. A durable phrase can occasionally produce
an overly broad or low-value capture. That is an accepted tradeoff because
miscaptures are cheap to inspect and remove, while Workshop governance keeps the
write bounded and recoverable.

### Experience review

After substantial work, OpenClaw can run one isolated background review to find
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

The reviewer is isolated and conservative. It can list or inspect proposals and
create or revise at most one pending proposal. Its one-mutation budget is shared
across retries. It cannot apply, reject, quarantine, message, update a live skill,
or use general agent tools. The reviewed trajectory is evidence, not instructions.

Good candidates include:

- a reliable recovery after repeated tool or model failures;
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

| Mode      | Capture behavior                                                                                          | Suggestion nudge                                                    |
| --------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `off`     | Does not create deterministic or experience-review captures.                                              | Enabled. OpenClaw can offer to save a detected durable instruction. |
| `propose` | Creates or revises pending proposals through both capture paths. Nothing applies automatically.           | Suppressed.                                                         |
| `auto`    | Creates or revises proposals, then immediately calls the normal Workshop apply path. This is the default. | Suppressed.                                                         |

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
- **Workspace-only writes:** creates and updates can target only writable skills
  in the selected workspace. Bundled, plugin, managed, personal-agent, system,
  and extra-root skills remain outside the write boundary.
- **Hash binding:** update proposals bind to the current live skill and go stale
  if that target changes before apply.
- **Rollback metadata:** apply records the prior skill and support-file contents
  before the live write.
- **Curator lifecycle:** learned skills unused for 30 days become stale and after
  90 days become archived. Pin keeps a skill active; restore returns an archived
  skill to new session snapshots.
- **Authoring standards:** learned skills use class-level names, trigger-first
  descriptions, evidence-backed steps, and token-efficient language.
- **Bounded failure:** an automatic apply is attempted once. A normal apply
  failure leaves the proposal pending, while a scanner-critical proposal is
  quarantined. OpenClaw does not retry in a loop.

Reject a pending miscapture with one command:

```bash
openclaw skills workshop reject <proposal-id> --reason "Not reusable"
```

Applied captures remain visible in `openclaw skills workshop list`, retain their
rollback metadata, and enter curator lifecycle management. This makes
approval-free learning reversible and observable rather than silent.

Residual risk remains: learned content comes from conversation and tool output,
and the scanner blocks recognized dangerous patterns, not every possible piece
of bad advice. Review `openclaw skills workshop list` when in doubt.

## Runtime support

Delayed experience review requires the runtime to report its resolved model and
actual `skill_workshop` availability. The embedded runner and Codex app-server
harness report those facts; Codex also reports its exact model-iteration count.
Other CLI-backed runtimes fail closed until they provide the same runtime facts.

Deterministic correction capture and `/learn` do not depend on delayed review and
continue to work on those runtimes. In `auto` mode, a runtime that does not report
actual Workshop availability leaves deterministic captures pending instead of
applying them.

## Cost and privacy

Deterministic correction capture does not make an extra model call. Experience
review adds one bounded model run on the configured provider only after a
substantial turn, not after every message. The review can make more
than one provider request while it inspects or drafts its single proposal.

The reviewer receives only the current turn beginning with its most recent user
message. The rendered trajectory is limited to 60,000 characters. When the
bundle is too large, OpenClaw keeps the first message and newest evidence and
marks the omitted middle.

The reviewer reuses the foreground provider, model, and available auth identity,
with model fallbacks disabled. Provider pricing and data-handling terms apply to
the additional run.

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

Inspect and manage applied learned skills through the curator:

```bash
openclaw skills curator status
openclaw skills curator pin <skill>
openclaw skills curator unpin <skill>
openclaw skills curator restore <skill>
```

Use `/learn` when you want an explicit proposal from the current conversation or
named sources:

```text
/learn
/learn docs/runbook.md; focus on recovery
```

`/learn` always creates a pending proposal and never auto-applies it.

To review older work manually, open **Plugins -> Workshop** in Control UI and
select **Find skill ideas**. Each click reviews one bounded window and leaves any
result pending regardless of autonomous mode.

## Configuration reference

| Setting                                    | Default  | Effect                                                                                                                   |
| ------------------------------------------ | -------- | ------------------------------------------------------------------------------------------------------------------------ |
| `skills.workshop.autonomous.mode`          | `"auto"` | Chooses `off`, `propose`, or `auto` capture behavior.                                                                    |
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
2. The correction uses durable language, or the turn reached at least 10 model
   iterations without ending in a provider or prompt error.
3. The conversation is eligible foreground work.
4. The runtime reported the resolved model and actual `skill_workshop`
   availability.
5. The run was not sandboxed and tool policy still permits `skill_workshop`.
6. For experience review, the Gateway stayed running and idle through the
   30-second quiet period.

An eligible experience review can still abstain. No proposal is the expected
result when the evidence does not clear the reusable-procedure bar.

### Doctor reports that Workshop is hidden

In `propose` and `auto` modes, `openclaw doctor` checks whether the default agent
tool policy permits `skill_workshop`. Apply the reported `tools.allow` or
`tools.alsoAllow` change, or set the autonomous mode to `off`.

### A proposal remains pending in auto mode

Automatic apply runs once. Inspect the proposal and its scanner state:

```bash
openclaw skills workshop inspect <proposal-id>
```

A normal write or target failure leaves it pending for manual review. A critical
scanner result moves it to quarantine. Fix the cause and apply manually; do not
build a retry loop around automatic capture.

### Too many low-value captures appear

Switch to `propose` to review every capture, or `off` to keep only the suggestion
nudge:

```bash
openclaw config set skills.workshop.autonomous.mode propose
openclaw config set skills.workshop.autonomous.mode off
```

Existing proposals and applied skills remain visible after the mode changes.

## Related

- [Skill Workshop](/tools/skill-workshop) for proposal lifecycle and storage
- [Creating skills](/tools/creating-skills) for hand-authored skills
- [Skills config](/tools/skills-config) for every `skills.*` setting
- [Skills CLI](/cli/skills) for Workshop and curator commands
