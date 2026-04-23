---
summary: "Inbound channel location parsing (Telegram/WhatsApp/Matrix) and context fields"
read_when:
  - Adding or modifying channel location parsing
  - Using location context fields in agent prompts or tools
title: "Channel location parsing"
---

OpenClaw normalizes shared locations from chat channels into:

- terse coordinate text appended to the inbound body, and
- structured fields in the auto-reply context payload. Channel-provided labels, addresses, and captions/comments are rendered into the prompt by the shared untrusted metadata JSON block, not inline in the user body.

Currently supported:

- **Telegram** (location pins + venues + live locations)
- **WhatsApp** (locationMessage + liveLocationMessage)
- **Matrix** (`m.location` with `geo_uri`)

## Text formatting

Locations are rendered as friendly lines without brackets:

- Pin:
  - `📍 48.858844, 2.294351 ±12m`
- Named place:
  - `📍 48.858844, 2.294351 ±12m`
- Live share:
  - `🛰 Live location: 48.858844, 2.294351 ±12m`

If the channel includes a label, address, or caption/comment, it is preserved in the context payload and appears in the prompt as fenced untrusted JSON:

````text
Location (untrusted metadata):
```json
{
  "latitude": 48.858844,
  "longitude": 2.294351,
  "name": "Eiffel Tower",
  "address": "Champ de Mars, Paris",
  "caption": "Meet here"
}
```
````

## Context fields

When a location is present, these fields are added to `ctx`:

- `LocationLat` (number)
- `LocationLon` (number)
- `LocationAccuracy` (number, meters; optional)
- `LocationName` (string; optional)
- `LocationAddress` (string; optional)
- `LocationSource` (`pin | place | live`)
- `LocationIsLive` (boolean)
- `LocationCaption` (string; optional)

The prompt renderer treats `LocationName`, `LocationAddress`, and `LocationCaption` as untrusted metadata and serializes them through the same bounded JSON path used for other channel context.

## Channel notes

- **Telegram**: venues map to `LocationName/LocationAddress`; live locations use `live_period`.
- **WhatsApp**: `locationMessage.comment` and `liveLocationMessage.caption` populate `LocationCaption`.
- **Matrix**: `geo_uri` is parsed as a pin location; altitude is ignored and `LocationIsLive` is always false.
