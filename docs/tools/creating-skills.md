---
summary: "Build and test custom workspace skills with SKILL.md"
title: "Creating skills"
read_when:
  - You are creating a new custom skill in your workspace
  - You need a quick starter workflow for SKILL.md-based skills
---

Skills teach the agent how and when to use tools. Each skill is a directory
containing a `SKILL.md` file with YAML frontmatter and markdown instructions.

For how skills are loaded and prioritized, see [Skills](/tools/skills).

## Create your first skill

<Steps>
  <Step title="Create the skill directory">
    Skills live in your workspace. Create a new folder:

    ```bash
    mkdir -p ~/.openclaw/workspace/skills/hello-world
    ```

  </Step>

  <Step title="Write SKILL.md">
    Create `SKILL.md` inside that directory. The frontmatter defines metadata,
    and the markdown body contains instructions for the agent.

    ```markdown
    ---
    name: hello-world
    description: A simple skill that says hello.
    ---

    # Hello World Skill

    When the user asks for a greeting, use the `echo` tool to say
    "Hello from your custom skill!".
    ```

    Use hyphen-case with lowercase letters, digits, and hyphens for the skill
    `name`. Keep the folder name and frontmatter `name` aligned.

  </Step>

  <Step title="Add tools (optional)">
    You can define custom tool schemas in the frontmatter or instruct the agent
    to use existing system tools (like `exec` or `browser`). Skills can also
    ship inside plugins alongside the tools they document.

  </Step>

  <Step title="Load the skill">
    Start a new session so OpenClaw picks up the skill:

    ```bash
    # From chat
    /new

    # Or restart the gateway
    openclaw gateway restart
    ```

    Verify the skill loaded:

    ```bash
    openclaw skills list
    ```

  </Step>

  <Step title="Test it">
    Send a message that should trigger the skill:

    ```bash
    openclaw agent --message "give me a greeting"
    ```

    Or just chat with the agent and ask for a greeting.

  </Step>
</Steps>

## Skill metadata reference

The YAML frontmatter supports these fields:

| Field                               | Required | Description                                                    |
| ----------------------------------- | -------- | -------------------------------------------------------------- |
| `name`                              | Yes      | Unique identifier using lowercase letters, digits, and hyphens |
| `description`                       | Yes      | One-line description shown to the agent                        |
| `metadata.openclaw.os`              | No       | OS filter (`["darwin"]`, `["linux"]`, etc.)                    |
| `metadata.openclaw.requires.bins`   | No       | Required binaries on PATH                                      |
| `metadata.openclaw.requires.config` | No       | Required config keys                                           |

## Advanced features

Once a basic skill works, these fields help make it reliable and portable:

- **Conditional activation** — use `requires.bins`, `requires.env`, or
  `requires.config` to load the skill only when required dependencies are
  available. See [Skills reference: gating](/tools/skills#gating).
- **Environment and API-key wiring** — use `skills.entries.<name>.env` and
  `skills.entries.<name>.apiKey` to inject host-side environment for a skill
  turn. See [Skills reference: config wiring](/tools/skills#config-wiring).
- **Invocation control** — set `user-invocable: false` to hide a slash command,
  or `disable-model-invocation: true` to keep a command-style skill out of the
  model prompt. See [Skills reference: frontmatter](/tools/skills#frontmatter).
- **Direct command dispatch** — use `command-dispatch: tool` with
  `command-tool` when a slash command should call a tool directly instead of
  routing through the model.
- **Portable paths** — use `{baseDir}` in `SKILL.md` when referencing scripts
  or assets inside the skill directory.
- **Publishing** — use the ClawHub skill when preparing a skill for publication.
  It documents the current `clawhub publish` command shape and required
  metadata.

## Best practices

- **Be concise** — instruct the model on _what_ to do, not how to be an AI
- **Safety first** — if your skill uses `exec`, ensure prompts don't allow arbitrary command injection from untrusted input
- **Test locally** — use `openclaw agent --message "..."` to test before sharing
- **Use ClawHub** — browse and contribute skills at [ClawHub](https://clawhub.ai)

## Where skills live

| Location                        | Precedence | Scope                 |
| ------------------------------- | ---------- | --------------------- |
| `\<workspace\>/skills/`         | Highest    | Per-agent             |
| `\<workspace\>/.agents/skills/` | High       | Per-workspace agent   |
| `~/.agents/skills/`             | Medium     | Shared agent profile  |
| `~/.openclaw/skills/`           | Medium     | Shared (all agents)   |
| Bundled (shipped with OpenClaw) | Low        | Global                |
| `skills.load.extraDirs`         | Lowest     | Custom shared folders |

## Related

- [Skills reference](/tools/skills) — loading, precedence, and gating rules
- [Skills config](/tools/skills-config) — `skills.*` config schema
- [ClawHub](/clawhub) — public skill registry
- [Building Plugins](/plugins/building-plugins) — plugins can ship skills
