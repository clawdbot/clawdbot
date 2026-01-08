---
name: icloud-findmy
description: Query Find My locations and battery status for family devices via iCloud.
homepage: https://github.com/picklepete/pyicloud
metadata: {"clawdbot":{"emoji":"📍","requires":{"bins":["icloud"]},"install":[{"id":"pipx","kind":"shell","command":"brew install pipx && pipx install pyicloud","bins":["icloud"],"label":"Install PyiCloud (pipx)"}]}}
---

# iCloud Find My

Access Find My device locations and battery status via the iCloud CLI (pyicloud).

## Setup

1. **Install pyicloud:**
```bash
brew install pipx
pipx install pyicloud
```

2. **Authenticate (one-time):**

Ask the user for their Apple ID, then run:
```bash
icloud --username their.email@example.com --with-family --list
```

They'll need to enter their password and complete 2FA. The session will be saved and lasts 1-2 months.

3. **Store Apple ID:**

Add the Apple ID to your TOOLS.md or workspace config so you remember it for future queries:
```markdown
## iCloud Find My
Apple ID: their.email@example.com
```

## Usage

### List all devices

```bash
icloud --username APPLE_ID --with-family --list
```

**Output format:**
```
------------------------------
Name           - Liam's iPhone
Display Name   - iPhone 15 Pro
Location       - {'latitude': 52.248, 'longitude': 0.761, 'timeStamp': 1767810759054, ...}
Battery Level  - 0.72
Battery Status - NotCharging
Device Class   - iPhone
------------------------------
```

**Parsing tips:**
- Devices are separated by `------------------------------`
- Location is a Python dict (use `eval()` or parse with regex)
- Battery Level is 0.0-1.0 (multiply by 100 for percentage)
- Battery Status: "Charging" or "NotCharging"
- Location fields: `latitude`, `longitude`, `timeStamp` (milliseconds), `horizontalAccuracy`

### Get specific device

Find a specific device by grepping the output:
```bash
icloud --username APPLE_ID --with-family --list | grep -A 10 "iPhone"
```

### Parse location

Extract and format location data:
```bash
icloud --username APPLE_ID --with-family --list | \
  grep -A 10 "Device Name" | \
  grep "Location" | \
  sed "s/Location.*- //"
```

Then parse the Python dict string with Python or extract coordinates with regex.

### Parse battery

```bash
icloud --username APPLE_ID --with-family --list | \
  grep -A 10 "Device Name" | \
  grep "Battery Level"
```

## Device Names

Device names come from iCloud and may include:
- Fancy Unicode apostrophes (U+2019 ') instead of ASCII '
- No apostrophes at all (e.g., "Lindas iPhone")

Use case-insensitive matching and normalize apostrophes if needed.

## Session Management

- Sessions last **1-2 months**
- Stored in user's home directory
- When expired, re-run the authentication step
- PyiCloud validates automatically on each request

## Common Patterns

**Check battery before going out:**
```bash
# Get battery for specific device
icloud --username ID --with-family --list | \
  grep -B 2 -A 5 "iPhone" | \
  grep "Battery Level"
```

**Get current location:**
```bash
# Extract location dict and parse coordinates
icloud --username ID --with-family --list | \
  grep -A 10 "iPhone" | \
  grep "Location" | \
  sed "s/.*- //" | \
  python3 -c "import sys; loc = eval(sys.stdin.read()); print(f\"{loc['latitude']}, {loc['longitude']}\")"
```

**Check if device is charging:**
```bash
icloud --username ID --with-family --list | \
  grep -A 10 "iPhone" | \
  grep "Battery Status"
```

## Proactive Use Cases

- **Battery warnings:** Check battery levels before calendar events (going out)
- **Location context:** Answer "near me" queries by checking user's current location
- **Home/away detection:** Check if user is at home based on coordinates
- **Low battery alerts:** Warn if battery <30% and not charging

## Troubleshooting

**Authentication errors:**
- Session expired - re-authenticate
- Wrong Apple ID - check stored ID
- 2FA required - complete 2FA flow

**No location available:**
- Device offline
- Find My disabled
- Location Services off

**Device not found:**
- Check exact device name with `--list`
- Names are case-sensitive
- May have Unicode apostrophes

## Notes

- Requires macOS (iCloud API quirks)
- Family Sharing must be enabled to see family devices
- Location updates every ~1-5 minutes when device is active
- Battery readings may be cached (check timestamp)
