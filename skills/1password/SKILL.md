---
name: 1password
description: "Set up and use 1Password CLI for sign-in, desktop integration, and reading or injecting secrets."
homepage: https://developer.1password.com/docs/cli/get-started/
metadata:
  {
    "openclaw":
      {
        "emoji": "🔐",
        "requires": { "bins": ["op"] },
        "install":
          [
            {
              "id": "brew",
              "kind": "brew",
              "formula": "1password-cli",
              "bins": ["op"],
              "label": "Install 1Password CLI (brew)",
            },
          ],
      },
  }
---

# 1Password CLI

Follow the official CLI get-started steps. Don't guess install commands.

## References

- `references/get-started.md` (install + app integration + sign-in flow)
- `references/cli-examples.md` (real `op` examples)

## Workflow

1. Check OS + shell.
2. Verify CLI present: `op --version`.
3. Detect the auth mode the user has set up:
   - **Service account:** `OP_SERVICE_ACCOUNT_TOKEN` is set (typical for headless setups, CI, gateways).
   - **Desktop app integration:** the 1Password desktop app is running with CLI integration enabled (typical on macOS / Windows / Linux desktops).
   - **Standalone signin:** neither of the above — `op signin` will prompt for an account password every session.
4. Run `op` according to the auth mode (see below).
5. Verify access: `op whoami` should succeed before any secret read.
6. If multiple accounts: use `--account` or `OP_ACCOUNT`.

## Running `op` per auth mode

### Service account (preferred for headless / gateway use)

Direct exec. No tmux, no signin step.

```bash
export OP_SERVICE_ACCOUNT_TOKEN="ops_..."
op vault list
op read op://app-prod/db/password
```

### Desktop app integration

Direct exec. **Do not wrap in tmux** — the desktop app integration uses a per-user IPC channel that is established for the gateway's exec environment but is not always reliably reachable from tmux subshells, which run with a different environment context. The transport differs per platform (XPC via the 1Password Browser Helper on macOS, a Unix domain socket on Linux, a named pipe on Windows); the practical rule for an agent is the same on all three: run `op` directly. On macOS, a useful symptom indicator is the 1Password integration group container at `~/Library/Group Containers/2BUA8C4S2C.com.1password/t/`.

```bash
op vault list      # may trigger Touch ID / Windows Hello / system auth on first call
op whoami
```

If a call returns `1Password CLI couldn't connect to the 1Password desktop app`, do not switch to tmux. Confirm the desktop app is running and unlocked, then retry direct exec.

### Standalone signin (no app, interactive password)

This is the only mode where tmux helps. `op signin` prints an `eval`-style export setting an `OP_SESSION_*` token for POSIX shells; later commands in the same shell are authenticated by that env var. The gateway's per-command shells lose that state between calls, so a persistent tmux pane keeps the session token alive — but only if the export is actually applied with `eval` in a POSIX shell. Sending `op signin` as a plain command leaves stdout printed to the pane and `op whoami` will fail.

The tmux flow is only actionable on macOS/Linux hosts where the `tmux` skill is available. The example intentionally opens `/bin/sh` so the POSIX `eval "$(op signin ...)"` output is valid even when the user's normal shell is fish. On Windows, prefer desktop app integration or service account auth. If the user only has standalone interactive signin on Windows, stop and ask them to provide a persistent PowerShell session mechanism or switch to desktop integration/service account auth; do not translate the tmux commands directly.

```bash
SOCKET_DIR="${OPENCLAW_TMUX_SOCKET_DIR:-${TMPDIR:-/tmp}/openclaw-tmux-sockets}"
mkdir -p "$SOCKET_DIR"
chmod 700 "$SOCKET_DIR"
SOCKET="$SOCKET_DIR/openclaw-op.sock"
SESSION="op-auth-$(date +%Y%m%d-%H%M%S)"

tmux -S "$SOCKET" new -d -s "$SESSION" -n shell /bin/sh
tmux -S "$SOCKET" send-keys -t "$SESSION":0.0 -- 'eval "$(op signin --account my.1password.com)"' Enter
tmux -S "$SOCKET" capture-pane -t "$SESSION":0.0 -p -S - | tail -40
```

Do not queue follow-up commands while signin is prompting. Poll the pane with `capture-pane`
until signin has either completed and the shell prompt has returned, or it is clearly waiting for
human input. If the prompt requires a password, MFA, or account choice, pause and ask the user to
complete signin in their own terminal; give them the socket and session values so they can attach
locally. The agent should not run `tmux attach` from exec because attach consumes the current TTY and
prevents scripted `send-keys` / `capture-pane` control.

After the shell prompt returns, verify by sending the checks into the same pane:

```bash
tmux -S "$SOCKET" send-keys -t "$SESSION":0.0 -- 'op whoami' Enter
tmux -S "$SOCKET" send-keys -t "$SESSION":0.0 -- 'op vault list' Enter
tmux -S "$SOCKET" capture-pane -t "$SESSION":0.0 -p -S - | tail -80
```

Keep the tmux session running so later `op read` / `op run` commands reuse the same authenticated shell.

Use the same `SOCKET` and `SESSION` values for every follow-up command in this standalone signin flow. The `-S "$SOCKET"` flag selects the tmux server socket; keep it in a user-owned `0700` directory, do not share it between users, and choose a new session name for each new signin attempt.

## Browser sign-in (1Password for Claude)

If the session exposes Claude in Chrome credential tools (`request_credentials`, `autofill_credential`, `enter_verification_code`), prefer them over `op` for signing in to websites: 1Password fills the page directly and the secret never enters context. Rules:

- Request every credential the task needs in one `request_credentials` call before navigating.
- Approval is a 1Password prompt on the gateway host. If it stays pending, tell the user which host to unlock ("1Password is waiting for approval on this Mac") instead of retrying.
- Never ask the user to send passwords or one-time codes through chat; codes go through `enter_verification_code` only.
- Do not fall back to `op read` for a website password just because the browser flow needs approval; that defeats the no-exposure design. Use `op` for secrets consumed by commands and config, not for web logins when the browser flow exists.

## Guardrails

- Never paste secrets into logs, chat, or code.
- Prefer `op run` / `op inject` over writing secrets to disk.
- If sign-in without app integration is needed, use `op account add` first.
- If a command returns "account is not signed in":
  - service account: re-export `OP_SERVICE_ACCOUNT_TOKEN`
  - desktop app: confirm the app is running and integration is enabled
  - standalone: re-run `op signin` inside the same tmux session and authorize
