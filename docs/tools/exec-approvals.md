---
summary: "Host exec approvals: policy knobs, allowlists, and the YOLO/strict workflow"
read_when:
  - Configuring exec approvals or allowlists
  - Implementing exec approval UX in the macOS app
  - Reviewing sandbox-escape prompts and their implications
title: "Exec approvals"
sidebarTitle: "Exec approvals"
---

Exec approvals are the **companion app / node host guardrail** for letting
a sandboxed agent run commands on a real host (`gateway` or `node`). A
safety interlock: commands are allowed only when policy + allowlist +
(optional) user approval all agree. Exec approvals stack **on top of**
tool policy and elevated gating (unless elevated is set to `full`, which
skips approvals).

<Note>
Effective policy is the **stricter** of `tools.exec.*` and approvals
defaults; if an approvals field is omitted, the `tools.exec` value is
used. Host exec also uses local approvals state on that machine - a
host-local `ask: "always"` in `~/.openclaw/exec-approvals.json` keeps
prompting even if session or config defaults request `ask: "on-miss"`.
</Note>

## Inspecting the effective policy

| Command                                                          | What it shows                                                                          |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `openclaw approvals get` / `--gateway` / `--node <id\|name\|ip>` | Requested policy, host policy sources, and the effective result.                       |
| `openclaw exec-policy show`                                      | Local-machine merged view.                                                             |
| `openclaw exec-policy set` / `preset`                            | Synchronize the local requested policy with the local host approvals file in one step. |

When a local scope requests `host=node`, `exec-policy show` reports that
scope as node-managed at runtime instead of pretending the local
approvals file is the source of truth.

If the companion app UI is **not available**, any request that would
normally prompt is resolved by the **ask fallback** (default: `deny`).

<Tip>
Native chat approval clients can seed channel-specific affordances on the
pending approval message. For example, Matrix seeds reaction shortcuts
(`✅` allow once, `❌` deny, `♾️` allow always) while still leaving
`/approve ...` commands in the message as a fallback.
</Tip>

## Where it applies

Exec approvals are enforced locally on the execution host:

- **Gateway host** → `openclaw` process on the gateway machine.
- **Node host** → node runner (macOS companion app or headless node host).

### Trust model

- Gateway-authenticated callers are trusted operators for that Gateway.
- Paired nodes extend that trusted operator capability onto the node host.
- Exec approvals reduce accidental execution risk, but are **not** a per-user auth boundary or filesystem read-only policy.
- Once approved, a command can mutate files according to the selected host or sandbox filesystem permissions.
- Approved node-host runs bind canonical execution context: canonical cwd, exact argv, env binding when present, and pinned executable path when applicable.
- For shell scripts and direct interpreter/runtime file invocations, OpenClaw also tries to bind one concrete local file operand. If that bound file changes after approval but before execution, the run is denied instead of executing drifted content.
- File binding is intentionally best-effort, **not** a complete semantic model of every interpreter/runtime loader path. If approval mode cannot identify exactly one concrete local file to bind, it refuses to mint an approval-backed run instead of pretending full coverage.

### macOS split

- The **node host service** forwards `system.run` to the **macOS app** over local IPC.
- The **macOS app** enforces approvals and executes the command in UI context.

## Settings and storage

Approvals live in a local JSON file on the execution host:

```text
~/.openclaw/exec-approvals.json
```

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
          "source": "allow-always",
          "commandText": "rg -n TODO",
          "lastUsedAt": 1737150000000,
          "lastUsedCommand": "rg -n TODO",
          "lastResolvedPath": "/Users/user/Projects/.../bin/rg"
        }
      ]
    }
  }
}
```

## Policy knobs

### `exec.security`

<ParamField path="security" type='"deny" | "allowlist" | "full"'>
  - `deny` - block all host exec requests.
  - `allowlist` - allow only allowlisted commands.
  - `full` - allow everything (equivalent to elevated).

</ParamField>

### `exec.ask`

<ParamField path="ask" type='"off" | "on-miss" | "always"'>
  - `off` - never prompt.
  - `on-miss` - prompt only when the allowlist does not match.
  - `always` - prompt on every command. `allow-always` durable trust does **not** suppress prompts when effective ask mode is `always`.

</ParamField>

### `askFallback`

<ParamField path="askFallback" type='"deny" | "allowlist" | "full"'>
  Resolution when a prompt is required but no UI is reachable.

- `deny` - block.
- `allowlist` - allow only if allowlist matches.
- `full` - allow.

</ParamField>

### `tools.exec.strictInlineEval`

<ParamField path="strictInlineEval" type="boolean">
  When `true`, OpenClaw treats inline code-eval forms as approval-only
  even if the interpreter binary itself is allowlisted. Defense-in-depth
  for interpreter loaders that do not map cleanly to one stable file
  operand.
</ParamField>

Examples that strict mode catches:

- `python -c`
- `node -e`, `node --eval`, `node -p`
- `ruby -e`
- `perl -e`, `perl -E`
- `php -r`
- `lua -e`
- `osascript -e`

In strict mode these commands still need explicit approval, and
`allow-always` does not persist new allowlist entries for them
automatically.

## YOLO mode (no-approval)

If you want host exec to run without approval prompts, you must open
**both** policy layers - requested exec policy in OpenClaw config
(`tools.exec.*`) **and** host-local approvals policy in
`~/.openclaw/exec-approvals.json`.

YOLO is the default host behavior unless you tighten it explicitly:

| Layer                 | YOLO setting               |
| --------------------- | -------------------------- |
| `tools.exec.security` | `full` on `gateway`/`node` |
| `tools.exec.ask`      | `off`                      |
| Host `askFallback`    | `full`                     |

<Warning>
**Important distinctions:**

- `tools.exec.host=auto` chooses **where** exec runs: sandbox when available, otherwise gateway.
- YOLO chooses **how** host exec is approved: `security=full` plus `ask=off`.
- In YOLO mode, OpenClaw does **not** add a separate heuristic command-obfuscation approval gate or script-preflight rejection layer on top of the configured host exec policy.
- `auto` does not make gateway routing a free override from a sandboxed session. A per-call `host=node` request is allowed from `auto`; `host=gateway` is only allowed from `auto` when no sandbox runtime is active. For a stable non-auto default, set `tools.exec.host` or use `/exec host=...` explicitly.

</Warning>

CLI-backed providers that expose their own noninteractive permission mode
can follow this policy. Claude CLI adds
`--permission-mode bypassPermissions` when OpenClaw's requested exec
policy is YOLO. Override that backend behavior with explicit Claude args
under `agents.defaults.cliBackends.claude-cli.args` / `resumeArgs` -
for example `--permission-mode default`, `acceptEdits`, or
`bypassPermissions`.

If you want a more conservative setup, tighten either layer back to
`allowlist` / `on-miss` or `deny`.

### Persistent gateway-host "never prompt" setup

<Steps>
  <Step title="Set the requested config policy">
    ```bash
    openclaw config set tools.exec.host gateway
    openclaw config set tools.exec.security full
    openclaw config set tools.exec.ask off
    openclaw gateway restart
    ```
  </Step>
  <Step title="Match the host approvals file">
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
  </Step>
</Steps>

### Local shortcut

```bash
openclaw exec-policy preset yolo
```

That local shortcut updates both:

- Local `tools.exec.host/security/ask`.
- Local `~/.openclaw/exec-approvals.json` defaults.

It is intentionally local-only. To change gateway-host or node-host
approvals remotely, use `openclaw approvals set --gateway` or
`openclaw approvals set --node <id|name|ip>`.

### Node host

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

<Note>
**Local-only limitations:**

- `openclaw exec-policy` does not synchronize node approvals.
- `openclaw exec-policy set --host node` is rejected.
- Node exec approvals are fetched from the node at runtime, so node-targeted updates must use `openclaw approvals --node ...`.

</Note>

### Session-only shortcut

- `/exec security=full ask=off` changes only the current session.
- `/elevated full` is a break-glass shortcut that also skips exec approvals for that session.

If the host approvals file stays stricter than config, the stricter host
policy still wins.

## Allowlist (per agent)

Allowlists are **per agent**. If multiple agents exist, switch which agent
you are editing in the macOS app. Patterns are glob matches.

Patterns can be resolved binary path globs or bare command-name globs.
Bare names match only commands invoked through `PATH`, so `rg` can match
`/opt/homebrew/bin/rg` when the command is `rg`, but **not** `./rg` or
`/tmp/rg`. Use a path glob when you want to trust one specific binary
location.

Legacy `agents.default` entries are migrated to `agents.main` on load.
Shell chains such as `echo ok && pwd` still need every top-level segment
to satisfy allowlist rules.

Examples:

- `rg`
- `~/Projects/**/bin/peekaboo`
- `~/.local/bin/*`
- `/opt/homebrew/bin/rg`

### Restricting arguments with argPattern

Add `argPattern` when an allowlist entry should match a binary and a
specific argument shape. OpenClaw evaluates the regular expression
against the parsed command arguments, excluding the executable token
(`argv[0]`). For hand-authored entries, arguments are joined with a
single space, so anchor the pattern when you need an exact match.

```json
{
  "version": 1,
  "agents": {
    "main": {
      "allowlist": [
        {
          "pattern": "python3",
          "argPattern": "^safe\\.py$"
        }
      ]
    }
  }
}
```

That entry allows `python3 safe.py`; `python3 other.py` is an allowlist
miss. If a path-only entry for the same binary is also present, unmatched
arguments can still fall back to that path-only entry. Omit the path-only
entry when the goal is to restrict the binary to the declared arguments.

Entries saved by approval flows can use an internal separator format for
exact argv matching. Prefer the UI or approval flow to regenerate those
entries instead of hand-editing the encoded value. If OpenClaw cannot
parse argv for a command segment, entries with `argPattern` do not match.

Each allowlist entry supports:

| Field              | Meaning                                                       |
| ------------------ | ------------------------------------------------------------- |
| `pattern`          | Resolved binary path glob or bare command-name glob           |
| `argPattern`       | Optional argv regex; omitted entries are path-only            |
| `id`               | Stable UUID used for UI identity                              |
| `source`           | Entry source, such as `allow-always`                          |
| `commandText`      | Command text captured when an approval flow created the entry |
| `lastUsedAt`       | Last-used timestamp                                           |
| `lastUsedCommand`  | Last command that matched                                     |
| `lastResolvedPath` | Last resolved binary path                                     |

## Auto-allow skill CLIs

When **Auto-allow skill CLIs** is enabled, executables referenced by
known skills are treated as allowlisted on nodes (macOS node or headless
node host). This uses `skills.bins` over the Gateway RPC to fetch the
skill bin list. Disable this if you want strict manual allowlists.

<Warning>
- This is an **implicit convenience allowlist**, separate from manual path allowlist entries.
- It is intended for trusted operator environments where Gateway and node are in the same trust boundary.
- If you require strict explicit trust, keep `autoAllowSkills: false` and use manual path allowlist entries only.

</Warning>

## Safe bins and approval forwarding

For safe bins (the stdin-only fast-path), interpreter binding details, and
how to forward approval prompts to Slack/Discord/Telegram (or run them as
native approval clients), see
[Exec approvals - advanced](/tools/exec-approvals-advanced).

## Control UI editing

Use the **Control UI → Nodes → Exec approvals** card to edit defaults,
per-agent overrides, and allowlists. Pick a scope (Defaults or an agent),
tweak the policy, add/remove allowlist patterns, then **Save**. The UI
shows last-used metadata per pattern so you can keep the list tidy.

The target selector chooses **Gateway** (local approvals) or a **Node**.
Nodes must advertise `system.execApprovals.get/set` (macOS app or
headless node host). If a node does not advertise exec approvals yet,
edit its local `~/.openclaw/exec-approvals.json` directly.

CLI: `openclaw approvals` supports gateway or node editing - see
[Approvals CLI](/cli/approvals).

## Approval flow

When a prompt is required, the gateway broadcasts
`exec.approval.requested` to operator clients. The Control UI and macOS
app resolve it via `exec.approval.resolve`, then the gateway forwards the
approved request to the node host.

For `host=node`, approval requests include a canonical `systemRunPlan`
payload. The gateway uses that plan as the authoritative
command/cwd/session context when forwarding approved `system.run`
requests.

That matters for async approval latency:

- The node exec path prepares one canonical plan up front.
- The approval record stores that plan and its binding metadata.
- Once approved, the final forwarded `system.run` call reuses the stored plan instead of trusting later caller edits.
- If the caller changes `command`, `rawCommand`, `cwd`, `agentId`, or `sessionKey` after the approval request was created, the gateway rejects the forwarded run as an approval mismatch.

## System events

Exec lifecycle is surfaced as system messages:

- `Exec running` (only if the command exceeds the running notice threshold).
- `Exec finished`.
- `Exec denied`.

These are posted to the agent's session after the node reports the event.
Gateway-host exec approvals emit the same lifecycle events when the
command finishes (and optionally when running longer than the threshold).
Approval-gated execs reuse the approval id as the `runId` in these
messages for easy correlation.

## Denied approval behavior

When an async exec approval is denied, OpenClaw prevents the agent from
reusing output from any earlier run of the same command in the session.
The denial reason is passed with explicit guidance that no command output
is available, which stops the agent from claiming there is new output or
repeating the denied command with stale results from a prior successful
run.

## Implications

- **`full`** is powerful; prefer allowlists when possible.
- **`ask`** keeps you in the loop while still allowing fast approvals.
- Per-agent allowlists prevent one agent's approvals from leaking into others.
- Approvals only apply to host exec requests from **authorized senders**. Unauthorized senders cannot issue `/exec`.
- `/exec security=full` is a session-level convenience for authorized operators and skips approvals by design. To hard-block host exec, set approvals security to `deny` or deny the `exec` tool via tool policy.

## Related

<CardGroup cols={2}>
  <Card title="Exec approvals - advanced" href="/tools/exec-approvals-advanced" icon="gear">
    Safe bins, interpreter binding, and approval forwarding to chat.
  </Card>
  <Card title="Exec tool" href="/tools/exec" icon="terminal">
    Shell command execution tool.
  </Card>
  <Card title="Elevated mode" href="/tools/elevated" icon="shield-exclamation">
    Break-glass path that also skips approvals.
  </Card>
  <Card title="Sandboxing" href="/gateway/sandboxing" icon="box">
    Sandbox modes and workspace access.
  </Card>
  <Card title="Security" href="/gateway/security" icon="lock">
    Security model and hardening.
  </Card>
  <Card title="Sandbox vs tool policy vs elevated" href="/gateway/sandbox-vs-tool-policy-vs-elevated" icon="sliders">
    When to reach for each control.
  </Card>
  <Card title="Skills" href="/tools/skills" icon="sparkles">
    Skill-backed auto-allow behavior.
  </Card>
</CardGroup>
