---
summary: "CLI reference for `openclaw approvals` and `openclaw exec-policy`"
read_when:
  - You want to edit exec approvals from the CLI
  - You need to manage allowlists on gateway or node hosts
  - You need to list or resolve a pending approval without a chat surface
title: "Approvals"
---

# `openclaw approvals`

Manage exec approvals for the **local host**, **gateway host**, or a **node host**. With no target flag, commands read/write the local approvals file on disk. Use `--gateway` to target the gateway, or `--node <id|name|ip>` to target a specific node.

Alias: `openclaw exec-approvals`

Related: [Exec approvals](/tools/exec-approvals), [Nodes](/nodes)

## `openclaw exec-policy`

`openclaw exec-policy` is the **local-only** convenience command that keeps requested `tools.exec.*` config and the local host approvals file in sync in one step:

```bash
openclaw exec-policy show
openclaw exec-policy show --json

openclaw exec-policy preset yolo
openclaw exec-policy preset cautious --json

openclaw exec-policy set --host gateway --security full --ask off --ask-fallback full
```

Presets (`yolo`, `cautious`, `deny-all`) apply `host`, `security`, `ask`, and `askFallback` together. `set` applies only the flags you pass; each accepted value is validated (`--host auto|sandbox|gateway|node`, `--security deny|allowlist|full`, `--ask off|on-miss|always`, `--ask-fallback deny|allowlist|full`).

Scope:

- Updates the local config file and local approvals file together; does not push policy to the gateway or a node host.
- `--host node` is rejected: node exec approvals are fetched from the node at runtime, so local `exec-policy` cannot synchronize them. Use `openclaw approvals set --node <id|name|ip>` instead.
- `exec-policy show` marks `host=node` scopes as node-managed at runtime instead of deriving an effective policy from the local approvals file.

For remote host approvals, use `openclaw approvals set --gateway` or `openclaw approvals set --node <id|name|ip>` directly.

## Common commands

```bash
openclaw approvals get
openclaw approvals get --node <id|name|ip>
openclaw approvals get --gateway
openclaw approvals pending
openclaw approvals resolve <id> <allow-once|allow-always|deny>
```

`get` shows the effective exec policy for the target: the requested `tools.exec` policy, the host approvals-file policy, and the merged effective result. Nodes with a host-native policy, such as the Windows companion, show that policy directly instead of applying OpenClaw approvals-file policy math.

For file-backed nodes, the merged view requires a host-resolved policy snapshot. Older nodes show the effective policy as unavailable instead of assuming the Gateway's requested policy also applies on the host.

<Note>
Per-session `/exec` overrides are not included. Run `/exec` in the relevant session to inspect its current defaults.
</Note>

Precedence:

- The host approvals file is the enforceable source of truth.
- Requested `tools.exec` policy can narrow or broaden intent, but the effective result is derived from host rules.
- `--node` combines the node host approvals file with gateway `tools.exec` policy (both apply at runtime).
- If gateway config is unavailable, the CLI falls back to the node approvals snapshot and notes that the final runtime policy could not be computed.

## Pending approvals

List pending exec, plugin, and OpenClaw system-agent approvals from the Gateway:

```bash
openclaw approvals pending
openclaw approvals pending --json
```

Complete enumeration and the matching operator-wide `resolve` flow use `operator.admin` because approval records otherwise retain requester/reviewer filtering. Resolution also requests the dedicated `operator.approvals` scope. The standard CLI operator grant includes both scopes; a restricted third-party client should not request admin merely to emulate this command.

Human output shows the approval kind, agent/session attribution, request age, time until expiry, a shortened command or summary, and a shell-neutral `id64_<base64url>` id token. A `Full request text` block always follows the compact table with every complete token and a losslessly escaped request, so terminal-width shortening cannot hide a suffix or the token needed for resolution. Copy the complete token into `resolve`. Unsafe terminal characters in other fields are shown as visible Unicode escapes. JSON output returns normalized entries under `approvals`, preserving the original raw `id`, `summary`, `createdAtMs`, and `expiresAtMs` for scripts; raw ids remain accepted by `resolve` unless they use the reserved `id64_` display-token prefix.

If a supplied `id64_` value matches both a literal raw id and the decoded display token for another approval, the CLI rejects it as ambiguous instead of risking resolution of the wrong request.

