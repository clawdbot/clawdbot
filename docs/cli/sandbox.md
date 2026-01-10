---
title: Sandbox CLI
summary: "Manage sandbox containers and inspect effective sandbox policy"
read_when: "You are managing sandbox containers or debugging sandbox/tool-policy behavior."
status: active
---

# Sandbox CLI

Manage Docker-based sandbox containers for isolated agent execution.

## Overview

Clawdbot can run agents in isolated Docker containers for security. The `sandbox` commands help you manage these containers, especially after updates or configuration changes.

## Commands

### `clawdbot sandbox explain`

Inspect the **effective** sandbox mode/scope/workspace access, sandbox tool policy, and elevated gates (with fix-it config key paths).

```bash
clawdbot sandbox explain
clawdbot sandbox explain --session agent:main:main
clawdbot sandbox explain --agent work
clawdbot sandbox explain --json
```

### `clawdbot sandbox list`

List all sandbox containers with their status and configuration.

```bash
clawdbot sandbox list
clawdbot sandbox list --browser  # List only browser containers
clawdbot sandbox list --json     # JSON output
```

**Output includes:**
- Container name and status (running/stopped)
- Docker image and whether it matches config
- Age (time since creation)
- Idle time (time since last use)
- Associated session/agent

### `clawdbot sandbox recreate`

Remove sandbox containers to force recreation with updated images/config.

```bash
clawdbot sandbox recreate --all                # Recreate all containers
clawdbot sandbox recreate --session main       # Specific session
clawdbot sandbox recreate --agent mybot        # Specific agent
clawdbot sandbox recreate --browser            # Only browser containers
clawdbot sandbox recreate --all --force        # Skip confirmation
```

**Options:**
- `--all`: Recreate all sandbox containers
- `--session <key>`: Recreate container for specific session
- `--agent <id>`: Recreate containers for specific agent
- `--browser`: Only recreate browser containers
- `--force`: Skip confirmation prompt

**Important:** Containers are automatically recreated when the agent is next used.

## Use Cases

### After updating Docker images

```bash
# Pull new image
docker pull clawdbot-sandbox:latest
docker tag clawdbot-sandbox:latest clawdbot-sandbox:bookworm-slim

# Update config to use new image
# Edit config: agents.defaults.sandbox.docker.image (or agents.list[].sandbox.docker.image)

# Recreate containers
clawdbot sandbox recreate --all
```

### After changing sandbox configuration

```bash
# Edit config: agents.defaults.sandbox.* (or agents.list[].sandbox.*)

# Recreate to apply new config
clawdbot sandbox recreate --all
```

### For a specific agent only

```bash
# Update only one agent's containers
clawdbot sandbox recreate --agent alfred
```

## Why is this needed?

**Problem:** When you update sandbox Docker images or configuration:
- Existing containers continue running with old settings
- Containers are only pruned after 24h of inactivity
- Regularly-used agents keep old containers running indefinitely

**Solution:** Use `clawdbot sandbox recreate` to force removal of old containers. They'll be recreated automatically with current settings when next needed.

## Configuration

Sandbox settings are in `clawdbot.config.json`:

```jsonc
{
  "agent": {
    "sandbox": {
      "mode": "all",                    // off, non-main, all
      "scope": "agent",                 // session, agent, shared
      "docker": {
        "image": "clawdbot-sandbox:bookworm-slim",
        "containerPrefix": "clawdbot-sbx-"
        // ... more Docker options
      },
      "prune": {
        "idleHours": 24,               // Auto-prune after 24h idle
        "maxAgeDays": 7                // Auto-prune after 7 days
      }
    }
  }
}
```

## See Also

- [Sandbox Documentation](/gateway/sandboxing)
- [Agent Configuration](/concepts/agent-workspace)
- [Doctor Command](/gateway/doctor) - Check sandbox setup
