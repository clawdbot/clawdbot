# web4-governance

R6 workflow formalism, audit trails, session identity, and policy-based pre-action gating for moltbot agent sessions.

## Overview

This plugin observes and optionally gates every tool call an agent makes:

- **R6 audit records** capture intent, context, and outcome for each action
- **Hash-linked chain** provides tamper-evident provenance (SHA-256 chain)
- **Session identity** via software-bound Linked Context Tokens (Soft LCT)
- **Policy engine** evaluates rules before tool execution, with allow/deny/warn decisions

## Installation

The plugin is bundled with moltbot. Enable it in your moltbot config:

```json
{
  "plugins": {
    "web4-governance": {}
  }
}
```

## Configuration

All fields are optional. Defaults shown below.

```json
{
  "plugins": {
    "web4-governance": {
      "auditLevel": "standard",
      "showR6Status": true,
      "storagePath": "~/.moltbot/extensions/web4-governance/",
      "policy": {
        "defaultPolicy": "allow",
        "enforce": true,
        "rules": []
      }
    }
  }
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `auditLevel` | `"minimal" \| "standard" \| "verbose"` | `"standard"` | Controls audit detail level. `verbose` logs every R6 to the console. |
| `showR6Status` | `boolean` | `true` | Show R6 chain status in session output. |
| `storagePath` | `string` | `~/.moltbot/extensions/web4-governance/` | Directory for audit logs and session state. |
| `policy` | `object` | see below | Policy engine configuration. |

## Policy Engine

The policy engine evaluates every tool call against a configurable set of rules before execution. Rules are matched in priority order (ascending); first match wins.

### Policy Configuration

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `defaultPolicy` | `"allow" \| "deny" \| "warn"` | `"allow"` | Decision when no rule matches. |
| `enforce` | `boolean` | `true` | When `false`, deny decisions are logged but not enforced (dry-run mode). |
| `rules` | `PolicyRule[]` | `[]` | Ordered list of policy rules. |

### Rule Schema

```json
{
  "id": "deny-destructive-commands",
  "name": "Block destructive shell commands",
  "priority": 1,
  "decision": "deny",
  "reason": "Destructive command blocked",
  "match": {
    "tools": ["Bash"],
    "targetPatterns": ["rm\\s+-rf", "mkfs\\."],
    "targetPatternsAreRegex": true
  }
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `id` | yes | Unique rule identifier, used in audit constraints. |
| `name` | yes | Human-readable rule name. |
| `priority` | yes | Lower number = evaluated first. First match wins. |
| `decision` | yes | `"allow"`, `"deny"`, or `"warn"`. |
| `reason` | no | Reason string recorded in audit and shown on block. |
| `match` | yes | Match criteria (all specified fields are AND'd). |

### Match Criteria

All specified criteria within a rule must match (AND logic). Omitted criteria are ignored.

| Field | Type | Description |
|-------|------|-------------|
| `tools` | `string[]` | Tool names: `Read`, `Write`, `Edit`, `Bash`, `Glob`, `Grep`, `WebFetch`, `WebSearch`, `Task`, `NotebookEdit`, `TodoWrite` |
| `categories` | `string[]` | Tool categories: `file_read`, `file_write`, `command`, `network`, `delegation`, `state`, `mcp`, `unknown` |
| `targetPatterns` | `string[]` | Patterns to match against the tool's target (file path, command, URL, etc.). Glob by default. |
| `targetPatternsAreRegex` | `boolean` | Set `true` to treat `targetPatterns` as regex instead of glob. Default: `false`. |

### Target Extraction

The target matched against `targetPatterns` is extracted from tool parameters:

| Tool | Target source |
|------|---------------|
| Read, Write, Edit, NotebookEdit | `file_path` param |
| Glob, Grep | `path` or `pattern` param |
| Bash | `command` param (truncated to 80 chars) |
| WebFetch, WebSearch | `url` param |
| Task, TodoWrite | no target extracted |

### Glob Patterns

Glob matching supports `*` (any characters except `/`), `**` (any characters including `/`), and `?` (single character). Special regex characters are escaped.

Examples:
- `**/.env*` matches `/project/.env`, `/project/.env.local`
- `/src/*.ts` matches `/src/index.ts` but not `/src/sub/index.ts`
- `/src/**/*.ts` matches any `.ts` file under `/src/` at any depth

### Decisions

| Decision | Behavior (enforce=true) | Behavior (enforce=false) |
|----------|------------------------|--------------------------|
| `allow` | Tool executes normally | Tool executes normally |
| `deny` | Tool is **blocked**, returns `[blocked] [web4-policy] <reason>` | Logged as warning, tool executes |
| `warn` | Tool executes, warning logged | Tool executes, warning logged |

### Audit Integration

Policy decisions are recorded in the R6 `rules.constraints` field:

```json
{
  "rules": {
    "auditLevel": "standard",
    "constraints": ["policy:deny", "rule:deny-destructive-commands"]
  }
}
```

### Example: Full Policy Config

```json
{
  "plugins": {
    "web4-governance": {
      "policy": {
        "defaultPolicy": "allow",
        "enforce": true,
        "rules": [
          {
            "id": "deny-destructive-commands",
            "name": "Block destructive shell commands",
            "priority": 1,
            "decision": "deny",
            "reason": "Destructive command blocked",
            "match": {
              "tools": ["Bash"],
              "targetPatterns": ["rm\\s+-rf", "mkfs\\."],
              "targetPatternsAreRegex": true
            }
          },
          {
            "id": "deny-secrets",
            "name": "Block reading secret files",
            "priority": 5,
            "decision": "deny",
            "reason": "Secret file access denied",
            "match": {
              "categories": ["file_read"],
              "targetPatterns": ["**/.env", "**/.env.*", "**/credentials.*", "**/*secret*"]
            }
          },
          {
            "id": "warn-network",
            "name": "Warn on network access",
            "priority": 10,
            "decision": "warn",
            "match": {
              "categories": ["network"]
            }
          }
        ]
      }
    }
  }
}
```

## CLI Commands

### Audit Commands

```bash
moltbot audit summary              # Show active session stats
moltbot audit verify [sessionId]   # Verify chain integrity
moltbot audit last [count]         # Show last N audit records (default: 10)
```

#### `audit summary`

Displays all active governance sessions with action counts, audit record counts, chain validity, and tool/category breakdowns.

#### `audit verify [sessionId]`

Verifies the hash-linked audit chain integrity. Checks that each record's `prevRecordHash` matches the SHA-256 hash of the previous record. Pass a session ID to verify a specific chain, or omit for all active sessions.

#### `audit last [count]`

Shows the most recent audit records across all active sessions. Each record shows timestamp, tool name, target, and result status.

### Policy Commands

```bash
moltbot policy status              # Show policy engine status
moltbot policy rules               # List all rules in evaluation order
moltbot policy test <tool> [target] # Dry-run a tool call against the policy
```

#### `policy status`

Shows the current policy engine state:

```
Policy engine:
  Rules:    3
  Default:  allow
  Enforce:  true
```

#### `policy rules`

Lists all configured rules in priority order with match criteria:

```
3 rules (priority order):

  [1] deny-destructive-commands -> deny
       Block destructive shell commands
       match: tools=[Bash] AND targets(regex)=[rm\s+-rf, mkfs\.]
       reason: Destructive command blocked

  [5] deny-secrets -> deny
       Block reading secret files
       match: categories=[file_read] AND targets(glob)=[**/.env, **/.env.*, **/credentials.*, **/*secret*]
       reason: Secret file access denied

  [10] warn-network -> warn
       Warn on network access
       match: categories=[network]

Default: allow | Enforce: true
```

#### `policy test <tool> [target]`

Dry-runs a tool call against the policy engine without executing anything. Shows what decision would be made:

```bash
$ moltbot policy test Bash "rm -rf /tmp"
Tool:       Bash
Category:   command
Target:     rm -rf /tmp
Decision:   deny
Enforced:   true
Reason:     Destructive command blocked
Rule:       deny-destructive-commands (priority 1)
Constraints: policy:deny, rule:deny-destructive-commands
```

```bash
$ moltbot policy test Read "/project/src/index.ts"
Tool:       Read
Category:   file_read
Target:     /project/src/index.ts
Decision:   allow
Enforced:   true
Reason:     Default policy: allow
Constraints: policy:allow, rule:default
```

## Storage Layout

```
~/.moltbot/extensions/web4-governance/
  audit/
    <sessionId>.jsonl     # Hash-linked audit records (append-only)
  sessions/
    <sessionId>.json      # Session metadata (overwritten on each action)
```

## Architecture

### Hooks

The plugin uses two hook surfaces:

- **`before_tool_call`** (sequential): Evaluates policy rules. Can block tool execution by returning `{ block: true, blockReason }`. Stashes the policy evaluation for the after-hook.
- **`after_tool_call`** (fire-and-forget): Creates the R6 audit record, writes policy constraints from the stashed evaluation, and appends to the hash-linked chain.

Internal hooks handle session lifecycle (bootstrap, start, end) and command-level auditing.

### R6 Request Structure

Each tool call produces an R6 record with six fields:

| Field | Content |
|-------|---------|
| **Rules** | Audit level + policy constraints |
| **Role** | Session ID, agent ID, action index, binding type |
| **Request** | Tool name, category, target, input hash |
| **Reference** | Session ID, previous R6 ID, chain position |
| **Resource** | Approval requirement flag |
| **Result** | Status (success/error/blocked), output hash, duration |

### Session Identity

Each session gets a Soft LCT (software-bound Linked Context Token) derived from `hostname:username`. Format: `web4:session:<machineHash>:<sessionId>`. This is the upgrade path to hardware-bound identity in Tier 2.

## Implementation Tiers

| Tier | Scope | Status |
|------|-------|--------|
| 1 - Observational | R6 audit, hash chain, soft LCT, tool classification | Done |
| 1.5 - Policy | Configurable rules, before_tool_call gating, allow/deny/warn | Done |
| 2 - Authorization | T3 trust tensors, ATP economics, hardware LCT, full policy engine | Planned (Hardbound) |

## Development

```bash
# Run plugin tests
npx vitest run extensions/web4-governance/

# Type-check
pnpm build

# Full test suite
pnpm test
```
