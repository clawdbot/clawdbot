---
summary: "CLI reference for Gateway-backed `openclaw agent` turns and isolated `agent exec` runs"
read_when:
  - You want to run one agent turn from scripts (optionally deliver reply)
  - You want a strict, ephemeral one-shot agent run for CI
title: "Agent"
---

# `openclaw agent`

Run one agent turn through the Gateway. The explicit `--local` flag is the only embedded execution path.

Pass at least one session selector: `--to`, `--session-key`, `--session-id`, or `--agent`.

A completed turn exits `0`. Error, timeout, and cancellation outcomes exit `1`, after any text or JSON result is written. A received `SIGINT` or `SIGTERM` instead preserves the signal-specific exit status described below.

Related: [Agent send tool](/tools/agent-send)

## `agent exec`

`openclaw agent exec` runs one embedded agent turn without connecting to a Gateway. It is the recommended headless entry point for CI and coding automation because it owns setup, cleanup, output projection, and process status.

```bash
openclaw agent exec "Run the focused tests and fix failures"
openclaw agent exec --message-file task.md --cwd ./repo
cat task.md | openclaw agent exec --message-file - --json
```

By default, the command creates and later removes a temporary state directory, and it runs against your ordinary OpenClaw config, so configured providers, credentials, and `agentRuntime` harness selection apply exactly as they do elsewhere. `--cwd` defaults to the process working directory and is passed as both the agent workspace and tool working directory.

Config is layered in three parts, entirely in memory: exec composes the run config and publishes it as this process's runtime config rather than writing a copy to disk. Exec defaults apply only where your config leaves a setting unset: workspace bootstrap files are skipped, the agent sandbox is off, the `coding` tool profile is selected, filesystem tools are restricted to `--cwd`, and exec runs under the full execution policy a headless turn needs. Anything your config sets wins over those defaults, so a configured sandbox, shell env, or tool profile is never downgraded, and exec host routing stays with the sandbox when your config enables one. The invocation itself always wins last: the run is scoped to `--cwd` and never bootstraps.

Use `--state-dir <dir>` to retain sessions and other run state. The directory must already exist and is never created or deleted by the command. A retained state directory requires exclusive ownership: exec refuses to start while a Gateway or another embedded writer owns it, then holds the state lock for the complete run. Omit `--state-dir` for isolated temporary state, or stop the Gateway first with `openclaw gateway stop`.

When exec uses the ambient or a pinned config, installed plugins continue to resolve from the operator's ordinary plugin roots while sessions and other run state use the ephemeral directory. In those modes, `--state-dir` controls run state only; it is not required for configured providers, channels, or harnesses supplied by installed plugins.

For reproducible runs, pin the config instead of inheriting it. `--config <path>` runs against exactly that config file, read through the normal loader so JSON5 syntax and `$include` resolve relative to it; a missing or invalid file fails the run rather than falling back to defaults, as does an ambient config that exists but cannot be parsed. `--isolated` ignores the ambient config entirely and uses only the exec defaults above. Both are the right choice for CI, where inheriting operator state would make runs machine-dependent.

Stored credentials are used by default, so a folder-scoped run reaches the same logins as the rest of the CLI. Pass `--auth-env-only` to restrict the run to provider keys already present in the process environment. That mode loads no config at all, and pairing it with `--config` is rejected rather than silently ignored, because a config supplies provider credentials through several surfaces at once: [inline keys and secret headers](/reference/secretref-credential-surface), an `env` block, and login-shell import. It also skips OpenClaw auth profiles and external Codex, Claude, or other CLI credential stores. Provider auth variables remain available to model authentication but are omitted from agent-launched host commands.

Select a primary and ordered fallback chain with repeatable flags:

```bash
openclaw agent exec "Implement the change" \
  --model openai/gpt-5.6-sol \
  --fallback anthropic/claude-sonnet-4-6 \
  --fallback google/gemini-3.1-pro-preview
```

For this command only, explicit `--fallback` values remain active with explicit `--model`. Other agent entry points keep their existing rule that a user-selected model disables configured fallbacks.

Select the one-shot tool surface explicitly when comparing local or smaller models:

