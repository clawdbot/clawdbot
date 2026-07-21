---
summary: "Nodes: pairing, capabilities, permissions, and CLI helpers for canvas/camera/screen/device/notifications/system"
read_when:
  - Pairing iOS/watchOS/Android nodes to a gateway
  - Using node canvas/camera for agent context
  - Adding new node commands or CLI helpers
title: "Nodes"
---

A **node** is a companion device (macOS/iOS/watchOS/Android/headless) that connects to the Gateway with `role: "node"` and exposes a command surface (e.g. `canvas.*`, `camera.*`, `device.*`, `notifications.*`, `system.*`) via `node.invoke`. Most nodes use the Gateway WebSocket on the operator port. The optional direct Apple Watch node uses signed HTTPS polling on that same port because watchOS blocks generic low-level networking for ordinary apps. Protocol details: [Gateway protocol](/gateway/protocol).

Legacy transport: [Bridge protocol](/gateway/bridge-protocol) (TCP JSONL; historical only for current nodes).

macOS can also run in **node mode**: the menu bar app connects to the Gateway's
WS server as one node (so `openclaw nodes …` works against this Mac). The app
adds native Canvas, camera, screen, notification, and computer-control commands
to the same node-host command surface used by `openclaw node run`. Do not start a
second CLI node on that Mac; the app runs the matching CLI node-host runtime as
an internal worker and remains the sole Gateway connection and node identity.

Nodes are **peripherals**, not gateways: they don't run the gateway service, and channel messages (Telegram, WhatsApp, etc.) land on the gateway, not on nodes.

Troubleshooting runbook: [/nodes/troubleshooting](/nodes/troubleshooting)

## Pairing + status

Nodes use **device pairing**. A node presents a signed device identity during connect; the Gateway creates a device pairing request for `role: node`. Approve via the devices CLI (or UI). The direct Apple Watch setup uses an admin-minted, short-lived node-only setup code to approve its fixed low-risk command surface; later capability expansion still requires normal approval.

```bash
openclaw devices list
openclaw devices approve <requestId>
openclaw devices reject <requestId>
openclaw nodes status
openclaw nodes describe --node <idOrNameOrIp>
```

Pending pairing requests expire 5 minutes after the device's last retry — a device that keeps reconnecting keeps its one pending request (and `requestId`) alive instead of minting a new prompt every few minutes; see [Node pairing](/gateway/pairing) for the full request/approve lifecycle. If a node retries with changed auth details (role/scopes/public key), the prior pending request is superseded and a new `requestId` is created — clients get a `device.pair.resolved` event for the superseded request, and you should re-run `openclaw devices list` before approving.

- `nodes status` marks a node as **paired** when its device pairing role includes `node`.
- A connected native Mac with Accessibility permission can report coalesced
  physical-input activity. The Gateway marks the freshest eligible Mac as
  `active`, gives the agent a stable node-id hint, and routes node connection
  alerts there before a delayed fallback. See
  [Active computer presence](/nodes/presence) for setup, privacy, timing, and
  troubleshooting.
- The device pairing record is the durable approved-role contract. Token rotation stays inside that contract; it cannot upgrade a paired node into a role that pairing approval never granted.
- `node.pair.*` (CLI: `openclaw nodes pending/approve/reject/remove/rename`) is a separate, gateway-owned node pairing store that tracks the node's approved command/capability surface across reconnects. It does **not** gate transport authentication — device pairing does that.
- `openclaw nodes remove --node <id|name|ip>` removes a node pairing. For a device-backed node it revokes the device's `node` role in the paired-device store and disconnects that device's node-role sessions: a mixed-role device keeps its row and only loses the `node` role, while a node-only device row is deleted. It also clears any matching entry from the separate node pairing store. `operator.pairing` may remove non-operator node rows on other devices; a device-token caller revoking its own node role on a mixed-role device additionally needs `operator.admin`.
- Approval scope follows the pending request's declared commands:
  - commandless request: `operator.pairing`
  - non-exec node commands: `operator.pairing` + `operator.write`
  - `system.run` / `system.run.prepare` / `system.which`: `operator.pairing` + `operator.admin`

## Version skew and upgrade order

The Gateway WebSocket accepts authenticated node clients across an N-1 protocol window.
The current v4 Gateway therefore accepts v3 nodes when the connection declares
both `role: "node"` and `client.mode: "node"`. Operator and UI sessions must
still use the current protocol.

For staged fleet upgrades, upgrade the Gateway first, then upgrade each node.
An N-1 node remains visible and manageable while it is upgraded; the Gateway
logs `legacy node protocol accepted` with an upgrade recommendation. Pairing,
device authentication, command allowlists, and exec approvals still apply.
Plugin-owned capabilities and commands stay hidden until the node upgrades to
the current protocol. Nodes older than N-1 require an out-of-band upgrade before
reconnecting.

The direct watchOS HTTPS transport requires the current protocol version; update
the watch app with the Gateway before enabling direct mode.

## Remote node host (system.run)

Use a **node host** when your Gateway runs on one machine and you want commands to execute on another. The model still talks to the **gateway**; the gateway forwards `exec` calls to the **node host** when `host=node` is selected.

