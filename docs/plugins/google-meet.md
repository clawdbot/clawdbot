---
summary: "Google Meet plugin: join explicit Meet URLs through Chrome or Twilio with agent talk-back defaults"
read_when:
  - You want an OpenClaw agent to join a Google Meet call
  - You want an OpenClaw agent to create a new Google Meet call
  - You are configuring Chrome, Chrome node, or Twilio as a Google Meet transport
title: "Google Meet plugin"
---

The `google-meet` plugin joins explicit Meet URLs on behalf of an OpenClaw agent. It is deliberately narrow:

- It only joins `https://meet.google.com/...` URLs; it never dials into a meeting from a phone number it discovers itself.
- `googlemeet create` can mint a new Meet URL through the Google Meet API (or a browser fallback) and join it by default.
- Chrome participation uses a signed-in Chrome profile, optionally on a paired node. Twilio participation dials a phone number plus PIN/DTMF through the [Voice call plugin](/plugins/voice-call); it cannot dial a Meet URL directly.
- `mode: "agent"` (default) transcribes participant speech with a realtime provider, routes it to the configured OpenClaw agent, and speaks the answer with regular OpenClaw TTS. `mode: "bidi"` lets a realtime voice model answer directly. `mode: "transcribe"` joins observe-only with no talk-back.
- There is no automatic consent announcement when the plugin joins a call.
- The CLI command is `googlemeet`; `meet` is reserved for broader agent teleconference workflows.

## Quick start

Install the local audio dependencies, then set a realtime provider key. OpenAI is the default transcription provider for `agent` mode; Google Gemini Live is available as the `bidi`-mode voice provider:

```bash
brew install blackhole-2ch sox
export OPENAI_API_KEY=sk-...
# only needed when realtime.voiceProvider is "google" for bidi mode
export GEMINI_API_KEY=...
```

`blackhole-2ch` installs the `BlackHole 2ch` virtual audio device Chrome routes through. Homebrew's installer requires a reboot before macOS exposes the device:

```bash
sudo reboot
```

After reboot, verify both pieces:

```bash
system_profiler SPAudioDataType | grep -i BlackHole
command -v sox
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

Check setup, then join:

```bash
openclaw googlemeet setup
openclaw googlemeet join https://meet.google.com/abc-defg-hij
```

`setup` output is agent-readable and mode/transport-aware: it reports Chrome profile, node pinning, and, for realtime Chrome joins, the BlackHole/SoX audio bridge and the delayed-intro check. Observe-only joins skip realtime prerequisites:

```bash
openclaw googlemeet setup --transport chrome-node --mode transcribe
```

When Twilio delegation is configured, `setup` also reports whether `voice-call`, Twilio credentials, and public webhook exposure are ready. Treat any `ok: false` check as a blocker for that transport/mode before an agent joins. Use `--json` for machine-readable output, and `--transport chrome|chrome-node|twilio` to preflight a specific transport ahead of time:

```bash
openclaw googlemeet setup --transport twilio
```

Or let an agent join through the `google_meet` tool:

```json
{
  "action": "join",
  "url": "https://meet.google.com/abc-defg-hij",
  "transport": "chrome-node",
  "mode": "agent"
}
```

On non-macOS Gateway hosts, `google_meet` stays visible for artifact, calendar, setup, transcribe, Twilio, and `chrome-node` actions, but local Chrome talk-back (`transport: "chrome"` with `mode: "agent"` or `"bidi"`) is blocked before it reaches the audio bridge, because that path currently depends on macOS `BlackHole 2ch`. Use `mode: "transcribe"`, Twilio dial-in, or a macOS `chrome-node` host instead.

### Create a meeting

```bash
openclaw googlemeet create --transport chrome-node --mode agent
openclaw googlemeet create --no-join
```

`create` has two paths, reported in the result's `source` field:

- **`api`**: used when Google Meet OAuth credentials are configured. Deterministic; does not depend on browser UI state.
- **`browser`**: used without OAuth credentials. OpenClaw opens `https://meet.google.com/new` on the pinned Chrome node and waits for Google to redirect to a real meeting-code URL; the OpenClaw Chrome profile on that node must already be signed in to Google. Join and create both reuse an existing Meet tab (or an in-progress `.../new` / Google account prompt tab) before opening a new one; tab matching ignores harmless query strings like `authuser`.

`create` joins by default and returns `joined: true` plus the join session. Pass `--no-join` (CLI) or `"join": false` (tool) to mint the URL only.

For API-created rooms, set an explicit access policy instead of inheriting the Google account default:

```bash
openclaw googlemeet create --access-type OPEN --transport chrome-node --mode agent
```

| `--access-type` | Who can join without knocking                                       |
| --------------- | ------------------------------------------------------------------- |
| `OPEN`          | Anyone with the Meet URL                                            |
| `TRUSTED`       | Host org's trusted users, invited external users, and dial-in users |
| `RESTRICTED`    | Invitees only                                                       |

This only applies to API-created rooms, so OAuth must be configured. If you authenticated before this option existed, rerun `openclaw googlemeet auth login --json` after adding the `meetings.space.settings` scope to your OAuth consent screen.

If the browser fallback hits a Google login or Meet permission blocker, the tool returns `manualActionRequired: true` with `manualActionReason`, `manualActionMessage`, and the `browser.nodeId`/`browser.targetId`/`browserUrl`. Report that message and stop opening new Meet tabs until the operator finishes the browser step.

### Observe-only join

Set `"mode": "transcribe"` to skip the duplex realtime bridge (no BlackHole/SoX requirement, no talk-back). Transcribe-mode Chrome joins also skip OpenClaw's microphone/camera permission grant and the Meet **Use microphone** path; if Meet shows the audio-choice interstitial, automation tries **Continue without microphone** first. Managed Chrome transports in this mode install a best-effort Meet caption observer. `googlemeet status --json` and `googlemeet doctor` report `captioning`, `captionsEnabledAttempted`, `transcriptLines`, `lastCaptionAt`, `lastCaptionSpeaker`, `lastCaptionText`, and a `recentTranscript` tail.

For the bounded session transcript, read the exact tracked Meet tab:

```bash
openclaw googlemeet transcript <session-id>
openclaw googlemeet transcript <session-id> --since <next-index> --json
```

The observer keeps at most 2,000 completed caption lines in the Meet page. Visible progressive text stays in the status health tail until the caption row completes, so saving `nextIndex` cannot skip a later text expansion; leaving finalizes visible rows before the snapshot. `droppedLines` reports lines lost from the head when the cap is exceeded. The four most recently ended session transcripts remain readable until the gateway restarts. Older ended transcripts return `evicted: true`. This is intentionally runtime memory, not durable meeting-history storage: restarting the gateway, closing the tab before a snapshot, or exceeding the documented caps can lose captions.

For a yes/no listen probe:

```bash
openclaw googlemeet test-listen <meet-url> --transport chrome-node
```

It joins in transcribe mode, waits for fresh caption/transcript movement, and returns `listenVerified`, `listenTimedOut`, manual-action fields, and current caption health.

### Realtime session health

During talk-back sessions, `google_meet` status reports Chrome/audio bridge health: `inCall`, `manualActionRequired`, `providerConnected`, `realtimeReady`, `audioInputActive`, `audioOutputActive`, last input/output timestamps, byte counters, and bridge-closed state. Managed Chrome sessions only speak the intro/test phrase after health reports `inCall: true`; otherwise `speechReady: false` and the speech attempt is blocked rather than silently no-opping.

