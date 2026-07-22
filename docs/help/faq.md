---
summary: "Frequently asked questions about OpenClaw setup, configuration, and usage"
read_when:
  - Answering common setup, install, onboarding, or runtime support questions
  - Triaging user-reported issues before deeper debugging
title: "FAQ"
---

Quick answers plus deeper troubleshooting for real-world setups (local dev, VPS, multi-agent, OAuth/API keys, model failover). For runtime diagnostics, see [Troubleshooting](/gateway/troubleshooting). For the full config reference, see [Configuration](/gateway/configuration).

## First 60 seconds if something is broken

<Steps>
  <Step title="Quick status">
    ```bash
    openclaw status
    ```
    Fast local summary: OS + update, gateway/service reachability, agents/sessions, provider config + runtime issues (when the gateway is reachable).
  </Step>
  <Step title="Pasteable report (safe to share)">
    ```bash
    openclaw status --all
    ```
    Read-only diagnosis with a log tail (tokens redacted).
  </Step>
  <Step title="Daemon + port state">
    ```bash
    openclaw gateway status
    ```
    Shows supervisor runtime vs RPC reachability, the probe target URL, and which config the service likely used.
  </Step>
  <Step title="Deep probes">
    ```bash
    openclaw status --deep
    ```
    Live gateway health probe, including channel probes when supported (requires a reachable gateway). See [Health](/gateway/health).
  </Step>
  <Step title="Tail the latest log">
    ```bash
    openclaw logs --follow
    ```
    If RPC is down, fall back to:
    ```bash
    tail -f "$(ls -t /tmp/openclaw/openclaw-*.log | head -1)"
    ```
    File logs are separate from service logs; see [Logging](/logging) and [Troubleshooting](/gateway/troubleshooting).
  </Step>
  <Step title="Run the doctor (repairs)">
    ```bash
    openclaw doctor
    ```
    Repairs/migrates config and state, then runs health checks. See [Doctor](/gateway/doctor).
  </Step>
  <Step title="Gateway snapshot (WS-only)">
    ```bash
    openclaw health --json
    openclaw health --verbose   # shows the target URL + config path on errors
    ```
    Asks the running gateway for a full snapshot. See [Health](/gateway/health).
  </Step>
</Steps>

## Quick start and first-run setup

First-run Q&A - install, onboard, auth routes, subscriptions, initial failures - lives on the [First-run FAQ](/help/faq-first-run).

## What is OpenClaw?

