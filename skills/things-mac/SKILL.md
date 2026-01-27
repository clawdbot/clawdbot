---
name: things-mac
description: Manage Things 3 via the `things` CLI on macOS (add/update projects+todos via URL scheme; read/search/list from the local Things database). Use when a user asks Moltbot to add a task to Things, list inbox/today/upcoming, search tasks, or inspect projects/areas/tags.
homepage: https://github.com/ossianhempel/things3-cli
metadata: {"moltbot":{"emoji":"✅","os":["darwin"],"requires":{"bins":["things"]},"install":[{"id":"go","kind":"go","module":"github.com/ossianhempel/things3-cli/cmd/things@latest","bins":["things"],"label":"Install things3-cli (go)"}]}}
---

# Things 3 CLI

Use `things` to read your local Things database (inbox/today/search/projects/areas/tags) and to add/update todos via the Things URL scheme.

Setup
- Install (recommended, Apple Silicon): `GOBIN=/opt/homebrew/bin go install github.com/ossianhempel/things3-cli/cmd/things@latest`
- If DB reads fail: grant **Full Disk Access** to the calling app (Terminal for manual runs; `Moltbot.app` for gateway runs).
- Optional: set `THINGSDB` (or pass `--db`) to point at your `ThingsData-*` folder.
- Optional: set `THINGS_AUTH_TOKEN` to avoid passing `--auth-token` for update ops.

Read-only (DB)
- `things inbox --limit 50`
- `things today`
- `things upcoming`
- `things search "query"`
- `things projects` / `things areas` / `things tags`

Write (URL scheme)
- Prefer safe preview: `things --dry-run add "Title"`
- Add: `things add "Title" --notes "..." --when today --deadline 2026-01-02`
- Bring Things to front: `things --foreground add "Title"`

Examples: add a todo
- Basic: `things add "Buy milk"`
- With notes: `things add "Buy milk" --notes "2% + bananas"`
- Into a project/area: `things add "Book flights" --list "Travel"`
- Into a project heading: `things add "Pack charger" --list "Travel" --heading "Before"`
- With tags: `things add "Call dentist" --tags "health,phone"`
- Checklist: `things add "Trip prep" --checklist-item "Passport" --checklist-item "Tickets"`
- From STDIN (multi-line => title + notes):
  - `cat <<'EOF' | things add -`
  - `Title line`
  - `Notes line 1`
  - `Notes line 2`
  - `EOF`

Examples: modify a todo (needs auth token)
- First: get the ID (UUID column): `things search "milk" --limit 5`
- Auth: set `THINGS_AUTH_TOKEN` or pass `--auth-token <TOKEN>`
- Title: `things update --id <UUID> --auth-token <TOKEN> "New title"`
- Notes replace: `things update --id <UUID> --auth-token <TOKEN> --notes "New notes"`
- Notes append/prepend: `things update --id <UUID> --auth-token <TOKEN> --append-notes "..."` / `--prepend-notes "..."`
- Move lists: `things update --id <UUID> --auth-token <TOKEN> --list "Travel" --heading "Before"`
- Tags replace/add: `things update --id <UUID> --auth-token <TOKEN> --tags "a,b"` / `things update --id <UUID> --auth-token <TOKEN> --add-tags "a,b"`
- Complete/cancel (soft-delete-ish): `things update --id <UUID> --auth-token <TOKEN> --completed` / `--canceled`
- Safe preview: `things --dry-run update --id <UUID> --auth-token <TOKEN> --completed`

Delete a todo?
- Not supported by `things3-cli` right now (no “delete/move-to-trash” write command; `things trash` is read-only listing).
- Options: use Things UI to delete/trash, or mark as `--completed` / `--canceled` via `things update`.

Notes
- macOS-only.
- `--dry-run` prints the URL and does not open Things.
