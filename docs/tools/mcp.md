---
summary: "Connect MCP servers to OpenClaw from Settings, the CLI, or config"
title: "Connect MCP servers"
read_when:
  - Adding an MCP server for OpenClaw agents
  - Choosing between Settings and `openclaw mcp`
  - Troubleshooting MCP transport, OAuth, or tool discovery
---

The Model Context Protocol (MCP) lets an agent use tools, resources, and prompts exposed by another process or service. OpenClaw keeps outbound server definitions under `mcp.servers`, connects eligible runtimes to enabled servers, and applies normal tool-profile and tool-policy controls to the tools they expose.

<Note>
This guide connects third-party MCP servers **to OpenClaw**. To expose OpenClaw channel conversations to another MCP client, use [`openclaw mcp serve`](/cli/mcp#openclaw-as-an-mcp-server).
</Note>

## Add a server from Settings

1. Open the Control UI and choose **Settings → MCP**.
2. In **Configured servers**, select **Add server**.
3. Enter a unique name and choose **Streamable HTTP**, **SSE**, or **Stdio**.
4. For HTTP transports, enter an `http://` or `https://` URL. For stdio, enter the command followed by its arguments.
5. Select **Add server**.

The page saves the new `mcp.servers` entry through the Gateway config path. Use the scoped editor farther down the page for headers, environment values, OAuth metadata, TLS settings, timeouts, parallel-tool-call hints, or tool filters. Server rows can also enable, disable, or remove definitions.

Run a live probe after setup:

```bash
openclaw mcp doctor <name> --probe
```

Settings changes do not prove the remote service is reachable. Active Gateway or agent processes may also need a restart or runtime rebuild before they use the new definition.

## Add a server from the CLI

For a local stdio server:

```bash
openclaw mcp add local-tools \
  --command node \
  --arg ./dist/mcp-server.js \
  --cwd /srv/openclaw-tools
openclaw mcp doctor local-tools --probe
```

For a remote Streamable HTTP server:

```bash
openclaw mcp add docs \
  --url https://mcp.example.com/mcp \
  --transport streamable-http \
  --include 'search,read_*'
openclaw mcp doctor docs --probe
```

Use `openclaw mcp status --verbose` for a config-only summary, `openclaw mcp probe <name>` for live capabilities, and `openclaw mcp login <name>` when an HTTP server uses OAuth. The [MCP CLI reference](/cli/mcp) documents every command, flag, output shape, and the separate `mcp serve` bridge.

## Configure a server directly

This example registers a remote server and exposes only its read tools:

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

An enabled server needs either a command for stdio or a URL for SSE or Streamable HTTP. `enabled: false` keeps the definition but excludes it from embedded runtime discovery. Store sensitive headers and environment values through the supported secret mechanisms instead of committing literal credentials.

## Troubleshooting

### The server appears in Settings but exposes no tools

Run `openclaw mcp doctor <name> --probe`. Doctor checks the saved definition before opening a live connection; the probe then reports tools and other advertised capabilities. Check `toolFilter.include` and `toolFilter.exclude` if the server connects but expected tools remain hidden.

### A stdio server does not start

Confirm that `command` resolves in the Gateway process environment and that `cwd` exists. Arguments belong in `args`; an explicit `transport: "stdio"` requires a non-empty command.

### An HTTP server needs authorization

Set `auth: "oauth"` and any required `oauth` metadata, then run:

```bash
openclaw mcp login <name>
```

Follow the printed authorization URL and rerun with `--code` when requested.

### Changes do not reach an active agent

Run `openclaw mcp reload` for runtimes owned by the current CLI process. Gateway and agent processes in another process need their own reload, config publish, or restart path.

## Related

- [MCP CLI reference](/cli/mcp)
- [Manage plugins](/plugins/manage-plugins)
- [Tool policies](/tools)
