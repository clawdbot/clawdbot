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

Matched by exact `<class>:` name prefix, so other codesigning certificates
(self-signed, internal CA) are not auto-selected; set `SIGN_IDENTITY` to sign
with one. `scripts/restart-mac.sh` applies the same rule when it chooses
between signing and ad-hoc signing, and passes `SIGN_IDENTITY` through.

This is a name check, not issuer verification: a certificate deliberately named
into one of those classes is still selected.

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