| Role         | Responsibility                                                   |
| ------------ | ---------------------------------------------------------------- |
| Gateway host | Receives messages, runs the model, routes tool calls.            |
| Node host    | Executes `system.run`/`system.which` on the node machine.        |
| Approvals    | Enforced on the node host via `~/.openclaw/exec-approvals.json`. |

Approval note:

- Approval-backed node runs bind exact request context. The exec path prepares a canonical `systemRunPlan` before approval; once granted, the gateway forwards that stored plan, not any later caller-edited command/cwd/session fields, and re-validates the working directory before running.
- For direct shell/runtime file executions, OpenClaw also best-effort binds one concrete local file operand and denies the run if that file changes before execution.
- If OpenClaw cannot identify exactly one concrete local file for an interpreter/runtime command, approval-backed execution is denied instead of pretending full runtime coverage. Use sandboxing, separate hosts, or an explicit trusted allowlist/full workflow for broader interpreter semantics.

### Start a node host (foreground)

On the node machine:

```bash
openclaw node run --host <gateway-host> --port 18789 --display-name "Build Node"
```

`node run` also accepts `--context-path` (Gateway WS context path), `--tls`, `--tls-fingerprint <sha256>`, and `--node-id` (override the legacy client instance ID; this does not reset pairing). On macOS, pass `--share-installed-apps` to advertise `device.apps`; sharing is off by default. Use `--no-share-installed-apps` to disable a previously saved opt-in.

### Remote gateway via SSH tunnel (loopback bind)

If the Gateway binds to loopback (`gateway.bind=loopback`, default in local mode), remote node hosts cannot connect directly. Create an SSH tunnel and point the node host at the local end of the tunnel.

Example (node host -> gateway host):

```bash
# Terminal A (keep running): forward local 18790 -> gateway 127.0.0.1:18789
ssh -N -L 18790:127.0.0.1:18789 user@gateway-host

# Terminal B: export the gateway token and connect through the tunnel
export OPENCLAW_GATEWAY_TOKEN="<gateway-token>"
openclaw node run --host 127.0.0.1 --port 18790 --display-name "Build Node"
```

Notes:

- `openclaw node run` supports token or password auth.
- Env vars are preferred: `OPENCLAW_GATEWAY_TOKEN` / `OPENCLAW_GATEWAY_PASSWORD`.
- Config fallback is `gateway.auth.token` / `gateway.auth.password`.
- In local mode, node host intentionally ignores `gateway.remote.token` / `gateway.remote.password`.
- In remote mode, `gateway.remote.token` / `gateway.remote.password` are eligible per remote precedence rules.
- If active local `gateway.auth.*` SecretRefs are configured but unresolved, node-host auth fails closed.
- Node-host auth resolution only honors `OPENCLAW_GATEWAY_*` env vars.

### Start a node host (service)

```bash
openclaw node install --host <gateway-host> --port 18789 --display-name "Build Node"
openclaw node start
openclaw node restart
```

`node install` also accepts `--context-path`, `--tls`, `--tls-fingerprint`, `--node-id` (legacy client instance ID only), `--share-installed-apps` / `--no-share-installed-apps`, `--runtime <node>` (default: node), and `--force` to reinstall. `node status`, `node stop`, and `node uninstall` are also available.

### Pair + name

On the gateway host:

```bash
openclaw devices list
openclaw devices approve <requestId>
openclaw nodes status
```

If the node retries with changed auth details, re-run `openclaw devices list` and approve the current `requestId`.

Naming options:

- `--display-name` on `openclaw node run` / `openclaw node install` (persists in the shared `node_host_config` SQLite row alongside the client instance ID and Gateway connection metadata).
- `openclaw nodes rename --node <id|name|ip> --name "Build Node"` (gateway override).

### Node-hosted MCP servers

Configure MCP servers in `openclaw.json` on the node machine, not on the
Gateway:

```json5
{
  nodeHost: {
    mcp: {
      servers: {
        localDocs: {
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-filesystem", "/srv/docs"],
          toolFilter: {
            include: ["read_*", "search"],
          },
        },
        internalApi: {
          url: "https://mcp.internal.example/mcp",
          transport: "streamable-http",
          headers: {
            Authorization: "Bearer ${INTERNAL_MCP_TOKEN}",
          },
        },
      },
    },
  },
}
```

The headless node host starts these servers, lists their tools, and publishes
the descriptors after connecting. Tool calls return to that node through
`mcp.tools.call.v1`; the Gateway does not need matching MCP config or a JS
plugin. OAuth MCP servers are not supported by this node-hosted v1 path.

Current node hosts declare the built-in `mcp.tools.call.v1` command family during
their initial pairing even when no MCP server is configured. A node paired on an
older OpenClaw version may request a one-time command-surface upgrade after the
node host is updated. Adding, removing, or filtering servers after that does not
require re-pairing because the approved command family is unchanged. Restart
`openclaw node run` or `openclaw node restart` to apply node MCP config changes;
the node host does not watch this config.

