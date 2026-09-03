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

Choose a particular agent with `--agent`, or collect diagnostics without starting one with `--json` or `--non-interactive`:

```bash
openclaw triage --agent codex
openclaw triage --json
openclaw triage --non-interactive
```

The prompt includes the OpenClaw version, platform, Node.js version, prioritized Doctor findings with repair hints, and the diagnostics archive path. The archive contains sanitized config, best-effort Gateway status and health snapshots, operational log summaries, and available stability diagnostics. If the Gateway is unreachable, triage still writes the archive with available local diagnostics and records snapshot failures inside it. Doctor or export failures are recorded in the prompt so the agent can still investigate.

The diagnostics archive excludes secrets, tokens, raw chat payloads, and raw logs. Failed-update prompts include bounded, sanitized diagnostic excerpts, with secrets and local paths redacted before truncation. Paths inside the prompt are shown relative to `~` or `$OPENCLAW_STATE_DIR`; the saved prompt path, archive path, and printed handoff commands retain the real absolute paths needed by your shell. Diagnostic collection is read-only. A launched agent is asked to repair autonomously within its existing permissions and preserve configuration, history, and databases.

The archive's config summary counts agent, plugin, and channel entries declared in the saved file. Shared channel settings and `$include` directives are excluded from those counts; diagnostics do not expand included files.

## Failed update recovery

Interactive update recovery uses this same handoff after the updater releases its maintenance state. It starts from the captured update failure and defers fresh Doctor checks and archive collection to the repair agent, so checks against the broken installation do not delay the handoff. The agent starts in the operator's captured working directory, or their OS home if that directory was removed or became inaccessible. Absolute installation selectors still identify the state, config, and default workspace to repair, even when the state directory cannot be accessed or created.

The prompt preserves the original error, before and after versions, and recorded recovery state ahead of current Doctor findings. It includes up to three failed or interrupted steps, excluding advisory Doctor results, with bounded excerpts from both stderr and stdout. It also retains bounded plugin failures and the terminal Doctor warning. The failure record is limited to 4 KiB and the whole prompt to 8 KiB. A healthy Doctor check does not erase the failed attempt, and an absent restart-safety verdict remains unknown.

Updates using `--yes`, JSON output, or a non-interactive session prepare diagnostics without starting a coding agent. Initial argument, ownership, and installation refusals remain outside this recovery flow. For a background or Control UI update failure, use the installation-specific command printed on the Gateway host, or run `openclaw triage` there. Standalone triage reads a pending failed-update notification without consuming it or creating a state database; delivery routes and continuation instructions are excluded.

Use `--update-result <path>` to include an updater's saved failure artifact. Triage reads at most 8 KiB of valid UTF-8 JSON and validates the failure record. Its printed embedded handoff command uses a sanitized support export, so it remains usable after a temporary updater input is deleted. Interactive handoffs with a captured failure defer fresh diagnostics; JSON and forced non-interactive runs still collect them.

The repair prompt directs the agent to preserve migrated state, investigate before rolling back or restarting, and verify the intended installation plus Gateway health and RPC connectivity after repair. A successful agent exit does not change the original updater failure into a successful update.

## Installation target and embedded handoff

Triage captures the diagnosed installation's resolved state directory, exact config path, and default workspace, including custom paths and named profiles. Local shell commands receive these as `OPENCLAW_STATE_DIR`, `OPENCLAW_CONFIG_PATH`, and `OPENCLAW_WORKSPACE_DIR`, so archive references and default workspace checks resolve against the diagnosed installation even when its selectors were implicit. An authored workspace in the installation's config still takes precedence over its default workspace. The embedded agent keeps its own config snapshot, sessions, execution cwd, and temporary run state separate; in-process config and session tools refer to that temporary run. Use local shell commands to inspect or repair the diagnosed installation.

`openclaw triage --run` explicitly requests one embedded OpenClaw agent turn. It first verifies the configured model with a live inference check. This route requires a working OpenClaw model configuration and an interactive terminal.

Embedded triage supports local OpenClaw tools, local CLI harness children, and local Codex native shells over stdio or a local Unix socket. It refuses WebSocket app-server connections, including loopback URLs that may forward to another host, because they cannot establish where native commands execute. Ordinary Codex runs without a triage installation target retain WebSocket support. Selected ACP turns, OpenClaw-provisioned sandboxes, remote/node execution, and a Codex app-server with `remoteWorkspaceRoot` are also unsupported for this local target. Use stdio, a local Unix socket, or the saved external/manual handoff on this machine. Triage does not redirect unsupported routes onto the host or relax native sandbox and approval policy.

