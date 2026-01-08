---
title: "Showcase"
description: "Real-world Clawdbot projects from the community"
---

# Showcase

Real projects from the community. See what people are building with Clawdbot.

<Info>
**Want to be featured?** Share your project in [#showcase on Discord](https://discord.gg/clawdbot) or [tag @clawdbot on X](https://x.com/clawdbot).
</Info>

## 🤖 Automation & Workflows

<CardGroup cols={2}>

<Card title="Grocery Autopilot" icon="cart-shopping" href="https://github.com/timkrase/clawdis-picnic-skill">
  **@timkrase** • `automation` `groceries` `api`
  
  Skill built around the Picnic API. Pulls order history, infers preferred brands, maps recipes to cart, completes orders in minutes.
</Card>

<Card title="German Rail Planning" icon="train" href="https://github.com/timkrase/clawdis-skills/tree/main/db-bahn">
  **@timkrase** • `automation` `travel` `cli`
  
  Go CLI for Deutsche Bahn; skill picks best train connections given time windows and preferences.
</Card>

<Card title="Padel Court Booking" icon="calendar-check" href="https://github.com/joshp123/padel-cli">
  **@joshp123** • `automation` `booking` `cli`
  
  Playtomic availability checker + booking CLI. Never miss an open court again.
  
  <img src="/assets/showcase/padel-screenshot.jpg" alt="padel-cli screenshot" />
</Card>

<Card title="Accounting Intake" icon="file-invoice-dollar">
  **Community** • `automation` `email` `pdf`
  
  Collects PDFs from email, preps documents for tax consultant. Monthly accounting on autopilot.
</Card>

<Card title="Couch Potato Dev Mode" icon="couch" href="https://davekiss.com">
  **@davekiss** • `telegram` `website` `migration` `astro`
  
  Rebuilt entire personal site via Telegram while watching Netflix — Notion → Astro, 18 posts migrated, DNS to Cloudflare. Never opened a laptop.
</Card>

</CardGroup>

## 🧠 Knowledge & Memory

<CardGroup cols={2}>

<Card title="xuezh Chinese Learning" icon="language" href="https://github.com/joshp123/xuezh">
  **@joshp123** • `learning` `voice` `skill`
  
  Chinese learning engine with pronunciation feedback and study flows via Clawdbot.
  
  <img src="/assets/showcase/xuezh-pronunciation.jpeg" alt="xuezh pronunciation feedback" />
</Card>

<Card title="WhatsApp Memory Vault" icon="vault">
  **Community** • `memory` `transcription` `indexing`
  
  Ingests full WhatsApp exports, transcribes 1k+ voice notes, cross-checks with git logs, outputs linked markdown reports.
</Card>

<Card title="Karakeep Semantic Search" icon="magnifying-glass" href="https://github.com/jamesbrooksco/karakeep-semantic-search">
  **@jamesbrooksco** • `search` `vector` `bookmarks`
  
  Adds vector search to Karakeep bookmarks using Qdrant + OpenAI/Ollama embeddings.
</Card>

<Card title="Inside-Out-2 Memory" icon="brain">
  **Community** • `memory` `beliefs` `self-model`
  
  Separate memory manager that turns session files into memories → beliefs → evolving self model.
</Card>

</CardGroup>

## 🎙️ Voice & Phone

<CardGroup cols={2}>

<Card title="Clawdia Phone Bridge" icon="phone" href="https://github.com/alejandroOPI/clawdia-bridge">
  **@alejandroOPI** • `voice` `vapi` `bridge`
  
  Vapi voice assistant ↔ Clawdbot HTTP bridge. Near real-time phone calls with your agent.
</Card>

<Card title="OpenRouter Transcription" icon="microphone" href="https://clawdhub.com/obviyus/openrouter-transcribe">
  **@obviyus** • `transcription` `multilingual` `skill`
  
  Multi-lingual audio transcription via OpenRouter (Gemini, etc). Available on ClawdHub.
</Card>

<Card title="Google Docs Editor" icon="file-word">
  **Community** • `docs` `editing` `skill`
  
  Rich-text Google Docs editing skill. Built rapidly with Claude Code.
</Card>

</CardGroup>

## 🏗️ Infrastructure & Deployment

<CardGroup cols={2}>

<Card title="Home Assistant Add-on" icon="home" href="https://github.com/ngutman/clawdbot-ha-addon">
  **@ngutman** • `homeassistant` `docker` `raspberry-pi`
  
  Clawdbot gateway running on Home Assistant OS with SSH tunnel support and persistent state.
</Card>

<Card title="Home Assistant Skill" icon="toggle-on" href="https://clawdhub.com/skills/homeassistant">
  **ClawdHub** • `homeassistant` `skill` `automation`
  
  Control and automate Home Assistant devices via natural language.
</Card>

<Card title="Nix Packaging" icon="snowflake" href="https://github.com/clawdbot/nix-clawdbot">
  **@clawdbot** • `nix` `packaging` `deployment`
  
  Batteries-included nixified Clawdbot configuration for reproducible deployments.
</Card>

<Card title="CalDAV Calendar" icon="calendar" href="https://clawdhub.com/skills/caldav-calendar">
  **ClawdHub** • `calendar` `caldav` `skill`
  
  Calendar skill using khal/vdirsyncer. Self-hosted calendar integration.
</Card>

</CardGroup>

## 🏠 Home & Hardware

<CardGroup cols={2}>

<Card title="GoHome Automation" icon="house-signal" href="https://github.com/joshp123/gohome">
  **@joshp123** • `home` `nix` `grafana`
  
  Nix-native home automation with Clawdbot as the interface, plus beautiful Grafana dashboards.
  
  <img src="/assets/showcase/gohome-grafana.png" alt="GoHome Grafana dashboard" />
</Card>

<Card title="Roborock Vacuum" icon="robot" href="https://github.com/joshp123/gohome/tree/main/plugins/roborock">
  **@joshp123** • `vacuum` `iot` `plugin`
  
  Control your Roborock robot vacuum through natural conversation.
  
  <img src="/assets/showcase/roborock-screenshot.jpg" alt="Roborock status" />
</Card>

</CardGroup>

## 🌟 Community Projects

<CardGroup cols={2}>

<Card title="StarSwap Marketplace" icon="star" href="https://star-swap.com/">
  **Community** • `marketplace` `astronomy` `webapp`
  
  Full astronomy gear marketplace. Built with/around the Clawdbot ecosystem.
</Card>

</CardGroup>

---

## Submit Your Project

Have something to share? We'd love to feature it!

<Steps>
  <Step title="Share It">
    Post in [#showcase on Discord](https://discord.gg/clawdbot) or [tweet @clawdbot](https://x.com/clawdbot)
  </Step>
  <Step title="Include Details">
    Tell us what it does, link to the repo/demo, share a screenshot if you have one
  </Step>
  <Step title="Get Featured">
    We'll add standout projects to this page
  </Step>
</Steps>
