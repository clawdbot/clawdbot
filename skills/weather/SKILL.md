---
name: weather
description: "Current weather and forecasts with wttr.in via curl for locations, rain, temperature, travel planning."
homepage: https://wttr.in/:help
metadata:
  {
    "openclaw":
      {
        "emoji": "☔",
        "requires": { "bins": ["curl"] },
        "install":
          [
            {
              "id": "brew",
              "kind": "brew",
              "formula": "curl",
              "bins": ["curl"],
              "label": "Install curl (brew)",
            },
          ],
      },
  }
---

# Weather

Use for current weather, rain/temperature checks, forecasts, and travel planning. Need a city, region, airport code, or coordinates.

## Commands

```bash
curl "wttr.in/London?format=3"
curl "wttr.in/London?0"
curl "wttr.in/London"
curl "wttr.in/London?format=v2"
curl "wttr.in/London?1"
curl "wttr.in/New+York?format=3"
```

Useful formats:

- `%l`: location
- `%c`: condition icon
- `%t`: temperature
- `%f`: feels like
- `%w`: wind
- `%h`: humidity
- `%p`: precipitation

```bash
curl "wttr.in/London?format=%l:+%c+%t,+feels+%f,+rain+%p,+wind+%w"
```

JSON:

```bash
curl "wttr.in/London?format=j1"
```

## Notes

- For severe alerts, aviation, marine, or official decisions, use official local weather services.
- For historical climate/weather, use an archive/API, not wttr.in.
- For hyper-local microclimates, prefer local sensors.
