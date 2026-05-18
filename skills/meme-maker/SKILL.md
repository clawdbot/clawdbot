---
name: meme-maker
description: Search meme templates, suggest formats, and generate local or hosted image memes.
metadata: { "openclaw": { "emoji": "🖼️", "requires": { "bins": ["node"] } } }
---

# Meme Maker

Create meme drafts from a curated template registry without bundling copyrighted template images.

Quick start

- Search: `{baseDir}/scripts/meme.mjs search "bad choice"`
- Suggest: `{baseDir}/scripts/meme.mjs suggest "slow python image scripts"`
- Local SVG: `{baseDir}/scripts/meme.mjs render drake --text "Python cold starts" --text "Node sharp cache" --out /tmp/meme.svg`
- Local PNG: `{baseDir}/scripts/meme.mjs render drake --text "Maybe API" --text "Local render" --out /tmp/meme.png`
- Imgflip hosted: `{baseDir}/scripts/meme.mjs render drake --service imgflip --text "before" --text "after"`

Modes

- `local` is default. It downloads template images from their source URL with a browser-like user agent, caches them under the user cache dir, embeds the image in an SVG, and writes SVG. If `--out` ends in `.png`, it uses `sharp` when available.
- `imgflip` calls Imgflip `caption_image` and prints the hosted URL. It requires `IMGFLIP_USER` and `IMGFLIP_PASS` unless supplied via `--username` and `--password`.

Commands

- `list [--json]`: list the built-in curated templates.
- `search <query> [--json]`: search template names, aliases, tags, and use cases.
- `suggest <topic> [--limit N] [--json]`: rank templates for the topic.
- `render <template> --text TEXT ... [--out PATH] [--service local|imgflip]`: generate a meme.
- `refresh [--limit N] [--json]`: fetch current Imgflip top templates for research; do not overwrite the curated registry automatically.

Template registry

- Read `{baseDir}/references/templates.json` for the curated 20-template registry.
- Each entry includes Imgflip metadata, Know Your Meme link, aliases, tags, fields, and local text placement boxes.
- Prefer `suggest` first when the user describes a joke but does not know the format.

Hygiene

- Do not ship template image files in the skill.
- Do not use shared or hardcoded Imgflip credentials.
- Keep Know Your Meme lookups out of the render hot path; use KYM links for explanation/provenance only.
