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
openclaw agent --agent main --message "hi" --model claude-cli/claude-sonnet-4-6
```

`main` is the default agent id when no explicit agent list is configured; swap in your own agent id otherwise.

If the gateway runs under launchd/systemd with a minimal `PATH`, point at the binary explicitly:

```json5
{
  agents: {
    defaults: {
      cliBackends: {
        "claude-cli": {
          command: "/opt/homebrew/bin/claude",
        },
      },
    },
  },
}
```

If you use a bundled CLI backend as the primary message provider on a gateway host, OpenClaw auto-loads the owning bundled plugin when your config references that backend in a model ref or under `agents.defaults.cliBackends`.

## Using it as a fallback

Add the CLI backend to your fallback list so it only runs when primary models fail:

```json5
{
  agents: {
    defaults: {
      model: {
        primary: "anthropic/claude-opus-4-6",
        fallbacks: ["claude-cli/claude-sonnet-4-6"],
      },
      models: {
        "anthropic/claude-opus-4-6": { alias: "Opus" },
        "claude-cli/claude-sonnet-4-6": {},
      },
    },
  },
}
```

If you use `agents.defaults.models` as an allowlist, include your CLI backend models there too. When the primary provider fails (auth, rate limits, timeouts), OpenClaw tries the CLI backend next.

## Configuration

All CLI backends live under `agents.defaults.cliBackends`, keyed by provider id (e.g. `claude-cli`, `my-cli`). The provider id becomes the left side of the model ref: `<provider>/<model>`.

```json5
{
  agents: {
    defaults: {
      cliBackends: {
        "my-cli": {
          command: "my-cli",
          args: ["--json"],
          output: "json",
          input: "arg",
          modelArg: "--model",
          modelAliases: {
            "claude-opus-4-6": "opus",
            "claude-sonnet-4-6": "sonnet",
          },
          sessionArg: "--session",
          sessionMode: "existing",
          sessionIdFields: ["session_id", "conversation_id"],
          systemPromptArg: "--system",
          // Dedicated prompt-file flag:
          // systemPromptFileArg: "--system-file",
          // Codex-style config-override flag instead:
          // systemPromptFileConfigArg: "-c",
          // systemPromptFileConfigKey: "model_instructions_file",
          systemPromptWhen: "first",
          imageArg: "--image",
          imageMode: "repeat",
          // Opt in only if this backend may reseed invalidated sessions from
          // bounded raw OpenClaw transcript history before compaction.
          reseedFromRawTranscriptWhenUncompacted: true,
          serialize: true,
        },
      },
    },
  },
}
```

## How it works

1. Selects a backend by provider prefix (`claude-cli/...`).
2. Builds a system prompt using the same OpenClaw prompt and workspace context.
3. Executes the CLI with a session id (if supported) so history stays consistent. The bundled `claude-cli` backend keeps a Claude stdio process alive per OpenClaw session and sends follow-up turns over stream-json stdin.
4. Parses output (JSON or plain text) and returns the final text.
5. Persists session ids per backend so follow-ups reuse the same CLI session.

### Claude CLI specifics

The bundled `claude-cli` backend prefers Claude Code's native skill resolver. When the current skills snapshot has at least one selected skill with a materialized path, OpenClaw passes a temporary Claude Code plugin via `--plugin-dir` and omits the duplicate OpenClaw skills catalog from the appended system prompt. Without a materialized plugin skill, OpenClaw keeps the prompt catalog as a fallback. Skill env/API key overrides still apply to the child process environment for the run.

Claude CLI has its own noninteractive permission mode; OpenClaw maps that to the existing exec policy instead of adding Claude-specific config. For OpenClaw-managed Claude live sessions, the effective exec policy is authoritative: YOLO (`tools.exec.security: "full"` and `tools.exec.ask: "off"`) launches Claude with `--permission-mode bypassPermissions`, while a restrictive policy launches it with `--permission-mode default`. Per-agent `agents.list[].tools.exec` settings override the global `tools.exec` for that agent. Raw backend args may still include `--permission-mode`, but live Claude launches normalize that flag to match the effective policy.

The backend also maps OpenClaw `/think` levels to Claude Code's native `--effort` flag: `minimal`/`low` -> `low`, `medium` -> `medium`, and `high`/`xhigh`/`max` pass through directly. `adaptive` removes configured `--effort` flags and supplies no replacement, so Claude Code resolves effective effort from its own environment, settings, and model defaults. Other CLI backends need their owning plugin to declare an equivalent argv mapper before `/think` affects the spawned CLI.

Before OpenClaw can use `claude-cli`, Claude Code itself must be logged in on the same host:

```bash
claude auth login
claude auth status --text
openclaw models auth login --provider anthropic --method cli --set-default
```

Docker installs need Claude Code installed and logged in inside the persisted container home, not only on the host; see [Claude CLI backend in Docker](/install/docker#claude-cli-backend-in-docker).

Set `agents.defaults.cliBackends.claude-cli.command` only when the `claude` binary is not already on `PATH`.

## Sessions

- If the CLI supports sessions, set `sessionArg` (e.g. `--session-id`), or `sessionArgs` (placeholder `{sessionId}`) when the id needs to land in multiple flags.
- If the CLI uses a resume subcommand with different flags, set `resumeArgs` (replaces `args` when resuming) and optionally `resumeOutput` for non-JSON resumes.
- `sessionMode`:
  - `always`: always send a session id (new UUID if none stored).
  - `existing`: only send a session id if one was stored before.
  - `none`: never send a session id.
- `claude-cli` defaults to `liveSession: "claude-stdio"`, `output: "jsonl"`, and `input: "stdin"`, so follow-up turns reuse the live Claude process while it is active, including for custom configs that omit transport fields. If the gateway restarts or the idle process exits, OpenClaw resumes from the stored Claude session id. Stored session ids are verified against a readable project transcript before resume; a missing transcript clears the binding (logged as `reason=transcript-missing`) instead of silently starting a fresh session under `--resume`.
- Claude live sessions keep bounded JSONL output guards: 8 MiB and 20,000 raw JSONL lines per turn by default. Raise them per backend with `agents.defaults.cliBackends.claude-cli.reliability.outputLimits.maxTurnRawChars` and `maxTurnLines`; OpenClaw clamps those settings to 64 MiB and 100,000 lines.
- Stored CLI sessions are provider-owned continuity. The implicit daily session reset does not cut them; `/reset` and explicit `session.reset` policies still do.
- Fresh CLI sessions normally reseed only from OpenClaw's compaction summary plus the post-compaction tail. To recover short sessions invalidated before compaction, a backend can opt in with `reseedFromRawTranscriptWhenUncompacted: true`. Raw transcript reseed stays bounded and limited to safe invalidations, such as a missing CLI transcript, an orphaned tool-use tail, message-policy/system-prompt/cwd/MCP changes, or a session-expired retry; auth profile or credential-epoch changes never reseed raw transcript history.

Serialization: `serialize: true` keeps same-lane runs ordered (most CLIs serialize on one provider lane). OpenClaw also drops stored CLI session reuse when the selected auth identity changes, including a changed auth profile id, static API key, static token, or OAuth account identity when the CLI exposes one; OAuth access/refresh token rotation alone does not cut the session. If a CLI has no stable OAuth account id, OpenClaw lets that CLI enforce its own resume permissions.

## Fallback prelude from claude-cli sessions

When a `claude-cli` attempt fails over to a non-CLI candidate in [`agents.defaults.model.fallbacks`](/concepts/model-failover), OpenClaw seeds the next attempt with a context prelude harvested from Claude Code's local JSONL transcript (under `~/.claude/projects/`, keyed per workspace). Without this seed the fallback provider starts cold, since OpenClaw's own session transcript is empty for `claude-cli` runs.

- The prelude prefers the latest `/compact` summary or `compact_boundary` marker, then appends the most recent post-boundary turns up to a char budget. Pre-boundary turns are dropped because the summary already represents them.
- Tool blocks are coalesced to compact `(tool call: name)` and `(tool result: …)` hints to keep the prompt budget honest; an oversized summary is truncated and labeled `(truncated)`.
- Same-provider `claude-cli` to `claude-cli` fallbacks rely on Claude's own `--resume` and skip the prelude.
- The seed reuses the existing Claude session-file path validation, so arbitrary paths cannot be read.

## Images

If your CLI accepts image paths, set `imageArg`:

```json5
imageArg: "--image",
imageMode: "repeat"
```

OpenClaw writes base64 images to temp files. If `imageArg` is set, those paths are passed as CLI args; if not, OpenClaw appends the file paths to the prompt (path injection), which works for CLIs that auto-load local files from plain paths.

## Inputs and outputs

- `output: "text"` (default) treats stdout as the final response.
- `output: "json"` tries to parse JSON and extract text plus a session id.
- `output: "jsonl"` parses a JSONL stream and extracts the final agent message plus session identifiers when present.
- For Gemini CLI JSON output, OpenClaw reads reply text from `response` and usage from `stats` when `usage` is missing or empty. The bundled Gemini CLI default uses `stream-json`; old `--output-format json` overrides still use the JSON parser.

Input modes:

- `input: "arg"` (default) passes the prompt as the last CLI arg.
- `input: "stdin"` sends the prompt via stdin.
- If the prompt is very long and `maxPromptArgChars` is set, stdin is used instead.

## Plugin-owned defaults

CLI backend defaults are part of the plugin surface:

- Plugins register them with `api.registerCliBackend(...)`.
- The backend `id` becomes the provider prefix in model refs.
- User config in `agents.defaults.cliBackends.<id>` still overrides the plugin default.
- Backend-specific config cleanup stays plugin-owned through the optional `normalizeConfig` hook.

Anthropic owns `claude-cli` and Google owns `google-gemini-cli`. OpenAI Codex agent runs use the Codex app-server harness through `openai/*`; OpenClaw no longer registers a bundled `codex-cli` backend.

The bundled Anthropic plugin registers for `claude-cli`:

| Key                   | Value                                                                                                                                                                                                         |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `command`             | `claude`                                                                                                                                                                                                      |
| `args`                | `-p --output-format stream-json --include-partial-messages --verbose --setting-sources user --allowedTools mcp__openclaw__* --disallowedTools ScheduleWakeup,CronCreate,Bash(run_in_background:true),Monitor` |
| `output`              | `jsonl`                                                                                                                                                                                                       |
| `input`               | `stdin`                                                                                                                                                                                                       |
| `modelArg`            | `--model`                                                                                                                                                                                                     |
| `sessionArg`          | `--session-id`                                                                                                                                                                                                |
| `sessionMode`         | `always`                                                                                                                                                                                                      |
| `imageArg`            | `@`                                                                                                                                                                                                           |
| `imagePathScope`      | `workspace`                                                                                                                                                                                                   |
| `systemPromptFileArg` | `--append-system-prompt-file`                                                                                                                                                                                 |
| `systemPromptMode`    | `append`                                                                                                                                                                                                      |

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

Prerequisite: the local Gemini CLI must be installed and on `PATH` as `gemini` (`brew install gemini-cli` or `npm install -g @google/gemini-cli`).

Gemini CLI output notes:

- The default `stream-json` parser reads assistant `message` events, tool events, final `result` usage, and fatal Gemini error events.
- If you override Gemini args to `--output-format json`, OpenClaw normalizes that backend back to `output: "json"` and reads reply text from the JSON `response` field.
- Usage falls back to `stats` when `usage` is absent or empty; `stats.cached` normalizes into OpenClaw `cacheRead`, and if `stats.input` is missing, input tokens derive from `stats.input_tokens - stats.cached`.

Override defaults only if needed (most commonly an absolute `command` path).

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

`claude-cli` has no harness endpoint (Claude Code compacts internally), so it declares `ownsNativeCompaction: true` and OpenClaw's compaction path returns the session entry unchanged. OpenClaw passes the run's effective context budget through Claude Code's documented [`CLAUDE_CODE_AUTO_COMPACT_WINDOW`](https://code.claude.com/docs/en/env-vars), keeping native auto-compaction aligned with configured Anthropic `contextTokens` limits. Native-harness sessions such as Codex keep routing to their harness compaction endpoint instead.

```typescript
api.registerCliBackend({ id: "my-cli", ownsNativeCompaction: true /* ... */ });
```

Only declare `ownsNativeCompaction` for a backend that genuinely owns compaction: it must reliably bound its own transcript near the context window and persist a resumable session (e.g. `--resume` / `--session-id`), or a deferred session can stay over budget.

## Bundle MCP overlays

CLI backends do not receive OpenClaw tool calls directly, but a backend can opt into a generated MCP config overlay with `bundleMcp: true`. Current bundled behavior:

- `claude-cli`: generated strict MCP config file.
- `google-gemini-cli`: generated Gemini system settings file.

When bundle MCP is enabled, OpenClaw:

- spawns a loopback HTTP MCP server that exposes gateway tools to the CLI process, authenticated with a per-run context grant (`OPENCLAW_MCP_TOKEN`) active only for the current execution attempt;
- binds tool access to the Gateway-selected session, account, and channel context instead of trusting child-process headers;
- loads enabled bundle-MCP servers for the current workspace and merges them with any existing backend MCP config/settings shape;
- rewrites the launch config using the backend-owned integration mode from the owning plugin.

If no MCP servers are enabled, OpenClaw still injects a strict config when a backend opts into bundle MCP, so background runs stay isolated.

Session-scoped bundled MCP runtimes are cached for reuse within a session, then reaped after `mcp.sessionIdleTtlMs` milliseconds of idle time (default 10 minutes; set `0` to disable). One-shot embedded runs such as auth probes, slug generation, and active-memory recall request cleanup at run end so stdio children and Streamable HTTP/SSE streams do not outlive the run.

## Reseed history cap

When a fresh CLI session is seeded from a prior OpenClaw transcript (for example after a `session_expired` retry), the rendered `<conversation_history>` block is capped to keep reseed prompts from exploding. The default is 12,288 characters (about 3,000 tokens).

Claude CLI backends scale this cap with the resolved Claude context window instead: larger context windows get a larger prior-history slice, up to a fixed ceiling; other CLI backends keep the conservative default. This cap only governs the reseed prompt's prior-history block — live-session output limits are tuned separately under `reliability.outputLimits` (see [Sessions](#sessions)).

## Limitations

- No direct OpenClaw tool calls: OpenClaw does not inject tool calls into the CLI backend protocol. Backends only see gateway tools when they opt into `bundleMcp: true`.
- Streaming is backend-specific: some backends stream JSONL, others buffer until exit.
- Structured outputs depend on the CLI's own JSON format.

## Troubleshooting

| Symptom               | Fix                                                               |
| --------------------- | ----------------------------------------------------------------- |
| CLI not found         | Set `command` to a full path.                                     |
| Wrong model name      | Use `modelAliases` to map `provider/model` to the CLI's model id. |
| No session continuity | Ensure `sessionArg` is set and `sessionMode` is not `none`.       |
| Images ignored        | Set `imageArg` and verify the CLI supports file paths.            |

## Related

- [Gateway runbook](/gateway)
- [Local models](/gateway/local-models)
