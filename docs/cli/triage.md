---
summary: "CLI reference for `openclaw triage` (sanitized diagnostics and agent handoff)"
read_when:
  - OpenClaw is misbehaving and you want an agent-ready debugging prompt
  - An update failed and you want a local coding agent to repair it
  - You need a sanitized diagnostics bundle without starting an agent
title: "Triage"
---

# `openclaw triage`

Collect sanitized diagnostics and open a coding agent on this machine to diagnose, repair, and verify this OpenClaw installation.

```bash
openclaw triage
```

In an interactive terminal, triage starts the first directly launchable agent on `PATH` in this detection order: Claude Code (`claude`), Codex (`codex`), OpenCode (`opencode`), then Pi (`pi`). It prints the selected agent and passes a bounded repair prompt directly, without a picker. The agent uses its existing authentication, sandbox, and approval settings.

Choose a particular agent with `--agent`, or collect diagnostics without starting one with `--json`:

```bash
openclaw triage --agent codex
openclaw triage --json
```

The prompt includes the OpenClaw version, platform, Node.js version, prioritized Doctor findings with repair hints, and the diagnostics archive path. The archive contains sanitized config, best-effort Gateway status and health snapshots, operational log summaries, and available stability diagnostics. If the Gateway is unreachable, triage still writes the archive with available local diagnostics and records snapshot failures inside it. Doctor or export failures are recorded in the prompt so the external agent can still investigate.

The diagnostics archive excludes secrets, tokens, raw chat payloads, and raw logs. Failed-update prompts include bounded, sanitized diagnostic excerpts, with secrets and local paths redacted before truncation. Paths inside the prompt are shown relative to `~` or `$OPENCLAW_STATE_DIR`; the saved prompt path, archive path, and printed handoff commands retain the real absolute paths needed by your shell. Diagnostic collection is read-only. A launched agent is asked to repair autonomously within its existing permissions and preserve configuration, history, and databases.

The archive's config summary counts agent, plugin, and channel entries declared in the saved file. Shared channel settings and `$include` directives are excluded from those counts; diagnostics do not expand included files.

## Failed update recovery

Interactive update recovery uses this same handoff after the updater releases its maintenance state. It starts from the captured update outcome and defers fresh Doctor checks and archive collection to the repair agent, so checks against the broken installation do not delay the handoff. The prompt includes before and after versions, restart-safety verdict when recorded, and the last three steps with nonzero exit codes. Each step includes a sanitized diagnostic excerpt of at most 384 bytes, preferring stderr over stdout. The whole prompt is limited to 8 KiB. The agent starts in the operator's captured working directory, or their OS home if that directory was removed or became inaccessible. Absolute installation selectors still identify the state, config, and default workspace to repair, even when the state directory cannot be accessed or created.

For a background or Control UI update failure, run `openclaw triage` in a terminal on the Gateway host. Standalone triage reads a pending failed-update notification without consuming it or creating a state database. It includes only update observations, excluding delivery routes and continuation instructions. An absent restart-safety verdict remains unknown; it is never inferred from a version number or failure message.

The repair prompt directs the agent to preserve migrated state, investigate before rolling back or restarting, and verify the intended installation plus Gateway health and RPC connectivity after repair. A successful agent exit does not change the original updater failure into a successful update.

## Installation target and embedded handoff

Triage captures the diagnosed installation's resolved state directory, exact config path, and default workspace, including custom paths and named profiles. Local shell commands receive these as `OPENCLAW_STATE_DIR`, `OPENCLAW_CONFIG_PATH`, and `OPENCLAW_WORKSPACE_DIR`, so archive references and default workspace checks resolve against the diagnosed installation even when its selectors were implicit. An authored workspace in the installation's config still takes precedence over its default workspace. The embedded agent keeps its own config snapshot, sessions, execution cwd, and temporary run state separate; in-process config and session tools refer to that temporary run. Use local shell commands to inspect or repair the diagnosed installation.

`openclaw triage --run` explicitly requests one embedded OpenClaw agent turn. It first verifies the configured model with a live inference check. This route requires a working OpenClaw model configuration and an interactive terminal.

