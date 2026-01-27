---
summary: "Repository scripts: purpose, scope, and safety notes"
read_when:
  - Running scripts from the repo
  - Adding or changing scripts under ./scripts
---
# Scripts

The `scripts/` directory contains helper scripts for local workflows and ops tasks.
Use these when a task is clearly tied to a script; otherwise prefer the CLI.

## Conventions

- Scripts are **optional** unless referenced in docs or release checklists.
- Prefer CLI surfaces when they exist (example: auth monitoring uses `moltbot models status --check`).
- Assume scripts are host‑specific; read them before running on a new machine.

## Git hooks

- `scripts/setup-git-hooks.js`: best-effort setup for `core.hooksPath` when inside a git repo.
- `scripts/format-staged.js`: pre-commit formatter for staged `src/` and `test/` files.

## Auth monitoring scripts

Auth monitoring scripts are documented here:
[/automation/auth-monitoring](/automation/auth-monitoring)

## When adding scripts

- Keep scripts focused and documented.
- Add a short entry in the relevant doc (or create one if missing).