Gateway operators can ignore all agent-visible tools published by paired nodes,
including node-hosted MCP tools, with
`gateway.nodes.pluginTools.enabled: false`. Exact command denies such as
`gateway.nodes.denyCommands: ["mcp.tools.call.v1"]` also block execution.

### Node-hosted skills

Install skills under the node machine's active OpenClaw skills directory,
`~/.openclaw/skills` by default. `OPENCLAW_HOME`, `OPENCLAW_STATE_DIR`, and
`OPENCLAW_CONFIG_PATH` move that active profile. `OPENCLAW_STATE_DIR` takes
precedence for skills; otherwise, `skills/` is beside the path printed by
`openclaw config file`. The headless node host publishes valid `SKILL.md` files
after it connects, and the Gateway adds them to agent skill snapshots only while
that node remains connected. Each skill directory name must match the `name`
frontmatter field so the abstract node locator maps to one entry without adding
another protocol field.

The initial node-role pairing approves skill publication. Adding, removing, or
changing skills does not require another pairing or Gateway configuration
change. Restart `openclaw node run` or `openclaw node restart` after changing
node skill files; the node host does not watch the skills directory.

Node-hosted skill entries identify their node and carry their execution
location. Skill files, referenced relative paths, and binaries remain on that
node. The agent reads the advertised `node://.../SKILL.md` location with the
normal `read` tool. `file_fetch` accepts operator-approved absolute node paths,
not node skill locators; runtimes without the normal read tool can instead run
`cat SKILL.md` through `exec host=node node=<node-id>` with the advertised
`node://.../skills/<name>` directory as `workdir`. Referenced files and binaries
use the same exec target and workdir. The node host resolves that locator against
its active OpenClaw state directory, so relative paths resolve on the node rather
than the Gateway machine. The publishing node must have approved `system.run`,
and the agent's exec policy must allow `host=node`; otherwise the skill stays
out of that agent's snapshot.

Set `nodeHost.skills.enabled: false` on the node to stop publication. Gateway
operators can ignore skills from every paired node with
`gateway.nodes.skills.enabled: false`.

### Headless identity state

The headless node keeps three separate state records:

- `~/.openclaw/state/openclaw.sqlite` (`node_host_config`): the client instance ID, display name, and Gateway connection metadata.
- `~/.openclaw/state/openclaw.sqlite` (`device_identities`, key `primary`): the signed device keypair and derived cryptographic device ID.
- `~/.openclaw/identity/device-auth.json`: paired device auth tokens keyed by cryptographic device ID and role.