Embedded triage supports local OpenClaw tools, local CLI harness children, and local Codex native shells over stdio or a local Unix socket. It refuses WebSocket app-server connections, including loopback URLs that may forward to another host, because they cannot establish where native commands execute. Ordinary Codex runs without a triage installation target retain WebSocket support. Selected ACP turns, OpenClaw-provisioned sandboxes, remote/node execution, and a Codex app-server with `remoteWorkspaceRoot` are also unsupported for this local target. Use stdio, a local Unix socket, or the saved external/manual handoff on this machine. Triage does not redirect unsupported routes onto the host or relax native sandbox and approval policy.

On Windows, recognized npm `.cmd` and `.bat` shims launch their Node.js or native executable entrypoint directly, preserving the interactive terminal. Node.js entrypoints require the running Node.js runtime or `node.exe` on `PATH`. Custom wrappers that require a shell remain manual handoffs. An explicit `--agent` that is missing or manual-only exits non-zero without selecting a different agent.

## Manual handoff

Non-interactive sessions, JSON output, and installations without a directly launchable coding agent provide these POSIX shell commands:

On Windows, text output labels these commands as POSIX/Git Bash syntax. JSON handoff commands use the same POSIX syntax. PowerShell and Command Prompt command generation is not supported.

```bash
env OPENCLAW_STATE_DIR='<state-dir>' OPENCLAW_CONFIG_PATH='<config-path>' OPENCLAW_WORKSPACE_DIR='<default-workspace-dir>' claude "$(cat '<prompt-path>')"
env OPENCLAW_STATE_DIR='<state-dir>' OPENCLAW_CONFIG_PATH='<config-path>' OPENCLAW_WORKSPACE_DIR='<default-workspace-dir>' codex exec --skip-git-repo-check - < '<prompt-path>'
env OPENCLAW_STATE_DIR='<state-dir>' OPENCLAW_CONFIG_PATH='<config-path>' OPENCLAW_WORKSPACE_DIR='<default-workspace-dir>' opencode --prompt "$(cat '<prompt-path>')"
env OPENCLAW_STATE_DIR='<state-dir>' OPENCLAW_CONFIG_PATH='<config-path>' OPENCLAW_WORKSPACE_DIR='<default-workspace-dir>' pi "$(cat '<prompt-path>')"
env OPENCLAW_STATE_DIR='<state-dir>' OPENCLAW_CONFIG_PATH='<config-path>' OPENCLAW_WORKSPACE_DIR='<default-workspace-dir>' openclaw triage --run
```

JSON output also includes `detectedAgents`, listing the external agents found on `PATH`. JSON output and non-interactive sessions never start an agent.

The Codex command works outside a Git checkout; it does not change Codex sandbox or approval settings.

## Output and exit codes

The prompt is written to `logs/support/` inside the state directory with owner-only permissions, alongside the diagnostics archive when one was produced. Both paths are printed, and `--json` returns them plus finding counts by severity.

If the prompt file cannot be saved, triage reports the storage error and still passes the in-memory prompt to an available interactive agent, including an explicitly requested embedded turn. It does not report a saved path for a failed write. JSON output, non-interactive sessions, and sessions without a launchable handoff retain a non-zero artifact failure; they never start an agent automatically.

A launched external agent inherits the current environment with the captured installation's state, config, and default workspace selectors pinned. The printed commands pin the same selectors and preserve shell quoting. External agents still control their own shell environment and execution policy; keep the handoff on this machine. Triage exits with the launched agent's exit code. If the agent cannot start, triage prints its manual command and exits non-zero; it does not try another provider. A failed embedded inference check, unsupported execution route, or `--run` without an interactive terminal also exits non-zero. The saved prompt and manual handoff commands remain available.

## Options

| Option           | Effect                                                                                     |
| ---------------- | ------------------------------------------------------------------------------------------ |
| `--json`         | Emit prompt and archive paths, finding counts, detected agents, and commands.              |
| `--no-export`    | Skip the diagnostics archive; still prepare the prompt and use the selected handoff route. |
| `--agent <name>` | Select `claude`, `codex`, `opencode`, or `pi` instead of automatic detection.              |
| `--run`          | Run one embedded agent turn after checking the model in an interactive terminal.           |

`--run` cannot be combined with `--json` or `--agent`. JSON output and non-interactive output never launch an external agent, even with `--agent`.

Related: [Doctor](/cli/doctor), [Gateway](/cli/gateway), and [Troubleshooting](/help/troubleshooting).
