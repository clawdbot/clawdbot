---
summary: "Adds Anthropic models, Claude CLI runtime, and native Claude session browsing to OpenClaw."
read_when:
  - You are installing, configuring, or auditing the anthropic plugin
title: "Anthropic plugin"
---

# Anthropic plugin

Adds Anthropic model provider support, Claude CLI runtime integration, and a
read-only Claude CLI/Desktop session catalog across the Gateway and paired
nodes.

## Distribution

- Package: `@openclaw/anthropic-provider`
- Install route: included in OpenClaw

## Surface

providers: anthropic; CLI backend: claude-cli; Control UI: Claude Sessions;
node commands: anthropic.claude.sessions.list.v1,
anthropic.claude.sessions.read.v1; contracts: mediaUnderstandingProviders,
usageProviders

## Related docs

- [anthropic](/providers/anthropic)
