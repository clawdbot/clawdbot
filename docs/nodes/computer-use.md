---
summary: "Capability-based desktop control through the computer tool and computer.act node command"
read_when:
  - Letting the gateway agent see and control a paired desktop
  - Enablement, permissions, or safety for computer use
  - Extending the computer.act node command or its fulfillers
title: "Computer use"
---

Computer use lets the gateway agent see and control a capable paired desktop. Eligibility is capability-based: the connected node must advertise both `computer.act` and `screen.snapshot`. The node's descriptor identifies the supported v2 action, target, observation, and delivery families, so the built-in `computer` tool exposes only what that provider can faithfully execute. Coordinate actions bind to a node-issued reference frame; capable providers can also address windows and elements, request background delivery, and return structured effect or refusal evidence. A vision-capable model drives the surface through the built-in `computer` agent tool.

The agent emits one uniform command, `computer.act`; it cannot choose how a node fulfills it. On macOS, **Settings → General → Capabilities** selects the node-local provider: Peekaboo is the default and preserves the existing in-process coordinate-action path, while CUA uses a driver daemon embedded in `OpenClaw.app`. The app spawns that daemon directly so it inherits OpenClaw's Accessibility and Screen Recording grants, and the app-owned node worker connects through a private socket. Windows and Linux can use the optional, experimental `cua-computer` plugin, which calls the packaged CUA Driver SDK directly.

Provider selection never falls back per action. Switching providers closes the active execution surface, rotates the provider generation, and re-advertises the node commands. A CUA failure therefore becomes an unavailable result instead of silently running the same action through Peekaboo.

## Requirements

- A paired, connected node advertising both `computer.act` and `screen.snapshot`, with `screen.snapshot` returning `displayFrameId`.
- **macOS fulfiller:** app setting **Allow Computer Control** enabled. It defaults on; an explicit off choice stays off.
- **macOS fulfiller:** choose **Peekaboo** (default) or **CUA**. CUA is selectable only when the pinned driver is present in the signed app bundle; development builds without that artifact show **driver not bundled**.
- **macOS fulfiller:** **Accessibility** and **Screen Recording** granted to OpenClaw. The native Peekaboo path also requires Event Posting access for its CoreGraphics input primitives.
- **Windows/Linux fulfiller:** bundled `cua-computer` plugin enabled on Windows x64/ARM64 or glibc-based Linux x64/ARM64. Its package includes the pinned CUA Driver SDK 0.21.0 runtime; no `cua-driver` executable, daemon, or MCP server is configured.
- The pairing update that includes `computer.act` approved on the gateway.
- A vision-capable agent model.
- Tool policy that exposes `computer`. The default `coding` profile does not. Add `computer` to `tools.alsoAllow`; sandboxed agents also need it in `tools.sandbox.tools.alsoAllow`.

## The `computer` agent tool

The built-in `computer` tool takes one action per call. Coordinates are non-negative integer pixels in the most recent screenshot; the node maps them to display points. Coordinate actions must echo the screenshot result's `frameId`, and an explicit `screenIndex` must match that frame. OpenClaw also carries a node-issued display identity from the screenshot into the action, so a display reconnect or geometry change fails closed instead of silently retargeting the same index. These checks reject guessed tokens and tokens from another delivered frame or display. A token is not a freshness guarantee: apps can change pixels on the same display after capture, so take a new screenshot whenever the scene may have changed.

- Reads: `screenshot`.
- Pointer: `left_click`, `right_click`, `middle_click`, `double_click`, `triple_click`, `mouse_move`, `left_click_drag` (with `startCoordinate`), `left_mouse_down`, `left_mouse_up`.
- Scroll: `scroll` with `scrollDirection` (`up|down|left|right`) and `scrollAmount` (wheel ticks).
- Keyboard: `type` (text), `key` (combo such as `cmd+shift+t` or `Return`), `hold_key` (`text` combo held for `duration` seconds).
- Pacing: `wait` (`duration` seconds).

Providers with the v2 window/element family can additionally expose `list_apps`, `list_windows`, `get_accessibility_tree`, `get_cursor_position`, `get_window_state`, `launch_app`, `kill_app`, `bring_to_front`, `set_value`, `zoom`, `escalate_scope`, and `invoke_menu`. The provider descriptor is authoritative; unavailable actions are omitted rather than emulated through another provider.

