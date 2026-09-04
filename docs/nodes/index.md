---
summary: "Nodes: pairing, capabilities, permissions, and CLI helpers for camera/screen/device/notifications/system and the macOS widget panel"
read_when:
  - Pairing iOS/watchOS/Android nodes to a gateway
  - Enabling isolated OpenClaw session hosting on a paired node
  - Using node camera or screen capture for agent context
  - Presenting a hosted widget on a Mac
  - Adding new node commands or CLI helpers
title: "Nodes"
doc-schema-version: 1
---

A **node** is a companion device (macOS/iOS/watchOS/Android/headless) that connects to the Gateway with `role: "node"` and exposes a command surface (e.g. `camera.*`, `device.*`, `notifications.*`, `system.*`) via `node.invoke`. Most nodes use the Gateway WebSocket on the operator port. The optional direct Apple Watch node uses signed HTTPS polling on that same port because watchOS blocks generic low-level networking for ordinary apps. Protocol details: [Gateway protocol](/gateway/protocol).

macOS can also run in **node mode**: the menu bar app connects to the Gateway's
WS server as one node (so `openclaw nodes …` works against this Mac). The app
adds native widget-panel, camera, screen, notification, and computer-control commands
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
- A connected native Mac can opt in to coalesced physical-input activity from
  **Settings -> Permissions -> Active computer detection**. Accessibility is
  also required. The Gateway marks the freshest eligible Mac as
  `active`, gives the agent a stable node-id hint, and routes node connection
  alerts there before a delayed fallback. See
  [Active computer presence](/nodes/presence) for setup, privacy, timing, and
  troubleshooting.
- The device pairing record is the durable approved-role contract. Token rotation stays inside that contract; it cannot upgrade a paired node into a role that pairing approval never granted.
- `node.pair.*` (CLI: `openclaw nodes pending/approve/reject/remove/rename`) manages the node's approved command/capability surface on its canonical paired-device record. Device pairing owns both transport authentication and the durable node surface; there is no separate node pairing store.
- `openclaw nodes remove --node <id|name|ip>` revokes the device's `node` role in the paired-device store and disconnects that device's node-role sessions: a mixed-role device keeps its row and only loses the `node` role, while a node-only device row is deleted. `operator.pairing` may remove non-operator node rows on other devices; a device-token caller revoking its own node role on a mixed-role device additionally needs `operator.admin`.
- Approval scope follows the pending request's declared commands:
  - commandless request: `operator.pairing`
  - non-exec node commands: `operator.pairing` + `operator.write`
  - `system.run` / `system.run.prepare` / `system.which`: `operator.pairing` + `operator.admin`

Headless node hosts report the hardware model on macOS and Linux.

