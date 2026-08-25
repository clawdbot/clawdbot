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

The prompt includes the OpenClaw version, platform, Node.js version, prioritized Doctor findings with repair hints, and the diagnostics archive path. The archive contains sanitized config, Gateway status and health snapshots, operational log summaries, and available stability diagnostics. If the Gateway is unreachable, triage still writes the prompt and explains why the archive is unavailable.

Secrets, tokens, raw chat payloads, and raw logs are excluded. Doctor checks remain advisory and do not apply repairs.

## Agent handoff

In an interactive terminal, triage detects the agent handoff routes available on the current machine and asks which one to use. A configured OpenClaw embedded agent appears first, followed by Claude Code when `claude` is on `PATH`, Codex CLI when `codex` is on `PATH`, and an option to just print the commands.

Choosing Claude Code or Codex starts its interactive session directly with the generated prompt. Choosing the embedded agent first verifies the configured model with a live inference check, then runs one OpenClaw agent turn. `--run` requests that same verified embedded route explicitly.

Non-interactive sessions and the print-only choice provide these manual handoff commands instead:

```bash
claude "$(cat '<prompt-path>')"
codex exec - < '<prompt-path>'
openclaw triage --run
```

JSON output also includes `detectedAgents`, listing the external agents found on `PATH`. JSON output and non-interactive sessions never start an agent.

## Options

| Option        | Effect                                                                           |
| ------------- | -------------------------------------------------------------------------------- |
| `--json`      | Emit prompt and archive paths, finding counts, detected agents, and commands.    |
| `--no-export` | Skip the diagnostics archive and only generate the debugging prompt.             |
| `--run`       | Run one embedded agent turn after checking the model in an interactive terminal. |

`--json` cannot be combined with `--run`.

Related: [Doctor](/cli/doctor), [Gateway](/cli/gateway), and [Troubleshooting](/help/troubleshooting).
