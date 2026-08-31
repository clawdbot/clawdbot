---
summary: "CLI backends: local AI CLI fallback with optional MCP tool bridge"
read_when:
  - You want a reliable fallback when API providers fail
  - You are running local AI CLIs and want to reuse them
  - You want to understand the MCP loopback bridge for CLI backend tool access
title: "CLI backends"
---

OpenClaw can run a local AI CLI as a text-only fallback when API providers are down, rate-limited, or misbehaving. It is intentionally conservative:

- OpenClaw tools are not injected directly, but a backend with `bundleMcp: true` can receive gateway tools through a loopback MCP bridge.
- JSONL streaming for CLIs that support it.
- Sessions are supported, so follow-up turns stay coherent.
- Images pass through if the CLI accepts image paths.

Use it as a safety net for "always works" text responses, not a primary path. For a full harness runtime with ACP session controls, background tasks, thread/conversation binding, and persistent external coding sessions, use [ACP Agents](/tools/acp-agents) instead; CLI backends are not ACP.

<Tip>
  Building a new backend plugin? See [CLI backend plugins](/plugins/cli-backend-plugins). This page covers configuring and operating an already-registered backend.
</Tip>

## Quick start

The bundled Anthropic plugin registers a default `claude-cli` backend, so it works with no config beyond having Claude Code installed and logged in:

```bash
openclaw agent --agent main --message "hi" --model claude-cli/claude-sonnet-5
```

`main` is the default agent id when no explicit agent list is configured; swap in your own agent id otherwise.

The gateway service must have the CLI on its `PATH`. If a deployment needs a
nonstandard executable path or arguments, register that adapter in a
[CLI backend plugin](/plugins/cli-backend-plugins) instead of putting launch
mechanics in `openclaw.json`.

OpenClaw auto-loads an owning bundled plugin when model selection or a
model-scoped `agentRuntime.id` references its backend.

## Using it as a fallback

Add the CLI backend to your fallback list so it only runs when primary models fail:

```json5
{
  agents: {
    defaults: {
      model: {
        primary: "anthropic/claude-opus-4-6",
        fallbacks: ["claude-cli/claude-sonnet-5"],
      },
      models: {
        "anthropic/claude-opus-4-6": { alias: "Opus" },
        "claude-cli/claude-sonnet-5": {},
      },
    },
  },
}
```

Configured fallbacks remain eligible when the primary provider fails (auth, rate limits, timeouts), even when they are not in `agents.defaults.modelPolicy.allow`. Add a CLI backend model to that policy only when users should also be able to select it directly through `/model`, a session override, or `--model`. `agents.defaults.models` only owns per-model aliases, parameters, and metadata.

## Configuration

Users choose a registered backend through the model and runtime policy. Keep
the model ref canonical and select the CLI runtime per model:

```json5
{
  agents: {
    defaults: {
      model: "anthropic/claude-opus-5",
      models: {
        "anthropic/claude-opus-5": {
          agentRuntime: { id: "claude-cli" },
        },
      },
    },
  },
}
```

Credentials remain in OpenClaw auth profiles or the owning plugin's config.
Command, argv, environment, parsing, session, image, and watchdog mechanics are
plugin code registered with `api.registerCliBackend(...)`.

## How it works

1. Selects a backend by provider prefix (`claude-cli/...`).
2. Builds a system prompt using the same OpenClaw prompt and workspace context.
3. Executes the CLI with a session id (if supported) so history stays consistent. The bundled `claude-cli` backend uses Anthropic's official Agent SDK and keeps its authenticated Claude Code subprocess warm across compatible agent turns.
4. Parses output (JSON or plain text) and returns the final text.
5. Persists session ids per backend so follow-ups reuse the same CLI session.

## Timeouts and long-running work

CLI backends have two independent limits:

- `agents.defaults.timeoutSeconds` limits the whole agent turn. Normal Gateway turns inherit the 48-hour default; `0` makes the turn budget unlimited. A stored override such as `600` replaces that default.
- The CLI no-output watchdog stops a subprocess that remains silent. Each backend plugin owns separate fresh/resume profiles, and the watchdog remains active even when the overall turn budget is unlimited.

