# OpenClaw release validation

> Copy this template to a private local worksheet. Edit that copy directly or
> tell the agent what to record. Only release-facing sections from the completed
> copy are summarized on GitHub.

## Candidate

- Release:
- Commit:
- Release notes: {{RELEASE_NOTES_URL}}
- Source version:
- Source commit:
- Shared issue:
- Upgrade result: pending

## Upgrade findings

Record candidate OpenClaw problems observed while upgrading or starting the
copied gateway. For each finding, note what you expected, what happened, and
the affected subsystem.

- None yet.

## Subsystem notes

> **Operator notes**
> Add notes only to the subsystems you tested. For priority subsystems, write
> under **Notes**; for all others, write directly beneath the subsystem name.
> Leave untested sections empty.

[Release notes]({{RELEASE_NOTES_URL}})

### Priority for this release

<!-- Campaign creator: move 3-5 selected subsystem sections here, add What changed, Recommended testing, and Notes subsections, then remove this comment. -->

### Other subsystems

#### Pairing

<!-- Pair a client or sender and confirm it can act. Add notes below. -->

#### Channels

<!-- Use the channel you know best and confirm one reply per message. Add notes below. -->

#### Control UI

<!-- Hold a real conversation with tools, reload, and continue. Add notes below. -->

#### TUI

<!-- Drive history, streaming, shortcuts, and reconnect yourself. Add notes below. -->

#### Onboarding

<!-- Complete setup and reach a working conversation. Add notes below. -->

#### Slash commands

<!-- Try familiar commands and check their results. Add notes below. -->

#### Memory

<!-- Retrieve old memory, add new memory, and retrieve it later. Add notes below. -->

#### Subagents

<!-- Spawn a child, receive its result, and confirm it exits. Add notes below. -->

#### Agents

<!-- Create or switch agents and confirm their state stays separate. Add notes below. -->

#### Cron

<!-- Create, run, inspect, and remove one disposable job. Add notes below. -->

#### Sessions

<!-- Restart or reconnect and confirm conversation continuity. Add notes below. -->

#### Context Engine

<!-- Confirm relevant context appears without obvious excess. Add notes below. -->

#### Skill Workshop

<!-- Invoke a skill, revise it, and invoke the revision. Add notes below. -->

#### MCP

<!-- Discover a familiar server and complete one real call. Add notes below. -->

#### Models

<!-- List, select, use, and persist a model. Add notes below. -->

#### Approvals

<!-- Deny once and approve once; confirm each action happens once. Add notes below. -->

#### Compaction

<!-- Compact a real conversation and confirm continuity. Add notes below. -->

#### Codex harness

<!-- Complete useful tool work and inspect its artifacts. Add notes below. -->

#### OpenClaw harness

<!-- Complete a real task and inspect its artifacts. Add notes below. -->

## Final feedback

- Overall feedback:
- Polished enough to promote: yes / no
