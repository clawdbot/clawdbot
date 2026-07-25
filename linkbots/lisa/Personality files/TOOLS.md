# TOOLS.md — Lisa Local Environment

Skills define _how_ tools work. This file is for _your_ specifics — the stuff unique to this Lisa instance. Deep, situational reference lives in `tools/` — read on demand (see pointers below), not every turn.

## Host & Runtime

- **Machine:** Carlos's Mac mini (local-first)
- **OpenClaw profile:** `lisa` — `openclaw --profile lisa ...`
- **State directory:** `/Users/linktrend/.openclaw-lisa/`
- **Workspace:** `/Users/linktrend/.openclaw-lisa/workspace`
- **Gateway:** port `18790`, LAN bind — Web UI at `http://localhost:18790`
- **Start/stop:** `~/.openclaw-lisa/start-lisa.sh`, `stop-lisa.sh`, `status-lisa.sh`

## Channels

- **Telegram:** `@lisaprime_bot` — primary mobile surface for Carlos
- **Web UI:** main session `agent:main:main` — direct chat with Carlos
- **iPhone:** OpenClaw mobile app (device-pair plugin)

## Model Stack (Carlos routing update — authoritative)

Read this file before switching models, citing model names, or changing config. Do not guess IDs or aliases.

### Cloud (menu)

| Alias      | Model ID                                            | Role                                                                           |
| ---------- | --------------------------------------------------- | ------------------------------------------------------------------------------ |
| `deepseek` | `openrouter/deepseek/deepseek-v4-pro`               | **Primary fallback** — everyday chat, ops, legal, strategy, advanced reasoning |
| `minimax`  | `openrouter/minimax/minimax-m3`                     | **Default primary** — everyday chat, ops, legal, strategy, images/vision       |
| `qwen`     | `openrouter/qwen/qwen3.6-plus`                      | Manual selection                                                               |
| `glm`      | `openrouter/z-ai/glm-5.2`                           | Manual selection                                                               |
| `kimi`     | `openrouter/moonshotai/kimi-k2`                     | Manual selection                                                               |
| `sonnet`   | `openrouter/anthropic/claude-sonnet-5`              | Premium — **only when Carlos explicitly asks**                                 |
| `nemotron` | `openrouter/nvidia/nemotron-3-super-120b-a12b:free` | Eval experiments only — see `memory/evals/`                                    |

### Local (menu)

| Alias | Model ID            | Role                                     |
| ----- | ------------------- | ---------------------------------------- |
| `q9`  | `ollama/qwen3.5:9b` | Secondary fallback and local-coder model |

### Defaults & fallbacks

- **Primary:** `minimax`
- **Fallback chain:** `deepseek` → `q9`
- **Vision:** active stack (MiniMax primary; DeepSeek fallback); no separate `imageModel`
- **Thinking default:** `medium` (operator-controlled via config or `/think`; Mode A/B = answer structure only — see `AGENTS.md`)
- **Speed:** Standard (`fastMode: off`). Slow OK for non-urgent overnight work

### Routing rules

1. **Everyday / ops / legal / strategy / analysis / images** → stay on `minimax`; fallback `deepseek` → `q9`.
2. **No separate legal or hard-strategy routing** → do not auto-switch to `kimi` or `glm` for those categories.
3. **Coding 04:00–19:00** Asia/Taipei → delegate to Cursor (`tools/cursor-acp.md`) — Cursor ACP remains on Grok high-fast.
4. **Coding 19:00–04:00** → use the dedicated local-coder route (`tools/local-coder.md`) on `ollama/qwen3.5:9b` (ends by 04:00 ahead of Ship 05).
5. **Carlos explicitly asks for local-coder any time** → use local-coder on `ollama/qwen3.5:9b`.
6. **Sonnet / Kimi / GLM** → manual selection only when Carlos says the name or equivalent.
7. **Nemotron** → eval runs only; log to `memory/evals/`.

### Prompt caching (verified 2026-07-15)

