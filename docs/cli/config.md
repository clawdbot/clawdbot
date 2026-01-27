---
summary: "CLI reference for `moltbot config` (get/set/unset config values)"
read_when:
  - You want to read or edit config non-interactively
---

# `moltbot config`

Config helpers: get/set/unset values by path. Run without a subcommand to open
the configure wizard (same as `moltbot configure`).

## Examples

```bash
moltbot config get browser.executablePath
moltbot config set browser.executablePath "/usr/bin/google-chrome"
moltbot config set agents.defaults.heartbeat.every "2h"
moltbot config set agents.list[0].tools.exec.node "node-id-or-name"
moltbot config unset tools.web.search.apiKey
```

## Paths

Paths use dot or bracket notation:

```bash
moltbot config get agents.defaults.workspace
moltbot config get agents.list[0].id
```

Use the agent list index to target a specific agent:

```bash
moltbot config get agents.list
moltbot config set agents.list[1].tools.exec.node "node-id-or-name"
```

## Values

Values are parsed as JSON5 when possible; otherwise they are treated as strings.
Use `--json` to require JSON5 parsing.

```bash
moltbot config set agents.defaults.heartbeat.every "0m"
moltbot config set gateway.port 19001 --json
moltbot config set channels.whatsapp.groups '["*"]' --json
```

Restart the gateway after edits.