Local Chrome joins through the signed-in OpenClaw browser profile and needs `BlackHole 2ch` for the mic/speaker path. A single BlackHole device is enough for a first smoke test but can echo; use separate virtual devices or a Loopback-style graph for clean duplex audio.

## Local Gateway + Parallels Chrome

A full Gateway or model API key is not required inside a macOS VM just to give it Chrome. Run the Gateway and agent locally; run a node host in the VM.

| Runs where           | What                                                                                            |
| -------------------- | ----------------------------------------------------------------------------------------------- |
| Gateway host         | OpenClaw Gateway, agent workspace, model/API keys, realtime provider, Google Meet plugin config |
| Parallels macOS VM   | OpenClaw CLI/node host, Chrome, SoX, BlackHole 2ch, a Chrome profile signed in to Google        |
| Not needed in the VM | Gateway service, agent config, model provider setup                                             |

Install VM dependencies, reboot, verify:

```bash
brew install blackhole-2ch sox
sudo reboot
system_profiler SPAudioDataType | grep -i BlackHole
command -v sox
```

Enable the plugin in the VM and start the node host:

```bash
openclaw plugins enable google-meet
openclaw node run --host <gateway-host> --port 18789 --display-name parallels-macos
```

If `<gateway-host>` is a LAN IP without TLS, opt in for that trusted private network:

```bash
OPENCLAW_ALLOW_INSECURE_PRIVATE_WS=1 \
  openclaw node run --host <gateway-lan-ip> --port 18789 --display-name parallels-macos
```

Use the same flag when installing as a LaunchAgent (it is process environment, stored in the LaunchAgent environment when present on the install command, not an `openclaw.json` setting):

```bash
OPENCLAW_ALLOW_INSECURE_PRIVATE_WS=1 \
  openclaw node install --host <gateway-lan-ip> --port 18789 --display-name parallels-macos --force
openclaw node restart
```

Approve the node from the Gateway host, then confirm it advertises both `googlemeet.chrome` and browser capability/`browser.proxy`:

```bash
openclaw devices list
openclaw devices approve <requestId>
openclaw nodes status
```

Route Meet through that node:

```json5
{
  gateway: {
    nodes: {
      allowCommands: ["googlemeet.chrome", "browser.proxy"],
    },
  },
  plugins: {
    entries: {
      "google-meet": {
        enabled: true,
        config: {
          defaultTransport: "chrome-node",
          chrome: {
            guestName: "OpenClaw Agent",
            autoJoin: true,
            reuseExistingTab: true,
          },
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

For a one-command smoke test that creates or reuses a session, speaks a known phrase, and prints session health:

```bash
openclaw googlemeet test-speech https://meet.google.com/abc-defg-hij
```

During realtime join, browser automation fills the guest name, clicks Join/Ask to join, and accepts Meet's first-run "Use microphone" prompt when it appears (or "Continue without microphone" during observe-only join and browser-only meeting creation). If the profile is signed out, Meet is waiting for host admission, Chrome needs mic/camera permission, or Meet is stuck on an unresolved prompt, the result reports `manualActionRequired: true` with `manualActionReason` and `manualActionMessage`. Stop retrying, report that message plus `browserUrl`/`browserTitle`, and retry only after the manual action completes.

If `chromeNode.node` is omitted, OpenClaw auto-selects only when exactly one connected node advertises both `googlemeet.chrome` and browser control; pin `chromeNode.node` (node id, display name, or remote IP) when several capable nodes are connected.

### Common failure checks

| Symptom                                                  | Fix                                                                                                                                                                                                                                                                 |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Configured Google Meet node ... is not usable: offline` | The pinned node is known but unavailable. Report the setup blocker; do not silently fall back to another transport unless asked.                                                                                                                                    |
| `No connected Google Meet-capable node`                  | Run `openclaw node run` in the VM, approve pairing, and run `openclaw plugins enable google-meet` and `openclaw plugins enable browser` there. Confirm `gateway.nodes.allowCommands` includes `googlemeet.chrome` and `browser.proxy`.                              |
| `BlackHole 2ch audio device not found`                   | Install `blackhole-2ch` on the host being checked and reboot.                                                                                                                                                                                                       |
| `BlackHole 2ch audio device not found on the node`       | Install `blackhole-2ch` in the VM and reboot the VM.                                                                                                                                                                                                                |
| Chrome opens but cannot join                             | Sign in to the browser profile in the VM, or keep `chrome.guestName` set. Guest auto-join uses OpenClaw browser automation through the node browser proxy; point the node's `browser.defaultProfile` (or a named existing-session profile) at the profile you want. |
| Duplicate Meet tabs                                      | Leave `chrome.reuseExistingTab: true`. OpenClaw activates an existing tab for the same URL, and creation reuses an in-progress `.../new` or Google account prompt tab, before opening another.                                                                      |
| No audio                                                 | Route Meet mic/speaker through the virtual audio path used by OpenClaw; use separate virtual devices or Loopback-style routing for clean duplex audio.                                                                                                              |

## Install notes

The Chrome talk-back default uses two external tools that OpenClaw does not bundle or redistribute; install them as host dependencies through Homebrew:

- `sox`: command-line audio utility. The plugin issues explicit CoreAudio device commands for the default 24 kHz PCM16 audio bridge.
- `blackhole-2ch`: macOS virtual audio driver providing the `BlackHole 2ch` device Chrome/Meet route through.

SoX is licensed `LGPL-2.0-only AND GPL-2.0-only`; BlackHole is GPL-3.0. If you build an installer or appliance that bundles BlackHole with OpenClaw, review BlackHole's upstream licensing or get a separate license from Existential Audio.

## Transports

| Transport     | Use when                                                                                     |
| ------------- | -------------------------------------------------------------------------------------------- |
| `chrome`      | Chrome/audio live on the Gateway host                                                        |
| `chrome-node` | Chrome/audio live on a paired node (for example a Parallels macOS VM)                        |
| `twilio`      | Phone dial-in fallback via the Voice Call plugin, when Chrome participation is not available |

### Chrome

Opens the Meet URL through OpenClaw browser control and joins as the signed-in OpenClaw browser profile. On macOS, the plugin checks for `BlackHole 2ch` before launch and, if configured, runs an audio bridge health/startup command before opening Chrome. For local Chrome, pick the profile with `browser.defaultProfile`; `chrome.browserProfile` is passed to `chrome-node` hosts instead.

```bash
openclaw googlemeet join https://meet.google.com/abc-defg-hij --transport chrome
openclaw googlemeet join https://meet.google.com/abc-defg-hij --transport chrome-node
```

Chrome mic/speaker audio routes through the local OpenClaw audio bridge. If `BlackHole 2ch` is not installed, the join fails with a setup error instead of joining without an audio path.

### Twilio

A strict dial plan delegated to the [Voice call plugin](/plugins/voice-call). It does not parse Meet pages for phone numbers; Google Meet must expose a phone dial-in number and PIN for the meeting.

Enable Voice Call on the Gateway host, not the Chrome node:

```json5
{
  plugins: {
    allow: ["google-meet", "voice-call", "google"],
    entries: {
      "google-meet": {
        enabled: true,
        config: {
          defaultTransport: "chrome-node",
          // or set "twilio" if Twilio should be the default
        },
      },
      "voice-call": {
        enabled: true,
        config: {
          provider: "twilio",
          inboundPolicy: "allowlist",
          realtime: {
            enabled: true,
            provider: "google",
            instructions: "Join this Google Meet as an OpenClaw agent. Be brief.",
            toolPolicy: "safe-read-only",
            providers: {
              google: {
                silenceDurationMs: 500,
                startSensitivity: "high",
              },
            },
          },
        },
      },
      google: {
        enabled: true,
      },
    },
  },
}
```