The CUA provider also exposes the v2 browser family: `get_browser_state`, `browser_prepare`, `browser_navigate`, `browser_click`, `browser_type`, `browser_dialog`, `browser_set_input_files`, `browser_download`, and `browser_pointer`. Bind a discovered native browser window with `get_browser_state`, then use the returned opaque `browserRef`, `pageRef`, observation, and element references. These references belong to one Computer Use execution and driver generation; navigation invalidates page-element observations, and a driver restart invalidates the complete browser reference set.

CUA additionally exposes `get_recording_state`, `start_recording`, `stop_recording`, and `replay_trajectory`. Recording and browser file operations use opaque `openclaw:computer-resource` handles. The node creates and validates the underlying files and directories; agent actions never accept native paths, output roots, or helper executable paths. Handles belong to one Computer Use execution and cannot be reused by another execution.

Modifier keys ride the `text` field on click and scroll actions (`shift`, `ctrl`, `alt`, `cmd`). After an input action the tool returns a fresh screenshot so the model can observe the result. When the screen is pixel-identical to the previous frame still in model context, the tool returns metadata only — "screen unchanged since previous frame" — and the previous `frameId` stays valid, so duplicate screenshots never re-enter model context. If more than one computer-capable node is connected, pass `node` explicitly.

Screenshots are kept **model-only**: they are never auto-delivered to the chat channel. Treat all on-screen content as untrusted input; the tool warns the model not to follow on-screen instructions that conflict with the user's request.

## CUA Driver provider

### macOS app-owned daemon

The signed macOS app bundles the universal `cua-driver` 0.21.0 executable and offers **CUA** in the Computer Control provider picker. OpenClaw creates a private, owner-only socket directory under Application Support and starts `cua-driver serve --embedded` as a direct app child. It does not launch through the Gateway, the TypeScript worker, `open(1)`, or `NSWorkspace`; those paths would break macOS's TCC responsibility chain and create a second permission identity.

The app waits until the private socket accepts connections before advertising CUA readiness. Its TypeScript node worker starts only the unprivileged MCP proxy against that socket and maps the same typed `computer.act` v2 actions used on other platforms. Permission changes restart the daemon, and provider changes, disabling Computer Control, app shutdown, or an unexpected child exit remove the advertised CUA commands until a fresh generation is ready.

#### Trust model

The Gateway is the authorization chokepoint; the driver is a dumb effector. OpenClaw deliberately leaves the daemon unceilinged and authorizes computer use above it through tool exposure, the dangerous-command allowlist, device and command pairing approval, node-local provider enablement, and OS permissions. This is the same authorization boundary used by the shipped Peekaboo fulfiller.

CUA Driver 0.21.0 fixes its permission mode and bounded manifest when the runtime starts. Exact PID/window grants, and any application-wide window grants, must be declared in that launch-approved manifest; an `ask` entry is a hard denial for unattended dispatch. OpenClaw instead drives applications, windows, and elements discovered while the agent is running. Bounded mode therefore cannot express this provider model without duplicating Gateway policy or preauthorizing broad application classes, so the app starts its managed daemon in unrestricted mode with approvals bypassed.

The `computer.act` node-invoke policy classifies exact arguments before transport dispatch. Forced app termination, browser navigation, browser downloads, browser file inputs, recording start, trajectory replay, and desktop-scope escalation are separate high-risk families; ordinary observation and input remain distinct. Classification does not add a per-action prompt or weaken the command-level gates: every action still requires the same exposed tool, armed command, approved pairing, enabled node provider, and OS permissions.

The managed endpoint is not part of the model contract. The CUA plugin registers no model tool, CLI command, service, or raw node-MCP descriptor, and its action schema accepts neither helper binaries, sockets, native sessions, driver arguments, nor provider tool names. On macOS only the app-owned worker receives the endpoint, while node shell execution is routed through the app host without that worker-only value. These boundaries prevent an OpenClaw model action from selecting an alternate route to the managed daemon.

CUA creates the Unix socket with mode `0600`, and OpenClaw places it in a random owner-only `0700` directory. This excludes remote clients and other local users. It does not authenticate or sandbox processes running as the same logged-in user: those processes are inside this boundary and may be able to discover and use same-user resources. Unrestricted CUA mode does not contain a compromised user account. Stronger same-user isolation would require inherited connected IPC or an OS-enforced process boundary.

