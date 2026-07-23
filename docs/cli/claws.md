---
summary: "Add, inspect, update, and remove experimental Claw agent packages"
read_when:
  - You want to validate a grouped Claw manifest
  - You want to preview or add one agent from a Claw
  - You need to inspect Claw ownership, drift, or cleanup behavior
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

Workspace files are declared by path and read from package sidecars. Bootstrap
files such as `SOUL.md` use named entries; additional files use package-relative
sources and workspace-relative targets:

```json
{
  "workspace": {
    "bootstrapFiles": {
      "SOUL.md": { "source": "workspace/SOUL.md" }
    },
    "files": [
      {
        "source": "workspace/reference/policy.md",
        "path": "reference/policy.md"
      }
    ]
  }
}
```

Skills and plugins use exact ClawHub versions:

```json
{
  "packages": [
    {
      "kind": "skill",
      "source": "clawhub",
      "ref": "incident-triage",
      "version": "1.0.0"
    },
    {
      "kind": "plugin",
      "source": "clawhub",
      "ref": "@acme/audit-plugin",
      "version": "2.0.0"
    }
  ]
}
```

The dry run uses the existing skill and plugin preflight paths to resolve the
exact artifact, integrity, and any ClawHub trust warning before consent. The
warning remains visible in the integrity-bound plan. Apply installs missing artifacts
or reuses matching ones and records whether the Claw introduced or referenced
each resource. Plugins remain process-wide OpenClaw capabilities rather than
per-agent installations.

Cron jobs declare scheduled work for the new agent:

```json
{
  "cronJobs": [
    {
      "id": "daily-summary",
      "name": "Daily incident summary",
      "schedule": { "cron": "0 9 * * *", "timezone": "UTC" },
      "session": "isolated",
      "message": "Summarize active incidents."
    }
  ]
}
```

Claws use the existing Gateway scheduler and bind created jobs to the new
agent. Preview, provenance, status, and removal cover those jobs without
changing the behavior of ordinary cron commands. Removal rereads the live job
through the Gateway and preserves it when its owned definition changed after
planning.

MCP declarations use the existing `mcp.servers` configuration model:

```json
{
  "mcpServers": {
    "statuspage": {
      "command": "npx",
      "args": ["--yes", "@acme/statuspage-mcp@1.0.0"],
      "env": { "STATUSPAGE_TOKEN": "${STATUSPAGE_TOKEN}" }
    }
  }
}
```

Environment references remain references; Claws do not embed resolved secret
values. A collision-free declaration becomes managed, while an exact existing
or shared declaration is referenced. Preview, provenance, status, export, and
removal follow the same ownership policy as other Claw resources.

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
prerequisites, blockers, distinct capability escalations, and a `planIntegrity`
digest. Capability records show the exact package, MCP, scheduled-work, sandbox,
tool, or heartbeat effect. Review the plan before creating the agent:

```bash
openclaw claws add ./incident-triage.claw.json \
  --yes \
  --plan-integrity <SHA256_FROM_DRY_RUN>
```

`--yes` alone is insufficient. OpenClaw rebuilds the plan and rejects consent
when the source, destination, or live configuration changed after preview. Use
`--agent-id` or `--workspace` during both preview and apply when package
defaults collide with local state.

Adding a Claw creates the new agent and workspace configuration, writes declared
workspace files, installs or reuses declared skill and plugin artifacts, and
records provenance. Existing files are not overwritten, and retries fail closed
when owned content drifted. Later Claws stages add other declared resources.

## Inspect installed state

```bash
openclaw claws status
openclaw claws status incident-triage --json
openclaw doctor
```

`status` compares the installed agent and its recorded workspace, package, MCP,
and cron provenance with current state. It reports incomplete installs, missing
resources, and drift without changing local state. `openclaw doctor` adds
Claw-specific diagnostics for incomplete ownership records, unsafe managed
files, and cron jobs that cannot be corroborated with live Gateway inventory.

Claw provenance distinguishes two relationships:

- **Managed:** the Claw introduced and currently manages the resource. It is a
  cleanup candidate when unchanged and no conflicting owner remains.
