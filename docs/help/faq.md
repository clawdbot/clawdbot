---
summary: "Frequently asked questions about OpenClaw setup, configuration, and usage"
read_when:
  - Answering common setup, install, onboarding, or runtime support questions
  - Triaging user-reported issues before deeper debugging
title: "FAQ"
---

Quick answers plus deeper troubleshooting for real-world setups (local dev, VPS, multi-agent, OAuth/API keys, model failover). For runtime diagnostics, see [Troubleshooting](/gateway/troubleshooting). For the full config reference, see [Configuration](/gateway/configuration).

## First 60 seconds if something is broken

1. **Quick status (first check)**

   ```bash
   openclaw status
   ```

   Fast local summary: OS + update, gateway/service reachability, agents/sessions, provider config + runtime issues (when gateway is reachable).

2. **Pasteable report (safe to share)**

   ```bash
   openclaw status --all
   ```

   Read-only diagnosis with log tail (tokens redacted).

3. **Daemon + port state**

   ```bash
   openclaw gateway status
   ```

   Shows supervisor runtime vs RPC reachability, the probe target URL, and which config the service likely used.

4. **Deep probes**

   ```bash
   openclaw status --deep
   ```

   Runs a live gateway health probe, including channel probes when supported
   (requires a reachable gateway). See [Health](/gateway/health).

5. **Tail the latest log**

   ```bash
   openclaw logs --follow
   ```

   If RPC is down, fall back to:

   ```bash
   tail -f "$(ls -t /tmp/openclaw/openclaw-*.log | head -1)"
   ```

   File logs are separate from service logs; see [Logging](/logging) and [Troubleshooting](/gateway/troubleshooting).

6. **Run the doctor (repairs)**

   ```bash
   openclaw doctor
   ```

   Repairs/migrates config/state + runs health checks. See [Doctor](/gateway/doctor).

7. **Gateway snapshot**

   ```bash
   openclaw health --json
   openclaw health --verbose   # shows the target URL + config path on errors
   ```

   Asks the running gateway for a full snapshot (WS-only). See [Health](/gateway/health).

## Quick start and first-run setup

First-run Q&A — install, onboard, auth routes, subscriptions, initial failures —
lives on the [First-run FAQ](/help/faq-first-run).

## What is OpenClaw?

