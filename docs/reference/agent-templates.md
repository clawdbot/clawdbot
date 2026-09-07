---
summary: "Portable agent template manifests, workspace files, automation fields, and validation limits"
title: "Agent templates"
read_when:
  - You are writing a tool that creates or reads portable agent templates
  - You need the exact export and import bundle contract
---

# Agent templates

A portable agent template is a directory consumed by `openclaw agents import`
and produced by `openclaw agents export`. It uses the same version 1 manifest as
the bundled role catalog. For command usage, see [Agents](/cli/agents).

## Directory layout

```text
research-template/
  manifest.json
  workspace/
    AGENTS.md
    SOUL.md
    IDENTITY.md
  automations.json       # optional
```

Only these files are accepted. The manifest's `files` entries are relative to
`workspace/`, not the bundle root. Each required workspace file appears exactly
once; directories and extra artifacts cannot be listed in its place.

## Manifest

```json
{
  "schemaVersion": 1,
  "title": "Research assistant",
  "summary": "Gather evidence and prepare a cited research brief.",
  "identity": { "name": "Research assistant", "emoji": "🔎", "theme": "Evidence first" },
  "skills": ["web-research"],
  "subagents": { "allowAgents": ["reviewer"], "delegationMode": "prefer" },
  "files": ["AGENTS.md", "SOUL.md", "IDENTITY.md"]
}
```

| Field                      | Contract                                                                                                                                                                                  |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schemaVersion`            | Required; exactly `1`.                                                                                                                                                                    |
| `role`                     | Optional catalog role: `coordinator`, `researcher`, `writer`, or `reviewer`. Import does not use it to resolve delegation targets.                                                        |
| `title`, `summary`         | Required non-empty strings describing the template.                                                                                                                                       |
| `identity`                 | Required object with a non-empty `name`; `emoji` and `theme` are optional non-empty strings.                                                                                              |
| `skills`                   | Optional array of non-empty skill names. Export includes it only when explicitly set on the agent, including an empty allowlist. Skill implementation files are not bundled.              |
| `model`                    | Optional model string or object with optional `primary` and `fallbacks` fields. Export includes only an explicit agent-level choice, not inherited defaults or credentials.               |
| `subagents.allowAgents`    | Optional array of agent ids, exported as configured. Import retains only ids already in the target roster and warns about dropped ids. If all targets are dropped, this field is omitted. |
| `subagents.delegationMode` | Optional `"suggest"` or `"prefer"`, preserved on import.                                                                                                                                  |
| `files`                    | Required array listing `AGENTS.md`, `SOUL.md`, and `IDENTITY.md` exactly once.                                                                                                            |

Unknown fields are rejected. No role-origin metadata is persisted.

## Automations

`automations.json`, when present, is an array of sanitized agent-turn jobs:

```json
[
  {
    "name": "Weekly research brief",
    "schedule": { "kind": "cron", "expr": "0 9 * * 1", "tz": "UTC" },
    "payload": {
      "kind": "agentTurn",
      "message": "Prepare a research brief from the current workspace instructions.",
      "timeoutSeconds": 300
    }
  }
]
```

Each job carries `name`, optional `description`, `schedule`, optional `pacing`,
and `payload`. Schedules use the `at`, `every`, or `cron` forms documented in
[Cron jobs](/automation/cron-jobs). `pacing` contains optional `min` and `max`
durations. The payload contains `kind: "agentTurn"`, `message`, and optional
`model`, `thinking`, and `timeoutSeconds`. No other job or payload fields are
portable. Pacing is valid only with `every` or `cron` schedules.

| Schedule kind | Fields                                                                                                      |
| ------------- | ----------------------------------------------------------------------------------------------------------- |
| `at`          | `at`: an absolute timestamp.                                                                                |
| `every`       | `everyMs`: a positive integer interval; optional `anchorMs`: a nonnegative timestamp in milliseconds.       |
| `cron`        | `expr`: a cron expression; optional `tz`: a timezone and `staggerMs`: a nonnegative integer stagger window. |

Export includes a job only when both `owner.agentId` and the execution `agentId`
match the exported agent. Unsupported payloads (`systemEvent`, `command`, and
`script`) are skipped and counted in the omissions report. Process-driven
schedules are not portable.

Import creates fresh job ids, sets the owner and execution agent to the new
agent id, and creates every job **disabled**. Review instructions and schedules
before enabling them. Delivery destinations, session keys, authorization data,
run history, and execution state are not transferred.

## Validation and exclusions

Bundles are limited to 32 regular files including metadata, 256 KiB per file,
and 2 MiB total. Version 1 accepts only the files in the directory layout above.
Paths must be relative and contained in the bundle: absolute paths, `..`
segments, symlinks, and unexpected files are rejected. Embedded absolute local
paths are also refused to keep the template portable.

Path checks are conservative around prose punctuation. Use percent-encoded
punctuation in a legitimate URL if it is mistaken for a local path.

Export scans Markdown and JSON for probable secrets. A refusal identifies the
file and line without echoing the suspected value; remove it from the source and
retry. There is no secret-check bypass. Pattern matching cannot prove the absence
of sensitive content, so inspect the bundle before sharing it.

Export never copies `USER.md`, `MEMORY.md`, `memory/`, `BOOTSTRAP.md`, other
personal workspace files, auth profiles, sessions, or anything under `agentDir`.
It also excludes channel bindings, skill code, inherited agent settings, and
command/script environment, arguments, working directories, and standard input.
Import requires a new agent id and a workspace without existing files, validates
the resulting agent configuration, and uses the normal agent creation path.
