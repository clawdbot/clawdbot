---
summary: "Chrome extension: securely automate signed-in tabs with automatic local pairing"
read_when:
  - You want an agent to drive your signed-in Chrome without remote-debugging prompts
  - You are installing, pairing, disabling, or troubleshooting the OpenClaw Chrome extension
  - You need the Chrome native bootstrap security and platform support model
title: "Chrome Extension"
---

# Chrome extension

The OpenClaw Chrome extension lets the browser tool automate eligible tabs in
your signed-in Chrome profile. It uses `chrome.debugger`, so it does not require
Chrome's blocking remote-debugging consent prompt.

The extension is browser automation infrastructure. It does not include chat,
page sharing, a prompt box, or a tab copilot. Its popup shows connection state,
the current access mode, a Pause/Allow action for the current eligible tab, and
a Settings link.

## Requirements

- Google Chrome, Chrome for Testing, or Chromium
- OpenClaw installed on the same machine as Chrome, or an OpenClaw browser node
  on that machine
- macOS or Linux for automatic native bootstrap
- Chrome launched at least once so its user-data directory exists

Windows keeps manual pairing. Current Chromium launches native hosts directly
only when the registered host is a Windows executable; OpenClaw does not install
a script launcher or registry key without a proven binary framing path.

## Install

Launch Chrome, then pre-register the native host before adding the extension:

```bash
openclaw browser extension install
```

