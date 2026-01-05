---
name: web-search-with-gemini
description: 🔴 CUSTOM SKILL - Use this for deep research queries using Gemini with multi-perspective reasoning, answering in Russian.
metadata: {"clawdis":{"emoji":"🔍","requires":{"bins":["web_search_with_gemini"]},"install":[{"id":"manual","kind":"manual","instructions":"Script at scripts/web_search_with_gemini.sh"}]}}
---

# web-search-with-gemini [CUSTOM SKILL]

**This is a custom deep-research web search skill with ultrathink capability.**

## Features

- **Deep Research**: Multi-perspective reasoning for complex queries
- **Ultrathink Mode**: High-level thinking for nuanced answers
- **Russian Language**: All responses in Russian
- **Gemini Backend**: Uses Gemini models with advanced prompting

## Usage

The Pi agent will automatically use this skill for web searches when properly configured.

Direct usage:
```bash
./scripts/web_search_with_gemini.sh "Your deep research question"
```

With model selection:
```bash
./scripts/web_search_with_gemini.sh --model gemini-3-flash-preview "Latest AI trends"
```

## Configuration

This skill uses the prompt tail from `prompts/web-search-tail.yaml` which adds ultrathink directives.
