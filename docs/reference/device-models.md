---
summary: "How OpenClaw vendors Apple device model identifiers for friendly names in the macOS app."
read_when:
  - Updating device model identifier mappings or NOTICE/license files
  - Changing how Instances UI displays device names
title: "Device model database"
---

The macOS companion app's **Instances** UI maps Apple model identifiers to friendly names (`iPad16,6` -> "iPad Pro 13-inch (M4)", `Mac16,6` -> "MacBook Pro (14-inch, 2024)"). `DeviceModelCatalog` also uses the identifier prefix (falling back to device family) to pick an SF Symbol per device.

Files in `apps/macos/Sources/OpenClaw/Resources/DeviceModels/`:

| File                                   | Purpose                               |
| -------------------------------------- | ------------------------------------- |
| `ios-device-identifiers.json`          | iOS/iPadOS identifier -> name mapping |
| `mac-device-identifiers.json`          | Mac identifier -> name mapping        |
| `NOTICE.md`                            | Pinned upstream commit SHAs           |
| `LICENSE.apple-device-identifiers.txt` | Upstream MIT license                  |

## Data source

Vendored from the MIT-licensed `kyle-seongwoo-jun/apple-device-identifiers` GitHub repository. JSON files are pinned to commit SHAs recorded in `NOTICE.md` to keep builds deterministic.

## Updating the database

1. Pick the upstream commit SHAs to pin to (one for iOS, one for macOS).
2. Update `apps/macos/Sources/OpenClaw/Resources/DeviceModels/NOTICE.md` with the new SHAs.
3. Re-download the JSON files pinned to those commits:

```bash
IOS_COMMIT="<commit sha for ios-device-identifiers.json>"
MAC_COMMIT="<commit sha for mac-device-identifiers.json>"

curl -fsSL "https://raw.githubusercontent.com/kyle-seongwoo-jun/apple-device-identifiers/${IOS_COMMIT}/ios-device-identifiers.json" \
  -o apps/macos/Sources/OpenClaw/Resources/DeviceModels/ios-device-identifiers.json

curl -fsSL "https://raw.githubusercontent.com/kyle-seongwoo-jun/apple-device-identifiers/${MAC_COMMIT}/mac-device-identifiers.json" \
  -o apps/macos/Sources/OpenClaw/Resources/DeviceModels/mac-device-identifiers.json
```

4. Confirm `LICENSE.apple-device-identifiers.txt` still matches upstream; replace it if the upstream license changed.
5. Verify the macOS app builds cleanly:

```bash
swift build --package-path apps/macos
```

## Related

- [Nodes](/nodes)
- [Node troubleshooting](/nodes/troubleshooting)
