---
summary: "Let OpenClaw propose reusable skills from corrections and substantial completed work"
read_when:
  - You want OpenClaw to learn reusable procedures from completed conversations
  - You are deciding whether to enable autonomous skill proposals
  - You need to understand self-learning safety, cost, eligibility, or troubleshooting
title: "Self-learning"
sidebarTitle: "Self-learning"
---

Self-learning lets OpenClaw turn useful evidence from conversations into pending
[Skill Workshop](/tools/skill-workshop) proposals. It does not train model
weights, edit active skills, or silently change agent behavior. Every learned
procedure stays pending until an operator reviews and applies it.

Self-learning is **disabled by default**. Enable it only when an additional
background model run and transcript review are appropriate for your workspace.

## Enable self-learning

In Control UI, open **Plugins → Workshop** and switch on **Self-learning**. The
change takes effect immediately; when another config writer has updated the
file, Control UI refreshes the config snapshot and retries the toggle without a
page or Gateway reload.

Use the CLI:

```bash
openclaw config set skills.workshop.autonomous.enabled true --strict-json
```

Or edit `~/.openclaw/openclaw.json`:

```json5
{
  skills: {
    workshop: {
      autonomous: {
        enabled: true,
      },
    },
  },
}
```

Disable it again with:

```bash
openclaw config set skills.workshop.autonomous.enabled false --strict-json
```

User-requested skill creation, `/learn`, and manual Skill Workshop operations
continue to work while self-learning is disabled.

## Review past sessions manually

Manual history review is the conservative alternative to autonomous capture.
Open **Plugins → Workshop** in the Control UI and select **Find skill ideas**.
This does not change `skills.workshop.autonomous.enabled`.

Each scan:

- starts with the newest unreviewed sessions and moves backward;
- reviews up to 20 substantial sessions with at least six model turns;
- skips cron, heartbeat, hook, subagent, ACP, plugin-owned, and internal review
  sessions;
- redacts recognized secrets and bounds the transcript bundle before sending it
  to the selected agent's configured model;
- uses the same high bar as autonomous experience review; and
- can create or revise at most three pending proposals, never live skills.

The Workshop reports cumulative session count, date coverage, and ideas found.
Select **Scan earlier work** for the next older window. When the cursor reaches
the beginning of eligible history, the action changes to **Scan new work**.
OpenClaw persists only cursor and coverage metadata in the shared state database;
it does not create a second transcript archive.

Sessions are scanned only when OpenClaw can prove their ownership and exclude
external-hook content. After an upgrade, the current pre-upgrade transcript can
be classified locally, but rotated pre-upgrade transcripts without per-run
provenance are skipped. New transcripts retain this provenance across rotation.

Manual scans still incur model-provider cost and send eligible conversation
content to the configured provider. Use them only when that review matches the
workspace's privacy and data-handling requirements.

## What OpenClaw can learn

Self-learning has two conservative paths:

1. **Direct instructions and corrections.** OpenClaw detects durable language
   such as “from now on,” “next time,” and corrections to a failed approach.
   With self-learning enabled, it can turn those signals into pending proposals
   without waiting for another prompt. This deterministic path can group related
   instructions into up to three proposals, target a writable workspace skill,
   or revise its own related pending proposal. It also runs after failed turns
   because it captures the user's instructions rather than judging completion.
2. **Experience review.** After a successful, substantial foreground turn,
   OpenClaw can review the completed work for a reusable recovery technique or
   a stable procedure that would remove at least two future model or tool round
   trips.

Good candidates include:

- a reliable recovery after repeated tool or model failures;
- a non-obvious ordering constraint that prevented a recurring error;
- a stable multi-step workflow that required repeated discovery; or
- a reusable preflight that would avoid multiple future calls.

The reviewer should abstain for routine successful work, one-off requests,
personal facts, simple preferences, transient environment failures, generic
advice, unsupported negative claims, and secrets.

## When experience review runs

Experience review is deliberately delayed and bounded:

- The foreground turn must finish successfully.
- The current turn must contain at least ten model iterations.
- Cron, heartbeat, memory, overflow, hook, subagent, and review sessions are
  excluded.
- The foreground run must have resolved a provider and model and must actually
  have had access to `skill_workshop`.
- OpenClaw waits 30 seconds after completion. A later foreground completion in
  the same session restarts that quiet period.
- If any agent or reply run is still active, review waits another 30 seconds.
- Only one experience review runs at a time.
- Delayed review is process-local Gateway work. The Gateway must remain running
  through the idle window; one-shot local and CLI-backed runtimes do not retain
  enough trajectory and tool-availability context to schedule it.

The foreground answer is never delayed for learning. A failed or ineligible
turn does not start experience review, although direct user corrections can
still be offered as a suggestion when autonomy is disabled.

## What the reviewer receives

