---
title: "Showcase"
description: "Real-world Clawdbot projects from the community"
summary: "Community-built projects and integrations powered by Clawdbot"
---

# Showcase

Real projects from the community. See what people are building with Clawdbot.

<Info>
**Want to be featured?** Share your project in [#showcase on Discord](https://discord.gg/clawdbot) or [tag @clawdbot on X](https://x.com/clawdbot).
</Info>

## 🎥 Clawdbot in Action

Full setup walkthrough (28m) by VelvetShark.

<div
  style={{
    position: "relative",
    paddingBottom: "56.25%",
    height: 0,
    overflow: "hidden",
    borderRadius: 16,
  }}
>
  <iframe
    src="https://www.youtube-nocookie.com/embed/SaWSPZoPX34"
    title="Clawdbot: The self-hosted AI that Siri should have been (Full setup)"
    style={{ position: "absolute", top: 0, left: 0, width: "100%", height: "100%" }}
    frameBorder="0"
    loading="lazy"
    allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
    allowFullScreen
  />
</div>

[Watch on YouTube](https://www.youtube.com/watch?v=SaWSPZoPX34)

## 🆕 Fresh from Discord

<CardGroup cols={2}>

<Card title="Tesco Shop Autopilot" icon="cart-shopping" href="https://x.com/i/status/2009724862470689131">
  **@marchattonhere** • `automation` `browser` `shopping`

  Weekly meal plan → regulars → book delivery slot → confirm order. No APIs, just browser control.

  <img src="/assets/showcase/tesco-shop.jpg" alt="Tesco shop automation via chat" />
</Card>

<Card title="SNAG Screenshot-to-Markdown" icon="scissors" href="https://github.com/am-will/snag">
  **@am-will** • `devtools` `screenshots` `markdown`

  Hotkey a screen region → Gemini vision → instant Markdown in your clipboard.

  <img src="/assets/showcase/snag.png" alt="SNAG screenshot-to-markdown tool" />
</Card>

<Card title="Agents UI" icon="window-maximize" href="https://releaseflow.net/kitze/agents-ui">
  **@kitze** • `ui` `skills` `sync`

  Desktop app to manage skills/commands across Agents, Claude, Codex, and Clawdbot.

  <img src="/assets/showcase/agents-ui.jpg" alt="Agents UI app" />
</Card>

<Card title="Telegram Voice Notes (papla.media)" icon="microphone" href="https://papla.media/docs">
  **Community** • `voice` `tts` `telegram`

  Wraps papla.media TTS and sends results as Telegram voice notes (no annoying autoplay).

  <img src="/assets/showcase/papla-tts.jpg" alt="Telegram voice note output from TTS" />
</Card>

<Card title="CodexMonitor" icon="eye" href="https://clawdhub.com/odrobnik/codexmonitor">
  **@odrobnik** • `devtools` `codex` `brew`

  Homebrew-installed helper to list/inspect/watch local OpenAI Codex sessions (CLI + VS Code).

  <img src="/assets/showcase/codexmonitor.png" alt="CodexMonitor on ClawdHub" />
</Card>

<Card title="Bambu 3D Printer Control" icon="print" href="https://clawdhub.com/tobiasbischoff/bambu-cli">
  **@tobiasbischoff** • `hardware` `3d-printing` `skill`

  Control and troubleshoot BambuLab printers: status, jobs, camera, AMS, calibration, and more.

  <img src="/assets/showcase/bambu-cli.png" alt="Bambu CLI skill on ClawdHub" />
</Card>

<Card title="Vienna Transport (Wiener Linien)" icon="train" href="https://clawdhub.com/hjanuschka/wienerlinien">
  **@hjanuschka** • `travel` `transport` `skill`

  Real-time departures, disruptions, elevator status, and routing for Vienna's public transport.

  <img src="/assets/showcase/wienerlinien.png" alt="Wiener Linien skill on ClawdHub" />
</Card>

<Card title="ParentPay School Meals" icon="utensils" href="#">
  **@George5562** • `automation` `browser` `parenting`

  Automated UK school meal booking via ParentPay. Uses mouse coordinates for reliable table cell clicking.
</Card>

<Card title="R2 Upload (Send Me My Files)" icon="cloud-arrow-up" href="https://clawdhub.com/skills/r2-upload">
  **@julianengel** • `files` `r2` `presigned-urls`

  Upload to Cloudflare R2/S3 and generate secure presigned download links. Perfect for remote Clawdbot instances.
</Card>

<Card title="iOS App via Telegram" icon="mobile" href="#">
  **@coard** • `ios` `xcode` `testflight`

  Built a complete iOS app with maps and voice recording, deployed to TestFlight entirely via Telegram chat.

  <img src="/assets/showcase/ios-testflight.jpg" alt="iOS app on TestFlight" />
</Card>

<Card title="Oura Ring Health Assistant" icon="heart-pulse" href="#">
  **@AS** • `health` `oura` `calendar`

  Personal AI health assistant integrating Oura ring data with calendar, appointments, and gym schedule.

  <img src="/assets/showcase/oura-health.png" alt="Oura ring health assistant" />
</Card>
<Card title="Multi-Agent Swarm (14+ Agents)" icon="robot" href="https://github.com/adam91holt/clawdspace">
  **@adam91holt** • `multi-agent` `slack` `orchestration` `swarm`

  14+ Clawdbot agents under one gateway. Opus 4.5 orchestrator delegates to Codex workers. Self-maintaining agents that continuously improve. Open-sourced clawdspace for agent sandboxing.
</Card>
</CardGroup>

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

<Card title="Job Search Agent" icon="briefcase">
  **@attol8** • `automation` `api` `skill`

  Searches job listings, matches against CV keywords, and returns relevant opportunities with links. Built in 30 minutes using JSearch API.
</Card>

<Card title="TradingView Analysis" icon="chart-line">
  **@bheem1798** • `finance` `browser` `automation`

  Logs into TradingView via browser automation, screenshots charts, and performs technical analysis on demand. No API needed—just browser control.
</Card>

<Card title="Slack Auto-Support" icon="slack">
  **@henrymascot** • `slack` `automation` `support`

  Watches company Slack channel, responds helpfully, and forwards notifications to Telegram. Autonomously fixed a production bug in a deployed app without being asked.
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