Connected CLI node hosts and the macOS app report CPU count, load averages,
memory, and home-volume disk capacity every 60 seconds, starting on connection.
The Gateway exposes the latest snapshot as `hostStats` in `node.list` and
`node.describe`. When received, it saves the snapshot on the paired node
record, so offline nodes keep showing last-known stats with the original
`updatedAtMs`. Connected nodes use live session stats. `openclaw nodes status`
and `openclaw nodes describe` show a compact stats summary with a last-known age
for offline nodes. Windows omits load averages, and unavailable disk capacity is
omitted. See
[Node host stats](/gateway/protocol#node-host-stats) for the wire contract.

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

| Role         | Responsibility                                                                           |
| ------------ | ---------------------------------------------------------------------------------------- |
| Gateway host | Receives messages, runs the model, routes tool calls.                                    |
| Node host    | Executes `system.run`/`system.which` on the node machine.                                |
| Approvals    | Enforced on the node host via `~/.openclaw/state/openclaw.sqlite#exec_approvals_config`. |

Approval note:

- Approval-backed node runs bind exact request context. The exec path prepares a canonical `systemRunPlan` before approval; once granted, the gateway forwards that stored plan, not any later caller-edited command/cwd/session fields, and re-validates the working directory before running.
- For direct shell/runtime file executions, OpenClaw also best-effort binds one concrete local file operand and denies the run if that file changes before execution.
- If OpenClaw cannot identify exactly one concrete local file for an interpreter/runtime command, approval-backed execution is denied instead of pretending full runtime coverage. Use sandboxing, separate hosts, or an explicit trusted allowlist/full workflow for broader interpreter semantics.

### Gateway deployments that cannot host nodes

A Gateway can remain healthy for browser users while node hosting is unavailable. Run `openclaw doctor` on the Gateway before onboarding nodes, and check these preconditions:

- **Machine authentication:** Tailscale identity headers do not authenticate node-role connections. In `gateway.auth.mode: "trusted-proxy"`, a new node also cannot supply the proxy's user identity headers. To use a shared token, switch to token mode and configure `gateway.auth.token` with a SecretRef; trusted-proxy mode rejects mixed token configuration. A trusted-proxy Gateway can use `gateway.auth.password` only for clean loopback/direct callers. See [trusted-proxy mixed token configuration](/gateway/trusted-proxy-auth#mixed-token-configuration).
- **Node onboarding URL:** With `gateway.bind: "loopback"`, configure Tailscale Serve, `gateway.remote.url`, or `plugins.entries.device-pair.config.publicUrl` before minting a join code. Otherwise `openclaw devices join-code` reports: `Gateway is only bound to loopback. Set gateway.bind=lan, enable tailscale serve, or configure plugins.entries.device-pair.config.publicUrl.`
- **Node onboarding plugin:** Join codes and `openclaw connect` require the bundled `device-pair` plugin. If it is disabled or excluded by plugin policy, set `plugins.entries.device-pair.enabled: true`, make sure `device-pair` is allowed, and restart the Gateway.
- **Device session runtime:** Paired-device runners support the embedded OpenClaw runtime and explicitly authorized Codex `remote-exec`; ACPX routes cannot dispatch to a paired device. Codex requires `codex.exec-server.stdio.v1` in `gateway.nodes.commands.allow` plus its normal pairing and invocation approvals. Runtime policy belongs on provider/model routes, not the ignored whole-agent runtime keys. Multi-agent rosters must also set `agents.ownership: "explicit"`. See [Codex paired-device placement](/plugins/codex-harness#run-codex-on-a-paired-device) and [runtime policy](/gateway/config-agents#runtime-policy).
- **Edge routing:** When a reverse proxy or access edge fronts the Gateway, the node must satisfy edge auth on the join request, its main Gateway WebSocket, and the worker WebSocket. Keep WebSocket upgrade enabled for `/__openclaw__/worker`. You can instead exempt `/j/*` and `/__openclaw__/worker` from edge identity auth because both routes enforce their own short-lived credentials. See [worker protocol](/gateway/protocol#worker-role-and-closed-protocol).

For a Cloudflare Access-fronted Gateway:

1. In Cloudflare Zero Trust, create an Access service token. Copy its Client ID and Client Secret when Cloudflare displays them.
2. Add a **Service Auth** policy that accepts the token on the Access application protecting the Gateway. If `/j/*` and `/__openclaw__/worker` are separate Access applications, add the same policy to both.
3. On the node, provide the conventional environment fallback and connect:

   ```bash
   export CF_ACCESS_CLIENT_ID="<client-id>"
   export CF_ACCESS_CLIENT_SECRET="<client-secret>"
   openclaw connect https://gateway.example/j/<code> --service
   ```

The canonical node connection keys are `gateway.cloudflareAccess.clientId` and `gateway.cloudflareAccess.clientSecret`; both accept SecretInput values. The environment fallback above persists those keys as env SecretRefs, not copied plaintext. For installed nodes, OpenClaw stores the environment values in the managed service environment file rather than inline in launchd, systemd, or Task Scheduler definitions. Resolved values are bound to the configured Gateway origin and are not followed across redirects. OpenClaw rejects the pair before resolution on plaintext `http://` or `ws://` routes; credential-free loopback and private-network plaintext behavior is unchanged.

### Start a node host (foreground)

On the node machine:

```bash
openclaw node run --host <gateway-host> --port 18789 --display-name "Build Node"
```

For one-paste setup, create a **Node host** setup link from the Control UI
Devices page, then run its copyable command on the node machine:

```bash
openclaw node run --pair "oc-pair://<setup-code>"
```

The link is single-use and expires after 10 minutes. It supplies the endpoint,
bootstrap token, TLS mode, and certificate pin when available. Explicit
gateway flags override the corresponding `--pair` values. Pairing does not
pre-approve command execution; the first `system.run` request still follows
the normal pending-approval or SSH-verification path. See
[Node pairing](/gateway/pairing#one-paste-node-pairing).

`node run` also accepts `--pair`, `--context-path` (Gateway WS context path), `--tls`, `--tls-fingerprint <sha256>`, and `--node-id` (override the legacy client instance ID; this does not reset pairing). On macOS, pass `--share-installed-apps` to advertise `device.apps`; sharing is off by default. Use `--no-share-installed-apps` to disable a previously saved opt-in.

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

`node install` also accepts `--context-path`, `--tls`, `--tls-fingerprint`, `--node-id` (legacy client instance ID only), `--share-installed-apps` / `--no-share-installed-apps`, `--runtime <node|bun>` (default: `node`), and `--force` to reinstall. Bun requires version 1.4+ with WAL-reset-safe `node:sqlite` and is an explicit opt-in; Node remains recommended. `node status`, `node stop`, and `node uninstall` are also available.

### Pair + name

On the gateway host:

```bash
openclaw devices list
openclaw devices approve <requestId>
openclaw nodes status
```

If the node retries with changed auth details, re-run `openclaw devices list` and approve the current `requestId`.

Naming options:

- `--display-name` on `openclaw node run` / `openclaw node install` (persists in the shared `nodeHost.config` SQLite machine-state value alongside the client instance ID and Gateway connection metadata).
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

Server-advertised tool-list changes apply live and replace the published node
catalog. If an MCP transport closes or a stateful Streamable HTTP session
expires, the node withdraws that server's stale tools and reconnects with
bounded backoff. The failed call that detects an expired session is not replayed;
a later call can use the replacement connection after its tools are republished.

Gateway operators can ignore all agent-visible tools published by paired nodes,
including node-hosted MCP tools, with
`gateway.nodes.pluginTools.enabled: false`. Exact command denies such as
`gateway.nodes.commands.deny: ["mcp.tools.call.v1"]` also block execution.

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
`gateway.nodes.allowSkills: false`.

### Headless identity state

The headless node keeps three separate state records in shared SQLite:

- `~/.openclaw/state/openclaw.sqlite` (`config_machine_state`, key `nodeHost.config`): the client instance ID, display name, and Gateway connection metadata.
- `~/.openclaw/state/openclaw.sqlite` (`device_identities`, key `primary`): the signed device keypair and derived cryptographic device ID.
- `~/.openclaw/state/openclaw.sqlite` (`device_auth_tokens`): paired device auth tokens keyed by cryptographic device ID and role.

For a signed node, the Gateway uses the cryptographic device ID for pairing and
node routing. The client instance ID is only connection metadata. Changing
`--node-id` or migrating a retired `node.json` therefore does not reset pairing. See
[Identity and pairing state](/cli/node#identity-and-pairing-state) for the
supported revoke-and-re-pair flow and upgrade notes.

Retired `identity/device.json` and `identity/device-auth.json` files are
Doctor-owned migration inputs. Stop the node host and run
`openclaw doctor --fix`; Doctor imports and verifies their rows in SQLite before
removing the old files.

### Allowlist the commands

Exec approvals are **per node host**. Add allowlist entries from the gateway:

```bash
openclaw approvals allowlist add --node <id|name|ip> "/usr/bin/uname"
openclaw approvals allowlist add --node <id|name|ip> "/usr/bin/sw_vers"
```

Approvals live on the node host in
`~/.openclaw/state/openclaw.sqlite#exec_approvals_config`.

### Point exec at the node

Configure defaults (gateway config):

```bash
openclaw config set tools.exec.host node
openclaw config set tools.exec.mode allowlist
openclaw config set tools.exec.node "<id-or-name>"
```

Or per session:

```text
/exec host=node security=allowlist node=<id-or-name>
```

Once set, any `exec` call with `host=node` runs on the node host (subject to the node allowlist/approvals).

`host=auto` will not implicitly choose the node on its own. An explicit per-call `host=node` request is allowed from `auto` only when no sandbox runtime is active; while a sandbox runtime is active, `auto` rejects it. To run on a node from a sandboxed session, or to make node exec the session default, set `tools.exec.host=node` or `/exec host=node ...` explicitly.

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

The terminal relay is separate from paired-node Chat continuation. A connected
node that advertises and permits both catalog commands plus
`codex.cli.session.resume` can continue a stored or idle interactive thread for
an operator with `operator.admin`. The Chat mirrors bounded visible history;
later messages run native Codex CLI resume against the exact thread on that
node and return the final text, without a streaming App Server harness bridge.
Nodes without the required commands remain readable without Chat continuation.
Paired-node **Archive** is unavailable.

On the Gateway computer, stored and idle rows can start a distinct model-locked
Chat branch. Either can be archived only after the operator confirms that no
other Codex client is using it; a stored row's live activity remains unknown.
Active rows cannot branch or archive.

See [Supervise Codex sessions](/plugins/codex-supervision) for setup,
pagination, local and paired-node continuation, and the metadata security boundary.

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

Catalog RPCs keep their normal method scopes: `sessions.catalog.list` and
`sessions.catalog.read` require `operator.read`; `sessions.catalog.continue` and
`sessions.catalog.archive` require `operator.write`.

Catalog visibility also follows the authenticated caller. An `operator.admin`
connection sees every discovered row. When the Gateway has durable profiles for
fewer than two people, catalog visibility is unchanged and rows remain unfiltered.
On a multi-user Gateway, a non-admin connection sees and can read, continue, or
archive only rows whose recorded `createdActor.id` matches the caller's Gateway
profile. Unattributed host CLI or desktop sessions are hidden from those callers.
This is a privacy and coordination boundary inside one trusted Gateway domain,
not hostile-user isolation; use separate agents or Gateway/host trust boundaries
when people must not share access to files, credentials, or tools. See
[Multi-user mode](/concepts/multi-user).

A Gateway-local Claude CLI row can be adopted from the normal Chat composer:
OpenClaw imports bounded visible history, resumes with `--fork-session` on the
first turn, and leaves the source transcript untouched.

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

### Host OpenClaw sessions

The macOS menu bar app and the headless node host can opt into full OpenClaw
session hosting with the same node-local setting:

```json5
{
  nodeHost: {
    workerRuns: { enabled: true },
  },
}
```

<Warning>
Only enable session hosting on a machine you trust as shared Gateway infrastructure. Hosting consent applies to the device, not to an individual person's ownership of it. Existing session authorization still controls who may dispatch work.
</Warning>

Restart the app or node host after enabling this setting. The macOS app owns
one paired node identity and uses the shared node runtime for session hosting;
do not start a second CLI node for the same Mac. Its native camera, screen, and
desktop capabilities remain on that identity. If the shared runtime cannot
start, native capabilities remain available, but session hosting is unavailable.

On the first session dispatch
for a Gateway build, the node downloads one sealed worker artifact from that
paired Gateway, verifies its exact content hash, and publishes it atomically
under the Gateway-namespaced node-host bundle root. The artifact already
contains its complete JavaScript dependency closure; the node does not install
packages or execute lifecycle scripts. Later turns reuse the immutable artifact
while its receipt still matches the Gateway's current build.

You can also enroll and enable a service host in one step with
`openclaw connect --service --session-host`. In Control UI New Session, a
write-scoped operator selects a Gateway project or folder and then either a
specific paired device or **Auto**. OpenClaw creates a
session-owned managed worktree on the Gateway, dispatches it with the exact
`deviceId` or `autoDevice: true`, and sends the first turn only after the chosen
device placement becomes active. New Session does not bind `execNode` or browse
the device filesystem.

The Devices page shows the validated Gateway-owned worker version in the node's
metadata. If the retained artifact is missing or fails validation, Devices shows
a **worker missing** warning; start a new session on that device to reinstall the
current bundle. This status is observational and reconnect-scoped: launch still
requires the exact durable receipt and current node authority.

Node hosts must support the current private worker-supervisor dialect before
they can host sessions. An older connected host remains visible but disabled in
the session picker. Update OpenClaw on that device and reconnect it; for a
headless node, run `openclaw update` followed by `openclaw node restart`. The
Gateway does not fall back to the node's local OpenClaw package or an older
supervisor dialect.

This setting enables supervised session turns on the paired device, including
Gateway-owned workspace transfer and result reconciliation. By default, each
node has one worker slot per available CPU core. Configure the slot count with
`nodeHost.workerRuns.capacity`. Launches beyond capacity wait up to 10 seconds
for a durable slot; while all slots are occupied, the node remains available
for status and cancellation but is not selected for a new session turn.

The picker derives every device row from `environments.list`. Every selected
runtime requires an available, connected paired session host. OpenClaw worker
turns additionally require valid exact worker slots with at least one free
slot. Codex paired-device execution launches its exec-server directly, so it
does not consume or require a worker slot; instead, its required command must
appear in the node's effective `invocableCommands`, not merely its declared
capabilities. A declared command is usable only when the approved pairing and
Gateway command allowlist both authorize it. Connected non-hosts, ineligible
or saturated hosts, update-required devices, and unavailable hosts remain
visible but disabled with an actionable reason. Enable hosting with
`openclaw connect --service --session-host` or the `nodeHost.workerRuns`
setting, then restart the node host. Update-required hosts must be upgraded and
restarted before selection.

While node inventory refreshes, or if that refresh fails, the picker keeps known
devices visible but disables remote selection and Start until fresh inventory
arrives. Local remains selectable; cached worker slots never authorize a new
remote session.

Choose **Auto** to let the Gateway select an eligible paired,
connected session host. For OpenClaw worker turns, it selects the host with the
most available worker slots and breaks ties by device ID. Runtimes that do not
consume worker slots choose the eligible host with the lowest device ID instead.
If a selected host disconnects, reaches capacity, or otherwise becomes
ineligible before dispatch finishes, the Gateway tries the next ranked host, up
to three hosts total. Other dispatch failures are returned immediately. If no
host is eligible, the error explains whether no session hosts are paired, hosts
are disconnected or at capacity, a host needs an update, or the selected runtime
is unsupported. The dispatch response identifies the device that was selected.

When a known session host disconnects, its paired-device record preserves only
the last accepted current-v6 hosting consent. The offline row remains visible
and disabled with status unavailable. A current disabled or empty v6
publication records false; older v1-v5 and update-required dialects do not
overwrite the last current fact. Connected inventory always wins over stored
history, a missing stored value means false, and exact worker slots are never
persisted or shown as offline capacity.

If the device is offline, its active placement remains active: availability is
process-current, not a terminal placement state. `sessions.list` and
`sessions.describe` project `runner: { kind: "device", status: "offline" }`
until that exact current-v6 node runner reconnects. Gateway restart therefore
shows an active device placement as offline until reconnect; current inventory
then changes the projection to `available` and emits a session refresh. Exact
worker slots gate only new placements whose runtime consumes a worker slot;
they do not affect Codex remote execution or an existing session's availability.

Control UI shows **Device offline** and waits by default without giving up the
placement, workspace, or authority. Retry the next turn after the device
returns. **Continue on Gateway…** is a separate destructive choice: it fences
the device owner and continues from the last Gateway-synced workspace without
replaying the interrupted turn. Unsynced device files and in-flight work may be
lost. A paired node remains dormant for 14 days after its exact recorded
disconnect; at that boundary its old worker environment is treated as gone and
the session placement reconciles normally. Pairing itself remains, so a later
reconnect can provision a fresh environment. Legacy pairings without exact node
disconnect history are retained fail-safe rather than expired from unrelated
device activity. Removing the device pairing, silently pruning a superseded
pairing, or removing only its node role invalidates clients first, then runs
targeted environment and placement reconciliation; explicit removal waits for
the credential fence before returning success, and the periodic sweep retries
failed provider or placement cleanup.

See [Anthropic: Claude sessions across computers](/providers/anthropic#claude-sessions-across-computers)
for the Control UI behavior and storage sources.

#### Isolate hosted worker sessions in containers

By default, hosted OpenClaw worker sessions run directly on the paired node.
Set `nodeHost.workerRuns.isolation` to `"container"` on that node to run each
worker inside its own container instead:

```json5
{
  nodeHost: {
    workerRuns: {
      enabled: true,
      isolation: "container",
      // Optional: use a digest-pinned, private-registry, or preloaded image.
      // containerImage: "registry.example.com/openclaw/node:22-slim",
    },
  },
}
```

Restart the node host after changing either setting. Isolation defaults to
`"none"`, preserving the existing direct-process behavior. This setting is
enforced locally on the node; the Gateway cannot silently disable it or fall
back to an unisolated worker.

Container isolation is supported on Linux and macOS node hosts; Windows is
unsupported because native Windows paths cannot be mounted at their original
paths inside the container. The node must have a working Docker-compatible
container engine. OpenClaw tries the `docker` CLI first, including Docker-backed
OrbStack installations, and then `podman`. The selected engine and daemon are
checked when the node host starts and again before each container is created.
If the platform is unsupported, neither engine works, or the daemon changes,
session hosting or the affected launch fails visibly instead of falling back to
an unisolated worker. Install or start the engine, verify `docker version` or
`podman version`, and restart the node host.

The default image is `node:22-slim`; the engine pulls it on first use when it
is not already present. Set `nodeHost.workerRuns.containerImage` to choose a
digest-pinned image, a private-registry image, or an image already available
to the engine. The image must provide a working Node.js 22 or newer runtime on
its standard executable search path. If the image cannot be pulled, is
inaccessible, or does not provide a suitable Node.js runtime, that session
launch fails visibly; it never retries as a bare host process. Preload the
image or configure registry access before hosting sessions on an offline or
restricted node.

Each worker container receives only two host bind mounts: its verified worker
bundle root is read-only, and its assigned session workspace is read-write.
Both are mounted at their original absolute host paths so the sealed bundle
and workspace descriptor remain valid; the session workspace is also the
container working directory. OpenClaw passes only the existing frozen,
non-secret worker environment allowlist and adds no other host mounts.
Container isolation protects the rest of the host filesystem and separates
the worker process, but the worker can still modify its assigned workspace
and connect to the Gateway.

The container uses the engine's normal outbound networking and must be able
to reach the Gateway worker WebSocket endpoint. A Gateway address such as
`127.0.0.1` or `localhost` that works on the node host points back into the
container when used by the worker; configure a Gateway address reachable from
the container network instead. If a Gateway requires a custom certificate
authority, `NODE_EXTRA_CA_CERTS` must point to a certificate already inside
the mounted bundle or session workspace; OpenClaw will not mount another host
path for it. Browser assignments that require access to host-only browser
state are not supported in container-isolated sessions.

Cancellation and fencing terminate the container itself rather than only the
container-engine client. The node host records the container's durable engine
and container identity, checks that identity during restart reconciliation,
and removes orphaned worker containers labeled for the same Gateway. If the
node-host process exits unexpectedly, a running container can survive until
the next node-host startup; keep the node host under a restarting service if
that cleanup window must remain short.

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

### Agent file transfers

The [File Transfer plugin](/plugins/reference/file-transfer) provides independently
selectable directory-listing, fetch, and write tools. Allowing one tool does not
make the others available; node-command and path policies still apply.

Every successful file fetch saves the bytes in the Gateway's file-transfer media
store and returns both `localPath` and `mediaId`, including for inlined text and
images. When node writing is available, pass that `mediaId` as `sourceMediaId` to
reuse the saved bytes. `sourceMediaId` does not accept a local path or an ID from
another media store. For inline bytes, use `contentBase64` instead.

## Invoking commands

Low-level (raw RPC):

```bash
openclaw nodes invoke --node <idOrNameOrIp> --command device.info --params '{}'
```

`nodes invoke` blocks `system.run` and `system.run.prepare`; those commands only run through the `exec` tool with `host=node` (see above). Higher-level helpers exist for the common "give the agent a MEDIA attachment" workflows (camera, screen, location, below).

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

Default allowlists by platform (before plugin defaults and `commands.allow`/`commands.deny` overrides):

| Platform | Commands allowed by default                                                                                                                                                                                                                                                                                                                                 |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| iOS      | `camera.list`, `location.get`, `device.info`, `device.status`, `contacts.search`, `calendar.events`, `reminders.list`, `photos.latest`, `motion.activity`, `motion.pedometer`, `system.notify`                                                                                                                                                              |
| watchOS  | `device.info`, `device.status`, `system.notify`                                                                                                                                                                                                                                                                                                             |
| Android  | `camera.list`, `location.get`, `notifications.list`, `notifications.actions`, `system.notify`, `device.info`, `device.status`, `device.permissions`, `device.health`, `device.apps`, `contacts.search`, `calendar.events`, `callLog.search`, `reminders.list`, `photos.latest`, `motion.activity`, `motion.pedometer`, `mobile.ui.observe`, `mobile.ui.act` |
| macOS    | `camera.list`, `camera.ptz.status`, `location.get`, `device.info`, `device.status`, `device.apps`, `contacts.search`, `calendar.events`, `reminders.list`, `photos.latest`, `motion.activity`, `motion.pedometer`, `system.notify`, `computer.act`                                                                                                          |
| Windows  | `camera.list`, `location.get`, `device.info`, `device.status`, `system.notify`, `computer.act`                                                                                                                                                                                                                                                              |
| Linux    | `system.notify`, `computer.act` (node host commands like `system.run` are approval-gated, see below)                                                                                                                                                                                                                                                        |

These rows describe the Gateway policy ceiling, not the commands implemented by every node app. A command is usable only when the connected node also declares it. In particular, Android advertises mobile UI commands only while Accessibility Control is enabled, and desktop nodes advertise `computer.act` only while their local Computer Control fulfiller is enabled. The current macOS app does not declare the device and personal-data families listed in the macOS policy row.

Plugin-owned defaults extend the platform table only for the plugin's supported
surface:

| Plugin | Platform | Commands allowed by default                        |
| ------ | -------- | -------------------------------------------------- |
| Canvas | macOS    | `canvas.present`, `canvas.hide`, `canvas.navigate` |

The Canvas commands present hosted widget documents in the macOS app's native
panel. iOS, Android, Windows, Linux, and unknown platforms do not receive Canvas
plugin defaults.

`talk.ptt.start`, `talk.ptt.stop`, `talk.ptt.cancel`, and `talk.ptt.once` are allowed by default for any node that advertises the `talk` capability or declares `talk.*` commands, independent of platform label.

Desktop host commands (`system.run`, `system.run.prepare`, `system.which`, `browser.proxy`, `browser.proxy.upload.v1`, `mcp.tools.call.v1`, and `screen.snapshot` on macOS/Windows/Linux) are not part of the static platform-default table above. They become available once the operator approves a pairing request that declares them, after which the node's approved command set carries them forward on reconnect.

Dangerous or privacy-heavy commands require a one-time persistent opt-in with `gateway.nodes.commands.allow`, even if a node declares them: `camera.snap`, `camera.clip`, `camera.ptz.control`, `desktop.stream`, `screen.record`, `contacts.add`, `calendar.add`, `reminders.add`, `health.summary`, `sms.send`, `sms.search`. `gateway.nodes.commands.deny` always wins over defaults and extra allowlist entries. See [Paired node desktops](/gateway/configuration-reference#paired-node-desktops), [HealthKit summaries](/platforms/ios-healthkit), and [Computer use](/nodes/computer-use) for the local enablement, pairing, capability, and tool-policy gates around desktop access.

Plugin-owned node commands can add a Gateway node-invoke policy. That policy runs after the allowlist check and before forwarding to the node, so raw `node.invoke`, CLI helpers, and dedicated agent tools share the same plugin permission boundary. Dangerous plugin node commands still require explicit `gateway.nodes.commands.allow` opt-in.

After a node changes its declared command list, reconnect it, inspect `openclaw nodes pending`, and approve the widened surface with `openclaw nodes approve <requestId>` so the Gateway stores the updated command snapshot.

## Config (`openclaw.json`)

Node-related settings live under `gateway.nodes` and `tools.exec`:

```json5
{
  gateway: {
    nodes: {
      // Auto-approve first-time node pairing from trusted networks (CIDR list).
      // Disabled when unset. Only applies to first-time role:node requests
      // with no requested scopes; does not auto-approve upgrades. This
      // approves the device only: the node's command/capability surface still
      // needs `openclaw nodes approve <requestId>` (see `openclaw nodes
      // pending`), because device pairing alone must not grant commands.
      // Silent same-host pairing behaves the same way. SSH-verified pairing
      // and node-profile setup codes approve the initial surface, since both
      // record explicit machine-ownership or admin consent.
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
      // Persistently enable dangerous/privacy-heavy node commands.
      commands: {
        allow: ["camera.snap", "desktop.stream", "screen.record"],
        // Block exact command names even if defaults or commands.allow include them.
        deny: ["camera.clip"],
      },
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

Use exact node command names. `commands.deny` removes a command even when a platform default or `commands.allow` entry would otherwise allow it. Paired nodes may publish agent-visible plugin tool descriptors by default, but each descriptor's command must still be in the node's approved command surface. Set `gateway.nodes.pluginTools.enabled: false` to ignore all such descriptors. See [Gateway configuration reference](/gateway/configuration-reference#gateway) for gateway node pairing and command-policy field details.

Per-agent exec node override:

```json5
{
  agents: {
    entries: {
      main: {
        default: true,
        tools: { exec: { node: "build-node" } },
      },
    },
  },
}
```

## macOS widget panel

```bash
openclaw nodes canvas present --node <idOrNameOrIp>
openclaw nodes canvas hide --node <idOrNameOrIp>
openclaw nodes canvas navigate "/__openclaw__/canvas/documents/<document-id>/index.html" --node <idOrNameOrIp>
```

Notes:

- `canvas present` accepts the existing optional target plus
  `--x/--y/--width/--height` placement arguments.
- `canvas navigate` accepts a hosted widget-document path or an app-local
  Canvas URL. The macOS app resolves hosted paths through its current scoped
  Canvas capability URL.
- The agent-facing path is [`show_widget`](/tools/show-widget) with
  `presentation.target: "node_panel"`; use the CLI helpers for direct operator
  control.
- A2UI renders on [session dashboards](/web/dashboards), not through node
  Canvas commands.

## Photos + videos (node camera)

Photos (`jpg`):

```bash
openclaw nodes camera list --node <idOrNameOrIp>
openclaw nodes camera snap --node <idOrNameOrIp>            # default: one node-selected photo
openclaw nodes camera snap --node <idOrNameOrIp> --facing front
openclaw nodes camera snap --node <idOrNameOrIp> --facing both # front then back (2 saved paths)
openclaw nodes camera snap --node <idOrNameOrIp> --device-id <id> --max-width 1200 --quality 0.9 --delay-ms 2000
```

Video clips (`mp4`):

```bash
openclaw nodes camera clip --node <idOrNameOrIp> --duration 10s
openclaw nodes camera clip --node <idOrNameOrIp> --duration 3000 --no-audio
```

Notes:

- The node must be **foregrounded** for `camera.*` (background calls return `NODE_BACKGROUND_UNAVAILABLE`).
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

Android nodes can expose `sms.send` and `sms.search` when the user grants **SMS** permission and the device supports telephony. Both commands are dangerous-by-default: the gateway operator must also add them to `gateway.nodes.commands.allow` before they can be invoked (see [Command policy](#command-policy)).

For read-only SMS search, opt in explicitly in `openclaw.json`:

```json5
{
  gateway: {
    nodes: {
      commands: { allow: ["sms.search"] },
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
- A `requires explicit gateway.nodes.commands.allow opt-in` error means the phone declared the command but the Gateway operator has not authorized it.

## Device and personal data commands

iOS and Android nodes advertise several read-only data commands by default (see the [Command policy](#command-policy) table); Android additionally exposes a larger family gated by its own in-app settings. A macOS or headless-mac TypeScript node host advertises `device.apps` only after the operator enables installed-app sharing with `--share-installed-apps`.

Available families:

- `device.status`, `device.info` — iOS, Android, Windows.
- `device.permissions`, `device.health` — Android only.
- `device.apps` — Android, macOS, and headless-mac nodes. Android requires Installed Apps sharing in Settings and returns launcher-visible apps by default. TypeScript node hosts keep sharing off by default and accept `query`, `limit`, and `includeSystem`; macOS results contain `label`, `bundleId`, `path`, and `system`.
- `notifications.list`, `notifications.actions` — Android only.
- `photos.latest` — iOS, Android.
- `contacts.search` — iOS, Android (read-only default); `contacts.add` is dangerous and needs `gateway.nodes.commands.allow`.
- `calendar.events` — iOS, Android (read-only default); `calendar.add` is dangerous and needs `gateway.nodes.commands.allow`.
- `reminders.list` — iOS, Android (read-only default); `reminders.add` is dangerous and needs `gateway.nodes.commands.allow`.
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

The macOS node and headless node host both expose `system.run.prepare`, `system.run`, `system.which`, and `system.execApprovals.get/set`; the macOS node also exposes `system.notify`.

Examples:

```bash
openclaw nodes notify --node <idOrNameOrIp> --title "Ping" --body "Gateway ready"
openclaw nodes invoke --node <idOrNameOrIp> --command system.which --params '{"bins":["git"]}'
```

Notes:

- `system.run` returns stdout/stderr/exit code in the payload.
- Shell execution now goes through the `exec` tool with `host=node`; `nodes` remains the direct-RPC surface for explicit node commands.
- `nodes invoke` does not expose `system.run` or `system.run.prepare`; those stay on the exec path only.
- The exec path reads the node policy and prepares a canonical `systemRunPlan`. Full/off execution resolves working-directory aliases without adding approval-only script checks. When caller or node policy requires approval binding, stricter path and script checks remain in place. Once an approval is granted, the gateway forwards that stored plan, not any later caller-edited command/cwd/session fields.
- `system.notify` respects notification permission state on the macOS app; supports `--priority <passive|active|timeSensitive>` and `--delivery <system|overlay|auto>`.
- Unrecognized node `platform` / `deviceFamily` metadata uses a conservative default allowlist that excludes `system.run` and `system.which`. If you intentionally need those commands for an unknown platform, add them explicitly via `gateway.nodes.commands.allow`.
- A `system.run` request supports `cwd`, an `env` map, `timeoutMs`, and `needsScreenRecording` — these are fields of the request payload carried on the exec path (see above), not `nodes invoke` CLI flags.
- For shell wrappers (`bash|sh|zsh ... -c/-lc`), request-scoped `env` values are reduced to an explicit allowlist (`TERM`, `LANG`, `LC_*`, `COLORTERM`, `NO_COLOR`, `FORCE_COLOR`).
- For allow-always decisions in allowlist mode, known dispatch wrappers (`env`, `flock`, `nice`, `nohup`, `stdbuf`, `timeout`) persist inner executable paths instead of wrapper paths. If unwrapping is not safe, no allowlist entry is persisted automatically.
- On Windows node hosts in allowlist mode, shell-wrapper runs via `cmd.exe /c` require approval (allowlist entry alone does not auto-allow the wrapper form).
- Node hosts ignore `PATH` overrides in the `env` object and strip a large, maintained set of interpreter/shell startup variables (for example `NODE_OPTIONS`, `PYTHONPATH`, `BASH_ENV`, `DYLD_*`, `LD_*`) before running a command. If you need extra PATH entries, configure the node host service environment (or install tools in standard locations) instead of passing `PATH` via `env`.
- On macOS node mode, `system.run` is gated by exec approvals in the macOS app (Settings → Exec approvals). Ask/allowlist/full behave the same as the headless node host; denied prompts return `SYSTEM_RUN_DENIED`.
- On headless node host, `system.run` is gated by the local SQLite exec approvals row; on macOS specifically, see the exec-host routing env vars under [Headless node host](#headless-node-host-cross-platform) below.

## Exec node binding

With no node target set, `exec host=node` selects the sole paired, connected node that supports `system.run`. Other paired devices do not make the selection ambiguous. If multiple executable nodes are connected, choose a target per call or bind exec to a specific node; the active Canvas target does not select the exec host. A bound or explicit target that is offline or cannot execute commands is rejected rather than redirected to another node.

A binding sets the default node for `exec host=node` and can be overridden per agent.

Global default:

```bash
openclaw config set tools.exec.node "node-id-or-name"
```

Per-agent override:

```bash
openclaw config get agents.entries
openclaw config set 'agents.entries.main.tools.exec.node' "node-id-or-name"
```

Unset the binding to use the sole eligible node, or choose a target per call when multiple eligible nodes are connected:

```bash
openclaw config unset tools.exec.node
openclaw config unset 'agents.entries.main.tools.exec.node'
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
- Exec approvals are enforced locally via
  `~/.openclaw/state/openclaw.sqlite#exec_approvals_config` (see [Exec approvals](/tools/exec-approvals)).
- On macOS, the headless node host executes `system.run` locally by default. Set `OPENCLAW_NODE_EXEC_HOST=app` to require the companion app exec host, with no local fallback. `OPENCLAW_NODE_EXEC_FALLBACK` does not change current routing.
- Add `--tls` / `--tls-fingerprint` when the Gateway WS uses TLS.

## Mac node mode

- The macOS menubar app connects to the Gateway WS server as a node (so `openclaw nodes …` works against this Mac).
- In remote mode, the app opens an SSH tunnel for the Gateway port and connects to `localhost`.