<AccordionGroup>
  <Accordion title="What is OpenClaw, in one paragraph?">
    OpenClaw is a personal AI assistant you run on your own devices. It replies on the messaging surfaces you already use (Discord, Google Chat, iMessage, Mattermost, Signal, Slack, Telegram, WebChat, WhatsApp, and bundled channel plugins such as QQ Bot) and can also do voice plus a live Canvas on supported platforms. The **Gateway** is the always-on control plane; the assistant is the product.
  </Accordion>

  <Accordion title="Value proposition">
    OpenClaw is not "just a Claude wrapper." It is a **local-first control plane** that runs a capable assistant on **your own hardware**, reachable from the chat apps you already use, with stateful sessions, memory, and tools - without handing your workflows to a hosted SaaS.

    - **Your devices, your data**: run the Gateway wherever you want (Mac, Linux, VPS) and keep the workspace and session history local.
    - **Real channels, not a web sandbox**: Discord/iMessage/Signal/Slack/Telegram/WhatsApp/etc, plus mobile voice and Canvas on supported platforms.
    - **Model-agnostic**: use Anthropic, MiniMax, OpenAI, OpenRouter, etc., with per-agent routing and failover.
    - **Local-only option**: run local models so all data can stay on your device.
    - **Multi-agent routing**: separate agents per channel, account, or task, each with its own workspace and defaults.
    - **Open source and hackable**: inspect, extend, and self-host without vendor lock-in.

    Docs: [Gateway](/gateway), [Channels](/channels), [Multi-agent](/concepts/multi-agent), [Memory](/concepts/memory).

  </Accordion>

  <Accordion title="I just set it up - what should I do first?">
    Good first projects: build a website (WordPress, Shopify, or a static site); prototype a mobile app (outline, screens, API plan); organize files and folders; connect Gmail and automate summaries or follow-ups.

    It can handle large tasks, but works best split into phases with sub-agents for parallel work.

  </Accordion>

  <Accordion title="What are the top five everyday use cases for OpenClaw?">
    - **Personal briefings**: summaries of inbox, calendar, and news you care about.
    - **Research and drafting**: quick research, summaries, and first drafts for emails or docs.
    - **Reminders and follow-ups**: cron- or heartbeat-driven nudges and checklists.
    - **Browser automation**: filling forms, collecting data, repeating web tasks.
    - **Cross-device coordination**: send a task from your phone, let the Gateway run it on a server, get the result back in chat.

  </Accordion>

  <Accordion title="Can OpenClaw help with lead gen, outreach, ads, and blogs for a SaaS?">
    Yes, for **research, qualification, and drafting**: scanning sites, building shortlists, summarizing prospects, writing outreach or ad copy drafts.

    For **outreach or ad runs**, keep a human in the loop. Avoid spam, follow local laws and platform policies, and review anything before it sends. Let OpenClaw draft; you approve.

    Docs: [Security](/gateway/security).

  </Accordion>

  <Accordion title="What are the advantages vs Claude Code for web development?">
    OpenClaw is a **personal assistant** and coordination layer, not an IDE replacement. Use Claude Code or Codex for the fastest direct coding loop inside a repo. Use OpenClaw for durable memory, cross-device access, and tool orchestration.

    - Persistent memory and workspace across sessions.
    - Multi-platform access (Telegram, WhatsApp, TUI, WebChat).
    - Tool orchestration (browser, files, scheduling, hooks).
    - Always-on Gateway (run on a VPS, interact from anywhere).
    - Nodes for local browser/screen/camera/exec.

    Showcase: [https://openclaw.ai/showcase](https://openclaw.ai/showcase).

  </Accordion>
</AccordionGroup>

## Skills and automation

<AccordionGroup>
  <Accordion title="How do I customize skills without keeping the repo dirty?">
    Use managed overrides instead of editing the repo copy. Put changes in `~/.openclaw/skills/<name>/SKILL.md` (or add a folder via `skills.load.extraDirs` in `~/.openclaw/openclaw.json`). Precedence: `<workspace>/skills` -> `<workspace>/.agents/skills` -> `~/.agents/skills` -> `~/.openclaw/skills` -> bundled -> `skills.load.extraDirs`, so managed overrides win over bundled skills without touching git. To install globally but limit visibility to some agents, keep the shared copy in `~/.openclaw/skills` and control visibility with `agents.defaults.skills` / `agents.entries.*.skills`. Only upstream-worthy edits should go out as PRs against the repo copy.
  </Accordion>

  <Accordion title="Can I load skills from a custom folder?">
    Yes: add directories via `skills.load.extraDirs` in `~/.openclaw/openclaw.json` (lowest precedence in the order above). `clawhub` installs into `./skills` by default, which OpenClaw treats as `<workspace>/skills` on the next session. To limit visibility to certain agents, pair with `agents.defaults.skills` or `agents.entries.*.skills`.
  </Accordion>

  <Accordion title="How can I use different models or settings for different tasks?">
    Supported patterns:

    - **Cron jobs**: isolated jobs can set a `model` override per job.
    - **Agents**: route tasks to separate agents with different default models, thinking levels, and stream params.
    - **On-demand switch**: `/model` switches the current session model at any time.

    Example - same model, different per-agent settings:

    ```json5
    {
      agents: {
        list: [
          {
            id: "coder",
            model: "xiaomi/mimo-v2.5-pro",
            thinkingDefault: "high",
            params: { temperature: 0.1 },
          },
          {
            id: "chat",
            model: "xiaomi/mimo-v2.5-pro",
            thinkingDefault: "off",
            params: { temperature: 0.8 },
          },
        ],
      },
    }
    ```

    Put shared per-model defaults in `agents.defaults.models["provider/model"].params`, then agent-specific overrides in flat `agents.entries.*.params`. Do not duplicate the same model under nested `agents.entries.*.models["provider/model"].params`; that path is for per-agent model catalog and runtime overrides.

    See [Cron jobs](/automation/cron-jobs), [Multi-Agent Routing](/concepts/multi-agent), [Configuration](/gateway/config-agents), [Slash commands](/tools/slash-commands).

  </Accordion>

  <Accordion title="The bot freezes while doing heavy work. How do I offload that?">
    Use **sub-agents** for long or parallel tasks: they run in their own session, return a summary, and keep your main chat responsive. Ask the bot to "spawn a sub-agent for this task," or use `/subagents`. Use `/status` to see whether the Gateway is currently busy.

    Long tasks and sub-agents both consume tokens; set a cheaper model for sub-agents via `agents.defaults.subagents.model` if cost matters.

    Docs: [Sub-agents](/tools/subagents), [Background Tasks](/automation/tasks).

  </Accordion>

  <Accordion title="How do thread-bound subagent sessions work on Discord?">
    Bind a Discord thread to a subagent or session target so follow-up messages there stay on that bound session.

    - Spawn with `sessions_spawn` using `thread: true` (optionally `mode: "session"` for persistent follow-up).
    - Or bind manually with `/focus <target>`.
    - `/agents` inspects binding state.
    - `/session idle <duration|off>` and `/session max-age <duration|off>` control auto-unfocus.
    - `/unfocus` detaches the thread.

    Config: `session.threadBindings.enabled` (global switch), `session.threadBindings.idleHours` (default `24`, `0` disables), `session.threadBindings.maxAgeHours` (default `0` = no hard cap), and `session.threadBindings.spawnSessions` for auto-bind on spawn (default `true`).

    Docs: [Sub-agents](/tools/subagents), [Discord](/channels/discord), [Configuration Reference](/gateway/configuration-reference), [Slash commands](/tools/slash-commands).

  </Accordion>

  <Accordion title="A subagent finished, but the completion update went to the wrong place or never posted. What should I check?">
    Check the resolved requester route:

    - Completion-mode subagent delivery prefers a bound thread or conversation route when one exists.
    - If the completion origin only carries a channel, OpenClaw falls back to the requester session's stored route (`lastChannel` / `lastTo` / `lastAccountId`) so direct delivery can still succeed.
    - No bound route and no usable stored route: direct delivery can fail and the result falls back to queued session delivery instead of posting immediately.
    - Invalid or stale targets can also force queue fallback or final delivery failure.
    - If the child's last visible assistant reply is exactly `NO_REPLY` / `no_reply` or `ANNOUNCE_SKIP`, OpenClaw intentionally suppresses the announce instead of posting stale earlier progress.

    Debug: `openclaw tasks show <lookup>` where `<lookup>` is a task id, run id, or session key.

    Docs: [Sub-agents](/tools/subagents), [Background Tasks](/automation/tasks), [Session Tools](/concepts/session-tool).

  </Accordion>

  <Accordion title="Cron or reminders do not fire. What should I check?">
    Cron runs inside the Gateway process; it does not fire if the Gateway is not running continuously.

    - Confirm cron is enabled (`cron.enabled`) and `OPENCLAW_SKIP_CRON` is not set.
    - Confirm the Gateway is running 24/7 (no sleep/restarts).
    - Verify job timezone (`--tz` vs host timezone).

    Debug:
    ```bash
    openclaw cron run <jobId>
    openclaw cron runs --id <jobId> --limit 50
    ```

    Docs: [Cron jobs](/automation/cron-jobs), [Automation](/automation).

  </Accordion>

  <Accordion title="Cron fired, but nothing was sent to the channel. Why?">
    Check the delivery mode:

    - `--no-deliver` / `delivery.mode: "none"`: no runner fallback send is expected.
    - Missing or invalid announce target (`channel` / `to`): the runner skipped outbound delivery.
    - Channel auth failures (`unauthorized`, `Forbidden`): the runner tried to deliver but credentials blocked it.
    - A silent isolated result (`NO_REPLY` / `no_reply` only) is treated as intentionally non-deliverable, so queued fallback delivery is also suppressed.

    For isolated cron jobs, the agent can still send directly with the `message` tool when a chat route is available. `--announce` only controls runner fallback delivery for final text the agent did not already send itself.

    Debug:
    ```bash
    openclaw cron runs --id <jobId> --limit 50
    openclaw tasks show <lookup>
    ```

    Docs: [Cron jobs](/automation/cron-jobs), [Background Tasks](/automation/tasks).

  </Accordion>

  <Accordion title="Why did an isolated cron run switch models or retry once?">
    That is the live model-switch path, not duplicate scheduling. Isolated cron persists a runtime model handoff and retries when the active run throws `LiveSessionModelSwitchError`, keeping the switched provider/model (and any switched auth-profile override) before retrying.

    Model-selection precedence: Gmail hook model override (`hooks.gmail.model`) first, then per-job `model`, then any stored cron-session model override, then normal agent/default model selection.

    The retry loop is bounded to the initial attempt plus 2 switch retries; cron then aborts instead of looping forever.

    Debug:
    ```bash
    openclaw cron runs --id <jobId> --limit 50
    ```

    Docs: [Cron jobs](/automation/cron-jobs), [cron CLI](/cli/cron).

  </Accordion>

  <Accordion title="How do I install skills on Linux?">
    Use native `openclaw skills` commands or drop skills into your workspace; the macOS Skills UI is not available on Linux. Browse skills at [https://clawhub.ai](https://clawhub.ai).

    ```bash
    openclaw skills search "calendar"
    openclaw skills search --limit 20
    openclaw skills install @owner/<skill-slug>
    openclaw skills install @owner/<skill-slug> --version <version>
    openclaw skills install @owner/<skill-slug> --force
    openclaw skills install @owner/<skill-slug> --global
    openclaw skills update --all
    openclaw skills update --all --global
    openclaw skills list --eligible
    openclaw skills check
    ```

    Native `openclaw skills install` writes into the active workspace `skills/` directory by default. Add `--global` to install into the shared managed skills directory for all local agents. Install the separate `clawhub` CLI only to publish or sync your own skills. Use `agents.defaults.skills` or `agents.entries.*.skills` to narrow which agents see shared skills.

  </Accordion>

  <Accordion title="Can OpenClaw run tasks on a schedule or continuously in the background?">
    Yes, via the Gateway scheduler:

    - **Cron jobs** for scheduled or recurring tasks (persist across restarts).
    - **Heartbeat** for main-session periodic checks.
    - **Isolated jobs** for autonomous agents that post summaries or deliver to chats.

    Docs: [Cron jobs](/automation/cron-jobs), [Automation](/automation), [Heartbeat](/gateway/heartbeat).

  </Accordion>

  <Accordion title="Can I run Apple macOS-only skills from Linux?">
    Not directly. macOS skills are gated by `metadata.openclaw.os` plus required binaries, and only load when eligible on the **Gateway host**. On Linux, `darwin`-only skills (`apple-notes`, `apple-reminders`, `things-mac`) will not load unless you override the gating.

    Three supported patterns:

    **Option A - run the Gateway on a Mac (simplest)**. Run the Gateway where the macOS binaries exist, then connect from Linux in [remote mode](#gateway-ports-already-running-and-remote-mode) or over Tailscale. Skills load normally because the Gateway host is macOS.

    **Option B - use a macOS node (no SSH)**. Run the Gateway on Linux, pair a macOS node (menubar app), and set **Node Run Commands** to "Always Ask" or "Always Allow" on the Mac. OpenClaw treats macOS-only skills as eligible when required binaries exist on the node; the agent runs them via the `nodes` tool. With "Always Ask," approving "Always Allow" in the prompt adds that command to the allowlist.

    **Option C - proxy macOS binaries over SSH (advanced)**. Keep the Gateway on Linux, but make the required CLI binaries resolve to SSH wrappers that run on a Mac, then override the skill to allow Linux so it stays eligible.

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
    Not built in today. Options:

    - **Custom skill / plugin**: best for reliable API access (both have APIs).
    - **Browser automation**: works without code but is slower and more fragile.

    For agency-style per-client context: keep one Notion page per client (context + preferences + active work) and ask the agent to fetch that page at the start of a session.

    For a native integration, open a feature request or build a skill against those APIs.

    ```bash
    openclaw skills install @owner/<skill-slug>
    openclaw skills update --all
    ```

    Native installs land in the active workspace `skills/` directory; use `--global` for all local agents, or configure `agents.defaults.skills` / `agents.entries.*.skills` to limit visibility. Some skills expect Homebrew-installed binaries; on Linux that means Linuxbrew.

    See [Skills](/tools/skills), [Skills config](/tools/skills-config), [ClawHub](/tools/clawhub).

  </Accordion>

  <Accordion title="How do I use my existing signed-in Chrome with OpenClaw?">
    Use the built-in `user` browser profile, which attaches through Chrome DevTools MCP:

    ```bash
    openclaw browser --browser-profile user tabs
    openclaw browser --browser-profile user snapshot
    ```

    For a custom name, create an explicit MCP profile:

    ```bash
    openclaw browser create-profile --name chrome-live --driver existing-session
    openclaw browser --browser-profile chrome-live tabs
    ```

    This can use the local host browser or a connected browser node. If the Gateway runs elsewhere, run a node host on the browser machine, or use remote CDP instead.

    Current limits on `existing-session` / `user` profiles versus the managed `openclaw` profile:

    - `click`, `type`, `hover`, `scrollIntoView`, `drag`, and `select` require snapshot refs, not CSS selectors.
    - Upload hooks require `ref` or `inputRef`, one file at a time, no CSS `element`.
    - `responsebody`, PDF export, download interception, and batch actions still require the managed browser path.

    See [Browser](/tools/browser#existing-session-via-chrome-devtools-mcp) for the full comparison.

  </Accordion>
</AccordionGroup>

## Sandboxing and memory

<AccordionGroup>
  <Accordion title="Is there a dedicated sandboxing doc?">
    Yes: [Sandboxing](/gateway/sandboxing). For Docker-specific setup (full gateway in Docker or sandbox images), see [Docker](/install/docker).
  </Accordion>

  <Accordion title="Docker feels limited - how do I enable full features?">
    The default image is security-first and runs as the `node` user, so it excludes system packages, Homebrew, and bundled browsers. For a fuller setup:

    - Persist `/home/node` with `OPENCLAW_HOME_VOLUME` so caches survive.
    - Bake system deps into the image with `OPENCLAW_IMAGE_APT_PACKAGES`.
    - Install Playwright browsers via the bundled CLI: `node /app/node_modules/playwright-core/cli.js install chromium`.
    - Set `PLAYWRIGHT_BROWSERS_PATH` and persist that path.

    Docs: [Docker](/install/docker), [Browser](/tools/browser).

  </Accordion>

  <Accordion title="Can I keep DMs personal but make groups public/sandboxed with one agent?">
    Yes, if private traffic is **DMs** and public traffic is **groups**. Set `agents.defaults.sandbox.mode: "non-main"` so group/channel sessions (non-main keys) run in the configured sandbox backend while the main DM session stays on-host. Docker is the default backend once sandboxing is enabled. Restrict tools available in sandboxed sessions via `tools.sandbox.tools`.

    Setup walkthrough: [Groups: personal DMs + public groups](/channels/groups#pattern-personal-dms-public-groups-single-agent). Key reference: [Gateway configuration](/gateway/config-agents#agentsdefaultssandbox).

  </Accordion>

  <Accordion title="How do I bind a host folder into the sandbox?">
    Set `agents.defaults.sandbox.docker.binds` to `["host:container:mode"]` (for example `"/home/user/src:/src:ro"`). Global and per-agent binds merge; per-agent binds are ignored when `scope: "shared"`. Use `:ro` for anything sensitive; binds bypass the sandbox filesystem walls.

    OpenClaw validates bind sources against both the normalized path and the canonical path resolved through the deepest existing ancestor, so symlink-parent escapes fail closed even when the final path segment does not exist yet.

    See [Sandboxing](/gateway/sandboxing#custom-bind-mounts) and [Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated#bind-mounts-security-quick-check).

  </Accordion>

  <Accordion title="How does memory work?">
    OpenClaw memory is Markdown files in the agent workspace: daily notes in `memory/YYYY-MM-DD.md`, curated long-term notes in `MEMORY.md` (main/private sessions only).

    OpenClaw also runs a silent **pre-compaction memory flush** before compaction summarizes the conversation, reminding the model to write durable notes first. It only runs when the workspace is writable (read-only sandboxes skip it); disable with `agents.defaults.compaction.memoryFlush.enabled: false`. See [Memory](/concepts/memory).

  </Accordion>

  <Accordion title="Memory keeps forgetting things. How do I make it stick?">
    Ask the bot to **write the fact to memory**: long-term notes go in `MEMORY.md`, short-term context in `memory/YYYY-MM-DD.md`. Reminding the model to store memories usually resolves it. If it keeps forgetting, verify the Gateway uses the same workspace on every run.

    Docs: [Memory](/concepts/memory), [Agent workspace](/concepts/agent-workspace).

  </Accordion>

  <Accordion title="Does memory persist forever? What are the limits?">
    Memory files live on disk and persist until deleted; the limit is your storage, not the model. **Session context** is still limited by the model context window, so long conversations can compact or truncate - that is why memory search exists, pulling only the relevant parts back into context.

    Docs: [Memory](/concepts/memory), [Context](/concepts/context).

  </Accordion>

  <Accordion title="Does semantic memory search require an OpenAI API key?">
    Only if you use **OpenAI embeddings**, which is the default provider. Codex OAuth covers chat/completions and does **not** grant embeddings access, so signing in with Codex (OAuth or the Codex CLI login) does not enable semantic memory search. OpenAI embeddings still need a real API key (`OPENAI_API_KEY` or `models.providers.openai.apiKey`).

    To stay local, set `memory.search.provider: "local"` (GGUF/llama.cpp). Other supported providers: Bedrock, DeepInfra, Gemini (`GEMINI_API_KEY` or `memory.search.remote.apiKey`), GitHub Copilot, LM Studio, Mistral, Ollama, OpenAI-compatible, and Voyage. See [Memory](/concepts/memory) and [Memory search](/concepts/memory-search) for setup details.

  </Accordion>
</AccordionGroup>

## Where things live on disk

<AccordionGroup>
  <Accordion title="Is all data used with OpenClaw saved locally?">
    No: **OpenClaw's own state is local**, but **external services still see what you send them**.

    - **Local by default**: sessions, memory files, config, and workspace live on the Gateway host (`~/.openclaw` plus your workspace directory).
    - **Remote by necessity**: messages sent to model providers (Anthropic/OpenAI/etc.) go to their APIs, and chat platforms (Slack/Telegram/WhatsApp/etc.) store message data on their servers.
    - **You control the footprint**: local models keep prompts on your machine, but channel traffic still goes through the channel's servers.

    Related: [Agent workspace](/concepts/agent-workspace), [Memory](/concepts/memory).

  </Accordion>

  <Accordion title="Where does OpenClaw store its data?">
    Everything lives under `$OPENCLAW_STATE_DIR` (default: `~/.openclaw`):

    | Path                                                               | Purpose                                                            |
    | ------------------------------------------------------------------ | ------------------------------------------------------------------ |
    | `$OPENCLAW_STATE_DIR/openclaw.json`                                 | Main config (JSON5)                                                 |
    | `$OPENCLAW_STATE_DIR/credentials/oauth.json`                        | Legacy OAuth import (copied into auth profiles on first use)        |
    | `$OPENCLAW_STATE_DIR/agents/<agentId>/agent/auth-profiles.json`     | Auth profiles (OAuth, API keys, optional `keyRef`/`tokenRef`)        |
    | `$OPENCLAW_STATE_DIR/secrets.json`                                  | Optional file-backed secret payload for `file` SecretRef providers   |
    | `$OPENCLAW_STATE_DIR/agents/<agentId>/agent/auth.json`              | Legacy compatibility file (static `api_key` entries scrubbed)        |
    | `$OPENCLAW_STATE_DIR/credentials/`                                  | Provider state (for example `whatsapp/<accountId>/creds.json`)      |
    | `$OPENCLAW_STATE_DIR/agents/`                                       | Per-agent state (agentDir + legacy/archive session artifacts)        |
    | `$OPENCLAW_STATE_DIR/agents/<agentId>/agent/openclaw-agent.sqlite`  | Per-agent SQLite state, including session rows and transcripts      |
    | `$OPENCLAW_STATE_DIR/agents/<agentId>/sessions/`                    | Legacy session migration sources and archive/support artifacts      |

    Legacy single-agent path `~/.openclaw/agent/*` is migrated by `openclaw doctor`.

    Your **workspace** (AGENTS.md, memory files, skills, etc.) is separate, configured via `agents.defaults.workspace` (default: `~/.openclaw/workspace`).

  </Accordion>

  <Accordion title="Where should AGENTS.md / SOUL.md / USER.md / MEMORY.md live?">
    These live in the **agent workspace**, not `~/.openclaw`.

    - **Workspace (per agent)**: `AGENTS.md`, `SOUL.md`, `IDENTITY.md`, `USER.md`, `MEMORY.md`, `memory/YYYY-MM-DD.md`, optional `HEARTBEAT.md`. Lowercase root `memory.md` is legacy repair input only; `openclaw doctor --fix` can merge it into `MEMORY.md` when both exist.
    - **State dir (`~/.openclaw`)**: config, channel/provider state, auth profiles, sessions, logs, shared skills (`~/.openclaw/skills`).

    Default workspace is `~/.openclaw/workspace`, configurable:

    ```json5
    {
      agents: { defaults: { workspace: "~/.openclaw/workspace" } },
    }
    ```

    If the bot "forgets" after a restart, confirm the Gateway uses the same workspace on every launch (remote mode uses the **gateway host's** workspace, not your local laptop).

    Tip: for durable behavior or preference, ask the bot to **write it into AGENTS.md or MEMORY.md** rather than relying on chat history.

    See [Agent workspace](/concepts/agent-workspace) and [Memory](/concepts/memory).

  </Accordion>

  <Accordion title="Can I make SOUL.md bigger?">
    Yes. `SOUL.md` is one of the workspace bootstrap files injected into agent context. Default per-file injection limit is `20000` characters; total bootstrap budget across files is `60000` characters.

    Change shared defaults:

    ```json5
    {
      agents: {
        defaults: {
          bootstrapMaxChars: 50000,
          bootstrapTotalMaxChars: 300000,
        },
      },
    }
    ```

    Or override one agent under `agents.entries.*.bootstrapMaxChars` / `bootstrapTotalMaxChars`.

    Use `/context` to check raw vs injected sizes and whether truncation happened. Keep `SOUL.md` focused on voice, stance, and personality; put operating rules in `AGENTS.md` and durable facts in memory.

    See [Context](/concepts/context) and [Agent config](/gateway/config-agents).

  </Accordion>

  <Accordion title="Recommended backup strategy">
    Put your **agent workspace** in a **private** git repo and back it up somewhere private (for example GitHub private). This captures memory plus AGENTS/SOUL/USER files and lets you restore the assistant's "mind" later.

    Do **not** commit anything under `~/.openclaw` (credentials, sessions, tokens, encrypted secrets payloads). For a full restore, back up the workspace and state directory separately.

    Docs: [Agent workspace](/concepts/agent-workspace).

  </Accordion>

  <Accordion title="How do I completely uninstall OpenClaw?">
    See [Uninstall](/install/uninstall).
  </Accordion>

  <Accordion title="Can agents work outside the workspace?">
    Yes. The workspace is the **default cwd** and memory anchor, not a hard sandbox. Relative paths resolve inside the workspace; absolute paths can access other host locations unless sandboxing is enabled. For isolation, use [`agents.defaults.sandbox`](/gateway/sandboxing) or per-agent sandbox settings. To make a repo the default working directory, point that agent's `workspace` at the repo root - the OpenClaw repo itself is just source code, so keep the workspace separate unless you intentionally want the agent to work inside it.

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
    Session state is owned by the **gateway host**. In remote mode, the session store you care about is on the remote machine, not your local laptop. See [Session management](/concepts/session).
  </Accordion>
</AccordionGroup>

## Config basics

<AccordionGroup>
  <Accordion title="What format is the config? Where is it?">
    OpenClaw reads an optional **JSON5** config from `$OPENCLAW_CONFIG_PATH` (default: `~/.openclaw/openclaw.json`). If the file is missing, it uses safe-ish defaults, including a default workspace of `~/.openclaw/workspace`.
  </Accordion>

  <Accordion title='I set gateway.bind: "lan" (or "tailnet") and now nothing listens / the UI says unauthorized'>
    Non-loopback binds **require a valid gateway auth path**: shared-secret auth (token or password), or `gateway.auth.mode: "trusted-proxy"` behind a correctly configured identity-aware reverse proxy.

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

    - `gateway.remote.token` / `.password` do **not** enable local gateway auth by themselves; local call paths can use `gateway.remote.*` as fallback only when `gateway.auth.*` is unset.
    - For password auth, set `gateway.auth.mode: "password"` plus `gateway.auth.password` (or `OPENCLAW_GATEWAY_PASSWORD`).
    - If `gateway.auth.token` / `.password` is explicitly configured via SecretRef and unresolved, resolution fails closed (no remote fallback masking).
    - Shared-secret Control UI setups authenticate via `connect.params.auth.token` or `connect.params.auth.password` (stored in app/UI settings). Identity-bearing modes such as Tailscale Serve or `trusted-proxy` use request headers instead - avoid putting shared secrets in URLs.
    - With `gateway.auth.mode: "trusted-proxy"`, same-host loopback reverse proxies require explicit `gateway.auth.trustedProxy.allowLoopback = true` and a loopback entry in `gateway.trustedProxies`.

  </Accordion>

  <Accordion title="Why do I need a token on localhost now?">
    OpenClaw enforces gateway auth by default, including loopback. If no explicit auth path is configured, startup resolves to token mode and generates a runtime-only token for that startup, so local WS clients must authenticate. This blocks other local processes from calling the Gateway.

    Configure `gateway.auth.token`, `gateway.auth.password`, `OPENCLAW_GATEWAY_TOKEN`, or `OPENCLAW_GATEWAY_PASSWORD` explicitly when clients need a stable secret across restarts. You can also choose password mode, or `trusted-proxy` for identity-aware reverse proxies. For open loopback, set `gateway.auth.mode: "none"` explicitly. `openclaw doctor --generate-gateway-token` generates a token any time.

  </Accordion>

  <Accordion title="Do I have to restart after changing config?">
    The Gateway watches the config and supports hot-reload: `gateway.reload.mode: "hybrid"` (default) hot-applies safe changes and restarts for critical ones. `hot`, `restart`, and `off` are also supported. Most `tools.*`, `agents.*` policy, `session.*`, and `messages.*` changes apply immediately with no reload action at all; `gateway.*` binding/port changes require a restart.
  </Accordion>

  <Accordion title="How do I enable web search (and web fetch)?">
    `web_fetch` works without an API key. `web_search` depends on your selected provider:

    | Provider | Key-free | Env var(s) |
    | --- | --- | --- |
    | Brave | No | `BRAVE_API_KEY` |
    | DuckDuckGo | Yes (unofficial HTML-based) | - |
    | Exa | No | `EXA_API_KEY` |
    | Firecrawl | No | `FIRECRAWL_API_KEY` |
    | Gemini | No | `GEMINI_API_KEY` |
    | Grok | No (xAI OAuth or key) | `XAI_API_KEY` |
    | Kimi | No | `KIMI_API_KEY` or `MOONSHOT_API_KEY` |
    | MiniMax Search | No | `MINIMAX_CODE_PLAN_KEY`, `MINIMAX_CODING_API_KEY`, or `MINIMAX_API_KEY` |
    | Ollama Web Search | Yes (needs `ollama signin`) | - |
    | Perplexity | No | `PERPLEXITY_API_KEY` or `OPENROUTER_API_KEY` |
    | SearXNG | Yes (self-hosted) | `SEARXNG_BASE_URL` |
    | Tavily | No | `TAVILY_API_KEY` |

    Grok can also reuse xAI OAuth from model auth (`openclaw onboard --auth-choice xai-oauth`).

    **Recommended**: `openclaw configure --section web` and pick a provider.

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

    Provider-specific web-search config lives under `plugins.entries.<plugin>.config.webSearch.*`. Legacy `tools.web.search.*` provider paths still load for compatibility but should not be used in new configs. Firecrawl web-fetch fallback config lives under `plugins.entries.firecrawl.config.webFetch.*`.

    - Allowlists: add `web_search`/`web_fetch`/`x_search`, or `group:web` for all three.
    - `web_fetch` is enabled by default.
    - If `tools.web.fetch.provider` is omitted, OpenClaw auto-detects the first ready fetch fallback provider from available credentials; the official Firecrawl plugin provides that fallback.
    - Daemons read env vars from `~/.openclaw/.env` (or the service environment).

    Docs: [Web tools](/tools/web).

  </Accordion>

  <Accordion title="config.apply wiped my config. How do I recover and avoid this?">
    `config.apply` replaces the **entire config**; a partial object removes everything else.

    Current OpenClaw protects most accidental clobbers:

    - OpenClaw-owned config writes validate the full post-change config before writing.
    - Invalid or destructive OpenClaw-owned writes are rejected and saved as `openclaw.json.rejected.*`.
    - A direct edit that breaks startup or hot reload makes the Gateway fail closed or skip the reload; it does not rewrite `openclaw.json`.
    - `openclaw doctor --fix` owns repair, can restore last-known-good, and saves the rejected file as `openclaw.json.clobbered.*`.

    Recover:

    - Check `openclaw logs --follow` for `Invalid config at`, `Config write rejected:`, or `config reload skipped (invalid config)`.
    - Inspect the newest `openclaw.json.clobbered.*` or `openclaw.json.rejected.*` beside the active config.
    - Run `openclaw config validate` and `openclaw doctor --fix`.
    - Copy only the intended keys back with `openclaw config set` or `config.patch`.
    - No last-known-good or rejected payload: restore from backup, or re-run `openclaw doctor` and reconfigure channels/models.
    - Unexpected loss: file a bug with your last known config or a backup. A local coding agent can often reconstruct a working config from logs or history.

    Avoid it: use `openclaw config set` for small changes, `openclaw configure` for interactive edits, `config.schema.lookup` to inspect an unfamiliar path (returns a shallow schema node plus immediate child summaries), and `config.patch` for partial RPC edits - reserve `config.apply` for full-config replacement. The agent-facing `gateway` runtime tool refuses to rewrite `tools.exec.ask` / `tools.exec.security` even via legacy `tools.bash.*` aliases.

    Docs: [Config](/cli/config), [Configure](/cli/configure), [Gateway troubleshooting](/gateway/troubleshooting#gateway-rejected-invalid-config), [Doctor](/gateway/doctor).

  </Accordion>

  <Accordion title="How do I run a central Gateway with specialized workers across devices?">
    Common pattern: **one Gateway** (for example a Raspberry Pi) plus **nodes** and **agents**.

    - **Gateway (central)**: owns channels (Signal/WhatsApp), routing, sessions.
    - **Nodes (devices)**: Macs/iOS/Android connect as peripherals and expose local tools (`system.run`, `canvas`, `camera`).
    - **Agents (workers)**: separate brains/workspaces for special roles (for example ops vs personal data).
    - **Sub-agents**: spawn background work from a main agent for parallelism.
    - **TUI**: connect to the Gateway and switch agents/sessions.

    Docs: [Nodes](/nodes), [Remote access](/gateway/remote), [Multi-Agent Routing](/concepts/multi-agent), [Sub-agents](/tools/subagents), [TUI](/web/tui).

  </Accordion>

  <Accordion title="Can the OpenClaw browser run headless?">
    Yes:

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

    Default is `false` (headful). Headless is more likely to trigger anti-bot checks on some sites (X/Twitter often blocks headless sessions). It uses the same Chromium engine and works for most automation; the main difference is no visible browser window (use screenshots for visuals). See [Browser](/tools/browser).

  </Accordion>

  <Accordion title="How do I use Brave for browser control?">
    Set `browser.executablePath` to your Brave binary (or any Chromium-based browser) and restart the Gateway. See [Browser](/tools/browser#use-brave-or-another-chromium-based-browser).
  </Accordion>
</AccordionGroup>

## Remote gateways and nodes

<AccordionGroup>
  <Accordion title="How do commands propagate between Telegram, the gateway, and nodes?">
    Telegram messages are handled by the **gateway**, which runs the agent and only then calls nodes over the **Gateway WebSocket** when a node tool is needed:

    Telegram -> Gateway -> Agent -> `node.*` -> Node -> Gateway -> Telegram

    Nodes do not see inbound provider traffic; they only receive node RPC calls.

  </Accordion>

  <Accordion title="How can my agent access my computer if the Gateway is hosted remotely?">
    Pair your computer as a **node**. The Gateway runs elsewhere but can call `node.*` tools (screen, camera, system) on your local machine over the Gateway WebSocket.

    1. Run the Gateway on the always-on host (VPS/home server).
    2. Put the Gateway host and your computer on the same tailnet.
    3. Ensure the Gateway WS is reachable (tailnet bind or SSH tunnel).
    4. Open the macOS app locally and connect in **Remote over SSH** mode (or direct tailnet) so it registers as a node.
    5. Approve the node:
       ```bash
       openclaw devices list
       openclaw devices approve <requestId>
       ```

    No separate TCP bridge is required; nodes connect over the Gateway WebSocket.

    Security reminder: pairing a macOS node allows `system.run` on that machine. Only pair devices you trust; review [Security](/gateway/security).

    Docs: [Nodes](/nodes), [Gateway protocol](/gateway/protocol), [macOS remote mode](/platforms/mac/remote), [Security](/gateway/security).

  </Accordion>

  <Accordion title="Tailscale is connected but I get no replies. What now?">
    Check the basics:

    ```bash
    openclaw gateway status
    openclaw status
    openclaw channels status
    ```

    Then verify auth and routing: if you use Tailscale Serve, confirm `gateway.auth.allowTailscale` is set correctly; if you connect via SSH tunnel, confirm the tunnel is up and points at the right port; confirm your DM/group allowlists include your account.

    Docs: [Tailscale](/gateway/tailscale), [Remote access](/gateway/remote), [Channels](/channels).

  </Accordion>

  <Accordion title="Can two OpenClaw instances talk to each other (local + VPS)?">
    Yes, though there is no built-in bot-to-bot bridge.

    **Simplest**: use a normal chat channel both bots can access (Slack/Telegram/WhatsApp). Have Bot A message Bot B, then let Bot B reply as usual.

    **CLI bridge (generic)**: run a script that calls the other Gateway with `openclaw agent --message ... --deliver`, targeting a chat where the other bot listens. If one bot is on a remote VPS, point your CLI at that remote Gateway via SSH/Tailscale (see [Remote access](/gateway/remote)):

    ```bash
    openclaw agent --message "Hello from local bot" --deliver --channel telegram --reply-to <chat-id>
    ```

    Add a guardrail so the two bots do not loop endlessly (mention-only, channel allowlists, or a "do not reply to bot messages" rule).

    Docs: [Remote access](/gateway/remote), [Agent CLI](/cli/agent), [Agent send](/tools/agent-send).

  </Accordion>

  <Accordion title="Do I need separate VPSes for multiple agents?">
    No. One Gateway hosts multiple agents, each with its own workspace, model defaults, and routing - this is the normal setup and much cheaper/simpler than one VPS per agent. Use separate VPSes only for hard isolation (security boundaries) or very different configs you do not want to share.
  </Accordion>

  <Accordion title="Is there a benefit to using a node on my personal laptop instead of SSH from a VPS?">
    Yes: nodes are the first-class way to reach your laptop from a remote Gateway and unlock more than shell access. The Gateway runs on macOS/Linux (Windows via WSL2) and is lightweight (a small VPS or Raspberry Pi-class box is fine; 4 GB RAM is plenty), so a common setup is an always-on host plus your laptop as a node.

    - **No inbound SSH required** - nodes connect out to the Gateway WebSocket via device pairing.
    - **Safer execution controls** - `system.run` is gated by node allowlists/approvals on that laptop.
    - **More device tools** - nodes expose `canvas`, `camera`, and `screen` in addition to `system.run`.
    - **Local browser automation** - keep the Gateway on a VPS but run Chrome locally through a node host, or attach to local Chrome via Chrome MCP.

    SSH is fine for ad-hoc shell access; nodes are simpler for ongoing agent workflows and device automation.

    Docs: [Nodes](/nodes), [Nodes CLI](/cli/nodes), [Browser](/tools/browser).

  </Accordion>

  <Accordion title="Do nodes run a gateway service?">
    No. Only **one gateway** should run per host unless you intentionally run isolated profiles (see [Multiple gateways](/gateway/multiple-gateways)). Nodes are peripherals that connect to the gateway (iOS/Android nodes, or macOS "node mode" in the menubar app). For headless node hosts and CLI control, see [Node host CLI](/cli/node).

    A full restart is required for `gateway`, `discovery`, and hosted plugin surface changes.

  </Accordion>

  <Accordion title="Is there an API / RPC way to apply config?">
    Yes:

    - `config.schema.lookup`: inspect one config subtree with its shallow schema node, matched UI hint, and immediate child summaries before writing.
    - `config.get`: fetch the current snapshot plus hash.
    - `config.patch`: safe partial update (preferred for most RPC edits); hot-reloads when possible, restarts when required.
    - `config.apply`: validate and replace the full config; hot-reloads when possible, restarts when required.
    - The agent-facing `gateway` runtime tool still refuses to rewrite `tools.exec.ask` / `tools.exec.security`; legacy `tools.bash.*` aliases normalize to the same protected paths.

  </Accordion>

  <Accordion title="Minimal sane config for a first install">
    ```json5
    {
      agents: { defaults: { workspace: "~/.openclaw/workspace" } },
      channels: { whatsapp: { allowFrom: ["+15555550123"] } },
    }
    ```

    Sets your workspace and restricts who can trigger the bot.

  </Accordion>

  <Accordion title="How do I set up Tailscale on a VPS and connect from my Mac?">
    1. **Install + login on the VPS**:
       ```bash
       curl -fsSL https://tailscale.com/install.sh | sh
       sudo tailscale up
       ```
    2. **Install + login on your Mac** using the Tailscale app, same tailnet.
    3. **Enable MagicDNS** in the Tailscale admin console so the VPS has a stable name.
    4. **Use the tailnet hostname**: SSH `ssh user@your-vps.tailnet-xxxx.ts.net`; Gateway WS `ws://your-vps.tailnet-xxxx.ts.net:18789`.

    For the Control UI without SSH, use Tailscale Serve on the VPS:

    ```bash
    openclaw gateway --tailscale serve
    ```

    This keeps the gateway bound to loopback and exposes HTTPS via Tailscale. See [Tailscale](/gateway/tailscale).

  </Accordion>

  <Accordion title="How do I connect a Mac node to a remote Gateway (Tailscale Serve)?">
    Serve exposes the **Gateway Control UI + WS**; nodes connect over the same Gateway WS endpoint.

    1. Make sure the VPS and Mac are on the same tailnet.
    2. Use the macOS app in Remote mode (SSH target can be the tailnet hostname) - it tunnels the Gateway port and connects as a node.
    3. Approve the node:
       ```bash
       openclaw devices list
       openclaw devices approve <requestId>
       ```

    Docs: [Gateway protocol](/gateway/protocol), [Discovery](/gateway/discovery), [macOS remote mode](/platforms/mac/remote).

  </Accordion>

  <Accordion title="Should I install on a second laptop or just add a node?">
    For **local tools only** (screen/camera/exec) on the second laptop, add it as a **node** - one Gateway, no duplicated config. Local node tools are currently macOS-only. Install a second Gateway only for **hard isolation** or two fully separate bots.

    Docs: [Nodes](/nodes), [Nodes CLI](/cli/nodes), [Multiple gateways](/gateway/multiple-gateways).

  </Accordion>
</AccordionGroup>

## Env vars and .env loading

<AccordionGroup>
  <Accordion title="How does OpenClaw load environment variables?">
    OpenClaw reads env vars from the parent process (shell, launchd/systemd, CI, etc.) and additionally loads:

    - `.env` from the current working directory.
    - a global fallback `.env` from `~/.openclaw/.env` (`$OPENCLAW_STATE_DIR/.env`).

    Neither `.env` file overrides existing env vars. Provider credential and endpoint-routing keys are an exception for workspace `.env`: keys such as `GEMINI_API_KEY`, `XAI_API_KEY`, `MISTRAL_API_KEY`, or any key ending in `_ENDPOINT` (and other bundled-provider auth or endpoint env vars) are ignored from workspace `.env` and should live in the process environment, `~/.openclaw/.env`, or config `env`.

    Inline env vars in config apply only if missing from the process env:

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
    Two fixes:

    1. Put the missing keys in `~/.openclaw/.env` so they load even when the service does not inherit your shell env.
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
       This runs your login shell and imports only missing expected keys (never overrides). Env var equivalents: `OPENCLAW_LOAD_SHELL_ENV=1`, `OPENCLAW_SHELL_ENV_TIMEOUT_MS=15000`.

  </Accordion>

  <Accordion title='I set COPILOT_GITHUB_TOKEN, but models status shows "Shell env: off." Why?'>
    `openclaw models status` reports whether **shell env import** is enabled. "Shell env: off" does **not** mean your env vars are missing - it just means OpenClaw will not load your login shell automatically.

    If the Gateway runs as a service (launchd/systemd), it will not inherit your shell environment. Fix by putting the token in `~/.openclaw/.env`, enabling `env.shellEnv.enabled: true`, or adding it to config `env` (applies only if missing), then restarting the gateway and rechecking:

    ```bash
    openclaw models status
    ```

    Copilot tokens resolve in this order: `OPENCLAW_GITHUB_TOKEN`, then `COPILOT_GITHUB_TOKEN`, then `GH_TOKEN`, then `GITHUB_TOKEN`.

    See [/concepts/model-providers](/concepts/model-providers) and [/environment](/help/environment).

  </Accordion>
</AccordionGroup>

## Sessions and multiple chats

<AccordionGroup>
  <Accordion title="How do I start a fresh conversation?">
    Send `/new` or `/reset` as a standalone message. See [Session management](/concepts/session).
  </Accordion>

  <Accordion title="Do sessions reset automatically if I never send /new?">
    No, not by default. Sessions keep the same `sessionId`, and compaction bounds the active model context as conversations grow. `/new` and `/reset` remain available, or you can opt into automatic resets with `mode: "daily"` or `mode: "idle"`. Daily mode rolls over at `session.reset.atHour` (default `4`, 0-23) on the gateway host; idle mode uses `session.reset.idleMinutes` since the last real interaction, not heartbeat/cron/exec system events.

    ```json5
    {
      session: {
        reset: { mode: "daily", atHour: 4 },
        resetByType: {
          group: { mode: "idle", idleMinutes: 120 },
          thread: { mode: "daily", atHour: 6 },
        },
        resetByChannel: {
          discord: { mode: "idle", idleMinutes: 10080 },
        },
      },
    }
    ```

    `resetByType` supports `direct`, `group`, and `thread`. Doctor migrates legacy `dm` entries to `direct`; the schema rejects `dm`. Legacy top-level `session.idleMinutes` still works as a compatibility alias for an idle-mode default when no `session.reset`/`resetByType` block is set. See [Session management](/concepts/session) for the full lifecycle.

  </Accordion>

  <Accordion title="Is there a way to make a team of OpenClaw instances (one CEO and many agents)?">
    Yes, via **multi-agent routing** and **sub-agents**: one coordinator agent plus several worker agents with their own workspaces and models.

    This is best seen as a fun experiment - it is token-heavy and often less efficient than one bot with separate sessions. The typical model is one bot you talk to, with different sessions for parallel work, spawning sub-agents when needed.

    Docs: [Multi-agent routing](/concepts/multi-agent), [Sub-agents](/tools/subagents), [Agents CLI](/cli/agents).

  </Accordion>

  <Accordion title="Why did context get truncated mid-task? How do I prevent it?">
    Session context is limited by the model window. Long chats, large tool outputs, or many files can trigger compaction or truncation.

    - Ask the bot to summarize current state and write it to a file.
    - Use `/compact` before long tasks, `/new` when switching topics.
    - Keep important context in the workspace and ask the bot to read it back.
    - Use sub-agents for long or parallel work so the main chat stays smaller.
    - Pick a model with a larger context window if this happens often.

  </Accordion>

  <Accordion title="How do I completely reset OpenClaw but keep it installed?">
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

    Onboarding also offers **Reset** if it detects an existing config; see [Onboarding (CLI)](/start/wizard). If you used profiles (`--profile` / `OPENCLAW_PROFILE`), reset each state dir (default `~/.openclaw-<profile>`). Dev-only reset: `openclaw gateway --dev --reset` wipes dev config, credentials, sessions, and workspace.

  </Accordion>

  <Accordion title='I am getting "context too large" errors - how do I reset or compact?'>
    - **Compact** (keeps the conversation, summarizes older turns): `/compact` or `/compact <instructions>` to guide the summary.
    - **Reset** (fresh session ID for the same chat key): `/new` or `/reset`.

    If it keeps happening, tune **session pruning** (`agents.defaults.contextPruning`) to trim old tool output, or use a model with a larger context window.

    Docs: [Compaction](/concepts/compaction), [Session pruning](/concepts/session-pruning), [Session management](/concepts/session).

  </Accordion>

  <Accordion title='Why am I seeing "LLM request rejected: messages.content.tool_use.input field required"?'>
    Provider validation error: the model emitted a `tool_use` block without the required `input`. Usually means the session history is stale or corrupted (often after long threads or a tool/schema change).

    Fix: start a fresh session with `/new` (standalone message).

  </Accordion>

  <Accordion title="Why am I getting heartbeat messages every 30 minutes?">
    Heartbeats run every **30m** by default, or **1h** when the resolved auth mode is Anthropic OAuth/token auth (including Claude CLI reuse) and `heartbeat.every` is unset. Tune or disable:

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

    If `HEARTBEAT.md` exists but is effectively empty (only blank lines, Markdown/HTML comments, ATX headings, fence markers, or empty list-item stubs), OpenClaw skips the heartbeat run to save API calls. If the file is missing, the heartbeat still runs and the model decides what to do.

    Per-agent overrides use `agents.entries.*.heartbeat`. Docs: [Heartbeat](/gateway/heartbeat).

  </Accordion>

  <Accordion title='Do I need to add a "bot account" to a WhatsApp group?'>
    No. OpenClaw runs on **your own account** - if you are in the group, OpenClaw can see it. By default, group replies are blocked until you allow senders (`groupPolicy: "allowlist"`).

    To restrict group replies to only you:

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
    Fastest: tail logs and send a test message in the group.

    ```bash
    openclaw logs --follow --json
    ```

    Look for `chatId` (or `from`) ending in `@g.us`, like `1234567890-1234567890@g.us`.

    If already configured/allowlisted, list groups from config:

    ```bash
    openclaw directory groups list --channel whatsapp
    ```

    Docs: [WhatsApp](/channels/whatsapp), [Directory](/cli/directory), [Logs](/cli/logs).

  </Accordion>

  <Accordion title="Why does OpenClaw not reply in a group?">
    Two common causes: mention gating is on by default (you must @mention the bot, or match `mentionPatterns`), or you configured `channels.whatsapp.groups` without `"*"` and the group is not allowlisted.

    See [Groups](/channels/groups) and [Group messages](/channels/group-messages).

  </Accordion>

  <Accordion title="Do groups/threads share context with DMs?">
    Direct chats collapse to the main session by default. Groups/channels have their own session keys, and Telegram topics / Discord threads are separate sessions. See [Groups](/channels/groups) and [Group messages](/channels/group-messages).
  </Accordion>

  <Accordion title="How many workspaces and agents can I create?">
    No hard limits - dozens or even hundreds are fine, but watch:

    - **Disk growth**: active sessions and transcripts live in the per-agent SQLite database; legacy/archive artifacts can still accumulate under `~/.openclaw/agents/<agentId>/sessions/`.
    - **Token cost**: more agents means more concurrent model usage.
    - **Ops overhead**: per-agent auth profiles, workspaces, and channel routing.

    Keep one **active** workspace per agent (`agents.defaults.workspace`), prune old sessions with `openclaw sessions cleanup` if disk grows (do not edit active SQLite state by hand), and use `openclaw doctor` to spot stray workspaces and profile mismatches.

  </Accordion>

  <Accordion title="Can I run multiple bots or chats at the same time (Slack), and how should I set that up?">
    Yes, via **Multi-Agent Routing**: run multiple isolated agents and route inbound messages by channel/account/peer. Slack is supported as a channel and can be bound to specific agents.

    Browser access is powerful but not "do anything a human can" - anti-bot, CAPTCHAs, and MFA can still block automation. For the most reliable control, use local Chrome MCP on the host, or CDP on the machine that actually runs the browser.

    Best-practice setup: always-on Gateway host (VPS/Mac mini), one agent per role (bindings), Slack channel(s) bound to those agents, and local browser via Chrome MCP or a node when needed.

    Docs: [Multi-Agent Routing](/concepts/multi-agent), [Slack](/channels/slack), [Browser](/tools/browser), [Nodes](/nodes).

  </Accordion>
</AccordionGroup>

## Models, failover, and auth profiles

Model Q&A - defaults, selection, aliases, switching, failover, auth profiles - lives on the [Models FAQ](/help/faq-models).

## Gateway: ports, "already running", and remote mode

<AccordionGroup>
  <Accordion title="What port does the Gateway use?">
    `gateway.port` controls the single multiplexed port for WebSocket + HTTP (Control UI, hooks, etc.). Precedence:

    ```text
    --port > OPENCLAW_GATEWAY_PORT > gateway.port > default 18789
    ```

  </Accordion>

  <Accordion title='Why does openclaw gateway status say "Runtime: running" but "Connectivity probe: failed"?'>
    "Running" is the **supervisor's** view (launchd/systemd/schtasks); the connectivity probe is the CLI actually connecting to the gateway WebSocket. Trust these lines from `openclaw gateway status`: `Probe target:` (the URL the probe used), `Listening:` (what is actually bound on the port), `Last gateway error:` (common root cause when the process is alive but the port is not listening).
  </Accordion>

  <Accordion title='Why does openclaw gateway status show "Config (cli)" and "Config (service)" different?'>
    You are editing one config file while the service runs another (often a `--profile` / `OPENCLAW_STATE_DIR` mismatch).

    Fix, run from the same `--profile` / environment you want the service to use:

    ```bash
    openclaw gateway install --force
    ```

  </Accordion>

  <Accordion title='What does "another gateway instance is already listening" mean?'>
    OpenClaw enforces a runtime lock by binding the WebSocket listener immediately on startup (default `ws://127.0.0.1:18789`). If the bind fails with `EADDRINUSE`, it throws `GatewayLockError` ("another gateway instance is already listening").

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

    - `openclaw gateway` only starts when `gateway.mode` is `local` (or you pass an override flag).
    - The macOS app watches the config file and switches modes live when these values change.
    - `gateway.remote.token` / `.password` are client-side remote credentials only; they do not enable local gateway auth by themselves.

  </Accordion>

  <Accordion title='The Control UI says "unauthorized" (or keeps reconnecting). What now?'>
    Your gateway auth path and the UI's auth method do not match.

    Facts (from code):

    - The Control UI keeps the token in `sessionStorage`, scoped to the current browser tab and selected gateway URL, so same-tab refreshes keep working without long-lived localStorage token persistence.
    - On `AUTH_TOKEN_MISMATCH`, trusted clients can attempt one bounded retry with a cached device token when the gateway returns retry hints (`canRetryWithDeviceToken=true`, `recommendedNextStep=retry_with_device_token`).
    - That cached-token retry reuses the cached approved scopes stored with the device token; explicit `deviceToken` / explicit `scopes` callers keep their requested scope set instead of inheriting cached scopes.
    - Outside that retry path, connect auth precedence is explicit shared token/password first, then explicit `deviceToken`, then stored device token, then bootstrap token.
    - Built-in setup-code bootstrap returns a node device token with `scopes: []` plus a bounded operator handoff token for trusted mobile onboarding. The operator handoff can read setup-time native configuration but does not grant pairing mutation scopes or `operator.admin`.

    Fix:

    - Fastest: `openclaw dashboard` (prints + copies the dashboard URL, tries to open; shows an SSH hint if headless).
    - No token yet: `openclaw doctor --generate-gateway-token`.
    - Remote: tunnel first with `ssh -N -L 18789:127.0.0.1:18789 user@host`, then open `http://127.0.0.1:18789/`.
    - Shared-secret mode: set `gateway.auth.token` / `OPENCLAW_GATEWAY_TOKEN` or `gateway.auth.password` / `OPENCLAW_GATEWAY_PASSWORD`, then paste the matching secret in Control UI settings.
    - Tailscale Serve mode: confirm `gateway.auth.allowTailscale` is enabled and you are opening the Serve URL, not a raw loopback/tailnet URL that bypasses Tailscale identity headers.
    - Trusted-proxy mode: confirm you are coming through the configured identity-aware proxy. Same-host loopback proxies also need `gateway.auth.trustedProxy.allowLoopback = true`.
    - Mismatch persists after the one retry: rotate/re-approve the paired device token:
      ```bash
      openclaw devices list
      openclaw devices rotate --device <id> --role operator
      ```
    - Rotate denied: paired-device sessions can rotate only their **own** device unless they also have `operator.admin`, and explicit `--scope` values cannot exceed the caller's current operator scopes.
    - Still stuck: `openclaw status --all` plus [Troubleshooting](/gateway/troubleshooting). See [Dashboard](/web/dashboard) for auth details.

  </Accordion>

  <Accordion title="I set gateway.bind tailnet but it listens only on loopback">
    `tailnet` bind picks a Tailscale IP from your network interfaces (100.64.0.0/10). If the machine is not on Tailscale (or the interface is down), the Gateway falls back to loopback instead of exposing another network interface.

    Fix: start Tailscale on that host and restart the Gateway, or switch explicitly to `gateway.bind: "loopback"` / `"lan"`.

    `tailnet` is explicit; `auto` prefers loopback. Use `gateway.bind: "tailnet"` to limit non-loopback exposure to the Tailnet while retaining the required same-host `127.0.0.1` listener.

  </Accordion>

  <Accordion title="Can I run multiple Gateways on the same host?">
    Usually no - one Gateway can run multiple messaging channels and agents. Use multiple Gateways only for redundancy (for example a rescue bot) or hard isolation, and isolate each with its own `OPENCLAW_CONFIG_PATH`, `OPENCLAW_STATE_DIR`, `agents.defaults.workspace`, and unique `gateway.port`.

    Recommended: `openclaw --profile <name> ...` per instance (auto-creates `~/.openclaw-<name>`), a unique `gateway.port` per profile config (or `--port` for manual runs), and a per-profile service with `openclaw --profile <name> gateway install`.

    Profiles also suffix service names: launchd `ai.openclaw.<profile>`, systemd `openclaw-gateway-<profile>.service`, Windows `OpenClaw Gateway (<profile>)`. The unqualified `openclaw-gateway` systemd unit only exists for the default profile; the legacy pre-rename systemd unit name `clawdbot-gateway` is migrated automatically.

    Full guide: [Multiple gateways](/gateway/multiple-gateways).

  </Accordion>

  <Accordion title='What does "invalid handshake" / code 1008 mean?'>
    The Gateway is a **WebSocket server** and expects the first message to be a `connect` frame. Anything else closes the connection with **code 1008** (policy violation).

    Common causes: you opened the **HTTP** URL in a browser instead of a WS client, used the wrong port/path, or a proxy/tunnel stripped auth headers or sent a non-Gateway request.

    Fix: use the WS URL (`ws://<host>:18789`, or `wss://...` over HTTPS), do not open the WS port in a normal browser tab, and include the token/password in the `connect` frame when auth is on. CLI/TUI example:

    ```bash
    openclaw tui --url ws://<host>:18789 --token <token>
    ```

    Protocol details: [Gateway protocol](/gateway/protocol).

  </Accordion>
</AccordionGroup>

## Logging and debugging

<AccordionGroup>
  <Accordion title="Where are logs?">
    File logs (structured): `/tmp/openclaw/openclaw-YYYY-MM-DD.log`. Set a stable path via `logging.file`; file log level via `logging.level`; console verbosity via `--verbose` and `logging.consoleLevel`.

    Fastest tail:

    ```bash
    openclaw logs --follow
    ```

    Service/supervisor logs (when the gateway runs via launchd/systemd):

    - macOS launchd stdout: `~/Library/Logs/openclaw/gateway.log` (profiles use `gateway-<profile>.log`; stderr is suppressed).
    - Linux: `journalctl --user -u openclaw-gateway[-<profile>].service -n 200 --no-pager`.
    - Windows: `schtasks /Query /TN "OpenClaw Gateway (<profile>)" /V /FO LIST`.

    See [Troubleshooting](/gateway/troubleshooting) for more.

  </Accordion>

  <Accordion title="How do I start/stop/restart the Gateway service?">
    ```bash
    openclaw gateway status
    openclaw gateway restart
    ```

    If you run the gateway manually, `openclaw gateway --force` can reclaim the port. See [Gateway](/gateway).

  </Accordion>

  <Accordion title="I closed my terminal on Windows - how do I restart OpenClaw?">
    Three Windows install modes:

    **1) Windows Hub local setup**: the native app manages a local app-owned WSL Gateway. Open **OpenClaw Companion** from the Start menu or tray, then use **Gateway Setup** or the Connections tab.

    **2) Manual WSL2 Gateway**: the Gateway runs inside Linux.
    ```powershell
    wsl
    openclaw gateway status
    openclaw gateway restart
    ```
    If you never installed the service, start it in the foreground: `openclaw gateway run`.

    **3) Native Windows CLI/Gateway**: runs directly in Windows.
    ```powershell
    openclaw gateway status
    openclaw gateway restart
    ```
    If you run it manually (no service): `openclaw gateway run`.

    Docs: [Windows](/platforms/windows), [Gateway service runbook](/gateway).

  </Accordion>

  <Accordion title="The Gateway is up but replies never arrive. What should I check?">
    Quick health sweep:

    ```bash
    openclaw status
    openclaw models status
    openclaw channels status
    openclaw logs --follow
    ```

    Common causes: model auth not loaded on the **gateway host** (check `models status`), channel pairing/allowlist blocking replies (check channel config and logs), or WebChat/Dashboard open without the right token. If remote, confirm the tunnel/Tailscale connection is up and the Gateway WebSocket is reachable.

    Docs: [Channels](/channels), [Troubleshooting](/gateway/troubleshooting), [Remote access](/gateway/remote).

  </Accordion>

  <Accordion title='"Disconnected from gateway: no reason" - what now?'>
    Usually means the UI lost the WebSocket connection. Check: is the Gateway running (`openclaw gateway status`)? Is it healthy (`openclaw status`)? Does the UI have the right token (`openclaw dashboard`)? If remote, is the tunnel/Tailscale link up?

    Then tail logs:

    ```bash
    openclaw logs --follow
    ```

    Docs: [Dashboard](/web/dashboard), [Remote access](/gateway/remote), [Troubleshooting](/gateway/troubleshooting).

  </Accordion>

  <Accordion title="Telegram setMyCommands fails. What should I check?">
    ```bash
    openclaw channels status
    openclaw channels logs --channel telegram
    ```

    Then match the error:

    - `BOT_COMMANDS_TOO_MUCH`: the Telegram menu has too many entries. OpenClaw already trims to the Telegram limit and retries with fewer commands, but some menu entries may still be dropped. Reduce plugin/skill/custom commands, or disable `channels.telegram.commands.native` if you do not need the menu.
    - `TypeError: fetch failed`, `Network request for 'setMyCommands' failed!`, or similar network errors: on a VPS or behind a proxy, confirm outbound HTTPS is allowed and DNS works for `api.telegram.org`.

    If the Gateway is remote, check logs on the Gateway host.

    Docs: [Telegram](/channels/telegram), [Channel troubleshooting](/channels/troubleshooting).

  </Accordion>

  <Accordion title="TUI shows no output. What should I check?">
    ```bash
    openclaw status
    openclaw models status
    openclaw logs --follow
    ```

    In the TUI, use `/status` to see the current state. If you expect replies in a chat channel, confirm delivery is enabled (`/deliver on`).

    Docs: [TUI](/web/tui), [Slash commands](/tools/slash-commands).

  </Accordion>

  <Accordion title="How do I completely stop then start the Gateway?">
    If you installed the service (launchd on macOS, systemd on Linux):

    ```bash
    openclaw gateway stop
    openclaw gateway start
    ```

    In the foreground, stop with Ctrl-C, then `openclaw gateway run`.

    Docs: [Gateway service runbook](/gateway).

  </Accordion>

  <Accordion title="ELI5: openclaw gateway restart vs openclaw gateway">
    `openclaw gateway restart` restarts the **background service** (launchd/systemd). `openclaw gateway` runs the gateway **in the foreground** for this terminal session. Use the gateway subcommands if you installed the service; use the bare foreground run for a one-off.
  </Accordion>

  <Accordion title="Fastest way to get more details when something fails">
    Start the Gateway with `--verbose` for more console detail, then inspect the log file for channel auth, model routing, and RPC errors.
  </Accordion>
</AccordionGroup>

## Media and attachments

<AccordionGroup>
  <Accordion title="My skill generated an image/PDF, but nothing was sent">
    Outbound attachments from the agent must use structured media fields such as `media`, `mediaUrl`, `path`, or `filePath`. See [OpenClaw assistant setup](/start/openclaw) and [Agent send](/tools/agent-send).

    ```bash
    openclaw message send --target +15555550123 --message "Here you go" --media /path/to/file.png
    ```

    Also check: the target channel supports outbound media and is not blocked by allowlists; the file is within the provider's size limits (images resize to a max side of 2048px); `tools.fs.workspaceOnly=true` limits local-path sends to workspace, temp/media-store, and sandbox-validated files; `tools.fs.workspaceOnly=false` (default) lets structured local media sends use host-local files the agent can already read, for media plus safe document types (images, audio, video, PDF, Office docs, and validated text documents such as Markdown/MD, TXT, JSON, YAML/YML). This is not a secret scanner - an agent-readable `secret.txt` or `config.json` can be attached when the extension and content validation match. Keep sensitive files outside agent-readable paths, or keep `tools.fs.workspaceOnly=true` for stricter local-path sends.

    See [Images](/nodes/images).

  </Accordion>
</AccordionGroup>

## Security and access control

<AccordionGroup>
  <Accordion title="Is it safe to expose OpenClaw to inbound DMs?">
    Treat inbound DMs as untrusted input. Defaults reduce risk:

    - Default behavior on DM-capable channels is **pairing**: unknown senders receive a pairing code and their message is not processed. Approve with `openclaw pairing approve --channel <channel> [--account <id>] <code>`. Pending requests are capped at **3 per channel**; check `openclaw pairing list --channel <channel> [--account <id>]` if a code did not arrive.
    - Opening DMs publicly requires explicit opt-in (`dmPolicy: "open"` and allowlist `"*"`).

    Run `openclaw doctor` to surface risky DM policies.

  </Accordion>

  <Accordion title="Is prompt injection only a concern for public bots?">
    No. Prompt injection is about **untrusted content**, not just who can DM the bot. If your assistant reads external content (web search/fetch, browser pages, emails, docs, attachments, pasted logs), that content can carry instructions that try to hijack the model - even if you are the only sender.

    The biggest risk is when tools are enabled: the model can be tricked into exfiltrating context or calling tools on your behalf. Reduce the blast radius:

    - use a read-only or tool-disabled "reader" agent to summarize untrusted content
    - keep `web_search` / `web_fetch` / `browser` off for tool-enabled agents
    - treat decoded file/document text as untrusted too: OpenResponses `input_file` and media-attachment extraction both wrap extracted text in explicit external-content boundary markers instead of passing raw file text
    - sandbox and use strict tool allowlists

    Details: [Security](/gateway/security).

  </Accordion>

  <Accordion title="Is OpenClaw less safe because it uses TypeScript/Node instead of Rust/WASM?">
    Language and runtime matter, but are not the main risk for a personal agent. The practical risks are gateway exposure, who can message the bot, prompt injection, tool scope, credential handling, browser access, exec access, and third-party skill/plugin trust.

    Rust and WASM can provide stronger isolation for some code classes, but do not solve prompt injection, bad allowlists, public gateway exposure, overbroad tools, or a browser profile already logged in to sensitive accounts. Treat these as the primary controls: keep the Gateway private or authenticated, use pairing and allowlists for DMs/groups, deny or sandbox risky tools for untrusted inputs, install only trusted plugins and skills, and run `openclaw security audit --deep` after config changes.

    Details: [Security](/gateway/security), [Sandboxing](/gateway/sandboxing).

  </Accordion>

  <Accordion title="I saw reports about exposed OpenClaw instances. What should I check?">
    ```bash
    openclaw security audit --deep
    openclaw gateway status
    ```

    A safer baseline: Gateway bound to `loopback`, or exposed only through authenticated private access (tailnet, SSH tunnel, token/password auth, or a correctly configured trusted proxy); DMs in `pairing` or `allowlist` mode; groups allowlisted and mention-gated unless every member is trusted; high-risk tools (`exec`, `browser`, `gateway`, `cron`) denied or tightly scoped for agents that read untrusted content; sandboxing enabled where tool execution needs a smaller blast radius.

    Public binds without auth, open DMs/groups with tools, and exposed browser control are the findings to fix first. Details: [openclaw security audit](/gateway/security#openclaw-security-audit).

  </Accordion>

  <Accordion title="Are ClawHub skills and third-party plugins safe to install?">
    Treat third-party skills and plugins as code you are choosing to trust. ClawHub skill pages expose scan state before install, but scans are not a complete security boundary. OpenClaw does not run built-in local dangerous-code blocking during plugin/skill install or update; use operator-owned `security.installPolicy` for local allow/block decisions.

    Safer pattern: prefer trusted authors and pinned versions, read the skill/plugin before enabling it, keep plugin/skill allowlists narrow, run untrusted-input workflows in a sandbox with minimal tools, and avoid giving third-party code broad filesystem, exec, browser, or secret access.

    Details: [Skills](/tools/skills), [Plugins](/tools/plugin), [Security](/gateway/security).

  </Accordion>

  <Accordion title="Should my bot have its own email, GitHub account, or phone number?">
    Yes, for most setups. Isolating the bot with separate accounts and phone numbers reduces the blast radius if something goes wrong, and makes it easier to rotate credentials or revoke access without impacting your personal accounts.

    Start small: give access only to the tools and accounts you actually need, and expand later if required.

    Docs: [Security](/gateway/security), [Pairing](/channels/pairing).

  </Accordion>

  <Accordion title="Can I give it autonomy over my text messages and is that safe?">
    We do **not** recommend full autonomy over your personal messages. Safest pattern: keep DMs in **pairing mode** or a tight allowlist, use a **separate number or account** if it should message on your behalf, and let it draft while you **approve before sending**.

    To experiment, do it on a dedicated, isolated account. See [Security](/gateway/security).

  </Accordion>

  <Accordion title="Can I use cheaper models for personal assistant tasks?">
    Yes, **if** the agent is chat-only and the input is trusted. Smaller tiers are more susceptible to instruction hijacking, so avoid them for tool-enabled agents or when reading untrusted content. If you must use a smaller model, lock down tools and run inside a sandbox. See [Security](/gateway/security).
  </Accordion>

  <Accordion title="I ran /start in Telegram but did not get a pairing code">
    Pairing codes are sent **only** when an unknown sender messages the bot and `dmPolicy: "pairing"` is enabled; `/start` by itself does not generate a code.

    Check pending requests:

    ```bash
    openclaw pairing list telegram
    ```

    For immediate access, allowlist your sender id or set `dmPolicy: "open"` for that account.

  </Accordion>

  <Accordion title="WhatsApp: will it message my contacts? How does pairing work?">
    No. Default WhatsApp DM policy is **pairing**. Unknown senders only get a pairing code; their message is **not processed**. OpenClaw only replies to chats it receives or to explicit sends you trigger.

    ```bash
    openclaw pairing approve whatsapp <code>
    openclaw pairing list whatsapp
    ```

    The wizard's phone number prompt sets your **allowlist/owner** so your own DMs are permitted - it is not used for auto-sending. On your personal WhatsApp number, use that number and enable `channels.whatsapp.selfChatMode`.

  </Accordion>
</AccordionGroup>

## Chat commands, aborting tasks, and "it will not stop"

<AccordionGroup>
  <Accordion title="How do I stop internal system messages from showing in chat?">
    Most internal/tool messages only appear when **verbose**, **trace**, or **reasoning** is enabled for that session.

    Fix in the chat where you see it:

    ```text
    /verbose off
    /trace off
    /reasoning off
    ```

    Still noisy: check session settings in the Control UI and set verbose to **inherit**; confirm you are not using a bot profile with `verboseDefault: "on"` in config.

    Docs: [Thinking and verbose](/tools/thinking), [Security](/gateway/security/index#reasoning-and-verbose-output-in-groups).

  </Accordion>

  <Accordion title="How do I stop/cancel a running task?">
    Send any of these **as a standalone message** (no slash) to trigger an abort: `stop`, `stop action`, `stop current action`, `stop run`, `stop current run`, `stop agent`, `stop the agent`, `stop openclaw`, `openclaw stop`, `stop don't do anything`, `stop do not do anything`, `stop doing anything`, `do not do that`, `please stop`, `stop please`, `abort`, `esc`, `exit`, `interrupt`, `halt`. Common non-English triggers (French, German, Spanish, Chinese, Japanese, Hindi, Arabic, Russian) also work.

    For background processes started by the exec tool, ask the agent to run:

    ```text
    process action:kill sessionId:XXX
    ```

    Most slash commands must be sent as a **standalone** message starting with `/`, but a few shortcuts (like `/status`) also work inline for allowlisted senders. See [Slash commands](/tools/slash-commands).

  </Accordion>

  <Accordion title='How do I send a Discord message from Telegram? ("Cross-context messaging denied")'>
    OpenClaw blocks **cross-provider** messaging by default. If a tool call is bound to Telegram, it will not send to Discord unless you explicitly allow it - and this takes effect immediately, no gateway restart needed:

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

  </Accordion>

  <Accordion title='Why does it feel like the bot "ignores" rapid-fire messages?'>
    Mid-run prompts are steered into the active run by default. Use `/queue` to choose active-run behavior:

    - `steer` (default) - guide the active run at the next model boundary.
    - `followup` - queue messages and run them one at a time after the current run ends.
    - `collect` - queue compatible messages and reply once after the current run ends.
    - `interrupt` - abort the current run and start fresh.

    Add options to queued modes like `debounce:0.5s cap:25 drop:summarize`. See [Command queue](/concepts/queue) and [Steering queue](/concepts/queue-steering).

  </Accordion>
</AccordionGroup>

## Miscellaneous

<AccordionGroup>
  <Accordion title='What is the default model for Anthropic with an API key?'>
    Credentials and model selection are separate. Setting `ANTHROPIC_API_KEY` (or storing an Anthropic API key in auth profiles) enables authentication, but the actual default model is whatever you configure in `agents.defaults.model.primary` (for example `anthropic/claude-sonnet-4-6` or `anthropic/claude-opus-4-6`). `No credentials found for profile "anthropic:default"` means the Gateway could not find Anthropic credentials in the expected `auth-profiles.json` for the running agent.
  </Accordion>
</AccordionGroup>

---

Still stuck? Ask in [Discord](https://discord.com/invite/clawd) or open a [GitHub discussion](https://github.com/openclaw/openclaw/discussions).

## Related

- [First-run FAQ](/help/faq-first-run) - install, onboard, auth, subscriptions, early failures
- [Models FAQ](/help/faq-models) - model selection, failover, auth profiles
- [Troubleshooting](/help/troubleshooting) - symptom-first triage
