---
summary: "Real-world showcases of what Clawdbot can do"
read_when:
  - You want inspiration or proof of capability
---
# Showcase

Real projects from the community. Highlights from #showcase (Jan 2–5, 2026).

## Automation & real-world outcomes
- **Grocery autopilot (Picnic)** — Skill built around an unofficial Picnic API client. Pulls order history, infers preferred brands, maps recipes to cart, completes order in minutes. https://github.com/timkrase/clawdis-picnic-skill
- **Grocery autopilot (Picnic, alt)** — Another Picnic-based skill built via the `picnic-api` package. https://github.com/MRVDH/picnic-api
- **German rail planning** — Go CLI for Deutsche Bahn; skill picks best connections given time windows and preferences. https://github.com/timkrase/dbrest-cli + https://github.com/timkrase/clawdis-skills/tree/main/db-bahn
- **Accounting intake** — Collect PDFs from email, prep for tax consultant (monthly accounting batch). (No link shared.)

## Knowledge & memory systems
- **WhatsApp memory vault** — Ingests full exports, transcribes 1k+ voice notes, cross‑checks with git logs, outputs linked MD reports + ongoing indexing. (No link shared.)
- **Karakeep semantic search** — Sidecar adds vector search to Karakeep bookmarks (Qdrant + OpenAI/Ollama), includes Clawdis skill. https://github.com/jamesbrooksco/karakeep-semantic-search
- **Inside‑Out‑2 style memory** — Separate memory manager app turns session files into memories → beliefs → self model. (No link shared.)

## Voice, docs, and assistants on the phone
- **Clawdia phone bridge** — Vapi voice assistant ↔ Clawdis HTTP bridge; near‑real‑time phone calls. https://github.com/alejandroOPI/clawdia-bridge
- **Google Docs edit skill** — Rich‑text editing skill built fast with Claude Code. (No link shared.)
- **OpenRouter transcription skill** — Multi‑lingual audio transcription via OpenRouter (Gemini etc). ClawdHub: https://clawdhub.com/obviyus/openrouter-transcribe (user/slug link)

## Infrastructure & deployment
- **Home Assistant OS gateway add‑on** — Clawdbot gateway running on HA OS (Raspberry Pi), with SSH tunnel support + persistent state in /config. https://github.com/ngutman/clawdbot-ha-addon
- **Home Assistant skill** — Control/automate HA via ClawdHub. https://clawdhub.com/skills/homeassistant
- **Nix packaging** — Batteries‑included nixified clawdis config. https://github.com/joshp123/nix-clawdis
- **CalDAV skill** — khal/vdirsyncer based calendar skill. ClawdHub: caldav-calendar → https://clawdhub.com/skills/caldav-calendar

## Home + hardware
- **Roborock integration** — Plugin for robot vacuum control. https://github.com/joshp123/gohome/tree/main/plugins/roborock

## Community builds (non‑Clawdis but made with/around it)
- **StarSwap marketplace** — Full astronomy gear marketplace. https://star-swap.com/
