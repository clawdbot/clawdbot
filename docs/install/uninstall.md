---
doc-schema-version: 1
summary: "Uninstall OpenClaw completely (CLI, service, state, workspace)"
read_when:
  - You want to remove OpenClaw from a machine
  - The gateway service is still running after uninstall
title: "Uninstall"
---

Complete removal has two phases:

1. Remove the Gateway service, state, workspaces, and macOS app with the built-in
   uninstaller or the manual service steps.
2. Remove the CLI files created by your installation method.

`openclaw uninstall --all` intentionally does **not** remove the CLI. Keeping the
CLI available lets the first phase finish even when service or data cleanup
needs recovery.

<Warning>
Before deleting state or an installation prefix, move every workspace and
configuration file you want to keep outside that directory.
</Warning>

## Remove runtime data with the CLI

The command attempts independent requested cleanup scopes and returns a nonzero status if any scope fails or is blocked. Service teardown remains the safety gate for state and workspace deletion; if that gate fails, those data scopes are preserved while app cleanup is still attempted. Partial cleanup is reported explicitly and is never followed by an unconditional completion result.

Preview every built-in cleanup scope first:

```bash
openclaw uninstall --dry-run --all
```

Then run the interactive uninstaller:

```bash
openclaw uninstall
```

State removal preserves configured workspace directories unless you also select
`--workspace`. Flags `--service`, `--state`, `--workspace`, and `--app` select
individual scopes; `--all` selects all four.

For non-interactive automation, confirm the preview before adding `--yes`:

```bash
openclaw uninstall --all --yes --non-interactive
npx -y openclaw uninstall --all --yes --non-interactive
```