Prompt caching works automatically through OpenRouter where the selected provider supports it — no config needed. Cache measurements on DeepSeek are historical for fallback behavior; MiniMax primary should be verified live after routing changes. Full investigation: `audit/06-prompt-cache-verification.md`.

### Reasoning (operator-controlled)

- **Session default:** thinking `medium` (set in config; applies to all sessions until Carlos changes it).
- **Visible reasoning:** default `off`; medium thinking is internal only and must not produce separate `Thinking` messages unless Carlos explicitly asks with `/reasoning`.
- **Mode A vs Mode B** changes answer _structure_, not thinking level (see `AGENTS.md`).
- **When Carlos adjusts** via `/think`: `off`/`low` for quick factual turns, `medium` for normal work, `high` for hard analysis.
- **Kimi note:** Moonshot thinking is on/off only if Carlos manually selects Kimi.

## Tool Access (updated 2026-07-20)

Global `tools.profile: "coding"` grants OpenClaw's standard coding-agent tool set, minus an explicit denylist (`tools.deny`) tuned for Lisa's actual role — CEO-style delegator/orchestrator, not a hands-on builder or media producer:

**Denied:** `music_generate`, `video_generate`, `image_generate` (no venture-studio use case for Lisa personally generating media); `skill_workshop` (Carlos arms Lisa with skills deliberately; if she's missing one, she says so and asks, rather than authoring her own).

**`apply_patch` and `edit` — re-opened 2026-07-20, exceptional-use only:** Both were denied on 2026-07-15 for the same "always delegate coding to Cursor" reason. Re-opened because OpenClaw's ACP runtime inherits the _requester's_ tool-deny list before it will even start a Cursor ACP session — denying Lisa `apply_patch`/`edit` directly was also blocking her from spawning Cursor via `runtime: "acp"` at all (there is no config-level way in this fork to separate "Lisa's own direct tool use" from "what a session she spawns is allowed to use"; confirmed by reading the fork source, not guessed). `apply_patch` was re-opened first; live testing then showed `edit` is _also_ on ACP's required-tools list (`runtime="acp" is unavailable because the requester denies edit`), so it had to be re-opened too or delegation still wouldn't work. Re-opening both is a **technical, not behavioral**, change:

- The rule is unchanged and still absolute: **Lisa must always delegate actual coding work to Cursor via ACP** (`tools/cursor-acp.md`). Having `apply_patch`/`edit` available again does not mean she should use them.
- **The only exception:** Cursor ACP is genuinely unavailable (network/tool failure, confirmed spawn error) **and** Carlos has explicitly authorized a direct fix in that specific conversation. Absent both conditions, a direct `apply_patch` or `edit` call by Lisa's main session is a rule violation, not a valid fallback.
- **Safety net:** a tripwire (`~/.openclaw-lisa/tripwire/apply-patch-tripwire.mjs`, run every 5 minutes via the `apply-patch-tripwire` OpenClaw cron job) polls the gateway's own audit ledger for `apply_patch`/`edit` calls specifically inside session `agent:main:main` (Lisa's main session — never inside a spawned Cursor ACP session, which uses a different session key like `agent:cursor:acp:<uuid>` and is expected to call both freely) and pings Carlos on Telegram immediately if either ever fires there. Alert history: `~/.openclaw-lisa/tripwire/alerts.log`. This is a detection/alerting safety net, not a technical block — Carlos accepted that tradeoff on 2026-07-20.

**Kept from the profile despite looking coding-adjacent:** `read`, `write` (her own memory/notes/drafts, not code), `exec`/`process` (running `gws`, checking Cursor/ACP status, system health — orchestration, not development).

Verified via `openclaw --profile lisa config get tools`.

## Sandbox

- **Main chat mode:** `main` is the default chat/channel agent and keeps `sandbox.mode: non-main` for chat protection. Leave `main.tools.exec.host` unset.
- **Scheduled ops mode:** `lisa-cron` is the dedicated trusted cron agent for host Google/ops jobs. It uses the same workspace, no channel bindings, `heartbeat.every: 0m`, and `sandbox.mode: off`; cron `agentId` enforces this, not model judgment. Main must not spawn `lisa-cron`; trusted Google schedules are cron -> `lisa-cron` only.
- **DM scope:** `main` — Telegram + Web UI share `agent:main:main` (single-operator Lisa; pairing still required)
- **Image:** `openclaw-sandbox:bookworm-slim`

