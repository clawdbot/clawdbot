---
name: granola
description: Access Granola meeting transcripts and notes.
homepage: https://granola.ai
metadata: {"clawdbot":{"emoji":"🥣","requires":{"bins":["python3"]}}}
---

# granola

Access Granola meeting transcripts, summaries, and notes.

## Setup

Granola stores meetings in the cloud. To access them locally:

1. **Install dependencies:**
```bash
pip install requests
```

2. **Run initial sync:**
```bash
python ~/path/to/clawdbot/skills/granola/scripts/sync.py ~/granola-meetings
```

3. **Set up automatic sync via clawdbot cron:**
```javascript
clawdbot_cron({
  action: "add",
  job: {
    name: "Granola Sync",
    description: "Sync Granola meetings to local disk",
    schedule: { kind: "cron", expr: "0 */6 * * *", tz: "America/New_York" },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: {
      kind: "agentTurn",
      message: "Run the Granola sync: python {skillsDir}/granola/scripts/sync.py ~/granola-meetings",
      deliver: false
    }
  }
})
```

The sync script reads auth from `~/Library/Application Support/Granola/supabase.json` (created when you sign into Granola on macOS).

## Data Structure

After sync, each meeting is a folder:
```
~/granola-meetings/
  {meeting-id}/
    metadata.json   - title, date, attendees
    transcript.md   - formatted transcript  
    transcript.json - raw transcript data
    document.json   - full API response
    notes.md        - AI summary (if available)
```

## Quick Commands

**List recent meetings:**
```bash
for d in $(ls -t ~/granola-meetings | head -10); do
  jq -r '"\(.created_at[0:10]) | \(.title)"' ~/granola-meetings/$d/metadata.json 2>/dev/null
done
```

**Search by title:**
```bash
grep -l "client name" ~/granola-meetings/*/metadata.json | while read f; do
  jq -r '.title' "$f"
done
```

**Search transcript content:**
```bash
grep -ri "keyword" ~/granola-meetings/*/transcript.md
```

**Meetings on a specific date:**
```bash
for d in ~/granola-meetings/*/metadata.json; do
  if jq -e '.created_at | startswith("2026-01-03")' "$d" > /dev/null 2>&1; then
    jq -r '.title' "$d"
  fi
done
```

## Notes

- Sync requires the Granola desktop app to be signed in (for auth tokens)
- Tokens expire after ~6 hours; open Granola to refresh them
- macOS only (auth file path is macOS-specific)
- For multi-machine setups, sync on one machine and rsync the folder to others
