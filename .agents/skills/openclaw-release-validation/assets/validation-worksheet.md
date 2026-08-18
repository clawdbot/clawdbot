# OpenClaw release validation

> Copy this template to a private local worksheet. Edit that copy directly or
> tell the agent what to record. Only release-facing sections from the completed
> copy are summarized on GitHub.

## Candidate

- Release:
- Commit:
- Release notes:
- Source version:
- Source commit:
- Shared issue:
- Upgrade result: pending

## Priority for this release

{{RELEASE_PRIORITIES}}

## How to use this worksheet

Start with the priorities above or choose any subsystem you know well. Add notes
directly beneath that subsystem's heading; an empty section means you did not
test it. Record failures, regressions, confusing behavior, and meaningful
latency under **Release findings** as well.

## Release findings

Record candidate OpenClaw problems found during upgrade or testing. For each
finding, note what you expected, what happened, and the affected subsystem.

- None yet.

## Private operator notes

Record OCM, copying, setup, local tooling, and cleanup problems here. This
section is never published to GitHub.

- None yet.

## Subsystem notes

### Pairing — pair a client or sender and confirm it can act

### Channels — use the channel you know best and confirm one reply per message

### Control UI — hold a real conversation with tools, reload, and continue

### TUI — drive history, streaming, shortcuts, and reconnect yourself

### Onboarding — complete setup and reach a working conversation

### Slash commands — try familiar commands and check their results

### Memory — retrieve old memory, add new memory, and retrieve it later

### Subagents — spawn a child, receive its result, and confirm it exits

### Agents — create or switch agents and confirm their state stays separate

### Cron — create, run, inspect, and remove one disposable job

### Sessions — restart or reconnect and confirm conversation continuity

### Context Engine — confirm relevant context appears without obvious excess

### Skill Workshop — invoke a skill, revise it, and invoke the revision

### MCP — discover a familiar server and complete one real call

### Models — list, select, use, and persist a model

### Approvals — deny once and approve once; confirm each action happens once

### Compaction — compact a real conversation and confirm continuity

### Codex harness — complete useful tool work and inspect its artifacts

### OpenClaw harness — complete a real task and inspect its artifacts

## Final feedback

- Overall feedback:
- Polished enough to promote: yes / no
