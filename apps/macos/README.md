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
node services still start. Combine it with `--attach-only` when an external
process owns the local Gateway.

## App profiles

Launch a fully isolated app instance with the same profile name used by the CLI:

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

## Packaging flow

```bash
scripts/package-mac-app.sh
```

Creates `dist/OpenClaw.app` and signs it via `scripts/codesign-mac-app.sh`.

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