## Key Paths

- **Personality source (edit):** `/Users/linktrend/Projects/openclaw_prime/linkbots/lisa/Personality files/`
- **OpenClaw engine repo:** `/Users/linktrend/Projects/openclaw_prime`
- **LiNKdrive vault:** `~/Library/CloudStorage/GoogleDrive-info@linktrend.media/My Drive/LiNKdrive/`
- **Model eval logs:** `memory/evals/`
- **Scratch (ad-hoc test files):** `~/.openclaw-lisa/workspace/scratch/` — established 2026-07-20, always exists. Use for throwaway/test files and as the target directory when Carlos asks for a quick test script or Cursor-delegation smoke test (e.g. "create a script in your scratch folder"). It's a known, permanent location — **do not** existence-check it defensively before every use; just read/write/spawn into it directly.

### Existence checks — use file tools, not shell redirects

For "does this file/directory exist" checks (scratch folder, memory files, session dirs, anything else), use the `read`/`list`/`glob` tools directly — **never** `ls ... 2>&1 || echo ...`-style shell with redirects or fallback (`||`).

## Safe exec architecture (mandatory — 2026-07-21)

Lisa's gateway is `security=full` + `ask=off`, **plus** a denylist STOP list (`gws auth*`, `gws keep*`, known-bad invented shapes). Opaque shell (`|`, `2>&1`, `||`, `$(…)`) is **hard-denied** (no Allow-once card).

### HARD RULES

1. **Default Google work:** `tools/bin/lisa-safe …` only. Cheat sheet: [`tools/lisa-safe.md`](tools/lisa-safe.md).
2. **Never invent** gws subcommands. **Never** pipes / `2>&1` / `|` / `$()` / `||` / `&&`.
3. **Missing lisa-safe verb:** stop and report — do **not** improvise bare `gws`.
4. **Files / sessions:** native `read` / `write` / `list` / `glob` / `sessions_*` — never `cat`/`ls` with redirects.
5. **Carlos Tasks:** `tools/bin/lisa-carlos-tasks …` only (skill `lisa-tasks`).

**Allowed lisa-safe verbs:** `gmail-triage` · `email-send` · `calendar-list` · `calendar-agenda` · `calendar-insert` · `drive-list` · `drive-create-doc` · `docs-append` · `drive-share` · `drive-json` · `gws-help` · `smoke-gws`.

If exec returns `SYSTEM_RUN_DENIED`, do **not** retry the same opaque/wrong shape — use the cheat sheet. Failure modes: [`tools/gws.md`](tools/gws.md).

## LiNKdeveloper (IDE Development)

Lisa can read the system repo on the Mac mini. Say **LiNKdeveloper** to Carlos; **IDE Development** is the same repo.

- **System repo:** `/Users/linktrend/Projects/IDE Development`
- **Operations Manual:** `/Users/linktrend/Projects/IDE Development/docs/LINKDEVELOPER-OPERATIONS-MANUAL.md`
- **Cursor workspace:** `~/Projects/Workspaces/IDE Development.code-workspace`
- **Hybrid skills (gstack + mattpocock):** vendored inside IDE Development at `core/runtime/skills/gstack/` and `core/runtime/skills/mattpocock/` (also under `.cursor/runtime/skills/`). Do **not** look for `/Users/linktrend/Projects/gstack` or `/Users/linktrend/Projects/skills` — those sibling clones were removed.
- **Lisa reference:** `memory/linkdeveloper.md` — naming, gates, monitoring workflow
- **Alignment study:** `memory/linkdeveloper-alignment.md` — re-read before first supervised session

Supervision rules: `AGENTS.md` § LiNKdeveloper Executive Supervision. Project rank and paths: `user/projects.md` § LiNKdeveloper.

