---
name: bird
description: X/Twitter CLI for reading, searching, and posting via cookies or Sweetistics.
homepage: https://bird.fast
metadata: {"clawdbot":{"emoji":"🐦","requires":{"bins":["bird"]},"install":[{"id":"brew","kind":"brew","formula":"steipete/tap/bird","bins":["bird"],"label":"Install bird (brew)"}]}}
---

# bird

## Reading vs Writing - Different Tools

**For READING tweets** (works great):
- Use the `bird` CLI - it's fast and reliable
- `bird read <url-or-id>` - grab a specific tweet
- `bird search "query" -n 5` - search tweets
- `bird mentions` - check notifications

**For WRITING tweets** (here's where it gets spicy):
- **Don't use the CLI for posting** - Twitter flags it as automated and you'll get rate limited or soft-banned fast
- **Use the browser tool instead** - mimics real human behavior

## Quick Reference (Reading Only)

```bash
bird whoami           # Check auth status
bird read <url-or-id> # Read a specific tweet
bird thread <url-or-id> # Read full thread
bird search "query" -n 5 # Search tweets
bird mentions         # Check notifications
```

## The React Input Problem

Twitter's compose box is a React controlled input. You can't just set `.value` like a normal input - React ignores it. The workaround:

**Simulate a paste event:**
```javascript
// 1. Focus the editor
var editor = document.querySelector('[data-testid="tweetTextarea_0"]');
editor.focus();

// 2. Create a fake paste event (this triggers React's state update)
var dataTransfer = new DataTransfer();
dataTransfer.setData('text/plain', 'your tweet text here');
var pasteEvent = new ClipboardEvent('paste', {
  clipboardData: dataTransfer,
  bubbles: true,
  cancelable: true
});
editor.dispatchEvent(pasteEvent);

// 3. Click the post button
document.querySelector('[data-testid="tweetButtonInline"]').click();
```

## Browser Setup Notes

- Use a dedicated browser profile (e.g. "clawd") so you're logged in persistently
- The cookie config lives at `~/.config/bird/config.json5` for the CLI
- If CDP fails, kill Chrome completely (`pkill -9 "Google Chrome"`) and restart with `browser action=start`

## Rate Limiting & Detection

- Space out your posts - don't rapid-fire
- Vary your timing slightly (don't post at exactly :00 every hour)
- If you get flagged, the account might need a CAPTCHA solve manually
- Reading is basically unlimited, posting is where they watch you

## Selectors That Work (as of late 2025)

- Tweet compose box: `[data-testid="tweetTextarea_0"]`
- Post button: `[data-testid="tweetButtonInline"]`
- These change occasionally so if stuff breaks, inspect the page

---

**TL;DR: read with CLI, write with browser + paste hack.** 🐦
