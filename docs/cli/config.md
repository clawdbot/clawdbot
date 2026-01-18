---
summary: "CLI reference for `clawdbot config` (get/set/unset config values)"
read_when:
  - You want to read or edit config non-interactively
---

# `clawdbot config`

Config helpers: get/set/unset values by path. Run without a subcommand to open
the configure wizard (same as `clawdbot configure`).

## Examples

```bash
clawdbot config get browser.executablePath
clawdbot config set browser.executablePath "/usr/bin/google-chrome"
clawdbot config set agents.defaults.heartbeat.every "2h"
clawdbot config set agents.list[0].tools.exec.node "node-id-or-name"
clawdbot config unset tools.web.search.apiKey
```

## Paths

Paths use dot or bracket notation:

```bash
clawdbot config get agents.defaults.workspace
clawdbot config get agents.list[0].id
```

Use the agent list index to target a specific agent:

```bash
clawdbot config get agents.list
clawdbot config set agents.list[1].tools.exec.node "node-id-or-name"
```

## Values

Values are parsed as JSON5 when possible; otherwise they are treated as strings.
Use `--json` to require JSON5 parsing.

```bash
clawdbot config set agents.defaults.heartbeat.every "0m"
clawdbot config set gateway.port 19001 --json
clawdbot config set channels.whatsapp.groups '["*"]' --json
```

Restart the gateway after edits.
