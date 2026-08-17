---
summary: "Create, add, update, and remove experimental Claw agent packages"
read_when:
  - You are authoring or validating a CLAW.md manifest
  - You want to preview or add one agent from a Claw
  - You need to inspect Claw ownership, drift, or cleanup behavior
title: "Claws"
---

# `openclaw claws`

A Claw is a versioned setup for one OpenClaw agent. It can describe the
agent's portable identity, workspace files, skills, plugins, MCP servers, and
cron jobs. Harness-specific agent settings may be carried in a conventional
package profile. By default, add creates a new agent; explicit adoption can
transfer lifecycle ownership of an exact existing configuration.

Claws are experimental. Their schema, command output, and lifecycle may change.
Enable the command surface explicitly:

```bash
export OPENCLAW_EXPERIMENTAL_CLAWS=1
```

The current CLI reads a local package directory, `CLAW.md`, or grouped JSON manifest.
Publishing, searching, and installing whole Claws through ClawHub are a
separate registry track and are not part of this command surface yet.

## Create a Claw package

A package contains `package.json`, a `CLAW.md` manifest, and any conventional
profiles, bootstrap instructions, or portable assets used by that manifest:

```json
{
  "name": "@acme/incident-triage-claw",
  "version": "1.0.0",
  "type": "module",
  "openclaw": { "claw": "CLAW.md" }
}
```

`CLAW.md` starts with YAML frontmatter. A non-empty Markdown body is the
portable agent prompt. OpenClaw applies it as the Claw-managed `SOUL.md` for
the new agent:

```md
---
schemaVersion: 1
agent:
  id: incident-triage
  name: Incident triage
workspace:
  bootstrapFiles: {}
packages: []
mcpServers: {}
cronJobs: []
---

# Incident triage

You review incoming incidents, identify severity and ownership, and leave a
concise handoff with evidence.
```

OpenClaw automatically discovers the optional `profiles/openclaw.yml` file.
No manifest pointer is required. Other harnesses may discover their own
conventional profile, such as `profiles/codex.yml`, without changing the
portable manifest.

The older `metadata.openclaw.config` pointer is deprecated but still read, so
packages published against it keep working. Reading one reports a
`deprecated_openclaw_profile_pointer` warning; move that file to
`profiles/openclaw.yml` and remove the metadata entry. A pointer that is not a
package-relative `.yml`/`.yaml` path is rejected, and a pointer that references
a different file while `profiles/openclaw.yml` also exists is rejected as a
conflict.

```yaml
schemaVersion: 1
agent:
  tools:
    allow: [read, write, cron]
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
to the user's normal OpenClaw configuration path. Other harnesses consume the
portable manifest and interpret only their own conventional profile.

The same strict version 1 schema continues to accept grouped JSON manifests.
Grouped JSON discovers the same conventional profile rather than embedding a
second copy of the OpenClaw settings. The remaining schema fragments on this
page use JSON, with equivalent keys available in `CLAW.md` frontmatter.

The OpenClaw package profile may use an explicit `tools.allow` list or select
any built-in tool profile registered by the running OpenClaw version. The
`coding` and `messaging` profiles include the dynamic `bundle-mcp` selector, so
a Claw that selects either profile must also provide a bounded `tools.allow`
intersection. Name any MCP grants as concrete generated tool names such as
`github__list_issues`; the package cannot freeze `bundle-mcp` itself.

Profiles can otherwise be refined with `alsoAllow`, `deny`, and
`tools.fs.workspaceOnly: true`. `tools.allow` cannot be combined with
`alsoAllow`; use a standalone allowlist, as above, when the package needs tools
outside its selected profile. A Claw cannot set `workspaceOnly` to `false` and
weaken host filesystem confinement. A Claw may also set
`memory.search.enabled`, choose the portable `memory` and `sessions` sources,
and opt into cross-conversation memory with `rememberAcrossConversations`.
Declaring the `sessions` source requires that opt-in.
Host policy still constrains these settings, and Claws do not carry custom
profile definitions, providers, credentials, bindings, or local memory paths.
The conventional profile is limited to 256 KiB, must be JSON-compatible YAML, may
not use aliases, anchors, tags, or merge keys, and must be a regular,
non-symlinked, non-hardlinked file inside the package.

An OpenClaw profile may also declare harness-specific extension requirements:

```yaml
schemaVersion: 1
agent: {}
extensions:
  - id: incident-tools
    kind: plugin
    format: claude
    source: clawhub
    ref: "@acme/incident-tools"
    version: 2.0.0
