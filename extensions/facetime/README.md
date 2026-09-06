# OpenClaw FaceTime

Experimental FaceTime carrier plugin for a dedicated Apple Silicon
Mac. The public setup, security, operation, and removal guides are:

- <https://docs.openclaw.ai/plugins/facetime>
- <https://docs.openclaw.ai/plugins/facetime-recovery>

The plugin is bundled with OpenClaw. Its signed and notarized native helpers are
released separately from `openclaw/openclaw-facetime` and installed with:

```bash
brew install openclaw/tap/openclaw-facetime
```

## Ownership boundaries

- `src/call-lifecycle.ts` owns the closed carrier/model state machine,
  generation fencing, serialized native commands, and the complete alias index.
- `src/pending-dial-store.ts` persists the one exact approved pending dial in
  plugin-owned SQLite state.
- `src/helper-rpc.ts` owns bounded loopback IPC with mutual authentication,
  connection-epoch message MACs, replay sequencing, and typed native
  postcondition projection.
- `src/helper-supervisor.ts` owns generation-bound LLDB injection and joins
  in-flight work on stop.
- `src/audio-pump.ts` owns the bounded framed parent/native media protocol.
- `openclaw/openclaw-facetime` owns the native process tap and injected helper.
  This plugin validates native protocol version 1, the exact OpenClaw
  Foundation Developer ID identity, and Apple notarization before activation.
- `src/talk-driver.ts` owns provider response/tool generations and exact agent
  consult cancellation.

Carrier hangup is terminal only after a native ended event or stable complete
topology absence. A helper reply only acknowledges the request. Capture death,
Gateway handoff, and unproven shutdown escalate before local suppression is
released.

## Configuration

`ownerHandles` is the only caller list. Every accepted identity receives owner
authority. `realtime.toolPolicy` is one of `safe-read-only`, `owner`, or `none`;
invalid explicit values fail validation.
`realtime.provider`, `realtime.model`, and `realtime.voice` are optional
session overrides. Registered realtime providers own auto-selection,
authentication, and their model and voice defaults.

The helper endpoint is not configurable. Node and the native helper consume
`helper-endpoint.json`, bind loopback only, and derive the port from the user ID.
The helper creates each connection epoch and authenticates the Gateway before
accepting commands; every command, response, and event is direction-bound and
strictly sequenced within that epoch.

## Development checks

```bash
node scripts/run-vitest.mjs extensions/facetime
sh -n extensions/facetime/scripts/*.sh
(cd extensions/facetime && npm pack --dry-run)
```

Do not run live calls, install/uninstall the driver, change SIP, enable developer
tools, or modify TCC during automated validation.

## Native and licensing boundary

The privileged driver script pins BlackHole v0.7.1 and its SHA-256, builds the
renamed `OpenClawBridge.driver` in a root-only temporary directory, and accepts
no caller-built artifact, digest, or compiler path. Before compilation it
requires the canonical Xcode bundle and its selected build tools to be
Apple-signed, root-owned, and not group/world writable, then performs a
transactional swap. Generated BlackHole/driver artifacts are GPL-3.0 and are
excluded from the package. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

The separately released Objective-C and Swift native sources, their adapted
third-party notices, and their signing pipeline live in
`openclaw/openclaw-facetime`.
