---
summary: "Expose OpenClaw channel conversations over MCP and manage saved MCP server definitions"
read_when:
  - Connecting Codex, Claude Code, or another MCP client to OpenClaw-backed channels
  - Running `openclaw mcp serve`
  - Managing OpenClaw-saved MCP server definitions
title: "MCP"
sidebarTitle: "MCP"
---

`openclaw mcp` has two jobs:

- run OpenClaw as an MCP server with `openclaw mcp serve`
- manage OpenClaw-managed outbound MCP server definitions with `list`, `show`, `status`, `doctor`, `probe`, `add`, `set`, `configure`, `tools`, `login`, `logout`, `reload`, and `unset`

`serve` is OpenClaw acting as an MCP server. The other subcommands are OpenClaw acting as an MCP client-side registry for servers its own runtimes may consume later.

<Note>
  `list`, `show`, `set`, and `unset` only read and write OpenClaw-managed `mcp.servers` entries in OpenClaw config. They do not include mcporter servers from `config/mcporter.json`; use `mcporter list` for that registry.
</Note>

Use [`openclaw acp`](/cli/acp) when OpenClaw should host a coding harness session itself and route that runtime through ACP.

## Choose the right MCP path

| Goal                                                                | Use                                                                  | Why                                                                                                             |
| ------------------------------------------------------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Let an external MCP client read/send OpenClaw channel conversations | `openclaw mcp serve`                                                 | OpenClaw is the MCP server and exposes Gateway-backed conversations over stdio.                                 |
| Save third-party MCP servers for OpenClaw-managed agent runs        | `openclaw mcp add`, `set`, `configure`, `tools`, `login`             | OpenClaw is the MCP client-side registry and later projects those servers into eligible runtimes.               |
| Check a saved server without running an agent turn                  | `openclaw mcp status`, `doctor`, `probe`                             | `status` and `doctor` inspect config; `probe` opens a live MCP connection and lists capabilities.               |
| Edit MCP config from a browser                                      | Control UI `/settings/mcp` (`/mcp` alias)                            | The page shows inventory, enablement, OAuth/filter summaries, command hints, and a scoped `mcp` editor.         |
| Give Codex app-server a scoped native MCP server                    | `mcp.servers.<name>.codex`                                           | The `codex` block only affects Codex app-server thread projection and is stripped before native config handoff. |
| Run ACP-hosted harness sessions                                     | [`openclaw acp`](/cli/acp) and [ACP Agents](/tools/acp-agents-setup) | ACP bridge mode does not accept per-session MCP server injection; configure gateway/plugin bridges instead.     |

<Tip>
If you are not sure which path you need, start with `openclaw mcp status --verbose`. It shows what OpenClaw has saved without starting any MCP servers.
</Tip>

## OpenClaw as an MCP server

This is the `openclaw mcp serve` path.

### When to use serve

Use `openclaw mcp serve` when:

- Codex, Claude Code, or another MCP client should talk directly to OpenClaw-backed channel conversations
- you already have a local or remote OpenClaw Gateway with routed sessions
- you want one MCP server that works across OpenClaw's channel backends instead of running separate per-channel bridges

Use [`openclaw acp`](/cli/acp) instead when OpenClaw should host the coding runtime itself and keep the agent session inside OpenClaw.

### How it works

`openclaw mcp serve` starts a stdio MCP server. The MCP client owns that process. While the client keeps the stdio session open, the bridge connects to a local or remote OpenClaw Gateway over WebSocket and exposes routed channel conversations over MCP.

<Steps>
  <Step title="Client spawns the bridge">
    The MCP client spawns `openclaw mcp serve`.
  </Step>
  <Step title="Bridge connects to Gateway">
    The bridge connects to the OpenClaw Gateway over WebSocket.
  </Step>
  <Step title="Sessions become MCP conversations">
    Routed sessions become MCP conversations and transcript/history tools.
  </Step>
  <Step title="Live events queue">
    Live events are queued in memory while the bridge is connected.
  </Step>
  <Step title="Optional Claude push">
    If Claude channel mode is enabled, the same session can also receive Claude-specific push notifications.
  </Step>
</Steps>

<AccordionGroup>
  <Accordion title="Important behavior">
    - live queue state starts when the bridge connects
    - older transcript history is read with `messages_read`
    - Claude push notifications only exist while the MCP session is alive
    - when the client disconnects, the bridge exits and the live queue is gone
    - one-shot agent entry points such as `openclaw agent` and `openclaw infer model run` retire any bundled MCP runtimes they open when the reply completes, so repeated scripted runs do not accumulate stdio MCP child processes
    - stdio MCP servers launched by OpenClaw (bundled or user-configured) are torn down as a process tree on shutdown, so child subprocesses started by the server do not survive after the parent stdio client exits
    - deleting or resetting a session disposes that session's MCP clients through the shared runtime cleanup path, so there are no lingering stdio connections tied to a removed session

  </Accordion>
