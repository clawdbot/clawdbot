---
summary: "CLI backends: local AI CLI fallback with optional MCP tool bridge"
read_when:
  - You want a reliable fallback when API providers fail
  - You are running Codex CLI or other local AI CLIs and want to reuse them
  - You want to understand the MCP loopback bridge for CLI backend tool access
title: "CLI backends"
---

OpenClaw can run **local AI CLIs** as a **text-only fallback** when API providers are down,
rate-limited, or temporarily misbehaving. This is intentionally conservative:

- **OpenClaw tools are not injected directly**, but backends with `bundleMcp: true`
  can receive gateway tools via a loopback MCP bridge.
- **JSONL streaming** for CLIs that support it.
- **Sessions are supported** (so follow-up turns stay coherent).
- **Images can be passed through** if the CLI accepts image paths.

This is designed as a **safety net** rather than a primary path. Use it when you
want “always works” text responses without relying on external APIs.

If you want a full harness runtime with ACP session controls, background tasks,
thread/conversation binding, and persistent external coding sessions, use
[ACP Agents](/tools/acp-agents) instead. CLI backends are not ACP.

## Beginner-friendly quick start

You can use Codex CLI **without any config** (the bundled OpenAI plugin
registers a default backend):

```bash
openclaw agent --message "hi" --model codex-cli/gpt-5.5
```

If your gateway runs under launchd/systemd and PATH is minimal, add just the
command path:

```json5
{
  agents: {
    defaults: {
      cliBackends: {
        "codex-cli": {
          command: "/opt/homebrew/bin/codex",
        },
      },
    },
  },
}
```

That’s it. No keys, no extra auth config needed beyond the CLI itself.

If you use a bundled CLI backend as the **primary message provider** on a
gateway host, OpenClaw now auto-loads the owning bundled plugin when your config
explicitly references that backend in a model ref or under
`agents.defaults.cliBackends`.

## Using it as a fallback

Add a CLI backend to your fallback list so it only runs when primary models fail:

```json5
{
  agents: {
    defaults: {
      model: {
        primary: "anthropic/claude-opus-4-6",
        fallbacks: ["codex-cli/gpt-5.5"],
      },
      models: {
        "anthropic/claude-opus-4-6": { alias: "Opus" },
        "codex-cli/gpt-5.5": {},
      },
    },
  },
}
```

Notes:

- If you use `agents.defaults.models` (allowlist), you must include your CLI backend models there too.
- If the primary provider fails (auth, rate limits, timeouts), OpenClaw will
  try the CLI backend next.

## Configuration overview

All CLI backends live under:

```
agents.defaults.cliBackends
```

Each entry is keyed by a **provider id** (e.g. `codex-cli`, `my-cli`).
The provider id becomes the left side of your model ref:

```
<provider>/<model>
```

### Example configuration

```json5
{
  agents: {
    defaults: {
      cliBackends: {
        "codex-cli": {
          command: "/opt/homebrew/bin/codex",
        },
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
          // For CLIs with a dedicated prompt-file flag:
          // systemPromptFileArg: "--system-file",
          // Codex-style CLIs can point at a prompt file instead:
          // systemPromptFileConfigArg: "-c",
          // systemPromptFileConfigKey: "model_instructions_file",
          systemPromptWhen: "first",
          imageArg: "--image",
          imageMode: "repeat",
          serialize: true,
        },
      },
    },
  },
}
```

## How it works

1. **Selects a backend** based on the provider prefix (`codex-cli/...`).
2. **Builds a system prompt** using the same OpenClaw prompt + workspace context.
3. **Executes the CLI** with a session id (if supported) so history stays consistent.
   The bundled `claude-cli` backend keeps a Claude stdio process alive per
   OpenClaw session and sends follow-up turns over stream-json stdin.
4. **Parses output** (JSON or plain text) and returns the final text.
5. **Persists session ids** per backend, so follow-ups reuse the same CLI session.

<Note>
The bundled Anthropic `claude-cli` backend is supported again. Anthropic staff
told us OpenClaw-style Claude CLI usage is allowed again, so OpenClaw treats
`claude -p` usage as sanctioned for this integration unless Anthropic publishes
a new policy.
</Note>

