---
summary: "Android app (node): connection runbook + Connect/Chat/OpenClaw/Voice/Canvas command surface"
read_when:
  - Pairing or reconnecting the Android node
  - Debugging Android gateway discovery or auth
  - Mirroring or controlling an Android device from a remote Mac
  - Verifying chat history parity across clients
title: "Android app"
---

<Note>
The official Android app is available on [Google Play](https://play.google.com/store/apps/details?id=ai.openclaw.app&hl=en_IN) and as a signed standalone APK on supported [GitHub Releases](https://github.com/openclaw/openclaw/releases). It is a companion node and requires a running OpenClaw Gateway. Source: [apps/android](https://github.com/openclaw/openclaw/tree/main/apps/android) ([build instructions](https://github.com/openclaw/openclaw/blob/main/apps/android/README.md)).
</Note>

## Support snapshot

- Role: companion node app (Android does not host the Gateway).
- Gateway required: yes (run it on macOS, Linux, or Windows via WSL2).
- Install: [Google Play](https://play.google.com/store/apps/details?id=ai.openclaw.app&hl=en_IN) or `OpenClaw-Android.apk` from a supported [GitHub Release](https://github.com/openclaw/openclaw/releases), [Getting Started](/start/getting-started) for the Gateway, then [Pairing](/channels/pairing).
- Gateway: [Runbook](/gateway) + [Configuration](/gateway/configuration).
  - Protocols: [Gateway protocol](/gateway/protocol) (nodes + control plane).
- **Settings → OpenClaw** opens a dedicated Gateway settings assistant when the operator connection has `operator.admin` and the Gateway supports `openclaw.chat`. Its setup conversation stays separate from ordinary Chat, redacts secret replies locally, and moves to Chat only after you tap **Open Chat**.

System control (launchd/systemd) lives on the Gateway host — see [Gateway](/gateway).

## Simultaneous gateway sessions

Pair each Gateway once, then open **Settings → Gateway**. The checkmark marks
the focused Gateway and each switch controls whether a non-focused Gateway's
operator session stays connected. Enabled Gateways reconnect independently
while the app is in the foreground, so switching focus does not tear down the
others. The focused Gateway alone owns the Android node session and device
capabilities; this prevents simultaneous Gateways from issuing camera,
location, screen, or notification commands to the same phone. Android can
suspend the secondary connections after the app leaves the foreground.

## Wear OS companion

The Wear OS companion uses the paired Android phone's authenticated Gateway connection; the watch never receives or stores Gateway credentials. It can select agents and sessions, read bounded transcripts, send text or dictated replies, abort an active run, start realtime Talk inside the selected session, and connect or disconnect the paired phone's Gateway. It also offers local reply notifications, dark or light appearance, and optional automatic speech for replies. Agent and Gateway controls are capability-negotiated for staggered phone/watch updates. Realtime Talk streams microphone and playback audio over a temporary Wear OS Data Layer channel and stops when the selected phone, Gateway connection, or audio channel is lost.

## Install outside Google Play

Regular final and correction GitHub Releases include a universal `OpenClaw-Android.apk` and `OpenClaw-Android-SHA256SUMS.txt`. The APK is built from the release tag, signed with the OpenClaw Android release key, and carries GitHub Actions provenance.

Choose a [release](https://github.com/openclaw/openclaw/releases) that lists both assets, then download and verify that exact tag before sideloading:

```bash
release_tag=vYYYY.M.PATCH
gh release download "$release_tag" \
  --repo openclaw/openclaw \
  --pattern OpenClaw-Android.apk \
  --pattern OpenClaw-Android-SHA256SUMS.txt
sha256sum --check OpenClaw-Android-SHA256SUMS.txt
gh attestation verify OpenClaw-Android.apk \
  --repo openclaw/openclaw \
  --signer-workflow openclaw/openclaw/.github/workflows/android-release.yml \
  --source-ref "refs/tags/${release_tag}" \
  --deny-self-hosted-runners
```

<Warning>
Google Play and standalone APK installs use different update channels and may have different signing identities. Android may require uninstalling the existing app before switching channels, which removes its local app data. Stay on one channel for normal updates.
</Warning>

## Mirror and control Android from a remote Mac

[scrcpy](https://github.com/Genymobile/scrcpy) mirrors an Android screen in a macOS window and
forwards keyboard and pointer input through Android Debug Bridge (ADB). This is an operator-side
workflow, separate from the OpenClaw node connection. It is useful when the Android device and the
Mac are in different locations but share a private Tailscale network.

### Before you begin

- Install Tailscale on the Android device and the Mac, and connect both to the same tailnet.
- On Android, enable **Developer options** and **USB debugging**. Android 16 places **Wireless
  debugging** under **Settings > System > Developer options**. See [Android developer
  options](https://developer.android.com/studio/debug/dev-options).
- Install scrcpy and ADB on the Mac:

  ```bash
  brew install scrcpy
  brew install --cask android-platform-tools
  ```

- Keep the Android device available for the first connection. Android must approve each Mac's ADB
  key before that Mac can control the device.

### Enable ADB over TCP

For the initial setup, connect the Android device by USB to a trusted computer and approve its
debugging prompt. Then run:

```bash
adb devices
adb tcpip 5555
```

You can now disconnect USB. If port 5555 stops listening after a device reboot or debugging reset,
repeat this local setup step. Android 11 and later can also establish the initial trust with
**Wireless debugging > Pair device with pairing code** and `adb pair`.

### Allow only the controller Mac

Tailnets with restrictive grants must explicitly allow the controller Mac to reach TCP port 5555
on the Android device. Add a narrow rule to the tailnet policy, replacing the example addresses
with the two devices' stable Tailscale IPs:

```json5
{
  grants: [
    {
      src: ["<remote-mac-tailnet-ip>"],
      dst: ["<android-tailnet-ip>"],
      ip: ["tcp:5555"],
    },
  ],
}
```

See [Tailscale grants](https://tailscale.com/docs/reference/syntax/grants) for host aliases and other
selectors. Do not grant this port to the public internet or expose it with Funnel: an authorized ADB
client has broad control of the device.

### Connect and start mirroring

On the remote Mac:

```bash
adb connect <android-tailnet-ip>:5555
adb devices
scrcpy --serial <android-tailnet-ip>:5555
```

The first `adb connect` from this Mac shows an authorization dialog on Android. Unlock the device,
confirm the key fingerprint, and select **Always allow from this computer** only when the Mac is
trusted. A successful `adb devices` entry ends in `device`; `unauthorized` means the on-device prompt
has not been approved.

Once the scrcpy window opens, use it directly or target it with a macOS screen-automation tool such
as [Peekaboo](https://peekaboo.sh/). scrcpy carries the display and input; Tailscale provides only the
private network path.

### Troubleshooting

- `Connection timed out`: verify the tailnet grant for TCP 5555. A successful `tailscale ping` proves
  peer reachability, not that policy permits this TCP port. Test with
  `nc -vz <android-tailnet-ip> 5555` from the Mac.
- `unauthorized`: unlock Android and approve the remote Mac's ADB key, or remove the stale workstation
  under **Wireless debugging > Paired devices** and pair it again.
- `Connection refused`: reconnect locally and run `adb tcpip 5555` again.
- More than one device listed: keep the explicit `--serial <android-tailnet-ip>:5555` argument.

When finished, close scrcpy and disconnect ADB:

```bash
adb disconnect <android-tailnet-ip>:5555
```

## Connection runbook

Android node app ⇄ (mDNS/NSD + WebSocket) ⇄ **Gateway**

Android connects directly to the Gateway WebSocket and uses device pairing (`role: node`).

For Tailscale or public hosts, Android requires a secure endpoint:

- Preferred: Tailscale Serve / Funnel with `https://<magicdns>` / `wss://<magicdns>`
- Also supported: any other `wss://` Gateway URL with a real TLS endpoint
- Cleartext `ws://` remains supported on private LAN addresses / `.local` hosts, plus `localhost`, `127.0.0.1`, and the Android emulator bridge (`10.0.2.2`); non-loopback setup automatically uses limited operator access

### Prerequisites

- Gateway running on another machine (or reachable via SSH).
- Android device/emulator can reach the gateway WebSocket:
  - Same LAN with mDNS/NSD, **or**
  - Same Tailscale tailnet using Wide-Area Bonjour / unicast DNS-SD (see below), **or**
  - Manual gateway host/port (fallback)
- Tailnet/public mobile pairing does **not** use raw tailnet IP `ws://` endpoints. Use Tailscale Serve or another `wss://` URL instead.
- The `openclaw` CLI available on the gateway machine (or via SSH), to approve pairing requests.

### 1. Start the Gateway

```bash
openclaw gateway --port 18789 --verbose
```

Confirm in logs you see something like:

- `listening on ws://0.0.0.0:18789`

For remote Android access over Tailscale, prefer Serve/Funnel instead of a raw tailnet bind:

```bash
openclaw gateway --tailscale serve
```

This gives Android a secure `wss://` / `https://` endpoint. A plain `gateway.bind: "tailnet"` setup is not enough for first-time remote Android pairing unless you also terminate TLS separately.

### 2. Verify discovery (optional)

From the gateway machine:

```bash
dns-sd -B _openclaw-gw._tcp local.
```

More debugging notes: [Bonjour](/gateway/bonjour).

If you also configured a wide-area discovery domain, compare against:

```bash
openclaw gateway discover --json
```

That shows `local.` plus the configured wide-area domain in one pass, using the resolved service endpoint instead of TXT-only hints.

#### Cross-network discovery via unicast DNS-SD

Android NSD/mDNS discovery does not cross networks. If the Android node and the gateway are on different networks but connected via Tailscale, use Wide-Area Bonjour / unicast DNS-SD instead. Discovery alone is not sufficient for tailnet/public Android pairing — the discovered route still needs a secure endpoint (`wss://` or Tailscale Serve):

1. Set up a DNS-SD zone (example `openclaw.internal.`) on the gateway host and publish `_openclaw-gw._tcp` records.
2. Configure Tailscale split DNS for your chosen domain pointing at that DNS server.

Details and example CoreDNS config: [Bonjour](/gateway/bonjour).

### 3. Connect from Android

In the Android app:

- The app keeps its gateway connection alive via a **foreground service** (persistent notification).
- Open the **Connect** tab.
- Use **Setup Code** or **Manual** mode.
- If discovery is blocked, use manual host/port in **Advanced controls**. For private LAN hosts, `ws://` still works. For Tailscale/public hosts, turn on TLS and use a `wss://` / Tailscale Serve endpoint.

After the first successful pairing, Android auto-reconnects on launch to the active paired gateway (best-effort for discovered gateways, which must be visible on the network).

Official setup codes connect Android as a node and grant full Gateway operator
access by default over `wss://`. Plaintext non-loopback `ws://` setup
automatically uses limited access for bearer-token safety. **Settings → Gateway**
shows **Full** or **Limited** access. For a limited connection, configure
`wss://` or Tailscale Serve, generate a new full-access code in Control UI or
with `openclaw qr`, then scan or paste it on that page and reconnect. Operators
who want the reduced profile can select **Limited access** in Control UI or run
`openclaw qr --limited`.

### Manage paired gateways

The app keeps a registry of every gateway it has paired with, so you can keep operator sessions connected and change focus without pairing again:

- **Settings → Gateway** lists paired gateways with the focused one marked. Tap an entry to focus it; the other enabled operator sessions remain connected.
- Each switch controls whether that non-focused Gateway stays connected while the app is in the foreground. The focused Gateway remains enabled and owns the phone's node connection and device capabilities.
- The **Connect** tab shows a quick switcher when more than one gateway is paired.
- Credentials, device tokens, TLS trust, chat history, and queued offline messages are stored per Gateway. Changing focus never mixes state between Gateways, and messages queued while offline are delivered only to the Gateway they were written for.
- **Forget** removes a gateway's registry entry together with its credentials, device tokens, TLS pin, and cached chats.

### Presence alive beacons

After the authenticated node session connects, and when the app moves to the background while the foreground service is still connected, Android calls `node.event` with `event: "node.presence.alive"`. The gateway records this as `lastSeenAtMs`/`lastSeenReason` on the paired node/device metadata only after the authenticated node device identity is known.

The app counts the beacon as successfully recorded only when the gateway response includes `handled: true`. Older gateways may acknowledge `node.event` with `{ "ok": true }`; that response is compatible but does not count as a durable last-seen update.

### 4. Approve pairing (CLI)

On the gateway machine:

```bash
openclaw devices list
openclaw devices approve <requestId>
openclaw devices reject <requestId>
```

Pairing details: [Pairing](/channels/pairing).

Optional: if the Android node always connects from a tightly controlled subnet, you can opt in to first-time node auto-approval with explicit CIDRs or exact IPs:

```json5
{
  gateway: {
    nodes: {
      pairing: {
        autoApproveCidrs: ["192.168.1.0/24"],
      },
    },
  },
}
```

This is disabled by default. It applies only to fresh `role: node` pairing with no requested scopes. Operator/browser pairing and any role, scope, metadata, or public-key change still require manual approval.

### 5. Verify the node is connected

```bash
openclaw nodes status
openclaw gateway call node.list --params "{}"
```

### 6. Chat + history

The Android Chat tab supports session selection (default `main`, plus other existing sessions):

- History: `chat.history` (display-normalized — inline directive tags, plain-text tool-call XML payloads (`<tool_call>`, `<function_call>`, `<tool_calls>`, `<function_calls>`, and truncated variants), and leaked ASCII/full-width model control tokens are stripped; silent-token assistant rows such as exact `NO_REPLY` / `no_reply` are omitted; oversized rows can be replaced with placeholders)
- Send: `chat.send`
- Durable sending: every send (text, picked images, and voice notes) is journaled to a per-gateway on-device outbox before any network attempt, so app termination cannot lose submitted input. Sends queued while offline deliver in order on reconnect with stable idempotency keys, and a send is retired only after the turn is visible in canonical `chat.history` — an acknowledgement alone is not treated as proof of delivery. Ambiguous outcomes (lost acknowledgement, app killed mid-send, gateway restart before the transcript write) surface as visible rows with explicit **Retry**/**Delete** instead of auto-resending. Slash commands never auto-replay across a reconnect; they park for explicit retry. The queue is bounded (50 messages and 48 MB of attachment bytes per gateway) and unsent rows expire after 48 hours. Composer drafts that were never submitted are not process-durable.
- Push updates (best-effort): `chat.subscribe` -> `event:"chat"`
- Listen: long-press an assistant message and choose **Listen** to hear it; audio renders via gateway `tts.speak` with the configured TTS provider chain, and on-device system TTS is used when the gateway cannot render audio. Playback stops on session switch, new chat, app backgrounding, or chat close.

### 7. Canvas + camera

#### Gateway Canvas Host (recommended for web content)

To have the node show real HTML/CSS/JS that the agent can edit on disk, point the node at the Gateway canvas host.

<Note>
Nodes load canvas from the Gateway HTTP server (same port as `gateway.port`, default `18789`).
</Note>

1. Create `~/.openclaw/workspace/canvas/index.html` on the gateway host.
2. Navigate the node to it (LAN):

```bash
openclaw nodes invoke --node "<Android Node>" --command canvas.navigate --params '{"url":"http://<gateway-hostname>.local:18789/__openclaw__/canvas/"}'
```

Tailnet (optional): if both devices are on Tailscale, use a MagicDNS name or tailnet IP instead of `.local`, e.g. `http://<gateway-magicdns>:18789/__openclaw__/canvas/`.

This server injects a live-reload client into HTML and reloads on file changes. The Gateway also serves `/__openclaw__/a2ui/`, but the Android app treats remote A2UI pages as render-only. Action-capable A2UI commands use the bundled app-owned A2UI page.

Canvas commands (foreground only):

- `canvas.eval`, `canvas.snapshot`, `canvas.navigate` (use `{"url":""}` or `{"url":"/"}` to return to the default scaffold). `canvas.snapshot` returns `{ format, base64 }` (default `format="jpeg"`).
- A2UI: `canvas.a2ui.push`, `canvas.a2ui.reset` (`canvas.a2ui.pushJSONL` legacy alias). These use the bundled app-owned A2UI page for action-capable rendering.

Camera commands (foreground only; permission-gated): `camera.snap` (jpg), `camera.clip` (mp4). See [Camera node](/nodes/camera) for parameters and CLI helpers.

### 8. Voice + expanded Android command surface

- Android's shell navigation is **Home**, **Chat**, and **Settings**. Voice input
  belongs to the Chat composer; there is no separate Voice tab.
- Tap the composer microphone for on-device speech recognition that inserts a
  transcript into the draft. Long-press the microphone to record a voice-note
  attachment. The UI reports unavailable recognition, missing permission,
  busy/network failures, and no-speech outcomes instead of silently dropping
  the attempt.
- Start continuous **Talk** from the Chat waveform. Dictation, voice-note
  recording, and Talk are mutually exclusive microphone paths.
- Talk Mode promotes the existing foreground service from `connectedDevice` to `connectedDevice|microphone` before capture starts, then demotes it when Talk Mode stops. The node service declares `FOREGROUND_SERVICE_CONNECTED_DEVICE` with `CHANGE_NETWORK_STATE`; Android 14+ also requires the `FOREGROUND_SERVICE_MICROPHONE` declaration, the `RECORD_AUDIO` runtime grant, and the microphone service type at runtime.
- By default, Android Talk uses native speech recognition, Gateway chat, and `talk.speak` through the configured gateway Talk provider. Local system TTS is used only when `talk.speak` is unavailable.
- Android Talk uses realtime Gateway relay only when `talk.realtime.mode` is `realtime` and `talk.realtime.transport` is `gateway-relay`.
- Android does not advertise the `voiceWake` capability. Use Chat dictation,
  a voice note, or Talk for voice input.
- Additional Android command families (availability depends on device, permissions, and user settings):
  - `device.status`, `device.info`, `device.permissions`, `device.health`
  - `device.apps` only when **Settings > Phone Capabilities > Installed Apps** is enabled; it lists launcher-visible apps by default (pass `includeNonLaunchable` for the full list).
  - `notifications.list`, `notifications.actions` (see [Notification forwarding](#notification-forwarding) below)
  - `photos.latest`
  - `contacts.search`, `contacts.add`
  - `calendar.events`, `calendar.add`
  - `callLog.search`
  - `sms.search`
  - `motion.activity`, `motion.pedometer`

### 9. Workspace files (read-only)

The Home overview includes a **Files** card that browses the active agent's workspace through the read-only `agents.workspace.list` / `agents.workspace.get` gateway RPCs: directory drill-down, text and image previews, and export through the Android share sheet. There are no write operations, and previews are size-capped by the gateway.

## Review command approvals

An operator connection with `operator.admin`, or a paired
`operator.approvals` connection explicitly targeted by the Gateway, can review
pending exec requests under **Settings -> Approvals**. The app loads the
Gateway's sanitized approval record before enabling its buttons, shows any
security warning and the exact decisions offered by that request, and submits
the approval ID and owner kind back to the Gateway.

Approval state is shared with the Control UI and supported chat surfaces. The
first committed answer wins; Android displays that canonical result even when
another surface answered first. If a resolve response is lost or the Gateway
disconnects, the app keeps the action locked and reads the approval again
before offering another decision.

Gateways that predate the unified approval methods fall back to the shipped
exec-specific methods. Pending review still works, but retained terminal state
and the richer cross-surface result require an updated Gateway.

## Answer agent questions

Chat shows pending Gateway questions as native cards for operator connections
with `operator.questions` (or `operator.admin`). Cards support single- and
multi-select options, option descriptions, free-text **Other** answers, and an
expiry countdown. Reconnects reload pending questions from the Gateway. A card
locks when this device answers it, another surface answers it first, or the
question expires or is cancelled.

## Assistant entrypoints

Android supports launching OpenClaw from the system assistant trigger (Google Assistant). Holding the home button (or another `ACTION_ASSIST` trigger) opens the app; saying "Hey Google, ask OpenClaw `<prompt>`" matches the app's declared App Actions query pattern and hands the prompt into the chat composer without auto-sending it.

This uses Android **App Actions** (`shortcuts.xml` capability) declared in the app manifest. No gateway-side configuration is needed — the assistant intent is handled entirely by the Android app.

<Note>
App Actions availability depends on the device, Google Play Services version, and whether the user has set OpenClaw as the default assistant app.
</Note>

## Notification forwarding

Android can forward device notifications to the gateway as `node.event` items. This is configured **on the device**, in the app's Settings sheet — not in gateway/`openclaw.json` config.

| Setting                     | Description                                                                                                                                                                                            |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Forward Notification Events | Master toggle. Off by default; requires Notification Listener Access to be granted first.                                                                                                              |
| Package Filter              | **Allowlist** (only listed package IDs forwarded) or **Blocklist** (default: all packages except listed IDs). OpenClaw's own package is always excluded in Blocklist mode to prevent forwarding loops. |
| Quiet Hours                 | Local HH:mm start/end window that suppresses forwarding. Disabled by default; defaults to `22:00`-`07:00` once enabled.                                                                                |
| Max Events / Minute         | Per-device rate limit on forwarded notifications. Default 20.                                                                                                                                          |
| Route Session Key           | Optional. Pins forwarded notification events into a specific session instead of the device's default notification route.                                                                               |

<Note>
Notification forwarding requires the Android Notification Listener permission. The app prompts for this during setup.
</Note>

WhatsApp, WhatsApp Business, Telegram, Telegram X, Discord, and Signal notifications are always excluded. Their messages are already owned by native OpenClaw channel sessions; forwarding the Android notification as a separate node event could route a reply through the wrong conversation.

## Related

- [iOS app](/platforms/ios)
- [Nodes](/nodes)
- [Android node troubleshooting](/nodes/troubleshooting)
