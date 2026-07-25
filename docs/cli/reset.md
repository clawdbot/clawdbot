---
summary: "CLI reference for `openclaw reset` (reset local state/config)"
read_when:
  - You want to wipe local state while keeping the CLI installed
  - You want a dry-run of what would be removed
title: "Reset"
---

# `openclaw reset`

Reset local config/state (keeps the CLI installed).

```bash
openclaw reset
openclaw reset --dry-run
openclaw reset --scope config --yes --non-interactive
openclaw reset --scope config+creds+sessions --yes --non-interactive
openclaw reset --scope full --yes --non-interactive
```

## Options

- `--scope <scope>`: `config`, `config+creds+sessions`, or `full`
- `--yes`: skip confirmation prompts
- `--non-interactive`: disable prompts; requires `--scope` and `--yes`
- `--dry-run`: print actions without removing files

## Scopes

| Scope                   | Removes                                                                     | Stops gateway first |
| ----------------------- | --------------------------------------------------------------------------- | ------------------- |
| `config`                | config file only                                                            | no                  |
| `config+creds+sessions` | config file, OAuth/credentials dir, per-agent session directories           | yes                 |
| `full`                  | state dir (including the shared SQLite database) plus workspace directories | yes                 |

`config+creds+sessions` and `full` stop a running managed gateway service before deleting state.

## Notes

- Run `openclaw backup create` first for a restorable snapshot before removing local state.
- Workspace setup state and attestations are rows in the shared SQLite database, so `full` removes them with the state directory; there are no current attestation sidecar files to remove separately.
- Without `--scope`, `openclaw reset` prompts interactively for the scope to remove.
- `--non-interactive` is only valid when both `--scope` and `--yes` are set.
- `config+creds+sessions` and `full` print `Next: openclaw onboard --install-daemon` when done.

## Related

- [CLI reference](/cli)