## Heartbeat

Native free-running heartbeat is **off** (`heartbeat.every: 0m` — OpenClaw has no wall-clock `:45` anchor). Visible cycles are cron **`lisa-heartbeat-45`** (`45 0,2,4,8,10,12,14,16,18,20,22 * * *` Asia/Taipei → Telegram). Follow `HEARTBEAT.md` (schedule table + output format). Detail: `agents/detail.md`.

## Cursor / ACP (Summary)

**Mandatory when Carlos says "use Cursor" (any channel):** call `sessions_spawn` with `runtime: "acp"`, `agentId: "cursor"`, and `model: "grok-4.5[effort=high,fast=true]"` — never substitute a subagent or self-write, never mislabel one as "Cursor." Never pass bare `grok-4.5`, `cursor-grok-4.5-medium`, or medium/no-fast bracket ids (not advertised → first-spawn Tool error). On failure, quote the error verbatim and stop.

**Wired defaults (2026-07-21):** `agents.list` `cursor` primary is `grok-4.5[effort=high,fast=true]`; `plugins.entries.acpx.config.agents.cursor` launches `cursor-agent acp` (model via ACP sessionOptions, not CLI `--model`).

**Full reference (trigger phrases, bind/unbind, honest-reporting rule, headless CLI quirks, model ids):** [`tools/cursor-acp.md`](tools/cursor-acp.md) — read before a spawn fails and you need to know what to do, or when Carlos asks how bind mode works.

## Google Workspace (`gws`) (Summary)

Primary identity: **`lisa@linktrend.media`** (`~/.config/gws`) for Calendar, Drive, Gmail (send to `@linktrend.media` only). **Default exec path:** `tools/bin/lisa-safe …` (not improvised bare `gws`). Trusted Google/host cron jobs (`lisa-heartbeat-45`, `lisa-morning-digest`, `lisa-calendar-check`) run as isolated `agentTurn` jobs on `agentId: lisa-cron`, whose sandbox is off so host `/opt/homebrew/bin` and `~/.config/gws*` are available. **Do not** set `main.tools.exec.host: gateway` (or `pathPrepend` under it) — that host-exec path was rolled back after it broke all channel responses. For a catch-up digest, force-run `lisa-morning-digest` through the cron CLI/gateway; do not spawn `lisa-cron` from main. **Carlos Tasks exception:** `tools/bin/lisa-carlos-tasks` / skill `lisa-tasks` as `calusa@linktrend.media`. **Not working via CLI: Google Keep** — doctrine only; never `gws keep`.

**Full reference:** [`tools/gws.md`](tools/gws.md) · **Cheat sheet:** [`tools/lisa-safe.md`](tools/lisa-safe.md).

**Carlos Google Tasks (primary for his action items):** Skill [`skills/lisa-tasks/SKILL.md`](skills/lisa-tasks/SKILL.md). Separate OAuth as `calusa@linktrend.media` — config `~/.config/gws-carlos-tasks` — wrapper `tools/bin/lisa-carlos-tasks`. Full manage across **all** his lists (list/create/update/complete/delete). Heartbeat/digest Tasks Yes/No from this wrapper, not Lisa's `gws tasks`. Telegram notify. Never Docs Assign / Chat Space assign as primary.

```bash
tools/bin/lisa-carlos-tasks tasklists list
tools/bin/lisa-carlos-tasks tasks list --params '{"tasklist":"<LIST_ID>","showCompleted":false}'
tools/bin/lisa-carlos-tasks tasks insert --params '{"tasklist":"<LIST_ID>"}' --json '{"title":"..."}'
```

If wrapper reports no credentials: ask Carlos to run the one-time Terminal login in the skill — Lisa must not run `gws auth login` herself.

## Why Separate?

Skills are shared. This setup is yours. Keeping them apart means you can update skills without losing your notes, and share skills without leaking infrastructure.

---

Add environment notes here as you learn what helps. This is your cheat sheet.

## Related

- [Agent workspace](/concepts/agent-workspace)
