---
summary: "Google Meet plugin: join explicit Meet URLs through Chrome or Twilio with realtime voice defaults"
read_when:
  - You want an OpenClaw agent to join a Google Meet call
  - You are configuring Chrome, Chrome node, or Twilio as a Google Meet transport
title: "Google Meet plugin"
---

# Google Meet (plugin)

Google Meet participant support for OpenClaw.

The plugin is explicit by design:

- It only joins an explicit `https://meet.google.com/...` URL.
- `realtime` voice is the default mode.
- Realtime voice can call back into the full OpenClaw agent when deeper
  reasoning or tools are needed.
- Auth starts as personal Google OAuth or an already signed-in Chrome profile.
- There is no automatic consent announcement.
- The default Chrome audio backend is `BlackHole 2ch`.
- Chrome can run locally or on a paired node host.
- Twilio accepts a dial-in number plus optional PIN or DTMF sequence.
- The CLI command is `googlemeet`; `meet` is reserved for broader agent
  teleconference workflows.

## Quick start

Install the local audio dependencies and make sure the realtime provider can use
OpenAI:

```bash
brew install blackhole-2ch sox
export OPENAI_API_KEY=sk-...
```

`blackhole-2ch` installs the `BlackHole 2ch` virtual audio device. Homebrew's
installer requires a reboot before macOS exposes the device:

```bash
sudo reboot
```

After reboot, verify both pieces:

```bash
system_profiler SPAudioDataType | grep -i BlackHole
command -v rec play
```

Enable the plugin:

```json5
{
  plugins: {
    entries: {
      "google-meet": {
        enabled: true,
        config: {},
      },
    },
  },
}
```

Check setup:

```bash
openclaw googlemeet setup
```

Join a meeting:

```bash
openclaw googlemeet join https://meet.google.com/abc-defg-hij
```

Or let an agent join through the `google_meet` tool:

```json
{
  "action": "join",
  "url": "https://meet.google.com/abc-defg-hij"
}
```

Chrome joins as the signed-in Chrome profile. In Meet, pick `BlackHole 2ch` for
the microphone/speaker path used by OpenClaw. For clean duplex audio, use
separate virtual devices or a Loopback-style graph; a single BlackHole device is
enough for a first smoke test but can echo.

### Local Gateway + Parallels Chrome

You do **not** need a full OpenClaw Gateway or model API key inside a macOS VM
just to make the VM own Chrome. Run the Gateway and agent locally, then run a
node host in the VM. Enable the bundled plugin on the VM once so the node
advertises the Chrome command:

What runs where:

- Gateway host: OpenClaw Gateway, agent workspace, model/API keys, realtime
  provider, and the Google Meet plugin config.
- Parallels macOS VM: OpenClaw CLI/node host, Google Chrome, SoX, BlackHole 2ch,
  and a Chrome profile signed in to Google.
- Not needed in the VM: Gateway service, agent config, OpenAI/GPT key, or model
  provider setup.

Install the VM dependencies:

```bash
brew install blackhole-2ch sox
```

Reboot the VM after installing BlackHole so macOS exposes `BlackHole 2ch`:

```bash
sudo reboot
```

After reboot, verify the VM can see the audio device and SoX commands:

```bash
system_profiler SPAudioDataType | grep -i BlackHole
command -v rec play
```

Install or update OpenClaw in the VM, then enable the bundled plugin there:

```bash
openclaw plugins enable google-meet
```

Start the node host in the VM:

```bash
openclaw node run --host <gateway-host> --port 18789 --display-name parallels-macos
```

If `<gateway-host>` is a LAN IP and you are not using TLS, the node refuses the
plaintext WebSocket unless you opt in for that trusted private network:

```bash
OPENCLAW_ALLOW_INSECURE_PRIVATE_WS=1 \
  openclaw node run --host <gateway-lan-ip> --port 18789 --display-name parallels-macos
```

Use the same environment variable when installing the node as a LaunchAgent:

```bash
OPENCLAW_ALLOW_INSECURE_PRIVATE_WS=1 \
  openclaw node install --host <gateway-lan-ip> --port 18789 --display-name parallels-macos --force
openclaw node restart
```

`OPENCLAW_ALLOW_INSECURE_PRIVATE_WS=1` is process environment, not an
`openclaw.json` setting. `openclaw node install` stores it in the LaunchAgent
environment when it is present on the install command.

Approve the node from the Gateway host:

```bash
openclaw devices list
openclaw devices approve <requestId>
```

Confirm the Gateway sees the node and that it advertises `googlemeet.chrome`:

```bash
openclaw nodes status
```

Route Meet through that node on the Gateway host:

```json5
{
  gateway: {
    nodes: {
      allowCommands: ["googlemeet.chrome"],
    },
  },
  plugins: {
    entries: {
      "google-meet": {
        enabled: true,
        config: {
          defaultTransport: "chrome-node",
          chromeNode: {
            node: "parallels-macos",
          },
        },
      },
    },
  },
}
```

Now join normally from the Gateway host:

```bash
openclaw googlemeet join https://meet.google.com/abc-defg-hij
```

or ask the agent to use the `google_meet` tool with `transport: "chrome-node"`.

If `chromeNode.node` is omitted, OpenClaw auto-selects only when exactly one
connected node advertises `googlemeet.chrome`. If several capable nodes are
connected, set `chromeNode.node` to the node id, display name, or remote IP.

Common failure checks:

- `No connected Google Meet-capable node`: start `openclaw node run` in the VM,
  approve pairing, and make sure `openclaw plugins enable google-meet` was run
  in the VM. Also confirm the Gateway host allows the node command with
  `gateway.nodes.allowCommands: ["googlemeet.chrome"]`.
- `BlackHole 2ch audio device not found on the node`: install `blackhole-2ch`
  in the VM and reboot the VM.
- Chrome opens but cannot join: sign in to Chrome inside the VM and confirm that
  profile can join the Meet URL manually.
- No audio: in Meet, route microphone/speaker through the virtual audio device
  path used by OpenClaw; use separate virtual devices or Loopback-style routing
  for clean duplex audio.

## Install notes

The Chrome realtime default uses two external tools:

- `sox`: command-line audio utility. The plugin uses its `rec` and `play`
  commands for the default 8 kHz G.711 mu-law audio bridge.
- `blackhole-2ch`: macOS virtual audio driver. It creates the `BlackHole 2ch`
  audio device that Chrome/Meet can route through.

OpenClaw does not bundle or redistribute either package. The docs ask users to
install them as host dependencies through Homebrew. SoX is licensed as
`LGPL-2.0-only AND GPL-2.0-only`; BlackHole is GPL-3.0. If you build an
installer or appliance that bundles BlackHole with OpenClaw, review BlackHole's
upstream licensing terms or get a separate license from Existential Audio.

## Transports

### Chrome

Chrome transport opens the Meet URL in Google Chrome and joins as the signed-in
Chrome profile. On macOS, the plugin checks for `BlackHole 2ch` before launch.
If configured, it also runs an audio bridge health command and startup command
before opening Chrome. Use `chrome` when Chrome/audio live on the Gateway host;
use `chrome-node` when Chrome/audio live on a paired node such as a Parallels
macOS VM.

```bash
openclaw googlemeet join https://meet.google.com/abc-defg-hij --transport chrome
openclaw googlemeet join https://meet.google.com/abc-defg-hij --transport chrome-node
```

Route Chrome microphone and speaker audio through the local OpenClaw audio
bridge. If `BlackHole 2ch` is not installed, the join fails with a setup error
instead of silently joining without an audio path.

### Twilio

Twilio transport is a strict dial plan delegated to the Voice Call plugin. It
does not parse Meet pages for phone numbers.

```bash
openclaw googlemeet join https://meet.google.com/abc-defg-hij \
  --transport twilio \
  --dial-in-number +15551234567 \
  --pin 123456
```

Use `--dtmf-sequence` when the meeting needs a custom sequence:

```bash
openclaw googlemeet join https://meet.google.com/abc-defg-hij \
  --transport twilio \
  --dial-in-number +15551234567 \
  --dtmf-sequence ww123456#
```

## OAuth and preflight

Google Meet Media API access uses a personal OAuth client first. Configure
`oauth.clientId` and optionally `oauth.clientSecret`, then run:

```bash
openclaw googlemeet auth login --json
```

The command prints an `oauth` config block with a refresh token. It uses PKCE,
localhost callback on `http://localhost:8085/oauth2callback`, and a manual
copy/paste flow with `--manual`.

These environment variables are accepted as fallbacks:

- `OPENCLAW_GOOGLE_MEET_CLIENT_ID` or `GOOGLE_MEET_CLIENT_ID`
- `OPENCLAW_GOOGLE_MEET_CLIENT_SECRET` or `GOOGLE_MEET_CLIENT_SECRET`
- `OPENCLAW_GOOGLE_MEET_REFRESH_TOKEN` or `GOOGLE_MEET_REFRESH_TOKEN`
- `OPENCLAW_GOOGLE_MEET_ACCESS_TOKEN` or `GOOGLE_MEET_ACCESS_TOKEN`
- `OPENCLAW_GOOGLE_MEET_ACCESS_TOKEN_EXPIRES_AT` or
  `GOOGLE_MEET_ACCESS_TOKEN_EXPIRES_AT`
- `OPENCLAW_GOOGLE_MEET_DEFAULT_MEETING` or `GOOGLE_MEET_DEFAULT_MEETING`
- `OPENCLAW_GOOGLE_MEET_PREVIEW_ACK` or `GOOGLE_MEET_PREVIEW_ACK`

Resolve a Meet URL, code, or `spaces/{id}` through `spaces.get`:

```bash
openclaw googlemeet resolve-space --meeting https://meet.google.com/abc-defg-hij
```

Run preflight before media work:

```bash
openclaw googlemeet preflight --meeting https://meet.google.com/abc-defg-hij
```

