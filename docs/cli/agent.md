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

Related: [Agent send tool](/tools/agent-send)

## `agent exec`

`openclaw agent exec` runs one embedded agent turn without connecting to a Gateway. It is the recommended headless entry point for CI and coding automation because it owns setup, cleanup, output projection, and process status.

```bash
openclaw agent exec "Run the focused tests and fix failures"
openclaw agent exec --message-file task.md --cwd ./repo
cat task.md | openclaw agent exec --message-file - --json
```

By default, the command creates and later removes a temporary state directory. Its implicit config skips workspace bootstrap files, disables the agent sandbox, selects the `coding` tool profile, restricts filesystem tools to `--cwd`, and enables full Gateway-host execution policy for the embedded local tool runtime. `--cwd` defaults to the process working directory and is passed as both the agent workspace and tool working directory.

Use `--state-dir <dir>` to retain sessions and other run state. The directory must already exist and is never created or deleted by the command. The command still uses its isolated implicit policy config; it does not read the ordinary OpenClaw config from that directory.

`--auth-env-only` is enabled by default. In this mode, the run can use provider keys already present in the process environment, but it does not load OpenClaw auth profiles or external Codex, Claude, or other CLI credential stores. Provider auth variables remain available to model authentication but are omitted from agent-launched host commands. Use `--no-auth-env-only` only when the run intentionally relies on those stored credentials.

Select a primary and ordered fallback chain with repeatable flags:

```bash
openclaw agent exec "Implement the change" \
  --model openai/gpt-5.6-sol \
  --fallback anthropic/claude-sonnet-4-6 \
  --fallback google/gemini-3.1-pro-preview
```

For this command only, explicit `--fallback` values remain active with explicit `--model`. Other agent entry points keep their existing rule that a user-selected model disables configured fallbacks.

The timeout defaults to 600 seconds for `agent exec`; this does not change the existing embedded `agent --local` default. A successful run exits `0`, any model or result error exits `1`, and a timeout exits `2`. Failure includes `meta.error`, aborted runs, exhausted model fallbacks, an error stop reason, and any error payload.

Plain output writes only the final assistant text to stdout. Diagnostics use stderr. `--json` reserves stdout for this stable envelope:

```json
{
  "ok": true,
  "status": "ok",
  "final": "The focused tests pass.",
  "payloads": [{ "text": "The focused tests pass." }],
  "usage": { "input": 120, "output": 8, "total": 128 },
  "model": "gpt-5.6-sol",
  "provider": "openai",
  "sessionId": "019..."
}
```

`status` is `ok`, `error`, or `timeout`. `usage` is omitted when unavailable. Failed envelopes add `error: { message, kind }`; `model` and `provider` are `null` when failure happens before model selection.

### `agent exec` options

- `[message]`: positional prompt text
- `--message-file <path>`: read a UTF-8 prompt from a file; `-` reads stdin
- `--cwd <dir>`: set both the agent workspace and tool working directory
- `--state-dir <dir>`: use an existing state directory without deleting it
- `--model <provider/model>`: explicit primary model
- `--thinking <level>`: one-run thinking level
- `--fallback <provider/model>`: ordered fallback model; repeatable and requires `--model`
- `--auth-env-only`: ignore stored and external CLI credentials (default)
- `--no-auth-env-only`: allow stored and external CLI credentials
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
- Slash commands (for example `/compact`) cannot run through `--message`. The CLI rejects them and points you at the first-class command instead (`openclaw sessions compact <key>` for compaction).
- `--local` runs are one-shot: bundled MCP loopback resources and warm Claude stdio sessions opened for the run are retired after the reply, so scripted invocations do not leave local child processes running. Gateway-backed runs keep Gateway-owned MCP loopback resources under the running Gateway process instead.
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