Loopback is also reachability, not identity: any process on the machine can connect to `127.0.0.1`. A Gateway client therefore does not receive `operator.write` merely because it arrived over loopback. It must authenticate and pass the Gateway's [device pairing and scope approval](/gateway/pairing); without a separately trusted local or shared credential, another already-authorized device must approve the requested operator scope. The driver and its socket never make that decision.

The CUA descriptor advertises window, element, and browser targets; background and foreground delivery; image, accessibility, and browser observations; and recording. Peekaboo remains the default in this release and does not advertise recording.

#### Browser profiles

`browser_prepare` can launch a separate driver-owned Chromium process with a new ephemeral profile or a named isolated profile. It never modifies, copies, terminates, or attaches to the selected browser's existing profile. Existing-profile/CDP attachment remains unavailable because it requires the driver's protected embedding-host consent and revocation path; Gateway approval and `computer.act` arming do not substitute for that local consent.

Browser targets, pages, page elements, and dialogs are opaque capabilities. Retake browser state after navigation, reconnect, or a stale-reference refusal. The adapter never returns provider-native CDP target IDs, tab IDs, or page refs to the model.

### Maintainer live-proof rig

The repository includes a development rig that preserves the real vertical path: agent-facing `computer` tool, Gateway `node.invoke`, paired node, and the selected node-local provider. It is deliberately isolated from the operator app and Gateway. The macOS path uses the signed app node; the Linux path uses the opt-in `cua-computer` plugin in a real X11 session.

#### macOS

Build a signed app from a clean, committed checkout, choose a fresh profile and non-default loopback port, and prepare the two config views:

```bash
scratch="$(mktemp -d /tmp/openclaw-cu-live.XXXXXX)"
scripts/dev/computer-use-macos-live-rig.sh prepare \
  cu-live-proof 29431 "$PWD/dist/OpenClaw.app" "$scratch" peekaboo
```

Run the emitted `gateway` and `app` commands in separate terminals. The split config is intentional: the externally launched daemon reads a scratch config with `gateway.mode: "local"`, while the app profile reads `gateway.mode: "remote"`, direct transport, and the daemon's loopback URL. If the app reads local mode, its Port Guardian owns the route instead of joining the external daemon. The rig keeps its validated launch fields in non-executable `rig.json`; later commands reject unknown fields or paths that do not match the scratch/profile layout. It also seeds a dedicated `node` identity, completed onboarding, unpaused state, Computer Control, and the checkout path used to start the debug node worker. There is no separate node-mode toggle.

In a third terminal, rerun the emitted `nodes` command until the paired entry is connected and advertises `computer.act` plus a `computerUse` descriptor. No operator-device approval step is involved: the loopback gateway silently pairs the rig's CLI identity on its first connect, and the proof runner is admitted as a local backend client without pairing at all. The rig keeps those two identities in separate state directories (`cli-state` and `agent-state`) because a paired operator device is pinned to the scopes of its first connect, and a CLI pairing would otherwise cap the proof client below `operator.write`.

If the node's command surface is still pending approval, take `.pending[0].requestId` from that `nodes` output and run `scripts/dev/computer-use-macos-live-rig.sh approve "$scratch" <request-id>`.

Place a harmless editable fixture window behind a different frontmost app, then run the vertical:

```bash
scripts/dev/computer-use-macos-live-rig.sh proof \
  "$scratch" peekaboo "Computer Use Fixture" "background proof" "Editor"
```

The proof runner first requires the sole connected computer node to advertise the requested provider, then executes `screenshot`, `list_windows`, `get_window_state`, background element click and type, and re-observes the window. It saves the structured result and target-window before/after images under the scratch directory and fails unless the provider matches, the target started non-frontmost, the frontmost app and cursor stayed unchanged, target content changed, and the final effect was confirmed or a structured refusal. Restart the isolated app with the other provider and rerun the same proof. Do not use port `18789`, the default profile, or `/Applications/OpenClaw.app` for this rig.

#### Linux X11 through Crabbox

Run Linux proof on a Crabbox Linux host, not on a macOS container. A direct AWS Crabbox lease with Xvfb is sufficient because Xvfb is a real X11 server; a local container on macOS is not remote Linux desktop proof. Install the X11 fixture prerequisites on the disposable host, then start an isolated session:

