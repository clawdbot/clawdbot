---
summary: "OpenProse: .prose workflows, slash commands, and state in Moltbot"
read_when:
  - You want to run or write .prose workflows
  - You want to enable the OpenProse plugin
  - You need to understand state storage
---
# OpenProse

OpenProse is a portable, markdown-first workflow format for orchestrating AI sessions. In Moltbot it ships as a plugin that installs an OpenProse skill pack plus a `/prose` slash command. Programs live in `.prose` files and can spawn multiple sub-agents with explicit control flow.

Official site: https://www.prose.md

## What it can do

- Multi-agent research + synthesis with explicit parallelism.
- Repeatable approval-safe workflows (code review, incident triage, content pipelines).
- Reusable `.prose` programs you can run across supported agent runtimes.

## Install + enable

Bundled plugins are disabled by default. Enable OpenProse:

```bash
moltbot plugins enable open-prose
```

Restart the Gateway after enabling the plugin.

Dev/local checkout: `moltbot plugins install ./extensions/open-prose`

Related docs: [Plugins](/plugin), [Plugin manifest](/plugins/manifest), [Skills](/tools/skills).

## Slash command

OpenProse registers `/prose` as a user-invocable skill command. It routes to the OpenProse VM instructions and uses Moltbot tools under the hood.

Common commands:

```
/prose help
/prose run <file.prose>
/prose run <handle/slug>
/prose run <https://example.com/file.prose>
/prose compile <file.prose>
/prose examples
/prose update
```

## Example: a simple `.prose` file

```prose
# Research + synthesis with two agents running in parallel.

input topic: "What should we research?"

agent researcher:
  model: sonnet
  prompt: "You research thoroughly and cite sources."

agent writer:
  model: opus
  prompt: "You write a concise summary."

parallel:
  findings = session: researcher
    prompt: "Research {topic}."
  draft = session: writer
    prompt: "Summarize {topic}."

session "Merge the findings + draft into a final answer."
context: { findings, draft }
```

## File locations

OpenProse keeps state under `.prose/` in your workspace:

```
.prose/
├── .env
├── runs/
│   └── {YYYYMMDD}-{HHMMSS}-{random}/
│       ├── program.prose
│       ├── state.md
│       ├── bindings/
│       └── agents/
└── agents/
```

User-level persistent agents live at:

```
~/.prose/agents/
```

## State modes

OpenProse supports multiple state backends:

- **filesystem** (default): `.prose/runs/...`
- **in-context**: transient, for small programs
- **sqlite** (experimental): requires `sqlite3` binary
- **postgres** (experimental): requires `psql` and a connection string

Notes:
- sqlite/postgres are opt-in and experimental.
- postgres credentials flow into subagent logs; use a dedicated, least-privileged DB.

## Remote programs

`/prose run <handle/slug>` resolves to `https://p.prose.md/<handle>/<slug>`.
Direct URLs are fetched as-is. This uses the `web_fetch` tool (or `exec` for POST).

## Moltbot runtime mapping

OpenProse programs map to Moltbot primitives:

| OpenProse concept | Moltbot tool |
| --- | --- |
| Spawn session / Task tool | `sessions_spawn` |
| File read/write | `read` / `write` |
| Web fetch | `web_fetch` |

If your tool allowlist blocks these tools, OpenProse programs will fail. See [Skills config](/tools/skills-config).

## Security + approvals

Treat `.prose` files like code. Review before running. Use Moltbot tool allowlists and approval gates to control side effects.

For deterministic, approval-gated workflows, compare with [Lobster](/tools/lobster).
