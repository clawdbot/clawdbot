---
summary: "Exec approvals, allowlists, and sandbox escape prompts"
read_when:
  - Configuring exec approvals or allowlists
  - Implementing exec approval UX in the macOS app
  - Reviewing sandbox escape prompts and implications
title: "Exec Approvals"
---

# Exec approvals

Exec approvals are the **companion app / node host guardrail** for letting a sandboxed agent run
commands on a real host (`gateway` or `node`). Think of it like a safety interlock:
commands are allowed only when policy + allowlist + (optional) user approval all agree.
Exec approvals are **in addition** to tool policy and elevated gating (unless elevated is set to `full`, which skips approvals).
Effective policy is the **stricter** of `tools.exec.*` and approvals defaults; if an approvals field is omitted, the `tools.exec` value is used.
Host exec also uses the local approvals state on that machine. A host-local
`ask: "always"` in `~/.openclaw/exec-approvals.json` keeps prompting even if
session or config defaults request `ask: "on-miss"`.
Use `openclaw approvals get`, `openclaw approvals get --gateway`, or
`openclaw approvals get --node <id|name|ip>` to inspect the requested policy,
host policy sources, and the effective result.
For the local machine, `openclaw exec-policy show` exposes the same merged view and
`openclaw exec-policy set|preset` can synchronize the local requested policy with the
local host approvals file in one step. When a local scope requests `host=node`,
`openclaw exec-policy show` reports that scope as node-managed at runtime instead of
pretending the local approvals file is the effective source of truth.

If the companion app UI is **not available**, any request that requires a prompt is
resolved by the **ask fallback** (default: deny).

Native chat approval clients can also expose channel-specific affordances on the
pending approval message. For example, Matrix can seed reaction shortcuts on the
approval prompt (`✅` allow once, `❌` deny, and `♾️` allow always when available)
while still leaving the `/approve ...` commands in the message as a fallback.

## Where it applies

Exec approvals are enforced locally on the execution host:

- **gateway host** → `openclaw` process on the gateway machine
- **node host** → node runner (macOS companion app or headless node host)

Trust model note:

- Gateway-authenticated callers are trusted operators for that Gateway.
- Paired nodes extend that trusted operator capability onto the node host.
- Exec approvals reduce accidental execution risk, but are not a per-user auth boundary.
- Approved node-host runs bind canonical execution context: canonical cwd, exact argv, env
  binding when present, and pinned executable path when applicable.
- For shell scripts and direct interpreter/runtime file invocations, OpenClaw also tries to bind
  one concrete local file operand. If that bound file changes after approval but before execution,
  the run is denied instead of executing drifted content.
- This file binding is intentionally best-effort, not a complete semantic model of every
  interpreter/runtime loader path. If approval mode cannot identify exactly one concrete local
  file to bind, it refuses to mint an approval-backed run instead of pretending full coverage.

macOS split:

- **node host service** forwards `system.run` to the **macOS app** over local IPC.
- **macOS app** enforces approvals + executes the command in UI context.

## Settings and storage

Approvals live in a local JSON file on the execution host:

`~/.openclaw/exec-approvals.json`

Example schema:

```json
{
  "version": 1,
  "socket": {
    "path": "~/.openclaw/exec-approvals.sock",
    "token": "base64url-token"
  },
  "defaults": {
    "security": "deny",
    "ask": "on-miss",
    "askFallback": "deny",
    "autoAllowSkills": false
  },
  "agents": {
    "main": {
      "security": "allowlist",
      "ask": "on-miss",
      "askFallback": "deny",
      "autoAllowSkills": true,
      "allowlist": [
        {
          "id": "B0C8C0B3-2C2D-4F8A-9A3C-5A4B3C2D1E0F",
          "pattern": "~/Projects/**/bin/rg",
          "lastUsedAt": 1737150000000,
          "lastUsedCommand": "rg -n TODO",
          "lastResolvedPath": "/Users/user/Projects/.../bin/rg"
        }
      ]
    }
  }
}
```