</AccordionGroup>

### Choose a client mode

<Tabs>
  <Tab title="Generic MCP clients">
    Standard MCP tools only. Use `conversations_list`, `messages_read`, `events_poll`, `events_wait`, `messages_send`, and the approval tools.
  </Tab>
  <Tab title="Claude Code">
    Standard MCP tools plus the Claude-specific channel adapter. Enable `--claude-channel-mode on` or leave the default `auto`.
  </Tab>
</Tabs>

<Note>
Today, `auto` behaves the same as `on`. There is no client capability detection yet.
</Note>

### What serve exposes

The bridge uses existing Gateway session route metadata to expose channel-backed conversations. A conversation appears when OpenClaw already has session state with a known route such as:

- `channel`
- recipient or destination metadata
- optional `accountId`
- optional `threadId`

This gives MCP clients one place to:

- list recent routed conversations
- read recent transcript history
- wait for new inbound events
- send a reply back through the same route
- see approval requests that arrive while the bridge is connected

### Usage

<Tabs>
  <Tab title="Local Gateway">
    ```bash
    openclaw mcp serve
    ```
  </Tab>
  <Tab title="Remote Gateway (token)">
    ```bash
    openclaw mcp serve --url wss://gateway-host:18789 --token-file ~/.openclaw/gateway.token
    ```
  </Tab>
  <Tab title="Remote Gateway (password)">
    ```bash
    openclaw mcp serve --url wss://gateway-host:18789 --password-file ~/.openclaw/gateway.password
    ```
  </Tab>
  <Tab title="Verbose / Claude off">
    ```bash
    openclaw mcp serve --verbose
    openclaw mcp serve --claude-channel-mode off
    ```
  </Tab>
</Tabs>

### Bridge tools

<AccordionGroup>
  <Accordion title="conversations_list">
    Lists recent session-backed conversations that already have route metadata in Gateway session state.

    Filters: `limit` (max 500), `search`, `channel`, `includeDerivedTitles`, `includeLastMessage`.

  </Accordion>
  <Accordion title="conversation_get">
    Returns one conversation by `session_key` using a direct Gateway session lookup.
  </Accordion>
  <Accordion title="messages_read">
    Reads recent transcript messages for one session-backed conversation. `limit` defaults to 20, max 200.
  </Accordion>
  <Accordion title="attachments_fetch">
    Extracts non-text message content blocks from one transcript message. This is a metadata view over transcript content, not a standalone durable attachment blob store.
  </Accordion>
  <Accordion title="events_poll">
    Reads queued live events since a numeric cursor. `limit` max 200.
  </Accordion>
  <Accordion title="events_wait">
    Long-polls until the next matching queued event arrives or a timeout expires (default 30s, max 300s).

    Use this when a generic MCP client needs near-real-time delivery without a Claude-specific push protocol.

  </Accordion>
  <Accordion title="messages_send">
    Sends text back through the same route already recorded on the session.

    Current behavior:

    - requires an existing conversation route
    - uses the session's channel, recipient, account id, and thread id
    - sends text only

  </Accordion>
  <Accordion title="permissions_list_open">
    Lists pending exec/plugin approval requests the bridge has observed since it connected to the Gateway.
  </Accordion>
  <Accordion title="permissions_respond">
    Resolves one pending exec/plugin approval request with:

    - `allow-once`
    - `allow-always`
    - `deny`

  </Accordion>
</AccordionGroup>

### Event model

The bridge keeps an in-memory event queue while it is connected.

Current event types:

- `message`
- `exec_approval_requested`
- `exec_approval_resolved`
- `plugin_approval_requested`
- `plugin_approval_resolved`
- `claude_permission_request`

<Warning>
- the queue is live-only; it starts when the MCP bridge starts
- `events_poll` and `events_wait` do not replay older Gateway history by themselves
- durable backlog should be read with `messages_read`

</Warning>

### Claude channel notifications

The bridge can also expose Claude-specific channel notifications. This is the OpenClaw equivalent of a Claude Code channel adapter: standard MCP tools remain available, but live inbound messages can also arrive as Claude-specific MCP notifications.

<Tabs>
  <Tab title="off">
    `--claude-channel-mode off`: standard MCP tools only.
  </Tab>
  <Tab title="on">
    `--claude-channel-mode on`: enable Claude channel notifications.
  </Tab>
  <Tab title="auto (default)">
    `--claude-channel-mode auto`: current default; same bridge behavior as `on`.
  </Tab>
</Tabs>

