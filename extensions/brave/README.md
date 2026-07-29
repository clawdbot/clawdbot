# @openclaw/brave-plugin

Official Brave Search provider plugin for OpenClaw.

This plugin registers Brave as a `web_search` provider. It supports normal Brave web search and Brave LLM Context API mode.

## Install

```bash
openclaw plugins install @openclaw/brave-plugin
```

Restart the Gateway after installing or updating the plugin.

## Configure

Store a Brave Search API key in plugin config or expose `BRAVE_API_KEY` to the Gateway:

```bash
openclaw config set plugins.entries.brave.enabled true
openclaw config set tools.web.search.provider brave
```

Provider-specific options live under `plugins.entries.brave.config.webSearch.*`.

## Docs

Full setup, config examples, search modes, and tool parameters:

- https://docs.openclaw.ai/tools/brave-search

## Package

- Plugin id: `brave`
- Package: `@openclaw/brave-plugin`
- Minimum OpenClaw host: `2026.4.10`