The background reviewer receives only the current turn, starting at its most
recent user message. The rendered trajectory is capped at 60,000 characters;
when necessary, OpenClaw keeps the first message and the newest evidence and
marks the omitted middle.

The reviewer reuses the resolved provider and model. It reuses the foreground
auth profile when that identity is available and disables model fallbacks. The
review therefore starts an additional model run on the configured provider.
That run can make more than one provider request when it inspects or drafts a
proposal. Provider pricing and data-handling terms apply just as they do to the
foreground turn.

Before starting, OpenClaw reloads current runtime configuration and rechecks the
effective sandbox and tool policy for the original conversation. If the run is
sandboxed, policy no longer permits `skill_workshop`, or required runtime facts
are missing, review fails closed and creates nothing.

<Warning>
  Enabling self-learning permits eligible conversation content, including tool
  inputs and results from the current turn, to be sent to the selected model
  provider for one additional review. Do not enable it in a workspace where
  that review would violate data-handling requirements.
</Warning>

## Proposal safety

The reviewer runs in an isolated session with a deliberately narrow tool
surface:

- It can only list or inspect Workshop proposals and create or revise one
  pending proposal.
- It cannot update a live skill, apply a proposal, reject a proposal, quarantine
  a proposal, send a message, or use general agent tools.
- One mutation budget is shared across model retries, so a review can create or
  revise at most one proposal.
- The reviewed trajectory is treated as untrusted evidence, not as instructions
  for the background agent.
- Skill Workshop scans proposal content and rejects recognized literal
  credentials before proposal state is written.

Normal Workshop limits still apply, including `maxPending`, `maxSkillBytes`,
support-file restrictions, scanner checks, and workspace-only writes. The
`approvalPolicy: "auto"` setting does not grant the background reviewer access
to lifecycle actions.

## Review learned proposals

Self-learning produces the same pending proposals as manual Workshop use.
Inspect them before applying:

```bash
openclaw skills workshop list
openclaw skills workshop inspect <proposal-id>
openclaw skills workshop apply <proposal-id>
```

Revise, reject, or quarantine proposals that are useful but not ready:

```bash
openclaw skills workshop revise <proposal-id> --proposal ./PROPOSAL.md
openclaw skills workshop reject <proposal-id> --reason "Too specific"
openclaw skills workshop quarantine <proposal-id> --reason "Needs security review"
```

Applying is the only operation that writes an active `SKILL.md`. See
[Skill Workshop](/tools/skill-workshop) for the complete lifecycle and storage
model.

## Configuration

| Setting                                    | Default  | Self-learning effect                                                                                                              |
| ------------------------------------------ | -------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `skills.workshop.autonomous.enabled`       | `false`  | Enables direct correction capture and delayed experience review.                                                                  |
| `skills.workshop.approvalPolicy`           | `"auto"` | Controls approval prompts for normal agent-initiated lifecycle actions; it does not expand the background reviewer's permissions. |
| `skills.workshop.maxPending`               | `50`     | Caps pending and quarantined proposals per workspace.                                                                             |
| `skills.workshop.maxSkillBytes`            | `40000`  | Caps proposal body size in bytes.                                                                                                 |
| `skills.workshop.allowSymlinkTargetWrites` | `false`  | Affects apply behavior only; self-learning itself writes proposal state, not live skill targets.                                  |

For the exhaustive schema, ranges, and related skill settings, see
[Skills config](/tools/skills-config#workshop-skills-workshop).

## Troubleshooting

### No proposal appears after a long turn

Check all of the following:

1. `skills.workshop.autonomous.enabled` is `true` in the active Gateway config.
2. The turn succeeded and included at least ten model iterations after the most
   recent user message.
3. The conversation was a normal foreground run, not a scheduled, memory,
   hook, or subagent run.
4. The original run had access to `skill_workshop` and was not sandboxed.
5. The system remained idle long enough for the delayed review.
6. The long-running Gateway process stayed active through the idle window; a
   one-shot local command does not wait for delayed review.

A qualifying review may still produce no proposal. Abstention is the expected
result when the evidence does not clear the reusable-procedure bar.

### Doctor reports that the Workshop tool is hidden

When self-learning is enabled, `openclaw doctor` checks whether the default
agent's effective tool policy permits `skill_workshop`. Follow the reported
`tools.allow` or `tools.alsoAllow` change, or disable self-learning.

### Too many low-value proposals appear

Disable self-learning and continue using `/learn` or explicit Workshop requests:

```bash
openclaw config set skills.workshop.autonomous.enabled false --strict-json
```

Pending proposals remain reviewable after the feature is disabled. Disabling
self-learning does not apply, reject, or delete them.

## Related

- [Skill Workshop](/tools/skill-workshop) for proposal review, approval, and
  storage
- [Creating skills](/tools/creating-skills) for hand-authored skills and
  `SKILL.md` structure
- [Skills config](/tools/skills-config) for all `skills.*` settings
- [Skills CLI](/cli/skills) for Workshop and curator commands
