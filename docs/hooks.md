---
summary: "Hooks: event-driven automation for commands and lifecycle events"
read_when:
  - You want event-driven automation for /new, /reset, /stop, and agent lifecycle events
  - You want to build, install, or debug hooks
---
# Hooks

Hooks provide an extensible event-driven system for automating actions in response to agent commands and events. Hooks are automatically discovered from directories and can be managed via CLI commands, similar to how skills work in Moltbot.

## Getting Oriented

Hooks are small scripts that run when something happens. There are two kinds:

- **Hooks** (this page): run inside the Gateway when agent events fire, like `/new`, `/reset`, `/stop`, or lifecycle events.
- **Webhooks**: external HTTP webhooks that let other systems trigger work in Moltbot. See [Webhook Hooks](/automation/webhook) or use `moltbot webhooks` for Gmail helper commands.
  
Hooks can also be bundled inside plugins; see [Plugins](/plugin#plugin-hooks).

Common uses:
- Save a memory snapshot when you reset a session
- Keep an audit trail of commands for troubleshooting or compliance
- Trigger follow-up automation when a session starts or ends
- Write files into the agent workspace or call external APIs when events fire

If you can write a small TypeScript function, you can write a hook. Hooks are discovered automatically, and you enable or disable them via the CLI.

## Overview

The hooks system allows you to:
- Save session context to memory when `/new` is issued
- Log all commands for auditing
- Trigger custom automations on agent lifecycle events
- Extend Moltbot's behavior without modifying core code

## Getting Started

### Bundled Hooks

Moltbot ships with four bundled hooks that are automatically discovered:

- **💾 session-memory**: Saves session context to your agent workspace (default `~/clawd/memory/`) when you issue `/new`
- **📝 command-logger**: Logs all command events to `~/.clawdbot/logs/commands.log`
- **🚀 boot-md**: Runs `BOOT.md` when the gateway starts (requires internal hooks enabled)
- **😈 soul-evil**: Swaps injected `SOUL.md` content with `SOUL_EVIL.md` during a purge window or by random chance

List available hooks:

```bash
moltbot hooks list
```

Enable a hook:

```bash
moltbot hooks enable session-memory
```

Check hook status:

```bash
moltbot hooks check
```

Get detailed information:

```bash
moltbot hooks info session-memory
```

### Onboarding

During onboarding (`moltbot onboard`), you'll be prompted to enable recommended hooks. The wizard automatically discovers eligible hooks and presents them for selection.

## Hook Discovery

Hooks are automatically discovered from three directories (in order of precedence):

1. **Workspace hooks**: `<workspace>/hooks/` (per-agent, highest precedence)
2. **Managed hooks**: `~/.clawdbot/hooks/` (user-installed, shared across workspaces)
3. **Bundled hooks**: `<moltbot>/dist/hooks/bundled/` (shipped with Moltbot)

Managed hook directories can be either a **single hook** or a **hook pack** (package directory).

Each hook is a directory containing:

```
my-hook/
├── HOOK.md          # Metadata + documentation
└── handler.ts       # Handler implementation
```

## Hook Packs (npm/archives)

Hook packs are standard npm packages that export one or more hooks via `moltbot.hooks` in
`package.json`. Install them with:

```bash
moltbot hooks install <path-or-spec>
```

Example `package.json`:

```json
{
  "name": "@acme/my-hooks",
  "version": "0.1.0",
  "moltbot": {
    "hooks": ["./hooks/my-hook", "./hooks/other-hook"]
  }
}
```

Each entry points to a hook directory containing `HOOK.md` and `handler.ts` (or `index.ts`).
Hook packs can ship dependencies; they will be installed under `~/.clawdbot/hooks/<id>`.

## Hook Structure

### HOOK.md Format

The `HOOK.md` file contains metadata in YAML frontmatter plus Markdown documentation:

```markdown
---
name: my-hook
description: "Short description of what this hook does"
homepage: https://docs.molt.bot/hooks#my-hook
metadata: {"moltbot":{"emoji":"🔗","events":["command:new"],"requires":{"bins":["node"]}}}
---

# My Hook

Detailed documentation goes here...

## What It Does

- Listens for `/new` commands
- Performs some action
- Logs the result

## Requirements

- Node.js must be installed

## Configuration

No configuration needed.
```

### Metadata Fields

The `metadata.moltbot` object supports:

- **`emoji`**: Display emoji for CLI (e.g., `"💾"`)
- **`events`**: Array of events to listen for (e.g., `["command:new", "command:reset"]`)
- **`export`**: Named export to use (defaults to `"default"`)
- **`homepage`**: Documentation URL
- **`requires`**: Optional requirements
  - **`bins`**: Required binaries on PATH (e.g., `["git", "node"]`)
  - **`anyBins`**: At least one of these binaries must be present
  - **`env`**: Required environment variables
  - **`config`**: Required config paths (e.g., `["workspace.dir"]`)
  - **`os`**: Required platforms (e.g., `["darwin", "linux"]`)
- **`always`**: Bypass eligibility checks (boolean)
- **`install`**: Installation methods (for bundled hooks: `[{"id":"bundled","kind":"bundled"}]`)

### Handler Implementation

The `handler.ts` file exports a `HookHandler` function:

```typescript
import type { HookHandler } from '../../src/hooks/hooks.js';

const myHandler: HookHandler = async (event) => {
  // Only trigger on 'new' command
  if (event.type !== 'command' || event.action !== 'new') {
    return;
  }

  console.log(`[my-hook] New command triggered`);
  console.log(`  Session: ${event.sessionKey}`);
  console.log(`  Timestamp: ${event.timestamp.toISOString()}`);

  // Your custom logic here

  // Optionally send message to user
  event.messages.push('✨ My hook executed!');
};

export default myHandler;
```

#### Event Context

Each event includes:

```typescript
{
  type: 'command' | 'session' | 'agent' | 'gateway' | 'message',
  action: string,              // e.g., 'new', 'reset', 'stop', 'received'
  sessionKey: string,          // Session identifier
  timestamp: Date,             // When the event occurred
  messages: string[],          // Push messages here to send to user
  context: {
    // For command events:
    sessionEntry?: SessionEntry,
    sessionId?: string,
    sessionFile?: string,
    commandSource?: string,    // e.g., 'whatsapp', 'telegram'
    senderId?: string,
    workspaceDir?: string,
    bootstrapFiles?: WorkspaceBootstrapFile[],
    cfg?: ClawdbotConfig,
    // For message:received events:
    from?: string,
    content?: string,
    channelId?: string,
    metadata?: Record<string, unknown>
  }
}
```

#### Message Received Handler Example

```typescript
import type { HookHandler } from '../../src/hooks/hooks.js';
import { isMessageReceivedEvent } from '../../src/hooks/hooks.js';

const handler: HookHandler = async (event) => {
  if (!isMessageReceivedEvent(event)) return;

  const { from, content, channelId, metadata } = event.context;

  console.log(`[message-hook] ${channelId}: ${from} said "${content.slice(0, 50)}..."`);

  // Example: Log to external service, analytics, audit trail, etc.
  // await logToExternalService({ from, content, channel: channelId });
};

export default handler;
```

**HOOK.md** for message watcher:
```markdown
---
name: message-watcher
description: "Watch all inbound messages"
metadata: {"clawdbot":{"emoji":"👀","events":["message:received"]}}
---

# Message Watcher

Logs all inbound messages for debugging or auditing.
```

## Event Types

### Command Events

Triggered when agent commands are issued:

- **`command`**: All command events (general listener)
- **`command:new`**: When `/new` command is issued
- **`command:reset`**: When `/reset` command is issued
- **`command:stop`**: When `/stop` command is issued

### Agent Events

- **`agent:bootstrap`**: Before workspace bootstrap files are injected (hooks may mutate `context.bootstrapFiles`)

### Gateway Events

Triggered when the gateway starts:

- **`gateway:startup`**: After channels start and hooks are loaded

### Message Events

Triggered when messages are received:

- **`message`**: All message events (general listener)
- **`message:received`**: When an inbound message is received from any channel (WhatsApp, Telegram, Discord, Slack, Signal, iMessage, Gateway/WebUI, MS Teams, Matrix, etc.). Fire-and-forget; cannot modify the message.

#### Message Received Context

For `message:received` events, the context includes:

```typescript
{
  from: string;           // Sender identifier (phone, user ID, etc.)
  content: string;        // Message text body
  timestamp?: number;     // Unix ms timestamp (if available)
  channelId: string;      // "whatsapp", "telegram", "discord", etc.
  accountId?: string;     // Multi-account bot ID
  conversationId?: string;// Chat/conversation ID
  metadata: {
    to?: string;
    provider?: string;
    surface?: string;
    threadId?: string;
    messageId?: string;
    senderId?: string;
    senderName?: string;
    senderUsername?: string;
    senderE164?: string;  // E.164 phone number
  }
}
```

### Tool Result Hooks (Plugin API)

These hooks are not event-stream listeners; they let plugins synchronously adjust tool results before Moltbot persists them.

- **`tool_result_persist`**: transform tool results before they are written to the session transcript. Must be synchronous; return the updated tool result payload or `undefined` to keep it as-is. See [Agent Loop](/concepts/agent-loop).

### Future Events

Planned event types:

- **`session:start`**: When a new session begins
- **`session:end`**: When a session ends
- **`agent:error`**: When an agent encounters an error
- **`message:sent`**: When an outbound message is sent

## Message Handlers

Message handlers provide config-driven routing that triggers immediate agent execution when messages match specified conditions. Unlike regular hooks (which are fire-and-forget observers), message handlers can take over message processing entirely.

### Problem Solved

When cron jobs wake an agent, they inject their own prompt. Messages that arrived earlier (bug reports, user questions) sit in a queue and are never processed:

```
Bug report arrives (10:03) → queued
Cron fires (10:10) → agent wakes with cron prompt only
Bug report → never processed
```

Message handlers fix this by immediately processing important messages as they arrive.

### Configuration

```json
{
  "hooks": {
    "internal": {
      "messageHandlers": [
        {
          "id": "bug-reports",
          "match": {
            "channelId": "whatsapp",
            "conversationId": "+447563241014",
            "contentContains": ["bug", "error", "broken"]
          },
          "action": "agent",
          "agentId": "support-bot",
          "priority": "immediate",
          "messagePrefix": "[BUG REPORT] ",
          "thinking": "medium"
        }
      ]
    }
  }
}
```

### Match Conditions

All specified conditions must match (AND logic). **At least one condition is required** - empty match objects are rejected to prevent accidental catch-all handlers.

| Field | Type | Description |
|-------|------|-------------|
| `channelId` | `string \| string[]` | Channel to match: `"whatsapp"`, `"telegram"`, `["discord", "slack"]`, or `"*"` for all |
| `conversationId` | `string \| string[]` | Chat/group ID to match |
| `from` | `string \| string[]` | Sender identifier (phone number, user ID) |
| `contentPattern` | `string` | Regex pattern (case-insensitive). Unsafe patterns (ReDoS vulnerable) are rejected. |
| `contentContains` | `string \| string[]` | Keywords to find in message (case-insensitive, any match) |

**Security Note**: The `contentPattern` field is validated for ReDoS (Regular Expression Denial of Service) safety before use. Patterns that could cause catastrophic backtracking (e.g., `(a+)+`) are rejected and logged as warnings.

### Handler Options

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `id` | `string` | required | Unique identifier for this handler |
| `enabled` | `boolean` | `true` | Enable/disable the handler |
| `match` | `object` | required | Match conditions (see above) |
| `action` | `"agent"` | required | Action type (currently only "agent") |
| `agentId` | `string` | route default | Which agent processes the message |
| `sessionKey` | `string` | auto-derived | Custom session key |
| `priority` | `"immediate" \| "queue"` | `"immediate"` | Immediate bypasses queue |
| `mode` | `"exclusive" \| "parallel"` | `"exclusive"` | Exclusive: handler only; Parallel: both handler AND normal flow |
| `messagePrefix` | `string` | `""` | Text prepended to message |
| `messageSuffix` | `string` | `""` | Text appended to message |
| `messageTemplate` | `string` | - | Full template with `{{content}}`, `{{from}}`, `{{channelId}}`, `{{conversationId}}` |
| `model` | `string` | - | Override model (provider/model or alias) |
| `thinking` | `"off" \| "low" \| "medium" \| "high"` | - | Thinking level |
| `timeoutSeconds` | `number` | - | Agent timeout |

### Example Configurations

#### Bug Reports from WhatsApp Group

```json
{
  "hooks": {
    "internal": {
      "messageHandlers": [
        {
          "id": "bug-reports",
          "match": {
            "channelId": "whatsapp",
            "conversationId": "+447563241014",
            "contentContains": ["bug", "error", "broken", "fix"]
          },
          "action": "agent",
          "agentId": "support-bot",
          "priority": "immediate",
          "messagePrefix": "[BUG REPORT] ",
          "thinking": "medium"
        }
      ]
    }
  }
}
```

#### All WhatsApp Messages to Specific Agent

```json
{
  "hooks": {
    "internal": {
      "messageHandlers": [
        {
          "id": "whatsapp-handler",
          "match": { "channelId": "whatsapp" },
          "action": "agent",
          "agentId": "personal-assistant",
          "priority": "immediate"
        }
      ]
    }
  }
}
```

#### Urgent Keywords Across All Channels

```json
{
  "hooks": {
    "internal": {
      "messageHandlers": [
        {
          "id": "urgent-handler",
          "match": {
            "contentPattern": "urgent|asap|emergency|critical"
          },
          "action": "agent",
          "priority": "immediate",
          "messagePrefix": "[URGENT] ",
          "model": "anthropic/claude-sonnet-4-20250514",
          "thinking": "high"
        }
      ]
    }
  }
}
```

#### Parallel Mode: Log AND Process Normally

```json
{
  "hooks": {
    "internal": {
      "messageHandlers": [
        {
          "id": "analytics-logger",
          "match": { "channelId": "whatsapp" },
          "action": "agent",
          "agentId": "analytics-bot",
          "priority": "immediate",
          "mode": "parallel",
          "messageTemplate": "[LOG] From: {{from}}, Content: {{content}}"
        }
      ]
    }
  }
}
```

This triggers `analytics-bot` AND lets the normal message flow continue (so the user's main agent also processes it).

### Rate Limiting

Message handlers are rate limited to prevent cost explosions from unbounded agent execution:

- **Default limit**: 10 executions per minute per handler
- Rate-limited messages fall through to normal queue processing
- A warning is logged when rate limiting kicks in

This protects against scenarios like a busy group chat triggering dozens of agent executions per minute.

### Order of Evaluation

1. Handlers are evaluated in order (first match wins)
2. Disabled handlers (`enabled: false`) are skipped
3. Rate limiting is checked before execution
4. If a handler matches with `mode: "exclusive"` (default), normal processing stops
5. If a handler matches with `mode: "parallel"`, normal processing continues after the handler fires

## Creating Custom Hooks

### 1. Choose Location

- **Workspace hooks** (`<workspace>/hooks/`): Per-agent, highest precedence
- **Managed hooks** (`~/.clawdbot/hooks/`): Shared across workspaces

### 2. Create Directory Structure

```bash
mkdir -p ~/.clawdbot/hooks/my-hook
cd ~/.clawdbot/hooks/my-hook
```

### 3. Create HOOK.md

```markdown
---
name: my-hook
description: "Does something useful"
metadata: {"moltbot":{"emoji":"🎯","events":["command:new"]}}
---

# My Custom Hook

This hook does something useful when you issue `/new`.
```

### 4. Create handler.ts

```typescript
import type { HookHandler } from '../../src/hooks/hooks.js';

const handler: HookHandler = async (event) => {
  if (event.type !== 'command' || event.action !== 'new') {
    return;
  }

  console.log('[my-hook] Running!');
  // Your logic here
};

export default handler;
```

### 5. Enable and Test

```bash
# Verify hook is discovered
moltbot hooks list

# Enable it
moltbot hooks enable my-hook

# Restart your gateway process (menu bar app restart on macOS, or restart your dev process)

# Trigger the event
# Send /new via your messaging channel
```

## Configuration

### New Config Format (Recommended)

```json
{
  "hooks": {
    "internal": {
      "enabled": true,
      "entries": {
        "session-memory": { "enabled": true },
        "command-logger": { "enabled": false }
      }
    }
  }
}
```

### Per-Hook Configuration

Hooks can have custom configuration:

```json
{
  "hooks": {
    "internal": {
      "enabled": true,
      "entries": {
        "my-hook": {
          "enabled": true,
          "env": {
            "MY_CUSTOM_VAR": "value"
          }
        }
      }
    }
  }
}
```

### Extra Directories

Load hooks from additional directories:

```json
{
  "hooks": {
    "internal": {
      "enabled": true,
      "load": {
        "extraDirs": ["/path/to/more/hooks"]
      }
    }
  }
}
```

### Legacy Config Format (Still Supported)

The old config format still works for backwards compatibility:

```json
{
  "hooks": {
    "internal": {
      "enabled": true,
      "handlers": [
        {
          "event": "command:new",
          "module": "./hooks/handlers/my-handler.ts",
          "export": "default"
        }
      ]
    }
  }
}
```

**Migration**: Use the new discovery-based system for new hooks. Legacy handlers are loaded after directory-based hooks.

## CLI Commands

### List Hooks

```bash
# List all hooks
moltbot hooks list

# Show only eligible hooks
moltbot hooks list --eligible

# Verbose output (show missing requirements)
moltbot hooks list --verbose

# JSON output
moltbot hooks list --json
```

### Hook Information

```bash
# Show detailed info about a hook
moltbot hooks info session-memory

# JSON output
moltbot hooks info session-memory --json
```

### Check Eligibility

```bash
# Show eligibility summary
moltbot hooks check

# JSON output
moltbot hooks check --json
```

### Enable/Disable

```bash
# Enable a hook
moltbot hooks enable session-memory

# Disable a hook
moltbot hooks disable command-logger
```

## Bundled Hooks

### session-memory

Saves session context to memory when you issue `/new`.

**Events**: `command:new`

**Requirements**: `workspace.dir` must be configured

**Output**: `<workspace>/memory/YYYY-MM-DD-slug.md` (defaults to `~/clawd`)

**What it does**:
1. Uses the pre-reset session entry to locate the correct transcript
2. Extracts the last 15 lines of conversation
3. Uses LLM to generate a descriptive filename slug
4. Saves session metadata to a dated memory file

**Example output**:

```markdown
# Session: 2026-01-16 14:30:00 UTC

- **Session Key**: agent:main:main
- **Session ID**: abc123def456
- **Source**: telegram
```

**Filename examples**:
- `2026-01-16-vendor-pitch.md`
- `2026-01-16-api-design.md`
- `2026-01-16-1430.md` (fallback timestamp if slug generation fails)

**Enable**:

```bash
moltbot hooks enable session-memory
```

### command-logger

Logs all command events to a centralized audit file.

**Events**: `command`

**Requirements**: None

**Output**: `~/.clawdbot/logs/commands.log`

**What it does**:
1. Captures event details (command action, timestamp, session key, sender ID, source)
2. Appends to log file in JSONL format
3. Runs silently in the background

**Example log entries**:

```jsonl
{"timestamp":"2026-01-16T14:30:00.000Z","action":"new","sessionKey":"agent:main:main","senderId":"+1234567890","source":"telegram"}
{"timestamp":"2026-01-16T15:45:22.000Z","action":"stop","sessionKey":"agent:main:main","senderId":"user@example.com","source":"whatsapp"}
```

**View logs**:

```bash
# View recent commands
tail -n 20 ~/.clawdbot/logs/commands.log

# Pretty-print with jq
cat ~/.clawdbot/logs/commands.log | jq .

# Filter by action
grep '"action":"new"' ~/.clawdbot/logs/commands.log | jq .
```

**Enable**:

```bash
moltbot hooks enable command-logger
```

### soul-evil

Swaps injected `SOUL.md` content with `SOUL_EVIL.md` during a purge window or by random chance.

**Events**: `agent:bootstrap`

**Docs**: [SOUL Evil Hook](/hooks/soul-evil)

**Output**: No files written; swaps happen in-memory only.

**Enable**:

```bash
moltbot hooks enable soul-evil
```

**Config**:

```json
{
  "hooks": {
    "internal": {
      "enabled": true,
      "entries": {
        "soul-evil": {
          "enabled": true,
          "file": "SOUL_EVIL.md",
          "chance": 0.1,
          "purge": { "at": "21:00", "duration": "15m" }
        }
      }
    }
  }
}
```

### boot-md

Runs `BOOT.md` when the gateway starts (after channels start).
Internal hooks must be enabled for this to run.

**Events**: `gateway:startup`

**Requirements**: `workspace.dir` must be configured

**What it does**:
1. Reads `BOOT.md` from your workspace
2. Runs the instructions via the agent runner
3. Sends any requested outbound messages via the message tool

**Enable**:

```bash
moltbot hooks enable boot-md
```

## Best Practices

### Keep Handlers Fast

Hooks run during command processing. Keep them lightweight:

```typescript
// ✓ Good - async work, returns immediately
const handler: HookHandler = async (event) => {
  void processInBackground(event); // Fire and forget
};

// ✗ Bad - blocks command processing
const handler: HookHandler = async (event) => {
  await slowDatabaseQuery(event);
  await evenSlowerAPICall(event);
};
```

### Handle Errors Gracefully

Always wrap risky operations:

```typescript
const handler: HookHandler = async (event) => {
  try {
    await riskyOperation(event);
  } catch (err) {
    console.error('[my-handler] Failed:', err instanceof Error ? err.message : String(err));
    // Don't throw - let other handlers run
  }
};
```

### Filter Events Early

Return early if the event isn't relevant:

```typescript
const handler: HookHandler = async (event) => {
  // Only handle 'new' commands
  if (event.type !== 'command' || event.action !== 'new') {
    return;
  }

  // Your logic here
};
```

### Use Specific Event Keys

Specify exact events in metadata when possible:

```yaml
metadata: {"moltbot":{"events":["command:new"]}}  # Specific
```

Rather than:

```yaml
metadata: {"moltbot":{"events":["command"]}}      # General - more overhead
```

## Debugging

### Enable Hook Logging

The gateway logs hook loading at startup:

```
Registered hook: session-memory -> command:new
Registered hook: command-logger -> command
Registered hook: boot-md -> gateway:startup
```

### Check Discovery

List all discovered hooks:

```bash
moltbot hooks list --verbose
```

### Check Registration

In your handler, log when it's called:

```typescript
const handler: HookHandler = async (event) => {
  console.log('[my-handler] Triggered:', event.type, event.action);
  // Your logic
};
```

### Verify Eligibility

Check why a hook isn't eligible:

```bash
moltbot hooks info my-hook
```

Look for missing requirements in the output.

## Testing

### Gateway Logs

Monitor gateway logs to see hook execution:

```bash
# macOS
./scripts/clawlog.sh -f

# Other platforms
tail -f ~/.clawdbot/gateway.log
```

### Test Hooks Directly

Test your handlers in isolation:

```typescript
import { test } from 'vitest';
import { createHookEvent } from './src/hooks/hooks.js';
import myHandler from './hooks/my-hook/handler.js';

test('my handler works', async () => {
  const event = createHookEvent('command', 'new', 'test-session', {
    foo: 'bar'
  });

  await myHandler(event);

  // Assert side effects
});
```

## Architecture

### Core Components

- **`src/hooks/types.ts`**: Type definitions
- **`src/hooks/workspace.ts`**: Directory scanning and loading
- **`src/hooks/frontmatter.ts`**: HOOK.md metadata parsing
- **`src/hooks/config.ts`**: Eligibility checking
- **`src/hooks/hooks-status.ts`**: Status reporting
- **`src/hooks/loader.ts`**: Dynamic module loader
- **`src/cli/hooks-cli.ts`**: CLI commands
- **`src/gateway/server-startup.ts`**: Loads hooks at gateway start
- **`src/auto-reply/reply/commands-core.ts`**: Triggers command events

### Discovery Flow

```
Gateway startup
    ↓
Scan directories (workspace → managed → bundled)
    ↓
Parse HOOK.md files
    ↓
Check eligibility (bins, env, config, os)
    ↓
Load handlers from eligible hooks
    ↓
Register handlers for events
```

### Event Flow

```
User sends /new
    ↓
Command validation
    ↓
Create hook event
    ↓
Trigger hook (all registered handlers)
    ↓
Command processing continues
    ↓
Session reset
```

## Troubleshooting

### Hook Not Discovered

1. Check directory structure:
   ```bash
   ls -la ~/.clawdbot/hooks/my-hook/
   # Should show: HOOK.md, handler.ts
   ```

2. Verify HOOK.md format:
   ```bash
   cat ~/.clawdbot/hooks/my-hook/HOOK.md
   # Should have YAML frontmatter with name and metadata
   ```

3. List all discovered hooks:
   ```bash
   moltbot hooks list
   ```

### Hook Not Eligible

Check requirements:

```bash
moltbot hooks info my-hook
```

Look for missing:
- Binaries (check PATH)
- Environment variables
- Config values
- OS compatibility

### Hook Not Executing

1. Verify hook is enabled:
   ```bash
   moltbot hooks list
   # Should show ✓ next to enabled hooks
   ```

2. Restart your gateway process so hooks reload.

3. Check gateway logs for errors:
   ```bash
   ./scripts/clawlog.sh | grep hook
   ```

### Handler Errors

Check for TypeScript/import errors:

```bash
# Test import directly
node -e "import('./path/to/handler.ts').then(console.log)"
```

## Migration Guide

### From Legacy Config to Discovery

**Before**:

```json
{
  "hooks": {
    "internal": {
      "enabled": true,
      "handlers": [
        {
          "event": "command:new",
          "module": "./hooks/handlers/my-handler.ts"
        }
      ]
    }
  }
}
```

**After**:

1. Create hook directory:
   ```bash
   mkdir -p ~/.clawdbot/hooks/my-hook
   mv ./hooks/handlers/my-handler.ts ~/.clawdbot/hooks/my-hook/handler.ts
   ```

2. Create HOOK.md:
   ```markdown
   ---
   name: my-hook
   description: "My custom hook"
   metadata: {"moltbot":{"emoji":"🎯","events":["command:new"]}}
   ---

   # My Hook

   Does something useful.
   ```

3. Update config:
   ```json
   {
     "hooks": {
       "internal": {
         "enabled": true,
         "entries": {
           "my-hook": { "enabled": true }
         }
       }
     }
   }
   ```

4. Verify and restart your gateway process:
   ```bash
   moltbot hooks list
   # Should show: 🎯 my-hook ✓
   ```

**Benefits of migration**:
- Automatic discovery
- CLI management
- Eligibility checking
- Better documentation
- Consistent structure

## See Also

- [CLI Reference: hooks](/cli/hooks)
- [Bundled Hooks README](https://github.com/moltbot/moltbot/tree/main/src/hooks/bundled)
- [Webhook Hooks](/automation/webhook)
- [Configuration](/gateway/configuration#hooks)