## No-approval "YOLO" mode

If you want host exec to run without approval prompts, you must open **both** policy layers:

- requested exec policy in OpenClaw config (`tools.exec.*`)
- host-local approvals policy in `~/.openclaw/exec-approvals.json`

This is now the default host behavior unless you tighten it explicitly:

- `tools.exec.security`: `full` on `gateway`/`node`
- `tools.exec.ask`: `off`
- host `askFallback`: `full`

Important distinction:

- `tools.exec.host=auto` chooses where exec runs: sandbox when available, otherwise gateway.
- YOLO chooses how host exec is approved: `security=full` plus `ask=off`.
- In YOLO mode, OpenClaw does not add a separate heuristic command-obfuscation approval gate or script-preflight rejection layer on top of the configured host exec policy.
- `auto` does not make gateway routing a free override from a sandboxed session. A per-call `host=node` request is allowed from `auto`, and `host=gateway` is only allowed from `auto` when no sandbox runtime is active. If you want a stable non-auto default, set `tools.exec.host` or use `/exec host=...` explicitly.

If you want a more conservative setup, tighten either layer back to `allowlist` / `on-miss`
or `deny`.

Persistent gateway-host "never prompt" setup:

```bash
openclaw config set tools.exec.host gateway
openclaw config set tools.exec.security full
openclaw config set tools.exec.ask off
openclaw gateway restart
```

Then set the host approvals file to match:

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

Local shortcut for the same gateway-host policy on the current machine:

```bash
openclaw exec-policy preset yolo
```

That local shortcut updates both:

- local `tools.exec.host/security/ask`
- local `~/.openclaw/exec-approvals.json` defaults

It is intentionally local-only. If you need to change gateway-host or node-host approvals
remotely, continue using `openclaw approvals set --gateway` or
`openclaw approvals set --node <id|name|ip>`.

For a node host, apply the same approvals file on that node instead:

