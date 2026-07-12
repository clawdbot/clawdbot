---
summary: "Anthropic models, Claude CLI, and native Claude session catalog."
read_when:
  - You are installing, configuring, or auditing the anthropic plugin
title: "Anthropic plugin"
---

# Anthropic plugin

Anthropic models, Claude CLI, and native Claude session catalog.

## Distribution

- Package: `@openclaw/anthropic-provider`
- Install route: included in OpenClaw

## Surface

providers: anthropic; contracts: mediaUnderstandingProviders, usageProviders

<!-- openclaw-plugin-reference:manual-start -->

node commands: anthropic.claude.sessions.list.v1,
anthropic.claude.sessions.read.v1; contracts: mediaUnderstandingProviders,
usageProviders

<!-- openclaw-plugin-reference:manual-end -->

## Related docs

- [anthropic](/providers/anthropic)