When Claude channel mode is enabled, the server advertises Claude experimental capabilities and can emit:

- `notifications/claude/channel`
- `notifications/claude/channel/permission`

Current bridge behavior:

- inbound `user` transcript messages are forwarded as `notifications/claude/channel`
- Claude permission requests received over MCP are tracked in-memory
- if the command owner in the linked conversation later sends `yes <id>` or `no <id>` (`<id>` is the 5-letter request id, excluding `l`), the bridge converts that to `notifications/claude/channel/permission`
- these notifications are live-session only; if the MCP client disconnects, there is no push target

This is intentionally client-specific. Generic MCP clients should rely on the standard polling tools.

### MCP client config

Example stdio client config:

```json
{
  "mcpServers": {
    "openclaw": {
      "command": "openclaw",
      "args": [
        "mcp",
        "serve",
        "--url",
        "wss://gateway-host:18789",
        "--token-file",
        "/path/to/gateway.token"
      ]
    }
  }
}
```

For most generic MCP clients, start with the standard tool surface and ignore Claude mode. Turn Claude mode on only for clients that actually understand the Claude-specific notification methods.

### Options

`openclaw mcp serve` supports:

<ParamField path="--url" type="string">
  Gateway WebSocket URL. Defaults to `gateway.remote.url` when configured.
</ParamField>
<ParamField path="--token" type="string">
  Gateway token.
</ParamField>
<ParamField path="--token-file" type="string">
  Read token from file.
</ParamField>
<ParamField path="--password" type="string">
  Gateway password.
</ParamField>
<ParamField path="--password-file" type="string">
  Read password from file.
</ParamField>
<ParamField path="--claude-channel-mode" type='"auto" | "on" | "off"'>
  Claude notification mode. Default `auto`.
</ParamField>
<ParamField path="-v, --verbose" type="boolean">
  Verbose logs on stderr.
</ParamField>

<Tip>
Prefer `--token-file` or `--password-file` over inline secrets when possible.
</Tip>

### Security and trust boundary

The bridge does not invent routing. It only exposes conversations that Gateway already knows how to route.

That means:

- sender allowlists, pairing, and channel-level trust still belong to the underlying OpenClaw channel configuration
- `messages_send` can only reply through an existing stored route
- approval state is live/in-memory only for the current bridge session
- bridge auth should use the same Gateway token or password controls you would trust for any other remote Gateway client

If a conversation is missing from `conversations_list`, the usual cause is not MCP configuration. It is missing or incomplete route metadata in the underlying Gateway session.

### Testing

OpenClaw ships a deterministic Docker smoke for this bridge:

```bash
pnpm test:docker:mcp-channels
```

That smoke runs a single container: it seeds conversation state, starts the Gateway, then spawns `openclaw mcp serve` as a stdio child process and drives it as an MCP client. It verifies conversation discovery, transcript reads, attachment metadata reads, live event queue behavior, and Claude-style channel and permission notifications over the real stdio MCP bridge. Outbound send routing (`messages_send` reusing the stored conversation route) is covered separately by unit tests in `src/mcp/channel-server.test.ts`.

This is the fastest way to prove the bridge works without wiring a real Telegram, Discord, or iMessage account into the test run.

For broader testing context, see [Testing](/help/testing).

### Troubleshooting

<AccordionGroup>
  <Accordion title="No conversations returned">
    Usually means the Gateway session is not already routable. Confirm that the underlying session has stored channel/provider, recipient, and optional account/thread route metadata.
  </Accordion>
  <Accordion title="events_poll or events_wait misses older messages">
    Expected. The live queue starts when the bridge connects. Read older transcript history with `messages_read`.
  </Accordion>
  <Accordion title="Claude notifications do not show up">
    Check all of these:

    - the client kept the stdio MCP session open
    - `--claude-channel-mode` is `on` or `auto`
    - the client actually understands the Claude-specific notification methods
    - the inbound message happened after the bridge connected

  </Accordion>
  <Accordion title="Approvals are missing">
    `permissions_list_open` only shows approval requests observed while the bridge was connected. It is not a durable approval history API.
  </Accordion>
</AccordionGroup>

## OpenClaw as an MCP client registry

This is the `openclaw mcp list`, `show`, `status`, `doctor`, `probe`, `add`, `set`,
`configure`, `tools`, `login`, `logout`, `reload`, and `unset` path.

These commands do not expose OpenClaw over MCP. They manage OpenClaw-managed MCP server definitions under `mcp.servers` in OpenClaw config. They do not read mcporter servers from `config/mcporter.json`.

Those saved definitions are for runtimes that OpenClaw launches or configures later, such as embedded OpenClaw and other runtime adapters. OpenClaw stores the definitions centrally so those runtimes do not need to keep their own duplicate MCP server lists.

