---
summary: "Run OpenClaw through ACP over stdio"
read_when:
  - Setting up ACP clients such as Buzz or an IDE
  - Debugging OpenClaw ACP execution or permissions
title: "ACP"
---

OpenClaw exposes two [Agent Client Protocol (ACP)](https://agentclientprotocol.com/)
stdio runtimes.

The existing command remains a bridge to an already-running Gateway:

```bash
openclaw acp
```

ACP hosts that need a self-contained process should launch:

```bash
openclaw-acp
# equivalent:
openclaw acp native
```

The distinct executable is the native-capability marker. Older OpenClaw
releases may provide `openclaw acp`, but they do not provide `openclaw-acp`.

Native ACP creates OpenClaw agent turns in the ACP process by using the same
configured models, sessions, tools, workspace, and execution policy as other
local OpenClaw surfaces. It does not connect to or start a Gateway.

This process ownership matters for ACP hosts such as Buzz: environment supplied
to the child process remains available to the tools that run the turn.

## Contract

`openclaw-acp` implements this runtime contract:

- transport: ACP over stdio
- agent execution: in process
- Gateway required: no
- sessions: one OpenClaw session per ACP session
- tools: normal local OpenClaw tool policy
- exec approvals: relayed through ACP `session/request_permission`
- plugin approvals: relayed through ACP `session/request_permission`
- model authentication: normal OpenClaw model configuration
- delivery: ACP returns protocol output; tools may use credentials inherited by
  the ACP process for external delivery

Hosts can inspect the contract without starting the ACP server:

```bash
openclaw acp info
```

Example output:

```json
{
  "schemaVersion": 1,
  "protocol": "acp",
  "transport": "stdio",
  "execution": "in-process",
  "gatewayRequired": false
}
```

## Model setup

Configure and authenticate an OpenClaw model before starting a session:

```bash
openclaw-acp --configure-model
```

ACP clients that support terminal authentication receive this setup flow as an
advertised authentication method.

## Supported ACP surface

| ACP area                               | Status      | Notes                                                                                         |
| -------------------------------------- | ----------- | --------------------------------------------------------------------------------------------- |
| `initialize`                           | Implemented | Advertises text, image, embedded context, session close, and terminal model setup.            |
| `session/new`                          | Implemented | Creates an isolated session for the configured default OpenClaw agent.                        |
| `session/prompt`                       | Implemented | Runs the canonical OpenClaw agent loop in the ACP process and streams assistant/thought text. |
| `session/cancel`                       | Implemented | Aborts the active OpenClaw turn for the ACP session.                                          |
| `session/close`                        | Implemented | Cancels active work and releases the ACP session binding.                                     |
| Prompt text/resources/images           | Implemented | Text and embedded resources become prompt text; images use normal multimodal input.           |
| Exec and plugin permissions            | Implemented | Requests are sent to the ACP client and fail closed when unavailable or expired.              |
| Client-supplied MCP servers            | Unsupported | Configure MCP through OpenClaw instead.                                                       |
| Additional client workspace roots      | Unsupported | The ACP session uses its absolute `cwd`.                                                      |
| Session list/load/resume               | Unsupported | Native v1 owns sessions created by the current ACP process.                                   |
| ACP client filesystem/terminal methods | Unsupported | OpenClaw tools execute locally in the ACP process.                                            |

## Gateway bridge

The shipped Gateway-backed behavior remains the default:

```bash
openclaw acp
```

Use this mode only when the ACP client should attach to an existing local or
remote OpenClaw Gateway. The bridge does not start a Gateway.

```bash
# Remote Gateway
openclaw acp \
  --url wss://gateway-host:18789 \
  --token-file ~/.openclaw/gateway.token

# Existing Gateway session
openclaw acp --session agent:main:main
```

`openclaw acp gateway` is an explicit alias for the same bridge.

Gateway bridge options:

- `--url <url>`
- `--token <token>` / `--token-file <path>`
- `--password <password>` / `--password-file <path>`
- `--session <key>` / `--session-label <label>`
- `--require-existing`
- `--reset-session`
- `--no-prefix-cwd`
- `--provenance <off|meta|meta+receipt>`
- `--verbose`

Prefer secret files or `OPENCLAW_GATEWAY_*` environment variables over inline
credentials. Inline values may be visible in process listings.

## ACP client debug

Use the built-in client for an interactive protocol check:

```bash
openclaw acp client --cwd /path/to/project
```

To test the explicit Gateway bridge:

```bash
openclaw acp client \
  --server-args gateway --url ws://127.0.0.1:18789
```

The debug client applies a narrow auto-approval policy for trusted read-only
tools. Exec-capable, mutating, unknown, and interactive tools still require a
permission response.

## Buzz

Buzz can register `openclaw-acp` as a first-class ACP runtime. Buzz launches
the command with the dedicated agent's `BUZZ_*` environment; OpenClaw tools run
in that same process and can use the Buzz CLI to publish the signed reply.

No Gateway URL, Gateway token, companion node, or separately managed Gateway is
part of this path.

Keep unattended ACP agents owner-only unless the host exposes a reviewed
permission policy. ACP hosts may answer permission requests without presenting
an interactive human prompt. Native ACP turns are always treated as non-owner
input, so owner-only tools remain unavailable; approving a tool call authorizes
only that call and does not attest the prompt sender's identity.

## IDE example

For Zed, add a custom ACP agent:

```json
{
  "agent_servers": {
    "OpenClaw ACP": {
      "type": "custom",
      "command": "openclaw-acp",
      "args": [],
      "env": {}
    }
  }
}
```

For a source checkout, invoke the direct CLI entrypoint so stdout remains a
clean ACP stream:

```bash
node openclaw.mjs acp native
```

## ACP versus ACP agents

- An ACP client wants OpenClaw to perform the turn: `openclaw-acp`.
- An ACP client wants an existing Gateway session: `openclaw acp`.
- OpenClaw should launch Codex, Claude, Gemini, or another external ACP
  harness: use `/acp spawn` and [ACP agents](/tools/acp-agents).

## Related

- [CLI reference](/cli)
- [ACP agents](/tools/acp-agents)
- [ACP agents setup](/tools/acp-agents-setup)
