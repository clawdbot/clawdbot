---
summary: "Which OpenAI capabilities OpenClaw exposes, embeddings, and spend reporting"
read_when:
  - You want to know which OpenAI capability maps to which OpenClaw surface
  - You are reconciling subscription quota against Platform API billing
  - You are pointing memory_search at OpenAI embeddings
title: "OpenAI coverage and cost"
sidebarTitle: "Coverage and cost"
---

## Usage and cost tracking

OpenClaw keeps subscription quota and Platform API billing distinct:

- ChatGPT/Codex OAuth shows the subscription plan, quota windows, and credit balance.
- `OPENAI_ADMIN_KEY` shows 30 days of provider-reported organization cost and completions usage in Control UI **Usage**, including daily spend, request/token totals, top models, and cost categories.
- `OPENAI_PROJECT_ID` optionally scopes Admin API history to one project.
- OpenClaw never sends `OPENAI_API_KEY` or an `openai` inference profile to organization APIs; those credentials may belong to custom, Azure, or agent-local endpoints.

An explicit Admin key takes precedence over OAuth. Provider-reported history is not merged with OpenClaw's session-derived estimated cost; it can include API activity from other clients and provider-side billing adjustments.

OpenAI's [API Usage Dashboard](https://help.openai.com/en/articles/10478918) documentation describes the organization-owner and explicit Usage Dashboard permission requirements for usage data.

Provider, model, runtime, and channel are separate layers. If those labels are
getting mixed together, read [Agent runtimes](/concepts/agent-runtimes) before
changing config.

## OpenClaw feature coverage

| OpenAI capability         | OpenClaw surface                                                                              | Status                                                             |
| ------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Chat / Responses          | `openai/<model>` model provider                                                               | Yes                                                                |
| Codex subscription models | `openai/<model>` with OpenAI OAuth                                                            | Yes                                                                |
| Legacy Codex model refs   | old Codex model refs, `codex-cli/<model>`                                                     | Repaired by doctor to `openai/<model>`                             |
| Codex app-server harness  | Codex-compatible HTTPS route with runtime unset/`auto`, or explicit `agentRuntime.id: codex`  | Yes                                                                |
| Server-side web search    | Native OpenAI Responses tool                                                                  | Yes, when web search is enabled and no other provider is pinned    |
| Images                    | `image_generate`                                                                              | Yes                                                                |
| Videos                    | `video_generate`                                                                              | Yes                                                                |
| Text-to-speech            | `tts.provider: "openai"` / `tts`                                                              | Yes                                                                |
| Batch speech-to-text      | `tools.media.audio` / media understanding                                                     | Yes                                                                |
| Streaming speech-to-text  | Voice Call `streaming.provider: "openai"`                                                     | Yes                                                                |
| Realtime voice            | Voice Call `realtime.provider: "openai"` / Control UI Talk `talk.realtime.provider: "openai"` | Yes (auth order depends on the selected Realtime route; see below) |
| Embeddings                | memory embedding provider                                                                     | Yes                                                                |

<Note>
Released GPT-Live browser and Gateway-relay WebRTC try an OpenClaw ChatGPT OAuth
profile first and fall back to Platform API-key auth. Ordinary GA browser
Realtime tries Platform auth first and falls back to OAuth only when no Platform
credential source is configured. Direct backend sockets and unlisted or private
realtime routes require Platform API-key auth.

Platform auth is resolved in this order: configured realtime API key, `openai`
API-key profile, then `OPENAI_API_KEY`. Voice Call, Discord realtime voice,
direct backend sockets, unlisted or private realtime routes, and realtime
transcription still require Platform auth.

If API-key auth reports missing billing, top up Platform credits at
[platform.openai.com/account/billing](https://platform.openai.com/account/billing)
for the organization backing your realtime credentials when using API-key
auth. Realtime voice accepts the `openai` API-key auth profile created by
`openclaw onboard --auth-choice openai-api-key`, a Platform API key set via
`talk.realtime.providers.openai.apiKey` for Control UI Talk, or
`plugins.entries.voice-call.config.realtime.providers.openai.apiKey` for Voice
Call, or the `OPENAI_API_KEY` environment variable.

In Control UI Video Talk with Platform auth, OpenAI WebRTC receives camera context on demand:
when the model calls `describe_view`, the browser sends one bounded JPEG over
the realtime data channel. OpenClaw does not attach a continuous camera track
to the OpenAI session.
</Note>

## Memory embeddings

OpenClaw can use OpenAI, or an OpenAI-compatible embedding endpoint, for
`memory_search` indexing and query embeddings:

```json5
{
  memory: {
    search: {
      provider: "openai",
      model: "text-embedding-3-small",
    },
  },
}
```

For OpenAI-compatible endpoints that require asymmetric embedding labels, set
`queryInputType` and `documentInputType` under `memory.search`. OpenClaw
forwards these as provider-specific `input_type` request fields: query
embeddings use `queryInputType`; indexed memory chunks and batch indexing use
`documentInputType`. See the
[Memory configuration reference](/reference/memory-config#provider-specific-config)
for the full example.