Provide Twilio credentials through environment to keep secrets out of `openclaw.json`:

```bash
export TWILIO_ACCOUNT_SID=AC...
export TWILIO_AUTH_TOKEN=...
export TWILIO_FROM_NUMBER=+15550001234
export GEMINI_API_KEY=...
```

Use `realtime.provider: "openai"` with `OPENAI_API_KEY` instead if OpenAI is the realtime voice provider.

Restart or reload the Gateway after enabling `voice-call`; plugin config changes do not take effect until reload. Verify:

```bash
openclaw config validate
openclaw plugins list | grep -E 'google-meet|voice-call'
openclaw googlemeet setup
```

When Twilio delegation is wired, `googlemeet setup` includes `twilio-voice-call-plugin`, `twilio-voice-call-credentials`, and `twilio-voice-call-webhook` checks.

```bash
openclaw googlemeet join https://meet.google.com/abc-defg-hij \
  --transport twilio \
  --dial-in-number +15551234567 \
  --pin 123456
```

Use `--dtmf-sequence` for a custom sequence, with leading `w` or commas for a pause before the PIN:

```bash
openclaw googlemeet join https://meet.google.com/abc-defg-hij \
  --transport twilio \
  --dial-in-number +15551234567 \
  --dtmf-sequence ww123456#
```

## OAuth and preflight

OAuth is optional for creating a Meet link, because `googlemeet create` can fall back to browser automation. Configure OAuth for official API create, space resolution, or Meet Media API preflight. Chrome/Chrome-node joins never depend on OAuth; they use a signed-in Chrome profile, BlackHole/SoX, and (for `chrome-node`) a connected node either way.

### Create Google credentials

In Google Cloud Console:

<Steps>
<Step title="Create or select a project">
</Step>
<Step title="Enable the Google Meet REST API">
</Step>
<Step title="Configure the OAuth consent screen">
Internal is simplest for a Google Workspace organization. External works for personal/test setups; while the app is in Testing, add each Google account that will authorize it as a test user.
</Step>
<Step title="Add the requested scopes">
- `https://www.googleapis.com/auth/meetings.space.created`
- `https://www.googleapis.com/auth/meetings.space.readonly`
- `https://www.googleapis.com/auth/meetings.space.settings`
- `https://www.googleapis.com/auth/meetings.conference.media.readonly`
- `https://www.googleapis.com/auth/calendar.events.readonly` (Calendar lookup)
- `https://www.googleapis.com/auth/drive.meet.readonly` (transcript/smart-note document body export)

</Step>
<Step title="Create an OAuth client ID">
Application type **Web application**. Authorized redirect URI:

```text
http://localhost:8085/oauth2callback
```

</Step>
<Step title="Copy the client ID and client secret">
</Step>
</Steps>

`meetings.space.created` is required by `spaces.create`. `meetings.space.readonly` resolves Meet URLs/codes to spaces. `meetings.space.settings` lets OpenClaw pass `SpaceConfig` settings such as `accessType` during API room creation. `meetings.conference.media.readonly` is for Meet Media API preflight and media work; Google may require Developer Preview enrollment for actual Media API use. `calendar.events.readonly` is only needed for `--today`/`--event` calendar lookup. `drive.meet.readonly` is only needed for `--include-doc-bodies` export. If you only need browser-based Chrome joins, skip OAuth entirely.

### Mint the refresh token

Configure `oauth.clientId` and optionally `oauth.clientSecret` (or pass them as environment variables), then run:

```bash
openclaw googlemeet auth login --json
```

This runs a PKCE flow with a localhost callback on `http://localhost:8085/oauth2callback`, and prints an `oauth` config block with a refresh token. Add `--manual` for a copy/paste flow when the browser cannot reach the local callback:

```bash
OPENCLAW_GOOGLE_MEET_CLIENT_ID="your-client-id" \
OPENCLAW_GOOGLE_MEET_CLIENT_SECRET="your-client-secret" \
openclaw googlemeet auth login --json --manual
```

JSON output:

```json
{
  "oauth": {
    "clientId": "your-client-id",
    "clientSecret": "your-client-secret",
    "refreshToken": "refresh-token",
    "accessToken": "access-token",
    "expiresAt": 1770000000000
  },
  "scope": "..."
}
```

Store the `oauth` object under the plugin config:

```json5
{
  plugins: {
    entries: {
      "google-meet": {
        enabled: true,
        config: {
          oauth: {
            clientId: "your-client-id",
            clientSecret: "your-client-secret",
            refreshToken: "refresh-token",
          },
        },
      },
    },
  },
}
```

Prefer environment variables when you do not want the refresh token in config; config is resolved first, then environment as fallback. If you authenticated before meeting creation, calendar lookup, or document-body export support existed, rerun `openclaw googlemeet auth login --json` so the refresh token covers the current scope set.

### Verify OAuth with doctor

```bash
openclaw googlemeet doctor --oauth --json
```

This checks OAuth config exists and the refresh token can mint an access token, without loading the Chrome runtime or requiring a connected node. The report includes only status fields (`ok`, `configured`, `tokenSource`, `expiresAt`, check messages) and never prints the access token, refresh token, or client secret.

| Check                | Meaning                                                                          |
| -------------------- | -------------------------------------------------------------------------------- |
| `oauth-config`       | `oauth.clientId` plus `oauth.refreshToken`, or a cached access token, is present |
| `oauth-token`        | The cached access token is still valid, or the refresh token minted a new one    |
| `meet-spaces-get`    | Optional `--meeting` check resolved an existing Meet space                       |
| `meet-spaces-create` | Optional `--create-space` check created a new Meet space                         |

Prove Meet API enablement and `spaces.create` scope with the side-effecting create check:

```bash
openclaw googlemeet doctor --oauth --create-space --json
```

Prove read access to an existing space:

```bash
openclaw googlemeet doctor --oauth --meeting https://meet.google.com/abc-defg-hij --json
openclaw googlemeet resolve-space --meeting https://meet.google.com/abc-defg-hij
```

A `403` from these checks usually means the Meet REST API is disabled, the refresh token is missing the required scope, or the Google account cannot access that space. A refresh-token error means rerun `openclaw googlemeet auth login --json` and store the new `oauth` block.

No OAuth is needed for the browser fallback; Google auth there comes from the signed-in Chrome profile on the selected node, not OpenClaw config.

These environment variables are accepted as fallbacks:

- `OPENCLAW_GOOGLE_MEET_CLIENT_ID` or `GOOGLE_MEET_CLIENT_ID`
- `OPENCLAW_GOOGLE_MEET_CLIENT_SECRET` or `GOOGLE_MEET_CLIENT_SECRET`
- `OPENCLAW_GOOGLE_MEET_REFRESH_TOKEN` or `GOOGLE_MEET_REFRESH_TOKEN`
- `OPENCLAW_GOOGLE_MEET_ACCESS_TOKEN` or `GOOGLE_MEET_ACCESS_TOKEN`
- `OPENCLAW_GOOGLE_MEET_ACCESS_TOKEN_EXPIRES_AT` or `GOOGLE_MEET_ACCESS_TOKEN_EXPIRES_AT`
- `OPENCLAW_GOOGLE_MEET_DEFAULT_MEETING` or `GOOGLE_MEET_DEFAULT_MEETING`
- `OPENCLAW_GOOGLE_MEET_PREVIEW_ACK` or `GOOGLE_MEET_PREVIEW_ACK`

