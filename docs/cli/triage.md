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

Triage prints ready-to-run commands for three routes:

```bash
claude "$(cat '<prompt-path>')"
codex exec - < '<prompt-path>'
openclaw triage --run
```

In an interactive terminal, OpenClaw offers to run one embedded agent turn only after the configured model passes a live inference check. `--run` requests the same verified embedded route explicitly. JSON output and non-interactive sessions never start an agent.

## Options

| Option        | Effect                                                                           |
| ------------- | -------------------------------------------------------------------------------- |
| `--json`      | Emit prompt and archive paths, finding counts, and suggested commands.           |
| `--no-export` | Skip the diagnostics archive and only generate the debugging prompt.             |
| `--run`       | Run one embedded agent turn after checking the model in an interactive terminal. |

`--json` cannot be combined with `--run`.

Related: [Doctor](/cli/doctor), [Gateway](/cli/gateway), and [Troubleshooting](/help/troubleshooting).
