---
name: ga4
description: GA4 Analytics CLI for users, events, funnels, and transcription metrics.
homepage: https://analytics.google.com
metadata: {"clawdbot":{"emoji":"📊","requires":{"bins":["bun"],"env":["GOOGLE_APPLICATION_CREDENTIALS"]},"primaryEnv":"GOOGLE_APPLICATION_CREDENTIALS"}}
---

# GA4 Analytics CLI

Query Google Analytics 4 data - users, events, funnels, transcription metrics.

## Setup

Set environment variables:
```bash
export GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json
export GA4_PROPERTY_ID=510572418  # Optional, defaults to Speakmac
```

Or configure in `~/.clawdbot/clawdbot.json`:
```json
{
  "skills": {
    "entries": {
      "ga4": {
        "env": {
          "GOOGLE_APPLICATION_CREDENTIALS": "/path/to/service-account.json",
          "GA4_PROPERTY_ID": "510572418"
        }
      }
    }
  }
}
```

## Commands

### Overview
```bash
bun {baseDir}/scripts/cli.ts overview                  # 30-day overview
bun {baseDir}/scripts/cli.ts overview --period 7d      # Last 7 days
```

### Real-time
```bash
bun {baseDir}/scripts/cli.ts realtime                  # Active users now
```

### Events
```bash
bun {baseDir}/scripts/cli.ts events                    # Top 50 events
bun {baseDir}/scripts/cli.ts events --limit 20         # Limit results
bun {baseDir}/scripts/cli.ts events --period 7d
```

### Funnels
```bash
bun {baseDir}/scripts/cli.ts funnel onboarding         # Onboarding completion
bun {baseDir}/scripts/cli.ts funnel transcription      # Transcription success
bun {baseDir}/scripts/cli.ts funnel permissions        # Permission grants
```

### Errors
```bash
bun {baseDir}/scripts/cli.ts errors                    # All errors (7d)
bun {baseDir}/scripts/cli.ts errors --type transcription
bun {baseDir}/scripts/cli.ts errors --type license
bun {baseDir}/scripts/cli.ts errors --period 14d
```

### Transcription Metrics
```bash
bun {baseDir}/scripts/cli.ts transcriptions            # By provider
bun {baseDir}/scripts/cli.ts transcriptions --by day   # Daily breakdown
bun {baseDir}/scripts/cli.ts transcriptions --period 14d
```

### Version Adoption
```bash
bun {baseDir}/scripts/cli.ts versions                  # App version usage
bun {baseDir}/scripts/cli.ts versions --period 7d
```

### Growth Metrics
```bash
bun {baseDir}/scripts/cli.ts growth                    # Growth trends
bun {baseDir}/scripts/cli.ts growth --period 90d
```

### Weekly (Date Range)
```bash
bun {baseDir}/scripts/cli.ts weekly --from 2025-11-01 --to 2026-01-20
```

### Custom Query
```bash
bun {baseDir}/scripts/cli.ts query --dimensions week --metrics activeUsers,sessions --from 2025-11-01 --to 2026-01-20
bun {baseDir}/scripts/cli.ts query --dimensions date --metrics eventCount --period 30d
```

## Periods

- `today` - Current day
- `yesterday` - Previous day
- `7d` - Last 7 days
- `14d` - Last 14 days
- `28d` - Last 28 days
- `30d` - Last 30 days (default)
- `90d` - Last 90 days

## Examples

```bash
# Daily check-in
bun {baseDir}/scripts/cli.ts overview --period 7d
bun {baseDir}/scripts/cli.ts realtime

# Feature usage
bun {baseDir}/scripts/cli.ts events --limit 20

# Onboarding health
bun {baseDir}/scripts/cli.ts funnel onboarding

# Transcription performance
bun {baseDir}/scripts/cli.ts transcriptions --by provider
bun {baseDir}/scripts/cli.ts errors --type transcription

# Version rollout
bun {baseDir}/scripts/cli.ts versions --period 7d
```

## Notes

- Service account needs "Viewer" role on GA4 property
- Real-time data shows last 30 minutes
- See `{baseDir}/docs/API_REFERENCE.md` for full API documentation
