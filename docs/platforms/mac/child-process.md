---
summary: "Gateway lifecycle on macOS (launchd)"
read_when:
  - Integrating the mac app with the gateway lifecycle
---
# Gateway lifecycle on macOS

The macOS app **manages the Gateway via launchd** by default and does not spawn
the Gateway as a child process. It first tries to attach to an already‑running
Gateway on the configured port; if none is reachable, it enables the launchd
service via the external `moltbot` CLI (no embedded runtime). This gives you
reliable auto‑start at login and restart on crashes.

Child‑process mode (Gateway spawned directly by the app) is **not in use** today.
If you need tighter coupling to the UI, run the Gateway manually in a terminal.

## Default behavior (launchd)

- The app installs a per‑user LaunchAgent labeled `com.clawdbot.gateway`
  (or `com.clawdbot.<profile>` when using `--profile`/`CLAWDBOT_PROFILE`).
- When Local mode is enabled, the app ensures the LaunchAgent is loaded and
  starts the Gateway if needed.
- Logs are written to the launchd gateway log path (visible in Debug Settings).

Common commands:

```bash
launchctl kickstart -k gui/$UID/com.clawdbot.gateway
launchctl bootout gui/$UID/com.clawdbot.gateway
```

Replace the label with `com.clawdbot.<profile>` when running a named profile.

## Unsigned dev builds

`scripts/restart-mac.sh --no-sign` is for fast local builds when you don’t have
signing keys. To prevent launchd from pointing at an unsigned relay binary, it:

- Writes `~/.clawdbot/disable-launchagent`.

Signed runs of `scripts/restart-mac.sh` clear this override if the marker is
present. To reset manually:

```bash
rm ~/.clawdbot/disable-launchagent
```

## Attach-only mode

To force the macOS app to **never install or manage launchd**, launch it with
`--attach-only` (or `--no-launchd`). This sets `~/.clawdbot/disable-launchagent`,
so the app only attaches to an already running Gateway. You can toggle the same
behavior in Debug Settings.

## Remote mode

Remote mode never starts a local Gateway. The app uses an SSH tunnel to the
remote host and connects over that tunnel.

## Why we prefer launchd

- Auto‑start at login.
- Built‑in restart/KeepAlive semantics.
- Predictable logs and supervision.

If a true child‑process mode is ever needed again, it should be documented as a
separate, explicit dev‑only mode.
