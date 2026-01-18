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
Exec approvals are **in addition** to tool policy and elevated gating.

If the companion app UI is **not available**, any request that requires a prompt is
resolved by the **ask fallback** (default: deny).

## Where it applies

Exec approvals are enforced locally on the execution host:
- **gateway host** → `clawdbot` process on the gateway machine
- **node host** → node runner (macOS companion app or headless node host)

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

Examples:
- `~/Projects/**/bin/bird`
- `~/.local/bin/*`
- `/opt/homebrew/bin/rg`

Each allowlist entry tracks:
- **last used** timestamp
- **last used command**
- **last resolved path**

## Auto-allow skill CLIs

When **Auto-allow skill CLIs** is enabled, executables referenced by known skills
are treated as allowlisted on nodes (macOS node or headless node host). This uses the Bridge RPC to ask the
gateway for the skill bin list. Disable this if you want strict manual allowlists.

## Approval flow

When a prompt is required, the companion app displays a confirmation dialog with:
- command + args
- cwd
- agent id
- resolved executable path
- host + policy metadata

Actions:
- **Allow once** → run now
- **Always allow** → add to allowlist + run
- **Deny** → block

## System events

Exec lifecycle is surfaced as system messages:
- `exec.started`
- `exec.finished`
- `exec.denied`

These are posted to the agent’s session after the node reports the event.

## Implications

- **full** is powerful; prefer allowlists when possible.
- **ask** keeps you in the loop while still allowing fast approvals.
- Per-agent allowlists prevent one agent’s approvals from leaking into others.

Related:
- [Exec tool](/tools/exec)
- [Elevated mode](/tools/elevated)
- [Skills](/tools/skills)