Remove a short overall-timeout override to return to the 48-hour default, or set an explicit budget such as 12 hours:

```bash
# Return to the 48-hour default:
openclaw config unset agents.defaults.timeoutSeconds

# Or choose an explicit 12-hour limit:
openclaw config set agents.defaults.timeoutSeconds 43200
```

Background work started inside a CLI is still part of that CLI subprocess. If the parent turn reaches its overall limit, OpenClaw stops the subprocess and its CLI-internal background tasks together. For durable long work, use a detached OpenClaw [sub-agent](/tools/subagents) or [ACP agent](/tools/acp-agents); detached sub-agents have no run timeout by default.

The `openclaw agent` command also has its own request deadline. Its 600-second fallback default applies to that command invocation, not to ordinary Gateway turns; see [`openclaw agent`](/cli/agent).

### Claude CLI specifics

The bundled Anthropic plugin runs the installed Claude Code executable through
Anthropic's official Agent SDK. Claude Code owns its existing local login and
subscription. OpenClaw uses a non-secret route marker. It never reads, persists,
refreshes, or forwards native tokens, or sends synthesized Anthropic API
requests. Compatible agent turns share one warm SDK query and
Claude Code subprocess. A changed model, system prompt, or tool policy starts a
new query; persisted Claude session IDs still provide
conversation continuity when the gateway or subprocess restarts.

For local SDK-backed turns, prompt-build hook context stays private: Claude
receives it as a native hook attachment, while OpenClaw history preserves the original user message. The
native session retains the context for resume; imported visible history and
cross-provider fallback preludes do not copy private hook attachments.

Keep Claude Code updated, especially if the SDK reports an incompatible
installed executable:

```bash
claude --version
claude update
# Restart the OpenClaw gateway after updating.
```

The bundled `claude-cli` backend prefers Claude Code's native skill resolver. When the current skills snapshot has at least one selected skill with a materialized path, OpenClaw passes a temporary Claude Code plugin via `--plugin-dir` and omits the duplicate OpenClaw skills catalog from the appended system prompt. Without a materialized plugin skill, OpenClaw keeps the prompt catalog as a fallback. Skill env/API key overrides still apply to the child process environment for the run.

The Agent SDK always runs with Claude Code's default permission mode.
OpenClaw's SDK permission callback and `PreToolUse` hook keep native tools under
host control, including when user or enterprise settings would otherwise
preapprove a call. Native requests pass through canonical `before_tool_call`
policy before exec policy and approval, with native tool names and file
arguments projected into their OpenClaw equivalents. Per-agent and session
restrictions still override broader global policy. OpenClaw-owned MCP tools
remain authorized by the Gateway rather than receiving duplicate native
approval; other MCP tools stay host-permission controlled.

When the effective exec ask setting is `on-miss` or `always`, OpenClaw relays
native or extension tool requests as interactive approvals to the session's
channel: **Allow once** permits the single call, **Allow always** permits that
tool name for the same warm live session while each subsequent turn's policy
and available tools still allow it, and **Deny**, a timeout, an unreachable
approval route, or a closed turn all deny the call. Grants stay in memory, end
when that exact live session is replaced, and never apply to Bash. Policies
that never prompt keep their existing behavior: `security: "deny"` rejects
every request, and ask `off` with less than full security denies without asking.

### Claude browser tools and 1Password sign-in

