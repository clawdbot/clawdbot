---
name: hn
description: Browse Hacker News - top stories, new, best, ask, show, jobs, and story details with comments.
homepage: https://news.ycombinator.com
metadata: {"clawdis":{"emoji":"📰","requires":{"bins":["curl"]}}}
---

# Hacker News

Read Hacker News from the command line.

## Commands

### Top Stories
```bash
uv run {baseDir}/scripts/hn.py top          # Top 10 stories
uv run {baseDir}/scripts/hn.py top -n 20    # Top 20 stories
```

### Other Feeds
```bash
uv run {baseDir}/scripts/hn.py new          # Newest stories
uv run {baseDir}/scripts/hn.py best         # Best stories
uv run {baseDir}/scripts/hn.py ask          # Ask HN
uv run {baseDir}/scripts/hn.py show         # Show HN
uv run {baseDir}/scripts/hn.py jobs         # Jobs
```

### Story Details
```bash
uv run {baseDir}/scripts/hn.py story <id>              # Story with top comments
uv run {baseDir}/scripts/hn.py story <id> --comments 20 # More comments
```

### Search
```bash
uv run {baseDir}/scripts/hn.py search "AI agents"      # Search stories
uv run {baseDir}/scripts/hn.py search "Claude" -n 5    # Limit results
```

## API

Uses the official [Hacker News API](https://github.com/HackerNews/API) (no auth required).
