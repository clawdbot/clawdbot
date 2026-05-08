# Workspace bootstrap

This is the first thing the agent reads on a fresh workspace. Once
the user finishes setup (filling in SOUL.md, USER.md, etc.),
BOOTSTRAP.md gets removed and the workspace is "live."

## Setup checklist

- review SOUL.md and add personal context
- review USER.md and add role/preferences
- run `openclaw doctor` to verify config + workspace are valid
- confirm the gateway can reach your providers

## Removing this file

When the checklist is complete, delete BOOTSTRAP.md. The runtime
detects its absence as "setup complete."