```bash
sudo apt-get update
sudo apt-get install -y at-spi2-core dbus-x11 gir1.2-gtk-3.0 jq openbox python3-gi x11-utils xdotool xvfb

dbus-run-session -- bash
export DISPLAY=:99 XDG_SESSION_TYPE=x11 NO_AT_BRIDGE=0
Xvfb "$DISPLAY" -screen 0 1280x800x24 -nolisten tcp &
openbox >/tmp/openclaw-cu-openbox.log 2>&1 &

scratch="$(mktemp -d /tmp/openclaw-cu-live.XXXXXX)"
scripts/dev/computer-use-macos-live-rig.sh prepare-linux \
  cu-linux-live-proof 29431 "$scratch"
```

Run the emitted `gateway`, `node`, and `fixture` commands in separate panes that inherit the same `DISPLAY` and `DBUS_SESSION_BUS_ADDRESS`. The isolated configs share one scratch-only random Gateway token, and the gateway silently approves loopback node-device pairing. The node command surface remains an explicit approval: run the emitted `nodes` command after the node finishes reconnecting, read `.pending[0].requestId`, and pass it to `scripts/dev/computer-use-macos-live-rig.sh approve "$scratch" <request-id>`. Rerun `nodes` until exactly one connected node advertises `provider.id: "cua-computer"`.

Execute the same proof runner against the non-frontmost GTK fixture:

```bash
scripts/dev/computer-use-macos-live-rig.sh proof \
  "$scratch" cua "OpenClaw CUA X11 Target" "W3-LINUX CONFIRMED"
```

The result and `window-before.png` / `window-after.png` stay under the scratch directory. A confirmed mutation must preserve the sentinel as the active X11 window and leave the pointer unchanged. An upstream `background_unavailable` or `background_occluded` result is valid refusal evidence only when it remains structured and no foreground retry is attempted. The rig rejects native Wayland even when `DISPLAY` is also present for XWayland; switch to X11 instead of claiming Wayland coverage.

### Windows and Linux (experimental, direct SDK)

The bundled `cua-computer` plugin provides an experimental fulfiller for Windows and Linux node hosts. It is disabled by default on those platforms (macOS enables it by default for the CUA fulfiller above) and uses the pinned CUA Driver SDK 0.21.0 contract directly:

1. Enable the plugin:

   ```bash
   openclaw plugins enable cua-computer
   ```

2. Verify the node-local SDK package before starting the node:

   ```bash
   openclaw doctor --lint --only cua-computer/driver-artifacts
   ```

   OpenClaw checks the SDK package version, the selected OS/CPU package version, regular-file identity, and the pinned SHA-256 digest of the native library and Node runtime. A clean check prints `no findings`. If it reports a `COMPUTER_DRIVER_*` error, reinstall or update OpenClaw on this node host and run the check again. Do not download a standalone `cua-driver` executable or add one to `PATH`; Windows and Linux use the npm-installed in-process SDK.

3. Start `openclaw node run` from the interactive desktop session. The plugin repeats artifact verification at startup before importing native code, then lazily creates its configured SDK runtime and one trusted lifecycle session for each provider execution. Window and desktop targets are supplied per action; `escalate_scope` reads the existing session state without widening its authority. Completion, cancellation, Gateway disconnect, provider switching, local Stop, and command-host shutdown all close that exact execution, finalize or discard its recording resources, close its session, and shut down its runtime.

4. Approve the pairing update that includes `computer.act`. Desktop `computer.act` is a built-in platform default, so plugin enablement plus that approval is the whole grant; no `gateway.nodes.commands.allow` entry is required. An operator who wants the command off can deny it:

   ```json5
   {
     gateway: {
       nodes: { commands: { deny: ["computer.act"] } },
     },
   }
   ```

   A denied command is withheld from the node's advertised surface together with its `computer` capability, and the Gateway logs which commands it withheld.

This fulfiller currently controls only the primary display. `hold_key`, `left_mouse_down`, and `left_mouse_up` are unavailable because the CUA Driver SDK has no desktop-scope held-input contract. Modifier-held clicks, scrolling, and dragging are rejected because the typed desktop methods do not accept modifiers. The `key` action accepts named keys, letters, and modifier combos (for example `cmd+c` or `Return`); digit and punctuation keys are rejected because the driver drops their layout-dependent shift state, so send that text through the `type` action instead. Cancellation is passed to the SDK for each node invocation.