Claude Code can drive a Chrome browser through the [Claude in Chrome extension](https://code.claude.com/docs/en/chrome), including [1Password for Claude](/gateway/1password#browser-sign-in-with-1password-for-claude) credential autofill. The bundled backend does not enable it; register a [CLI backend plugin](/plugins/cli-backend-plugins) that appends `--chrome` to the launch args of a `claude-stream-json`-dialect backend. OpenClaw preserves a configured `--chrome` on normal runs and always forces `--no-chrome` on runs with a restricted tool policy, such as side questions. The Chrome window, the extension, and any 1Password approval prompts live on the gateway host, so someone must be at that machine to approve credential use.

The backend maps OpenClaw `/think` levels to Claude Code's native `--effort` flag: `minimal`/`low` -> `low`, `medium` -> `medium`, and `high`/`xhigh`/`max` pass through directly. For models that allow fixed thinking budgets, it also launches Claude Code with `MAX_THINKING_TOKENS`: `off=0`, `minimal=1024`, `low=2048`, `medium=8192`, `high`/`xhigh=16384`, and `max=32768`; positive fixed budgets disable adaptive thinking. Models that require adaptive thinking omit the fixed budget and continue to use `--effort`. `adaptive` removes configured effort flags and fixed-budget environment overrides, so Claude Code resolves effective thinking from its own environment, settings, and model defaults. Other CLI backends need their owning plugin to map the selected level before `/think` affects the spawned CLI.

Before OpenClaw can use `claude-cli`, Claude Code itself must be logged in on the same host:

```bash
claude auth login
claude auth status --text
openclaw models auth login --provider anthropic --method cli --set-default
```

Docker installs need Claude Code installed and logged in inside the persisted container home, not only on the host; see [Claude CLI backend in Docker](/install/docker#claude-cli-backend-in-docker).

The gateway service must resolve `claude` on `PATH`. For a nonstandard path,
register a small wrapper backend plugin.

## Sessions

- If the CLI supports sessions, set `sessionArgs` with a `{sessionId}` placeholder (for example `["--session-id", "{sessionId}"]`).
- If the CLI uses a resume subcommand with different flags, set `resumeArgs` (replaces `args` when resuming) and optionally `resumeOutput` for non-JSON resumes.
- `sessionMode`:
  - `always`: always send a session id (new UUID if none stored).
  - `existing`: only send a session id if one was stored before.
  - `none`: never send a session id.
- `claude-cli` defaults to `liveSession: "claude-stdio"`, `output: "jsonl"`, and `input: "stdin"`. The owning Anthropic plugin keeps one official Agent SDK query and Claude Code subprocess warm for compatible consecutive agent turns. If the gateway restarts or the idle process exits, OpenClaw resumes from the stored Claude session id. Stored session ids are verified against a readable project transcript before resume; a missing transcript clears the binding (logged as `reason=transcript-missing`) instead of silently starting a fresh session under `--resume`.
- Stored CLI sessions are provider-owned continuity. Automatic reset is disabled by default; `/reset` and explicit daily or idle `session.reset` policies still cut them.
- Fresh CLI sessions normally reseed from OpenClaw's latest compaction summary, the messages retained by that compaction, and subsequent turns on the active branch. OpenClaw reads this history from the canonical session SQLite database; it does not require an OpenClaw JSONL transcript file. To recover short sessions invalidated before compaction, a backend can opt in with `reseedFromRawTranscriptWhenUncompacted: true`. Raw transcript reseed stays bounded and limited to safe invalidations, such as a missing CLI transcript, an orphaned tool-use tail, message-policy/system-prompt/cwd/MCP changes, or a session-expired retry; auth profile or credential-epoch changes never reseed raw transcript history.

Serialization: `serialize: true` keeps same-lane runs ordered (most CLIs serialize on one provider lane). OpenClaw also drops stored CLI session reuse when the selected auth identity changes, including a changed auth profile id, static API key, static token, or OAuth account identity when the CLI exposes one; OAuth access/refresh token rotation alone does not cut the session. If a CLI has no stable OAuth account id, OpenClaw lets that CLI enforce its own resume permissions.

## Fallback prelude from claude-cli sessions

When a `claude-cli` attempt fails over to a non-CLI candidate in [`agents.defaults.model.fallbacks`](/concepts/model-failover), OpenClaw seeds the next attempt with a context prelude harvested from Claude Code's local JSONL transcript (under `~/.claude/projects/`, keyed per workspace). This supplies CLI-owned context that may not be present in OpenClaw's SQLite session transcript.

- The prelude prefers the latest `/compact` summary or `compact_boundary` marker, then appends the most recent post-boundary turns up to a char budget. Pre-boundary turns are dropped because the summary already represents them.
- Tool blocks are coalesced to compact `(tool call: name)` and `(tool result: …)` hints to keep the prompt budget honest; an oversized summary is truncated and labeled `(truncated)`.
- Same-provider `claude-cli` to `claude-cli` fallbacks rely on Claude's own `--resume` and skip the prelude.
- The seed reuses the existing Claude session-file path validation, so arbitrary paths cannot be read.

## Images

Plugin authors declare image-path support with `imageArg`:

```json5
imageArg: "--image",
imageMode: "repeat"
```

OpenClaw writes base64 images to temp files. If `imageArg` is set, those paths are passed as CLI args; if not, OpenClaw appends the file paths to the prompt (path injection), which works for CLIs that auto-load local files from plain paths.

## Inputs and outputs

- `output: "text"` (default) treats stdout as the final response.
- `output: "json"` tries to parse JSON and extract text plus a session id.
- `output: "jsonl"` parses a JSONL stream and extracts the final agent message plus session identifiers when present.
- For Gemini CLI JSON output, OpenClaw reads reply text from `response` and usage from `stats` when `usage` is missing or empty. The bundled Gemini CLI adapter uses `stream-json`.

Input modes:

- `input: "arg"` (default) passes the prompt as the last CLI arg.
- `input: "stdin"` sends the prompt via stdin.
- If the prompt is very long and `maxPromptArgChars` is set, stdin is used instead.

## Plugin-owned defaults

CLI backend defaults are part of the plugin surface:

- Plugins register them with `api.registerCliBackend(...)`.
- The backend `id` becomes the provider prefix in model refs.
- Command, argv, environment, parser, session, and watchdog behavior stays in plugin code.
- Backend-specific normalization stays plugin-owned through the optional `normalizeConfig` hook.

Anthropic owns `claude-cli` and Google owns `google-gemini-cli`. OpenAI Codex agent runs use the Codex app-server harness through `openai/*`; OpenClaw no longer registers a bundled `codex-cli` backend.

The bundled Anthropic plugin registers for `claude-cli`:

| Key                   | Value                                                                                                                                                                                                         |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `command`             | `claude`                                                                                                                                                                                                      |
| `args`                | `-p --output-format stream-json --include-partial-messages --verbose --setting-sources user --allowedTools mcp__openclaw__* --disallowedTools ScheduleWakeup,CronCreate,Bash(run_in_background:true),Monitor` |
| `output`              | `jsonl`                                                                                                                                                                                                       |
| `input`               | `stdin`                                                                                                                                                                                                       |
| `modelArg`            | `--model`                                                                                                                                                                                                     |
| `sessionArgs`         | `["--session-id", "{sessionId}"]`                                                                                                                                                                             |
| `sessionMode`         | `always`                                                                                                                                                                                                      |
| agent runtime         | Anthropic Agent SDK with a warm, session-scoped Claude Code query                                                                                                                                             |
| `imageArg`            | `@`                                                                                                                                                                                                           |
| `imagePathScope`      | `workspace`                                                                                                                                                                                                   |
| `systemPromptFileArg` | `--append-system-prompt-file`                                                                                                                                                                                 |
| `systemPromptMode`    | `append`                                                                                                                                                                                                      |

On Claude Code 2.1.98 or newer, the bundled backend adds
`--exclude-dynamic-system-prompt-sections` after a bounded version probe on the
first CLI execution. Concurrent executions share the probe; API catalog discovery
does not start it. Older, unknown, or failed probes keep the established argv.

The bundled Google plugin registers for `google-gemini-cli`:

| Key                       | Value                                                                                  |
| ------------------------- | -------------------------------------------------------------------------------------- |
| `command`                 | `gemini`                                                                               |
| `args`                    | `--skip-trust --approval-mode auto_edit --output-format stream-json --prompt {prompt}` |
| `resumeArgs`              | same, with `--resume {sessionId}`                                                      |
| `output` / `resumeOutput` | `jsonl`                                                                                |
| `jsonlDialect`            | `gemini-stream-json`                                                                   |
| `imageArg`                | `@`                                                                                    |
| `imagePathScope`          | `workspace`                                                                            |
| `modelArg`                | `--model`                                                                              |
| `sessionMode`             | `existing`                                                                             |
| `sessionIdFields`         | `["session_id", "sessionId"]`                                                          |

Prerequisites: the local Gemini CLI must be installed and on `PATH` as `gemini`
(`brew install gemini-cli` or `npm install -g @google/gemini-cli`), and the
selected model must have a supported Google AI Studio API-key profile. Existing
valid legacy Gemini CLI OAuth profiles remain runtime-compatible, but OpenClaw
does not create or repair them.

Gemini CLI output notes:

- The default `stream-json` parser reads assistant `message` events, tool events, final `result` usage, and fatal Gemini error events.
- Usage falls back to `stats` when `usage` is absent or empty; `stats.cached` normalizes into OpenClaw `cacheRead`, and if `stats.input` is missing, input tokens derive from `stats.input_tokens - stats.cached`.

## Text transform overlays

Plugins that need small prompt/message compatibility shims can declare bidirectional text transforms without replacing a provider or CLI backend:

```typescript
api.registerTextTransforms({
  input: [{ from: /red basket/g, to: "blue basket" }],
  output: [{ from: /blue basket/g, to: "red basket" }],
});
```

`input` rewrites the system prompt and user prompt passed to the CLI. `output` rewrites streamed assistant text and parsed final text before OpenClaw handles its own control markers and channel delivery; for provider-backed model calls it also restores string values inside structured tool-call arguments after stream repair and before tool execution. Raw provider JSON fragments are left unchanged; consumers should use the structured partial, end, or result payload.

For CLIs that emit provider-specific JSONL events, set `jsonlDialect` on that backend's config: `claude-stream-json` for Claude Code-compatible streams, `gemini-stream-json` for Gemini CLI `stream-json` events.

## Native compaction ownership

Some CLI backends run an agent that compacts its own transcript, so OpenClaw must not run its safeguard summarizer against them — doing so fights the backend's own compaction and can hard-fail the turn.

`claude-cli` has no harness endpoint (Claude Code compacts internally), so it declares `ownsNativeCompaction: true`. Automatic OpenClaw compaction defers to Claude Code, while an explicit `/compact` resumes the bound Claude Code session and sends its native `/compact` command. OpenClaw passes the run's effective context budget through Claude Code's documented [`CLAUDE_CODE_AUTO_COMPACT_WINDOW`](https://code.claude.com/docs/en/env-vars), keeping native auto-compaction aligned with configured Anthropic `contextTokens` limits. Native-harness sessions such as Codex keep routing to their harness compaction endpoint instead.

`google-gemini-cli` also owns automatic compaction and persists its compressed session for resume. OpenClaw defers to Gemini CLI rather than running a second summarizer. Explicit `/compact` is unsupported for this backend because it does not declare a manual compaction capability.

```typescript
api.registerCliBackend({
  id: "my-cli",
  ownsNativeCompaction: true,
  manualCompaction: {
    buildPrompt: (instructions) => (instructions ? `/compact ${instructions}` : "/compact"),
    input: "arg",
    validateOutput: (rawOutput) =>
      rawOutput.includes('"type":"compaction_complete"')
        ? { ok: true }
        : { ok: false, reason: "CLI did not confirm compaction." },
  },
  // ...
});
```

Only declare `ownsNativeCompaction` for a backend that genuinely owns compaction: it must reliably bound its own transcript near the context window and persist a resumable session (e.g. `--resume` / `--session-id`), or a deferred session can stay over budget.

Add the atomic `manualCompaction` capability only when its command compacts the resumed session in place. Its `input` selects the transport the backend command actually recognizes, and `validateOutput` must require a positive backend acknowledgement rather than treating a zero exit as success. OpenClaw runs it as an internal control operation: it is not written as a user turn and does not run agent or context-engine turn hooks.

## Bundle MCP overlays

CLI backends do not receive OpenClaw tool calls directly, but a backend can opt into a generated MCP config overlay with `bundleMcp: true`. Current bundled behavior:

- `claude-cli`: generated strict MCP config file.
- `google-gemini-cli`: generated Gemini system settings file.

When bundle MCP is enabled, OpenClaw:

- spawns a loopback HTTP MCP server that exposes gateway tools to the CLI process, authenticated with a per-run context grant (`OPENCLAW_MCP_TOKEN`) active only for the current execution attempt;
- binds tool access to the Gateway-selected session, account, and channel context instead of trusting child-process headers;
- loads enabled bundle-MCP servers for the current workspace and merges them with any existing backend MCP config/settings shape;
- rewrites the launch config using the backend-owned integration mode from the owning plugin.

`tools.allow` and `tools.deny` also constrain configured native MCP servers.
OpenClaw lists each server through its session-scoped runtime, assigns the same
provider-safe `<safe-server>__<safe-tool>` identities used by embedded tools,
and applies the complete layered policy before process spawn or Codex
`thread/start`/`thread/resume`. It then projects exact raw names into each
backend's enforcement contract: Claude receives server omission plus bare
`--disallowedTools` entries, Codex receives `enabled_tools` and
`disabled_tools`, and Gemini receives `includeTools` and `excludeTools`.
Configured server filters and session overrides remain additional
restrictions. These backend fields are generated implementation details; keep
operator policy in OpenClaw configuration.

For example, `agents.entries.research.tools.allow: ["docs__read_docs"]`
exposes only that tool from the safe `docs` namespace, while
`deny: ["docs__delete_*"]` removes matching siblings. An empty intersection
omits the affected MCP server. A server whose restrictive catalog cannot be
established is also omitted and reported instead of being passed through
unfiltered.

Restricted runs such as cron jobs with `toolsAllow` require an exact
backend-owned translation. The bundled `claude-cli` backend disables Claude's
native tools and user, project, and local customizations, including hooks,
plugins, agents, skills, and `CLAUDE.md`. It then exposes every allowed
OpenClaw tool through the grant-scoped MCP server. This keeps filesystem,
process, exec, approval, and sandbox policy inside OpenClaw instead of widening
authority to Claude's native tools or customization processes. The same MCP
list is enforced in Claude's generated config and again by the Gateway on tool
listing and execution. Before minting the grant, core rejects backend
translations that name any MCP permission outside the original allowlist.
Backends without an exact translation still fail closed.

If no MCP servers are enabled, OpenClaw still injects a strict config when a backend opts into bundle MCP, so background runs stay isolated.

Session-scoped bundled MCP runtimes are cached for reuse within a session, then reaped after 10 minutes of idle time. One-shot embedded runs such as auth probes, slug generation, and active-memory recall request cleanup at run end so stdio children and Streamable HTTP/SSE streams do not outlive the run.

For `claude-cli`, the installed Claude Code process uses its current native
login. OpenClaw uses a non-secret route marker and never reads, persists,
refreshes, selects, or forwards the native tokens.
Set `CLAUDE_CONFIG_DIR` on the Gateway process to use a separate Claude configuration directory.
Explicit OpenClaw-managed API-key and token profiles continue to use the
protected, per-invocation credential-forwarding CLI path.

## Reseed history cap

When a fresh CLI session is seeded from a prior OpenClaw transcript (for example after a `session_expired` retry), the rendered `<conversation_history>` block is capped to keep reseed prompts from exploding. The default is 12,288 characters (about 3,000 tokens).

Claude CLI backends scale this cap with the resolved Claude context window instead: larger context windows get a larger prior-history slice, up to a fixed ceiling; other CLI backends keep the conservative default. This cap only governs the reseed prompt's prior-history block.

## Limitations

- OpenClaw does not inject tool calls into the CLI backend protocol. Backends only see gateway tools when they opt into `bundleMcp: true`.
- Streaming is backend-specific: some backends stream JSONL, others buffer until exit.
- Structured outputs depend on the CLI's own JSON format.

## Troubleshooting

| Symptom               | Fix                                                                                            |
| --------------------- | ---------------------------------------------------------------------------------------------- |
| CLI not found         | Put the CLI on the gateway service's `PATH`, or update the owning plugin's registered command. |
| Wrong model name      | Update the plugin's `modelAliases` mapping.                                                    |
| No session continuity | Check the plugin's `sessionArgs` and `sessionMode`.                                            |
| Images ignored        | Check the plugin's `imageArg` and the CLI's file-path support.                                 |

## Related

- [Gateway runbook](/gateway)
- [Local models](/gateway/local-models)
