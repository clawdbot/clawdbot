---
summary: "Repository scripts: purpose, scope, and safety notes"
read_when:
  - Running scripts from the repo
  - Adding or changing scripts under ./scripts
title: "Scripts"
---

`scripts/` holds helper scripts for local workflows and ops tasks. Use these when a task is clearly tied to a script; otherwise prefer the CLI.

## Conventions

- Scripts are **optional** unless referenced in docs or release checklists.
- Prefer CLI surfaces when they exist (example: `openclaw models status --check`).
- Assume scripts are host-specific; read them before running on a new machine.

## Auth monitoring scripts

General model auth is covered in [Authentication](/gateway/authentication). The scripts below are a separate, optional system for monitoring a **Claude Code CLI subscription token** on a remote/headless host and re-authenticating from a phone:

- `scripts/setup-auth-system.sh` - one-time setup: checks current auth, helps generate a long-lived `claude setup-token`, and prints systemd/Termux install steps.
- `scripts/claude-auth-status.sh [full|json|simple]` - checks Claude Code + OpenClaw auth status.
- `scripts/auth-monitor.sh` - polls status and sends a notification (via OpenClaw send, and/or ntfy.sh) when the token nears expiry. Env: `WARN_HOURS` (default `2`), `NOTIFY_PHONE`, `NOTIFY_NTFY`. Run on a schedule via the bundled `scripts/systemd/openclaw-auth-monitor.{service,timer}` (every 30 minutes).
- `scripts/mobile-reauth.sh` - re-runs `claude setup-token` and prints URLs to open on a phone, for use over SSH from Termux.
- `scripts/termux-quick-auth.sh`, `scripts/termux-auth-widget.sh`, `scripts/termux-sync-widget.sh` - Termux:Widget scripts that SSH to the host, show a status toast, and open the re-auth console/instructions when auth has expired.

## GitHub read helper

Use `scripts/gh-read` when you want `gh` to use a GitHub App installation token for repo-scoped read calls while leaving normal `gh` on your personal login for write actions.

Required env:

- `OPENCLAW_GH_READ_APP_ID`
- `OPENCLAW_GH_READ_PRIVATE_KEY_FILE`

Optional env:

- `OPENCLAW_GH_READ_INSTALLATION_ID` when you want to skip repo-based installation lookup
- `OPENCLAW_GH_READ_PERMISSIONS` as a comma-separated override for the read permission subset to request

Repo resolution order:

- `gh ... -R owner/repo`
- `GH_REPO`
- `git remote origin`

Examples:

- `scripts/gh-read pr view 123`
- `scripts/gh-read run list -R openclaw/openclaw`
- `scripts/gh-read api repos/openclaw/openclaw/pulls/123`

## When adding scripts

- Keep scripts focused and documented.
- Add a short entry in the relevant doc (or create one if missing).

## Related

- [Testing](/help/testing)
- [Testing live](/help/testing-live)