The plugin calls `CuaDriver.createConfigured`, never bare `create()`. Its authorization ceiling, trusted session identity, TTLs, and action targets are owned by OpenClaw; model-facing `screen.snapshot` and `computer.act` inputs cannot select a native session or widen its authority. Because the driver reports no stable display identity, frame authorization binds to the trusted session generation plus live primary-display geometry. A new session invalidates outstanding frames, but a same-geometry primary-display substitution inside one session cannot be detected; prefer a stable single-display session for this fulfiller.

On Windows and Linux this is a hard replacement of the former 0.10 daemon/MCP integration: OpenClaw does not spawn a CUA process or proxy an MCP client. macOS deliberately uses the app-owned embedded daemon described above so the driver remains in `OpenClaw.app`'s TCC responsibility chain. Neither path falls back to another provider for an individual action.

The accepted driver record lives with the `cua-computer` package and supplies both the npm native-file digests and the macOS archive digest. Updating OpenClaw updates that record and the SDK packages together. There is no independent Windows/Linux driver updater or rollback directory because there is no separate driver installation on those hosts; roll back by installing the previous known-good OpenClaw package, then rerun the focused doctor check before restarting the node.

### Troubleshooting

The `cua-computer` fulfiller surfaces typed error codes in the tool result and node logs. Common ones:

| Code                                                 | Cause                                                                                                                                                         | Fix                                                                                                                                                                                                      |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `COMPUTER_DRIVER_UNAVAILABLE`                        | The CUA runtime cannot initialize, the macOS app-owned endpoint is absent, or the desktop permissions/session are unavailable.                                | On macOS, verify CUA is selected and the bundled driver is ready; on Windows/Linux, run `openclaw node run` inside the interactive desktop session. Reinstall OpenClaw if the pinned runtime is missing. |
| `COMPUTER_DRIVER_PACKAGE_MISSING`                    | The pinned SDK package, OS/CPU native package, native library, or Node runtime is absent or unreadable.                                                       | Reinstall OpenClaw on the node host, rerun `openclaw doctor --lint --only cua-computer/driver-artifacts`, then restart the node.                                                                         |
| `COMPUTER_DRIVER_VERSION_MISMATCH`                   | The SDK package or selected native package does not match the accepted 0.21.0 version.                                                                        | Update or reinstall OpenClaw so both packages come from the same release; rerun the focused doctor check.                                                                                                |
| `COMPUTER_DRIVER_DIGEST_MISMATCH`                    | A native SDK library or Node runtime is not a regular package file or does not match its pinned SHA-256 digest.                                               | Do not run or replace the file manually. Reinstall OpenClaw, rerun the focused doctor check, then restart the node.                                                                                      |
| `COMPUTER_DRIVER_PLATFORM_UNSUPPORTED`               | The node host has no published 0.21.0 native SDK package, such as musl Linux or an unsupported CPU architecture.                                              | Use Windows x64/ARM64 or glibc-based Linux x64/ARM64 for this provider.                                                                                                                                  |
| `COMPUTER_REFUSED_<code>`                            | The driver refused the action with a structured code such as `background_unavailable`, `background_occluded`, or `foreground_unavailable` (KDE/KWin Wayland). | Bring the target window forward, switch to X11, or use a supported compositor. See the compatibility notes above.                                                                                        |
| `COMPUTER_STALE_FRAME`                               | The coordinates referenced a screenshot that is no longer current (context compaction, a display geometry change, or a reference-width change).               | Take a fresh `screenshot` before the coordinate action.                                                                                                                                                  |
| `COMPUTER_STALE_OBSERVATION`                         | A window or browser reference belongs to an older observation, navigation, execution, or driver generation.                                                   | Run `get_window_state` or `get_browser_state` again and retry with the new opaque references.                                                                                                            |
| `COMPUTER_UNSUPPORTED_ACTION`                        | An action this fulfiller cannot faithfully deliver: `hold_key`, `left_mouse_down`, `left_mouse_up`, or modifier-held click/drag/scroll.                       | Use a supported action. The typed CUA Driver desktop contract has no held-input or modifier argument for these calls.                                                                                    |
| `COMPUTER_UNSUPPORTED_DISPLAY`                       | A non-primary `screenIndex`, a capture/screen geometry mismatch, or a cursor outside the primary display.                                                     | Drive the primary display only.                                                                                                                                                                          |
| `COMPUTER_UNSUPPORTED_KEY`                           | A `key` value the driver cannot reproduce reliably: a digit or punctuation key whose shift state is layout-dependent, or an unknown key.                      | Send that text through the `type` action instead.                                                                                                                                                        |
| `COMPUTER_DRIVER_ERROR` / `COMPUTER_INVALID_REQUEST` | The driver failed without a structured code, or the action arguments were malformed.                                                                          | Check the driver state and retake a screenshot; correct the action arguments.                                                                                                                            |