<AccordionGroup>
  <Accordion title="Important behavior">
    - these commands only read or write OpenClaw config
    - `status`, `list`, `show`, `doctor` without `--probe`, `set`, `configure`, `tools`, `logout`, `reload`, and `unset` do not connect to the target MCP server
    - `login` performs the MCP OAuth network flow for the configured HTTP server and saves the resulting local credentials
    - `status --verbose` prints resolved transport, auth, timeout, filter, and parallel-tool-call hints without connecting
    - `doctor` checks saved definitions for local setup problems such as missing stdio commands, invalid working directories, missing TLS files, disabled servers, literal sensitive header/env values, and incomplete OAuth authorization
    - `doctor --probe` adds the same live connection proof as `probe` after static checks pass
    - `probe` connects to the selected server or all configured servers, lists tools, and reports capabilities/diagnostics
    - `add` builds a definition from flags and probes before saving unless `--no-probe` is set or OAuth authorization is needed first
    - runtime adapters decide which transport shapes they actually support at execution time
    - `enabled: false` keeps a server saved but excludes it from embedded runtime discovery
    - `timeout` and `connectTimeout` set per-server request and connection timeouts in seconds
    - `supportsParallelToolCalls: true` marks servers that adapters can call concurrently
    - HTTP servers can use static headers, OAuth login, TLS verification control, and mTLS certificate/key paths
    - embedded OpenClaw exposes configured MCP tools in normal `coding` and `messaging` tool profiles; `minimal` still hides them, and `tools.deny: ["bundle-mcp"]` disables them explicitly
    - per-server `toolFilter.include` and `toolFilter.exclude` filter discovered MCP tools before they become OpenClaw tools
    - servers that advertise resources or prompts also expose utility tools for listing/reading resources and listing/fetching prompts; those generated utility names (`resources_list`, `resources_read`, `prompts_list`, `prompts_get`) use the same include/exclude filter
    - dynamic MCP tool-list changes invalidate the cached catalog for that session; the next discovery/use refreshes from the server
    - repeated MCP tool request/protocol failures pause that server briefly so one broken server does not consume the whole turn
    - session-scoped bundled MCP runtimes are reaped after `mcp.sessionIdleTtlMs` milliseconds of idle time (default 10 minutes; set `0` to disable) and one-shot embedded runs clean them up at run end

  </Accordion>
</AccordionGroup>

Runtime adapters may normalize this shared registry into the shape their downstream client expects. For example, embedded OpenClaw consumes OpenClaw `transport` values directly, while Claude Code and Gemini receive CLI-native `type` values such as `http`, `sse`, or `stdio`.

Codex app-server also honors an optional `codex` block on each server. This is
OpenClaw projection metadata for Codex app-server threads only; it does not
change ACP sessions, generic Codex harness config, or other runtime adapters.
Use non-empty `codex.agents` to project a server only into specific OpenClaw
agent ids. Empty, blank, or invalid agent lists are rejected by config
validation and omitted by the runtime projection path instead of becoming
global. Use `codex.defaultToolsApprovalMode` (`auto`, `prompt`, or `approve`)
to emit Codex's native `default_tools_approval_mode` for a trusted server.
OpenClaw strips the `codex` metadata before handing the native `mcp_servers`
config to Codex.

### Saved MCP server definitions

Commands:

- `openclaw mcp list`
- `openclaw mcp show [name]`
- `openclaw mcp status [--verbose]`
- `openclaw mcp doctor [name] [--probe]`
- `openclaw mcp probe [name]`
- `openclaw mcp add <name> [flags]`
- `openclaw mcp set <name> <json>`
- `openclaw mcp configure <name> [flags]`
- `openclaw mcp tools <name> [--include csv] [--exclude csv] [--clear]`
- `openclaw mcp login <name> [--code code]`
- `openclaw mcp logout <name>`
- `openclaw mcp reload`
- `openclaw mcp unset <name>`

Notes:

- `list` sorts server names.
- `show` without a name prints the full configured MCP server object.
- `status` classifies configured transports without connecting. `--verbose` includes resolved launch, timeout, OAuth, filter, and parallel-call details.
- `doctor` performs static checks without connecting. Add `--probe` when the command should also verify that enabled servers connect.
- `probe` connects and reports tool counts, resources/prompts support, list-change support, and diagnostics.
- `add` accepts stdio flags such as `--command`, `--arg`, `--env`, and `--cwd`, or HTTP flags such as `--url`, `--transport`, `--header`, `--auth oauth`, TLS, timeout, and tool-selection flags.
- `set` expects one JSON object value on the command line.
- `configure` updates enablement, tool filters, timeouts, OAuth, TLS, and parallel-tool-call hints without replacing the whole server definition. Add `--probe` to verify the updated server before saving.
- `tools` updates per-server tool filters. Include/exclude entries are MCP tool names and simple `*` globs.
- `login` runs the OAuth flow for HTTP servers configured with `auth: "oauth"`. The first run prints an authorization URL; rerun with `--code` after approval.
- `logout` clears stored OAuth credentials for the named server without removing the saved server definition.
- `reload` disposes cached in-process MCP runtimes for the current CLI process only. Gateway or agent processes in another process still need their own reload or restart path.
- Use `transport: "streamable-http"` for Streamable HTTP MCP servers. `openclaw mcp set` also normalizes CLI-native `type: "http"` to the same canonical config shape for compatibility.
- `unset` fails if the named server does not exist.

