---
title: "OpenProse"
sidebarTitle: "OpenProse"
summary: "OpenProse is a markdown-first workflow format for multi-agent AI sessions. In OpenClaw it ships as a plugin with a /prose slash command and a skill pack."
read_when:
  - You want to run or write .prose workflow files
  - You want to enable the OpenProse plugin
  - You need to understand how OpenProse maps to OpenClaw primitives
---

OpenProse is a portable, markdown-first workflow format for orchestrating AI
sessions. In OpenClaw it ships as a plugin that installs an OpenProse skill
pack and a `/prose` slash command. Programs live in `.prose` files and can
spawn multiple sub-agents with explicit control flow.

<CardGroup cols={3}>
  <Card title="Install" icon="download" href="#install">
    Enable the OpenProse plugin and restart the Gateway.
  </Card>
  <Card title="Run a program" icon="play" href="#slash-command">
    Use `/prose run` to execute a `.prose` file or remote program.
  </Card>
  <Card title="Write programs" icon="pencil" href="#example-parallel-research-and-synthesis">
    Author multi-agent workflows with parallel and sequential steps.
  </Card>
</CardGroup>

## Install

<Steps>
  <Step title="Enable the plugin">
    OpenProse is bundled but disabled by default. Enable it:

    ```bash
    openclaw plugins enable open-prose
    ```

  </Step>
  <Step title="Restart the Gateway">
    ```bash
    openclaw gateway restart
    ```
  </Step>
  <Step title="Verify">
    ```bash
    openclaw plugins list | grep prose
    ```

    You should see `open-prose` as enabled. The `/prose` skill command is now
    available in chat.

  </Step>
</Steps>

From a repo checkout you can install the plugin directly:
`openclaw plugins install ./extensions/open-prose`

## Slash command

OpenProse registers `/prose` as a user-invocable skill command:

```text
/prose help
/prose run <file.prose>
/prose run <handle/slug>
/prose run <https://example.com/file.prose>
/prose compile <file.prose>
/prose examples
/prose update
```

`/prose run <handle/slug>` resolves to `https://p.prose.md/<handle>/<slug>`.
Direct URLs are fetched as-is using the `web_fetch` tool.

Top-level remote runs are explicit. Remote imports inside a `.prose` program are
transitive code dependencies: before OpenProse fetches any remote `use` target,
it shows the resolved import list and requires the operator to reply exactly
`approve remote prose imports` for that run.

## What it can do

- Multi-agent research and synthesis with explicit parallelism.
- Repeatable, approval-safe workflows (code review, incident triage, content pipelines).
- Reusable `.prose` programs you can run across supported agent runtimes.

## Example: parallel research and synthesis

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

## OpenClaw runtime mapping

OpenProse programs map to OpenClaw primitives:

| OpenProse concept         | OpenClaw tool                                   |
| ------------------------- | ----------------------------------------------- |
| Spawn session / Task tool | `sessions_spawn`                                |
| File read / write         | `read` / `write`                                |
| Web fetch                 | `web_fetch` (`exec` + curl when POST is needed) |

<Warning>
  If your tool allowlist blocks `sessions_spawn`, `read`, `write`, or
  `web_fetch`, OpenProse programs will fail. Check your
  [tools allowlist config](/gateway/config-tools).
</Warning>

## File locations

OpenProse keeps state under `.prose/` in your workspace:

```text
.prose/
├── .env                      # config (key=value), e.g. OPENPROSE_POSTGRES_URL
├── runs/
│   └── {YYYYMMDD}-{HHMMSS}-{random}/
│       ├── program.prose     # copy of the running program
│       ├── state.md          # execution state
│       ├── bindings/
│       ├── imports/          # nested remote program runs
│       └── agents/
└── agents/                   # project-scoped persistent agents
```

User-level persistent agents (shared across projects) live at:

```text
~/.prose/agents/
```

## State backends

<AccordionGroup>
  <Accordion title="filesystem (default)">
    State is written to `.prose/runs/...` in the workspace. No extra
    dependencies required.
  </Accordion>
  <Accordion title="in-context">
    Transient state kept in the context window; select with `--in-context`.
    Suitable for small, short-lived programs.
  </Accordion>
  <Accordion title="sqlite (experimental)">
    Select with `--state=sqlite`. Requires the `sqlite3` binary on `PATH`
    (falls back to filesystem when missing); state lands in
    `.prose/runs/{id}/state.db`.
  </Accordion>
  <Accordion title="postgres (experimental)">
    Select with `--state=postgres`. Requires `psql` and a connection string in
    `OPENPROSE_POSTGRES_URL` (set it in `.prose/.env`).

    <Warning>
      Postgres credentials flow into sub-agent logs. Use a dedicated,
      least-privileged database.
    </Warning>

  </Accordion>
</AccordionGroup>

## Security

Treat `.prose` files like code. Review them before running, including remote
`use` imports. Top-level `/prose run https://...` requests are explicit, but
transitive remote imports require per-run approval before they are fetched or
executed. Use OpenClaw tool allowlists and approval gates to control side
effects. For deterministic, approval-gated workflows, compare with
[Lobster](/tools/lobster).

## Related

<CardGroup cols={2}>
  <Card title="Skills reference" href="/tools/skills" icon="puzzle-piece">
    How OpenProse's skill pack loads and what gates apply.
  </Card>
  <Card title="Subagents" href="/tools/subagents" icon="users">
    OpenClaw's native multi-agent coordination layer.
  </Card>
  <Card title="Text-to-speech" href="/tools/tts" icon="volume-high">
    Add audio output to your workflows.
  </Card>
  <Card title="Slash commands" href="/tools/slash-commands" icon="terminal">
    All available chat commands including /prose.
  </Card>
</CardGroup>

Official site: [https://www.prose.md](https://www.prose.md)