## The `computer.act` node command

`computer.act` is the single node command the tool routes input through (`node.invoke` with `command: "computer.act"`). It is:

- **Locally enabled**: the node advertises it only while Computer Control is enabled. The gateway can approve that advertised surface once at pairing.
- **Capability-based**: the tool requires a connected node to advertise both `computer.act` and `screen.snapshot`. The bundled macOS app and the opt-in experimental `cua-computer` plugin fulfill the same command pair.

Reads reuse `screen.snapshot`; there is no second capture path. See [Camera and screen nodes](/nodes/camera) for the shared capture command.

## Authorization

1. Enable the platform fulfiller: on macOS, **Settings → General → Capabilities → Allow Computer Control** starts enabled, then choose Peekaboo or CUA and grant **Accessibility** and **Screen Recording** under **Settings → Permissions**; on Windows/Linux, follow the experimental `cua-computer` setup above.
2. Approve the pairing update on the gateway (a new command forces re-pairing).
3. Expose the tool to the vision-capable agent. For the default `coding` profile:

   ```json5
   {
     tools: {
       alsoAllow: ["computer"],
       // Sandboxed agents need this second gate too:
       sandbox: { tools: { alsoAllow: ["computer"] } },
     },
   }
   ```

Once the node-local control is enabled and the pairing update is approved, `computer.act` is durably available while the node continues to advertise it. There is no lease, expiry, or arm/disarm command. Disabling Computer Control locally removes the advertised command and the node rechecks the toggle at invocation time.

On macOS, default-on means a paired gateway can drive pointer and keyboard input as soon as the required macOS grants exist. There is no per-action confirmation. Turn off **Allow Computer Control** before pairing, or at any later time, to stop advertising and accepting `computer.act`.

`gateway.nodes.commands.deny` remains an explicit global revocation and always wins; a denied `computer.act` is withheld from the node's advertised surface together with its `computer` capability, and the Gateway records what it withheld. No fulfiller needs a `gateway.nodes.commands.allow` entry: `computer.act` is a built-in desktop platform default, so node-local enablement plus pairing approval is the whole grant on every platform and for either fulfiller. An authenticated operator with `operator.write` can invoke an enabled, paired command through `node.invoke`; there is no per-action admin check.

## Safety

- Every layer (tool policy, gateway command policy, pairing, node-app setting, and platform permissions) must agree. On macOS that includes **Allow Computer Control**, Accessibility, and Screen Recording; the native Peekaboo path also requires Event Posting. Actions execute while those durable controls remain enabled; there is no per-action confirmation.
- The macOS fulfiller posts text one grapheme at a time, so cancellation, disconnect, pause, disable, or endpoint replacement stops it before the next grapheme. The experimental CUA Driver fulfiller passes node cancellation to the SDK for each call.
- CUA recording, replay, browser upload, and browser download paths are node-owned. The model receives only opaque execution-scoped resource handles; traversal, absolute paths, symlink escapes, and helper selection are rejected before driver dispatch.
- Screenshots are model-only and never auto-sent to chat (issue [#44759](https://github.com/openclaw/openclaw/issues/44759)).
- Treat screen content as untrusted; it can carry prompt injection.

## macOS permission troubleshooting

The Computer Control status in **Settings → General → Capabilities** checks Accessibility, Event Posting, and Screen Recording separately. Screen capture can work while input remains denied because macOS stores those grants in separate TCC buckets.

If the status says **Accessibility grant may be stale**, OpenClaw may already appear enabled under **System Settings → Privacy & Security → Accessibility** even though macOS rejects it. This happens when the Accessibility entry is pinned to an older app build. Select OpenClaw in that list, remove it with **−**, then re-add `/Applications/OpenClaw.app`. Quit and reopen OpenClaw after changing the grant because macOS can cache Accessibility trust for the lifetime of the process.

## Relationship to other desktop-control paths

This is the agent-driven path. See [Peekaboo bridge](/platforms/mac/peekaboo) for how it relates to the PeekabooBridge host, Codex Computer Use, and the direct `cua-driver` MCP.
