---
summary: "Refactor plan: exec host routing, node approvals, and headless runner"
read_when:
  - Designing exec host routing or exec approvals
  - Implementing node runner + UI IPC
  - Adding exec host security modes and slash commands
---

# Exec host refactor plan

## Goals
- Add `exec.host` + `exec.security` to route execution across **sandbox**, **gateway**, and **node**.
- Keep defaults **safe**: no cross-host execution unless explicitly enabled.
- Split execution into a **headless runner service** with optional UI (macOS app) via local IPC.
- Provide **per-agent** policy, allowlist, ask mode, and node binding.
- Support **ask modes** that work *with* or *without* allowlists.
- Cross-platform: Unix socket + token auth (macOS/Linux/Windows parity).

## Non-goals
- No legacy allowlist migration or legacy schema support.
- No PTY/streaming for node exec (aggregated output only).
- No new network layer beyond the existing Bridge + Gateway.

## Decisions (locked)
- **Config keys:** `exec.host` + `exec.security` (per-agent override allowed).
- **Elevation:** keep `/elevated` as an alias for gateway full access.
- **Ask default:** `on-miss`.
- **Approvals store:** `~/.clawdbot/exec-approvals.json` (JSON, no legacy migration).
- **Runner:** headless system service; UI app hosts a Unix socket for approvals.
- **Node identity:** use existing `nodeId`.
- **Socket auth:** Unix socket + token (cross-platform); split later if needed.

## Key concepts
### Host
- `sandbox`: Docker exec (current behavior).
- `gateway`: exec on gateway host.
- `node`: exec on node runner via Bridge (`system.run`).

### Security mode
- `deny`: always block.
- `allowlist`: allow only matches.
- `full`: allow everything (equivalent to elevated).

### Ask mode
- `off`: never ask.
- `on-miss`: ask only when allowlist does not match.
- `always`: ask every time.

Ask is **independent** of allowlist; allowlist can be used with `always` or `on-miss`.

### Policy resolution (per exec)
1) Resolve `exec.host` (tool param → agent override → global default).
2) Resolve `exec.security` and `exec.ask` (same precedence).
3) If host is `sandbox`, proceed with local sandbox exec.
4) If host is `gateway` or `node`, apply security + ask policy on that host.

## Default safety
- Default `exec.host = sandbox`.
- Default `exec.security = deny` for `gateway` and `node`.
- Default `exec.ask = on-miss` (only relevant if security allows).
- If no node binding is set, **agent may target any node**, but only if policy allows it.

## Config surface
### Tool parameters
- `exec.host` (optional): `sandbox | gateway | node`.
- `exec.security` (optional): `deny | allowlist | full`.
- `exec.ask` (optional): `off | on-miss | always`.
- `exec.node` (optional): node id/name to use when `host=node`.

### Config keys (global)
- `tools.exec.host`
- `tools.exec.security`
- `tools.exec.ask`
- `tools.exec.node` (default node binding)

### Config keys (per agent)
- `agents.list[].tools.exec.host`
- `agents.list[].tools.exec.security`
- `agents.list[].tools.exec.ask`
- `agents.list[].tools.exec.node`

### Alias
- `/elevated on` = set `tools.exec.host=gateway`, `tools.exec.security=full` for the agent session.
- `/elevated off` = restore previous exec settings for the agent session.

## Approvals store (JSON)
Path: `~/.clawdbot/exec-approvals.json`

Purpose:
- Local policy + allowlists for the **execution host** (gateway or node runner).
- Ask fallback when no UI is available.
- IPC credentials for UI clients.

Proposed schema (v1):
```json
{
  "version": 1,
  "socket": {
    "path": "~/.clawdbot/exec-approvals.sock",
    "token": "base64-opaque-token"
  },
  "defaults": {
    "security": "deny",
    "ask": "on-miss",
    "askFallback": "deny"
  },
  "agents": {
    "agent-id-1": {
      "security": "allowlist",
      "ask": "on-miss",
      "allowlist": [
        {
          "pattern": "~/Projects/**/bin/rg",
          "lastUsedAt": 0,
          "lastUsedCommand": "rg -n TODO",
          "lastResolvedPath": "/Users/user/Projects/.../bin/rg"
        }
      ]
    }
  }
}
```
Notes:
- No legacy allowlist formats.
- `askFallback` applies only when `ask` is required and no UI is reachable.
- File permissions: `0600`.