After this phase, continue with [Remove the CLI](#remove-the-cli). If the CLI is
already missing but the service remains, use
[Manual service removal](#manual-service-removal-cli-missing) first.

## Remove runtime data manually

Manual steps provide a complete removal path, but a raw state-directory deletion
does not have the built-in uninstaller's workspace-preservation behavior. If
you want the equivalent of `openclaw uninstall --state`, preserve every
configured workspace before deleting state.

1. Stop the gateway service:

```bash
openclaw gateway stop
```

2. Uninstall the gateway service (launchd/systemd/schtasks):

```bash
openclaw gateway uninstall
```

3. Decide whether to preserve the workspace.

`openclaw uninstall --state` deliberately preserves configured workspace
directories, including the default `~/.openclaw/workspace`. Before using the
manual `rm -rf` below, move any workspace you want to keep outside the state
directory. If you want to remove it too, no separate deletion is needed when it
lives inside the state directory.

4. Delete state + config:

```bash
rm -rf "${OPENCLAW_STATE_DIR:-$HOME/.openclaw}"
```

If you set `OPENCLAW_CONFIG_PATH` to a custom location outside the state dir, delete that file too.
Restore any preserved workspace to its configured path after recreating the
parent directory, or update the workspace path in your next installation.

5. Delete a workspace stored outside the state directory only if you want to
   remove its agent files too:

```bash
rm -rf /path/to/external/workspace
```

6. If you installed the macOS app:

```bash
rm -rf /Applications/OpenClaw.app
```

7. Continue with [Remove the CLI](#remove-the-cli).

Notes:

- If you used profiles (`--profile` / `OPENCLAW_PROFILE`), repeat steps 3-4 for each state dir (defaults are `~/.openclaw-<profile>`).
- In remote mode, the state dir lives on the **gateway host**, so run steps 1-4 there too.

## Remove the CLI

Choose the row that matches how you installed OpenClaw. Do not delete a Git
checkout before removing its wrapper: otherwise a broken `openclaw` command can
remain on `PATH`.

| Installation method                                           | CLI owner to remove                                                    |
| ------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `install.sh` default (`npm`) or `install.ps1` default (`npm`) | Global npm package                                                     |
| Direct `npm`, `pnpm`, or Bun global install                   | The matching package-manager package                                   |
| `install.sh --install-method git`                             | `~/.local/bin/openclaw` wrapper, then the Git checkout                 |
| `install.ps1 -InstallMethod git`                              | `%USERPROFILE%\.local\bin\openclaw.cmd` wrapper, then the Git checkout |
| `install-cli.sh` default or custom prefix                     | The dedicated prefix; for Git mode, also the separate checkout         |
| Direct source checkout without an installer                   | The checkout and any wrapper or symlink you created yourself           |

### Package-manager install

Run only the command for the package manager you used:

```bash
npm rm -g openclaw
pnpm remove -g openclaw
bun remove -g openclaw
```

`install.sh` and `install.ps1` use npm in their default installation mode.

### install.sh Git install (macOS, Linux, or WSL)

The installer writes `~/.local/bin/openclaw` and points it at the selected Git
checkout (default `~/openclaw`). Inspect the wrapper before removing it:

```bash
sed -n '1,4p' "$HOME/.local/bin/openclaw"
```

The installer-owned wrapper has exactly three lines with this shape:

```text
#!/usr/bin/env bash
set -euo pipefail
exec <node-path> <checkout>/dist/entry.js "$@"
```

If the file has that shape and points to the checkout you intend to remove,
set `git_dir` to that exact checkout path, then delete the wrapper **before**
the checkout:

```bash
git_dir="/path/to/openclaw-checkout"
rm -f "$HOME/.local/bin/openclaw"
rm -rf -- "$git_dir"
```

If the wrapper differs, leave it in place; another tool or installation owns
it.

### install.ps1 Git install (Windows)

The installer writes `%USERPROFILE%\.local\bin\openclaw.cmd` and points it at
the selected checkout (default `%USERPROFILE%\openclaw`). Inspect it first:

```powershell
$wrapper = Join-Path $env:USERPROFILE ".local\bin\openclaw.cmd"
Get-Content -LiteralPath $wrapper
```

The installer-owned wrapper has this shape:

```text
@echo off
node "<checkout>\dist\entry.js" %*
```

If it matches and points to the checkout you intend to remove, delete the
wrapper before that exact checkout:

```powershell
$gitDir = "C:\path\to\openclaw-checkout"
Remove-Item -LiteralPath $wrapper -Force
Remove-Item -LiteralPath $gitDir -Recurse -Force
```

If the wrapper differs, leave it in place.

### install-cli.sh dedicated prefix

`install-cli.sh` owns a dedicated prefix containing its wrapper, local Node
runtime, and npm package. Its default prefix is `~/.openclaw`; `--prefix` or
`OPENCLAW_PREFIX` can select another path. Git mode also owns a separate
checkout (default `~/openclaw`).

Confirm the exact prefix you used. Delete it only if that directory is dedicated
to OpenClaw and you already preserved any state or workspace inside it:

```bash
prefix="/path/to/dedicated-openclaw-prefix"
printf 'Removing dedicated OpenClaw prefix: %s\n' "$prefix"
rm -rf -- "$prefix"
```

For a Git-mode prefix install, remove its checkout too:

```bash
git_dir="/path/to/openclaw-checkout"
rm -rf -- "$git_dir"
```

If you pointed `--prefix` at a shared directory, do not delete the whole
directory. Remove only the OpenClaw-owned wrapper/runtime/package after
inspecting that prefix, or reinstall into a dedicated prefix before cleanup.

### Direct source checkout

After removing the Gateway service, delete any wrapper or symlink you created
for the checkout, then delete the checkout itself. Leave package-manager shims
and wrappers owned by another installation in place.

## Remove completion and PATH changes

State cleanup removes the cached completion scripts, but it cannot safely edit
your shell profile after the CLI is gone. If you installed completion, open the
profile listed in the [completion reference](/cli/completion#install-flow) and
remove only the two-line OpenClaw block:

```text
# OpenClaw Completion
<source line for .../completions/openclaw.<shell>>
```

Also remove a legacy `source <(openclaw completion ...)`,
`eval "$(openclaw completion ...)"`, or equivalent PowerShell line only when
that line contains no other command. Preserve all surrounding profile content.

### POSIX PATH entries

Git mode may add one of these exact entries to Bash, zsh, or fish startup files:

```text
export PATH="$HOME/.local/bin:$PATH"
fish_add_path -- "$HOME/.local/bin"
```

Search your startup files, including `~/.bashrc`, the Bash login profile,
`~/.zshrc`, `~/.zprofile`, and `~/.config/fish/conf.d/openclaw.fish`. Remove the
exact line only if `~/.local/bin` contains no other commands you still use. The
directory is a shared user bin location; do not delete it wholesale.

### Windows PATH entries

Git mode may add `%USERPROFILE%\.local\bin` to the user PATH. Remove that exact
entry only if no other command uses the directory:

```powershell
$bin = Join-Path $env:USERPROFILE ".local\bin"
$entries = @([Environment]::GetEnvironmentVariable("Path", "User") -split ";" | Where-Object { $_ -and $_ -ine $bin })
[Environment]::SetEnvironmentVariable("Path", ($entries -join ";"), "User")
```

If `install.ps1` provisioned portable Node or MinGit under
`%LOCALAPPDATA%\OpenClaw\deps`, remove only the exact PATH entries and dependency
directories that no other workflow uses.

Start a new shell after PATH cleanup.

## Manual service removal (CLI missing)

Use this if the gateway service keeps running but `openclaw` is missing.

### macOS (launchd)

Default label is `ai.openclaw.gateway` (or `ai.openclaw.<profile>` with a profile):

```bash
launchctl bootout gui/$UID/ai.openclaw.gateway
rm -f ~/Library/LaunchAgents/ai.openclaw.gateway.plist
```

If you used a profile, replace the label and plist name with `ai.openclaw.<profile>`.

### Linux (systemd user unit)

Default unit name is `openclaw-gateway.service` (or `openclaw-gateway-<profile>.service`). A pre-rename `clawdbot-gateway.service` unit may still exist on machines upgraded from very old installs; `openclaw uninstall` / `openclaw gateway uninstall` detects and removes it automatically.

```bash
systemctl --user disable --now openclaw-gateway.service
rm -f ~/.config/systemd/user/openclaw-gateway.service
systemctl --user daemon-reload
```

### Windows (Scheduled Task)

Default task name is `OpenClaw Gateway` (or `OpenClaw Gateway (<profile>)`).
The task launches a windowless `gateway.vbs` script under your state dir, which in turn
runs `gateway.cmd`; remove both.

```powershell
schtasks /Delete /F /TN "OpenClaw Gateway"
Remove-Item -Force "$env:USERPROFILE\.openclaw\gateway.cmd" -ErrorAction SilentlyContinue
Remove-Item -Force "$env:USERPROFILE\.openclaw\gateway.vbs" -ErrorAction SilentlyContinue
```

If you used a profile, delete the matching task name and the `gateway.cmd` /
`gateway.vbs` files under `~\.openclaw-<profile>`.

## Verify removal

Open a new terminal and verify that no CLI remains on `PATH`:

```bash
command -v openclaw || echo "OpenClaw CLI removed"
```

On Windows:

```powershell
Get-Command openclaw -ErrorAction SilentlyContinue
```

If a command still resolves, inspect that path before deleting it. It may be a
second package-manager installation or a foreign wrapper.

## Related

- [Install overview](/install)
- [Migration guide](/install/migrating)
