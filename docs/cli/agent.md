---
summary: "CLI reference for `openclaw agent` (send one agent turn via the Gateway)"
read_when:
  - You want to run one agent turn from scripts (optionally deliver reply)
title: "Agent"
---

# `openclaw agent`

Run an agent turn via the Gateway (use `--local` for embedded).
Use `--agent <id>` to target a configured agent directly.

Pass at least one session selector:

- `--to <dest>`
- `--session-id <id>`
- `--agent <id>`

Related:

- Agent send tool: [Agent send](/tools/agent-send)

## Options

- `-m, --message <text>`: required message body
- `-t, --to <dest>`: recipient used to derive the session key
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
- `--timeout <seconds>`: override agent timeout (default 600 or config value)
- `--json`: output JSON

## Examples

```bash
openclaw agent --to +15555550123 --message "status update" --deliver
openclaw agent --agent ops --message "Summarize logs"
openclaw agent --agent ops --model openai/gpt-5.4 --message "Summarize logs"
openclaw agent --session-id 1234 --message "Summarize inbox" --thinking medium
openclaw agent --to +15555550123 --message "Trace logs" --verbose on --json
openclaw agent --agent ops --message "Generate report" --deliver --reply-channel slack --reply-to "#reports"
openclaw agent --agent ops --message "Run locally" --local
```

## Notes

- Gateway mode falls back to the embedded agent when the Gateway request fails. Use `--local` to force embedded execution up front.
- `--local` still preloads the plugin registry first, so plugin-provided providers, tools, and channels stay available during embedded runs.
- `--local` and embedded fallback runs are treated as one-shot runs. Bundled MCP loopback resources and warm Claude stdio sessions opened for that local process are retired after the reply, so scripted invocations do not keep local child processes alive.
- Gateway-backed runs leave Gateway-owned MCP loopback resources under the running Gateway process; older clients may still send the historical cleanup flag, but the Gateway accepts it as a compatibility no-op.
- `--channel`, `--reply-channel`, and `--reply-account` affect reply delivery, not session routing.
- `--json` keeps stdout reserved for the JSON response. Gateway, plugin, and embedded-fallback diagnostics are routed to stderr so scripts can parse stdout directly.
- Embedded fallback JSON includes `meta.transport: "embedded"` and `meta.fallbackFrom: "gateway"` so scripts can distinguish fallback runs from Gateway runs.
- If the Gateway accepts an agent run but the CLI times out waiting for the final reply, embedded fallback uses a fresh explicit `gateway-fallback-*` session/run id and reports `meta.fallbackReason: "gateway_timeout"` plus the fallback session fields. This avoids racing the Gateway-owned transcript lock or silently replacing the original routed conversation session.
- When this command triggers `models.json` regeneration, SecretRef-managed provider credentials are persisted as non-secret markers (for example env var names, `secretref-env:ENV_VAR_NAME`, or `secretref-managed`), not resolved secret plaintext.
- Marker writes are source-authoritative: OpenClaw persists markers from the active source config snapshot, not from resolved runtime secret values.

## Related

- [CLI reference](/cli)
- [Agent runtime](/concepts/agent)