<AccordionGroup>
  <Accordion title="What is OpenClaw, in one paragraph?">
    OpenClaw is a personal AI assistant you run on your own devices. It replies on the messaging surfaces you already use (WhatsApp, Telegram, Slack, Mattermost, Discord, Google Chat, Signal, iMessage, WebChat, and bundled channel plugins such as QQ Bot) and can also do voice + a live Canvas on supported platforms. The **Gateway** is the always-on control plane; the assistant is the product.
  </Accordion>

  <Accordion title="Value proposition">
    OpenClaw is not "just a Claude wrapper." It's a **local-first control plane** that lets you run a
    capable assistant on **your own hardware**, reachable from the chat apps you already use, with
    stateful sessions, memory, and tools - without handing control of your workflows to a hosted
    SaaS.

    Highlights:

    - **Your devices, your data:** run the Gateway wherever you want (Mac, Linux, VPS) and keep the
      workspace + session history local.
    - **Real channels, not a web sandbox:** WhatsApp/Telegram/Slack/Discord/Signal/iMessage/etc,
      plus mobile voice and Canvas on supported platforms.
    - **Model-agnostic:** use Anthropic, OpenAI, MiniMax, OpenRouter, etc., with per-agent routing
      and failover.
    - **Local-only option:** run local models so **all data can stay on your device** if you want.
    - **Multi-agent routing:** separate agents per channel, account, or task, each with its own
      workspace and defaults.
    - **Open source and hackable:** inspect, extend, and self-host without vendor lock-in.

    Docs: [Gateway](/gateway), [Channels](/channels), [Multi-agent](/concepts/multi-agent),
    [Memory](/concepts/memory).

  </Accordion>

  <Accordion title="I just set it up - what should I do first?">
    Good first projects:

    - Build a website (WordPress, Shopify, or a simple static site).
    - Prototype a mobile app (outline, screens, API plan).
    - Organize files and folders (cleanup, naming, tagging).
    - Connect Gmail and automate summaries or follow ups.

    It can handle large tasks, but it works best when you split them into phases and
    use sub agents for parallel work.

  </Accordion>

  <Accordion title="What are the top five everyday use cases for OpenClaw?">
    Everyday wins usually look like:

    - **Personal briefings:** summaries of inbox, calendar, and news you care about.
    - **Research and drafting:** quick research, summaries, and first drafts for emails or docs.
    - **Reminders and follow ups:** cron or heartbeat driven nudges and checklists.
    - **Browser automation:** filling forms, collecting data, and repeating web tasks.
    - **Cross device coordination:** send a task from your phone, let the Gateway run it on a server, and get the result back in chat.

  </Accordion>

  <Accordion title="Can OpenClaw help with lead gen, outreach, ads, and blogs for a SaaS?">
    Yes for **research, qualification, and drafting**. It can scan sites, build shortlists,
    summarize prospects, and write outreach or ad copy drafts.

    For **outreach or ad runs**, keep a human in the loop. Avoid spam, follow local laws and
    platform policies, and review anything before it is sent. The safest pattern is to let
    OpenClaw draft and you approve.

    Docs: [Security](/gateway/security).

  </Accordion>

  <Accordion title="What are the advantages vs Claude Code for web development?">
    OpenClaw is a **personal assistant** and coordination layer, not an IDE replacement. Use
    Claude Code or Codex for the fastest direct coding loop inside a repo. Use OpenClaw when you
    want durable memory, cross-device access, and tool orchestration.

    Advantages:

    - **Persistent memory + workspace** across sessions
    - **Multi-platform access** (WhatsApp, Telegram, TUI, WebChat)
    - **Tool orchestration** (browser, files, scheduling, hooks)
    - **Always-on Gateway** (run on a VPS, interact from anywhere)
    - **Nodes** for local browser/screen/camera/exec

    Showcase: [https://openclaw.ai/showcase](https://openclaw.ai/showcase)

  </Accordion>
</AccordionGroup>

## Skills and automation

<AccordionGroup>
  <Accordion title="How do I customize skills without keeping the repo dirty?">
    Use managed overrides instead of editing the repo copy. Put your changes in `~/.openclaw/skills/<name>/SKILL.md` (or add a folder via `skills.load.extraDirs` in `~/.openclaw/openclaw.json`). Precedence is `<workspace>/skills` → `<workspace>/.agents/skills` → `~/.agents/skills` → `~/.openclaw/skills` → bundled → `skills.load.extraDirs`, so managed overrides still win over bundled skills without touching git. If you need the skill installed globally but only visible to some agents, keep the shared copy in `~/.openclaw/skills` and control visibility with `agents.defaults.skills` and `agents.list[].skills`. Only upstream-worthy edits should live in the repo and go out as PRs.
  </Accordion>

  <Accordion title="Can I load skills from a custom folder?">
    Yes. Add extra directories via `skills.load.extraDirs` in `~/.openclaw/openclaw.json` (lowest precedence). Default precedence is `<workspace>/skills` → `<workspace>/.agents/skills` → `~/.agents/skills` → `~/.openclaw/skills` → bundled → `skills.load.extraDirs`. `clawhub` installs into `./skills` by default, which OpenClaw treats as `<workspace>/skills` on the next session. If the skill should only be visible to certain agents, pair that with `agents.defaults.skills` or `agents.list[].skills`.
  </Accordion>

  <Accordion title="How can I use different models for different tasks?">
    Today the supported patterns are:

    - **Cron jobs**: isolated jobs can set a `model` override per job.
    - **Sub-agents**: route tasks to separate agents with different default models.
    - **On-demand switch**: use `/model` to switch the current session model at any time.

    See [Cron jobs](/automation/cron-jobs), [Multi-Agent Routing](/concepts/multi-agent), and [Slash commands](/tools/slash-commands).

  </Accordion>

  <Accordion title="The bot freezes while doing heavy work. How do I offload that?">
    Use **sub-agents** for long or parallel tasks. Sub-agents run in their own session,
    return a summary, and keep your main chat responsive.

    Ask your bot to "spawn a sub-agent for this task" or use `/subagents`.
    Use `/status` in chat to see what the Gateway is doing right now (and whether it is busy).

    Token tip: long tasks and sub-agents both consume tokens. If cost is a concern, set a
    cheaper model for sub-agents via `agents.defaults.subagents.model`.

    Docs: [Sub-agents](/tools/subagents), [Background Tasks](/automation/tasks).

  </Accordion>

  <Accordion title="How do thread-bound subagent sessions work on Discord?">
    Use thread bindings. You can bind a Discord thread to a subagent or session target so follow-up messages in that thread stay on that bound session.

    Basic flow:

    - Spawn with `sessions_spawn` using `thread: true` (and optionally `mode: "session"` for persistent follow-up).
    - Or manually bind with `/focus <target>`.
    - Use `/agents` to inspect binding state.
    - Use `/session idle <duration|off>` and `/session max-age <duration|off>` to control auto-unfocus.
    - Use `/unfocus` to detach the thread.

    Required config:

    - Global defaults: `session.threadBindings.enabled`, `session.threadBindings.idleHours`, `session.threadBindings.maxAgeHours`.
    - Discord overrides: `channels.discord.threadBindings.enabled`, `channels.discord.threadBindings.idleHours`, `channels.discord.threadBindings.maxAgeHours`.
    - Auto-bind on spawn: `channels.discord.threadBindings.spawnSessions` defaults to `true`; set it to `false` to disable thread-bound session spawns.

    Docs: [Sub-agents](/tools/subagents), [Discord](/channels/discord), [Configuration Reference](/gateway/configuration-reference), [Slash commands](/tools/slash-commands).

  </Accordion>

  <Accordion title="A subagent finished, but the completion update went to the wrong place or never posted. What should I check?">
    Check the resolved requester route first:

    - Completion-mode subagent delivery prefers any bound thread or conversation route when one exists.
    - If the completion origin only carries a channel, OpenClaw falls back to the requester session's stored route (`lastChannel` / `lastTo` / `lastAccountId`) so direct delivery can still succeed.
    - If neither a bound route nor a usable stored route exists, direct delivery can fail and the result falls back to queued session delivery instead of posting immediately to chat.
    - Invalid or stale targets can still force queue fallback or final delivery failure.
    - If the child's last visible assistant reply is the exact silent token `NO_REPLY` / `no_reply`, or exactly `ANNOUNCE_SKIP`, OpenClaw intentionally suppresses the announce instead of posting stale earlier progress.
    - If the child timed out after only tool calls, the announce can collapse that into a short partial-progress summary instead of replaying raw tool output.

    Debug:

    ```bash
    openclaw tasks show <runId-or-sessionKey>
    ```

    Docs: [Sub-agents](/tools/subagents), [Background Tasks](/automation/tasks), [Session Tools](/concepts/session-tool).

  </Accordion>

  <Accordion title="Cron or reminders do not fire. What should I check?">
    Cron runs inside the Gateway process. If the Gateway is not running continuously,
    scheduled jobs will not run.

    Checklist:

    - Confirm cron is enabled (`cron.enabled`) and `OPENCLAW_SKIP_CRON` is not set.
    - Check the Gateway is running 24/7 (no sleep/restarts).
    - Verify timezone settings for the job (`--tz` vs host timezone).

    Debug:

    ```bash
    openclaw cron run <jobId>
    openclaw cron runs --id <jobId> --limit 50
    ```

    Docs: [Cron jobs](/automation/cron-jobs), [Automation](/automation).

  </Accordion>

  <Accordion title="Cron fired, but nothing was sent to the channel. Why?">
    Check the delivery mode first:

    - `--no-deliver` / `delivery.mode: "none"` means no runner fallback send is expected.
    - Missing or invalid announce target (`channel` / `to`) means the runner skipped outbound delivery.
    - Channel auth failures (`unauthorized`, `Forbidden`) mean the runner tried to deliver but credentials blocked it.
    - A silent isolated result (`NO_REPLY` / `no_reply` only) is treated as intentionally non-deliverable, so the runner also suppresses queued fallback delivery.

    For isolated cron jobs, the agent can still send directly with the `message`
    tool when a chat route is available. `--announce` only controls the runner
    fallback path for final text that the agent did not already send.

    Debug:

    ```bash
    openclaw cron runs --id <jobId> --limit 50
    openclaw tasks show <runId-or-sessionKey>
    ```

    Docs: [Cron jobs](/automation/cron-jobs), [Background Tasks](/automation/tasks).

  </Accordion>

  <Accordion title="Why did an isolated cron run switch models or retry once?">
    That is usually the live model-switch path, not duplicate scheduling.

    Isolated cron can persist a runtime model handoff and retry when the active
    run throws `LiveSessionModelSwitchError`. The retry keeps the switched
    provider/model, and if the switch carried a new auth profile override, cron
    persists that too before retrying.

    Related selection rules:

    - Gmail hook model override wins first when applicable.
    - Then per-job `model`.
    - Then any stored cron-session model override.
    - Then the normal agent/default model selection.

    The retry loop is bounded. After the initial attempt plus 2 switch retries,
    cron aborts instead of looping forever.

    Debug:

    ```bash
    openclaw cron runs --id <jobId> --limit 50
    openclaw tasks show <runId-or-sessionKey>
    ```

    Docs: [Cron jobs](/automation/cron-jobs), [cron CLI](/cli/cron).

  </Accordion>

  <Accordion title="How do I install skills on Linux?">
    Use native `openclaw skills` commands or drop skills into your workspace. The macOS Skills UI isn't available on Linux.
    Browse skills at [https://clawhub.ai](https://clawhub.ai).

    ```bash
    openclaw skills search "calendar"
    openclaw skills search --limit 20
    openclaw skills install <skill-slug>
    openclaw skills install <skill-slug> --version <version>
    openclaw skills install <skill-slug> --force
    openclaw skills update --all
    openclaw skills list --eligible
    openclaw skills check
    ```

    Native `openclaw skills install` writes into the active workspace `skills/`
    directory. Install the separate `clawhub` CLI only if you want to publish or
    sync your own skills. For shared installs across agents, put the skill under
    `~/.openclaw/skills` and use `agents.defaults.skills` or
    `agents.list[].skills` if you want to narrow which agents can see it.

  </Accordion>

  <Accordion title="Can OpenClaw run tasks on a schedule or continuously in the background?">
    Yes. Use the Gateway scheduler:

    - **Cron jobs** for scheduled or recurring tasks (persist across restarts).
    - **Heartbeat** for "main session" periodic checks.
    - **Isolated jobs** for autonomous agents that post summaries or deliver to chats.

    Docs: [Cron jobs](/automation/cron-jobs), [Automation](/automation),
    [Heartbeat](/gateway/heartbeat).

  </Accordion>

  <Accordion title="Can I run Apple macOS-only skills from Linux?">
    Not directly. macOS skills are gated by `metadata.openclaw.os` plus required binaries, and skills only appear in the system prompt when they are eligible on the **Gateway host**. On Linux, `darwin`-only skills (like `apple-notes`, `apple-reminders`, `things-mac`) will not load unless you override the gating.

    You have three supported patterns:

    **Option A - run the Gateway on a Mac (simplest).**
    Run the Gateway where the macOS binaries exist, then connect from Linux in [remote mode](#gateway-ports-already-running-and-remote-mode) or over Tailscale. The skills load normally because the Gateway host is macOS.

    **Option B - use a macOS node (no SSH).**
    Run the Gateway on Linux, pair a macOS node (menubar app), and set **Node Run Commands** to "Always Ask" or "Always Allow" on the Mac. OpenClaw can treat macOS-only skills as eligible when the required binaries exist on the node. The agent runs those skills via the `nodes` tool. If you choose "Always Ask", approving "Always Allow" in the prompt adds that command to the allowlist.

    **Option C - proxy macOS binaries over SSH (advanced).**
    Keep the Gateway on Linux, but make the required CLI binaries resolve to SSH wrappers that run on a Mac. Then override the skill to allow Linux so it stays eligible.

    1. Create an SSH wrapper for the binary (example: `memo` for Apple Notes):

       ```bash
       #!/usr/bin/env bash
       set -euo pipefail
       exec ssh -T user@mac-host /opt/homebrew/bin/memo "$@"
       ```

    2. Put the wrapper on `PATH` on the Linux host (for example `~/bin/memo`).
    3. Override the skill metadata (workspace or `~/.openclaw/skills`) to allow Linux:

       ```markdown
       ---
       name: apple-notes
       description: Manage Apple Notes via the memo CLI on macOS.
       metadata: { "openclaw": { "os": ["darwin", "linux"], "requires": { "bins": ["memo"] } } }
       ---
       ```

    4. Start a new session so the skills snapshot refreshes.

  </Accordion>

  <Accordion title="Do you have a Notion or HeyGen integration?">
    Not built-in today.

    Options:

    - **Custom skill / plugin:** best for reliable API access (Notion/HeyGen both have APIs).
    - **Browser automation:** works without code but is slower and more fragile.

    If you want to keep context per client (agency workflows), a simple pattern is:

    - One Notion page per client (context + preferences + active work).
    - Ask the agent to fetch that page at the start of a session.

    If you want a native integration, open a feature request or build a skill
    targeting those APIs.

    Install skills:

    ```bash
    openclaw skills install <skill-slug>
    openclaw skills update --all
    ```

    Native installs land in the active workspace `skills/` directory. For shared skills across agents, place them in `~/.openclaw/skills/<name>/SKILL.md`. If only some agents should see a shared install, configure `agents.defaults.skills` or `agents.list[].skills`. Some skills expect binaries installed via Homebrew; on Linux that means Linuxbrew (see the Homebrew Linux FAQ entry above). See [Skills](/tools/skills), [Skills config](/tools/skills-config), and [ClawHub](/clawhub).

  </Accordion>

  <Accordion title="How do I use my existing signed-in Chrome with OpenClaw?">
    Use the built-in `user` browser profile, which attaches through Chrome DevTools MCP:

    ```bash
    openclaw browser --browser-profile user tabs
    openclaw browser --browser-profile user snapshot
    ```

    If you want a custom name, create an explicit MCP profile:

    ```bash
    openclaw browser create-profile --name chrome-live --driver existing-session
    openclaw browser --browser-profile chrome-live tabs
    ```

    This path can use the local host browser or a connected browser node. If the Gateway runs elsewhere, either run a node host on the browser machine or use remote CDP instead.

    Current limits on `existing-session` / `user`:

    - actions are ref-driven, not CSS-selector driven
    - uploads require `ref` / `inputRef` and currently support one file at a time
    - `responsebody`, PDF export, download interception, and batch actions still need a managed browser or raw CDP profile

  </Accordion>
</AccordionGroup>

## Sandboxing and memory

<AccordionGroup>
  <Accordion title="Is there a dedicated sandboxing doc?">
    Yes. See [Sandboxing](/gateway/sandboxing). For Docker-specific setup (full gateway in Docker or sandbox images), see [Docker](/install/docker).
  </Accordion>

  <Accordion title="Docker feels limited - how do I enable full features?">
    The default image is security-first and runs as the `node` user, so it does not
    include system packages, Homebrew, or bundled browsers. For a fuller setup:

    - Persist `/home/node` with `OPENCLAW_HOME_VOLUME` so caches survive.
    - Bake system deps into the image with `OPENCLAW_DOCKER_APT_PACKAGES`.
    - Install Playwright browsers via the bundled CLI:
      `node /app/node_modules/playwright-core/cli.js install chromium`
    - Set `PLAYWRIGHT_BROWSERS_PATH` and ensure the path is persisted.

    Docs: [Docker](/install/docker), [Browser](/tools/browser).

  </Accordion>

  <Accordion title="Can I keep DMs personal but make groups public/sandboxed with one agent?">
    Yes - if your private traffic is **DMs** and your public traffic is **groups**.

    Use `agents.defaults.sandbox.mode: "non-main"` so group/channel sessions (non-main keys) run in the configured sandbox backend, while the main DM session stays on-host. Docker is the default backend if you do not choose one. Then restrict what tools are available in sandboxed sessions via `tools.sandbox.tools`.

    Setup walkthrough + example config: [Groups: personal DMs + public groups](/channels/groups#pattern-personal-dms-public-groups-single-agent)

    Key config reference: [Gateway configuration](/gateway/config-agents#agentsdefaultssandbox)

  </Accordion>

  <Accordion title="How do I bind a host folder into the sandbox?">
    Set `agents.defaults.sandbox.docker.binds` to `["host:path:mode"]` (e.g., `"/home/user/src:/src:ro"`). Global + per-agent binds merge; per-agent binds are ignored when `scope: "shared"`. Use `:ro` for anything sensitive and remember binds bypass the sandbox filesystem walls.

    OpenClaw validates bind sources against both the normalized path and the canonical path resolved through the deepest existing ancestor. That means symlink-parent escapes still fail closed even when the last path segment does not exist yet, and allowed-root checks still apply after symlink resolution.

    See [Sandboxing](/gateway/sandboxing#custom-bind-mounts) and [Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated#bind-mounts-security-quick-check) for examples and safety notes.

  </Accordion>

  <Accordion title="How does memory work?">
    OpenClaw memory is just Markdown files in the agent workspace:

    - Daily notes in `memory/YYYY-MM-DD.md`
    - Curated long-term notes in `MEMORY.md` (main/private sessions only)

    OpenClaw also runs a **silent pre-compaction memory flush** to remind the model
    to write durable notes before auto-compaction. This only runs when the workspace
    is writable (read-only sandboxes skip it). See [Memory](/concepts/memory).

  </Accordion>

  <Accordion title="Memory keeps forgetting things. How do I make it stick?">
    Ask the bot to **write the fact to memory**. Long-term notes belong in `MEMORY.md`,
    short-term context goes into `memory/YYYY-MM-DD.md`.

    This is still an area we are improving. It helps to remind the model to store memories;
    it will know what to do. If it keeps forgetting, verify the Gateway is using the same
    workspace on every run.

    Docs: [Memory](/concepts/memory), [Agent workspace](/concepts/agent-workspace).

  </Accordion>

  <Accordion title="Does memory persist forever? What are the limits?">
    Memory files live on disk and persist until you delete them. The limit is your
    storage, not the model. The **session context** is still limited by the model
    context window, so long conversations can compact or truncate. That is why
    memory search exists - it pulls only the relevant parts back into context.

    Docs: [Memory](/concepts/memory), [Context](/concepts/context).

  </Accordion>

  <Accordion title="Does semantic memory search require an OpenAI API key?">
    Only if you use **OpenAI embeddings**. Codex OAuth covers chat/completions and
    does **not** grant embeddings access, so **signing in with Codex (OAuth or the
    Codex CLI login)** does not help for semantic memory search. OpenAI embeddings
    still need a real API key (`OPENAI_API_KEY` or `models.providers.openai.apiKey`).

    If you don't set a provider explicitly, OpenClaw auto-selects a provider when it
    can resolve an API key (auth profiles, `models.providers.*.apiKey`, or env vars).
    It prefers OpenAI if an OpenAI key resolves, otherwise Gemini if a Gemini key
    resolves, then Voyage, then Mistral. If no remote key is available, memory
    search stays disabled until you configure it. If you have a local model path
    configured and present, OpenClaw
    prefers `local`. Ollama is supported when you explicitly set
    `memorySearch.provider = "ollama"`.

    If you'd rather stay local, set `memorySearch.provider = "local"` (and optionally
    `memorySearch.fallback = "none"`). If you want Gemini embeddings, set
    `memorySearch.provider = "gemini"` and provide `GEMINI_API_KEY` (or
    `memorySearch.remote.apiKey`). We support **OpenAI, Gemini, Voyage, Mistral, Ollama, or local** embedding
    models - see [Memory](/concepts/memory) for the setup details.

  </Accordion>
</AccordionGroup>

## Where things live on disk

<AccordionGroup>
  <Accordion title="Is all data used with OpenClaw saved locally?">
    No - **OpenClaw's state is local**, but **external services still see what you send them**.

    - **Local by default:** sessions, memory files, config, and workspace live on the Gateway host
      (`~/.openclaw` + your workspace directory).
    - **Remote by necessity:** messages you send to model providers (Anthropic/OpenAI/etc.) go to
      their APIs, and chat platforms (WhatsApp/Telegram/Slack/etc.) store message data on their
      servers.
    - **You control the footprint:** using local models keeps prompts on your machine, but channel
      traffic still goes through the channel's servers.

    Related: [Agent workspace](/concepts/agent-workspace), [Memory](/concepts/memory).

  </Accordion>

  <Accordion title="Where does OpenClaw store its data?">
    Everything lives under `$OPENCLAW_STATE_DIR` (default: `~/.openclaw`):

    | Path                                                            | Purpose                                                            |
    | --------------------------------------------------------------- | ------------------------------------------------------------------ |
    | `$OPENCLAW_STATE_DIR/openclaw.json`                             | Main config (JSON5)                                                |
    | `$OPENCLAW_STATE_DIR/credentials/oauth.json`                    | Legacy OAuth import (copied into auth profiles on first use)       |
    | `$OPENCLAW_STATE_DIR/agents/<agentId>/agent/auth-profiles.json` | Auth profiles (OAuth, API keys, and optional `keyRef`/`tokenRef`)  |
    | `$OPENCLAW_STATE_DIR/secrets.json`                              | Optional file-backed secret payload for `file` SecretRef providers |
    | `$OPENCLAW_STATE_DIR/agents/<agentId>/agent/auth.json`          | Legacy compatibility file (static `api_key` entries scrubbed)      |
    | `$OPENCLAW_STATE_DIR/credentials/`                              | Provider state (e.g. `whatsapp/<accountId>/creds.json`)            |
    | `$OPENCLAW_STATE_DIR/agents/`                                   | Per-agent state (agentDir + sessions)                              |
    | `$OPENCLAW_STATE_DIR/agents/<agentId>/sessions/`                | Conversation history & state (per agent)                           |
    | `$OPENCLAW_STATE_DIR/agents/<agentId>/sessions/sessions.json`   | Session metadata (per agent)                                       |

    Legacy single-agent path: `~/.openclaw/agent/*` (migrated by `openclaw doctor`).

    Your **workspace** (AGENTS.md, memory files, skills, etc.) is separate and configured via `agents.defaults.workspace` (default: `~/.openclaw/workspace`).

  </Accordion>

  <Accordion title="Where should AGENTS.md / SOUL.md / USER.md / MEMORY.md live?">
    These files live in the **agent workspace**, not `~/.openclaw`.

    - **Workspace (per agent)**: `AGENTS.md`, `SOUL.md`, `IDENTITY.md`, `USER.md`,
      `MEMORY.md`, `memory/YYYY-MM-DD.md`, optional `HEARTBEAT.md`.
      Lowercase root `memory.md` is legacy repair input only; `openclaw doctor --fix`
      can merge it into `MEMORY.md` when both files exist.
    - **State dir (`~/.openclaw`)**: config, channel/provider state, auth profiles, sessions, logs,
      and shared skills (`~/.openclaw/skills`).

    Default workspace is `~/.openclaw/workspace`, configurable via:

    ```json5
    {
      agents: { defaults: { workspace: "~/.openclaw/workspace" } },
    }
    ```

    If the bot "forgets" after a restart, confirm the Gateway is using the same
    workspace on every launch (and remember: remote mode uses the **gateway host's**
    workspace, not your local laptop).

    Tip: if you want a durable behavior or preference, ask the bot to **write it into
    AGENTS.md or MEMORY.md** rather than relying on chat history.

    See [Agent workspace](/concepts/agent-workspace) and [Memory](/concepts/memory).

  </Accordion>

  <Accordion title="Recommended backup strategy">
    Put your **agent workspace** in a **private** git repo and back it up somewhere
    private (for example GitHub private). This captures memory + AGENTS/SOUL/USER
    files, and lets you restore the assistant's "mind" later.

    Do **not** commit anything under `~/.openclaw` (credentials, sessions, tokens, or encrypted secrets payloads).
    If you need a full restore, back up both the workspace and the state directory
    separately (see the migration question above).

    Docs: [Agent workspace](/concepts/agent-workspace).

  </Accordion>

  <Accordion title="How do I completely uninstall OpenClaw?">
    See the dedicated guide: [Uninstall](/install/uninstall).
  </Accordion>

  <Accordion title="Can agents work outside the workspace?">
    Yes. The workspace is the **default cwd** and memory anchor, not a hard sandbox.
    Relative paths resolve inside the workspace, but absolute paths can access other
    host locations unless sandboxing is enabled. If you need isolation, use
    [`agents.defaults.sandbox`](/gateway/sandboxing) or per-agent sandbox settings. If you
    want a repo to be the default working directory, point that agent's
    `workspace` to the repo root. The OpenClaw repo is just source code; keep the
    workspace separate unless you intentionally want the agent to work inside it.

    Example (repo as default cwd):

    ```json5
    {
      agents: {
        defaults: {
          workspace: "~/Projects/my-repo",
        },
      },
    }
    ```

  </Accordion>

  <Accordion title="Remote mode: where is the session store?">
    Session state is owned by the **gateway host**. If you're in remote mode, the session store you care about is on the remote machine, not your local laptop. See [Session management](/concepts/session).
  </Accordion>
</AccordionGroup>

## Config basics

<AccordionGroup>
  <Accordion title="What format is the config? Where is it?">
    OpenClaw reads an optional **JSON5** config from `$OPENCLAW_CONFIG_PATH` (default: `~/.openclaw/openclaw.json`):

    ```
    $OPENCLAW_CONFIG_PATH
    ```

    If the file is missing, it uses safe-ish defaults (including a default workspace of `~/.openclaw/workspace`).

  </Accordion>

  <Accordion title='I set gateway.bind: "lan" (or "tailnet") and now nothing listens / the UI says unauthorized'>
    Non-loopback binds **require a valid gateway auth path**. In practice that means:

    - shared-secret auth: token or password
    - `gateway.auth.mode: "trusted-proxy"` behind a correctly configured identity-aware reverse proxy

    ```json5
    {
      gateway: {
        bind: "lan",
        auth: {
          mode: "token",
          token: "replace-me",
        },
      },
    }
    ```

    Notes:

    - `gateway.remote.token` / `.password` do **not** enable local gateway auth by themselves.
    - Local call paths can use `gateway.remote.*` as fallback only when `gateway.auth.*` is unset.
    - For password auth, set `gateway.auth.mode: "password"` plus `gateway.auth.password` (or `OPENCLAW_GATEWAY_PASSWORD`) instead.
    - If `gateway.auth.token` / `gateway.auth.password` is explicitly configured via SecretRef and unresolved, resolution fails closed (no remote fallback masking).
    - Shared-secret Control UI setups authenticate via `connect.params.auth.token` or `connect.params.auth.password` (stored in app/UI settings). Identity-bearing modes such as Tailscale Serve or `trusted-proxy` use request headers instead. Avoid putting shared secrets in URLs.
    - With `gateway.auth.mode: "trusted-proxy"`, same-host loopback reverse proxies require explicit `gateway.auth.trustedProxy.allowLoopback = true` and a loopback entry in `gateway.trustedProxies`.

  </Accordion>

  <Accordion title="Why do I need a token on localhost now?">
    OpenClaw enforces gateway auth by default, including loopback. In the normal default path that means token auth: if no explicit auth path is configured, gateway startup resolves to token mode and generates a runtime-only token for that startup, so **local WS clients must authenticate**. Configure `gateway.auth.token`, `gateway.auth.password`, `OPENCLAW_GATEWAY_TOKEN`, or `OPENCLAW_GATEWAY_PASSWORD` explicitly when clients need a stable secret across restarts. This blocks other local processes from calling the Gateway.

    If you prefer a different auth path, you can explicitly choose password mode (or, for identity-aware reverse proxies, `trusted-proxy`). If you **really** want open loopback, set `gateway.auth.mode: "none"` explicitly in your config. Doctor can generate a token for you any time: `openclaw doctor --generate-gateway-token`.

  </Accordion>

  <Accordion title="Do I have to restart after changing config?">
    The Gateway watches the config and supports hot-reload:

    - `gateway.reload.mode: "hybrid"` (default): hot-apply safe changes, restart for critical ones
    - `hot`, `restart`, `off` are also supported

  </Accordion>

  <Accordion title="How do I disable funny CLI taglines?">
    Set `cli.banner.taglineMode` in config:

    ```json5
    {
      cli: {
        banner: {
          taglineMode: "off", // random | default | off
        },
      },
    }
    ```

    - `off`: hides tagline text but keeps the banner title/version line.
    - `default`: uses `All your chats, one OpenClaw.` every time.
    - `random`: rotating funny/seasonal taglines (default behavior).
    - If you want no banner at all, set env `OPENCLAW_HIDE_BANNER=1`.

  </Accordion>

  <Accordion title="How do I enable web search (and web fetch)?">
    `web_fetch` works without an API key. `web_search` depends on your selected
    provider:

    - API-backed providers such as Brave, Exa, Firecrawl, Gemini, Grok, Kimi, MiniMax Search, Perplexity, and Tavily require their normal API key setup.
    - Ollama Web Search is key-free, but it uses your configured Ollama host and requires `ollama signin`.
    - DuckDuckGo is key-free, but it is an unofficial HTML-based integration.
    - SearXNG is key-free/self-hosted; configure `SEARXNG_BASE_URL` or `plugins.entries.searxng.config.webSearch.baseUrl`.

    **Recommended:** run `openclaw configure --section web` and choose a provider.
    Environment alternatives:

    - Brave: `BRAVE_API_KEY`
    - Exa: `EXA_API_KEY`
    - Firecrawl: `FIRECRAWL_API_KEY`
    - Gemini: `GEMINI_API_KEY`
    - Grok: `XAI_API_KEY`
    - Kimi: `KIMI_API_KEY` or `MOONSHOT_API_KEY`
    - MiniMax Search: `MINIMAX_CODE_PLAN_KEY`, `MINIMAX_CODING_API_KEY`, or `MINIMAX_API_KEY`
    - Perplexity: `PERPLEXITY_API_KEY` or `OPENROUTER_API_KEY`
    - SearXNG: `SEARXNG_BASE_URL`
    - Tavily: `TAVILY_API_KEY`

    ```json5
    {
      plugins: {
        entries: {
          brave: {
            config: {
              webSearch: {
                apiKey: "BRAVE_API_KEY_HERE",
              },
            },
          },
        },
        },
        tools: {
          web: {
            search: {
              enabled: true,
              provider: "brave",
              maxResults: 5,
            },
            fetch: {
              enabled: true,
              provider: "firecrawl", // optional; omit for auto-detect
            },
          },
        },
    }
    ```

    Provider-specific web-search config now lives under `plugins.entries.<plugin>.config.webSearch.*`.
    Legacy `tools.web.search.*` provider paths still load temporarily for compatibility, but they should not be used for new configs.
    Firecrawl web-fetch fallback config lives under `plugins.entries.firecrawl.config.webFetch.*`.

    Notes:

    - If you use allowlists, add `web_search`/`web_fetch`/`x_search` or `group:web`.
    - `web_fetch` is enabled by default (unless explicitly disabled).
    - If `tools.web.fetch.provider` is omitted, OpenClaw auto-detects the first ready fetch fallback provider from available credentials. Today the bundled provider is Firecrawl.
    - Daemons read env vars from `~/.openclaw/.env` (or the service environment).

    Docs: [Web tools](/tools/web).

  </Accordion>

  <Accordion title="config.apply wiped my config. How do I recover and avoid this?">
    `config.apply` replaces the **entire config**. If you send a partial object, everything
    else is removed.

    Current OpenClaw protects many accidental clobbers:

    - OpenClaw-owned config writes validate the full post-change config before writing.
    - Invalid or destructive OpenClaw-owned writes are rejected and saved as `openclaw.json.rejected.*`.
    - If a direct edit breaks startup or hot reload, Gateway fails closed or skips the reload; it does not rewrite `openclaw.json`.
    - `openclaw doctor --fix` owns repair and can restore last-known-good while saving the rejected file as `openclaw.json.clobbered.*`.

    Recover:

    - Check `openclaw logs --follow` for `Invalid config at`, `Config write rejected:`, or `config reload skipped (invalid config)`.
    - Inspect the newest `openclaw.json.clobbered.*` or `openclaw.json.rejected.*` beside the active config.
    - Run `openclaw config validate` and `openclaw doctor --fix`.
    - Copy only the intended keys back with `openclaw config set` or `config.patch`.
    - If you have no last-known-good or rejected payload, restore from backup, or re-run `openclaw doctor` and reconfigure channels/models.
    - If this was unexpected, file a bug and include your last known config or any backup.
    - A local coding agent can often reconstruct a working config from logs or history.

    Avoid it:

    - Use `openclaw config set` for small changes.
    - Use `openclaw configure` for interactive edits.
    - Use `config.schema.lookup` first when you are not sure about an exact path or field shape; it returns a shallow schema node plus immediate child summaries for drill-down.
    - Use `config.patch` for partial RPC edits; keep `config.apply` for full-config replacement only.
    - If you are using the owner-only `gateway` tool from an agent run, it will still reject writes to `tools.exec.ask` / `tools.exec.security` (including legacy `tools.bash.*` aliases that normalize to the same protected exec paths).

    Docs: [Config](/cli/config), [Configure](/cli/configure), [Gateway troubleshooting](/gateway/troubleshooting#gateway-rejected-invalid-config), [Doctor](/gateway/doctor).

  </Accordion>

  <Accordion title="How do I run a central Gateway with specialized workers across devices?">
    The common pattern is **one Gateway** (e.g. Raspberry Pi) plus **nodes** and **agents**:

    - **Gateway (central):** owns channels (Signal/WhatsApp), routing, and sessions.
    - **Nodes (devices):** Macs/iOS/Android connect as peripherals and expose local tools (`system.run`, `canvas`, `camera`).
    - **Agents (workers):** separate brains/workspaces for special roles (e.g. "Hetzner ops", "Personal data").
    - **Sub-agents:** spawn background work from a main agent when you want parallelism.
    - **TUI:** connect to the Gateway and switch agents/sessions.

    Docs: [Nodes](/nodes), [Remote access](/gateway/remote), [Multi-Agent Routing](/concepts/multi-agent), [Sub-agents](/tools/subagents), [TUI](/web/tui).

  </Accordion>

  <Accordion title="Can the OpenClaw browser run headless?">
    Yes. It's a config option:

    ```json5
    {
      browser: { headless: true },
      agents: {
        defaults: {
          sandbox: { browser: { headless: true } },
        },
      },
    }
    ```

    Default is `false` (headful). Headless is more likely to trigger anti-bot checks on some sites. See [Browser](/tools/browser).

    Headless uses the **same Chromium engine** and works for most automation (forms, clicks, scraping, logins). The main differences:

    - No visible browser window (use screenshots if you need visuals).
    - Some sites are stricter about automation in headless mode (CAPTCHAs, anti-bot).
      For example, X/Twitter often blocks headless sessions.

  </Accordion>

  <Accordion title="How do I use Brave for browser control?">
    Set `browser.executablePath` to your Brave binary (or any Chromium-based browser) and restart the Gateway.
    See the full config examples in [Browser](/tools/browser#use-brave-or-another-chromium-based-browser).
  </Accordion>
</AccordionGroup>

## Remote gateways and nodes

<AccordionGroup>
  <Accordion title="How do commands propagate between Telegram, the gateway, and nodes?">
    Telegram messages are handled by the **gateway**. The gateway runs the agent and
    only then calls nodes over the **Gateway WebSocket** when a node tool is needed:

    Telegram → Gateway → Agent → `node.*` → Node → Gateway → Telegram

    Nodes don't see inbound provider traffic; they only receive node RPC calls.

  </Accordion>

  <Accordion title="How can my agent access my computer if the Gateway is hosted remotely?">
    Short answer: **pair your computer as a node**. The Gateway runs elsewhere, but it can
    call `node.*` tools (screen, camera, system) on your local machine over the Gateway WebSocket.

    Typical setup:

    1. Run the Gateway on the always-on host (VPS/home server).
    2. Put the Gateway host + your computer on the same tailnet.
    3. Ensure the Gateway WS is reachable (tailnet bind or SSH tunnel).
    4. Open the macOS app locally and connect in **Remote over SSH** mode (or direct tailnet)
       so it can register as a node.
    5. Approve the node on the Gateway:

       ```bash
       openclaw devices list
       openclaw devices approve <requestId>
       ```

    No separate TCP bridge is required; nodes connect over the Gateway WebSocket.

    Security reminder: pairing a macOS node allows `system.run` on that machine. Only
    pair devices you trust, and review [Security](/gateway/security).

    Docs: [Nodes](/nodes), [Gateway protocol](/gateway/protocol), [macOS remote mode](/platforms/mac/remote), [Security](/gateway/security).

  </Accordion>

  <Accordion title="Tailscale is connected but I get no replies. What now?">
    Check the basics:

    - Gateway is running: `openclaw gateway status`
    - Gateway health: `openclaw status`
    - Channel health: `openclaw channels status`

    Then verify auth and routing:

    - If you use Tailscale Serve, make sure `gateway.auth.allowTailscale` is set correctly.
    - If you connect via SSH tunnel, confirm the local tunnel is up and points at the right port.
    - Confirm your allowlists (DM or group) include your account.

    Docs: [Tailscale](/gateway/tailscale), [Remote access](/gateway/remote), [Channels](/channels).

  </Accordion>

  <Accordion title="Can two OpenClaw instances talk to each other (local + VPS)?">
    Yes. There is no built-in "bot-to-bot" bridge, but you can wire it up in a few
    reliable ways:

    **Simplest:** use a normal chat channel both bots can access (Telegram/Slack/WhatsApp).
    Have Bot A send a message to Bot B, then let Bot B reply as usual.

    **CLI bridge (generic):** run a script that calls the other Gateway with
    `openclaw agent --message ... --deliver`, targeting a chat where the other bot
    listens. If one bot is on a remote VPS, point your CLI at that remote Gateway
    via SSH/Tailscale (see [Remote access](/gateway/remote)).

    Example pattern (run from a machine that can reach the target Gateway):

    ```bash
    openclaw agent --message "Hello from local bot" --deliver --channel telegram --reply-to <chat-id>
    ```

    Tip: add a guardrail so the two bots do not loop endlessly (mention-only, channel
    allowlists, or a "do not reply to bot messages" rule).

    Docs: [Remote access](/gateway/remote), [Agent CLI](/cli/agent), [Agent send](/tools/agent-send).

  </Accordion>

  <Accordion title="Do I need separate VPSes for multiple agents?">
    No. One Gateway can host multiple agents, each with its own workspace, model defaults,
    and routing. That is the normal setup and it is much cheaper and simpler than running
    one VPS per agent.

    Use separate VPSes only when you need hard isolation (security boundaries) or very
    different configs that you do not want to share. Otherwise, keep one Gateway and
    use multiple agents or sub-agents.

  </Accordion>

  <Accordion title="Is there a benefit to using a node on my personal laptop instead of SSH from a VPS?">
    Yes - nodes are the first-class way to reach your laptop from a remote Gateway, and they
    unlock more than shell access. The Gateway runs on macOS/Linux (Windows via WSL2) and is
    lightweight (a small VPS or Raspberry Pi-class box is fine; 4 GB RAM is plenty), so a common
    setup is an always-on host plus your laptop as a node.

    - **No inbound SSH required.** Nodes connect out to the Gateway WebSocket and use device pairing.
    - **Safer execution controls.** `system.run` is gated by node allowlists/approvals on that laptop.
    - **More device tools.** Nodes expose `canvas`, `camera`, and `screen` in addition to `system.run`.
    - **Local browser automation.** Keep the Gateway on a VPS, but run Chrome locally through a node host on the laptop, or attach to local Chrome on the host via Chrome MCP.

    SSH is fine for ad-hoc shell access, but nodes are simpler for ongoing agent workflows and
    device automation.

    Docs: [Nodes](/nodes), [Nodes CLI](/cli/nodes), [Browser](/tools/browser).

  </Accordion>

  <Accordion title="Do nodes run a gateway service?">
    No. Only **one gateway** should run per host unless you intentionally run isolated profiles (see [Multiple gateways](/gateway/multiple-gateways)). Nodes are peripherals that connect
    to the gateway (iOS/Android nodes, or macOS "node mode" in the menubar app). For headless node
    hosts and CLI control, see [Node host CLI](/cli/node).

    A full restart is required for `gateway`, `discovery`, and hosted plugin surface changes.

  </Accordion>

  <Accordion title="Is there an API / RPC way to apply config?">
    Yes.

    - `config.schema.lookup`: inspect one config subtree with its shallow schema node, matched UI hint, and immediate child summaries before writing
    - `config.get`: fetch the current snapshot + hash
    - `config.patch`: safe partial update (preferred for most RPC edits); hot-reloads when possible and restarts when required
    - `config.apply`: validate + replace the full config; hot-reloads when possible and restarts when required
    - The owner-only `gateway` runtime tool still refuses to rewrite `tools.exec.ask` / `tools.exec.security`; legacy `tools.bash.*` aliases normalize to the same protected exec paths

  </Accordion>

  <Accordion title="Minimal sane config for a first install">
    ```json5
    {
      agents: { defaults: { workspace: "~/.openclaw/workspace" } },
      channels: { whatsapp: { allowFrom: ["+15555550123"] } },
    }
    ```

    This sets your workspace and restricts who can trigger the bot.

  </Accordion>

  <Accordion title="How do I set up Tailscale on a VPS and connect from my Mac?">
    Minimal steps:

    1. **Install + login on the VPS**

       ```bash
       curl -fsSL https://tailscale.com/install.sh | sh
       sudo tailscale up
       ```

    2. **Install + login on your Mac**
       - Use the Tailscale app and sign in to the same tailnet.
    3. **Enable MagicDNS (recommended)**
       - In the Tailscale admin console, enable MagicDNS so the VPS has a stable name.
    4. **Use the tailnet hostname**
       - SSH: `ssh user@your-vps.tailnet-xxxx.ts.net`
       - Gateway WS: `ws://your-vps.tailnet-xxxx.ts.net:18789`

    If you want the Control UI without SSH, use Tailscale Serve on the VPS:

    ```bash
    openclaw gateway --tailscale serve
    ```

    This keeps the gateway bound to loopback and exposes HTTPS via Tailscale. See [Tailscale](/gateway/tailscale).

  </Accordion>

  <Accordion title="How do I connect a Mac node to a remote Gateway (Tailscale Serve)?">
    Serve exposes the **Gateway Control UI + WS**. Nodes connect over the same Gateway WS endpoint.

    Recommended setup:

    1. **Make sure the VPS + Mac are on the same tailnet**.
    2. **Use the macOS app in Remote mode** (SSH target can be the tailnet hostname).
       The app will tunnel the Gateway port and connect as a node.
    3. **Approve the node** on the gateway:

       ```bash
       openclaw devices list
       openclaw devices approve <requestId>
       ```

    Docs: [Gateway protocol](/gateway/protocol), [Discovery](/gateway/discovery), [macOS remote mode](/platforms/mac/remote).

  </Accordion>

  <Accordion title="Should I install on a second laptop or just add a node?">
    If you only need **local tools** (screen/camera/exec) on the second laptop, add it as a
    **node**. That keeps a single Gateway and avoids duplicated config. Local node tools are
    currently macOS-only, but we plan to extend them to other OSes.

    Install a second Gateway only when you need **hard isolation** or two fully separate bots.

    Docs: [Nodes](/nodes), [Nodes CLI](/cli/nodes), [Multiple gateways](/gateway/multiple-gateways).

  </Accordion>
</AccordionGroup>

## Env vars and .env loading

<AccordionGroup>
  <Accordion title="How does OpenClaw load environment variables?">
    OpenClaw reads env vars from the parent process (shell, launchd/systemd, CI, etc.) and additionally loads:

    - `.env` from the current working directory
    - a global fallback `.env` from `~/.openclaw/.env` (aka `$OPENCLAW_STATE_DIR/.env`)

    Neither `.env` file overrides existing env vars.

    You can also define inline env vars in config (applied only if missing from the process env):

    ```json5
    {
      env: {
        OPENROUTER_API_KEY: "sk-or-...",
        vars: { GROQ_API_KEY: "gsk-..." },
      },
    }
    ```

    See [/environment](/help/environment) for full precedence and sources.

  </Accordion>

  <Accordion title="I started the Gateway via the service and my env vars disappeared. What now?">
    Two common fixes:

    1. Put the missing keys in `~/.openclaw/.env` so they're picked up even when the service doesn't inherit your shell env.
    2. Enable shell import (opt-in convenience):

    ```json5
    {
      env: {
        shellEnv: {
          enabled: true,
          timeoutMs: 15000,
        },
      },
    }
    ```

    This runs your login shell and imports only missing expected keys (never overrides). Env var equivalents:
    `OPENCLAW_LOAD_SHELL_ENV=1`, `OPENCLAW_SHELL_ENV_TIMEOUT_MS=15000`.

  </Accordion>

  <Accordion title='I set COPILOT_GITHUB_TOKEN, but models status shows "Shell env: off." Why?'>
    `openclaw models status` reports whether **shell env import** is enabled. "Shell env: off"
    does **not** mean your env vars are missing - it just means OpenClaw won't load
    your login shell automatically.

    If the Gateway runs as a service (launchd/systemd), it won't inherit your shell
    environment. Fix by doing one of these:

    1. Put the token in `~/.openclaw/.env`:

       ```
       COPILOT_GITHUB_TOKEN=...
       ```

    2. Or enable shell import (`env.shellEnv.enabled: true`).
    3. Or add it to your config `env` block (applies only if missing).

    Then restart the gateway and recheck:

    ```bash
    openclaw models status
    ```

    Copilot tokens are read from `COPILOT_GITHUB_TOKEN` (also `GH_TOKEN` / `GITHUB_TOKEN`).
    See [/concepts/model-providers](/concepts/model-providers) and [/environment](/help/environment).

  </Accordion>
</AccordionGroup>

## Sessions and multiple chats

<AccordionGroup>
  <Accordion title="How do I start a fresh conversation?">
    Send `/new` or `/reset` as a standalone message. See [Session management](/concepts/session).
  </Accordion>

  <Accordion title="Do sessions reset automatically if I never send /new?">
    Sessions can expire after `session.idleMinutes`, but this is **disabled by default** (default **0**).
    Set it to a positive value to enable idle expiry. When enabled, the **next**
    message after the idle period starts a fresh session id for that chat key.
    This does not delete transcripts - it just starts a new session.

    ```json5
    {
      session: {
        idleMinutes: 240,
      },
    }
    ```

  </Accordion>

  <Accordion title="Is there a way to make a team of OpenClaw instances (one CEO and many agents)?">
    Yes, via **multi-agent routing** and **sub-agents**. You can create one coordinator
    agent and several worker agents with their own workspaces and models.

    That said, this is best seen as a **fun experiment**. It is token heavy and often
    less efficient than using one bot with separate sessions. The typical model we
    envision is one bot you talk to, with different sessions for parallel work. That
    bot can also spawn sub-agents when needed.

    Docs: [Multi-agent routing](/concepts/multi-agent), [Sub-agents](/tools/subagents), [Agents CLI](/cli/agents).

  </Accordion>

  <Accordion title="Why did context get truncated mid-task? How do I prevent it?">
    Session context is limited by the model window. Long chats, large tool outputs, or many
    files can trigger compaction or truncation.

    What helps:

    - Ask the bot to summarize the current state and write it to a file.
    - Use `/compact` before long tasks, and `/new` when switching topics.
    - Keep important context in the workspace and ask the bot to read it back.
    - Use sub-agents for long or parallel work so the main chat stays smaller.
    - Pick a model with a larger context window if this happens often.

  </Accordion>

  <Accordion title="How do I completely reset OpenClaw but keep it installed?">
    Use the reset command:

    ```bash
    openclaw reset
    ```

    Non-interactive full reset:

    ```bash
    openclaw reset --scope full --yes --non-interactive
    ```

    Then re-run setup:

    ```bash
    openclaw onboard --install-daemon
    ```

    Notes:

    - Onboarding also offers **Reset** if it sees an existing config. See [Onboarding (CLI)](/start/wizard).
    - If you used profiles (`--profile` / `OPENCLAW_PROFILE`), reset each state dir (defaults are `~/.openclaw-<profile>`).
    - Dev reset: `openclaw gateway --dev --reset` (dev-only; wipes dev config + credentials + sessions + workspace).

  </Accordion>

  <Accordion title='I am getting "context too large" errors - how do I reset or compact?'>
    Use one of these:

    - **Compact** (keeps the conversation but summarizes older turns):

      ```
      /compact
      ```

      or `/compact <instructions>` to guide the summary.

    - **Reset** (fresh session ID for the same chat key):

      ```
      /new
      /reset
      ```

    If it keeps happening:

    - Enable or tune **session pruning** (`agents.defaults.contextPruning`) to trim old tool output.
    - Use a model with a larger context window.

    Docs: [Compaction](/concepts/compaction), [Session pruning](/concepts/session-pruning), [Session management](/concepts/session).

  </Accordion>

  <Accordion title='Why am I seeing "LLM request rejected: messages.content.tool_use.input field required"?'>
    This is a provider validation error: the model emitted a `tool_use` block without the required
    `input`. It usually means the session history is stale or corrupted (often after long threads
    or a tool/schema change).

    Fix: start a fresh session with `/new` (standalone message).

  </Accordion>

  <Accordion title="Why am I getting heartbeat messages every 30 minutes?">
    Heartbeats run every **30m** by default (**1h** when using OAuth auth). Tune or disable them:

    ```json5
    {
      agents: {
        defaults: {
          heartbeat: {
            every: "2h", // or "0m" to disable
          },
        },
      },
    }
    ```

    If `HEARTBEAT.md` exists but is effectively empty (only blank lines and markdown
    headers like `# Heading`), OpenClaw skips the heartbeat run to save API calls.
    If the file is missing, the heartbeat still runs and the model decides what to do.

    Per-agent overrides use `agents.list[].heartbeat`. Docs: [Heartbeat](/gateway/heartbeat).

  </Accordion>

  <Accordion title='Do I need to add a "bot account" to a WhatsApp group?'>
    No. OpenClaw runs on **your own account**, so if you're in the group, OpenClaw can see it.
    By default, group replies are blocked until you allow senders (`groupPolicy: "allowlist"`).

    If you want only **you** to be able to trigger group replies:

    ```json5
    {
      channels: {
        whatsapp: {
          groupPolicy: "allowlist",
          groupAllowFrom: ["+15551234567"],
        },
      },
    }
    ```

  </Accordion>

  <Accordion title="How do I get the JID of a WhatsApp group?">
    Option 1 (fastest): tail logs and send a test message in the group:

    ```bash
    openclaw logs --follow --json
    ```

    Look for `chatId` (or `from`) ending in `@g.us`, like:
    `1234567890-1234567890@g.us`.

    Option 2 (if already configured/allowlisted): list groups from config:

    ```bash
    openclaw directory groups list --channel whatsapp
    ```

    Docs: [WhatsApp](/channels/whatsapp), [Directory](/cli/directory), [Logs](/cli/logs).

  </Accordion>

  <Accordion title="Why does OpenClaw not reply in a group?">
    Two common causes:

    - Mention gating is on (default). You must @mention the bot (or match `mentionPatterns`).
    - You configured `channels.whatsapp.groups` without `"*"` and the group isn't allowlisted.

    See [Groups](/channels/groups) and [Group messages](/channels/group-messages).

  </Accordion>

  <Accordion title="Do groups/threads share context with DMs?">
    Direct chats collapse to the main session by default. Groups/channels have their own session keys, and Telegram topics / Discord threads are separate sessions. See [Groups](/channels/groups) and [Group messages](/channels/group-messages).
  </Accordion>

  <Accordion title="How many workspaces and agents can I create?">
    No hard limits. Dozens (even hundreds) are fine, but watch for:

    - **Disk growth:** sessions + transcripts live under `~/.openclaw/agents/<agentId>/sessions/`.
    - **Token cost:** more agents means more concurrent model usage.
    - **Ops overhead:** per-agent auth profiles, workspaces, and channel routing.

    Tips:

    - Keep one **active** workspace per agent (`agents.defaults.workspace`).
    - Prune old sessions (delete JSONL or store entries) if disk grows.
    - Use `openclaw doctor` to spot stray workspaces and profile mismatches.

  </Accordion>

  <Accordion title="Can I run multiple bots or chats at the same time (Slack), and how should I set that up?">
    Yes. Use **Multi-Agent Routing** to run multiple isolated agents and route inbound messages by
    channel/account/peer. Slack is supported as a channel and can be bound to specific agents.

    Browser access is powerful but not "do anything a human can" - anti-bot, CAPTCHAs, and MFA can
    still block automation. For the most reliable browser control, use local Chrome MCP on the host,
    or use CDP on the machine that actually runs the browser.

    Best-practice setup:

    - Always-on Gateway host (VPS/Mac mini).
    - One agent per role (bindings).
    - Slack channel(s) bound to those agents.
    - Local browser via Chrome MCP or a node when needed.

    Docs: [Multi-Agent Routing](/concepts/multi-agent), [Slack](/channels/slack),
    [Browser](/tools/browser), [Nodes](/nodes).

  </Accordion>
</AccordionGroup>

## Models, failover, and auth profiles

Model Q&A — defaults, selection, aliases, switching, failover, auth profiles —
lives on the [Models FAQ](/help/faq-models).

## Gateway: ports, "already running", and remote mode

<AccordionGroup>
  <Accordion title="What port does the Gateway use?">
    `gateway.port` controls the single multiplexed port for WebSocket + HTTP (Control UI, hooks, etc.).

    Precedence:

    ```
    --port > OPENCLAW_GATEWAY_PORT > gateway.port > default 18789
    ```

  </Accordion>

  <Accordion title='Why does openclaw gateway status say "Runtime: running" but "Connectivity probe: failed"?'>
    Because "running" is the **supervisor's** view (launchd/systemd/schtasks). The connectivity probe is the CLI actually connecting to the gateway WebSocket.

    Use `openclaw gateway status` and trust these lines:

    - `Probe target:` (the URL the probe actually used)
    - `Listening:` (what's actually bound on the port)
    - `Last gateway error:` (common root cause when the process is alive but the port isn't listening)

  </Accordion>

  <Accordion title='Why does openclaw gateway status show "Config (cli)" and "Config (service)" different?'>
    You're editing one config file while the service is running another (often a `--profile` / `OPENCLAW_STATE_DIR` mismatch).

    Fix:

    ```bash
    openclaw gateway install --force
    ```

    Run that from the same `--profile` / environment you want the service to use.

  </Accordion>

  <Accordion title='What does "another gateway instance is already listening" mean?'>
    OpenClaw enforces a runtime lock by binding the WebSocket listener immediately on startup (default `ws://127.0.0.1:18789`). If the bind fails with `EADDRINUSE`, it throws `GatewayLockError` indicating another instance is already listening.

    Fix: stop the other instance, free the port, or run with `openclaw gateway --port <port>`.

  </Accordion>

  <Accordion title="How do I run OpenClaw in remote mode (client connects to a Gateway elsewhere)?">
    Set `gateway.mode: "remote"` and point to a remote WebSocket URL, optionally with shared-secret remote credentials:

    ```json5
    {
      gateway: {
        mode: "remote",
        remote: {
          url: "ws://gateway.tailnet:18789",
          token: "your-token",
          password: "your-password",
        },
      },
    }
    ```

    Notes:

    - `openclaw gateway` only starts when `gateway.mode` is `local` (or you pass the override flag).
    - The macOS app watches the config file and switches modes live when these values change.
    - `gateway.remote.token` / `.password` are client-side remote credentials only; they do not enable local gateway auth by themselves.

  </Accordion>

  <Accordion title='The Control UI says "unauthorized" (or keeps reconnecting). What now?'>
    Your gateway auth path and the UI's auth method do not match.

    Facts (from code):

    - The Control UI keeps the token in `sessionStorage` for the current browser tab session and selected gateway URL, so same-tab refreshes keep working without restoring long-lived localStorage token persistence.
    - On `AUTH_TOKEN_MISMATCH`, trusted clients can attempt one bounded retry with a cached device token when the gateway returns retry hints (`canRetryWithDeviceToken=true`, `recommendedNextStep=retry_with_device_token`).
    - That cached-token retry now reuses the cached approved scopes stored with the device token. Explicit `deviceToken` / explicit `scopes` callers still keep their requested scope set instead of inheriting cached scopes.
    - Outside that retry path, connect auth precedence is explicit shared token/password first, then explicit `deviceToken`, then stored device token, then bootstrap token.
    - Bootstrap token scope checks are role-prefixed. The built-in bootstrap operator allowlist only satisfies operator requests; node or other non-operator roles still need scopes under their own role prefix.

    Fix:

    - Fastest: `openclaw dashboard` (prints + copies the dashboard URL, tries to open; shows SSH hint if headless).
    - If you don't have a token yet: `openclaw doctor --generate-gateway-token`.
    - If remote, tunnel first: `ssh -N -L 18789:127.0.0.1:18789 user@host` then open `http://127.0.0.1:18789/`.
    - Shared-secret mode: set `gateway.auth.token` / `OPENCLAW_GATEWAY_TOKEN` or `gateway.auth.password` / `OPENCLAW_GATEWAY_PASSWORD`, then paste the matching secret in Control UI settings.
    - Tailscale Serve mode: make sure `gateway.auth.allowTailscale` is enabled and you are opening the Serve URL, not a raw loopback/tailnet URL that bypasses Tailscale identity headers.
    - Trusted-proxy mode: make sure you are coming through the configured identity-aware proxy, not a raw gateway URL. Same-host loopback proxies also need `gateway.auth.trustedProxy.allowLoopback = true`.
    - If mismatch persists after the one retry, rotate/re-approve the paired device token:
      - `openclaw devices list`
      - `openclaw devices rotate --device <id> --role operator`
    - If that rotate call says it was denied, check two things:
      - paired-device sessions can rotate only their **own** device unless they also have `operator.admin`
      - explicit `--scope` values cannot exceed the caller's current operator scopes
    - Still stuck? Run `openclaw status --all` and follow [Troubleshooting](/gateway/troubleshooting). See [Dashboard](/web/dashboard) for auth details.

  </Accordion>

  <Accordion title="I set gateway.bind tailnet but it cannot bind and nothing listens">
    `tailnet` bind picks a Tailscale IP from your network interfaces (100.64.0.0/10). If the machine isn't on Tailscale (or the interface is down), there's nothing to bind to.

    Fix:

    - Start Tailscale on that host (so it has a 100.x address), or
    - Switch to `gateway.bind: "loopback"` / `"lan"`.

    Note: `tailnet` is explicit. `auto` prefers loopback; use `gateway.bind: "tailnet"` when you want a tailnet-only bind.

  </Accordion>

  <Accordion title="Can I run multiple Gateways on the same host?">
    Usually no - one Gateway can run multiple messaging channels and agents. Use multiple Gateways only when you need redundancy (ex: rescue bot) or hard isolation.

    Yes, but you must isolate:

    - `OPENCLAW_CONFIG_PATH` (per-instance config)
    - `OPENCLAW_STATE_DIR` (per-instance state)
    - `agents.defaults.workspace` (workspace isolation)
    - `gateway.port` (unique ports)

    Quick setup (recommended):

    - Use `openclaw --profile <name> ...` per instance (auto-creates `~/.openclaw-<name>`).
    - Set a unique `gateway.port` in each profile config (or pass `--port` for manual runs).
    - Install a per-profile service: `openclaw --profile <name> gateway install`.

    Profiles also suffix service names (`ai.openclaw.<profile>`; legacy `com.openclaw.*`, `openclaw-gateway-<profile>.service`, `OpenClaw Gateway (<profile>)`).
    Full guide: [Multiple gateways](/gateway/multiple-gateways).

  </Accordion>

  <Accordion title='What does "invalid handshake" / code 1008 mean?'>
    The Gateway is a **WebSocket server**, and it expects the very first message to
    be a `connect` frame. If it receives anything else, it closes the connection
    with **code 1008** (policy violation).

    Common causes:

    - You opened the **HTTP** URL in a browser (`http://...`) instead of a WS client.
    - You used the wrong port or path.
    - A proxy or tunnel stripped auth headers or sent a non-Gateway request.

    Quick fixes:

    1. Use the WS URL: `ws://<host>:18789` (or `wss://...` if HTTPS).
    2. Don't open the WS port in a normal browser tab.
    3. If auth is on, include the token/password in the `connect` frame.

    If you're using the CLI or TUI, the URL should look like:

    ```
    openclaw tui --url ws://<host>:18789 --token <token>
    ```

    Protocol details: [Gateway protocol](/gateway/protocol).

  </Accordion>
</AccordionGroup>

## Logging and debugging

<AccordionGroup>
  <Accordion title="Where are logs?">
    File logs (structured):

    ```
    /tmp/openclaw/openclaw-YYYY-MM-DD.log
    ```

    You can set a stable path via `logging.file`. File log level is controlled by `logging.level`. Console verbosity is controlled by `--verbose` and `logging.consoleLevel`.

    Fastest log tail:

    ```bash
    openclaw logs --follow
    ```

    Service/supervisor logs (when the gateway runs via launchd/systemd):

    - macOS: `$OPENCLAW_STATE_DIR/logs/gateway.log` and `gateway.err.log` (default: `~/.openclaw/logs/...`; profiles use `~/.openclaw-<profile>/logs/...`)
    - Linux: `journalctl --user -u openclaw-gateway[-<profile>].service -n 200 --no-pager`
    - Windows: `schtasks /Query /TN "OpenClaw Gateway (<profile>)" /V /FO LIST`

    See [Troubleshooting](/gateway/troubleshooting) for more.

  </Accordion>

  <Accordion title="How do I start/stop/restart the Gateway service?">
    Use the gateway helpers:

    ```bash
    openclaw gateway status
    openclaw gateway restart
    ```

    If you run the gateway manually, `openclaw gateway --force` can reclaim the port. See [Gateway](/gateway).

  </Accordion>

  <Accordion title="I closed my terminal on Windows - how do I restart OpenClaw?">
    There are **two Windows install modes**:

    **1) WSL2 (recommended):** the Gateway runs inside Linux.

    Open PowerShell, enter WSL, then restart:

    ```powershell
    wsl
    openclaw gateway status
    openclaw gateway restart
    ```

    If you never installed the service, start it in the foreground:

    ```bash
    openclaw gateway run
    ```

    **2) Native Windows (not recommended):** the Gateway runs directly in Windows.

    Open PowerShell and run:

    ```powershell
    openclaw gateway status
    openclaw gateway restart
    ```

    If you run it manually (no service), use:

    ```powershell
    openclaw gateway run
    ```

    Docs: [Windows (WSL2)](/platforms/windows), [Gateway service runbook](/gateway).

  </Accordion>

  <Accordion title="The Gateway is up but replies never arrive. What should I check?">
    Start with a quick health sweep:

    ```bash
    openclaw status
    openclaw models status
    openclaw channels status
    openclaw logs --follow
    ```

    Common causes:

    - Model auth not loaded on the **gateway host** (check `models status`).
    - Channel pairing/allowlist blocking replies (check channel config + logs).
    - WebChat/Dashboard is open without the right token.

    If you are remote, confirm the tunnel/Tailscale connection is up and that the
    Gateway WebSocket is reachable.

    Docs: [Channels](/channels), [Troubleshooting](/gateway/troubleshooting), [Remote access](/gateway/remote).

  </Accordion>

  <Accordion title='"Disconnected from gateway: no reason" - what now?'>
    This usually means the UI lost the WebSocket connection. Check:

    1. Is the Gateway running? `openclaw gateway status`
    2. Is the Gateway healthy? `openclaw status`
    3. Does the UI have the right token? `openclaw dashboard`
    4. If remote, is the tunnel/Tailscale link up?

    Then tail logs:

    ```bash
    openclaw logs --follow
    ```

    Docs: [Dashboard](/web/dashboard), [Remote access](/gateway/remote), [Troubleshooting](/gateway/troubleshooting).

  </Accordion>

  <Accordion title="Telegram setMyCommands fails. What should I check?">
    Start with logs and channel status:

    ```bash
    openclaw channels status
    openclaw channels logs --channel telegram
    ```

    Then match the error:

    - `BOT_COMMANDS_TOO_MUCH`: the Telegram menu has too many entries. OpenClaw already trims to the Telegram limit and retries with fewer commands, but some menu entries still need to be dropped. Reduce plugin/skill/custom commands, or disable `channels.telegram.commands.native` if you do not need the menu.
    - `TypeError: fetch failed`, `Network request for 'setMyCommands' failed!`, or similar network errors: if you are on a VPS or behind a proxy, confirm outbound HTTPS is allowed and DNS works for `api.telegram.org`.

    If the Gateway is remote, make sure you are looking at logs on the Gateway host.

    Docs: [Telegram](/channels/telegram), [Channel troubleshooting](/channels/troubleshooting).

  </Accordion>

  <Accordion title="TUI shows no output. What should I check?">
    First confirm the Gateway is reachable and the agent can run:

    ```bash
    openclaw status
    openclaw models status
    openclaw logs --follow
    ```

    In the TUI, use `/status` to see the current state. If you expect replies in a chat
    channel, make sure delivery is enabled (`/deliver on`).

    Docs: [TUI](/web/tui), [Slash commands](/tools/slash-commands).

  </Accordion>

  <Accordion title="How do I completely stop then start the Gateway?">
    If you installed the service:

    ```bash
    openclaw gateway stop
    openclaw gateway start
    ```

    This stops/starts the **supervised service** (launchd on macOS, systemd on Linux).
    Use this when the Gateway runs in the background as a daemon.

    If you're running in the foreground, stop with Ctrl-C, then:

    ```bash
    openclaw gateway run
    ```

    Docs: [Gateway service runbook](/gateway).

  </Accordion>

  <Accordion title="ELI5: openclaw gateway restart vs openclaw gateway">
    - `openclaw gateway restart`: restarts the **background service** (launchd/systemd).
    - `openclaw gateway`: runs the gateway **in the foreground** for this terminal session.

    If you installed the service, use the gateway commands. Use `openclaw gateway` when
    you want a one-off, foreground run.

  </Accordion>

  <Accordion title="Fastest way to get more details when something fails">
    Start the Gateway with `--verbose` to get more console detail. Then inspect the log file for channel auth, model routing, and RPC errors.
  </Accordion>
</AccordionGroup>

## Media and attachments

<AccordionGroup>
  <Accordion title="My skill generated an image/PDF, but nothing was sent">
    Outbound attachments from the agent must include a `MEDIA:<path-or-url>` line (on its own line). See [OpenClaw assistant setup](/start/openclaw) and [Agent send](/tools/agent-send).

    CLI sending:

    ```bash
    openclaw message send --target +15555550123 --message "Here you go" --media /path/to/file.png
    ```

    Also check:

    - The target channel supports outbound media and isn't blocked by allowlists.
    - The file is within the provider's size limits (images are resized to max 2048px).
    - `tools.fs.workspaceOnly=true` keeps local-path sends limited to workspace, temp/media-store, and sandbox-validated files.
    - `tools.fs.workspaceOnly=false` lets `MEDIA:` send host-local files the agent can already read, but only for media plus safe document types (images, audio, video, PDF, and Office docs). Plain text and secret-like files are still blocked.

    See [Images](/nodes/images).

  </Accordion>
</AccordionGroup>

## Security and access control

<AccordionGroup>
  <Accordion title="Is it safe to expose OpenClaw to inbound DMs?">
    Treat inbound DMs as untrusted input. Defaults are designed to reduce risk:

    - Default behavior on DM-capable channels is **pairing**:
      - Unknown senders receive a pairing code; the bot does not process their message.
      - Approve with: `openclaw pairing approve --channel <channel> [--account <id>] <code>`
      - Pending requests are capped at **3 per channel**; check `openclaw pairing list --channel <channel> [--account <id>]` if a code didn't arrive.
    - Opening DMs publicly requires explicit opt-in (`dmPolicy: "open"` and allowlist `"*"`).

    Run `openclaw doctor` to surface risky DM policies.

  </Accordion>

  <Accordion title="Is prompt injection only a concern for public bots?">
    No. Prompt injection is about **untrusted content**, not just who can DM the bot.
    If your assistant reads external content (web search/fetch, browser pages, emails,
    docs, attachments, pasted logs), that content can include instructions that try
    to hijack the model. This can happen even if **you are the only sender**.

    The biggest risk is when tools are enabled: the model can be tricked into
    exfiltrating context or calling tools on your behalf. Reduce the blast radius by:

    - using a read-only or tool-disabled "reader" agent to summarize untrusted content
    - keeping `web_search` / `web_fetch` / `browser` off for tool-enabled agents
    - treating decoded file/document text as untrusted too: OpenResponses
      `input_file` and media-attachment extraction both wrap extracted text in
      explicit external-content boundary markers instead of passing raw file text
    - sandboxing and strict tool allowlists

    Details: [Security](/gateway/security).

  </Accordion>

  <Accordion title="Should my bot have its own email, GitHub account, or phone number?">
    Yes, for most setups. Isolating the bot with separate accounts and phone numbers
    reduces the blast radius if something goes wrong. This also makes it easier to rotate
    credentials or revoke access without impacting your personal accounts.

    Start small. Give access only to the tools and accounts you actually need, and expand
    later if required.

    Docs: [Security](/gateway/security), [Pairing](/channels/pairing).

  </Accordion>

  <Accordion title="Can I give it autonomy over my text messages and is that safe?">
    We do **not** recommend full autonomy over your personal messages. The safest pattern is:

    - Keep DMs in **pairing mode** or a tight allowlist.
    - Use a **separate number or account** if you want it to message on your behalf.
    - Let it draft, then **approve before sending**.

    If you want to experiment, do it on a dedicated account and keep it isolated. See
    [Security](/gateway/security).

  </Accordion>

  <Accordion title="Can I use cheaper models for personal assistant tasks?">
    Yes, **if** the agent is chat-only and the input is trusted. Smaller tiers are
    more susceptible to instruction hijacking, so avoid them for tool-enabled agents
    or when reading untrusted content. If you must use a smaller model, lock down
    tools and run inside a sandbox. See [Security](/gateway/security).
  </Accordion>

  <Accordion title="I ran /start in Telegram but did not get a pairing code">
    Pairing codes are sent **only** when an unknown sender messages the bot and
    `dmPolicy: "pairing"` is enabled. `/start` by itself doesn't generate a code.

    Check pending requests:

    ```bash
    openclaw pairing list telegram
    ```

    If you want immediate access, allowlist your sender id or set `dmPolicy: "open"`
    for that account.

  </Accordion>

  <Accordion title="WhatsApp: will it message my contacts? How does pairing work?">
    No. Default WhatsApp DM policy is **pairing**. Unknown senders only get a pairing code and their message is **not processed**. OpenClaw only replies to chats it receives or to explicit sends you trigger.

    Approve pairing with:

    ```bash
    openclaw pairing approve whatsapp <code>
    ```

    List pending requests:

    ```bash
    openclaw pairing list whatsapp
    ```

    Wizard phone number prompt: it's used to set your **allowlist/owner** so your own DMs are permitted. It's not used for auto-sending. If you run on your personal WhatsApp number, use that number and enable `channels.whatsapp.selfChatMode`.

  </Accordion>
</AccordionGroup>

## Chat commands, aborting tasks, and "it will not stop"

<AccordionGroup>
  <Accordion title="How do I stop internal system messages from showing in chat?">
    Most internal or tool messages only appear when **verbose**, **trace**, or **reasoning** is enabled
    for that session.

    Fix in the chat where you see it:

    ```
    /verbose off
    /trace off
    /reasoning off
    ```

    If it is still noisy, check the session settings in the Control UI and set verbose
    to **inherit**. Also confirm you are not using a bot profile with `verboseDefault` set
    to `on` in config.

    Docs: [Thinking and verbose](/tools/thinking), [Security](/gateway/security/index#reasoning-and-verbose-output-in-groups).

  </Accordion>

  <Accordion title="How do I stop/cancel a running task?">
    Send any of these **as a standalone message** (no slash):

    ```
    stop
    stop action
    stop current action
    stop run
    stop current run
    stop agent
    stop the agent
    stop openclaw
    openclaw stop
    stop don't do anything
    stop do not do anything
    stop doing anything
    please stop
    stop please
    abort
    esc
    wait
    exit
    interrupt
    ```

    These are abort triggers (not slash commands).

    For background processes (from the exec tool), you can ask the agent to run:

    ```
    process action:kill sessionId:XXX
    ```

    Slash commands overview: see [Slash commands](/tools/slash-commands).

    Most commands must be sent as a **standalone** message that starts with `/`, but a few shortcuts (like `/status`) also work inline for allowlisted senders.

  </Accordion>

  <Accordion title='How do I send a Discord message from Telegram? ("Cross-context messaging denied")'>
    OpenClaw blocks **cross-provider** messaging by default. If a tool call is bound
    to Telegram, it won't send to Discord unless you explicitly allow it.

    Enable cross-provider messaging for the agent:

    ```json5
    {
      tools: {
        message: {
          crossContext: {
            allowAcrossProviders: true,
            marker: { enabled: true, prefix: "[from {channel}] " },
          },
        },
      },
    }
    ```

    Restart the gateway after editing config.

  </Accordion>

  <Accordion title='Why does it feel like the bot "ignores" rapid-fire messages?'>
    Queue mode controls how new messages interact with an in-flight run. Use `/queue` to change modes:

    - `steer` - queue all pending steering for the next model boundary in the current run
    - `queue` - legacy one-at-a-time steering
    - `followup` - run messages one at a time
    - `collect` - batch messages and reply once
    - `steer-backlog` - steer now, then process backlog
    - `interrupt` - abort current run and start fresh

    Default mode is `steer`. You can add options like `debounce:0.5s cap:25 drop:summarize` for followup modes. See [Command queue](/concepts/queue) and [Steering queue](/concepts/queue-steering).

  </Accordion>
</AccordionGroup>

## Miscellaneous

<AccordionGroup>
  <Accordion title='What is the default model for Anthropic with an API key?'>
    In OpenClaw, credentials and model selection are separate. Setting `ANTHROPIC_API_KEY` (or storing an Anthropic API key in auth profiles) enables authentication, but the actual default model is whatever you configure in `agents.defaults.model.primary` (for example, `anthropic/claude-sonnet-4-6` or `anthropic/claude-opus-4-6`). If you see `No credentials found for profile "anthropic:default"`, it means the Gateway couldn't find Anthropic credentials in the expected `auth-profiles.json` for the agent that's running.
  </Accordion>
</AccordionGroup>

---

Still stuck? Ask in [Discord](https://discord.com/invite/clawd) or open a [GitHub discussion](https://github.com/openclaw/openclaw/discussions).

## Related

- [First-run FAQ](/help/faq-first-run) — install, onboard, auth, subscriptions, early failures
- [Models FAQ](/help/faq-models) — model selection, failover, auth profiles
- [Troubleshooting](/help/troubleshooting) — symptom-first triage