Set `preview.enrollmentAcknowledged: true` only after confirming your Cloud
project, OAuth principal, and meeting participants are enrolled in the Google
Workspace Developer Preview Program for Meet media APIs.

## Config

The common Chrome realtime path only needs the plugin enabled, BlackHole, SoX,
and an OpenAI key:

```bash
brew install blackhole-2ch sox
export OPENAI_API_KEY=sk-...
```

Set the plugin config under `plugins.entries.google-meet.config`:

```json5
{
  plugins: {
    entries: {
      "google-meet": {
        enabled: true,
        config: {},
      },
    },
  },
}
```

Defaults:

- `defaultTransport: "chrome"`
- `defaultMode: "realtime"`
- `chromeNode.node`: optional node id/name/IP for `chrome-node`
- `chrome.audioBackend: "blackhole-2ch"`
- `chrome.audioInputCommand`: SoX `rec` command writing 8 kHz G.711 mu-law
  audio to stdout
- `chrome.audioOutputCommand`: SoX `play` command reading 8 kHz G.711 mu-law
  audio from stdin
- `realtime.provider: "openai"`
- `realtime.toolPolicy: "safe-read-only"`
- `realtime.instructions`: brief spoken replies, with
  `openclaw_agent_consult` for deeper answers
- `realtime.introMessage`: short spoken readiness check when the realtime bridge
  connects; set it to `""` to join silently

Optional overrides:

```json5
{
  defaults: {
    meeting: "https://meet.google.com/abc-defg-hij",
  },
  chrome: {
    browserProfile: "Default",
  },
  chromeNode: {
    node: "parallels-macos",
  },
  realtime: {
    toolPolicy: "owner",
    introMessage: "Say exactly: I'm here.",
  },
}
```

Twilio-only config:

```json5
{
  defaultTransport: "twilio",
  twilio: {
    defaultDialInNumber: "+15551234567",
    defaultPin: "123456",
  },
  voiceCall: {
    gatewayUrl: "ws://127.0.0.1:18789",
  },
}
```

## Tool

Agents can use the `google_meet` tool:

```json
{
  "action": "join",
  "url": "https://meet.google.com/abc-defg-hij",
  "transport": "chrome-node",
  "mode": "realtime"
}
```

Use `transport: "chrome"` when Chrome runs on the Gateway host. Use
`transport: "chrome-node"` when Chrome runs on a paired node such as a Parallels
VM. In both cases the realtime model and `openclaw_agent_consult` run on the
Gateway host, so model credentials stay there.

Use `action: "status"` to list active sessions or inspect a session ID. Use
`action: "speak"` with `sessionId` and `message` to make the realtime agent
speak immediately. Use `action: "leave"` to mark a session ended.

```json
{
  "action": "speak",
  "sessionId": "meet_...",
  "message": "Say exactly: I'm here and listening."
}
```

## Realtime agent consult

Chrome realtime mode is optimized for a live voice loop. The realtime voice
provider hears the meeting audio and speaks through the configured audio bridge.
When the realtime model needs deeper reasoning, current information, or normal
OpenClaw tools, it can call `openclaw_agent_consult`.

The consult tool runs the regular OpenClaw agent behind the scenes with recent
meeting transcript context and returns a concise spoken answer to the realtime
voice session. The voice model can then speak that answer back into the meeting.

`realtime.toolPolicy` controls the consult run:

- `safe-read-only`: expose the consult tool and limit the regular agent to
  `read`, `web_search`, `web_fetch`, `x_search`, `memory_search`, and
  `memory_get`.
- `owner`: expose the consult tool and let the regular agent use the normal
  agent tool policy.
- `none`: do not expose the consult tool to the realtime voice model.

The consult session key is scoped per Meet session, so follow-up consult calls
can reuse prior consult context during the same meeting.

To force a spoken readiness check after Chrome has fully joined the call:

```bash
openclaw googlemeet speak meet_... "Say exactly: I'm here and listening."
```

## Notes

Google Meet's official media API is receive-oriented, so speaking into a Meet
call still needs a participant path. This plugin keeps that boundary visible:
Chrome handles browser participation and local audio routing; Twilio handles
phone dial-in participation.

Chrome realtime mode needs either:

- `chrome.audioInputCommand` plus `chrome.audioOutputCommand`: OpenClaw owns the
  realtime model bridge and pipes 8 kHz G.711 mu-law audio between those
  commands and the selected realtime voice provider.
- `chrome.audioBridgeCommand`: an external bridge command owns the whole local
  audio path and must exit after starting or validating its daemon.

For clean duplex audio, route Meet output and Meet microphone through separate
virtual devices or a Loopback-style virtual device graph. A single shared
BlackHole device can echo other participants back into the call.

`googlemeet speak` triggers the active realtime audio bridge for a Chrome
session. `googlemeet leave` stops that bridge. For Twilio sessions delegated
through the Voice Call plugin, `leave` also hangs up the underlying voice call.

## Related

- [Voice call plugin](/plugins/voice-call)
- [Talk mode](/nodes/talk)
- [Building plugins](/plugins/building-plugins)
