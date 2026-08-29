# OpenClaw macOS app (dev + signing)

## Quick dev run

```bash
# from repo root
scripts/restart-mac.sh
```

Options:

```bash
scripts/restart-mac.sh --no-sign   # fastest dev; ad-hoc signing (TCC permissions do not stick)
scripts/restart-mac.sh --sign      # force code signing (requires cert)
scripts/restart-mac.sh --background-only # keep services running without automatic windows
```

`--background-only` suppresses first-run onboarding, update and CLI prompts, and
the `--chat`/`--dashboard` auto-open helpers. Pairing, control-channel, and Mac
node services still start. It also keeps GUI-owned onboarding and saved Gateway
profile Keychain state cold, so a signer or ACL transition cannot raise a
SecurityAgent prompt during unattended work. The primary Gateway route still
comes from the normal environment/config endpoint. Combine it with
`--attach-only` when an external process owns the local Gateway.

## App profiles

Launch a separately configured app instance with the same profile name used by the CLI:

```bash
OPENCLAW_PROFILE=work /Applications/OpenClaw.app/Contents/MacOS/OpenClaw
```

Profile names use 1–64 lowercase letters, numbers, underscores, or hyphens and
must start with a letter or number. `default` selects the normal app; `gateway`,
`mac`, and `node` are reserved LaunchAgent identities.

`scripts/restart-mac.sh` intentionally rejects named profiles because its
packaging cleanup is host-global. Build/package normally, then launch the named
profile directly with the command above.

A named profile keeps state in `~/.openclaw-<name>`, uses its own app defaults,
Keychain services, duplicate-instance lock, and the CLI-managed Gateway service
`ai.openclaw.<name>`. Unless config or environment selects a port, each profile
derives a stable port in the profile `20000...59999` range. The app does not
install or modify the host-global Mac node
service or OpenClaw login item while a profile is active. The runtime child node
still runs in process as usual. App relocation, Sparkle updates, and post-update
service repair are disabled in profile mode; update the installed app through
the normal default-profile workflow.

Profiles are not test sandboxes. PortGuardian intentionally shares its tunnel
ledger and orphan cleanup across app instances, and port reservation inspects
other profiles' Gateway service claims. Use a clean test account or VM when
validation must not access or change operator state.

## Native tests