Keep the command running. It pre-registers an origin-locked native host for the
exact official Chrome Web Store identity and for OpenClaw's deterministic
development IDs. After pre-registration succeeds, add
[OpenClaw from the Chrome Web Store](https://chromewebstore.google.com/detail/openclaw/kcdjddhmeafeomebliikmbpblkmkfoig).

The extension pairs on its first native call; you do not need to open its
popup, reload it, or restart Chrome during a normal first-time setup. The
installer then reads the profile's `Secure Preferences` and verifies the exact
Store ID independently from any extension path.

For extension development, the command also copies the bundled extension to a
stable OpenClaw-owned directory. Use that unpacked copy only as a development
fallback:

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select the path printed by the command.

Leave the install command running while completing either Store or development
setup. For unpacked development, the installer verifies that Chrome loaded the
approved realpath under its predicted deterministic ID.

The installer recognizes the official Store installation only by the exact
Foundation Store ID. That identity never makes a recorded path OpenClaw-owned.
For unpacked development, it accepts an ID only when all of these are true:

- the ID matches Chrome's 32-character extension ID format;
- Chrome records the install location as unpacked;
- the recorded extension path resolves exactly to the installed or bundled
  OpenClaw extension directory;
- the recorded ID equals Chromium's deterministic path ID for that exact
  canonical realpath.

The extension name is not trusted. Existing native-host files with the same
host name are not overwritten unless they are verifiably OpenClaw-owned.

Use a different bounded wait when needed:

```bash
openclaw browser extension install --wait-ms 60000
```

For automation, use `--json`. The result reports Store discovery separately
from approved unpacked IDs and paths, plus native-host registration health and
whether manual setup is required. It never includes a relay key or pairing
string.

## Use it

Select the built-in `chrome` profile, or make it the default:

```bash
openclaw config set browser.defaultProfile chrome
```

```json5
{
  browser: {
    profiles: {
      chrome: { driver: "extension" },
    },
  },
}
```

Fresh automatic pairings use **All tabs**. Existing valid pairings are never
overwritten, and older pairings keep their stored access mode.

For local setup, native bootstrap connects the extension through the local
Gateway's exact `/browser/extension` route. That first authenticated connection
wakes the lazy browser-control service and starts the profile's loopback relay;
OpenClaw and local clients such as mcporter then use that profile relay port.
Keep `openclaw gateway run` or the managed Gateway service running. A separate
browser request or prewarm step is not required.

Browser-node setup remains different: the extension connects to the relay on
the browser-node host while the node uses its configured remote Gateway. An
explicit `--gateway-url` pairing connects directly to that remote Gateway and
remains a manual-only flow.

### Choose tab access

- **All tabs** exposes every eligible ordinary tab in that Chrome profile,
  except tabs paused for the current browser session. Use **Pause on this tab**
  and **Allow on this tab** in the popup.
- **Selected tabs** uses the **OpenClaw** tab group as the access-control
  boundary. Moving a tab into the group grants access; moving it out revokes
  access.

Open the extension's Settings page to change the access mode. Switching to
Selected tabs immediately detaches ungrouped tabs, including attaches already
in flight. Agent-created tabs stay in the OpenClaw group in either mode.

The extension excludes incognito tabs, internal pages such as `chrome://` and
`chrome-extension://`, and tabs without a usable current URL. `file://` access
also requires Chrome's **Allow access to file URLs** setting.

## Automatic setup controls

Settings shows redacted relay/native bootstrap status and an **Use automatic
local setup** switch.

- Turning automatic setup off preserves a valid existing pairing but prevents
  new native bootstrap attempts.
- **Disconnect and disable automatic setup** revokes the pairing immediately,
  detaches debugger sessions, and persists the opt-out.
- **Use local OpenClaw** clears the opt-out and retries the native host.
- Saving an explicit manual pairing also clears the opt-out.

Pre-release development installs that paired before local Gateway wakeup
routing keep their existing pairing unchanged. In Settings, use **Disconnect
and disable automatic setup**, then **Use local OpenClaw** to create the new
local pairing. Released builds do not require this recovery step.

### Upgrades from the retired tab copilot

If Settings says automation is paused to protect a pre-upgrade copilot
session, confirm that old runs are finished. Then click **Disconnect and
disable automatic setup** to discard the retired recovery state, followed by
**Use local OpenClaw** to reconnect. Until that explicit disconnect succeeds,
the extension preserves the retired state and blocks relay connections, native
setup, manual pairing, tab access changes, and debugger attachment.

Chromium caches the first missing-native-host result for the running browser
process. If an existing extension already attempted automatic setup before the
native host was installed, restart Chrome once (a full browser-process reload).
Retrying from the popup or Settings cannot clear that process-level miss.
Normal setup avoids it by pre-registering the host before adding or reopening
the Store extension. For development, pre-register before **Load unpacked**.

## Status and removal

Inspect the installation without printing credentials:

```bash
openclaw browser extension status
openclaw browser extension status --json
```

Remove only OpenClaw-owned native-host manifests and launchers:

```bash
openclaw browser extension uninstall-host
```

This does not remove the Store or unpacked extension from Chrome. Use
`chrome://extensions` for that. It also does not delete the stable development
copy or an existing relay key.

`openclaw browser extension path` is read-only. It prints the stable installed
copy when present and the bundled source directory otherwise.

## Advanced manual pairing

The Settings page owns manual pairing. Generate a host-local pairing string:

```bash
openclaw browser extension pair
```

Manual pairing remains useful on Windows and for recovery. Treat the complete
pairing string as a password.

Without `--gateway-url`, this command retains the host-local `/extension` relay
for standalone manual pairing. It does not wake Browser control; the selected
profile relay must already be running before the extension connects.

For a laptop that has Chrome but does not run OpenClaw or a browser node, pair
directly to a remote Gateway:

```bash
openclaw browser extension pair \
  --gateway-url wss://gateway.example.com
```

Paste that string in **Settings → Advanced manual pairing**. This flow cannot
use automatic bootstrap: the remote Gateway owns a different relay key, and the
local native host never fetches or copies it. Non-loopback remote URLs require
`wss://`, and the Gateway must expose the exact `/browser/extension` WebSocket
path without a path-rewriting proxy prefix.

## External CDP clients

The relay supports Browser Relay Authentication v2 clients such as mcporter.
Print non-secret endpoint metadata:

```bash
openclaw browser extension cdp
openclaw browser extension cdp --json
```

The output includes the loopback endpoint, protocol version, key ID, and fixed
challenge/complete resources. It does not include the relay key or an
authorization header.

`cdp --legacy-bearer` is a temporary, warned compatibility escape hatch. It
works only while `browser.extensionRelay.allowLegacyAuth=true` and prints the
legacy credential on request.

## Permissions

The extension requests only:

- `debugger`: send CDP commands to allowed tabs;
- `tabs` and `tabGroups`: discover tabs and enforce access mode;
- `storage`: persist pairing, access mode, session pauses, and bootstrap opt-out;
- `alarms`: wake the MV3 worker for relay/bootstrap retries;
- `nativeMessaging`: request one local bootstrap pairing.

It does not request `activeTab`, `contextMenus`, `scripting`, or `sidePanel`.

## Native bootstrap security

The native host is `ai.openclaw.browser_bootstrap`. Each
`chrome.runtime.sendNativeMessage` call starts one process, reads one request,
writes one response, and exits.

The request uses a versioned, length-prefixed JSON frame with a fresh 16-byte
nonce. The host caps input at 4 KiB, requires fatal UTF-8 decoding and exact
fields, verifies the caller origin against the exact installed manifest, and
returns only a locally generated pairing or a bounded non-secret failure code.
The response is below Chrome's 1 MiB native-message limit. Pairing keys never
appear in launcher arguments, manifests, status JSON, or diagnostics.

The POSIX launcher and manifest use absolute canonical paths under an
OpenClaw-owned mode-`0700` directory. Manifests are mode `0600`; the launcher is
owner-executable. Symlinks, foreign ownership, unsafe modes, path traversal,
wildcard origins, and foreign same-name registrations fail closed.

The managed manifest authorizes the exact Foundation Chrome Web Store origin
plus deterministic development origins in canonical order. The Store identity
is a fixed product trust grant, not proof that an arbitrary path is
OpenClaw-owned.

Install the official Chrome Web Store build for normal use. Only load unpacked
development copies you trust: Chrome can give a key-matched unpacked build the
same extension identity and native-host access.

The unpacked development ID calculation matches Chromium's
`crx_file::id_util::GenerateIdForPath`: hash the canonical absolute path's raw
bytes with SHA-256 (native UTF-16LE path bytes on Windows, with only a lowercase
drive letter uppercased), keep the first 16 digest bytes, then map hexadecimal
digits `0` through `f` to letters `a` through `p`. The unpacked extension
manifest has no `key`; only these development IDs depend on approved
OpenClaw-owned realpaths.

The relay itself uses connection-bound HMAC proofs. The persistent per-host key
is not sent in a URL, header, WebSocket subprotocol, or application frame.

## Troubleshooting

```bash
openclaw browser extension status --json
openclaw browser doctor --browser-profile chrome
openclaw doctor
```

- **No extension ID detected:** keep Chrome running, rerun `extension install`,
  then add the official Store extension. Use **Load unpacked** only as a
  development fallback after the command says native bootstrap is ready.
- **Extension was loaded before native setup:** restart Chrome once to clear its
  cached native-host miss, then rerun the ordered install flow.
- **Extension version mismatch:** reload the unpacked OpenClaw extension from
  `chrome://extensions`, then rerun browser doctor. Fully restart Chrome if the
  running and bundled versions still differ.
- **Waiting for local OpenClaw:** run `extension status`; install or repair the
  owned native host.
- **Automatic setup disabled:** enable it in Settings or click **Use local
  OpenClaw**.
- **Manual setup required:** use Settings for the advanced pairing flow. This
  is expected on Windows and direct extension-only remote Gateway setups.
- **Relay unavailable:** confirm `openclaw gateway run` or the managed Gateway
  service is running for local setup, or confirm the browser node is running
  for browser-node setup. Then run browser doctor. No separate browser prewarm
  should be necessary.

See [Browser](/tools/browser) for the full profile model and the managed
`openclaw` and Chrome MCP `user` profiles.
