---
summary: "CLI reference for `openclaw agent` (send one agent turn via the Gateway)"
read_when:
  - You want to run one agent turn from scripts (optionally deliver reply)
title: "Agent"
---

# `openclaw agent`

Run one agent turn through the Gateway. Falls back to the embedded agent if the Gateway request fails; pass `--local` to force embedded execution up front.

Pass at least one session selector: `--to`, `--session-key`, `--session-id`, or `--agent`.

Related: [Agent send tool](/tools/agent-send)

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
- `--local` and embedded fallback runs are one-shot: bundled MCP loopback resources and warm Claude stdio sessions opened for the run are retired after the reply, so scripted invocations do not leave local child processes running. Gateway-backed runs keep Gateway-owned MCP loopback resources under the running Gateway process instead.
- Standalone embedded execution (`--local` and transport fallback) refuses to reuse an existing main session while restart recovery is pending. Run the turn through a healthy Gateway, or reset it there with `/new` or `/reset`; an independent embedded process cannot safely coordinate that recovery owner with the Gateway scanner.
- With `--agent`, `--channel` and `--to` together, session routing follows the channel's canonical recipient and `session.dmScope`. Channels with a stable outbound-only recipient identity use a provider-owned session isolated from the agent's main session. `--reply-channel` and `--reply-account` affect delivery only.
- `--session-key` selects an explicit session key. Agent-prefixed keys must use `agent:<agent-id>:<session-key>`, and `--agent` must match the key's agent id when both are given. Bare non-sentinel keys scope to `--agent` when supplied, or to the configured default agent otherwise; for example `--agent ops --session-key incident-42` routes to `agent:ops:incident-42`. The literal keys `global` and `unknown` stay unscoped only when no `--agent` is supplied.
- `--json` reserves stdout for the JSON response; Gateway, plugin, and embedded-fallback diagnostics go to stderr so scripts can parse stdout directly.
- Embedded fallback JSON includes `meta.transport: "embedded"` and `meta.fallbackFrom: "gateway"` so scripts can detect a fallback run.
- If the Gateway accepts a run but the CLI times out waiting for the final reply, embedded fallback uses a fresh `gateway-fallback-*` session/run id and reports `meta.fallbackReason: "gateway_timeout"` plus the fallback session fields, instead of racing the Gateway-owned transcript or silently replacing the original session.
- `SIGTERM`/`SIGINT` interrupt a waiting Gateway-backed request; if the Gateway already accepted the run, the CLI also sends `chat.abort` for that run id before exiting. `--local` and embedded fallback runs receive the same signal but do not send `chat.abort`. If the internal run-dedup key already has an active run for this session, the response reports `status: "in_flight"` and the non-JSON CLI prints a stderr diagnostic instead of an empty reply. For external cron/systemd wrappers, keep a hard-kill backstop such as `timeout -k 60 600 openclaw agent ...` so the supervisor can reap the process if shutdown cannot drain.
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
