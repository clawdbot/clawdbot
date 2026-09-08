---
summary: "Shared replay, stream, and tool-compat family builders for provider plugins"
read_when:
  - You want one builder to wire a whole provider family
  - You need the current replay and stream family tables
  - You are going off the common pattern and need the underlying SDK seams
title: "Provider hook families"
sidebarTitle: "Hook families"
---

Family builders wire the common replay, stream, and tool-compat hooks for a
provider in one call. Part of the [Building provider
plugins](/plugins/sdk-provider-plugins) guide.

## Family builders

Shared helper builders now cover the most common replay/tool-compat
families, so plugins usually do not need to hand-wire each hook one by one:

```typescript
import { buildProviderReplayFamilyHooks } from "openclaw/plugin-sdk/provider-model-shared";
import { buildProviderStreamFamilyHooks } from "openclaw/plugin-sdk/provider-stream";
import { buildProviderToolCompatFamilyHooks } from "openclaw/plugin-sdk/provider-tools";

const GOOGLE_FAMILY_HOOKS = {
  ...buildProviderReplayFamilyHooks({ family: "google-gemini" }),
  ...buildProviderStreamFamilyHooks("google-thinking"),
  ...buildProviderToolCompatFamilyHooks("gemini"),
};

api.registerProvider({
  id: "acme-gemini-compatible",
  // ...
  ...GOOGLE_FAMILY_HOOKS,
});
```

Available replay families today:

| Family                      | What it wires in                                                                                                                                                                                                                                                                   | Bundled examples                                    |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `openai-compatible`         | Shared OpenAI-style replay policy for OpenAI-compatible transports, including tool-call-id sanitation, assistant-first ordering fixes, and generic Gemini-turn validation where the transport needs it                                                                             | `moonshot`, `ollama`, `xai`, `zai`                  |
| `anthropic-by-model`        | Claude-aware replay policy chosen by `modelId`, so Anthropic-message transports only get Claude-specific thinking-block cleanup when the resolved model is actually a Claude id                                                                                                    | `amazon-bedrock`                                    |
| `native-anthropic-by-model` | Same Claude-by-model policy as `anthropic-by-model`, plus tool-call-id sanitation and native Anthropic tool-use id preservation for transports that must keep vendor-native ids                                                                                                    | `anthropic-vertex`, `clawrouter`                    |
| `google-gemini`             | Native Gemini replay policy plus bootstrap replay sanitation. The shared family keeps the text-output Gemini CLI on tagged reasoning; the direct `google` provider overrides `resolveReasoningOutputMode` to `native` because Gemini API thinking arrives as native thought parts. | `google`, `google-gemini-cli`                       |
| `passthrough-gemini`        | Gemini thought-signature sanitation for Gemini models running through OpenAI-compatible proxy transports; does not enable native Gemini replay validation or bootstrap rewrites                                                                                                    | `openrouter`, `kilocode`, `opencode`, `opencode-go` |
| `hybrid-anthropic-openai`   | Hybrid policy for providers that mix Anthropic-message and OpenAI-compatible model surfaces in one plugin; optional Claude-only thinking-block dropping stays scoped to the Anthropic side                                                                                         | `minimax`                                           |

Available stream families today:

| Family                      | What it wires in                                                                                                                                                                                       | Bundled examples              |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------- |
| `google-thinking`           | Gemini thinking payload normalization on the shared stream path                                                                                                                                        | `google`, `google-gemini-cli` |
| `kilocode-thinking`         | Kilo reasoning wrapper on the shared proxy stream path, with `kilo-auto/balanced` and unsupported proxy reasoning ids skipping injected thinking                                                       | `kilocode`                    |
| `moonshot-thinking`         | Moonshot binary native-thinking payload mapping from config + `/think` level                                                                                                                           | `moonshot`                    |
| `minimax-fast-mode`         | MiniMax fast-mode model rewrite on the shared stream path                                                                                                                                              | `minimax`, `minimax-portal`   |
| `openai-responses-defaults` | Shared native OpenAI/Codex Responses wrappers: attribution headers, `/fast`/`serviceTier`, text verbosity, native Codex web search, reasoning-compat payload shaping, and Responses context management | `openai`                      |
| `openrouter-thinking`       | OpenRouter reasoning wrapper for proxy routes, with unsupported-model/`auto` skips handled centrally                                                                                                   | `openrouter`                  |
| `tool-stream-default-on`    | Default-on `tool_stream` wrapper for providers like Z.AI that want tool streaming unless explicitly disabled                                                                                           | `zai`                         |

<Accordion title="SDK seams powering the family builders">
  Each family builder is composed from lower-level public helpers exported from the same package, which you can reach for when a provider needs to go off the common pattern:

- `openclaw/plugin-sdk/provider-model-shared` - `ProviderReplayFamily`, `buildProviderReplayFamilyHooks(...)`, and the raw replay builders (`buildOpenAICompatibleReplayPolicy`, `buildAnthropicReplayPolicyForModel`, `buildGoogleGeminiReplayPolicy`, `buildHybridAnthropicOrOpenAIReplayPolicy`). Also exports Gemini replay helpers (`sanitizeGoogleGeminiReplayHistory`, `resolveTaggedReasoningOutputMode`) and endpoint/model helpers (`resolveProviderEndpoint`, `normalizeProviderId`, `normalizeGooglePreviewModelId`).
- `openclaw/plugin-sdk/provider-stream` - `ProviderStreamFamily`, `buildProviderStreamFamilyHooks(...)`, `composeProviderStreamWrappers(...)`, plus the shared OpenAI/Codex wrappers (`createOpenAIAttributionHeadersWrapper`, `createOpenAIFastModeWrapper`, `createOpenAIServiceTierWrapper`, `createOpenAIResponsesContextManagementWrapper`, `createCodexNativeWebSearchWrapper`), DeepSeek V4 OpenAI-compatible wrapper (`createDeepSeekV4OpenAICompatibleThinkingWrapper`), Anthropic Messages thinking prefill cleanup (`createAnthropicThinkingPrefillPayloadWrapper`), plain-text tool-call compat (`createPlainTextToolCallCompatWrapper`), and shared proxy/provider wrappers (`createOpenRouterWrapper`, `createToolStreamWrapper`, `createMinimaxFastModeWrapper`).
- `openclaw/plugin-sdk/provider-stream-shared` - lightweight payload and event wrappers for hot provider paths, including `applyCompletionsAnthropicCacheControl` (the shared Chat Completions cache-marker layout; native Anthropic Messages uses its own policy), `createOpenAICompatibleCompletionsThinkingOffWrapper`, `createPayloadPatchStreamWrapper`, `createPlainTextToolCallCompatWrapper`, `normalizeOpenAICompatibleReasoningPayload(...)`, and `setQwenChatTemplateThinking(...)`.
- Copilot transports can use `projectCopilotRequestFacts(messages, contentMode, hasImages?)` from `provider-stream-shared` to derive `{ initiator, hasImages }`. Use `"direct"` for normalized direct image blocks or `"nested"` for nested provider content, including user-carried `tool_result` continuations. An explicit `hasImages` reuses a caller's computed vision fact. Runtime identity, header casing, and caller overrides remain with the plugin.
- `openclaw/plugin-sdk/provider-transport-runtime` - native Google wire helpers: `projectGoogleMessages(...)`, `convertGoogleTools(...)`, `requiresGoogleToolCallId(...)`, and `consumeGoogleGenerateContentStream(...)`. Prepare and normalize transcript routes before projection. Use `replay: "managed"` and stream `profile: "managed"` for managed SSE; the direct SDK uses `replay: "signed-parts"` and the default stream profile to preserve individual signed parts. Transport owners retain authentication, retries, HTTP cancellation, and trusted video admission; the reducer emits events and usage, and throws failures for the caller to finalize.
- `openclaw/plugin-sdk/provider-tools` - `ProviderToolCompatFamily`, `buildProviderToolCompatFamilyHooks("deepseek" | "gemini" | "openai")`, and underlying provider schema helpers.

For Gemini-family providers, keep the reasoning-output mode aligned with
the transport. Direct Google Gemini API providers should use `native`
reasoning output so OpenClaw consumes native thought parts without adding
`<think>` / `<final>` prompt directives. Text-only Gemini CLI-style
backends that parse a final JSON/text response can keep the shared
`google-gemini` tagged contract.

Some stream helpers stay provider-local on purpose. `@openclaw/anthropic-provider` keeps `wrapAnthropicProviderStream`, `resolveAnthropicBetas`, `resolveAnthropicFastMode`, `resolveAnthropicServiceTier`, and the lower-level Anthropic wrapper builders in its own public `api.ts` / `contract-api.ts` seam because they encode Claude OAuth beta handling and `context1m` gating. The xAI plugin similarly keeps native xAI Responses shaping in its own `wrapStreamFn` (`/fast` aliases, default `tool_stream`, unsupported strict-tool cleanup, xAI-specific reasoning-payload removal).

The same package-root pattern also backs `@openclaw/openai-provider` (provider builders, default-model helpers, realtime provider builders) and `@openclaw/openrouter-provider` (provider builder plus onboarding/config helpers).
</Accordion>