On Windows, recognized npm `.cmd` and `.bat` shims launch their Node.js or native executable entrypoint directly, preserving the interactive terminal. Node.js entrypoints require the running Node.js runtime or `node.exe` on `PATH`. Custom wrappers that require a shell remain manual handoffs. An explicit `--agent` that is missing or manual-only exits non-zero without selecting a different agent.

## Manual handoff

Non-interactive sessions, JSON output, and installations without a directly launchable coding agent provide commands for an external diagnostic turn or the explicit embedded route. Saved external prompts are read from stdin, so quotes and multiline text do not depend on native command-line argument parsing. On macOS and Linux, the commands look like this:

```bash
env OPENCLAW_STATE_DIR='<state-dir>' OPENCLAW_CONFIG_PATH='<config-path>' OPENCLAW_WORKSPACE_DIR='<default-workspace-dir>' claude -p < '<prompt-path>'
env OPENCLAW_STATE_DIR='<state-dir>' OPENCLAW_CONFIG_PATH='<config-path>' OPENCLAW_WORKSPACE_DIR='<default-workspace-dir>' codex exec --skip-git-repo-check - < '<prompt-path>'
env OPENCLAW_STATE_DIR='<state-dir>' OPENCLAW_CONFIG_PATH='<config-path>' OPENCLAW_WORKSPACE_DIR='<default-workspace-dir>' opencode run < '<prompt-path>'
env OPENCLAW_STATE_DIR='<state-dir>' OPENCLAW_CONFIG_PATH='<config-path>' OPENCLAW_WORKSPACE_DIR='<default-workspace-dir>' pi --print < '<prompt-path>'
env OPENCLAW_STATE_DIR='<state-dir>' OPENCLAW_CONFIG_PATH='<config-path>' OPENCLAW_WORKSPACE_DIR='<default-workspace-dir>' openclaw triage --run
```

A captured update failure adds `--update-result <saved-failure-path>` to the embedded command. The external commands use their agent's normal non-interactive tool policy; triage does not bypass permission prompts. Use `openclaw triage --agent <name>` to start an interactive session.

Printed Windows commands target PowerShell, including Windows PowerShell 5.1. They read saved prompts as UTF-8, preserve literal paths, and restore your installation selectors after the command completes. WSL uses POSIX shell commands.

JSON output also includes `detectedAgents`, listing the external agents found on `PATH`. JSON output, non-TTY sessions, and `--non-interactive` never start an agent, even with `--agent`. The Codex command works outside a Git checkout; it does not change Codex sandbox or approval settings.

## Output and exit codes

The prompt is written to `logs/support/` inside the state directory with owner-only permissions, alongside the diagnostics archive and sanitized update failure when available. Prompt and archive paths are printed, and `--json` returns them plus finding counts by severity and handoff commands.

If a support artifact cannot be saved, triage reports the storage error and still passes the in-memory prompt to an available interactive agent, including an explicitly requested embedded turn. It does not report a saved prompt path for a failed write. JSON output, non-interactive sessions, and sessions without a launchable handoff retain a non-zero artifact failure; they never start an agent automatically.

A launched external agent inherits the current environment with the captured installation's state, config, and default workspace selectors pinned. The printed commands pin the same selectors and preserve shell quoting. External agents still control their own shell environment and execution policy; keep the handoff on this machine. Triage exits with the launched agent's exit code. If the agent cannot start, triage prints its manual command and exits non-zero; it does not try another provider. A failed embedded inference check, unsupported execution route, or `--run` without an interactive terminal also exits non-zero. Saved prompts and manual handoff commands remain available.

## Options

| Option                   | Effect                                                                                     |
| ------------------------ | ------------------------------------------------------------------------------------------ |
| `--json`                 | Emit prompt and archive paths, finding counts, detected agents, and commands.              |
| `--no-export`            | Skip the diagnostics archive; still prepare the prompt and use the selected handoff route. |
| `--agent <name>`         | Select `claude`, `codex`, `opencode`, or `pi` instead of automatic detection.              |
| `--run`                  | Run one embedded agent turn after checking the model in an interactive terminal.           |
| `--non-interactive`      | Prepare diagnostics without prompting or starting an agent, including on a terminal.       |
| `--update-result <path>` | Include the bounded update-failure JSON diagnostics artifact written by the updater.       |

`--run` cannot be combined with `--json`, `--non-interactive`, or `--agent`.

Related: [Doctor](/cli/doctor), [Gateway](/cli/gateway), and [Troubleshooting](/help/troubleshooting).