For a signed node, the Gateway uses the cryptographic device ID for pairing and
node routing. The client instance ID is only connection metadata. Changing
`--node-id` or migrating a retired `node.json` therefore does not reset pairing. See
[Identity and pairing state](/cli/node#identity-and-pairing-state) for the
supported revoke-and-re-pair flow and upgrade notes.

A retired `identity/device.json` file or interrupted Doctor claim blocks normal
identity use. Stop the node host and run `openclaw doctor --fix`; Doctor imports
the validated keypair into SQLite before removing the old file. The identity
migration leaves `identity/device-auth.json` untouched.

### Allowlist the commands

Exec approvals are **per node host**. Add allowlist entries from the gateway:

```bash
openclaw approvals allowlist add --node <id|name|ip> "/usr/bin/uname"
openclaw approvals allowlist add --node <id|name|ip> "/usr/bin/sw_vers"
```

Approvals live on the node host at `~/.openclaw/exec-approvals.json`.

### Point exec at the node

Configure defaults (gateway config):

```bash
openclaw config set tools.exec.host node
openclaw config set tools.exec.security allowlist
openclaw config set tools.exec.node "<id-or-name>"
```

Or per session:

```text
/exec host=node security=allowlist node=<id-or-name>
```

Once set, any `exec` call with `host=node` runs on the node host (subject to the node allowlist/approvals).

`host=auto` will not implicitly choose the node on its own, but an explicit per-call `host=node` request is allowed from `auto`. If you want node exec to be the default for the session, set `tools.exec.host=node` or `/exec host=node ...` explicitly.

Related:

- [Node host CLI](/cli/node)
- [Exec tool](/tools/exec)
- [Exec approvals](/tools/exec-approvals)

### Local model inference

A desktop or server node can expose chat-capable models from an Ollama server running on that node. Agents use the Ollama plugin's `node_inference` tool to discover installed models and run a bounded prompt remotely; the Gateway does not need direct network access to Ollama. See [Ollama node-local inference](/providers/ollama#node-local-inference) for setup, model filtering, and direct verification commands.

### Codex sessions and transcripts

The official `codex` plugin can expose non-archived Codex sessions on a
headless node host or native macOS node. Catalog registration no longer depends
on `supervision.enabled`; that option gates the agent-facing supervision tools.
Set `sessionCatalog.enabled: false` in the Codex plugin config to disable the
operator catalog and paired-node catalog commands without disabling the
provider or harness.
The plugin must still be active on both computers, and the node setting remains
local consent: enabling only the Gateway cannot read another computer's Codex
state.

The node advertises the versioned read-only
`codex.appServer.threads.list.v1` and
`codex.appServer.thread.turns.list.v1` commands. A native node host with the
Codex CLI available also advertises `codex.terminal.resume.v1`. Approve the node pairing
upgrade when those commands first appear. The Gateway invokes them through the
normal plugin node policy and isolates failures by host.

Paired-node rows appear as a **Codex** group in the normal sessions sidebar.
Within each host, rows group by project folder by default; a working directory
under `.claude/worktrees/<name>` folds into its origin repository, and project
groups collapse like other sidebar sections. Use the folder icon in the catalog
header to flatten or restore the project groups. The same grouping applies to
the Claude sessions catalog.
By default, selecting a row opens the normal Chat pane and reads its persisted transcript
through bounded, cursor-paginated
`thread/turns/list` calls with full item projection. Use the row menu, the viewer header, or the **Open Codex/Claude sessions in** preference to start `codex resume <thread-id>` in the operator terminal on the computer that owns the session. The paired-node terminal path is an allowlisted PTY relay owned by the Codex plugin, not arbitrary node command execution.

The relay does not provide the full OpenClaw harness continuation and archive ownership contracts. **Continue** and **Archive** are therefore unavailable for remote rows. On the Gateway computer, stored and idle
rows can start a distinct model-locked Chat branch. Either can be archived only
after the operator confirms that no other Codex client is using it; a stored
row's live activity remains unknown. Active rows cannot branch or archive.

See [Supervise Codex sessions](/plugins/codex-supervision) for setup,
pagination, local continuation, and the metadata security boundary.

### Claude sessions and transcripts

The bundled `anthropic` plugin discovers non-archived Claude CLI and Claude
Desktop sessions on the Gateway and paired nodes by default. Set
`plugins.entries.anthropic.config.sessionCatalog.enabled: false` to disable the
operator catalog and paired-node catalog commands without disabling Anthropic
models or the Claude CLI backend.
A remote macOS app node advertises
`anthropic.claude.sessions.list.v1` and `anthropic.claude.sessions.read.v1`
when the Anthropic plugin is enabled and `~/.claude/projects/` exists. Approve
the node pairing upgrade when those commands first appear.

A native node host with the Claude CLI available also advertises
`anthropic.claude.terminal.resume.v1`. Eligible CLI and Desktop rows can open
`claude --resume <session-id>` in the operator terminal on their owning host.
This is a takeover of the native session; unlike OpenClaw adoption, it does not
fork the Claude session first.

The catalog combines valid Claude CLI project-index records with a bounded
metadata fallback for unindexed JSONL transcripts. That fallback recognizes
concurrent non-sidechain interactive (`cli`) and headless Agent SDK CLI
(`sdk-cli`) sessions. Claude Desktop's local metadata supplies Desktop titles and archive
state. Desktop metadata wins when both sources refer to the same Claude Code
session ID; CLI-only transcripts remain visible because the CLI has no archive
flag. Transcript reads use opaque
byte-offset cursors and bounded backward file reads, so selecting a large
session or loading an older page does not read the whole JSONL history into one
Gateway response.

The list and read commands are read-only. They expose catalog metadata and transcript
content only through the generic `sessions.catalog.list` and
`sessions.catalog.read` methods to an authenticated operator connection with
`operator.write`. A Gateway-local Claude CLI row can be adopted from the normal
Chat composer: OpenClaw imports bounded visible history, resumes with
`--fork-session` on the first turn, and leaves the source transcript untouched.

A headless node host can opt into the same continuation flow:

```json5
{
  nodeHost: {
    agentRuns: {
      claude: { enabled: true },
    },
  },
}
```

The node advertises `agent.cli.claude.run.v1` only when this node-local setting
is enabled and the `claude` executable resolves on that node. The Gateway cannot
enable it remotely. The command also passes through the node's existing exec
approval policy. When all three Claude commands are advertised and permitted by
the Gateway's node command policy, a Claude CLI
row on that node becomes continuable: OpenClaw imports bounded history, binds
the adopted session to the node and its catalog-reported working directory, and
runs each one-shot `claude -p` turn there. The first turn still uses
`--fork-session`, preserving the source transcript.

Node-placed turns use the node's Claude defaults. In v1 they do not receive the
Gateway loopback MCP config or Gateway skills plugin, cannot reseed from a
Gateway transcript, and reject attachments and images. Claude Desktop rows and
nodes that do not advertise the run command remain view-only. The macOS app
node does not advertise this command yet, so its rows remain view-only.

See [Anthropic: Claude sessions across computers](/providers/anthropic#claude-sessions-across-computers)
for the Control UI behavior and storage sources.

### OpenCode and Pi sessions

The bundled OpenCode and ACPX plugins also discover read-only native session
catalogs on the Gateway and paired nodes. A node advertises
`opencode.sessions.list.v1` / `opencode.sessions.read.v1` when the `opencode`
CLI is installed, and `acpx.pi.sessions.list.v1` / `acpx.pi.sessions.read.v1`
when Pi's session directory exists. Approve the node pairing upgrade when new
commands first appear. When the matching CLI is also available, the node adds
`opencode.terminal.resume.v1` or `acpx.pi.terminal.resume.v1`; the existing row
menu and viewer header can then reopen the selected session in its owning
terminal with `opencode --session <id>` or `pi --session <id>`.

OpenCode reads through its official CLI JSON/export surface. Pi reads its
documented JSONL session store, including project and global `settings.json`
session directories plus `PI_CODING_AGENT_DIR` and
`PI_CODING_AGENT_SESSION_DIR` overrides. Both catalogs are enabled by default;
turn them off in the Web UI under **Config > Plugins**.

Terminal resume uses the stored session working directory and the same
allowlisted duplex PTY relay as Codex and Claude. It does not expose arbitrary
node command execution.

### Terminal file uploads

The Control UI can drag files into an open paired-node terminal. The native node host advertises the admin-only `terminal.upload` command; approve the pairing upgrade when it first appears. Each file is limited to 16 MiB, staged in a private temporary directory on that node, and returned to the terminal as a shell-quoted path without executing it.

Path insertion supports PowerShell, `cmd.exe`, and recognized POSIX shells (`sh`, Bash, Dash, Ash, Ksh, Zsh, and Fish), including Git Bash on Windows. Other shell overrides are refused because their quoting rules cannot be inferred safely; run the node host inside WSL for native WSL paths. `cmd.exe` paths containing `%` or `!` are also refused because that shell expands those characters even inside double quotes.

## Invoking commands

Low-level (raw RPC):

```bash
openclaw nodes invoke --node <idOrNameOrIp> --command canvas.eval --params '{"javaScript":"location.href"}'
```

`nodes invoke` blocks `system.run` and `system.run.prepare`; those commands only run through the `exec` tool with `host=node` (see above). Higher-level helpers exist for the common "give the agent a MEDIA attachment" workflows (canvas, camera, screen, location, below).

Long-running streaming node commands use additive `node.invoke.progress`
events. Each event carries the invoke ID, a zero-based sequence number, and a
bounded UTF-8 text chunk; the Gateway orders chunks before delivering them to
the caller. The existing `node.invoke.result` remains the single terminal
response. Streaming callers can set an inactivity deadline that starts with the
first progress event and resets after later progress while retaining the
invoke's separate hard timeout during approval and execution. Result, hard
timeout, inactivity timeout, and node disconnect all discard pending stream
state. Caller cancellation emits `node.invoke.cancel`; the node host then
terminates the matching process tree. Existing request/response commands are unchanged.

## Command policy

Node commands must pass two gates before they can be invoked:

1. The node must declare the command in its authenticated connect metadata (`connect.commands`).
2. The gateway's platform-and-approval-derived allowlist must include the declared command.

Default allowlists by platform (before plugin defaults and `allowCommands`/`denyCommands` overrides):

| Platform | Commands allowed by default                                                                                                                                                                                                                                                                                           |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| iOS      | `camera.list`, `location.get`, `device.info`, `device.status`, `contacts.search`, `calendar.events`, `reminders.list`, `photos.latest`, `motion.activity`, `motion.pedometer`, `system.notify`                                                                                                                        |
| watchOS  | `device.info`, `device.status`, `system.notify`                                                                                                                                                                                                                                                                       |
| Android  | `camera.list`, `location.get`, `notifications.list`, `notifications.actions`, `system.notify`, `device.info`, `device.status`, `device.permissions`, `device.health`, `device.apps`, `contacts.search`, `calendar.events`, `callLog.search`, `reminders.list`, `photos.latest`, `motion.activity`, `motion.pedometer` |
| macOS    | `camera.list`, `location.get`, `device.info`, `device.status`, `device.apps`, `contacts.search`, `calendar.events`, `reminders.list`, `photos.latest`, `motion.activity`, `motion.pedometer`, `system.notify`                                                                                                         |
| Windows  | `camera.list`, `location.get`, `device.info`, `device.status`, `system.notify`                                                                                                                                                                                                                                        |
| Linux    | `system.notify` (node host commands like `system.run` are approval-gated, see below)                                                                                                                                                                                                                                  |

These rows describe the Gateway policy ceiling, not the commands implemented by every node app. A command is usable only when the connected node also declares it. In particular, the current macOS app does not declare the device and personal-data families listed in the macOS policy row.

`canvas.*` commands (`canvas.present`, `canvas.hide`, `canvas.navigate`, `canvas.eval`, `canvas.snapshot`, `canvas.a2ui.*`) are a plugin default on iOS, Android, macOS, Windows, Linux, and unknown platforms. Linux nodes declare them only when the desktop app's local Canvas socket is present. All Canvas commands are foreground-restricted on iOS.

`talk.ptt.start`, `talk.ptt.stop`, `talk.ptt.cancel`, and `talk.ptt.once` are allowed by default for any node that advertises the `talk` capability or declares `talk.*` commands, independent of platform label.

Desktop host commands (`system.run`, `system.run.prepare`, `system.which`, `browser.proxy`, `mcp.tools.call.v1`, and `screen.snapshot` on macOS/Windows/Linux) are not part of the static platform-default table above. They become available once the operator approves a pairing request that declares them, after which the node's approved command set carries them forward on reconnect.

Dangerous or privacy-heavy commands still require explicit opt-in with `gateway.nodes.allowCommands`, even if a node declares them: `camera.snap`, `camera.clip`, `screen.record`, `computer.act`, `contacts.add`, `calendar.add`, `reminders.add`, `health.summary`, `sms.send`, `sms.search`. `gateway.nodes.denyCommands` always wins over defaults and extra allowlist entries. See [HealthKit summaries](/platforms/ios-healthkit) for the iPhone consent gate and [Computer use](/nodes/computer-use) for the additional capability, tool-policy, arming, and platform-fulfiller gates around desktop input.

Plugin-owned node commands can add a Gateway node-invoke policy. That policy runs after the allowlist check and before forwarding to the node, so raw `node.invoke`, CLI helpers, and dedicated agent tools share the same plugin permission boundary. Dangerous plugin node commands still require explicit `gateway.nodes.allowCommands` opt-in.

After a node changes its declared command list, reject the old device pairing and approve the new request so the gateway stores the updated command snapshot.

## Config (`openclaw.json`)

Node-related settings live under `gateway.nodes` and `tools.exec`:

```json5
{
  gateway: {
    nodes: {
      // Auto-approve first-time node pairing from trusted networks (CIDR list).
      // Disabled when unset. Only applies to first-time role:node requests
      // with no requested scopes; does not auto-approve upgrades.
      pairing: {
        autoApproveCidrs: ["192.168.1.0/24"],
        // SSH-verified auto-approval (default: enabled). Approves first-time
        // node pairing on an exact device-key match read back over SSH.
        sshVerify: true,
      },
      // Trust agent-visible plugin tools published by paired nodes (default: true).
      pluginTools: {
        enabled: true,
      },
      // Opt into dangerous/privacy-heavy node commands (camera.snap, etc.).
      allowCommands: ["camera.snap", "screen.record"],
      // Block exact command names even if defaults or allowCommands include them.
      denyCommands: ["camera.clip"],
    },
  },
  tools: {
    exec: {
      // Default exec host: "node" routes all exec calls to a paired node.
      host: "node",
      // Security mode for node exec: allow only approved/allowlisted commands.
      security: "allowlist",
      // Pin exec to a specific node (id or name). Omit to allow any node.
      node: "build-node",
    },
  },
}
```

Use exact node command names. `denyCommands` removes a command even when a platform default or `allowCommands` entry would otherwise allow it. Paired nodes may publish agent-visible plugin tool descriptors by default, but each descriptor's command must still be in the node's approved command surface. Set `gateway.nodes.pluginTools.enabled: false` to ignore all such descriptors. See [Gateway configuration reference](/gateway/configuration-reference#gateway) for gateway node pairing and command-policy field details.

Per-agent exec node override:

```json5
{
  agents: {
    list: [
      {
        id: "main",
        tools: { exec: { node: "build-node" } },
      },
    ],
  },
}
```

## Screenshots (canvas snapshots)

If the node is showing the Canvas (WebView), `canvas.snapshot` returns `{ format, base64 }`.

CLI helper (writes to a temp file and prints the saved path):

```bash
openclaw nodes canvas snapshot --node <idOrNameOrIp> --format png
openclaw nodes canvas snapshot --node <idOrNameOrIp> --format jpg --max-width 1200 --quality 0.9
```

### Canvas controls

```bash
openclaw nodes canvas present --node <idOrNameOrIp> --target https://example.com
openclaw nodes canvas hide --node <idOrNameOrIp>
openclaw nodes canvas navigate https://example.com --node <idOrNameOrIp>
openclaw nodes canvas eval --node <idOrNameOrIp> --js "document.title"
```

Notes:

- `canvas present` accepts URLs or local file paths (`--target`) on nodes that support local paths, plus optional `--x/--y/--width/--height` for positioning. Linux Canvas accepts HTTP(S) URLs or its bundled A2UI renderer.
- `canvas eval` accepts inline JS (`--js`) or a positional arg.

### A2UI (Canvas)

```bash
openclaw nodes canvas a2ui push --node <idOrNameOrIp> --text "Hello"
openclaw nodes canvas a2ui push --node <idOrNameOrIp> --jsonl ./payload.jsonl
openclaw nodes canvas a2ui reset --node <idOrNameOrIp>
```

Notes:

- Mobile and Linux desktop nodes use a bundled app-owned A2UI page for action-capable rendering.
- Only A2UI v0.8 JSONL is supported (v0.9/createSurface is rejected).
- iOS and Android render remote Gateway Canvas pages, but A2UI button actions are dispatched only from the bundled app-owned A2UI page. Gateway-hosted HTTP/HTTPS A2UI pages are render-only on those mobile clients.
- macOS can dispatch actions from the exact capability-scoped Gateway A2UI page selected by the app. Other HTTP/HTTPS pages remain render-only.
- Linux dispatches actions only from the bundled A2UI page. Other HTTP/HTTPS pages remain render-only, and a headless Linux node without the desktop app does not advertise Canvas.

## Photos + videos (node camera)

Photos (`jpg`):

```bash
openclaw nodes camera list --node <idOrNameOrIp>
openclaw nodes camera snap --node <idOrNameOrIp>            # default: both facings (2 MEDIA lines)
openclaw nodes camera snap --node <idOrNameOrIp> --facing front
openclaw nodes camera snap --node <idOrNameOrIp> --device-id <id> --max-width 1200 --quality 0.9 --delay-ms 2000
```

Video clips (`mp4`):

```bash
openclaw nodes camera clip --node <idOrNameOrIp> --duration 10s
openclaw nodes camera clip --node <idOrNameOrIp> --duration 3000 --no-audio
```

Notes:

- The node must be **foregrounded** for `canvas.*` and `camera.*` (background calls return `NODE_BACKGROUND_UNAVAILABLE`).
- Nodes clamp clip duration to keep the base64 payload manageable (see [Camera capture](/nodes/camera) for exact per-platform limits). The `nodes` agent tool additionally caps requested `durationMs` at 300000 (5 minutes) before forwarding the call; the node itself enforces the tighter limit.
- Android will prompt for `CAMERA`/`RECORD_AUDIO` permissions when possible; denied permissions fail with `*_PERMISSION_REQUIRED`.

## Screen recordings (nodes)

Supported nodes expose `screen.record` (mp4). Example:

```bash
openclaw nodes screen record --node <idOrNameOrIp> --duration 10s --fps 10
openclaw nodes screen record --node <idOrNameOrIp> --duration 10s --fps 10 --no-audio
```

Notes:

- `screen.record` availability depends on node platform.
- The `nodes` agent tool caps requested `durationMs` at 300000 (5 minutes); the node may enforce a tighter limit to bound the returned payload.
- `--no-audio` disables microphone capture on supported platforms.
- Use `--screen <index>` to select a display when multiple screens are available (0 = primary).

## Location (nodes)

Nodes expose `location.get` when Location is enabled in settings.

CLI helper:

```bash
openclaw nodes location get --node <idOrNameOrIp>
openclaw nodes location get --node <idOrNameOrIp> --accuracy precise --max-age 15000 --location-timeout 10000
```

Notes:

- Location is **off by default**.
- "Always" requires system permission; background fetch is best-effort.
- The response includes lat/lon, accuracy (meters), and timestamp.
- Full parameter/response shape and error codes: [Location command](/nodes/location-command).

## SMS (Android nodes)

Android nodes can expose `sms.send` and `sms.search` when the user grants **SMS** permission and the device supports telephony. Both commands are dangerous-by-default: the gateway operator must also add them to `gateway.nodes.allowCommands` before they can be invoked (see [Command policy](#command-policy)).

For read-only SMS search, opt in explicitly in `openclaw.json`:

```json5
{
  gateway: {
    nodes: {
      allowCommands: ["sms.search"],
    },
  },
}
```

Add `sms.send` separately only when the node should also be able to send messages. Android permission and Gateway command authorization are independent; granting the phone permission does not edit Gateway policy.

Low-level invoke:

```bash
openclaw nodes invoke --node <idOrNameOrIp> --command sms.send --params '{"to":"+15555550123","message":"Hello from OpenClaw"}'
```

Notes:

- `sms.search` may be declared before `READ_SMS` is granted so an invocation can return a permission diagnostic; reading messages still requires that Android permission.
- Wi-Fi-only devices without telephony will not advertise `sms.send`.
- A `requires explicit gateway.nodes.allowCommands opt-in` error means the phone declared the command but the Gateway operator has not authorized it.

## Device and personal data commands

iOS and Android nodes advertise several read-only data commands by default (see the [Command policy](#command-policy) table); Android additionally exposes a larger family gated by its own in-app settings. A macOS or headless-mac TypeScript node host advertises `device.apps` only after the operator enables installed-app sharing with `--share-installed-apps`.

Available families:

- `device.status`, `device.info` — iOS, Android, Windows.
- `device.permissions`, `device.health` — Android only.
- `device.apps` — Android, macOS, and headless-mac nodes. Android requires Installed Apps sharing in Settings and returns launcher-visible apps by default. TypeScript node hosts keep sharing off by default and accept `query`, `limit`, and `includeSystem`; macOS results contain `label`, `bundleId`, `path`, and `system`.
- `notifications.list`, `notifications.actions` — Android only.
- `photos.latest` — iOS, Android.
- `contacts.search` — iOS, Android (read-only default); `contacts.add` is dangerous and needs `gateway.nodes.allowCommands`.
- `calendar.events` — iOS, Android (read-only default); `calendar.add` is dangerous and needs `gateway.nodes.allowCommands`.
- `reminders.list` — iOS, Android (read-only default); `reminders.add` is dangerous and needs `gateway.nodes.allowCommands`.
- `callLog.search` — Android only.
- `motion.activity`, `motion.pedometer` — iOS, Android; capability-gated by available sensors.

Example invokes:

```bash
openclaw nodes invoke --node <idOrNameOrIp> --command device.status --params '{}'
openclaw nodes invoke --node <idOrNameOrIp> --command device.apps --params '{"limit":10}'
openclaw nodes invoke --node <idOrNameOrIp> --command notifications.list --params '{}'
openclaw nodes invoke --node <idOrNameOrIp> --command photos.latest --params '{"limit":1}'
```

## System commands (node host / mac node)

The macOS node exposes `system.run`, `system.which`, `system.notify`, and `system.execApprovals.get/set`. The headless node host exposes `system.run.prepare`, `system.run`, `system.which`, and `system.execApprovals.get/set`.

Examples:

```bash
openclaw nodes notify --node <idOrNameOrIp> --title "Ping" --body "Gateway ready"
openclaw nodes invoke --node <idOrNameOrIp> --command system.which --params '{"bins":["git"]}'
```

Notes:

- `system.run` returns stdout/stderr/exit code in the payload.
- Shell execution now goes through the `exec` tool with `host=node`; `nodes` remains the direct-RPC surface for explicit node commands.
- `nodes invoke` does not expose `system.run` or `system.run.prepare`; those stay on the exec path only.
- The exec path prepares a canonical `systemRunPlan` before approval. Once an approval is granted, the gateway forwards that stored plan, not any later caller-edited command/cwd/session fields.
- `system.notify` respects notification permission state on the macOS app; supports `--priority <passive|active|timeSensitive>` and `--delivery <system|overlay|auto>`.
- Unrecognized node `platform` / `deviceFamily` metadata uses a conservative default allowlist that excludes `system.run` and `system.which`. If you intentionally need those commands for an unknown platform, add them explicitly via `gateway.nodes.allowCommands`.
- `system.run` supports `--cwd`, `--env KEY=VAL`, `--command-timeout`, and `--needs-screen-recording`.
- For shell wrappers (`bash|sh|zsh ... -c/-lc`), request-scoped `--env` values are reduced to an explicit allowlist (`TERM`, `LANG`, `LC_*`, `COLORTERM`, `NO_COLOR`, `FORCE_COLOR`).
- For allow-always decisions in allowlist mode, known dispatch wrappers (`env`, `flock`, `nice`, `nohup`, `stdbuf`, `timeout`) persist inner executable paths instead of wrapper paths. If unwrapping is not safe, no allowlist entry is persisted automatically.
- On Windows node hosts in allowlist mode, shell-wrapper runs via `cmd.exe /c` require approval (allowlist entry alone does not auto-allow the wrapper form).
- Node hosts ignore `PATH` overrides in `--env` and strip a large, maintained set of interpreter/shell startup variables (for example `NODE_OPTIONS`, `PYTHONPATH`, `BASH_ENV`, `DYLD_*`, `LD_*`) before running a command. If you need extra PATH entries, configure the node host service environment (or install tools in standard locations) instead of passing `PATH` via `--env`.
- On macOS node mode, `system.run` is gated by exec approvals in the macOS app (Settings → Exec approvals). Ask/allowlist/full behave the same as the headless node host; denied prompts return `SYSTEM_RUN_DENIED`.
- On headless node host, `system.run` is gated by exec approvals (`~/.openclaw/exec-approvals.json`); on macOS specifically, see the exec-host routing env vars under [Headless node host](#headless-node-host-cross-platform) below.

## Exec node binding

When multiple nodes are available, you can bind exec to a specific node. This sets the default node for `exec host=node` (and can be overridden per agent).

Global default:

```bash
openclaw config set tools.exec.node "node-id-or-name"
```

Per-agent override:

```bash
openclaw config get agents.list
openclaw config set 'agents.list[0].tools.exec.node' "node-id-or-name"
```

Unset to allow any node:

```bash
openclaw config unset tools.exec.node
openclaw config unset 'agents.list[0].tools.exec.node'
```

## Permissions map

Nodes may include a `permissions` map in `node.list` / `node.describe`, keyed by permission name (e.g. `screenRecording`, `accessibility`, `location`) with boolean values (`true` = granted).

## Headless node host (cross-platform)

OpenClaw can run a **headless node host** (no UI) that connects to the Gateway WebSocket and exposes `system.run` / `system.which`. This is useful on Linux/Windows or for running a minimal node alongside a server.

Start it:

```bash
openclaw node run --host <gateway-host> --port 18789
```

Notes:

- Pairing is still required (the Gateway will show a device pairing prompt).
- Client instance metadata, signed device identity, and pairing auth use separate state records; see [Headless identity state](#headless-identity-state).
- Exec approvals are enforced locally via `~/.openclaw/exec-approvals.json` (see [Exec approvals](/tools/exec-approvals)).
- On macOS, the headless node host executes `system.run` locally by default. Set `OPENCLAW_NODE_EXEC_HOST=app` to route `system.run` through the companion app exec host; add `OPENCLAW_NODE_EXEC_FALLBACK=0` to require the app host and fail closed if it is unavailable.
- Add `--tls` / `--tls-fingerprint` when the Gateway WS uses TLS.

## Mac node mode

- The macOS menubar app connects to the Gateway WS server as a node (so `openclaw nodes …` works against this Mac).
- In remote mode, the app opens an SSH tunnel for the Gateway port and connects to `localhost`.
