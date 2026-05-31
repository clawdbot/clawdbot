---
summary: "Build and test custom workspace skills with SKILL.md"
title: "Creating skills"
read_when:
  - You are creating a new custom skill in your workspace
  - You need a quick starter workflow for SKILL.md-based skills
---

Skills teach the agent how and when to use tools. Each skill is a directory
containing a `SKILL.md` file with YAML frontmatter and markdown instructions.

For how skills are loaded and prioritized, see [Skills](/tools/skills). For
agent-generated or reviewed skill changes, see
[Skill Workshop](/tools/skill-workshop).

## Create your first skill

<Steps>
  <Step title="Create the skill directory">
    Skills live in your workspace. Create a new folder:

    ```bash
    mkdir -p ~/.openclaw/workspace/skills/hello-world
    ```

    You can group skills in subfolders when your library grows:

    ```bash
    mkdir -p ~/.openclaw/workspace/skills/personal/hello-world
    ```

    Group folders are only organizational. The skill is still named by
    `SKILL.md` frontmatter, so `name: hello-world` is invoked as
    `/hello-world`.

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
    `name`. Keep the leaf folder name and frontmatter `name` aligned.

  </Step>

  <Step title="Add tools (optional)">
    You can define custom tool schemas in the frontmatter or instruct the agent
    to use existing system tools (like `exec` or `browser`). Skills can also
    ship inside plugins alongside the tools they document.

  </Step>

  <Step title="Load the skill">
    Verify the skill loaded:

    ```bash
    openclaw skills list
    ```

    OpenClaw watches nested `SKILL.md` files under skills roots. If the watcher
    is disabled or you are continuing an existing session, start a new session
    so the model receives the refreshed skills list:

    ```bash
    # From chat
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

    Or just chat with the agent and ask for a greeting.

  </Step>
</Steps>

## Use Skill Workshop for generated skills

For agent-generated procedures, use Skill Workshop instead of writing `SKILL.md`
directly. Skill Workshop creates a pending proposal first; it becomes an active
skill only after review and apply:

```bash
openclaw skills workshop propose-create \
  --name "hello-world" \
  --description "A simple skill that says hello." \
  --proposal ./PROPOSAL.md
```

Use `--proposal-dir` when the proposal also has support files:

```bash
openclaw skills workshop propose-create \
  --name "hello-world" \
  --description "A simple skill that says hello." \
  --proposal-dir ./hello-world-proposal
```

The proposal stays inactive until an operator reviews and applies it.
Proposal directories must contain `PROPOSAL.md`. Support files can be included
under `assets/`, `examples/`, `references/`, `scripts/`, or `templates/`:

```bash
openclaw skills workshop inspect <proposal-id>
openclaw skills workshop revise <proposal-id> --proposal ./PROPOSAL.md
openclaw skills workshop apply <proposal-id>
```

When applied, OpenClaw writes the final `SKILL.md` into the workspace `skills/`
root, writes approved support files beside it, and removes proposal-only
frontmatter such as `status: proposal`, proposal `version`, and proposal
`date`.

Full proposal storage, review, Gateway, and approval-policy details are in
[Skill Workshop](/tools/skill-workshop).

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

Each skills root can contain direct skill folders such as
`skills/hello-world/SKILL.md` or grouped folders such as
`skills/personal/hello-world/SKILL.md`.

## Related

- [Skills reference](/tools/skills) — loading, precedence, and gating rules
- [Skill Workshop](/tools/skill-workshop) — governed creation for generated or reviewed skill changes
- [Skills config](/tools/skills-config) — `skills.*` config schema
- [ClawHub](/clawhub) — public skill registry
- [Building Plugins](/plugins/building-plugins) — plugins can ship skills