### Resolve, preflight, and read artifacts

```bash
openclaw googlemeet resolve-space --meeting https://meet.google.com/abc-defg-hij
openclaw googlemeet preflight --meeting https://meet.google.com/abc-defg-hij
```

After Meet has created conference records:

```bash
openclaw googlemeet artifacts --meeting https://meet.google.com/abc-defg-hij
openclaw googlemeet attendance --meeting https://meet.google.com/abc-defg-hij
openclaw googlemeet export --meeting https://meet.google.com/abc-defg-hij --output ./meet-export
```

With `--meeting`, `artifacts` and `attendance` use the latest conference record by default; pass `--all-conference-records` for every retained record.

Calendar lookup resolves the meeting URL from Google Calendar before reading artifacts (requires a refresh token that includes the Calendar events readonly scope):

```bash
openclaw googlemeet latest --today
openclaw googlemeet calendar-events --today --json
openclaw googlemeet artifacts --event "Weekly sync"
openclaw googlemeet attendance --today --format csv --output attendance.csv
```

`--today` searches today's `primary` calendar for an event with a Meet link; `--event <query>` searches matching event text; `--calendar <id>` targets a non-primary calendar. `calendar-events` previews matching events and marks which one `latest`/`artifacts`/`attendance`/`export` will choose.

If you already know the conference record id, address it directly:

```bash
openclaw googlemeet latest --meeting https://meet.google.com/abc-defg-hij
openclaw googlemeet artifacts --conference-record conferenceRecords/abc123 --json
openclaw googlemeet attendance --conference-record conferenceRecords/abc123 --json
```

Close the room for an API-created space:

```bash
openclaw googlemeet end-active-conference https://meet.google.com/abc-defg-hij
```

Calls `spaces.endActiveConference` and requires OAuth with the `meetings.space.created` scope for a space the authorized account can manage. Accepts a Meet URL, meeting code, or `spaces/{id}` and resolves it to the API space resource first. This is separate from `googlemeet leave`: `leave` stops OpenClaw's local/session participation; `end-active-conference` asks Google Meet to end the active conference for the space.

Write a readable report:

```bash
openclaw googlemeet artifacts --conference-record conferenceRecords/abc123 \
  --format markdown --output meet-artifacts.md
openclaw googlemeet attendance --conference-record conferenceRecords/abc123 \
  --format csv --output meet-attendance.csv
openclaw googlemeet export --conference-record conferenceRecords/abc123 \
  --include-doc-bodies --zip --output meet-export
openclaw googlemeet export --conference-record conferenceRecords/abc123 \
  --include-doc-bodies --dry-run
```

`artifacts` returns conference record metadata plus participant, recording, transcript, structured transcript-entry, and smart-note resource metadata when Google exposes it. `--no-transcript-entries` skips entry lookup for large meetings. `attendance` expands participants into participant-session rows with first/last seen times, total session duration, late/early-leave flags, and duplicate participant resources merged by signed-in user or display name; `--no-merge-duplicates` keeps raw resources separate, `--late-after-minutes`/`--early-before-minutes` tune the thresholds.

`export` writes a folder with `summary.md`, `attendance.csv`, `transcript.md`, `artifacts.json`, `attendance.json`, and `manifest.json`. `manifest.json` records the chosen input, export options, conference records, output files, counts, token source, any Calendar event used, and partial-retrieval warnings. `--zip` also writes a portable archive next to the folder. `--include-doc-bodies` exports linked transcript/smart-note Google Docs text through Drive `files.export` (requires the Drive Meet readonly scope); without it, exports include Meet metadata and structured transcript entries only. A partial artifact failure (smart-note listing, transcript-entry, or document-body error) keeps the warning in the summary/manifest instead of failing the whole export. `--dry-run` fetches the same data and prints the manifest JSON without creating the folder or ZIP.

