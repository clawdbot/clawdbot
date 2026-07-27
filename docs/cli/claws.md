---
summary: "Create, add, update, and remove experimental Claw agent packages"
read_when:
  - You are authoring or validating a CLAW.md manifest
  - You want to preview or add one agent from a Claw
  - You need to inspect Claw ownership, drift, or cleanup behavior
title: "Claws"
---

# `openclaw claws`

A Claw is a versioned setup for one new OpenClaw agent. It can describe the
agent's portable identity, workspace files, skills, plugins, MCP servers, and
cron jobs. Harness-specific agent settings may be carried in a referenced
package profile. A Claw does not replace or modify an existing agent.

Claws are experimental. Their schema, command output, and lifecycle may change.
Enable the command surface explicitly:

```bash
export OPENCLAW_EXPERIMENTAL_CLAWS=1
```

The current CLI reads a local package directory, `CLAW.md`, or grouped JSON manifest.
Publishing, searching, and installing whole Claws through ClawHub are a
separate registry track and are not part of this command surface yet.

## Create a Claw package

A package contains `package.json`, a `CLAW.md` manifest, and any profiles or
workspace sidecars referenced by that manifest:

```json
{
  "name": "@acme/incident-triage-claw",
  "version": "1.0.0",
  "type": "module",
  "openclaw": { "claw": "CLAW.md" }
}
```

`CLAW.md` starts with YAML frontmatter. Its Markdown body describes the Claw
for people and is not part of the agent configuration:

```md
---
schemaVersion: 1
agent:
  id: incident-triage
  name: Incident triage
metadata:
  openclaw.config: profiles/openclaw.yml
workspace:
  bootstrapFiles: {}
packages: []
mcpServers: {}
cronJobs: []
---

# Incident triage

Creates one agent for reviewing and routing incidents.
```

`metadata` is a string-to-string map for portable consumer hints. OpenClaw's
`openclaw.config` key points to an optional, package-relative YAML profile. The
exported default is `profiles/openclaw.yml`; the pointer is normative, so a
package may choose another safe relative `.yml` or `.yaml` path.

```yaml
schemaVersion: 1
agent:
  tools:
    profile: coding
    alsoAllow: [cron]
    deny: [exec]
    fs:
      workspaceOnly: true
  memory:
    search:
      enabled: true
      rememberAcrossConversations: true
      sources: [memory, sessions]
```

This profile exists only inside the Claw package. OpenClaw validates and uses it
while inspecting, adding, updating, and exporting that Claw; it is not copied
to the user's normal OpenClaw configuration path. Other harnesses can ignore
the namespaced metadata key and consume the portable manifest fields.

The same strict version 1 schema continues to accept grouped JSON manifests.
Grouped JSON uses the same `metadata.openclaw.config` pointer rather than
embedding a second copy of the OpenClaw profile. The remaining schema fragments
on this page use JSON, with equivalent keys available in `CLAW.md` frontmatter.

The OpenClaw package profile may select any built-in tool profile registered by
the running OpenClaw version, then refine it with `alsoAllow`, `deny`, and
`tools.fs.workspaceOnly: true`. A Claw cannot set that field to `false` and
weaken host filesystem confinement. `tools.allow` remains available as an
explicit allowlist but cannot be combined with `alsoAllow`. A Claw may also set
`memory.search.enabled`, choose the portable `memory` and `sessions` sources,
and opt into cross-conversation memory with `rememberAcrossConversations`.
Declaring the `sessions` source requires that opt-in.
Host policy still constrains these settings, and Claws do not carry custom
profile definitions, providers, credentials, bindings, or local memory paths.
The referenced profile is limited to 256 KiB, must be JSON-compatible YAML, may
not use aliases, anchors, tags, or merge keys, and must be a regular,
non-symlinked, non-hardlinked file inside the package.

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
defaults collide with local state. For disposable profiles and parallel validation,
pass an explicit `--workspace`; `OPENCLAW_STATE_DIR` relocates runtime state but
does not change the default workspace location.

Adding a Claw creates the new agent and workspace configuration, writes declared
workspace files, installs or reuses declared skill and plugin artifacts, and
records package, MCP, and cron provenance. Existing files are not overwritten,
and retries fail closed when owned content drifted.

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

The result contains `package.json`, canonical `CLAW.md`, and managed workspace
sidecars. It is a portable Claw package, not a whole-instance backup: unrelated
agents, credentials, sessions, and unowned local state are excluded.

## Command reference

| Command                             | Purpose                                             |
| ----------------------------------- | --------------------------------------------------- |
| `claws inspect <source>`            | Validate a package directory or grouped manifest.   |
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