## Runner service (headless)
### Role
- Enforce `exec.security` + `exec.ask` locally.
- Execute system commands and return output.
- Emit Bridge events for exec lifecycle (optional but recommended).

### Service lifecycle
- Launchd/daemon on macOS; system service on Linux/Windows.
- Approvals JSON is local to the execution host.
- UI hosts a local Unix socket; runners connect on demand.

## UI integration (macOS app)
### IPC
- Unix socket at `~/.clawdbot/exec-approvals.sock`.
- Runner connects and sends an approval request; UI responds with a decision.
- Token stored in `exec-approvals.json`.

### Ask flow
1) Runner receives `system.run` from gateway.
2) If ask required, runner connects to the socket and sends a prompt request.
3) UI shows dialog; returns decision.
4) Runner enforces decision and proceeds.

If UI missing:
- Apply `askFallback` (`deny|allowlist|full`).

## Node identity + binding
- Use existing `nodeId` from Bridge pairing.
- Binding model:
  - `tools.exec.node` restricts the agent to a specific node.
  - If unset, agent can pick any node (policy still enforces defaults).
- Node selection resolution:
  - `nodeId` exact match
  - `displayName` (normalized)
  - `remoteIp`
  - `nodeId` prefix (>= 6 chars)

## Eventing
### Who sees events
- System events are **per session** and shown to the agent on the next prompt.
- Stored in the gateway in-memory queue (`enqueueSystemEvent`).

### Event text
- `Exec started (host=node, node=<id>, id=<runId>)`
- `Exec finished (exit=<code>, tail=<...>)`
- `Exec denied (policy=<...>, reason=<...>)`

### Transport
Option A (recommended):
- Runner sends Bridge `event` frames `exec.started` / `exec.finished`.
- Gateway `handleBridgeEvent` maps these into `enqueueSystemEvent`.

Option B:
- Gateway `exec` tool handles lifecycle directly (synchronous only).

## Exec flows
### Sandbox host
- Existing `exec` behavior (Docker or host when unsandboxed).
- PTY supported in non-sandbox mode only.

### Gateway host
- Gateway process executes on its own machine.
- Enforces local `exec-approvals.json` (security/ask/allowlist).

### Node host
- Gateway calls `node.invoke` with `system.run`.
- Runner enforces local approvals.
- Runner returns aggregated stdout/stderr.
- Optional Bridge events for start/finish/deny.

## Output caps
- Cap combined stdout+stderr at **200k**; keep **tail 20k** for events.
- Truncate with a clear suffix (e.g., `"… (truncated)"`).

## Slash commands
- `/exec host=<sandbox|gateway|node> security=<deny|allowlist|full> ask=<off|on-miss|always> node=<id>`
- Per-agent, per-session overrides; non-persistent unless saved via config.
- `/elevated on|off` remains a shortcut for `host=gateway security=full`.

## Cross-platform story
- The runner service is the portable execution target.
- UI is optional; if missing, `askFallback` applies.
- Windows/Linux support the same approvals JSON + socket protocol.

## Implementation phases
### Phase 1: config + exec routing
- Add config schema for `exec.host`, `exec.security`, `exec.ask`, `exec.node`.
- Update tool plumbing to respect `exec.host`.
- Add `/exec` slash command and keep `/elevated` alias.

### Phase 2: approvals store + gateway enforcement
- Implement `exec-approvals.json` reader/writer.
- Enforce allowlist + ask modes for `gateway` host.
- Add output caps.

### Phase 3: node runner enforcement
- Update node runner to enforce allowlist + ask.
- Add Unix socket prompt bridge to macOS app UI.
- Wire `askFallback`.

### Phase 4: events
- Add node → gateway Bridge events for exec lifecycle.
- Map to `enqueueSystemEvent` for agent prompts.

### Phase 5: UI polish
- Mac app: allowlist editor, per-agent switcher, ask policy UI.
- Node binding controls (optional).

## Testing plan
- Unit tests: allowlist matching (glob + case-insensitive).
- Unit tests: policy resolution precedence (tool param → agent override → global).
- Integration tests: node runner deny/allow/ask flows.
- Bridge event tests: node event → system event routing.

## Open risks
- UI unavailability: ensure `askFallback` is respected.
- Long-running commands: rely on timeout + output caps.
- Multi-node ambiguity: error unless node binding or explicit node param.

## Related docs
- [Exec tool](/tools/exec)
- [Exec approvals](/tools/exec-approvals)
- [Nodes](/nodes)
- [Elevated mode](/tools/elevated)
