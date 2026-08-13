# DEV-NOTES — Running the fork gateway from dist

Operational notes for anyone running `dist/index.js gateway --port 19789` from this
source tree (systemd user unit: `opencrustacean-gateway.service`).

## Golden rule: build ⇒ restart, never build over a running dist

`pnpm build` emits **hashed chunk filenames** and deletes the old ones. The _running_
gateway lazy-imports chunks on demand, so anything it hasn't loaded yet references
files that no longer exist after a rebuild:

    [plugins] plugin service stop failed (browser-control): Error [ERR_MODULE_NOT_FOUND]:
    Cannot find module '.../dist/control-service-<hash>.js' imported from .../dist/plugin-registration-<hash>.js
    [shutdown] task-registry-maintenance: Cannot find module '.../dist/task-registry.maintenance-<hash>.js'

Symptoms: broken browser-control, failing maintenance tasks, degraded/odd behavior,
until the gateway is restarted. The 2026-08-11 "frozen exec/shell tools" incident
(interrupted build → half-written dist) is the same family of bug.

**Always do both in one step:**

    pnpm build && systemctl --user restart opencrustacean-gateway.service

(or `pnpm build` then immediately restart — never leave a rebuilt dist running under
the old process).

## Restart side effects (expect these)

- In-flight exec runs and background subagents die; "dreaming" (memory-core) runs get
  orphaned and pruned at next startup.
- Webchat sockets drop (code=1006); the Control UI briefly errors with
  `SessionTranscriptProjectionUnavailableError` while transcripts rebuild.
- Restarts are clean SIGTERM ("restart drain") — systemd `Restart=always` handles crashes.

## Where to look

- Journal: `journalctl --user -u opencrustacean-gateway.service` (user systemd, PPID of the node process is systemd --user)
- Daily log: `/tmp/opencrustacean/opencrustacean-YYYY-MM-DD.log`
- Config: `~/.opencrustacean/opencrustacean.json` (gateway auto-restarts on some config changes — watch for "restart drain")
- Unit: `~/.config/systemd/user/opencrustacean-gateway.service` (`NODE_OPTIONS=--max-old-space-size=4096`)

## Known environment gotchas

- **Memory pressure:** gateway RSS routinely exceeds the 1.5 GiB warning threshold
  (peak observed 2.3 GiB + 764 MiB swap). ComfyUI renders on the same 22 GiB box make
  it worse. Watch `[diagnostics/memory]` warnings.
- **xai/grok:** OAuth refresh token was revoked + the xAI team had no credits (403s).
  Re-auth: `openclaw models auth login --provider xai`, fund team at console.x.ai.
- **Workspace vs identity:** `agents.defaults.workspace` is BOTH the default cwd and
  the identity/context source (AGENTS/SOUL/IDENTITY/USER/MEMORY/memory). The fork
  workspace (`~/.opencrustacean/workspace`) is deliberately separate from
  `~/Desktop/vscode` (prod's workspace) to prevent persona/memory bleedover between
  the two gateways. Do not point both at the same root.
- **AGENTS.md size cap:** workspace bootstrap files truncate above 10,000 chars
  (`agents.defaults.bootstrapMaxChars`). Keep AGENTS.md under it.
