---
summary: "Experimental FaceTime carrier for a private OpenClaw voice session on a dedicated Mac"
read_when:
  - You are evaluating or developing the FaceTime plugin
  - You need its owner, driver, or private-API requirements
title: "FaceTime plugin"
sidebarTitle: "FaceTime (experimental)"
---

The FaceTime plugin is an experimental bundled plugin for an Apple Silicon Mac.
It can answer configured owner handles, place an explicitly
approved outgoing call, bridge call audio to a realtime provider, consult the
configured OpenClaw agent, and request carrier hangup.

<Warning>
This plugin injects a helper into protected Apple call applications and uses
private APIs. It is appropriate only on a dedicated, patched, physically
controlled Mac whose operator accepts that security boundary. The plugin never
changes System Integrity Protection, developer-tools policy, TCC permissions,
or System Settings automatically.
</Warning>

## Requirements

- Apple Silicon and macOS 14.4 or later
- OpenClaw 2026.8.1 or later
- signed native helpers from `openclaw/openclaw-facetime`
- full Xcode at `/Applications/Xcode.app`
- FaceTime signed in for the logged-in user
- a configured realtime voice provider
- consent from everyone whose audio will be processed

Install the signed and notarized native helpers, then enable the bundled plugin:

```bash
brew install openclaw/tap/openclaw-facetime
openclaw plugins enable facetime
```

The plugin requires native protocol version 1. Before staging the injected
helper, it requires the exact `Developer ID Application: OpenClaw Foundation
(FWJYW4S8P8)` identity and an accepted Apple notarization ticket. It fails
closed when the installed package is missing, incompatible, or signed by any
other identity.

## Configure owner identities

Every accepted handle receives owner authority. There is no guest tier.

```json5
{
  plugins: {
    allow: ["facetime"],
    entries: {
      facetime: {
        enabled: true,
        config: {
          ownerHandles: ["owner@example.com", "+12065550123"],
          realtime: {
            // Optional OpenAI-specific overrides for this FaceTime session.
            provider: "openai",
            model: "gpt-realtime-2.1",
            voice: "marin",
            sessionKey: "main",
            toolPolicy: "owner",
          },
        },
      },
    },
  },
}
```

`realtime.provider`, `realtime.model`, and `realtime.voice` are optional
overrides. When omitted, the registered realtime voice providers own provider
auto-selection, authentication, model defaults, and voice defaults. The OpenAI
values above are one explicit example, not FaceTime plugin defaults. Put a
plugin-local provider key under `realtime.providers.<provider>.apiKey` only when
you need to override that provider's normal authentication.

`realtime.toolPolicy` accepts `safe-read-only`, `owner`, or `none`. An invalid
explicit value fails configuration; it is never upgraded to `owner`.
Outgoing targets must match `ownerHandles` and require one-shot approval.
A matching phone number is never sufficient to grant owner authority: the
native helper and plugin both require a provider-classified FaceTime transport
and reject cellular, baseband, Wi-Fi Calling/PSTN, emergency, and unknown calls.

## Prepare the Mac

The helper requires debugger attachment to FaceTime and Phone. Setup reports
developer-tools and SIP debugging restrictions, but does not repair them.
Review the security tradeoff and manual recovery steps in
[FaceTime recovery and removal](/plugins/facetime-recovery).

Install or update the local paired audio driver through the admin-scoped
methods:

```bash
openclaw gateway call facetime.installDriver --json
openclaw gateway call facetime.updateDriver --json
openclaw gateway call facetime.driverStatus --json
```

The administrator phase downloads pinned BlackHole v0.7.1 source, verifies its
fixed SHA-256, and builds it with fixed options in a root-only temporary
directory. Before compilation it requires the canonical
`/Applications/Xcode.app` bundle, its complete sealed contents, and the selected
`xcodebuild`, `clang`, linker, and libtool binaries to be Apple-signed,
root-owned, and not group/world writable. It does not accept a caller-built
driver, digest, or compiler path.
If Xcode fails this trust check, reinstall Xcode from Apple into `/Applications`
through an administrator-managed installation; the plugin does not change
Xcode ownership, permissions, or signatures. Driver replacement remains
transactional: failure restores the previous driver, and Core Audio restarts
only after a committed replacement. Generated GPL artifacts are not
distributed with OpenClaw.

Configure FaceTime and Phone to use:

- microphone: `OpenClaw-Mic`
- output: physical speakers or headphones

Do not use an aggregate, multi-output, BlackHole, `OpenClaw-Mic`, or
`OpenClaw-Feed` device as call output.

## Inspect and activate

`facetime.status`, model `get_status`, and model `check_readiness` perform
static inspection when the runtime is inactive. They do not compile helpers,
open apps, inject, install, or start call media.

Explicit live inspection and repair are admin actions:

```bash
openclaw gateway call facetime.setup --json
openclaw gateway call facetime.preflight --json
```

Runtime flags such as `audioReady`, `realtimeActive`,
`processInputVerified`, and `processOutputSuppressed` describe internal stages.
They do not prove that a remote participant heard audio. Only a consensual live
round trip can prove remote audibility, and no such call is run automatically.

## Place and end calls

```bash
openclaw gateway call facetime.dial \
  --params '{"handle":"owner@example.com","mode":"audio"}' \
  --json

openclaw gateway call facetime.hangup --json
```

The caller-generated dial identity remains in the helper's process-local
correlation state and plugin SQLite state. It is not stamped into Apple's call
object. After Gateway restart, the plugin adopts only a call correlated by the
exact persisted dial identity, UUID alias, or proxy identity.

Hangup acknowledgement means only that termination was requested. The plugin
keeps local suppression until a native ended event or stable complete-topology
absence proves closure. On shutdown or capture loss, unproven closure escalates
to the exact authenticated carrier process before the tap is released.

## Remove the integration

Use the explicit admin uninstall, then follow the app-restart and SIP recovery
steps in [FaceTime recovery and removal](/plugins/facetime-recovery):

```bash
openclaw gateway call facetime.uninstall --json
```

## Limits

- one managed call at a time
- FaceTime video and Phone-owned FaceTime Audio require separate live proof
- private numeric call statuses use one versioned mapping; unknown states fail closed
- internal playback drain proves native `OpenClaw-Feed` consumption, not remote delivery
- no FaceTime-specific realtime-model fallback; the selected provider owns its defaults