Agents use the same actions through the `google_meet` tool (`export`, `create` with `accessType`, `end_active_conference`, `test_listen`); see [Tool](#tool).

### Live smoke test

```bash
OPENCLAW_LIVE_TEST=1 \
OPENCLAW_GOOGLE_MEET_LIVE_MEETING=https://meet.google.com/abc-defg-hij \
pnpm test:live -- extensions/google-meet/google-meet.live.test.ts
```

```bash
openclaw googlemeet setup --transport chrome-node --mode transcribe
openclaw googlemeet test-listen https://meet.google.com/abc-defg-hij --transport chrome-node --timeout-ms 30000
```

| Variable                                                                                                                  | Purpose                                                                |
| ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `OPENCLAW_LIVE_TEST=1`                                                                                                    | Enables guarded live tests                                             |
| `OPENCLAW_GOOGLE_MEET_LIVE_MEETING`                                                                                       | Retained Meet URL, code, or `spaces/{id}`                              |
| `OPENCLAW_GOOGLE_MEET_CLIENT_ID` / `GOOGLE_MEET_CLIENT_ID`                                                                | OAuth client id                                                        |
| `OPENCLAW_GOOGLE_MEET_REFRESH_TOKEN` / `GOOGLE_MEET_REFRESH_TOKEN`                                                        | Refresh token                                                          |
| `OPENCLAW_GOOGLE_MEET_CLIENT_SECRET`, `OPENCLAW_GOOGLE_MEET_ACCESS_TOKEN`, `OPENCLAW_GOOGLE_MEET_ACCESS_TOKEN_EXPIRES_AT` | Optional; same fallback names without the `OPENCLAW_` prefix also work |

The base artifact/attendance smoke needs `meetings.space.readonly` and `meetings.conference.media.readonly`. Calendar lookup needs `calendar.events.readonly`. Drive document-body export needs `drive.meet.readonly`.

### Create examples

```bash
openclaw googlemeet create
```

Prints the new meeting URI, source, and join session. With OAuth it uses the Meet API; without it, the pinned Chrome node's signed-in profile. Browser fallback JSON:

```json
{
  "source": "browser",
  "meetingUri": "https://meet.google.com/abc-defg-hij",
  "joined": true,
  "browser": {
    "nodeId": "ba0f4e4bc...",
    "targetId": "tab-1"
  },
  "join": {
    "session": {
      "id": "meet_...",
      "url": "https://meet.google.com/abc-defg-hij"
    }
  }
}
```

If the browser fallback hits Google login or a Meet permission blocker first, `google_meet` returns structured details instead of a plain string:

```json
{
  "source": "browser",
  "error": "google-login-required: Sign in to Google in the OpenClaw browser profile, then retry meeting creation.",
  "manualActionRequired": true,
  "manualActionReason": "google-login-required",
  "manualActionMessage": "Sign in to Google in the OpenClaw browser profile, then retry meeting creation.",
  "browser": {
    "nodeId": "ba0f4e4bc...",
    "targetId": "tab-1",
    "browserUrl": "https://accounts.google.com/signin",
    "browserTitle": "Sign in - Google Accounts"
  }
}
```

API create JSON:

```json
{
  "source": "api",
  "meetingUri": "https://meet.google.com/abc-defg-hij",
  "joined": true,
  "space": {
    "name": "spaces/abc-defg-hij",
    "meetingCode": "abc-defg-hij",
    "meetingUri": "https://meet.google.com/abc-defg-hij"
  },
  "join": {
    "session": {
      "id": "meet_...",
      "url": "https://meet.google.com/abc-defg-hij"
    }
  }
}
```

Creating joins by default, but Chrome/Chrome-node still needs a signed-in Google profile to join through the browser; if signed out, OpenClaw reports `manualActionRequired: true` or a browser fallback error and asks the operator to finish Google login before retrying.

Set `preview.enrollmentAcknowledged: true` only after confirming your Cloud project, OAuth principal, and meeting participants are enrolled in the Google Workspace Developer Preview Program for Meet media APIs.

## Config

The common Chrome agent path only needs the plugin enabled, BlackHole, SoX, a realtime provider key, and a configured OpenClaw TTS provider:

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

### Defaults

| Key                               | Default                                  | Notes                                                                                                                                                                                                             |
| --------------------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `defaultTransport`                | `"chrome"`                               |                                                                                                                                                                                                                   |
| `defaultMode`                     | `"agent"`                                | `"realtime"` is accepted as a legacy alias for `"agent"`; new callers should say `"agent"`                                                                                                                        |
| `chromeNode.node`                 | unset                                    | Node id/name/IP for `chrome-node`; required when more than one capable node may be connected                                                                                                                      |
| `chrome.launch`                   | `true`                                   | Launch Chrome for the join; set `false` only when reusing an already-open session                                                                                                                                 |
| `chrome.audioBackend`             | `"blackhole-2ch"`                        |                                                                                                                                                                                                                   |
| `chrome.guestName`                | `"OpenClaw Agent"`                       | Shown on the signed-out Meet guest screen                                                                                                                                                                         |
| `chrome.autoJoin`                 | `true`                                   | Best-effort guest-name fill and Join Now click on `chrome-node`                                                                                                                                                   |
| `chrome.reuseExistingTab`         | `true`                                   | Activates an existing Meet tab instead of opening duplicates                                                                                                                                                      |
| `chrome.waitForInCallMs`          | `20000`                                  | Wait for the Meet tab to report in-call before the talk-back intro fires                                                                                                                                          |
| `chrome.audioFormat`              | `"pcm16-24khz"`                          | Command-pair audio format; `"g711-ulaw-8khz"` is only for legacy/custom command pairs that emit telephony audio                                                                                                   |
| `chrome.audioBufferBytes`         | `4096`                                   | SoX processing buffer for generated command-pair audio commands (half SoX's default 8192-byte buffer, lowering pipe latency); values are clamped to a minimum of 17 bytes                                         |
| `chrome.audioInputCommand`        | generated SoX command                    | Reads from CoreAudio `BlackHole 2ch`, writes audio in `chrome.audioFormat`                                                                                                                                        |
| `chrome.audioOutputCommand`       | generated SoX command                    | Reads audio in `chrome.audioFormat`, writes to CoreAudio `BlackHole 2ch`                                                                                                                                          |
| `chrome.bargeInInputCommand`      | unset                                    | Optional local microphone command writing signed 16-bit little-endian mono PCM for human barge-in detection during assistant playback; applies to the Gateway-hosted command-pair bridge                          |
| `chrome.bargeInRmsThreshold`      | `650`                                    | RMS level counted as human interruption                                                                                                                                                                           |
| `chrome.bargeInPeakThreshold`     | `2500`                                   | Peak level counted as human interruption                                                                                                                                                                          |
| `chrome.bargeInCooldownMs`        | `900`                                    | Minimum delay between repeated interruption clears                                                                                                                                                                |
| `mode` (per-request)              | `"agent"`                                | Talk-back mode; see the [Agent and bidi modes](#agent-and-bidi-modes) table                                                                                                                                       |
| `realtime.provider`               | `"openai"`                               | Compatibility fallback used when the scoped fields below are unset                                                                                                                                                |
| `realtime.transcriptionProvider`  | `"openai"`                               | Provider id used by `agent` mode for realtime transcription                                                                                                                                                       |
| `realtime.voiceProvider`          | unset                                    | Provider id used by `bidi` mode for direct realtime voice; set to `"google"` for Gemini Live while keeping agent-mode transcription on OpenAI. Pair with `realtime.model` to pick the specific Gemini Live model. |
| `realtime.toolPolicy`             | `"safe-read-only"`                       | See [Agent and bidi modes](#agent-and-bidi-modes)                                                                                                                                                                 |
| `realtime.instructions`           | brief spoken-reply instructions          | Tells the model to speak briefly and use `openclaw_agent_consult` for deeper answers                                                                                                                              |
| `realtime.introMessage`           | `"Say exactly: I'm here and listening."` | Spoken once when the realtime bridge connects; set to `""` to join silently                                                                                                                                       |
| `realtime.agentId`                | `"main"`                                 | OpenClaw agent id used for `openclaw_agent_consult`                                                                                                                                                               |
| `voiceCall.enabled`               | `true`                                   | Delegates the Twilio PSTN call, DTMF, and intro greeting to the Voice Call plugin                                                                                                                                 |
| `voiceCall.dtmfDelayMs`           | `12000`                                  | Leading wait before playing a PIN-derived DTMF sequence over Twilio                                                                                                                                               |
| `voiceCall.postDtmfSpeechDelayMs` | `5000`                                   | Delay before requesting the realtime intro greeting after Voice Call starts the Twilio leg                                                                                                                        |

`chrome.audioBridgeCommand` and `chrome.audioBridgeHealthCommand` let an external bridge own the whole local audio path instead of `chrome.audioInputCommand`/`chrome.audioOutputCommand`; see [Notes](#notes) for the constraint on which mode can use them.

An `openclaw doctor --fix` migration exists for the legacy `realtime.provider: "google"` shape: it moves that intent to `realtime.voiceProvider: "google"` plus `realtime.transcriptionProvider: "openai"` when those fields are not already set.

### Optional overrides

```json5
{
  defaults: {
    meeting: "https://meet.google.com/abc-defg-hij",
  },
  browser: {
    defaultProfile: "openclaw",
  },
  chrome: {
    guestName: "OpenClaw Agent",
    waitForInCallMs: 30000,
    bargeInInputCommand: [
      "sox",
      "-q",
      "-t",
      "coreaudio",
      "External Microphone",
      "-r",
      "24000",
      "-c",
      "1",
      "-b",
      "16",
      "-e",
      "signed-integer",
      "-t",
      "raw",
      "-",
    ],
  },
  chromeNode: {
    node: "parallels-macos",
  },
  defaultMode: "agent",
  realtime: {
    provider: "openai",
    transcriptionProvider: "openai",
    voiceProvider: "google",
    model: "gemini-3.1-flash-live-preview",
    agentId: "jay",
    toolPolicy: "owner",
    introMessage: "Say exactly: I'm here.",
    providers: {
      google: {
        speakerVoice: "Kore",
      },
    },
  },
}
```

ElevenLabs for both agent-mode listening and speaking:

```json5
{
  messages: {
    tts: {
      provider: "elevenlabs",
      providers: {
        elevenlabs: {
          modelId: "eleven_v3",
          speakerVoiceId: "pMsXgVXv3BLzUgSXRplE",
        },
      },
    },
  },
  plugins: {
    entries: {
      "google-meet": {
        config: {
          realtime: {
            transcriptionProvider: "elevenlabs",
            providers: {
              elevenlabs: {
                modelId: "scribe_v2_realtime",
                audioFormat: "ulaw_8000",
                sampleRate: 8000,
                commitStrategy: "vad",
              },
            },
          },
        },
      },
    },
  },
}
```

The persistent Meet voice comes from `messages.tts.providers.elevenlabs.speakerVoiceId`. Agent replies can also use per-reply `[[tts:speakerVoiceId=... model=eleven_v3]]` directives when TTS model overrides are enabled, but config is the deterministic default for meetings. On join, logs show `transcriptionProvider=elevenlabs`, and each spoken reply logs `provider=elevenlabs model=eleven_v3 speakerVoiceId=<voiceId>`.

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

With `voiceCall.enabled: true` (the default) and Twilio transport, Voice Call places the DTMF sequence before opening the realtime media stream, then uses the saved intro text as the initial realtime greeting. If `voice-call` is not enabled, Google Meet can still validate and record the dial plan but cannot place the Twilio call.

Leave `voiceCall.gatewayUrl` unset to use the local trusted Gateway runtime, which preserves the
invoking agent for the full call. A configured Gateway URL remains an explicit WebSocket target and
cannot authenticate plugin provenance; non-default agent joins fail closed instead of silently
using another agent. Run Google Meet and Voice Call in the same Gateway process when per-agent
routing is required.

## Tool

Agents use the `google_meet` tool:

```json
{
  "action": "join",
  "url": "https://meet.google.com/abc-defg-hij",
  "transport": "chrome-node",
  "mode": "agent"
}
```

| `action`                | Purpose                                                                                           |
| ----------------------- | ------------------------------------------------------------------------------------------------- |
| `join`                  | Join an explicit Meet URL                                                                         |
| `create`                | Create a space (and join by default); supports `accessType`/`entryPointAccess`                    |
| `status`                | List active sessions, or inspect one by `sessionId`                                               |
| `setup_status`          | Run the same checks as `googlemeet setup`                                                         |
| `resolve_space`         | Resolve a URL/code/`spaces/{id}` via `spaces.get`                                                 |
| `preflight`             | Validate OAuth + meeting resolution prerequisites                                                 |
| `latest`                | Find the latest conference record for a meeting                                                   |
| `calendar_events`       | Preview Calendar events with Meet links                                                           |
| `artifacts`             | List conference records and participant/recording/transcript/smart-note metadata                  |
| `attendance`            | List participants and participant sessions                                                        |
| `export`                | Write the artifacts/attendance/transcript/manifest bundle; set `"dryRun": true` for manifest-only |
| `recover_current_tab`   | Focus/inspect an existing Meet tab without opening a new one                                      |
| `transcript`            | Read the bounded caption transcript; `sinceIndex` resumes from the previous `nextIndex`           |
| `leave`                 | End a session (Chrome clicks Leave; closes only tabs it opened; Twilio hangs up)                  |
| `end_active_conference` | End the active Google Meet conference for an API-managed space                                    |
| `speak`                 | Make the realtime agent speak immediately, given `sessionId` and `message`                        |
| `test_speech`           | Create/reuse a session, trigger a known phrase, return Chrome health                              |
| `test_listen`           | Create/reuse an observe-only session, wait for caption/transcript movement                        |

`test_speech` always forces `mode: "agent"` or `"bidi"` and fails if asked to run in `mode: "transcribe"`, because observe-only sessions cannot emit speech. Its `speechOutputVerified` result is based on realtime audio output bytes increasing during that call, so a reused session with older audio does not count as a fresh check.

For Chrome transports, `leave` keeps a reused user-owned tab open after clicking Meet's Leave call button. Tabs opened by OpenClaw are closed after departure.

Use `transport: "chrome"` when Chrome runs on the Gateway host, `transport: "chrome-node"` when it runs on a paired node. In both cases the model providers and `openclaw_agent_consult` run on the Gateway host, so model credentials stay there. Agent-mode logs include the resolved transcription provider/model at bridge startup and the TTS provider/model/voice/output format/sample rate after each synthesized reply. Raw `mode: "realtime"` is still accepted as a legacy compatibility alias for `mode: "agent"`, but it is no longer advertised in the tool's `mode` enum.

`create` with an API-backed room and explicit access policy:

```json
{
  "action": "create",
  "transport": "chrome-node",
  "mode": "agent",
  "accessType": "OPEN"
}
```

Ending a known room's active conference:

```json
{
  "action": "end_active_conference",
  "meeting": "https://meet.google.com/abc-defg-hij"
}
```

Listen-first validation before claiming a meeting is useful:

```json
{
  "action": "test_listen",
  "url": "https://meet.google.com/abc-defg-hij",
  "transport": "chrome-node",
  "timeoutMs": 30000
}
```

Speaking on demand:

```json
{
  "action": "speak",
  "sessionId": "meet_...",
  "message": "Say exactly: I'm here and listening."
}
```

`status` includes Chrome health when available:

| Field                                                                 | Meaning                                                                                                                |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `inCall`                                                              | Chrome appears to be inside the Meet call                                                                              |
| `micMuted`                                                            | Best-effort Meet microphone state                                                                                      |
| `manualActionRequired` / `manualActionReason` / `manualActionMessage` | Browser profile needs manual login, Meet host admission, permissions, or browser-control repair before speech can work |
| `speechReady` / `speechBlockedReason` / `speechBlockedMessage`        | Whether managed Chrome speech is allowed now; `speechReady: false` means OpenClaw did not send the intro/test phrase   |
| `providerConnected` / `realtimeReady`                                 | Realtime voice bridge state                                                                                            |
| `lastInputAt` / `lastOutputAt`                                        | Last audio seen from/sent to the bridge                                                                                |
| `audioOutputRouted` / `audioOutputDeviceLabel`                        | Whether the Meet tab's media output was actively routed to the bridge's BlackHole device                               |
| `lastSuppressedInputAt` / `suppressedInputBytes`                      | Loopback input ignored while assistant playback is active                                                              |

## Agent and bidi modes

| Mode    | Who decides the answer        | Speech output path                     | Use when                                              |
| ------- | ----------------------------- | -------------------------------------- | ----------------------------------------------------- |
| `agent` | The configured OpenClaw agent | Normal OpenClaw TTS runtime            | You want "my agent is in the meeting" behavior        |
| `bidi`  | The realtime voice model      | Realtime voice provider audio response | You want the lowest-latency conversational voice loop |

`agent` mode: the realtime transcription provider hears meeting audio, final participant transcripts route through the configured OpenClaw agent, and the answer is spoken through regular OpenClaw TTS. Nearby final-transcript fragments are coalesced before the consult so one spoken turn does not produce several stale partial answers; realtime input is suppressed while queued assistant audio is still playing, and recent assistant-like transcript echoes are ignored before the consult so BlackHole loopback does not make the agent answer its own speech.

`bidi` mode: the realtime voice model answers directly and can call `openclaw_agent_consult` for deeper reasoning, current information, or normal OpenClaw tools. The consult tool runs the regular OpenClaw agent behind the scenes with recent meeting transcript context and returns a concise spoken answer; in `agent` mode OpenClaw sends that answer directly to TTS, in `bidi` mode the realtime voice model can speak it back. It uses the same shared consult machinery as Voice Call.

By default consults run against the `main` agent; set `realtime.agentId` to point a Meet lane at a dedicated agent workspace, model defaults, tool policy, memory, and session history. Agent-mode consults use a per-meeting `agent:<id>:subagent:google-meet:<session>` session key so follow-up questions keep meeting context while inheriting normal agent policy. When an agent calls `google_meet` in agent mode, the consultant session forks the caller's current transcript before answering participant speech; the Meet session stays separate so meeting follow-ups do not mutate the caller transcript directly.

`realtime.toolPolicy` controls the consult run:

| Policy           | Behavior                                                                                                                         |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `safe-read-only` | Expose the consult tool; limit the regular agent to `read`, `web_search`, `web_fetch`, `x_search`, `memory_search`, `memory_get` |
| `owner`          | Expose the consult tool; let the regular agent use its normal tool policy                                                        |
| `none`           | Do not expose the consult tool to the realtime voice model                                                                       |

The consult session key is scoped per Meet session, so follow-up consult calls reuse prior consult context during the same meeting.

Force a spoken readiness check after Chrome has fully joined:

```bash
openclaw googlemeet speak meet_... "Say exactly: I'm here and listening."
```

Full join-and-speak smoke:

```bash
openclaw googlemeet test-speech https://meet.google.com/abc-defg-hij \
  --transport chrome-node \
  --message "Say exactly: I'm here and listening."
```

## Live test checklist

Before handing a meeting to an unattended agent:

```bash
openclaw googlemeet setup
openclaw nodes status
openclaw googlemeet test-speech https://meet.google.com/abc-defg-hij \
  --transport chrome-node \
  --message "Say exactly: Google Meet speech test complete."
```

Expected Chrome-node state:

- `googlemeet setup` is all green, and includes `chrome-node-connected` when Chrome-node is the default transport or a node is pinned.
- `nodes status` shows the selected node connected, advertising both `googlemeet.chrome` and `browser.proxy`.
- The Meet tab joins, and `test-speech` returns Chrome health with `inCall: true`.

For a remote Chrome host such as a Parallels macOS VM, the shortest safe check after updating the Gateway or the VM:

```bash
openclaw googlemeet setup
openclaw nodes status --connected
openclaw nodes invoke \
  --node parallels-macos \
  --command googlemeet.chrome \
  --params '{"action":"setup"}'
```

That proves the Gateway plugin is loaded, the VM node is connected with the current token, and the Meet audio bridge is available before an agent opens a real meeting tab.

For a Twilio smoke, use a meeting that exposes phone dial-in details:

```bash
openclaw googlemeet setup
openclaw googlemeet join https://meet.google.com/abc-defg-hij \
  --transport twilio \
  --dial-in-number +15551234567 \
  --pin 123456
```

Expected Twilio state:

- `googlemeet setup` includes green `twilio-voice-call-plugin`, `twilio-voice-call-credentials`, and `twilio-voice-call-webhook` checks.
- `voicecall` is available in the CLI after Gateway reload.
- The returned session has `transport: "twilio"` and a `twilio.voiceCallId`.
- `openclaw logs --follow` shows DTMF TwiML served before realtime TwiML, then a realtime bridge with the initial greeting queued.
- `googlemeet leave <sessionId>` hangs up the delegated voice call.

## Troubleshooting

### Agent cannot see the Google Meet tool

Confirm the plugin is enabled and reload the Gateway; the running agent only sees plugin tools registered by the current Gateway process:

```bash
openclaw plugins list | grep google-meet
openclaw googlemeet setup
```

On non-macOS Gateway hosts, `google_meet` stays visible, but local Chrome talk-back actions are blocked before they hit the audio bridge. Use `mode: "transcribe"`, Twilio dial-in, or a macOS `chrome-node` host instead of the default local Chrome agent path.

### No connected Google Meet-capable node

On the node host:

```bash
openclaw plugins enable google-meet
openclaw plugins enable browser
OPENCLAW_ALLOW_INSECURE_PRIVATE_WS=1 \
  openclaw node run --host <gateway-lan-ip> --port 18789 --display-name parallels-macos
```

On the Gateway host:

```bash
openclaw devices list
openclaw devices approve <requestId>
openclaw nodes status
```

The node must be connected and list `googlemeet.chrome` plus `browser.proxy`; the Gateway config must allow both:

```json5
{
  gateway: {
    nodes: {
      allowCommands: ["browser.proxy", "googlemeet.chrome"],
    },
  },
}
```

If `googlemeet setup` fails `chrome-node-connected`, or the Gateway log reports `gateway token mismatch`, reinstall or restart the node with the current Gateway token:

```bash
OPENCLAW_ALLOW_INSECURE_PRIVATE_WS=1 \
  openclaw node install \
  --host <gateway-lan-ip> \
  --port 18789 \
  --display-name parallels-macos \
  --force
```

Then reload the node service and re-run:

```bash
openclaw googlemeet setup
openclaw nodes status --connected
```

### Browser opens but agent cannot join

Run `googlemeet test-listen` for observe-only joins or `googlemeet test-speech` for realtime joins, then inspect the returned Chrome health. If either reports `manualActionRequired: true`, show `manualActionMessage` to the operator and stop retrying until the browser action is complete.

Common manual actions: sign in to the Chrome profile; admit the guest from the Meet host account; grant Chrome microphone/camera permissions when the native prompt appears; close or repair a stuck Meet permission dialog.

Do not report "not signed in" just because Meet asks "Do you want people to hear you in the meeting?"; that is Meet's audio-choice interstitial. OpenClaw clicks **Use microphone** through browser automation when available and keeps waiting for the real meeting state; for create-only browser fallback it may click **Continue without microphone** instead, since minting the URL does not need the realtime audio path.

### Meeting creation fails

`googlemeet create` uses the Meet API `spaces.create` when OAuth is configured, otherwise the pinned Chrome node browser. Confirm:

- **API creation**: `oauth.clientId` and `oauth.refreshToken` (or matching `OPENCLAW_GOOGLE_MEET_*` env vars) are present, and the refresh token was minted after create support was added; older tokens may lack `meetings.space.created`, so rerun `openclaw googlemeet auth login --json`.
- **Browser fallback**: `defaultTransport: "chrome-node"` and `chromeNode.node` point at a connected node with `browser.proxy` and `googlemeet.chrome`; the OpenClaw Chrome profile on that node is signed in and can open `https://meet.google.com/new`.
- **Browser fallback retries**: reuse an existing `.../new` or Google account prompt tab before opening a new one; retry the tool call rather than manually opening another tab.
- **Manual action**: if the tool returns `manualActionRequired: true`, use `browser.nodeId`, `browser.targetId`, `browserUrl`, and `manualActionMessage` to guide the operator; do not retry in a loop.
- **Audio-choice interstitial**: if Meet shows "Do you want people to hear you in the meeting?", leave the tab open. OpenClaw should click **Use microphone** or (create-only) **Continue without microphone** and keep waiting for the generated URL; if it cannot, the error should mention `meet-audio-choice-required`, not `google-login-required`.

### Agent joins but does not talk

```bash
openclaw googlemeet setup
openclaw googlemeet doctor
```

Use `mode: "agent"` for the STT -> OpenClaw agent -> TTS path, `mode: "bidi"` for the direct realtime voice fallback. `mode: "transcribe"` intentionally starts no talk-back bridge. For observe-only debugging, run `openclaw googlemeet status --json <session-id>` after participants speak and check `captioning`, `transcriptLines`, `lastCaptionText`. If `inCall` is true but `transcriptLines` stays `0`, Meet captions may be disabled, no one has spoken since the observer was installed, the Meet UI changed, or live captions are unavailable for the meeting language/account.

`googlemeet test-speech` always checks the realtime path and reports whether bridge output bytes were observed for that invocation. If `speechOutputVerified` is false and `speechOutputTimedOut` is true, the realtime provider may have accepted the utterance but OpenClaw did not see new output bytes reach the Chrome audio bridge.

Also verify: a realtime provider key (`OPENAI_API_KEY` or `GEMINI_API_KEY`) is available on the Gateway host; `BlackHole 2ch` is visible on the Chrome host; `sox` exists there; Meet mic/speaker are routed through the virtual audio path (`doctor` should show `meet output routed: yes` for local Chrome realtime joins).

`googlemeet doctor [session-id]` prints session, node, in-call state, manual action reason, realtime provider connection, `realtimeReady`, audio input/output activity, last audio timestamps, byte counters, and browser URL. Use `googlemeet status [session-id] --json` for raw JSON, and `googlemeet doctor --oauth` (add `--meeting` or `--create-space`) to verify OAuth refresh without exposing tokens.

If an agent timed out and a Meet tab is already open, inspect it without opening another one:

```bash
openclaw googlemeet recover-tab
openclaw googlemeet recover-tab https://meet.google.com/abc-defg-hij
```

The equivalent tool action is `recover_current_tab`: it focuses and inspects an existing Meet tab for the selected transport (local browser control for `chrome`, the configured node for `chrome-node`) without opening a new tab or session, and reports the current blocker (login, admission, permissions, audio-choice state). The CLI command talks to the configured Gateway, which must be running; `chrome-node` also requires the node to be connected.

### Twilio setup checks fail

`twilio-voice-call-plugin` fails when `voice-call` is not allowed or not enabled: add it to `plugins.allow`, enable `plugins.entries.voice-call`, reload the Gateway.

`twilio-voice-call-credentials` fails when the Twilio backend is missing account SID, auth token, or caller number:

```bash
export TWILIO_ACCOUNT_SID=AC...
export TWILIO_AUTH_TOKEN=...
export TWILIO_FROM_NUMBER=+15550001234
```

`twilio-voice-call-webhook` fails when `voice-call` has no public webhook exposure, or `publicUrl` points at loopback/private network space. Do not use `localhost`, `127.0.0.1`, `0.0.0.0`, `10.x`, `172.16.x`-`172.31.x`, `192.168.x`, `169.254.x`, `fc00::/7`, or `fd00::/8` as `publicUrl`; carrier callbacks cannot reach those. Set `plugins.entries.voice-call.config.publicUrl` to a public URL, or configure a tunnel/Tailscale exposure:

```json5
{
  plugins: {
    entries: {
      "voice-call": {
        enabled: true,
        config: {
          provider: "twilio",
          fromNumber: "+15550001234",
          publicUrl: "https://voice.example.com/voice/webhook",
        },
      },
    },
  },
}
```

For local development, use a tunnel or Tailscale exposure instead of a private host URL:

```json5
{
  plugins: {
    entries: {
      "voice-call": {
        config: {
          tunnel: { provider: "ngrok" },
          // or
          tailscale: { mode: "funnel", path: "/voice/webhook" },
        },
      },
    },
  },
}
```

Restart or reload the Gateway, then:

```bash
openclaw googlemeet setup --transport twilio
openclaw voicecall setup
openclaw voicecall smoke
```

`voicecall smoke` is readiness-only by default. Dry-run a specific number:

```bash
openclaw voicecall smoke --to "+15555550123"
```

Only add `--yes` to intentionally place a live outbound call:

```bash
openclaw voicecall smoke --to "+15555550123" --yes
```

### Twilio call starts but never enters the meeting

Confirm the Meet event exposes phone dial-in details, and pass the exact dial-in number plus PIN or a custom DTMF sequence:

```bash
openclaw googlemeet join https://meet.google.com/abc-defg-hij \
  --transport twilio \
  --dial-in-number +15551234567 \
  --dtmf-sequence ww123456#
```

Use leading `w` or commas in `--dtmf-sequence` for a pause before the PIN.

If the call is created but the Meet roster never shows the dial-in participant:

- `openclaw googlemeet doctor <session-id>`: confirm the delegated Twilio call ID, whether DTMF was queued, and whether the intro greeting was requested.
- `openclaw voicecall status --call-id <id>`: confirm the call is still active.
- `openclaw voicecall tail`: confirm Twilio webhooks are arriving at the Gateway.
- `openclaw logs --follow`: look for the Twilio Meet sequence: Google Meet delegates the join, Voice Call stores and serves pre-connect DTMF TwiML, Voice Call serves realtime TwiML for the Twilio call, then Google Meet requests intro speech with `voicecall.speak`.
- Re-run `openclaw googlemeet setup --transport twilio`; a green setup check is required but does not prove the meeting PIN sequence is correct.
- Confirm the dial-in number belongs to the same Meet invitation and region as the PIN.
- Increase `voiceCall.dtmfDelayMs` from the 12-second default if Meet answers slowly or the call transcript still shows the PIN prompt after pre-connect DTMF was sent.
- If the participant joins but you do not hear the greeting, check `openclaw logs --follow` for the post-DTMF `voicecall.speak` request and either media-stream TTS playback or the Twilio `<Say>` fallback. If the transcript still shows "enter the meeting PIN", the phone leg has not joined the Meet room yet, so participants will not hear speech.

If webhooks do not arrive, debug the Voice Call plugin first: the provider must reach `plugins.entries.voice-call.config.publicUrl` or the configured tunnel. See [Voice call troubleshooting](/plugins/voice-call#troubleshooting).

## Notes

Google Meet's official media API is receive-oriented, so speaking into a call still needs a participant path. This plugin keeps that boundary visible: Chrome handles browser participation and local audio routing; Twilio handles phone dial-in participation.

Chrome talk-back modes need `BlackHole 2ch` plus either:

- `chrome.audioInputCommand` plus `chrome.audioOutputCommand`: OpenClaw owns the bridge and pipes audio in `chrome.audioFormat` between those commands and the selected provider. `agent` mode uses realtime transcription plus regular TTS; `bidi` mode uses the realtime voice provider. The default path is 24 kHz PCM16 with `chrome.audioBufferBytes: 4096`; 8 kHz G.711 mu-law remains available for legacy command pairs.
- `chrome.audioBridgeCommand`: an external bridge command owns the whole local audio path and must exit after starting or validating its daemon. Valid only for `bidi`, because `agent` mode needs direct command-pair access for TTS.

With the command-pair Chrome bridge, `chrome.bargeInInputCommand` can listen to a separate local microphone and clear assistant playback when a human starts talking, keeping human speech ahead of assistant output even while the shared BlackHole loopback input is temporarily suppressed during assistant playback. Like `chrome.audioInputCommand`/`chrome.audioOutputCommand`, it is an operator-configured local command: use an explicit trusted command path or argument list, never a script from an untrusted location.

For clean duplex audio, route Meet output and Meet microphone through separate virtual devices or a Loopback-style virtual device graph; a single shared BlackHole device can echo other participants back into the call.

`googlemeet speak` triggers the active talk-back audio bridge for a Chrome session; `googlemeet leave` stops it (and, for Twilio sessions delegated through Voice Call, hangs up the underlying call). Use `googlemeet end-active-conference` to also close the active Google Meet conference for an API-managed space.

## Related

- [Voice call plugin](/plugins/voice-call)
- [Talk mode](/nodes/talk)
- [Building plugins](/plugins/building-plugins)