Examples:

```bash
openclaw mcp list
openclaw mcp show context7 --json
openclaw mcp status --verbose
openclaw mcp doctor --probe
openclaw mcp probe context7 --json
openclaw mcp add memory --command npx --arg -y --arg @modelcontextprotocol/server-memory
openclaw mcp set context7 '{"command":"uvx","args":["context7-mcp"]}'
openclaw mcp tools context7 --include 'resolve-library-id,get-library-docs'
openclaw mcp set docs '{"url":"https://mcp.example.com","transport":"streamable-http"}'
openclaw mcp configure docs --timeout 20 --connect-timeout 5 --include 'search,read_*'
openclaw mcp configure docs --auth oauth --oauth-scope 'docs.read'
openclaw mcp login docs
openclaw mcp logout docs
openclaw mcp unset context7
```

### Common server recipes

These examples save server definitions only. Run `openclaw mcp doctor --probe` afterward to prove that the server starts and exposes tools.

<Tabs>
  <Tab title="Filesystem">
    ```bash
    openclaw mcp add files \
      --command npx \
      --arg -y \
      --arg @modelcontextprotocol/server-filesystem \
      --arg "$HOME/Documents" \
      --include 'read_file,list_directory,search_files'
    openclaw mcp doctor files --probe
    ```

    Scope filesystem servers to the smallest directory tree that the agent should read or edit.

  </Tab>
  <Tab title="Memory">
    ```bash
    openclaw mcp add memory \
      --command npx \
      --arg -y \
      --arg @modelcontextprotocol/server-memory
    openclaw mcp probe memory --json
    ```

    Use a tool filter if the server exposes write tools that should not be available to normal agents.

  </Tab>
  <Tab title="Local script">
    ```bash
    openclaw mcp add local-tools \
      --command node \
      --arg ./dist/mcp-server.js \
      --cwd /srv/openclaw-tools \
      --env API_BASE=https://internal.example
    openclaw mcp status --verbose
    ```

    `doctor` checks that `cwd` exists and that the command resolves from the configured environment.

  </Tab>
  <Tab title="Remote HTTP">
    ```bash
    openclaw mcp add docs \
      --url https://mcp.example.com/mcp \
      --transport streamable-http \
      --auth oauth \
      --oauth-scope docs.read \
      --timeout 20 \
      --connect-timeout 5 \
      --include 'search,read_*'
    openclaw mcp doctor docs --probe
    ```

    Use OAuth when the remote server supports it. If the server requires static headers, avoid committing literal bearer tokens.

  </Tab>
  <Tab title="Desktop/CUA">
    ```bash
    openclaw mcp set cua-driver '{"command":"cua-driver","args":["mcp"]}'
    openclaw mcp tools cua-driver --include 'list_apps,observe,click,type'
    openclaw mcp doctor cua-driver --probe
    ```

    Direct desktop-control servers inherit the permissions of the process they launch. Use narrow tool filters and OS-level permission prompts.

  </Tab>
</Tabs>

### JSON output shapes

Use `--json` for scripts and dashboards. Field sets can grow over time, so consumers should ignore unknown keys.

