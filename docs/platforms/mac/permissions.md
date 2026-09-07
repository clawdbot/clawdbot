---
summary: "macOS permission persistence (TCC) and signing requirements"
read_when:
  - Debugging missing or stuck macOS permission prompts
  - Screen Recording still appears missing after granting access
  - Deciding whether to grant Accessibility to node or a CLI runtime
  - Packaging or signing the macOS app
  - Changing bundle IDs or app install paths
title: "macOS permissions"
---

macOS permission grants are fragile. TCC associates a permission grant with the app's code signature, bundle identifier, and on-disk path. If any of those change, macOS treats the app as new and may drop or hide prompts.

Open **Dashboard → Settings → This Mac → Permissions** in the macOS app to
check each permission, request access, or open its macOS System Settings pane.
The page also controls location access and precision. Permission status refreshes
when you return to the app after changing a grant in System Settings, focus the
Dashboard, or complete a permission request. Open Dashboard windows do not start
background permission polling.

Enabling camera access, Computer Control, the Peekaboo bridge, browser cookie
sync, or continuous Voice Wake listening requires a native confirmation with
**Cancel** selected by default. Increasing location access (from Off to While
Using or Always, or from While Using to Always) and enabling precise location
also require confirmation. Adding cookie domains requires confirmation even
before sync is enabled; changing the destination requires it while sync is
enabled. Disabling these capabilities or decreasing location access takes
effect without native confirmation. Cancelling a cookie-domain or destination
change restores the displayed native value; a newer edit stays pending until
its own confirmation finishes.

Voice Wake and location changes that need macOS authorization remain pending
until permission is granted. Closing or replacing their Dashboard document
discards the pending change. A newer setting from another Dashboard window
also supersedes an older permission request, so its later completion cannot
undo the newer choice.

## Requirements for stable permissions

- Same path: run a release app from `/Applications/OpenClaw.app`; keep development builds at one fixed path such as `dist/OpenClaw.app`.
- Same bundle identifier: release builds use `ai.openclaw.mac`; development builds default to `ai.openclaw.mac.debug`. Each has a separate permission identity.
- Signed app: unsigned or ad-hoc signed builds do not persist permissions.
- Consistent signature: use a real Apple Development or Developer ID certificate so the signature stays stable across rebuilds.

Ad-hoc signatures generate a new identity every build. macOS forgets previous grants, and prompts can disappear entirely until the stale entries are cleared.

## Screen Recording still appears missing after granting access

If Quick Chat still shows **Needs additional permissions: Screen Recording**:

1. Click **Grant** in OpenClaw.
2. If macOS opens System Settings, enable the running OpenClaw app under **Privacy & Security -> Screen & System Audio Recording** (called **Screen Recording** on older macOS versions).
3. Return to OpenClaw and retry the screenshot. **Dashboard → Settings → This Mac → Permissions** shows the refreshed access status.

After an explicit **Grant** request, OpenClaw checks ScreenCaptureKit as well as the macOS permission preflight. This lets it recognize access when the preflight still reports an old denial. Passive status checks do not initiate this probe before you request access.

If access still appears missing, quit and reopen OpenClaw from the same app path. Some macOS permission changes require an app restart before capture works. If both release and development builds are installed, grant access to the build you are actually running: approving `/Applications/OpenClaw.app` does not grant access to a development build with a different bundle identifier.

## Accessibility grants for Node and CLI runtimes

Prefer granting Accessibility to OpenClaw.app, Peekaboo.app, or another signed helper with its own bundle identifier instead of a generic `node` binary.

macOS TCC grants Accessibility to the code identity of the process it sees. If a Homebrew, nvm, pnpm, or npm workflow causes a shared `node` executable to receive Accessibility, any JavaScript package launched through that same executable may inherit GUI automation privileges.

Treat a `node` entry in System Settings as broad permission for that Node runtime, not as permission for one npm package. Avoid granting Accessibility to `node` unless you trust every script and package launched through that exact Node install.

Accessibility approval does not enable activity sharing. **Dashboard → Settings → This Mac → Permissions → Active computer presence** is a separate, off-by-default control for sharing bounded idle duration with your Gateway. Turning it off clears retained activity without revoking Accessibility or disconnecting the node.

If you accidentally granted Accessibility to `node`, remove that entry from System Settings -> Privacy & Security -> Accessibility. Then grant the signed app or helper that should own UI automation.

## Separate Computer Control grants

macOS keeps Accessibility, Event Posting, input listening, and Screen Recording in separate TCC buckets. One successful grant does not prove the others are usable. OpenClaw's Computer Control status checks Accessibility, Event Posting, and Screen Recording separately; this is why screenshots can succeed while clicks and typing fail.

An Accessibility row can also remain visibly enabled while its code requirement is pinned to an older build. When OpenClaw reports **Accessibility grant may be stale**, select OpenClaw under **System Settings -> Privacy & Security -> Accessibility**, remove it with **-**, then re-add `/Applications/OpenClaw.app`. Quit and reopen OpenClaw afterward because Accessibility trust can remain cached in the running process.

## Recovery checklist when prompts disappear

1. Quit the app.
2. Remove the app entry in System Settings -> Privacy & Security.
3. Relaunch the app from the same path and re-grant permissions.
4. If the prompt still does not appear, reset TCC entries with `tccutil` and try again.
5. Some permissions only reappear after a full macOS restart.

Example resets (using OpenClaw's bundle ID, `ai.openclaw.mac`):

```bash
sudo tccutil reset Accessibility ai.openclaw.mac
sudo tccutil reset ScreenCapture ai.openclaw.mac
sudo tccutil reset AppleEvents
```

## Files and folders permissions (Desktop/Documents/Downloads)

macOS may also gate Desktop, Documents, and Downloads for terminal/background processes. If file reads or directory listings hang, grant access to the same process context that performs file operations (for example Terminal/iTerm, LaunchAgent-launched app, or SSH process).

Workaround: move files into the OpenClaw workspace (`~/.openclaw/workspace`) if you want to avoid per-folder grants.

If you are testing permissions, always sign with a real certificate. Ad-hoc builds are only acceptable for quick local runs where permissions do not matter.

## Related

- [macOS app](/platforms/macos)
- [macOS signing](/platforms/mac/signing)
