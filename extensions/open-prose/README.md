# OpenProse (plugin)

Adds the OpenProse skill pack and `/prose` slash command.

## Enable

Bundled plugins are disabled by default. Enable this one:

```json
{
  "plugins": {
    "entries": {
      "open-prose": { "enabled": true }
    }
  }
}
```

Restart the Gateway after enabling.

## What you get

- `/prose` slash command (user-invocable skill)
- OpenProse VM semantics (`.prose` programs + multi-agent orchestration)
- Telemetry support (best-effort, per OpenProse spec)
