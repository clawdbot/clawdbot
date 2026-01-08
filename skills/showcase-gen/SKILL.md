---
name: showcase-gen
description: Generate showcase entries from tweets, Discord messages, or text descriptions and submit as individual PRs to clawdbot/clawdbot.
---

# Showcase Generator

Generate and submit showcase entries to the Clawdbot docs.

## Trigger

When the user says something is "for the showcase" or shares a link/text for showcase purposes.

## Input Types

- **Tweet URL**: `https://x.com/username/status/123`
- **Discord link**: Fetch via browser or Discord API
- **Plain text**: User pastes description directly

## Workflow

1. **Parse input** — Extract author, description, links from whatever format
2. **Generate entry** — Create catchy title, summary, tags
3. **Create PR** — Each entry gets its own PR to `clawdbot/clawdbot`

## PR Process

```bash
# From ~/Git/clawd (which tracks clawdbot/clawdbot)
git checkout main
git pull upstream main
git checkout -b docs/showcase-[slug]

# Edit docs/start/showcase.md - add new Card in appropriate category
# Commit and push to fork
git add docs/start/showcase.md
git commit -m "docs(showcase): add [title] by @author"
git push fork docs/showcase-[slug]

# Create PR
gh pr create --repo clawdbot/clawdbot \
  --head dbhurley:docs/showcase-[slug] \
  --title "docs(showcase): add [title]" \
  --body "..."
```

## Card Format

```markdown
<Card title="Catchy Title" icon="icon-name" href="https://source-url">
  **@author** • `tag1` `tag2` `tag3`
  
  One-sentence description of the Clawdbot use case.
</Card>
```

## Categories & Icons

| Category | Section Header | Common Icons |
|----------|---------------|--------------|
| automation | 🤖 Automation & Workflows | `cart-shopping`, `train`, `calendar-check`, `robot` |
| knowledge | 🧠 Knowledge & Memory | `brain`, `language`, `magnifying-glass`, `vault` |
| voice | 🎙️ Voice & Phone | `phone`, `microphone`, `headset` |
| infrastructure | 🏗️ Infrastructure & Deployment | `home`, `server`, `docker`, `snowflake` |
| hardware | 🏠 Home & Hardware | `house-signal`, `lightbulb`, `robot` |
| community | 🌟 Community Projects | `star`, `users`, `rocket` |

## Tags

2-5 lowercase tags from:
- Platform: `telegram`, `whatsapp`, `discord`, `slack`
- Domain: `website`, `groceries`, `travel`, `calendar`, `email`, `home`
- Tech: `api`, `cli`, `docker`, `nix`, `astro`, `notion`
- Type: `skill`, `migration`, `bridge`, `addon`

## Example

**Input**: Tweet about rebuilding website via Telegram

**Output PR**:
- Branch: `docs/showcase-telegram-website-rebuild`
- Title: `docs(showcase): add "Couch Potato Dev Mode" by @davekiss`
- Adds Card to "🤖 Automation & Workflows" section
