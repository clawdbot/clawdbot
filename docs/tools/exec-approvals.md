---
summary: "Exec approvals, allowlists, and sandbox escape prompts"
read_when:
  - Configuring exec approvals or allowlists
  - Implementing exec approval UX in the macOS app
  - Reviewing sandbox escape prompts and implications
---

# Exec approvals

Exec approvals are the **companion app / node host guardrail** for letting a sandboxed agent run
commands on a real host (`gateway` or `node`). Think of it like a safety interlock:
commands are allowed only when policy + allowlist + (optional) user approval all agree.
Exec approvals are **in addition** to tool policy and elevated gating (unless elevated is set to `full`, which skips approvals).
Effective policy is the **stricter** of `tools.exec.*` and approvals defaults; if an approvals field is omitted, the `tools.exec` value is used.

If the companion app UI is **not available**, any request that requires a prompt is
resolved by the **ask fallback** (default: deny).

## Where it applies

Exec approvals are enforced locally on the execution host:
- **gateway host** → `clawdbot` process on the gateway machine
- **node host** → node runner (macOS companion app or headless node host)

macOS split:
- **node host service** forwards `system.run` to the **macOS app** over local IPC.
- **macOS app** enforces approvals + executes the command in UI context.

## Settings and storage

Approvals live in a local JSON file on the execution host:

`~/.clawdbot/exec-approvals.json`

Example schema:
```json
{
  "version": 1,
  "socket": {
    "path": "~/.clawdbot/exec-approvals.sock",
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

## Policy knobs

### Security (`exec.security`)
- **deny**: block all host exec requests.
- **allowlist**: allow only allowlisted commands.
- **full**: allow everything (equivalent to elevated).

### Ask (`exec.ask`)
- **off**: never prompt.
- **on-miss**: prompt only when allowlist does not match.
- **always**: prompt on every command.

### Ask fallback (`askFallback`)
If a prompt is required but no UI is reachable, fallback decides:
- **deny**: block.
- **allowlist**: allow only if allowlist matches.
- **full**: allow.

## Allowlist (per agent)

Allowlists are **per agent**. If multiple agents exist, switch which agent you’re
editing in the macOS app. Patterns are **case-insensitive glob matches**.
Patterns should resolve to **binary paths** (basename-only entries are ignored).
Legacy `agents.default` entries are migrated to `agents.main` on load.

Examples:
- `~/Projects/**/bin/bird`
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

## Safe bins (stdin-only)

`tools.exec.safeBins` defines a small list of **stdin-only** binaries (for example `jq`)
that can run in allowlist mode **without** explicit allowlist entries. Safe bins reject
positional file args and path-like tokens, so they can only operate on the incoming stream.
Shell chaining and redirections are not auto-allowed in allowlist mode.

Shell chaining (`&&`, `||`, `;`) is allowed when every top-level segment satisfies the allowlist
(including safe bins or skill auto-allow). Redirections remain unsupported in allowlist mode.

Default safe bins: `jq`, `grep`, `cut`, `sort`, `uniq`, `head`, `tail`, `tr`, `wc`.

## Control UI editing

Use the **Control UI → Nodes → Exec approvals** card to edit defaults, per‑agent
overrides, and allowlists. Pick a scope (Defaults or an agent), tweak the policy,
add/remove allowlist patterns, then **Save**. The UI shows **last used** metadata
per pattern so you can keep the list tidy.

The target selector chooses **Gateway** (local approvals) or a **Node**. Nodes
must advertise `system.execApprovals.get/set` (macOS app or headless node host).
If a node does not advertise exec approvals yet, edit its local
`~/.clawdbot/exec-approvals.json` directly.

CLI: `clawdbot approvals` supports gateway or node editing (see [Approvals CLI](/cli/approvals)).

## Approval flow

When a prompt is required, the gateway broadcasts `exec.approval.requested` to operator clients.
The Control UI and macOS app resolve it via `exec.approval.resolve`, then the gateway forwards the
approved request to the node host.

When approvals are required, the exec tool returns immediately with an approval id. Use that id to
correlate later system events (`Exec finished` / `Exec denied`). If no decision arrives before the
timeout, the request is treated as an approval timeout and surfaced as a denial reason.

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
        { channel: "telegram", to: "123456789" }
      ]
    }
  }
}
```

Reply in chat:
```
/approve <id> allow-once
/approve <id> allow-always
/approve <id> deny
```

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