```bash
openclaw agent exec "Inspect this repository" \
  --model ollama/qwen3.5:9b \
  --code-mode code \
  --local-model-lean \
  --json
```

`--code-mode direct` disables Code Mode, `auto` uses model capability metadata, and `code` forces the generic Code Mode surface for tool-capable runs. `--local-model-lean` removes high-latency and channel-dependent tools and enables the bounded Tool Search defaults for the isolated run.

The timeout defaults to 600 seconds for `agent exec`; this does not change the existing embedded `agent --local` default. A successful run exits `0`, any model or result error exits `1`, and a timeout exits `2`. Failure includes `meta.error`, aborted runs, exhausted model fallbacks, an error stop reason, and any error payload.

Plain output writes only the final assistant text to stdout. Diagnostics use stderr. `--json` reserves stdout for this stable envelope:

```json
{
  "ok": true,
  "status": "ok",
  "final": "The focused tests pass.",
  "payloads": [{ "text": "The focused tests pass." }],
  "usage": { "input": 120, "output": 8, "total": 128 },
  "costUsd": 0.0021,
  "codeModeEngaged": false,
  "assistantTurns": 2,
  "bridgeCalls": { "search": 1, "describe": 0, "call": 3 },
  "toolSummary": { "calls": 2, "tools": ["read", "write"], "totalToolTimeMs": 48 },
  "model": "gpt-5.6-sol",
  "provider": "openai",
  "sessionId": "019..."
}
```

`status` is `ok`, `error`, or `timeout`. `usage` is omitted when unavailable. Failed envelopes add `error: { message, kind }`; `model` and `provider` are `null` when failure happens before model selection.

Run-stat fields are additive and may be absent:

- `costUsd`: estimated USD cost of the run's accumulated usage, including cache read/write pricing; omitted when the model has no cost data.
- `codeModeEngaged`: `true` only when [code mode](/tools/code-mode) actually owned the model tool surface for the run. `tools.codeMode.enabled=true` alone does not guarantee engagement, and harnesses that own their native tool surface always read `false` because OpenClaw code mode never owns their tools.
- `assistantTurns`: completed assistant/provider round trips in the run; omitted when none completed.
- `bridgeCalls`: inner tool-search/code-mode bridge call counts (`search`/`describe`/`call`). These are invisible to the provider; outer tool calls stay in `meta.toolSummary.calls` of the full run metadata.
- `toolSummary`: outer model-visible tool-call count, tool names, failures, and total tool time from the embedded run.

The agent run-stat fields appear on `meta.agentMeta` in the `openclaw agent --json` response; the outer tool summary remains at `meta.toolSummary`.

### Code Mode model matrix

From a source checkout, run the bounded evaluation matrix against any explicit model reference:

```bash
pnpm qa:code-mode-models -- --model ollama/qwen3.5:9b
```

Repeat `--model` to compare models, or use `--mode`, `--task`, and `--repetitions` to narrow the default direct/automatic/forced Code Mode matrix. Each cell runs an isolated `agent exec` task and records model/provider identity, timing, result status, failure class, outer tool calls, Code Mode bridge calls, and verified output/effects.

The output directory contains canonical QA Lab `qa-evidence.json`. `summary.json` and `results.jsonl` are supporting aggregate and per-cell artifacts; `manifest.json` records the requested matrix and source identity.

This is evaluation-only evidence, not a CI or release gate. Results do not change model capabilities, runtime routing, fallback, or repair policy.

### `agent exec` options

- `[message]`: positional prompt text
- `--message-file <path>`: read a UTF-8 prompt from a file; `-` reads stdin
- `--cwd <dir>`: set both the agent workspace and tool working directory
- `--state-dir <dir>`: use an existing state directory without deleting it
- `--config <path>`: run against this config file instead of the ambient config (JSON5 and `$include` supported)
- `--isolated`: ignore the ambient config and use only exec defaults
- `--model <provider/model>`: explicit primary model
- `--code-mode <mode>`: select `direct`, `auto`, or forced `code` tool mode
- `--local-model-lean`: use the reduced local-model tool surface
- `--also-allow-tool <name>`: allow one additional tool for this run; repeatable, and extends an existing strict `tools.allow` list when present
- `--thinking <level>`: one-run thinking level
- `--fallback <provider/model>`: ordered fallback model; repeatable and requires `--model`
- `--auth-env-only`: use only environment provider keys; skips stored credentials, external CLI credentials, and config entirely
- `--no-auth-env-only`: allow stored and external CLI credentials (default)
- `--timeout <seconds>`: deadline in seconds (default `600`; `0` disables it)
- `--json`: emit the stable JSON envelope