```bash
openclaw approvals set --node <id|name|ip> --stdin <<'EOF'
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

Important local-only limitation:

- `openclaw exec-policy` does not synchronize node approvals
- `openclaw exec-policy set --host node` is rejected
- node exec approvals are fetched from the node at runtime, so node-targeted updates must use `openclaw approvals --node ...`

Session-only shortcut:

- `/exec security=full ask=off` changes only the current session.
- `/elevated full` is a break-glass shortcut that also skips exec approvals for that session.

If the host approvals file stays stricter than config, the stricter host policy still wins.

## Policy knobs

### Security (`exec.security`)

- **deny**: block all host exec requests.
- **allowlist**: allow only allowlisted commands.
- **full**: allow everything (equivalent to elevated).

### Ask (`exec.ask`)

- **off**: never prompt.
- **on-miss**: prompt only when allowlist does not match.
- **always**: prompt on every command.
- `allow-always` durable trust does not suppress prompts when effective ask mode is `always`

### Ask fallback (`askFallback`)

If a prompt is required but no UI is reachable, fallback decides:

- **deny**: block.
- **allowlist**: allow only if allowlist matches.
- **full**: allow.

### Inline interpreter eval hardening (`tools.exec.strictInlineEval`)

When `tools.exec.strictInlineEval=true`, OpenClaw treats inline code-eval forms as approval-only even if the interpreter binary itself is allowlisted.

Examples:

- `python -c`
- `node -e`, `node --eval`, `node -p`
- `ruby -e`
- `perl -e`, `perl -E`
- `php -r`
- `lua -e`
- `osascript -e`

This is defense-in-depth for interpreter loaders that do not map cleanly to one stable file operand. In strict mode:

- these commands still need explicit approval;
- `allow-always` does not persist new allowlist entries for them automatically.

## Allowlist (per agent)

Allowlists are **per agent**. If multiple agents exist, switch which agent you’re
editing in the macOS app. Patterns are **case-insensitive glob matches**.
Patterns should resolve to **binary paths** (basename-only entries are ignored).
Legacy `agents.default` entries are migrated to `agents.main` on load.
Shell chains such as `echo ok && pwd` still need every top-level segment to satisfy allowlist rules.

Examples:

- `~/Projects/**/bin/peekaboo`
- `~/.local/bin/*`
- `/opt/homebrew/bin/rg`

Each allowlist entry tracks:

- **id** stable UUID used for UI identity (optional)
- **last used** timestamp
- **last used command**
- **last resolved path**

## Auto-allow skill CLIs

When **Auto-allow skill CLIs** is enabled, executables referenced by known skills
are treated as allowlisted on nodes (macOS node or headless node host). This uses
`skills.bins` over the Gateway RPC to fetch the skill bin list. Disable this if you want strict manual allowlists.

Important trust notes:

- This is an **implicit convenience allowlist**, separate from manual path allowlist entries.
- It is intended for trusted operator environments where Gateway and node are in the same trust boundary.
- If you require strict explicit trust, keep `autoAllowSkills: false` and use manual path allowlist entries only.

## Safe bins (stdin-only)

`tools.exec.safeBins` defines a small list of **stdin-only** binaries (for example `cut`)
that can run in allowlist mode **without** explicit allowlist entries. Safe bins reject
positional file args and path-like tokens, so they can only operate on the incoming stream.
Treat this as a narrow fast-path for stream filters, not a general trust list.
Do **not** add interpreter or runtime binaries (for example `python3`, `node`, `ruby`, `bash`, `sh`, `zsh`) to `safeBins`.
If a command can evaluate code, execute subcommands, or read files by design, prefer explicit allowlist entries and keep approval prompts enabled.
Custom safe bins must define an explicit profile in `tools.exec.safeBinProfiles.<bin>`.
Validation is deterministic from argv shape only (no host filesystem existence checks), which
prevents file-existence oracle behavior from allow/deny differences.
File-oriented options are denied for default safe bins (for example `sort -o`, `sort --output`,
`sort --files0-from`, `sort --compress-program`, `sort --random-source`,
`sort --temporary-directory`/`-T`, `wc --files0-from`, `jq -f/--from-file`,
`grep -f/--file`).
Safe bins also enforce explicit per-binary flag policy for options that break stdin-only
behavior (for example `sort -o/--output/--compress-program` and grep recursive flags).
Long options are validated fail-closed in safe-bin mode: unknown flags and ambiguous
abbreviations are rejected.
Denied flags by safe-bin profile:

[//]: # "SAFE_BIN_DENIED_FLAGS:START"

- `grep`: `--dereference-recursive`, `--directories`, `--exclude-from`, `--file`, `--recursive`, `-R`, `-d`, `-f`, `-r`
- `jq`: `--argfile`, `--from-file`, `--library-path`, `--rawfile`, `--slurpfile`, `-L`, `-f`
- `sort`: `--compress-program`, `--files0-from`, `--output`, `--random-source`, `--temporary-directory`, `-T`, `-o`
- `wc`: `--files0-from`

[//]: # "SAFE_BIN_DENIED_FLAGS:END"

Safe bins also force argv tokens to be treated as **literal text** at execution time (no globbing
and no `$VARS` expansion) for stdin-only segments, so patterns like `*` or `$HOME/...` cannot be
used to smuggle file reads.
Safe bins must also resolve from trusted binary directories (system defaults plus optional
`tools.exec.safeBinTrustedDirs`). `PATH` entries are never auto-trusted.
Default trusted safe-bin directories are intentionally minimal: `/bin`, `/usr/bin`.
If your safe-bin executable lives in package-manager/user paths (for example
`/opt/homebrew/bin`, `/usr/local/bin`, `/opt/local/bin`, `/snap/bin`), add them explicitly
to `tools.exec.safeBinTrustedDirs`.
Shell chaining and redirections are not auto-allowed in allowlist mode.

Shell chaining (`&&`, `||`, `;`) is allowed when every top-level segment satisfies the allowlist
(including safe bins or skill auto-allow). Redirections remain unsupported in allowlist mode.
Command substitution (`$()` / backticks) is rejected during allowlist parsing, including inside
double quotes; use single quotes if you need literal `$()` text.
On macOS companion-app approvals, raw shell text containing shell control or expansion syntax
(`&&`, `||`, `;`, `|`, `` ` ``, `$`, `<`, `>`, `(`, `)`) is treated as an allowlist miss unless
the shell binary itself is allowlisted.
For shell wrappers (`bash|sh|zsh ... -c/-lc`), request-scoped env overrides are reduced to a
small explicit allowlist (`TERM`, `LANG`, `LC_*`, `COLORTERM`, `NO_COLOR`, `FORCE_COLOR`).
For allow-always decisions in allowlist mode, known dispatch wrappers
(`env`, `nice`, `nohup`, `stdbuf`, `timeout`) persist inner executable paths instead of wrapper
paths. Shell multiplexers (`busybox`, `toybox`) are also unwrapped for shell applets (`sh`, `ash`,
etc.) so inner executables are persisted instead of multiplexer binaries. If a wrapper or
multiplexer cannot be safely unwrapped, no allowlist entry is persisted automatically.
If you allowlist interpreters like `python3` or `node`, prefer `tools.exec.strictInlineEval=true` so inline eval still requires an explicit approval. In strict mode, `allow-always` can still persist benign interpreter/script invocations, but inline-eval carriers are not persisted automatically.

Default safe bins:

[//]: # "SAFE_BIN_DEFAULTS:START"

`cut`, `uniq`, `head`, `tail`, `tr`, `wc`

[//]: # "SAFE_BIN_DEFAULTS:END"

`grep` and `sort` are not in the default list. If you opt in, keep explicit allowlist entries for
their non-stdin workflows.
For `grep` in safe-bin mode, provide the pattern with `-e`/`--regexp`; positional pattern form is
rejected so file operands cannot be smuggled as ambiguous positionals.

### Safe bins versus allowlist

| Topic            | `tools.exec.safeBins`                                  | Allowlist (`exec-approvals.json`)                            |
| ---------------- | ------------------------------------------------------ | ------------------------------------------------------------ |
| Goal             | Auto-allow narrow stdin filters                        | Explicitly trust specific executables                        |
| Match type       | Executable name + safe-bin argv policy                 | Resolved executable path glob pattern                        |
| Argument scope   | Restricted by safe-bin profile and literal-token rules | Path match only; arguments are otherwise your responsibility |
| Typical examples | `head`, `tail`, `tr`, `wc`                             | `jq`, `python3`, `node`, `ffmpeg`, custom CLIs               |
| Best use         | Low-risk text transforms in pipelines                  | Any tool with broader behavior or side effects               |

Configuration location:

- `safeBins` comes from config (`tools.exec.safeBins` or per-agent `agents.list[].tools.exec.safeBins`).
- `safeBinTrustedDirs` comes from config (`tools.exec.safeBinTrustedDirs` or per-agent `agents.list[].tools.exec.safeBinTrustedDirs`).
- `safeBinProfiles` comes from config (`tools.exec.safeBinProfiles` or per-agent `agents.list[].tools.exec.safeBinProfiles`). Per-agent profile keys override global keys.
- allowlist entries live in host-local `~/.openclaw/exec-approvals.json` under `agents.<id>.allowlist` (or via Control UI / `openclaw approvals allowlist ...`).
- `openclaw security audit` warns with `tools.exec.safe_bins_interpreter_unprofiled` when interpreter/runtime bins appear in `safeBins` without explicit profiles.
- `openclaw doctor --fix` can scaffold missing custom `safeBinProfiles.<bin>` entries as `{}` (review and tighten afterward). Interpreter/runtime bins are not auto-scaffolded.

Custom profile example:

```json5
{
  tools: {
    exec: {
      safeBins: ["jq", "myfilter"],
      safeBinProfiles: {
        myfilter: {
          minPositional: 0,
          maxPositional: 0,
          allowedValueFlags: ["-n", "--limit"],
          deniedFlags: ["-f", "--file", "-c", "--command"],
        },
      },
    },
  },
}
```

If you explicitly opt `jq` into `safeBins`, OpenClaw still rejects the `env` builtin in safe-bin
mode so `jq -n env` cannot dump the host process environment without an explicit allowlist path
or approval prompt.

## Control UI editing

Use the **Control UI → Nodes → Exec approvals** card to edit defaults, per‑agent
overrides, and allowlists. Pick a scope (Defaults or an agent), tweak the policy,
add/remove allowlist patterns, then **Save**. The UI shows **last used** metadata
per pattern so you can keep the list tidy.

The target selector chooses **Gateway** (local approvals) or a **Node**. Nodes
must advertise `system.execApprovals.get/set` (macOS app or headless node host).
If a node does not advertise exec approvals yet, edit its local
`~/.openclaw/exec-approvals.json` directly.

CLI: `openclaw approvals` supports gateway or node editing (see [Approvals CLI](/cli/approvals)).

## Approval flow

When a prompt is required, the gateway broadcasts `exec.approval.requested` to operator clients.
The Control UI and macOS app resolve it via `exec.approval.resolve`, then the gateway forwards the
approved request to the node host.

For `host=node`, approval requests include a canonical `systemRunPlan` payload. The gateway uses
that plan as the authoritative command/cwd/session context when forwarding approved `system.run`
requests.

That matters for async approval latency:

- the node exec path prepares one canonical plan up front
- the approval record stores that plan and its binding metadata
- once approved, the final forwarded `system.run` call reuses the stored plan
  instead of trusting later caller edits
- if the caller changes `command`, `rawCommand`, `cwd`, `agentId`, or
  `sessionKey` after the approval request was created, the gateway rejects the
  forwarded run as an approval mismatch

## Interpreter/runtime commands

Approval-backed interpreter/runtime runs are intentionally conservative:

- Exact argv/cwd/env context is always bound.
- Direct shell script and direct runtime file forms are best-effort bound to one concrete local
  file snapshot.
- Common package-manager wrapper forms that still resolve to one direct local file (for example
  `pnpm exec`, `pnpm node`, `npm exec`, `npx`) are unwrapped before binding.
- If OpenClaw cannot identify exactly one concrete local file for an interpreter/runtime command
  (for example package scripts, eval forms, runtime-specific loader chains, or ambiguous multi-file
  forms), approval-backed execution is denied instead of claiming semantic coverage it does not
  have.
- For those workflows, prefer sandboxing, a separate host boundary, or an explicit trusted
  allowlist/full workflow where the operator accepts the broader runtime semantics.

When approvals are required, the exec tool returns immediately with an approval id. Use that id to
correlate later system events (`Exec finished` / `Exec denied`). If no decision arrives before the
timeout, the request is treated as an approval timeout and surfaced as a denial reason.

### Followup delivery behavior

After an approved async exec finishes, OpenClaw sends a followup `agent` turn to the same session.

- If a valid external delivery target exists (deliverable channel plus target `to`), followup delivery uses that channel.
- In webchat-only or internal-session flows with no external target, followup delivery stays session-only (`deliver: false`).
- If a caller explicitly requests strict external delivery with no resolvable external channel, the request fails with `INVALID_REQUEST`.
- If `bestEffortDeliver` is enabled and no external channel can be resolved, delivery is downgraded to session-only instead of failing.

The confirmation dialog includes:

- command + args
- cwd
- agent id
- resolved executable path
- host + policy metadata

Actions:

- **Allow once** → run now
- **Always allow** → add to allowlist + run
- **Deny** → block

## Approval forwarding to chat channels

You can forward exec approval prompts to any chat channel (including plugin channels) and approve
them with `/approve`. This uses the normal outbound delivery pipeline.

Config:

```json5
{
  approvals: {
    exec: {
      enabled: true,
      mode: "session", // "session" | "targets" | "both"
      agentFilter: ["main"],
      sessionFilter: ["discord"], // substring or regex
      targets: [
        { channel: "slack", to: "U12345678" },
        { channel: "telegram", to: "123456789" },
      ],
    },
  },
}
```

Reply in chat:

```
/approve <id> allow-once
/approve <id> allow-always
/approve <id> deny
```

The `/approve` command handles both exec approvals and plugin approvals. If the ID does not match a pending exec approval, it automatically checks plugin approvals instead.

### Plugin approval forwarding

Plugin approval forwarding uses the same delivery pipeline as exec approvals but has its own
independent config under `approvals.plugin`. Enabling or disabling one does not affect the other.

```json5
{
  approvals: {
    plugin: {
      enabled: true,
      mode: "targets",
      agentFilter: ["main"],
      targets: [
        { channel: "slack", to: "U12345678" },
        { channel: "telegram", to: "123456789" },
      ],
    },
  },
}
```

The config shape is identical to `approvals.exec`: `enabled`, `mode`, `agentFilter`,
`sessionFilter`, and `targets` work the same way.

Channels that support shared interactive replies render the same approval buttons for both exec and
plugin approvals. Channels without shared interactive UI fall back to plain text with `/approve`
instructions.

### Same-chat approvals on any channel

When an exec or plugin approval request originates from a deliverable chat surface, the same chat
can now approve it with `/approve` by default. This applies to channels such as Slack, Matrix, and
Microsoft Teams in addition to the existing Web UI and terminal UI flows.

This shared text-command path uses the normal channel auth model for that conversation. If the
originating chat can already send commands and receive replies, approval requests no longer need a
separate native delivery adapter just to stay pending.

Discord and Telegram also support same-chat `/approve`, but those channels still use their
resolved approver list for authorization even when native approval delivery is disabled.

For Telegram and other native approval clients that call the Gateway directly,
this fallback is intentionally bounded to "approval not found" failures. A real
exec approval denial/error does not silently retry as a plugin approval.

### Native approval delivery

Some channels can also act as native approval clients. Native clients add approver DMs, origin-chat
fanout, and channel-specific interactive approval UX on top of the shared same-chat `/approve`
flow.

When native approval cards/buttons are available, that native UI is the primary
agent-facing path. The agent should not also echo a duplicate plain chat
`/approve` command unless the tool result says chat approvals are unavailable or
manual approval is the only remaining path.

Generic model:

- host exec policy still decides whether exec approval is required
- `approvals.exec` controls forwarding approval prompts to other chat destinations
- `channels.<channel>.execApprovals` controls whether that channel acts as a native approval client

Native approval clients auto-enable DM-first delivery when all of these are true:

- the channel supports native approval delivery
- approvers can be resolved from explicit `execApprovals.approvers` or that
  channel's documented fallback sources
- `channels.<channel>.execApprovals.enabled` is unset or `"auto"`

Set `enabled: false` to disable a native approval client explicitly. Set `enabled: true` to force
it on when approvers resolve. Public origin-chat delivery stays explicit through
`channels.<channel>.execApprovals.target`.

FAQ: [Why are there two exec approval configs for chat approvals?](/help/faq#why-are-there-two-exec-approval-configs-for-chat-approvals)

- Discord: `channels.discord.execApprovals.*`
- Slack: `channels.slack.execApprovals.*`
- Telegram: `channels.telegram.execApprovals.*`

These native approval clients add DM routing and optional channel fanout on top of the shared
same-chat `/approve` flow and shared approval buttons.

Shared behavior:

- Slack, Matrix, Microsoft Teams, and similar deliverable chats use the normal channel auth model
  for same-chat `/approve`
- when a native approval client auto-enables, the default native delivery target is approver DMs
- for Discord and Telegram, only resolved approvers can approve or deny
- Discord approvers can be explicit (`execApprovals.approvers`) or inferred from `commands.ownerAllowFrom`
- Telegram approvers can be explicit (`execApprovals.approvers`) or inferred from existing owner config (`allowFrom`, plus direct-message `defaultTo` where supported)
- Slack approvers can be explicit (`execApprovals.approvers`) or inferred from `commands.ownerAllowFrom`
- Slack native buttons preserve approval id kind, so `plugin:` ids can resolve plugin approvals
  without a second Slack-local fallback layer
- Matrix native DM/channel routing and reaction shortcuts handle both exec and plugin approvals;
  plugin authorization still comes from `channels.matrix.dm.allowFrom`
- the requester does not need to be an approver
- the originating chat can approve directly with `/approve` when that chat already supports commands and replies
- native Discord approval buttons route by approval id kind: `plugin:` ids go
  straight to plugin approvals, everything else goes to exec approvals
- native Telegram approval buttons follow the same bounded exec-to-plugin fallback as `/approve`
- when native `target` enables origin-chat delivery, approval prompts include the command text
- pending exec approvals expire after 30 minutes by default
- if no operator UI or configured approval client can accept the request, the prompt falls back to `askFallback`

Telegram defaults to approver DMs (`target: "dm"`). You can switch to `channel` or `both` when you
want approval prompts to appear in the originating Telegram chat/topic as well. For Telegram forum
topics, OpenClaw preserves the topic for the approval prompt and the post-approval follow-up.

See:

- [Discord](/channels/discord)
- [Telegram](/channels/telegram)

### macOS IPC flow

```
Gateway -> Node Service (WS)
                 |  IPC (UDS + token + HMAC + TTL)
                 v
             Mac App (UI + approvals + system.run)
```

Security notes:

- Unix socket mode `0600`, token stored in `exec-approvals.json`.
- Same-UID peer check.
- Challenge/response (nonce + HMAC token + request hash) + short TTL.

## System events

Exec lifecycle is surfaced as system messages:

- `Exec running` (only if the command exceeds the running notice threshold)
- `Exec finished`
- `Exec denied`

These are posted to the agent’s session after the node reports the event.
Gateway-host exec approvals emit the same lifecycle events when the command finishes (and optionally when running longer than the threshold).
Approval-gated execs reuse the approval id as the `runId` in these messages for easy correlation.

## Denied approval behavior

When an async exec approval is denied, OpenClaw prevents the agent from reusing
output from any earlier run of the same command in the session. The denial reason
is passed with explicit guidance that no command output is available, which stops
the agent from claiming there is new output or repeating the denied command with
stale results from a prior successful run.

## Implications

- **full** is powerful; prefer allowlists when possible.
- **ask** keeps you in the loop while still allowing fast approvals.
- Per-agent allowlists prevent one agent’s approvals from leaking into others.
- Approvals only apply to host exec requests from **authorized senders**. Unauthorized senders cannot issue `/exec`.
- `/exec security=full` is a session-level convenience for authorized operators and skips approvals by design.
  To hard-block host exec, set approvals security to `deny` or deny the `exec` tool via tool policy.

Related:

- [Exec tool](/tools/exec)
- [Elevated mode](/tools/elevated)
- [Skills](/tools/skills)

## Related

- [Exec](/tools/exec) — shell command execution tool
- [Sandboxing](/gateway/sandboxing) — sandbox modes and workspace access
- [Security](/gateway/security) — security model and hardening
- [Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated) — when to use each