<AccordionGroup>
  <Accordion title="status --json">
    ```json
    {
      "path": "/home/user/.openclaw/openclaw.json",
      "servers": [
        {
          "name": "docs",
          "configured": true,
          "enabled": true,
          "ok": true,
          "transport": "streamable-http",
          "launch": "streamable-http https://mcp.example.com/mcp",
          "auth": "oauth",
          "authStatus": {
            "hasTokens": true,
            "hasClientInformation": true,
            "hasCodeVerifier": false,
            "hasDiscoveryState": true,
            "hasLastAuthorizationUrl": false
          },
          "requestTimeoutMs": 20000,
          "connectionTimeoutMs": 5000,
          "toolFilter": {
            "include": ["search", "read_*"],
            "exclude": []
          },
          "supportsParallelToolCalls": true
        }
      ]
    }
    ```
  </Accordion>
  <Accordion title="doctor --json">
    ```json
    {
      "ok": true,
      "path": "/home/user/.openclaw/openclaw.json",
      "servers": [
        {
          "name": "docs",
          "ok": true,
          "issues": [
            {
              "level": "warning",
              "message": "OAuth credentials are not authorized; run openclaw mcp login docs"
            }
          ]
        }
      ]
    }
    ```

    `doctor --json` exits nonzero when any enabled checked server has an `error`-level issue. `warning` and `info` issues are reported but do not make the command fail by themselves.

  </Accordion>
  <Accordion title="probe --json">
    ```json
    {
      "generatedAt": "2026-05-31T09:00:00.000Z",
      "servers": {
        "docs": {
          "launch": "streamable-http https://mcp.example.com/mcp",
          "tools": 2,
          "resources": true,
          "listChanged": {
            "tools": true,
            "resources": false,
            "prompts": false
          }
        }
      },
      "tools": ["docs__read_page", "docs__search"],
      "diagnostics": []
    }
    ```

    `probe --json` opens a live MCP client session and prints its result directly; unlike `status`/`doctor`, the output has no top-level `path` field. `resources` and `prompts` keys are present only when the server actually advertises that capability (a server without prompts omits the `prompts` key rather than reporting `false`). Use `probe` for reachability and capability proof, not for static config audits.

  </Accordion>
</AccordionGroup>

Example config shape:

```json
{
  "mcp": {
    "servers": {
      "context7": {
        "command": "uvx",
        "args": ["context7-mcp"]
      },
      "docs": {
        "url": "https://mcp.example.com",
        "transport": "streamable-http",
        "timeout": 20,
        "connectTimeout": 5,
        "supportsParallelToolCalls": true,
        "auth": "oauth",
        "oauth": {
          "scope": "docs.read"
        },
        "sslVerify": true,
        "clientCert": "/path/to/client.crt",
        "clientKey": "/path/to/client.key",
        "toolFilter": {
          "include": ["search_*"],
          "exclude": ["admin_*"]
        }
      }
    }
  }
}
```

### Stdio transport

Launches a local child process and communicates over stdin/stdout.

| Field                      | Description                       |
| -------------------------- | --------------------------------- |
| `command`                  | Executable to spawn (required)    |
| `args`                     | Array of command-line arguments   |
| `env`                      | Extra environment variables       |
| `cwd` / `workingDirectory` | Working directory for the process |

<Warning>
**Stdio env safety filter**

OpenClaw rejects interpreter-startup, loader-hijack, and shell-init env keys before spawning a stdio MCP server, even if they appear in a server's `env` block. This uses the same host environment security policy as other OpenClaw-spawned processes: it blocks known interpreter startup hooks (for example `NODE_OPTIONS`, `PYTHONSTARTUP`, `PERL5OPT`, `RUBYOPT`, `BASHOPTS`, `KSH_ENV`), shared-library and function-injection prefixes (`DYLD_*`, `LD_*`, `BASH_FUNC_*`), and similar runtime-control variables. Startup drops these silently and logs a warning so they cannot inject an implicit prelude, swap the interpreter, enable a debugger, or hijack the dynamic linker against the stdio process. An explicit allowlist keeps ordinary MCP credential env vars usable (`GITHUB_TOKEN`, `GH_TOKEN`, `GITLAB_TOKEN`, `NPM_TOKEN`, `NODE_AUTH_TOKEN`, `DATABASE_URL`, `MONGODB_URI`, `REDIS_URL`, `AMQP_URL`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`), along with ordinary proxy and server-specific env vars (`HTTP_PROXY`, custom `*_API_KEY`, etc.). Other `AWS_*` keys such as `AWS_CONFIG_FILE` and `AWS_SHARED_CREDENTIALS_FILE` remain blocked because they point at credential files rather than carry a credential value directly.

If your MCP server genuinely needs one of the blocked variables, set it on the gateway host process instead of under the stdio server's `env`.
</Warning>

### SSE / HTTP transport

Connects to a remote MCP server over HTTP Server-Sent Events.

| Field                          | Description                                                      |
| ------------------------------ | ---------------------------------------------------------------- |
| `url`                          | HTTP or HTTPS URL of the remote server (required)                |
| `headers`                      | Optional key-value map of HTTP headers (for example auth tokens) |
| `connectionTimeoutMs`          | Per-server connection timeout in ms (optional)                   |
| `connectTimeout`               | Per-server connection timeout in seconds (optional)              |
| `timeout` / `requestTimeoutMs` | Per-server MCP request timeout in seconds or ms                  |
| `auth: "oauth"`                | Use MCP OAuth credentials saved by `openclaw mcp login`          |
| `sslVerify`                    | Set false only for explicitly trusted private HTTPS endpoints    |
| `clientCert` / `clientKey`     | mTLS client certificate and key paths                            |
| `supportsParallelToolCalls`    | Hint that concurrent calls are safe for this server              |