## Options

- `-m, --message <text>`: message body
- `--message-file <path>`: read the message body from a UTF-8 file
- `-t, --to <dest>`: recipient used to derive the session key
- `--session-key <key>`: explicit session key to use for routing
- `--session-id <id>`: explicit session id
- `--agent <id>`: agent id; overrides routing bindings
- `--model <id>`: model override for this run (`provider/model` or model id)
- `--thinking <level>`: agent thinking level (`off`, `minimal`, `low`, `medium`, `high`, plus provider-supported custom levels such as `xhigh`, `adaptive`, or `max`)
- `--verbose <on|off>`: persist verbose level for the session
- `--channel <channel>`: delivery channel; omit to use the main session channel
- `--reply-to <target>`: delivery target override
- `--reply-channel <channel>`: delivery channel override
- `--reply-account <id>`: delivery account override
- `--local`: run the embedded agent directly (after plugin registry preload)
- `--deliver`: send the reply back to the selected channel/target
- `--timeout <seconds>`: override this command's agent-turn deadline (default 600, or `agents.defaults.timeoutSeconds`); `0` disables the overall deadline. The 600-second fallback belongs to this CLI command, not ordinary Gateway turns, whose default is 48 hours.
- `--json`: output JSON

## Examples

```bash
openclaw agent --to +15555550123 --message "status update" --deliver
openclaw agent --agent ops --message "Summarize logs"
openclaw agent --agent ops --message-file ./task.md
openclaw agent --agent ops --model openai/gpt-5.4 --message "Summarize logs"
openclaw agent --session-key agent:ops:incident-42 --message "Summarize status"
openclaw agent --agent ops --session-key incident-42 --message "Summarize status"
openclaw agent --session-id 1234 --message "Summarize inbox" --thinking medium
openclaw agent --to +15555550123 --message "Trace logs" --verbose on --json
openclaw agent --agent ops --message "Generate report" --deliver --reply-channel slack --reply-to "#reports"
openclaw agent --agent ops --message "Run locally" --local
```

## Notes

