# iCloud Find My

Access Find My device locations and battery status via the iCloud CLI.

## What This Skill Does

Teaches your agent how to:
- Query iCloud Find My for device locations
- Check battery levels and charging status
- Monitor family devices
- Provide proactive battery warnings

## Requirements

- macOS (for iCloud API access)
- PyiCloud installed via pipx
- Apple ID with Find My enabled
- Family Sharing (optional, for family devices)

## Installation

```bash
clawdhub install icloud-findmy
```

This will guide you to install PyiCloud. Your agent will then help you authenticate with your Apple ID.

## How It Works

This skill provides documentation and examples for using the `icloud` CLI. Your agent:

1. Stores your Apple ID in its workspace
2. Calls `icloud --username YOUR_ID --with-family --list`
3. Parses the output to extract location and battery data
4. Provides natural language responses

**No custom code required** - just the standard icloud CLI from PyiCloud.

## Session Duration

Sessions last 1-2 months. When expired, your agent will help you re-authenticate.

## Privacy

- Your Apple ID is stored locally in your agent's workspace
- iCloud sessions are stored in your home directory
- No data is sent to third parties
- Uses Apple's standard Find My API

## Examples

**"What's my battery level?"**
→ Agent checks Find My and reports your phone's battery

**"Where is Linda's phone?"**
→ Agent looks up location and provides coordinates or address

**Proactive alerts:**
→ Agent warns if battery is low (<30%) before calendar events

## License

MIT - Uses [PyiCloud](https://github.com/picklepete/pyicloud) by picklepete
