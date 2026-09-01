---
summary: "CLI reference for `openclaw triage` (sanitized diagnostics and agent handoff)"
read_when:
  - OpenClaw is misbehaving and you want an agent-ready debugging prompt
  - You need a sanitized diagnostics bundle without applying repairs
title: "Triage"
---

# `openclaw triage`

Run read-only Doctor checks, collect the existing sanitized diagnostics archive, and write a bounded Markdown prompt for an agent debugging this OpenClaw installation.

```bash
openclaw triage
```

The prompt includes the OpenClaw version, platform, Node.js version, prioritized Doctor findings with repair hints, and the diagnostics archive path. The archive contains sanitized config, best-effort Gateway status and health snapshots, operational log summaries, and available stability diagnostics. If the Gateway is unreachable, triage still writes the archive with available local diagnostics and records snapshot failures inside it. If the export itself fails, triage still writes the prompt and explains why the archive is unavailable.

Secrets, tokens, raw chat payloads, and raw logs are excluded. Paths inside the prompt are shown relative to `~` or `$OPENCLAW_STATE_DIR`; the saved prompt path, archive path, and printed handoff commands retain the real absolute paths needed by your shell. Doctor checks remain advisory and do not apply repairs.

The archive's config summary counts agent, plugin, and channel entries declared in the saved file. Shared channel settings and `$include` directives are excluded from those counts; diagnostics do not expand included files.

## Agent handoff

In an interactive terminal, triage detects the agent handoff routes available on the current machine and asks which one to use. A configured OpenClaw embedded agent appears first, followed by Claude Code when `claude` is on `PATH`, Codex CLI when `codex` is on `PATH`, and an option to just print the commands.

Choosing Claude Code or Codex starts its interactive session directly with the generated prompt. Choosing the embedded agent first verifies the configured model with a live inference check, then runs one OpenClaw agent turn. `--run` requests that same verified embedded route explicitly.

Triage captures the diagnosed installation's resolved state directory, exact config path, and default workspace, including custom paths and named profiles. Local shell commands receive these as `OPENCLAW_STATE_DIR`, `OPENCLAW_CONFIG_PATH`, and `OPENCLAW_WORKSPACE_DIR`, so archive references and default workspace checks resolve against the diagnosed installation even when its selectors were implicit. An authored workspace in the installation's config still takes precedence over its default workspace. The embedded agent keeps its own config snapshot, sessions, execution cwd, and temporary run state separate; in-process config and session tools refer to that temporary run. Use local shell commands to inspect or repair the diagnosed installation.

Embedded triage supports local OpenClaw tools, local CLI harness children, and local Codex native shells over stdio or a local Unix socket. It refuses WebSocket app-server connections, including loopback URLs that may forward to another host, because they cannot establish where native commands execute. Ordinary Codex runs without a triage installation target retain WebSocket support. Selected ACP turns, OpenClaw-provisioned sandboxes, remote/node execution, and a Codex app-server with `remoteWorkspaceRoot` are also unsupported for this local target. Use stdio, a local Unix socket, or the saved external/manual handoff on this machine. Triage does not redirect unsupported routes onto the host or relax native sandbox and approval policy.

On Windows, agents installed only as `.cmd` or `.bat` command shims appear in the manual handoff commands instead of the direct-launch picker.

Non-interactive sessions and the print-only choice provide these POSIX shell handoff commands instead:

```bash
env OPENCLAW_STATE_DIR='<state-dir>' OPENCLAW_CONFIG_PATH='<config-path>' OPENCLAW_WORKSPACE_DIR='<default-workspace-dir>' claude "$(cat '<prompt-path>')"
env OPENCLAW_STATE_DIR='<state-dir>' OPENCLAW_CONFIG_PATH='<config-path>' OPENCLAW_WORKSPACE_DIR='<default-workspace-dir>' codex exec --skip-git-repo-check - < '<prompt-path>'
env OPENCLAW_STATE_DIR='<state-dir>' OPENCLAW_CONFIG_PATH='<config-path>' OPENCLAW_WORKSPACE_DIR='<default-workspace-dir>' openclaw triage --run
```

JSON output also includes `detectedAgents`, listing the external agents found on `PATH`. JSON output and non-interactive sessions never start an agent.

The Codex command works outside a Git checkout; it does not change Codex sandbox or approval settings.

## Output and exit codes

The prompt is written to `logs/support/` inside the state directory with owner-only permissions, alongside the diagnostics archive when one was produced. Both paths are printed, and `--json` returns them plus finding counts by severity.

A launched external agent inherits the current environment with the captured installation's state, config, and default workspace selectors pinned. The printed commands pin the same selectors and preserve shell quoting. External agents still control their own shell environment and execution policy; keep the handoff on this machine. Triage exits with the launched agent's exit code. If the agent cannot be started, triage prints its manual command and exits non-zero. A failed embedded inference check or unsupported execution route exits non-zero whether selected from the picker or requested with `--run`; the saved prompt and manual handoff commands remain available. `--run` without an interactive terminal also exits non-zero.

## Options

| Option        | Effect                                                                           |
| ------------- | -------------------------------------------------------------------------------- |
| `--json`      | Emit prompt and archive paths, finding counts, detected agents, and commands.    |
| `--no-export` | Skip the diagnostics archive and only generate the debugging prompt.             |
| `--run`       | Run one embedded agent turn after checking the model in an interactive terminal. |

`--json` cannot be combined with `--run`.

Related: [Doctor](/cli/doctor), [Gateway](/cli/gateway), and [Troubleshooting](/help/troubleshooting).