- Pass exactly one of `--message` or `--message-file`. `--message-file` strips a leading UTF-8 BOM and preserves multiline content; it rejects files that are not valid UTF-8. Files larger than 4 MiB are rejected before dispatch.
- `--message` does not run the channel slash-command dispatcher. Recognized `$skill-name` references and leading `/skill-name [input]` are the scoped exception: OpenClaw expands them into model instructions to read the skill before acting. Other slash-prefixed messages keep normal agent-turn behavior; `/compact` is rejected with a pointer to `openclaw sessions compact <key>`.
- `--local` runs are one-shot: bundled MCP loopback resources and warm Claude stdio sessions opened for the run are retired after the reply, so scripted invocations do not leave local child processes running. Gateway-backed runs keep Gateway-owned MCP loopback resources under the running Gateway process instead.
- `--local` requires exclusive ownership of the configured state directory. It refuses to start while a Gateway or another `agent --local` run owns that directory, then holds the same state lock for the full embedded turn. Run without `--local` to use the active Gateway, or stop it first with `openclaw gateway stop`.
- Standalone embedded execution with `--local` refuses to reuse an existing main session while restart recovery is pending. Run the turn through a healthy Gateway, or reset it there with `/new` or `/reset`; an independent embedded process cannot safely coordinate that recovery owner with the Gateway scanner.
- With `--agent`, `--channel` and `--to` together, session routing follows the channel's canonical recipient and `session.dmScope`. Channels with a stable outbound-only recipient identity use a provider-owned session isolated from the agent's main session. `--reply-channel` and `--reply-account` affect delivery only.
- `--session-key` selects an explicit session key. Agent-prefixed keys must use `agent:<agent-id>:<session-key>`, and `--agent` must match the key's agent id when both are given. Bare non-sentinel keys scope to `--agent` when supplied, or to the configured default agent otherwise; for example `--agent ops --session-key incident-42` routes to `agent:ops:incident-42`. The literal keys `global` and `unknown` stay unscoped only when no `--agent` is supplied.
- `--json` reserves stdout for the JSON response; Gateway, plugin, and `--local` diagnostics go to stderr so scripts can parse stdout directly.
- After transient handshake retries are exhausted, a Gateway timeout or closed connection fails the command; the CLI never silently reruns the turn embedded. Transport loss is ambiguous — the Gateway may have accepted and may still finish the turn — so the stderr hint says to check `openclaw gateway status` and the session transcript before retrying or rerunning with `--local`, to avoid executing the turn twice.
- `SIGTERM`/`SIGINT` interrupt a waiting Gateway-backed request; if the Gateway already accepted the run, the CLI also sends `chat.abort` for that run id before exiting. `--local` runs receive the same signal but do not send `chat.abort`. A launcher child that terminates from the first forwarded `SIGINT` or `SIGTERM` exits with status 130 or 143, respectively. If the internal run-dedup key already has an active run for this session, the response reports `status: "in_flight"` and the non-JSON CLI prints a stderr diagnostic instead of an empty reply. For external cron/systemd wrappers, keep a hard-kill backstop such as `timeout -k 60 600 openclaw agent ...` so the supervisor can reap the process if shutdown cannot drain.
- When this command triggers `models.json` regeneration, SecretRef-managed provider credentials are persisted as non-secret markers (for example env var names, `secretref-env:ENV_VAR_NAME`, or `secretref-managed`), never resolved secret plaintext. Marker writes come from the active source config snapshot, not from resolved runtime secret values.

## JSON delivery status

With `--json --deliver`, the CLI JSON response includes top-level `deliveryStatus` so scripts can distinguish delivered, suppressed, partial, and failed sends:

```json
{
  "payloads": [{ "text": "Report ready", "mediaUrl": null }],
  "meta": { "durationMs": 1200 },
  "deliveryStatus": {
    "requested": true,
    "attempted": true,
    "status": "sent",
    "succeeded": true,
    "resultCount": 1
  }
}
```

Gateway-backed CLI responses also preserve the raw Gateway result shape at `result.deliveryStatus`.

`deliveryStatus.status` is one of:

| Status           | Meaning                                                                                                                                    |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `sent`           | Delivery completed.                                                                                                                        |
| `suppressed`     | Delivery was intentionally not sent (for example a message-sending hook cancelled it, or there was no visible result). Terminal, no retry. |
| `partial_failed` | At least one payload sent before a later payload failed.                                                                                   |
| `failed`         | No durable send completed, or delivery preflight failed.                                                                                   |

Common fields:

- `requested`: always `true` when the object is present.
- `attempted`: `true` once the durable send path ran; `false` for preflight failures or no visible payloads.
- `succeeded`: `true`, `false`, or `"partial"`; `"partial"` pairs with `status: "partial_failed"`.
- `reason`: lowercase snake-case reason from durable delivery or preflight validation. Known values include `cancelled_by_message_sending_hook`, `no_visible_payload`, `no_visible_result`, `channel_resolved_to_internal`, `unknown_channel`, `invalid_delivery_target`, and `no_delivery_target`; failed durable sends may also report the failed stage. Treat unknown values as opaque since the set can expand.
- `resultCount`: number of channel send results, when available.
- `sentBeforeError`: `true` when a partial failure sent at least one payload before erroring.
- `error`: `true` for failed or partial-failed sends.
- `errorMessage`: present only when an underlying delivery error message was captured. Preflight failures carry `error`/`reason` but no `errorMessage`.
- `payloadOutcomes`: optional per-payload results with `index`, `status`, `reason`, `resultCount`, `error`, `stage`, `sentBeforeError`, or hook metadata when available.

## Related

- [CLI reference](/cli)
- [Agent runtime](/concepts/agent)