Run the full app suite only in disposable macOS CI or a VM without operator
credentials or a live Gateway. A test filter or temporary `HOME` is not enough:
preferences and Keychain use system services, and AppKit/WebKit tests can open
windows and helper processes. Local subsets need a verified OS sandbox as well
as test-owned resources. See [native test safety](https://docs.openclaw.ai/platforms/mac/dev-setup#run-native-tests-safely).

The `macos-swift` CI job builds tests once, then runs them through
`scripts/test-macos-native.mts`. The full suite retains default-profile behavior;
named-profile AppState isolation tests run separately. Each process gets private
home, config/state paths, and a short temporary directory before the test bundle
loads. The launcher also creates an unlocked, disposable Keychain in that home
and selects it as the user-domain default and search list, so catalog migration
can save without prompting to create a login Keychain. It disables automatic
locking only for that test resource and deletes it after the test process group
and output pipes close. Failed or unverified cleanup retains resources and fails
the launch.
The disposable runner owns default preferences and system-service state; a named
profile gets a fresh preferences domain. The launcher itself is not a sandbox.
Local `scripts/prepush-ci.sh` keeps Swift lint/build checks but reports native
test proof as incomplete and requires the exact commit's `macos-swift` CI result.

## Packaging flows

Development bundle (signed but not notarized):

```bash
scripts/package-mac-app.sh
```

This creates `dist/OpenClaw.app` and signs it via `scripts/codesign-mac-app.sh`.
It is not a distribution artifact. For a notarized app ZIP and DMG, use:

```bash
scripts/package-mac-dist.sh
```

For an unattended Peekaboo elevation host, use the closed Foundation signing
profile and source-addressed ZIP workflow. `package` is an internal release
operator command: it requires the OpenClaw Foundation signing identity and
notarization credentials, and its archive is not a general-download artifact.

```bash
scripts/mac-elevation-host.sh package \
  --peekaboo-source-commit <full-peekaboo-sha>
cd dist/elevation-host
export PREFIX="OpenClaw-<full-openclaw-sha>-Peekaboo-<full-peekaboo-sha>-stable"
export INSTALLER_SHA256="<authenticated-installer-sha256>"
export RECEIPT_SHA256="<authenticated-receipt-sha256>"
[[ "$(shasum -a 256 "$PREFIX-installer.sh" | awk '{print $1}')" == "$INSTALLER_SHA256" ]] || exit 1
shasum -a 256 -c "$PREFIX.zip.sha256"
shasum -a 256 -c "$PREFIX-installer.sh.sha256"
./"$PREFIX-installer.sh" verify \
  --archive "$PREFIX.zip" \
  --receipt "$PREFIX.json" \
  --receipt-sha256 "$RECEIPT_SHA256"
./"$PREFIX-installer.sh" migration-plan \
  --migrate-launch-agent "$HOME/Library/LaunchAgents/ai.openclaw.node.plist"
./"$PREFIX-installer.sh" install \
  --archive "$PREFIX.zip" \
  --receipt "$PREFIX.json" \
  --receipt-sha256 "$RECEIPT_SHA256" \
  --migrate-launch-agent "$HOME/Library/LaunchAgents/ai.openclaw.node.plist"
./"$PREFIX-installer.sh" status --state-dir "<existing-state-dir>"
```

The elevation package is ZIP-only, notarized and stapled, contains exactly
`OpenClaw.app`, omits Apple Events entitlements, records an immutable receipt,
and verifies a freshly extracted copy. The same source-addressed artifact set
includes a portable installer copied from that exact Git commit plus separate
archive and installer checksum files. Transfer the archive, receipt, portable
installer, and both checksums; the target Mac does not need a source checkout.
The release operator must deliver the receipt SHA-256 through the authenticated
handoff alongside the separately authenticated installer digest. `verify` uses
that receipt digest to select the approved archive and then checks its signer,
entitlements, architectures, and both source revisions. The portable installer
is not covered by the app's code signature, so this explicit two-digest operator
handoff remains part of the internal workflow's trust boundary.

Installation requires an existing app-readable remote Gateway config and a
paired macOS node identity in the selected state directory. Use
`migration-plan` before changing a CLI-managed node LaunchAgent. For a currently
running background app with no LaunchAgent, use the explicit
`--adopt-running-app` plan/install option instead. The installer copies no token
or password: it preserves only the state and config ownership paths, then
requires the same node identity to reconnect as `openclaw-macos/node` with the
new app version and computer-use capabilities before committing. Installation owns the separate
`ai.openclaw.mac.elevation-host` launchd job with `RunAtLoad` and `KeepAlive`.
It refuses to replace or race the ordinary `ai.openclaw.mac` Launch at login
job. `recover` restores the recorded prior bundle after a failed cutover;
`uninstall` removes only the elevation job and preserves the app, state,
Keychain, TCC, and recovery receipt. Installation exits successfully once the
launchd-owned process is both Bridge-ready and reconnected to the Gateway as the
expected computer-use node. Missing TCC remains a degraded `status` result until
the required grants are present. Managed upgrades use generation-unique plist and
receipt backups. Recovery preserves the replaced app in a unique evidence directory
and restores the prior install receipt, so `status` and a same-artifact reinstall
remain valid after rollback.

## Signing behavior

Auto-selects identity (first match):
1) Developer ID Application
2) Apple Distribution
3) Apple Development
4) first available identity

If none found:
- errors by default
- set `ALLOW_ADHOC_SIGNING=1` or `SIGN_IDENTITY="-"` to ad-hoc sign

## Team ID audit (Sparkle mismatch guard)

After signing, we read the app bundle Team ID and compare every Mach-O inside the app.
If any embedded binary has a different Team ID, signing fails.

Skip the audit:
```bash
SKIP_TEAM_ID_CHECK=1 scripts/package-mac-app.sh
```

## Library validation workaround (dev only)

If Sparkle Team ID mismatch blocks loading (common with Apple Development certs), opt in:

```bash
DISABLE_LIBRARY_VALIDATION=1 scripts/package-mac-app.sh
```

This adds `com.apple.security.cs.disable-library-validation` to app entitlements.
Use for local dev only; keep off for release builds.

## Useful env flags

- `SIGN_IDENTITY="Apple Development: Your Name (TEAMID)"`
- `ALLOW_ADHOC_SIGNING=1` (ad-hoc, TCC permissions do not persist)
- `CODESIGN_TIMESTAMP=off` (offline debug)
- `DISABLE_LIBRARY_VALIDATION=1` (dev-only Sparkle workaround)
- `SKIP_TEAM_ID_CHECK=1` (bypass audit)
