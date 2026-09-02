---
summary: "OpenClaw Anthropic Vertex provider plugin for Claude models on Google Vertex AI."
read_when:
  - You are installing, configuring, or auditing the anthropic-vertex plugin
title: "Anthropic Vertex plugin"
---

# Anthropic Vertex plugin

OpenClaw Anthropic Vertex provider plugin for Claude models on Google Vertex AI.

## Distribution

- Package: `@openclaw/anthropic-vertex-provider`
- Install route: npm; ClawHub

## Surface

providers: `anthropic-vertex`

<!-- openclaw-plugin-reference:manual-start -->

## Claude Fable 5

Use `anthropic-vertex/claude-fable-5` where the model is available in your Google Cloud region.
Fable 5 always uses adaptive thinking and defaults to `high` effort. `/think off` and
`/think minimal` use `low` effort because the model does not support disabling thinking.

## Claude Sonnet 5

Use `anthropic-vertex/claude-sonnet-5` with Vertex's `global`, `us`, or `eu`
endpoint. Sonnet 5 defaults to adaptive thinking at `high` effort and supports
`/think off` or the native `/think xhigh|max` levels. OpenClaw publishes its
1,000,000-token context window and 128,000-token output limit automatically.

Catalog pricing follows [Google's current Vertex pricing](https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing#anthropics-claude-models):
`$2/$10` per million input/output tokens for `global`, or `$2.20/$11` for
the `us` and `eu` multi-region endpoints. Cache hits and 5-minute cache writes
cost `$0.20/$2.50` globally or `$0.22/$2.75` in either multi-region endpoint,
per million tokens. These USD rates apply at both 200K input tokens or less
and above 200K input tokens.

<!-- openclaw-plugin-reference:manual-end -->