Resolve one approval by its full id:

```bash
openclaw approvals resolve <id> allow-once
openclaw approvals resolve <id> allow-always
openclaw approvals resolve <id> deny --reason "Not expected during maintenance"
```

The CLI reads the unified approval record to select its kind, checks the requested decision against the record's allowed decisions, and then calls the unified resolver. A first successful decision exits `0`. Repeating the recorded decision also exits `0` and reports `already resolved (same decision)`. A conflicting decision, missing approval, expired approval, or decision unavailable for that approval kind prints a clear error and exits non-zero.

`--reason` adds a local note to the CLI confirmation. The current Gateway approval record has no free-text resolution-reason field, so this note is not persisted or sent to other approval surfaces.

## Replace approvals from a file

```bash
openclaw approvals set --file ./exec-approvals.json
openclaw approvals set --stdin <<'EOF'
{ version: 1, defaults: { security: "full", ask: "off", askFallback: "full" } }
EOF
openclaw approvals set --node <id|name|ip> --file ./exec-approvals.json
openclaw approvals set --gateway --file ./exec-approvals.json
```

`set` accepts JSON5, not only strict JSON. Use either `--file` or `--stdin`, not both.

Host-native Windows nodes use their own policy shape:

```bash
openclaw approvals set --node <id|name|ip> --stdin <<'EOF'
{
  defaultAction: "deny",
  rules: [{ pattern: "hostname", action: "allow" }]
}
EOF
```

The CLI reads the node's current hash first and sends it with the update, so concurrent local edits are rejected instead of overwritten. `rules` is required because this operation replaces the node's complete rule list; `defaultAction` is optional. A node that reports its native policy as disabled cannot be configured remotely; enable or configure the policy on that host first. Host-native policies do not support the `allowlist add|remove` helpers.

## "Never prompt" / YOLO example

Set the host approvals defaults to `full` + `off` for a host that should never stop on exec approvals:

```bash
openclaw approvals set --stdin <<'EOF'
{
  version: 1,
  defaults: {
    security: "full",
    ask: "off",
    askFallback: "full"
  }
}
EOF
```

For nodes that expose an OpenClaw approvals file, use the same body with `openclaw approvals set --node <id|name|ip> --stdin`. Host-native nodes require their owner-specific shape shown above.

This changes the **host approvals file** only. To keep the requested OpenClaw policy aligned, also set:

```bash
openclaw config set tools.exec.host gateway
openclaw config set tools.exec.mode full
```

`tools.exec.host=gateway` is explicit here because `host=auto` still means "sandbox when available, otherwise gateway": YOLO is about approvals, not routing. Use `gateway` (or `/exec host=gateway`) when you want host exec even with a sandbox configured.

Omitted `askFallback` defaults to `deny`. Set `askFallback: "full"` explicitly when upgrading a no-UI host that should keep never-prompt behavior.

Local shortcut for the same intent, on the local machine only:

```bash
openclaw exec-policy preset yolo
```

## Allowlist helpers

```bash
openclaw approvals allowlist add "~/Projects/**/bin/rg"
openclaw approvals allowlist add --agent main --node <id|name|ip> "/usr/bin/uptime"
openclaw approvals allowlist add --agent "*" "/usr/bin/uname"

openclaw approvals allowlist remove "~/Projects/**/bin/rg"
```

## Common options

`get`, `set`, and `allowlist add|remove` all support:

- `--node <id|name|ip>` (resolves id, name, IP, or id prefix; same resolver as `openclaw nodes`)
- `--gateway`
- shared node RPC options: `--url`, `--token`, `--timeout`, `--json`

No target flag means the local approvals file on disk.

`allowlist add|remove` also supports `--agent <id>` (defaults to `"*"`, applying to all agents).

`pending` and `resolve` always use the Gateway because pending requests are live Gateway state. They support the shared Gateway connection options `--url`, `--token`, and `--timeout`; `pending` also supports `--json`.

## Notes

- The node host must advertise `system.execApprovals.get/set` (macOS app, headless node host, or Windows companion).
- Approvals files are stored per host in the OpenClaw state dir: `$OPENCLAW_STATE_DIR/exec-approvals.json`, or `~/.openclaw/exec-approvals.json` when the variable is unset.

## Related

- [CLI reference](/cli)
- [Exec approvals](/tools/exec-approvals)
