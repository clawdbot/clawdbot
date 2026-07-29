---
summary: "Connect MCP servers to OpenClaw from Settings, the CLI, or config"
title: "Connect MCP servers"
read_when:
  - Adding an MCP server for OpenClaw agents
  - Choosing between Settings and `openclaw mcp`
  - Troubleshooting MCP transport, OAuth, or tool discovery
---

The Model Context Protocol (MCP) is how an agent borrows tools from another program: an MCP server exposes tools, resources, and prompts, and OpenClaw connects to it and makes those tools available to your agents. Server definitions live under `mcp.servers` in config, and the tools they expose go through the same tool-profile and tool-policy controls as everything else — connecting a server does not bypass your policy.

<Note>
This guide is about connecting third-party MCP servers **to OpenClaw**. For the reverse — exposing OpenClaw channel conversations to another MCP client — use [`openclaw mcp serve`](/cli/mcp#openclaw-as-an-mcp-server).
</Note>

## Add a server from Settings

1. Open the Control UI and go to **Settings → MCP**.
2. Under **Configured servers**, select **Add server**.
3. Give it a unique name and pick a transport: **Streamable HTTP**, **SSE**, or **Stdio**.
4. For the HTTP transports, enter the server's `http://` or `https://` URL. For stdio, enter the command followed by its arguments.
5. Select **Add server**.

That writes the new `mcp.servers` entry through the Gateway. For anything beyond the basics — headers, environment values, OAuth metadata, TLS settings, timeouts, parallel-tool-call hints, tool filters — use the scoped config editor further down the page. The server rows also let you enable, disable, or remove a definition.

Once the server is saved, verify it actually answers:

```bash
openclaw mcp doctor <name> --probe
```

Saving a definition proves nothing about reachability — the probe does. Note that already-running Gateway or agent processes may need a restart or runtime reload before they pick up the new definition.

## Add a server from the CLI

A local stdio server:

```bash
openclaw mcp add local-tools \
  --command node \
  --arg ./dist/mcp-server.js \
  --cwd /srv/openclaw-tools
openclaw mcp doctor local-tools --probe
```

A remote Streamable HTTP server, exposing only some of its tools:

```bash
openclaw mcp add docs \
  --url https://mcp.example.com/mcp \
  --transport streamable-http \
  --include 'search,read_*'
openclaw mcp doctor docs --probe
```

Useful companions: `openclaw mcp status --verbose` for a config-only summary, `openclaw mcp probe <name>` for live capabilities, and `openclaw mcp login <name>` when an HTTP server uses OAuth. The [MCP CLI reference](/cli/mcp) documents every command, flag, and output shape, plus the separate `mcp serve` bridge.

## Configure a server directly

The same `docs` server, written straight into config:

```json5
{
  mcp: {
    servers: {
      docs: {
        url: "https://mcp.example.com/mcp",
        transport: "streamable-http",
        enabled: true,
        connectionTimeoutMs: 5000,
        requestTimeoutMs: 20000,
        toolFilter: {
          include: ["search", "read_*"],
        },
      },
    },
  },
}
```

An enabled server needs either a command (stdio) or a URL (SSE or Streamable HTTP). Setting `enabled: false` keeps the definition around without connecting it. Keep credentials out of config literals — store sensitive headers and environment values through the supported secret mechanisms.

## Troubleshooting

### The server appears in Settings but exposes no tools

Run `openclaw mcp doctor <name> --probe`. Doctor validates the saved definition first, then opens a live connection and reports the tools and other capabilities the server advertises. If it connects but expected tools are missing, check `toolFilter.include` and `toolFilter.exclude`.

### A stdio server does not start

Confirm the `command` resolves in the Gateway process environment and that `cwd` exists. Arguments belong in `args`, and an explicit `transport: "stdio"` requires a non-empty command.

### An HTTP server needs authorization

Set `auth: "oauth"` plus any required `oauth` metadata, then:

```bash
openclaw mcp login <name>
```

Follow the printed authorization URL and rerun with `--code` when prompted.

### Changes do not reach an active agent

`openclaw mcp reload` refreshes runtimes owned by the current CLI process. A Gateway or agent running elsewhere needs its own reload, config publish, or restart.

## Related

- [MCP CLI reference](/cli/mcp)
- [Manage plugins](/plugins/manage-plugins)
- [Tool policies](/tools)