The bundled OpenAI `codex-cli` backend passes OpenClaw's system prompt through
Codex's `model_instructions_file` config override (`-c
model_instructions_file="..."`). Codex does not expose a Claude-style
`--append-system-prompt` flag, so OpenClaw writes the assembled prompt to a
temporary file for each fresh Codex CLI session.

The bundled Anthropic `claude-cli` backend receives the OpenClaw skills snapshot
two ways: the compact OpenClaw skills catalog in the appended system prompt, and
a temporary Claude Code plugin passed with `--plugin-dir`. The plugin contains
only the eligible skills for that agent/session, so Claude Code's native skill
resolver sees the same filtered set that OpenClaw would otherwise advertise in
the prompt. Skill env/API key overrides are still applied by OpenClaw to the
child process environment for the run.

Claude CLI also has its own noninteractive permission mode. OpenClaw maps that
to the existing exec policy instead of adding Claude-specific config: when the
effective requested exec policy is YOLO (`tools.exec.security: "full"` and
`tools.exec.ask: "off"`), OpenClaw adds `--permission-mode bypassPermissions`.
Per-agent `agents.list[].tools.exec` settings override global `tools.exec` for
that agent. To force a different Claude mode, set explicit raw backend args
such as `--permission-mode default` or `--permission-mode acceptEdits` under
`agents.defaults.cliBackends.claude-cli.args` and matching `resumeArgs`.

Before OpenClaw can use the bundled `claude-cli` backend, Claude Code itself
must already be logged in on the same host:

```bash
claude auth login
claude auth status --text
openclaw models auth login --provider anthropic --method cli --set-default
```

Use `agents.defaults.cliBackends.claude-cli.command` only when the `claude`
binary is not already on `PATH`.

## Sessions

- If the CLI supports sessions, set `sessionArg` (e.g. `--session-id`) or
  `sessionArgs` (placeholder `{sessionId}`) when the ID needs to be inserted
  into multiple flags.
- If the CLI uses a **resume subcommand** with different flags, set
  `resumeArgs` (replaces `args` when resuming) and optionally `resumeOutput`
  (for non-JSON resumes).
- `sessionMode`:
  - `always`: always send a session id (new UUID if none stored).
  - `existing`: only send a session id if one was stored before.
  - `none`: never send a session id.
- `claude-cli` defaults to `liveSession: "claude-stdio"`, `output: "jsonl"`,
  and `input: "stdin"` so follow-up turns reuse the live Claude process while
  it is active. Warm stdio is the default now, including for custom configs
  that omit transport fields. If the Gateway restarts or the idle process
  exits, OpenClaw resumes from the stored Claude session id. Stored session
  ids are verified against an existing readable project transcript before
  resume, so phantom bindings are cleared with `reason=transcript-missing`
  instead of silently starting a fresh Claude CLI session under `--resume`.
- Stored CLI sessions are provider-owned continuity. The implicit daily session
  reset does not cut them; `/reset` and explicit `session.reset` policies still
  do.

Serialization notes:

- `serialize: true` keeps same-lane runs ordered.
- Most CLIs serialize on one provider lane.
- OpenClaw drops stored CLI session reuse when the selected auth identity changes,
  including a changed auth profile id, static API key, static token, or OAuth
  account identity when the CLI exposes one. OAuth access and refresh token
  rotation does not cut the stored CLI session. If a CLI does not expose a
  stable OAuth account id, OpenClaw lets that CLI enforce resume permissions.

## Fallback prelude from claude-cli sessions

When a `claude-cli` attempt fails over to a non-CLI candidate in
[`agents.defaults.model.fallbacks`](/concepts/model-failover), OpenClaw seeds
the next attempt with a context prelude harvested from Claude Code's local
JSONL transcript at `~/.claude/projects/`. Without this seed, the fallback
provider would start cold because OpenClaw's own session transcript is empty
for `claude-cli` runs.

- The prelude prefers the latest `/compact` summary or `compact_boundary`
  marker, then appends the most recent post-boundary turns up to a char
  budget. Pre-boundary turns are dropped because the summary already represents
  them.
- Tool blocks are coalesced to compact `(tool call: name)` and
  `(tool result: …)` hints to keep the prompt budget honest. The summary is
  labeled `(truncated)` if it overflows.
- Same-provider `claude-cli` to `claude-cli` fallbacks rely on Claude's own
  `--resume` and skip the prelude.
- The seed reuses the existing Claude session-file path validation, so
  arbitrary paths cannot be read.

## Images (pass-through)

If your CLI accepts image paths, set `imageArg`:

```json5
imageArg: "--image",
imageMode: "repeat"
```

OpenClaw will write base64 images to temp files. If `imageArg` is set, those
paths are passed as CLI args. If `imageArg` is missing, OpenClaw appends the
file paths to the prompt (path injection), which is enough for CLIs that auto-
load local files from plain paths.

## Inputs / outputs

- `output: "json"` (default) tries to parse JSON and extract text + session id.
- For Gemini CLI JSON output, OpenClaw reads reply text from `response` and
  usage from `stats` when `usage` is missing or empty.
- `output: "jsonl"` parses JSONL streams (for example Codex CLI `--json`) and extracts the final agent message plus session
  identifiers when present.
- `output: "text"` treats stdout as the final response.

Input modes:

- `input: "arg"` (default) passes the prompt as the last CLI arg.
- `input: "stdin"` sends the prompt via stdin.
- If the prompt is very long and `maxPromptArgChars` is set, stdin is used.

## Defaults (plugin-owned)

The bundled OpenAI plugin also registers a default for `codex-cli`:

- `command: "codex"`
- `args: ["exec","--json","--color","never","--sandbox","workspace-write","--skip-git-repo-check"]`
- `resumeArgs: ["exec","resume","{sessionId}","-c","sandbox_mode=\"workspace-write\"","--skip-git-repo-check"]`
- `output: "jsonl"`
- `resumeOutput: "text"`
- `modelArg: "--model"`
- `imageArg: "--image"`
- `sessionMode: "existing"`

The bundled Google plugin also registers a default for `google-gemini-cli`:

- `command: "gemini"`
- `args: ["--output-format", "json", "--prompt", "{prompt}"]`
- `resumeArgs: ["--resume", "{sessionId}", "--output-format", "json", "--prompt", "{prompt}"]`
- `imageArg: "@"`
- `imagePathScope: "workspace"`
- `modelArg: "--model"`
- `sessionMode: "existing"`
- `sessionIdFields: ["session_id", "sessionId"]`

Prerequisite: the local Gemini CLI must be installed and available as
`gemini` on `PATH` (`brew install gemini-cli` or
`npm install -g @google/gemini-cli`).

Gemini CLI JSON notes:

- Reply text is read from the JSON `response` field.
- Usage falls back to `stats` when `usage` is absent or empty.
- `stats.cached` is normalized into OpenClaw `cacheRead`.
- If `stats.input` is missing, OpenClaw derives input tokens from
  `stats.input_tokens - stats.cached`.

Override only if needed (common: absolute `command` path).

## Plugin-owned defaults

CLI backend defaults are now part of the plugin surface:

- Plugins register them with `api.registerCliBackend(...)`.
- The backend `id` becomes the provider prefix in model refs.
- User config in `agents.defaults.cliBackends.<id>` still overrides the plugin default.
- Backend-specific config cleanup stays plugin-owned through the optional
  `normalizeConfig` hook.

Plugins that need tiny prompt/message compatibility shims can declare
bidirectional text transforms without replacing a provider or CLI backend:

```typescript
api.registerTextTransforms({
  input: [
    { from: /red basket/g, to: "blue basket" },
    { from: /paper ticket/g, to: "digital ticket" },
    { from: /left shelf/g, to: "right shelf" },
  ],
  output: [
    { from: /blue basket/g, to: "red basket" },
    { from: /digital ticket/g, to: "paper ticket" },
    { from: /right shelf/g, to: "left shelf" },
  ],
});
```

`input` rewrites the system prompt and user prompt passed to the CLI. `output`
rewrites streamed assistant deltas and parsed final text before OpenClaw handles
its own control markers and channel delivery.

For CLIs that emit Claude Code stream-json compatible JSONL, set
`jsonlDialect: "claude-stream-json"` on that backend's config.

## Bundle MCP overlays

CLI backends do **not** receive OpenClaw tool calls directly, but a backend can
opt into a generated MCP config overlay with `bundleMcp: true`.

Current bundled behavior:

- `claude-cli`: generated strict MCP config file
- `codex-cli`: inline config overrides for `mcp_servers`; the generated
  OpenClaw loopback server is marked with Codex's per-server tool approval mode
  so MCP calls cannot stall on local approval prompts
- `google-gemini-cli`: generated Gemini system settings file

When bundle MCP is enabled, OpenClaw:

- spawns a loopback HTTP MCP server that exposes gateway tools to the CLI process
- authenticates the bridge with a per-session token (`OPENCLAW_MCP_TOKEN`)
- scopes tool access to the current session, account, and channel context
- loads enabled bundle-MCP servers for the current workspace
- merges them with any existing backend MCP config/settings shape
- rewrites the launch config using the backend-owned integration mode from the owning extension

If no MCP servers are enabled, OpenClaw still injects a strict config when a
backend opts into bundle MCP so background runs stay isolated.

Session-scoped bundled MCP runtimes are cached for reuse within a session, then
reaped after `mcp.sessionIdleTtlMs` milliseconds of idle time (default 10
minutes; set `0` to disable). One-shot embedded runs such as auth probes,
slug generation, and active-memory recall request cleanup at run end so stdio
children and Streamable HTTP/SSE streams do not outlive the run.

## Limitations

- **No direct OpenClaw tool calls.** OpenClaw does not inject tool calls into
  the CLI backend protocol. Backends only see gateway tools when they opt into
  `bundleMcp: true`.
- **Streaming is backend-specific.** Some backends stream JSONL; others buffer
  until exit.
- **Structured outputs** depend on the CLI’s JSON format.
- **Codex CLI sessions** resume via text output (no JSONL), which is less
  structured than the initial `--json` run. OpenClaw sessions still work
  normally.

## Troubleshooting

- **CLI not found**: set `command` to a full path.
- **Wrong model name**: use `modelAliases` to map `provider/model` → CLI model.
- **No session continuity**: ensure `sessionArg` is set and `sessionMode` is not
  `none` (Codex CLI currently cannot resume with JSON output).
- **Images ignored**: set `imageArg` (and verify CLI supports file paths).

## Related

- [Gateway runbook](/gateway)
- [Local models](/gateway/local-models)
