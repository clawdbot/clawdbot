---
title: "Showcase"
description: "Real-world OpenClaw projects from the community"
summary: "Community-built projects and integrations powered by OpenClaw"
read_when:
  - Looking for real OpenClaw usage examples
  - Updating community project highlights
---

<!-- markdownlint-disable MD033 -->

# Showcase

<div className="showcase-hero">
  <p className="showcase-kicker">Built in chats, terminals, browsers, and living rooms</p>
  <p className="showcase-lead">
    OpenClaw projects are not toy demos. People are shipping PR review loops, mobile apps, home automation,
    voice systems, devtools, and memory-heavy workflows from the channels they already use.
  </p>
  <div className="showcase-actions">
    <a href="#videos">Watch demos</a>
    <a href="#fresh-from-discord">Browse projects</a>
    <a href="https://discord.gg/clawd">Share yours</a>
  </div>
  <div className="showcase-highlights">
    <div className="showcase-highlight">
      <strong>Chat-native builds</strong>
      <span>Telegram, WhatsApp, Discord, Beeper, web chat, and terminal-first workflows.</span>
    </div>
    <div className="showcase-highlight">
      <strong>Real automation</strong>
      <span>Booking, shopping, support, reporting, and browser control without waiting for an API.</span>
    </div>
    <div className="showcase-highlight">
      <strong>Local + physical world</strong>
      <span>Printers, vacuums, cameras, health data, home systems, and personal knowledge bases.</span>
    </div>
  </div>
</div>

