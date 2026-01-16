---
summary: "CLI reference for `clawdbot hooks` (internal hooks + Gmail Pub/Sub + webhook helpers)"
read_when:
  - You want to manage internal agent hooks
  - You want to wire Gmail Pub/Sub events into Clawdbot hooks
  - You want to run the gog watch service and renew loop
---

# `clawdbot hooks`

Webhook helpers and hook-based integrations.

Related:
- Internal Hooks: [Internal Agent Hooks](/internal-hooks)
- Webhooks: [Webhook](/automation/webhook)
- Gmail Pub/Sub: [Gmail Pub/Sub](/automation/gmail-pubsub)

## Internal Hooks

Manage internal agent hooks (event-driven automations for commands like `/new`, `/reset`, etc.).

### List All Hooks

```bash
clawdbot hooks internal list
```

List all discovered internal hooks from workspace, managed, and bundled directories.

**Options:**
- `--eligible`: Show only eligible hooks (requirements met)
- `--json`: Output as JSON
- `-v, --verbose`: Show detailed information including missing requirements

**Example output:**

```
Internal Hooks (2/2 ready)

Ready:
  📝 command-logger ✓ - Log all command events to a centralized audit file
  💾 session-memory ✓ - Save session context to memory when /new command is issued
```

**Example (verbose):**

```bash
clawdbot hooks internal list --verbose
```

Shows missing requirements for ineligible hooks.

**Example (JSON):**

```bash
clawdbot hooks internal list --json
```

Returns structured JSON for programmatic use.

### Get Hook Information

```bash
clawdbot hooks internal info <name>
```

Show detailed information about a specific hook.

**Arguments:**
- `<name>`: Hook name (e.g., `session-memory`)

**Options:**
- `--json`: Output as JSON

**Example:**

```bash
clawdbot hooks internal info session-memory
```

**Output:**

```
💾 session-memory ✓ Ready

Save session context to memory when /new command is issued

Details:
  Source: clawdbot-bundled
  Path: /path/to/clawdbot/hooks/bundled/session-memory/HOOK.md
  Handler: /path/to/clawdbot/hooks/bundled/session-memory/handler.ts
  Homepage: https://docs.clawd.bot/hooks/session-memory
  Events: command:new

Requirements:
  Config: ✓ workspace.dir
```

### Check Hooks Eligibility

```bash
clawdbot hooks internal check
```

Show summary of hook eligibility status (how many are ready vs. not ready).

**Options:**
- `--json`: Output as JSON

**Example output:**

```
Internal Hooks Status

Total hooks: 2
Ready: 2
Not ready: 0
```

### Enable a Hook

```bash
clawdbot hooks internal enable <name>
```

Enable a specific hook by adding it to your config (`~/.clawdbot/config.json`).

**Arguments:**
- `<name>`: Hook name (e.g., `session-memory`)

**Example:**

```bash
clawdbot hooks internal enable session-memory
```

**Output:**

```
✓ Enabled hook: 💾 session-memory
```

**What it does:**
- Checks if hook exists and is eligible
- Updates `hooks.internal.entries.<name>.enabled = true` in your config
- Saves config to disk

**After enabling:**
- Restart the gateway for changes to take effect:
  ```bash
  pkill -9 -f 'clawdbot.*gateway'
  pnpm clawdbot gateway
  ```

### Disable a Hook

```bash
clawdbot hooks internal disable <name>
```

Disable a specific hook by updating your config.

**Arguments:**
- `<name>`: Hook name (e.g., `command-logger`)

**Example:**

```bash
clawdbot hooks internal disable command-logger
```

**Output:**

```
⏸ Disabled hook: 📝 command-logger
```

**After disabling:**
- Restart the gateway for changes to take effect

## Bundled Hooks

### session-memory

Saves session context to memory when you issue `/new`.

**Enable:**

```bash
clawdbot hooks internal enable session-memory
```

**Output:** `~/clawd/memory/YYYY-MM-DD-slug.md`

**See:** [session-memory documentation](/internal-hooks#session-memory)

### command-logger

Logs all command events to a centralized audit file.

**Enable:**

```bash
clawdbot hooks internal enable command-logger
```

**Output:** `~/.clawdbot/logs/commands.log`

**View logs:**

```bash
# Recent commands
tail -n 20 ~/.clawdbot/logs/commands.log

# Pretty-print
cat ~/.clawdbot/logs/commands.log | jq .

# Filter by action
grep '"action":"new"' ~/.clawdbot/logs/commands.log | jq .
```

**See:** [command-logger documentation](/internal-hooks#command-logger)

## Gmail

```bash
clawdbot hooks gmail setup --account you@example.com
clawdbot hooks gmail run
```

See [Gmail Pub/Sub documentation](/automation/gmail-pubsub) for details.
