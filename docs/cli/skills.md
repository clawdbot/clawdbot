---
summary: "CLI reference for `openclaw skills` (search/install/update/list/info/check)"
read_when:
  - You want to see which skills are available and ready to run
  - You want to search ClawHub or install skills from ClawHub, Git, or local directories
  - You want to debug missing binaries/env/config for skills
title: "Skills"
---

# `openclaw skills`

Inspect local skills, search ClawHub, install skills from ClawHub/Git/local directories, and update
ClawHub-tracked installs.

Related:

- Skills system: [Skills](/tools/skills)
- Skills config: [Skills config](/tools/skills-config)
- ClawHub installs: [ClawHub](/clawhub/cli)

## Commands

```bash
openclaw skills search "calendar"
openclaw skills search --limit 20 --json
openclaw skills install <slug>
openclaw skills install <slug> --version <version>
openclaw skills install git:owner/repo
openclaw skills install git:owner/repo@main
openclaw skills install ./path/to/skill --as custom-name
openclaw skills install <slug> --force
openclaw skills install <slug> --agent <id>
openclaw skills install <slug> --global
openclaw skills update <slug>
openclaw skills update <slug> --global
openclaw skills update --all
openclaw skills update --all --agent <id>
openclaw skills update --all --global
openclaw skills list
openclaw skills list --eligible
openclaw skills list --json
openclaw skills list --verbose
openclaw skills list --agent <id>
openclaw skills info <name>
openclaw skills info <name> --json
openclaw skills info <name> --agent <id>
openclaw skills check
openclaw skills check --agent <id>
openclaw skills check --json
```

`search` and `update` use ClawHub directly. `install <slug>` installs a ClawHub
skill, `install git:owner/repo[@ref]` clones a Git skill, and `install ./path`
copies a local skill directory. By default, `install` and `update` target the
active workspace `skills/` directory; with `--global`, they target the shared
managed skills directory. `list`/`info`/`check` still inspect the local skills
visible to the current workspace and config. Workspace-backed commands resolve
the target workspace from `--agent <id>`, then the current working directory
when it is inside a configured agent workspace, then the default agent.

Git and local directory installs expect `SKILL.md` at the source root. The
install slug comes from `SKILL.md` frontmatter `name` when it is valid, then the
source directory or repository name; use `--as <slug>` to override it. `--version`
is ClawHub-only. Skill installs do not support npm package specs or zip/archive
paths, and `openclaw skills update` updates ClawHub-tracked installs only.

Gateway-backed skill dependency installs triggered from onboarding or Skills
settings use the separate `skills.install` request path instead.

Notes:

- `search [query...]` accepts an optional query; omit it to browse the default
  ClawHub search feed.
- `search --limit <n>` caps returned results.
- `install git:owner/repo[@ref]` installs a Git skill. Branch refs may contain
  slashes, such as `git:owner/repo@feature/foo`.
- `install ./path/to/skill` installs a local directory whose root contains
  `SKILL.md`.
- `install --as <slug>` overrides the inferred slug for Git and local directory
  installs.
- `install --version <version>` applies only to ClawHub skill slugs.
- `install --force` overwrites an existing workspace skill folder for the same
  slug.
- `--global` targets the shared managed skills directory and cannot be combined
  with `--agent <id>`.
- `--agent <id>` targets one configured agent workspace and overrides current
  working directory inference.
- `update <slug>` updates a single tracked skill. Add `--global` to target the
  shared managed skills directory instead of the workspace.
- `update --all` updates tracked ClawHub installs in the selected workspace, or
  in the shared managed skills directory when combined with `--global`.
- `check --agent <id>` checks the selected agent's workspace and reports which
  ready skills are actually visible to that agent's prompt or command surface.
- `list` is the default action when no subcommand is provided.
- `list`, `info`, and `check` write their rendered output to stdout. With
  `--json`, that means the machine-readable payload stays on stdout for pipes
  and scripts.

## Related

- [CLI reference](/cli)
- [Skills](/tools/skills)