<Info>
**Want to be featured?** Share your project in [#self-promotion on Discord](https://discord.gg/clawd) or [tag @openclaw on X](https://x.com/openclaw).
</Info>

<div className="showcase-jump-links">
  <a href="#videos">Videos</a>
  <a href="#fresh-from-discord">Fresh from Discord</a>
  <a href="#automation-workflows">Automation</a>
  <a href="#knowledge-memory">Memory</a>
  <a href="#voice-phone">Voice &amp; Phone</a>
  <a href="#infrastructure-deployment">Infrastructure</a>
  <a href="#home-hardware">Home &amp; Hardware</a>
  <a href="#community-projects">Community</a>
  <a href="#submit-your-project">Submit a project</a>
</div>

<h2 id="videos">Videos</h2>

<p className="showcase-section-intro">
  Start here if you want the shortest path from “what is this?” to “okay, I get it.”
</p>

<div className="showcase-video-grid">
  <div className="showcase-video-card">
    <div className="showcase-video-shell">
      <iframe
        src="https://www.youtube-nocookie.com/embed/SaWSPZoPX34"
        title="OpenClaw: The self-hosted AI that Siri should have been (Full setup)"
        loading="lazy"
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
        allowFullScreen
      />
    </div>
    <h3>Full setup walkthrough</h3>
    <p>VelvetShark, 28 minutes. Install, onboard, and get to a first working assistant end to end.</p>
    <a href="https://www.youtube.com/watch?v=SaWSPZoPX34">Watch on YouTube</a>
  </div>

  <div className="showcase-video-card">
    <div className="showcase-video-shell">
      <iframe
        src="https://www.youtube-nocookie.com/embed/mMSKQvlmFuQ"
        title="OpenClaw showcase video"
        loading="lazy"
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
        allowFullScreen
      />
    </div>
    <h3>Community showcase reel</h3>
    <p>A faster pass across real projects, surfaces, and workflows built around OpenClaw.</p>
    <a href="https://www.youtube.com/watch?v=mMSKQvlmFuQ">Watch on YouTube</a>
  </div>

  <div className="showcase-video-card">
    <div className="showcase-video-shell">
      <iframe
        src="https://www.youtube-nocookie.com/embed/5kkIJNUGFho"
        title="OpenClaw community showcase"
        loading="lazy"
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
        allowFullScreen
      />
    </div>
    <h3>Projects in the wild</h3>
    <p>Examples from the community, from chat-native coding loops to hardware and personal automation.</p>
    <a href="https://www.youtube.com/watch?v=5kkIJNUGFho">Watch on YouTube</a>
  </div>
</div>

<h2 id="fresh-from-discord">Fresh from Discord</h2>

<p className="showcase-section-intro">
  Recent standouts across coding, devtools, mobile, and chat-native product building.
</p>

<CardGroup cols={2}>

<Card title="PR Review → Telegram Feedback" icon="code-pull-request" href="https://x.com/i/status/2010878524543131691">
  **@bangnokia** • `review` `github` `telegram`

OpenCode finishes the change → opens a PR → OpenClaw reviews the diff and replies in Telegram with “minor suggestions” plus a clear merge verdict (including critical fixes to apply first).

  <img src="/assets/showcase/pr-review-telegram.jpg" alt="OpenClaw PR review feedback delivered in Telegram" />
</Card>

<Card title="Wine Cellar Skill in Minutes" icon="wine-glass" href="https://x.com/i/status/2010916352454791216">
  **@prades_maxime** • `skills` `local` `csv`

Asked “Robby” (@openclaw) for a local wine cellar skill. It requests a sample CSV export + where to store it, then builds/tests the skill fast (962 bottles in the example).

  <img src="/assets/showcase/wine-cellar-skill.jpg" alt="OpenClaw building a local wine cellar skill from CSV" />
</Card>

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

Desktop app to manage skills/commands across Agents, Claude, Codex, and OpenClaw.

  <img src="/assets/showcase/agents-ui.jpg" alt="Agents UI app" />
</Card>

<Card title="Telegram Voice Notes (papla.media)" icon="microphone" href="https://papla.media/docs">
  **Community** • `voice` `tts` `telegram`

Wraps papla.media TTS and sends results as Telegram voice notes (no annoying autoplay).

  <img src="/assets/showcase/papla-tts.jpg" alt="Telegram voice note output from TTS" />
</Card>

<Card title="CodexMonitor" icon="eye" href="https://clawhub.ai/odrobnik/codexmonitor">
  **@odrobnik** • `devtools` `codex` `brew`

Homebrew-installed helper to list/inspect/watch local OpenAI Codex sessions (CLI + VS Code).

  <img src="/assets/showcase/codexmonitor.png" alt="CodexMonitor on ClawHub" />
</Card>

<Card title="Bambu 3D Printer Control" icon="print" href="https://clawhub.ai/tobiasbischoff/bambu-cli">
  **@tobiasbischoff** • `hardware` `3d-printing` `skill`

Control and troubleshoot BambuLab printers: status, jobs, camera, AMS, calibration, and more.

  <img src="/assets/showcase/bambu-cli.png" alt="Bambu CLI skill on ClawHub" />
</Card>

<Card title="Vienna Transport (Wiener Linien)" icon="train" href="https://clawhub.ai/hjanuschka/wienerlinien">
  **@hjanuschka** • `travel` `transport` `skill`

Real-time departures, disruptions, elevator status, and routing for Vienna's public transport.

  <img src="/assets/showcase/wienerlinien.png" alt="Wiener Linien skill on ClawHub" />
</Card>

<Card title="ParentPay School Meals" icon="utensils">
  **@George5562** • `automation` `browser` `parenting`

Automated UK school meal booking via ParentPay. Uses mouse coordinates for reliable table cell clicking.
</Card>

<Card title="R2 Upload (Send Me My Files)" icon="cloud-arrow-up" href="https://clawhub.ai/skills/r2-upload">
  **@julianengel** • `files` `r2` `presigned-urls`

Upload to Cloudflare R2/S3 and generate secure presigned download links. Perfect for remote OpenClaw instances.
</Card>

<Card title="iOS App via Telegram" icon="mobile">
  **@coard** • `ios` `xcode` `testflight`

Built a complete iOS app with maps and voice recording, deployed to TestFlight entirely via Telegram chat.

  <img src="/assets/showcase/ios-testflight.jpg" alt="iOS app on TestFlight" />
</Card>

<Card title="Oura Ring Health Assistant" icon="heart-pulse">
  **@AS** • `health` `oura` `calendar`

Personal AI health assistant integrating Oura ring data with calendar, appointments, and gym schedule.

  <img src="/assets/showcase/oura-health.png" alt="Oura ring health assistant" />
</Card>
<Card title="Kev's Dream Team (14+ Agents)" icon="robot" href="https://github.com/adam91holt/orchestrated-ai-articles">
  **@adam91holt** • `multi-agent` `orchestration` `architecture` `manifesto`

14+ agents under one gateway with Opus 4.5 orchestrator delegating to Codex workers. Comprehensive [technical write-up](https://github.com/adam91holt/orchestrated-ai-articles) covering the Dream Team roster, model selection, sandboxing, webhooks, heartbeats, and delegation flows. [Clawdspace](https://github.com/adam91holt/clawdspace) for agent sandboxing. [Blog post](https://adams-ai-journey.ghost.io/2026-the-year-of-the-orchestrator/).
</Card>

<Card title="Linear CLI" icon="terminal" href="https://github.com/Finesssee/linear-cli">
  **@NessZerra** • `devtools` `linear` `cli` `issues`

CLI for Linear that integrates with agentic workflows (Claude Code, OpenClaw). Manage issues, projects, and workflows from the terminal. First external PR merged!
</Card>

<Card title="Beeper CLI" icon="message" href="https://github.com/blqke/beepcli">
  **@jules** • `messaging` `beeper` `cli` `automation`

Read, send, and archive messages via Beeper Desktop. Uses Beeper local MCP API so agents can manage all your chats (iMessage, WhatsApp, etc.) in one place.
</Card>

</CardGroup>

<h2 id="automation-workflows">Automation &amp; Workflows</h2>

<p className="showcase-section-intro">
  Scheduling, browser control, support loops, and the “just do the task for me” side of the product.
</p>

<CardGroup cols={2}>

<Card title="Winix Air Purifier Control" icon="wind" href="https://x.com/antonplex/status/2010518442471006253">
  **@antonplex** • `automation` `hardware` `air-quality`

Claude Code discovered and confirmed the purifier controls, then OpenClaw takes over to manage room air quality.

  <img src="/assets/showcase/winix-air-purifier.jpg" alt="Winix air purifier control via OpenClaw" />
</Card>

<Card title="Pretty Sky Camera Shots" icon="camera" href="https://x.com/signalgaining/status/2010523120604746151">
  **@signalgaining** • `automation` `camera` `skill` `images`

Triggered by a roof camera: ask OpenClaw to snap a sky photo whenever it looks pretty — it designed a skill and took the shot.

  <img src="/assets/showcase/roof-camera-sky.jpg" alt="Roof camera sky snapshot captured by OpenClaw" />
</Card>

<Card title="Visual Morning Briefing Scene" icon="robot" href="https://x.com/buddyhadry/status/2010005331925954739">
  **@buddyhadry** • `automation` `briefing` `images` `telegram`

A scheduled prompt generates a single "scene" image each morning (weather, tasks, date, favorite post/quote) via an OpenClaw persona.
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

<Card title="Jira Skill Builder" icon="diagram-project" href="https://x.com/jdrhyne/status/2008336434827002232">
  **@jdrhyne** • `automation` `jira` `skill` `devtools`

OpenClaw connected to Jira, then generated a new skill on the fly (before it existed on ClawHub).
</Card>

<Card title="Todoist Skill via Telegram" icon="list-check" href="https://x.com/iamsubhrajyoti/status/2009949389884920153">
  **@iamsubhrajyoti** • `automation` `todoist` `skill` `telegram`

Automated Todoist tasks and had OpenClaw generate the skill directly in Telegram chat.
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

<h2 id="knowledge-memory">Knowledge &amp; Memory</h2>

<p className="showcase-section-intro">
  Systems that index, search, remember, and reason over personal or team knowledge.
</p>

<CardGroup cols={2}>

<Card title="xuezh Chinese Learning" icon="language" href="https://github.com/joshp123/xuezh">
  **@joshp123** • `learning` `voice` `skill`
  
  Chinese learning engine with pronunciation feedback and study flows via OpenClaw.
  
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

<h2 id="voice-phone">Voice &amp; Phone</h2>

<p className="showcase-section-intro">
  Speech-first entry points, phone bridges, and transcription-heavy workflows.
</p>

<CardGroup cols={2}>

<Card title="Clawdia Phone Bridge" icon="phone" href="https://github.com/alejandroOPI/clawdia-bridge">
  **@alejandroOPI** • `voice` `vapi` `bridge`
  
  Vapi voice assistant ↔ OpenClaw HTTP bridge. Near real-time phone calls with your agent.
</Card>

<Card title="OpenRouter Transcription" icon="microphone" href="https://clawhub.ai/obviyus/openrouter-transcribe">
  **@obviyus** • `transcription` `multilingual` `skill`

Multi-lingual audio transcription via OpenRouter (Gemini, etc). Available on ClawHub.
</Card>

</CardGroup>

<h2 id="infrastructure-deployment">Infrastructure &amp; Deployment</h2>

<p className="showcase-section-intro">
  Packaging, deployment, and integrations that make OpenClaw easier to run and extend.
</p>

<CardGroup cols={2}>

<Card title="Home Assistant Add-on" icon="home" href="https://github.com/ngutman/openclaw-ha-addon">
  **@ngutman** • `homeassistant` `docker` `raspberry-pi`
  
  OpenClaw gateway running on Home Assistant OS with SSH tunnel support and persistent state.
</Card>

<Card title="Home Assistant Skill" icon="toggle-on" href="https://clawhub.ai/skills/homeassistant">
  **ClawHub** • `homeassistant` `skill` `automation`
  
  Control and automate Home Assistant devices via natural language.
</Card>

<Card title="Nix Packaging" icon="snowflake" href="https://github.com/openclaw/nix-openclaw">
  **@openclaw** • `nix` `packaging` `deployment`
  
  Batteries-included nixified OpenClaw configuration for reproducible deployments.
</Card>

<Card title="CalDAV Calendar" icon="calendar" href="https://clawhub.ai/skills/caldav-calendar">
  **ClawHub** • `calendar` `caldav` `skill`
  
  Calendar skill using khal/vdirsyncer. Self-hosted calendar integration.
</Card>

</CardGroup>

<h2 id="home-hardware">Home &amp; Hardware</h2>

<p className="showcase-section-intro">
  The physical-world side of OpenClaw: homes, sensors, cameras, vacuums, and other devices.
</p>

<CardGroup cols={2}>

<Card title="GoHome Automation" icon="house-signal" href="https://github.com/joshp123/gohome">
  **@joshp123** • `home` `nix` `grafana`
  
  Nix-native home automation with OpenClaw as the interface, plus beautiful Grafana dashboards.
  
  <img src="/assets/showcase/gohome-grafana.png" alt="GoHome Grafana dashboard" />
</Card>

<Card title="Roborock Vacuum" icon="robot" href="https://github.com/joshp123/gohome/tree/main/plugins/roborock">
  **@joshp123** • `vacuum` `iot` `plugin`
  
  Control your Roborock robot vacuum through natural conversation.
  
  <img src="/assets/showcase/roborock-screenshot.jpg" alt="Roborock status" />
</Card>

</CardGroup>

<h2 id="community-projects">Community Projects</h2>

<p className="showcase-section-intro">
  Things that grew beyond a single workflow into broader products or ecosystems.
</p>

<CardGroup cols={2}>

<Card title="StarSwap Marketplace" icon="star" href="https://star-swap.com/">
  **Community** • `marketplace` `astronomy` `webapp`
  
  Full astronomy gear marketplace. Built with/around the OpenClaw ecosystem.
</Card>

</CardGroup>

---

<h2 id="submit-your-project">Submit Your Project</h2>

<p className="showcase-section-intro">
  If you are building something interesting with OpenClaw, send it over. Strong screenshots and concrete outcomes help.
</p>

Have something to share? We'd love to feature it!

<Steps>
  <Step title="Share It">
    Post in [#self-promotion on Discord](https://discord.gg/clawd) or [tweet @openclaw](https://x.com/openclaw)
  </Step>
  <Step title="Include Details">
    Tell us what it does, link to the repo/demo, share a screenshot if you have one
  </Step>
  <Step title="Get Featured">
    We'll add standout projects to this page
  </Step>
</Steps>