- **Referenced:** the resource existed independently or is shared. Removal
  releases this Claw's reference and retains the resource by default.

This is not a reference count. Ordinary plugin, skill, and agent commands keep
their existing behavior; Claws add provenance and guarded lifecycle operations
on top.

## Update an installed Claw

By default, update uses the source recorded when the Claw was added. Use
`--from` when that source moved or when testing another package directory:

```bash
openclaw claws update incident-triage --dry-run --json
openclaw claws update incident-triage \
  --from ./incident-triage-next \
  --dry-run --json
```

The plan compares current provenance and live state with the target manifest.
It reports agent, workspace, package, MCP, cron, and ownership changes,
including capability escalations and blockers. Capability escalations have
separate machine-readable records and `!` lines with exact redacted effects in
human output. Resolved package integrity, install identity, and any trust
warning are included. Removing a package declaration releases this Claw's edge
without uninstalling the artifact during update. The eventual
exact `planIntegrity` confirmation binds that disclosed set as well as ordinary
content changes. Hosts may use the same records for a separate dialog or an
aggregate multi-agent review. Apply the exact reviewed plan with explicit
consent:

```bash
openclaw claws update incident-triage \
  --yes \
  --plan-integrity <SHA256_FROM_DRY_RUN>
```

OpenClaw rebuilds the plan and compare-and-swaps owned state before each
mutation. Removed package declarations release dependency edges without
uninstalling artifacts. Cron changes reread the live scheduler definition and
stop on operator drift. Package installers, source-config writers, and the Gateway scheduler
are not one transaction. If compensation cannot be proven after an external
mutation, OpenClaw reports error code `update_partial` with structured
`status: partial`, preserves uncertain provenance,
and stops. Inspect `claws status`, the affected resource, and `openclaw doctor`;
then preview again before retrying or removing anything.

## Remove an installed Claw

Preview removal before selecting cleanup:

```bash
openclaw claws remove incident-triage --dry-run --json
openclaw claws remove incident-triage \
  --yes \
  --plan-integrity <SHA256_FROM_DRY_RUN>
```

The default removes eligible managed state and releases referenced state.
Modified files and resources with another current owner are retained or
blocked. Cleanup choices are part of the plan digest; `--yes` never broadens
them. Globally installed plugins are retained while this Claw's reference is
released; use the ordinary plugin lifecycle separately when you intend to
uninstall a process-wide plugin.

To remove unchanged Claw-introduced references that have no other current
owner, include `--remove-unused` in both preview and apply. To select exact
referenced resources instead, repeat `--remove-referenced`:

```bash
openclaw claws remove incident-triage \
  --dry-run \
  --remove-referenced 'plugin:@acme/audit-plugin@2.0.0'
```

Use `--force-referenced` only after reviewing the displayed dependents,
independent owners, and pre-existing origin. It allows selected cleanup despite
those conflicts; it does not skip plan-integrity consent.

## Export an installed agent

Export creates a new package directory and fails if the destination exists or
managed state has drifted:

```bash
openclaw claws export incident-triage --out ./incident-triage-export --json
```

The result contains `package.json`, `openclaw.claw.json`, and managed workspace
sidecars. It is a portable Claw package, not a whole-instance backup: unrelated
agents, credentials, sessions, and unowned local state are excluded.

## Command reference

| Command                             | Purpose                                             |
| ----------------------------------- | --------------------------------------------------- |
| `claws inspect <source>`            | Validate a package directory or JSON manifest.      |
| `claws add <source>`                | Preview or create one new agent and workspace.      |
| `claws status [claw-or-agent]`      | Report installed state, ownership, and drift.       |
| `claws update <claw-or-agent>`      | Preview or apply changes from the selected source.  |
| `claws remove <claw-or-agent>`      | Preview or remove the agent and eligible resources. |
| `claws export <agent> --out <path>` | Create a portable package from an installed agent.  |

Use `--json` for experimental machine-readable output.

## See also

- [Agents](/cli/agents)
- [Skills](/tools/skills)
- [Plugins](/tools/plugin)
- [Cron jobs](/automation/cron-jobs)
- [MCP configuration](/gateway/configuration-reference#mcp)
