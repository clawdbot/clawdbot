---
summary: "CLI reference for `openclaw attach` (launch Claude Code with a scoped Gateway MCP grant)"
read_when:
  - You want Claude Code to use OpenClaw Gateway MCP tools
  - You need a temporary session-bound MCP grant for an external harness
title: "Attach CLI"
---

`openclaw attach` launches Claude Code with a strict temporary MCP config bound to one Gateway session.

```sh
openclaw attach [target]
```

`target` accepts a Control UI session URL, a compact `host/agent/ref`, a bare
short reference, or a literal `agent:...` session key. A URL or host target
authoritatively selects that Gateway; a bare reference uses the configured or
default Gateway.

```sh
openclaw attach
openclaw attach https://gateway.example/dashboard/main/movies-a1166b81
openclaw attach movies-a1166b81
openclaw attach --session agent:main:telegram:123 --ttl 600000
openclaw attach --print-config
```

Options:

- `--session <key>` binds the grant to a Gateway session. Defaults to the main session.
- `--url <url>` selects a Gateway for a bare reference or `--session` key. Do
  not combine it with a URL target.
- `--token <token>` and `--password <password>` provide explicit Gateway auth.
- `--tls-fingerprint <sha256>` pins the Gateway TLS certificate.
- `--ttl <ms>` requests a positive grant TTL in milliseconds. The Gateway applies its own ceiling.
- `--bin <path>` selects the Claude Code binary. Default: `claude`.
- `--print-config` writes the temporary `.mcp.json`, prints the launch command and env, and leaves the grant live until TTL expiry (it does not spawn Claude Code or revoke the grant).

Pass either a positional target or `--session`, not both. Short references are
resolved before the scoped attach grant is minted; a missing session is never
created implicitly.

A URL or host target never reuses configured credentials or
`OPENCLAW_GATEWAY_TOKEN` / `OPENCLAW_GATEWAY_PASSWORD`. It uses the stored
device token for that exact Gateway origin, or explicit `--token`/`--password`
credentials. On first contact, pass one of those credentials once, approve the
pairing request in that Gateway's Control UI, and retry; see
[Devices](/cli/devices). Session URLs must stay credential-free: userinfo and
sensitive query or fragment parameters such as `token` and `password` are
rejected.

Target resolution uses the same [session target error matrix](/cli/tui#session-target-errors)
as `openclaw tui`.

The bearer token is passed through environment variables, not argv. OpenClaw launches Claude Code with `--strict-mcp-config --mcp-config <path>` so ambient Claude MCP servers do not join the attached session. Normal launches (without `--print-config`) revoke the grant when the Claude Code process exits.

If an attached tool asks a structured question, answer it through the question
controls in the Control UI or native app. An attach grant scopes tools to a
session but does not identify an active OpenClaw run or its original caller
permissions, so ordinary channel text cannot claim that question. See
[Ask user](/tools/ask-user).

See also: [Control UI URLs](/web/urls), [Devices](/cli/devices), [Gateway CLI](/cli/gateway), [MCP CLI](/cli/mcp), and [ACP CLI](/cli/acp).