```

`format` asserts the artifact format that OpenClaw must detect (`openclaw`,
`claude`, `codex`, or `cursor`). The canonical plugin preflight resolves the
exact artifact and reports which components the current OpenClaw adapter maps
and which remain unavailable. Missing identity, integrity, format detection, or
adapter identity blocks apply. Extension-backed plugins use the existing
plugin installer and ownership model; they are shared host requirements, not
Claw-owned members or a second package system.

OpenClaw ignores foreign harness profiles during apply. Package integrity still
covers every published package byte, while a development snapshot binds the
portable manifest, bootstrap and workspace sources, and the selected OpenClaw
profile. Status and doctor report adapter mapping drift or unavailable
inspection. Export writes extension-backed plugins to `profiles/openclaw.yml`
and does not duplicate them in the portable `packages` list.

Package and workspace paths must remain inside the package root. Manifests are
limited to 1 MiB, package metadata to 256 KiB, and workspace sources enforce
separate per-file and aggregate limits. Workspace sources also reject symlinked
parents.

The `CLAW.md` body is the preferred portable source for `SOUL.md`; do not also
declare a `SOUL.md` sidecar when the body is non-empty. Other bootstrap files
use named entries, while additional files use package-relative sources and
workspace-relative targets:

```json
{
  "workspace": {
    "bootstrapFiles": {
      "AGENTS.md": { "source": "workspace/AGENTS.md" }
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

Additional files are the portable asset mechanism. Authors may organize package
sources under directories such as `assets/`, `schemas/`, `templates/`, and
`examples/`, then map them into the new agent workspace with
`workspace.files`. Apply records those destinations as managed files; update
reconciles unchanged managed assets, and remove preserves modified or
user-owned files.

An optional package-root `BOOTSTRAP.md` supplies conversational first-run
instructions. OpenClaw seeds it into the new agent workspace and records
progress through the native workspace bootstrap state. Once the agent consumes
or removes it, Claw update does not recreate it. Root `BOOTSTRAP.md` therefore
cannot also be declared through `workspace.files`. Claw removal deletes an
unchanged, still-pending package bootstrap after verifying its recorded digest;
it preserves edited bootstrap content and files created during onboarding.

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
warning remains visible in the integrity-bound plan. Each requirement is shown
as satisfied, missing-installable, conflicting, or setup-required. The exact
plan consent approves missing installs; OpenClaw completes those canonical
plugin actions before creating the agent or workspace. Apply reuses matching
artifacts and records whether the Claw introduced or referenced each resource.
Plugins remain process-wide OpenClaw capabilities rather than per-agent
installations.

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

## Author locally

Create a minimal project, validate its publishable inputs, preview its complete
OpenClaw add plan offline, and build an immutable package artifact:

```bash
openclaw claws create ./incident-triage
openclaw claws validate ./incident-triage
openclaw claws dev ./incident-triage
openclaw claws build ./incident-triage --out ./incident-triage-1.0.0.tgz
```

`create` writes only `package.json` and `CLAW.md` and refuses to merge into a
nonempty directory. Project validation requires `openclaw.claw` to point to
the root `CLAW.md`, rejects package scripts and lifecycle hooks, discovers a
single unambiguous project root, and reports files excluded from the package.

`dev` validates and builds the same artifact that would be published, then
runs that artifact through the canonical add planner. It does not install
packages, contact ClawHub, start an agent turn, enable schedules, deliver
messages, or modify OpenClaw state. Dependencies that require online preflight
appear as blockers instead of weakening that boundary. Use `--agent-id` or
`--workspace` to preview collision-free local destinations.

`build` writes a deterministic npm-compatible `.tgz` with a `package/` root.
Only package metadata, `CLAW.md`, optional `BOOTSTRAP.md`, the OpenClaw profile,
and sources selected by the manifest are included. Tests, caches, ambient or
unselected credentials, unselected files, prior artifacts, and source-control
state remain outside the package. Selected source bytes are package content, so
authors must not select secret-bearing files. Build refuses to overwrite an
existing artifact, reports its SHA-256 integrity, and re-opens it through the
canonical Claw reader before success.

## Inspect and preview

Validate the source without planning local changes. For OpenClaw profile
extensions, inspect also performs the canonical read-only artifact probe and
reports mapped and unavailable components:

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

Adding a Claw first realizes consented shared plugin requirements, then creates
the new agent and workspace configuration, seeds optional first-run
instructions, writes declared workspace assets, realizes workspace skills, and
records package, MCP, and cron provenance. Existing files are not overwritten,
and retries fail closed when owned content drifted.

By default an existing workspace directory is a `workspace_collision` blocker.
Pass `--adopt-existing-workspace` during both preview and apply to install into
an existing directory instead:

```bash
openclaw claws add ./incident-triage.claw.json \
  --workspace ~/agents/incident-triage \
  --adopt-existing-workspace \
  --dry-run --json
```

At plan time each declared file is compared against the existing content:
identical files become `adopt` actions and are recorded as managed without
being rewritten, missing files are written normally, and differing content is a
`workspace_file_conflict` blocker — adoption never overwrites existing files.
If the package defines first-run instructions, any existing package bootstrap
file is also a conflict, even when its content matches; Claws cannot safely
claim or later remove a bootstrap file it did not create.
Apply re-verifies content digests and fails closed when an adoptable file
changed after planning. The agent is added to configuration only after every
workspace file has been safely revalidated and recorded, so a failed adoption
cannot leave a partially owned workspace routable. Adoption is disclosed as a
distinct capability change in the plan, and a workspace already configured for
another agent still blocks.

Adoption transfers lifecycle ownership of matching declared files to Claws.
After adoption, `claws update` may replace an unchanged adopted file with the
content from the reviewed target package, and `claws remove` may delete an
unchanged adopted file. Locally modified adopted files are retained and must be
reconciled explicitly. Preview update and removal plans before applying them.

### Adopt a configured agent

Use configured-agent adoption to bring an agent that predates Claws under the
same package lifecycle. Pass the same agent id, workspace, and explicit flag in
both preview and apply:

```bash
openclaw claws add ./incident-triage.claw.json \
  --agent-id incident-triage \
  --workspace ~/agents/incident-triage \
  --adopt-existing-agent \
  --dry-run --json

openclaw claws add ./incident-triage.claw.json \
  --agent-id incident-triage \
  --workspace ~/agents/incident-triage \
  --adopt-existing-agent \
  --yes \
  --plan-integrity <SHA256_FROM_DRY_RUN>
```

`--adopt-existing-agent` also opts into adoption of that agent's configured
workspace. The agent must exist without another Claw install record, its
canonical workspace must equal the requested workspace, and no other agent may
use an overlapping workspace. After preserving the existing `default` marker,
the complete package-derived agent configuration must match exactly. Adoption
never rewrites a differing agent entry; the plan reports only the differing
field paths and blocks.

Successful adoption transfers ownership of the matching agent configuration,
declared workspace files, and other managed package resources. Status exposes
`agentOrigin: "adopted"`. Update retains the adopted agent's recorded
`default` marker and still treats any later full-configuration change as drift.

Removal deletes the managed agent configuration, derived bindings and allow
references, unchanged managed workspace files, and eligible package, MCP, and
cron resources. It never deletes an adopted agent's pre-existing agent
directory or database, session index, session transcripts, workspace
directory, or undeclared workspace files. Those historical artifacts remain
on disk after the Claw install record is removed.

Adopted-agent ownership uses a newer install-record format as a downgrade
fence. Builds that predate configured-agent adoption reject that record before
status, update, or removal can mutate it. Complete the lifecycle with a build
that supports configured-agent adoption before downgrading.

## Inspect installed state

```bash
openclaw claws status
openclaw claws status incident-triage --json
openclaw doctor
```

`status` reports whether the agent was created or adopted, then compares the
installed agent and its recorded workspace, package, MCP,
and cron provenance with current state. It also reports whether native
first-run bootstrap remains pending. It reports incomplete installs, missing
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
human output. Resolved package integrity, install identity, trust warnings, and
remaining local setup prerequisites are included. Removing a package declaration
releases this Claw's edge without uninstalling the artifact during update. The eventual
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
released. Removal reports which retained requirements Claw add introduced; use
the ordinary plugin lifecycle separately when you intend to uninstall a
process-wide plugin.

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

Use `--bootstrap <path>` to attach an explicitly reviewed Markdown file as the
package-root `BOOTSTRAP.md`. Export re-emits an unchanged, still-pending package
bootstrap automatically. A package bootstrap that drifted in the workspace
(edited, unsafe, or unreadable) fails the export with `bootstrap_drifted`, the
same way managed workspace files fail with `workspace_files_drifted`; pass
`--bootstrap <path>` with a reviewed replacement to export anyway. A bootstrap
the agent already consumed is a completed lifecycle state, so export omits
`BOOTSTRAP.md` instead of failing. The exporter validates the completed package
and removes the new output directory if validation fails. Bootstrap is
package-authored prompt content: do not include credentials, tokens, private
answers, or machine-specific paths. Export does not infer questions, render
personal-data templates, persist answers, or add a separate setup lifecycle.

The result contains `package.json`, canonical `CLAW.md`, and managed workspace
sidecars. Managed `SOUL.md` content is emitted as the `CLAW.md` body when it is
non-empty UTF-8 and the combined document fits the manifest limit. Otherwise,
export retains it as an explicit sidecar so the package remains importable. It
is a portable Claw package, not a whole-instance backup: unrelated agents,
credentials, sessions, and unowned local state are excluded.

## Command reference

| Command                             | Purpose                                             |
| ----------------------------------- | --------------------------------------------------- |
| `claws inspect <source>`            | Validate a package directory or grouped manifest.   |
| `claws add <source>`                | Preview or create one agent and its workspace.      |
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