Example:

```json
{
  "mcp": {
    "servers": {
      "remote-tools": {
        "url": "https://mcp.example.com",
        "auth": "oauth",
        "timeout": 20,
        "headers": {
          "Authorization": "Bearer <token>"
        }
      }
    }
  }
}
```

Sensitive values in `url` (userinfo) and `headers` are redacted in logs and status output. `openclaw mcp doctor` warns when sensitive-looking `headers` or `env` entries contain literal values, so operators can move those values out of committed config.

### OAuth workflow

OAuth is for HTTP MCP servers that advertise the MCP OAuth flow. Static `Authorization` headers are ignored for a server while `auth: "oauth"` is enabled. Credentials saved by `openclaw mcp login` work with embedded MCP, CLI runners, and the local Codex app-server.

Until credentials are available, OpenClaw omits only that MCP server from the agent runtime instead of failing the agent turn. The operator, or an agent with shell access, can then run `openclaw mcp login <name>` and use the server on a later turn.

When a remote MCP service is already backed by a separate OpenClaw refresh-capable auth profile, you can optionally set `oauth.authProfileId`. OpenClaw refreshes either credential source before runtime projection and passes only the current access token to the downstream MCP client.

<Steps>
  <Step title="Save the server">
    Add or update the server with `auth: "oauth"` and any optional OAuth metadata.

    ```bash
    openclaw mcp set docs '{"url":"https://mcp.example.com/mcp","transport":"streamable-http","auth":"oauth","oauth":{"scope":"docs.read"}}'
    ```

    For an auth-profile-backed bearer, save the profile binding:

    ```bash
    openclaw mcp set docs '{"url":"https://mcp.example.com/mcp","transport":"streamable-http","auth":"oauth","oauth":{"authProfileId":"docs:mcp"}}'
    ```

  </Step>
  <Step title="Start login">
    Run login to create the authorization request.

    ```bash
    openclaw mcp login docs
    ```

    OpenClaw prints the authorization URL and stores temporary OAuth verifier state under the OpenClaw state directory.

  </Step>
  <Step title="Finish with the code">
    After approving in the browser, pass the returned code back to OpenClaw.

    ```bash
    openclaw mcp login docs --code abc123
    ```

  </Step>
  <Step title="Check authorization">
    Use status or doctor to confirm that tokens are present.

    ```bash
    openclaw mcp status --verbose
    openclaw mcp doctor docs --probe
    ```

  </Step>
  <Step title="Clear credentials">
    Logout removes stored OAuth credentials but keeps the saved server definition.

    ```bash
    openclaw mcp logout docs
    ```

  </Step>
</Steps>

If the provider rotates tokens or the authorization state gets stuck, run `openclaw mcp logout <name>`, then repeat `login`. `logout` can clear credentials for a saved HTTP server even after `auth: "oauth"` has been removed from config, as long as the server name and URL still identify the credential store entry.

### Streamable HTTP transport

`streamable-http` is an additional transport option alongside `sse` and `stdio`. It uses HTTP streaming for bidirectional communication with remote MCP servers.

| Field                          | Description                                                                            |
| ------------------------------ | -------------------------------------------------------------------------------------- |
| `url`                          | HTTP or HTTPS URL of the remote server (required)                                      |
| `transport`                    | Set to `"streamable-http"` to select this transport; when omitted, OpenClaw uses `sse` |
| `headers`                      | Optional key-value map of HTTP headers (for example auth tokens)                       |
| `connectionTimeoutMs`          | Per-server connection timeout in ms (optional)                                         |
| `connectTimeout`               | Per-server connection timeout in seconds (optional)                                    |
| `timeout` / `requestTimeoutMs` | Per-server MCP request timeout in seconds or ms                                        |
| `auth: "oauth"`                | Use MCP OAuth credentials saved by `openclaw mcp login`                                |
| `sslVerify`                    | Set false only for explicitly trusted private HTTPS endpoints                          |
| `clientCert` / `clientKey`     | mTLS client certificate and key paths                                                  |
| `supportsParallelToolCalls`    | Hint that concurrent calls are safe for this server                                    |

OpenClaw config uses `transport: "streamable-http"` as the canonical spelling. CLI-native MCP `type: "http"` values are accepted when saved through `openclaw mcp set` and repaired by `openclaw doctor --fix` in existing config, but `transport` is what embedded OpenClaw consumes directly.

Example:

```json
{
  "mcp": {
    "servers": {
      "streaming-tools": {
        "url": "https://mcp.example.com/stream",
        "transport": "streamable-http",
        "connectTimeout": 10,
        "timeout": 30,
        "headers": {
          "Authorization": "Bearer <token>"
        }
      }
    }
  }
}
```

<Note>
Registry commands do not start the channel bridge. Only `probe` and `doctor --probe` open a live MCP client session to prove the target server is reachable.
</Note>

## Control UI

The browser Control UI includes a dedicated MCP settings page at `/settings/mcp`; the previous `/mcp` path remains an alias. The page shows configured server counts, enabled/OAuth/filter summaries, per-server transport rows, enable/disable controls, common CLI commands, and a scoped editor for the `mcp` config section.

Use the page for operator edits and quick inventory. Use `openclaw mcp doctor --probe` or `openclaw mcp probe` when you need live server proof.

Operator workflow:

1. Open the Control UI and choose **MCP**.
2. Review the summary cards for total, enabled, OAuth, and filtered servers.
3. Use each server row for transport, auth, filter, timeout, and command hints.
4. Toggle enablement when you want to keep a definition but exclude it from runtime discovery.
5. Edit the scoped `mcp` config section for structural changes such as new servers, headers, TLS, OAuth metadata, or tool filters.
6. Choose **Save** to persist config only, or **Save & Publish** to apply through the Gateway config path.
7. Run `openclaw mcp doctor --probe` when you need live proof that the edited server starts and lists tools.

Notes:

- command snippets quote server names so unusual names remain copyable in a shell
- displayed URL-like values are redacted before rendering when they contain embedded credentials
- the page does not start MCP transports by itself
- active runtimes may need `openclaw mcp reload`, Gateway config publish, or process restart depending on which process owns the MCP clients

## MCP Apps

OpenClaw can render tools that implement the stable [MCP Apps extension](https://modelcontextprotocol.io/extensions/apps). Apps are opt-in because their HTML comes from the configured MCP server and can request app-visible tools or resources from that same server.

Enable the host bridge:

```bash
openclaw config set mcp.apps.enabled true --strict-json
```

Restart the Gateway after changing this setting. When enabled, OpenClaw starts a sandbox-only HTTP(S) listener on the Gateway port plus one (for the default Gateway, `18790`). The Control UI loads Apps from that separate origin; the listener never serves Control UI, authenticated Gateway routes, or user data.

Direct Gateway connections need access to both ports. If a reverse proxy or TLS terminator exposes the Control UI, give Apps a dedicated public origin and proxy only that origin to the sandbox listener:

```json5
{
  mcp: {
    apps: {
      enabled: true,
      sandboxOrigin: "https://mcp-apps.example.com",
      sandboxPort: 18790,
    },
  },
}
```

The sandbox origin must differ from the Control UI origin. Do not host other authenticated or sensitive content on it.

For example, the official basic React demo can be configured as:

```json5
{
  mcp: {
    apps: { enabled: true },
    servers: {
      "basic-react": {
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-basic-react", "--stdio"],
      },
    },
  },
}
```

Behavior and security boundaries:

- OpenClaw advertises the `io.modelcontextprotocol/ui` extension only when Apps are enabled.
- Only `ui://` resources with the exact `text/html;profile=mcp-app` MIME type render.
- UI resources are capped at 2 MiB, placed behind a double-iframe proxy on a dedicated outer origin, loaded into an opaque inner App origin, and constrained by CSP derived from the resource metadata.
- App-only tools (`_meta.ui.visibility: ["app"]`) stay out of model tool lists. Apps can call only app-visible tools on their owning server that also pass the effective OpenClaw tool policy for the run that created the view.
- Origin-bound App permissions such as camera, microphone, and geolocation are not granted while inner App documents use opaque origins for cross-App isolation.
- App HTML, complete tool arguments, and raw results live in a bounded ten-minute in-memory view lease and are not written to disk or copied into transcript preview metadata. The transcript stores only a bounded server/tool/resource descriptor tied to the original tool-call ID. After a Gateway restart, the Control UI can verify that descriptor against the authenticated session transcript and refetch the `ui://` resource; reconstructed views are read-only until a fresh run establishes current tool permissions.
- `openclaw security audit` warns while the bridge is enabled. Disable it with `openclaw config set mcp.apps.enabled false --strict-json` when it is not needed.

## Current limits

This page documents the bridge as shipped today.

Current limits:

- conversation discovery depends on existing Gateway session route metadata
- no generic push protocol beyond the Claude-specific adapter
- no message edit or react tools yet
- HTTP/SSE/streamable-http transport connects to a single remote server; no multiplexed upstream yet
- `permissions_list_open` only includes approvals observed while the bridge is connected

## Related

- [CLI reference](/cli)
- [Plugins](/cli/plugins)
