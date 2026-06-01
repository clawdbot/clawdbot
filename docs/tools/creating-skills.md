---
title: "Creating skills"
sidebarTitle: "Creating skills"
summary: "Build, test, and publish custom SKILL.md workspace skills for your OpenClaw agents."
read_when:
  - You are creating a new custom skill
  - You need a quick starter workflow for SKILL.md-based skills
  - You want to use Skill Workshop to propose a skill for agent review
---

Skills teach the agent how and when to use tools. Each skill is a directory
containing a `SKILL.md` file with YAML frontmatter and markdown instructions.
OpenClaw loads skills from several roots in a defined [precedence order](/tools/skills#loading-order).

## Create your first skill

<Steps>
  <Step title="Create the skill directory">
    Skills live in your workspace `skills/` folder. Create a directory for your
    new skill:

    ```bash
    mkdir -p ~/.openclaw/workspace/skills/hello-world
    ```

    You can group skills in subfolders for organization — the skill is still
    named by the `SKILL.md` frontmatter, not the folder path:

    ```bash
    mkdir -p ~/.openclaw/workspace/skills/personal/hello-world
    # skill name is still "hello-world", invoked as /hello-world
    ```

  </Step>

  <Step title="Write SKILL.md">
    Create `SKILL.md` inside the directory. The frontmatter defines metadata;
    the body gives the agent instructions.

    ```markdown
    ---
    name: hello-world
    description: A simple skill that prints a greeting.
    ---

    # Hello World

    When the user asks for a greeting, use the `exec` tool to run:

    ```bash
    echo "Hello from your custom skill!"
    ```
    ```

    Naming rules:
    - Use lowercase letters, digits, and hyphens for `name`.
    - Keep the directory name and frontmatter `name` aligned.
    - `description` is shown to the agent and in slash-command discovery —
      keep it one line and under 160 characters.

  </Step>

  <Step title="Verify the skill loaded">
    ```bash
    openclaw skills list
    ```

    OpenClaw watches `SKILL.md` files under skills roots by default. If the
    watcher is disabled or you are continuing an existing session, start a new
    one so the agent receives the refreshed list:

    ```bash
    # From chat — archive current session and start fresh
    /new

    # Or restart the gateway
    openclaw gateway restart
    ```

  </Step>

  <Step title="Test it">
    Send a message that should trigger the skill:

    ```bash
    openclaw agent --message "give me a greeting"
    ```

    Or open a chat and ask the agent directly. Use `/skill hello-world` to
    invoke it explicitly by name.

  </Step>
</Steps>

## SKILL.md reference

### Required fields

| Field         | Description                                                     |
| ------------- | --------------------------------------------------------------- |
| `name`        | Unique slug using lowercase letters, digits, and hyphens        |
| `description` | One-line description shown to the agent and in discovery output |

### Optional frontmatter keys

| Field                      | Default | Description                                                                      |
| -------------------------- | ------- | -------------------------------------------------------------------------------- |
| `user-invocable`           | `true`  | Expose the skill as a user slash command                                         |
| `disable-model-invocation` | `false` | Keep the skill out of the agent's system prompt (still runs via `/skill`)        |
| `command-dispatch`         | —       | Set to `tool` to route the slash command directly to a tool, bypassing the model |
| `command-tool`             | —       | Tool name to invoke when `command-dispatch: tool` is set                         |
| `command-arg-mode`         | `raw`   | For tool dispatch, forwards the raw args string to the tool                      |
| `homepage`                 | —       | URL shown as "Website" in the macOS Skills UI                                    |

For gating fields (`requires.bins`, `requires.env`, etc.) see
[Skills — Gating](/tools/skills#gating).

### Using `{baseDir}`

Use `{baseDir}` in the skill body to reference files inside the skill
directory without hardcoding paths:

```markdown
Run the helper script at `{baseDir}/scripts/run.sh`.
```

## Adding conditional activation

Gate your skill so it only loads when its dependencies are available:

```markdown
---
name: gemini-search
description: Search using Gemini CLI.
metadata: { "openclaw": { "requires": { "bins": ["gemini"] }, "primaryEnv": "GEMINI_API_KEY" } }
---
```

<AccordionGroup>
  <Accordion title="Gating options">
    | Key | Description |
    | --- | --- |
    | `requires.bins` | All binaries must exist on `PATH` |
    | `requires.anyBins` | At least one binary must exist on `PATH` |
    | `requires.env` | Each env var must exist in the process or config |
    | `requires.config` | Each `openclaw.json` path must be truthy |
    | `os` | Platform filter: `["darwin"]`, `["linux"]`, `["win32"]` |
    | `always` | Set `true` to skip all gates and always include the skill |

    Full reference: [Skills — Gating](/tools/skills#gating).

  </Accordion>
  <Accordion title="Environment and API keys">
    Wire an API key to a skill entry in `openclaw.json`:

    ```json5
    {
      skills: {
        entries: {
          "gemini-search": {
            enabled: true,
            apiKey: { source: "env", provider: "default", id: "GEMINI_API_KEY" },
          },
        },
      },
    }
    ```

    The key is injected into the host process for that agent turn only.
    It does not reach the sandbox — see
    [sandboxed env vars](/tools/skills-config#sandboxed-skills-and-env-vars).

  </Accordion>
</AccordionGroup>

## Propose via Skill Workshop

For agent-drafted skills or when you want operator review before a skill goes
live, use [Skill Workshop](/tools/skill-workshop) proposals instead of writing
`SKILL.md` directly.

```bash
# Propose a brand-new skill
openclaw skills workshop propose-create \
  --name "hello-world" \
  --description "A simple skill that prints a greeting." \
  --proposal ./PROPOSAL.md

# Propose an update to an existing skill
openclaw skills workshop propose-update hello-world \
  --proposal ./PROPOSAL.md \
  --description "Updated greeting skill"
```

Use `--proposal-dir` when the proposal includes support files:

```bash
openclaw skills workshop propose-create \
  --name "hello-world" \
  --description "A simple skill that prints a greeting." \
  --proposal-dir ./hello-world-proposal/
```

The directory must contain `PROPOSAL.md`. Support files can go in `assets/`,
`examples/`, `references/`, `scripts/`, or `templates/`.

After review:

```bash
openclaw skills workshop inspect <proposal-id>
openclaw skills workshop apply <proposal-id>
```

See [Skill Workshop](/tools/skill-workshop) for the full proposal lifecycle.

## Publishing to ClawHub

<Steps>
  <Step title="Ensure your SKILL.md is complete">
    Make sure `name`, `description`, and any `metadata.openclaw` gating fields
    are set. Add a `homepage` URL if you have a project page.
  </Step>
  <Step title="Install the ClawHub skill">
    The ClawHub skill documents the current publish command shape and required
    metadata:

    ```bash
    openclaw skills install clawhub-publish
    ```

  </Step>
  <Step title="Publish">
    ```bash
    clawhub publish
    ```

    See [ClawHub — Publishing](/clawhub/publishing) for the full flow.

  </Step>
</Steps>

## Best practices

<Tip>
  - **Be concise** — instruct the model on *what* to do, not how to be an AI.
  - **Safety first** — if your skill uses `exec`, ensure prompts do not allow
    arbitrary command injection from untrusted input.
  - **Test locally** — use `openclaw agent --message "..."` before sharing.
  - **Use ClawHub** — browse community skills at [clawhub.ai](https://clawhub.ai)
    before building from scratch.
</Tip>

## Related

<CardGroup cols={2}>
  <Card title="Skills reference" href="/tools/skills" icon="puzzle-piece">
    Loading order, gating, allowlists, and SKILL.md format.
  </Card>
  <Card title="Skill Workshop" href="/tools/skill-workshop" icon="flask">
    Proposal queue for agent-drafted skills.
  </Card>
  <Card title="Skills config" href="/tools/skills-config" icon="gear">
    Full `skills.*` config schema.
  </Card>
  <Card title="ClawHub" href="/clawhub" icon="cloud">
    Browse and publish skills on the public registry.
  </Card>
  <Card title="Building plugins" href="/plugins/building-plugins" icon="plug">
    Plugins can ship skills alongside the tools they document.
  </Card>
</CardGroup>
