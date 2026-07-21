---
summary: "Validate and preview experimental Claw agent packages"
read_when:
  - You want to validate a grouped Claw manifest
  - You want to preview adding one agent from a Claw
title: "Claws"
---

# `openclaw claws`

A Claw is a versioned setup for one new OpenClaw agent. It can describe the
agent configuration, workspace files, skills, plugins, MCP servers, and cron
jobs that agent needs. A Claw does not replace or modify an existing agent.

Claws are experimental. Their schema, command output, and lifecycle may change.
Enable the command surface explicitly:

```bash
export OPENCLAW_EXPERIMENTAL_CLAWS=1
```

The current CLI reads a local package directory or grouped JSON manifest.
Publishing, searching, and installing whole Claws through ClawHub are a
separate registry track and are not part of this command surface yet.

## Create a grouped manifest

Start with a version 1 JSON manifest:

```json
{
  "schemaVersion": 1,
  "agent": {
    "id": "incident-triage",
    "name": "Incident triage",
    "tools": { "deny": ["exec"] }
  },
  "workspace": { "bootstrapFiles": {} },
  "packages": [],
  "mcpServers": {},
  "cronJobs": []
}
```

Package and workspace paths must remain inside the package root. Manifests are
limited to 1 MiB, package metadata to 256 KiB, and workspace sources enforce
separate per-file and aggregate limits. Workspace sources also reject symlinked
parents.

## Inspect and preview

Validate the source without planning local changes:

```bash
openclaw claws inspect ./incident-triage.claw.json
```

Preview all proposed lifecycle actions:

```bash
openclaw claws add ./incident-triage.claw.json --dry-run --json
```

The plan reports the derived agent and workspace, every proposed action,
prerequisites, blockers, and distinct capability escalations. Capability records
show the exact package, MCP, scheduled-work, sandbox, tool, or heartbeat effect
and are included in plan integrity. Use `--agent-id` or
`--workspace` to preview alternatives when package defaults collide with local
state.

This initial experimental command is read-only. `claws add` requires
`--dry-run` and does not create the agent or mutate OpenClaw state.

## Command reference

| Command                  | Purpose                                        |
| ------------------------ | ---------------------------------------------- |
| `claws inspect <source>` | Validate a package directory or JSON manifest. |
| `claws add <source>`     | Preview adding one new agent and workspace.    |

Use `--json` for experimental machine-readable output.

## See also

- [Agents](/cli/agents)
- [Skills](/tools/skills)
- [Plugins](/tools/plugin)
