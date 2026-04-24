---
summary: "Architecture of OpenClaw's embedded Pi agent integration and session lifecycle"
title: "Pi integration architecture"
read_when:
  - Understanding Pi SDK integration design in OpenClaw
  - Modifying agent session lifecycle, tooling, or provider wiring for Pi
---

This document describes how OpenClaw integrates with [pi-coding-agent](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) and its sibling packages (`pi-ai`, `pi-agent-core`, `pi-tui`) to power its AI agent capabilities.

## Overview

OpenClaw uses the pi SDK to embed an AI coding agent into its messaging gateway architecture. Instead of spawning pi as a subprocess or using RPC mode, OpenClaw directly imports and instantiates pi's `AgentSession` via `createAgentSession()`. This embedded approach provides:

- Full control over session lifecycle and event handling
- Custom tool injection (messaging, sandbox, channel-specific actions)
- System prompt customization per channel/context
- Session persistence with branching/compaction support
- Multi-account auth profile rotation with failover
- Provider-agnostic model switching

## Package Dependencies

```json
{
  "@mariozechner/pi-agent-core": "0.68.1",
  "@mariozechner/pi-ai": "0.68.1",
  "@mariozechner/pi-coding-agent": "0.68.1",
  "@mariozechner/pi-tui": "0.68.1"
}
```

| Package           | Purpose                                                                                                |
| ----------------- | ------------------------------------------------------------------------------------------------------ |
| `pi-ai`           | Core LLM abstractions: `Model`, `streamSimple`, message types, provider APIs                           |
| `pi-agent-core`   | Agent loop, tool execution, `AgentMessage` types                                                       |
| `pi-coding-agent` | High-level SDK: `createAgentSession`, `SessionManager`, `AuthStorage`, `ModelRegistry`, built-in tools |
| `pi-tui`          | Terminal UI components (used in OpenClaw's local TUI mode)                                             |

## File Structure

```
src/agents/
├── pi-embedded-runner.ts          # Re-exports from pi-embedded-runner/
├── pi-embedded-runner/
│   ├── run.ts                     # Main entry: runEmbeddedPiAgent()
│   ├── run/
│   │   ├── attempt.ts             # Single attempt logic with session setup
│   │   ├── params.ts              # RunEmbeddedPiAgentParams type
│   │   ├── payloads.ts            # Build response payloads from run results
│   │   ├── images.ts              # Vision model image injection
│   │   └── types.ts               # EmbeddedRunAttemptResult
│   ├── abort.ts                   # Abort error detection
│   ├── cache-ttl.ts               # Cache TTL tracking for context pruning
│   ├── compact.ts                 # Manual/auto compaction logic
│   ├── extensions.ts              # Load pi extensions for embedded runs
│   ├── extra-params.ts            # Provider-specific stream params
│   ├── google.ts                  # Google/Gemini turn ordering fixes
│   ├── history.ts                 # History limiting (DM vs group)
│   ├── lanes.ts                   # Session/global command lanes
│   ├── logger.ts                  # Subsystem logger
│   ├── model.ts                   # Model resolution via ModelRegistry
│   ├── runs.ts                    # Active run tracking, abort, queue
│   ├── sandbox-info.ts            # Sandbox info for system prompt
│   ├── session-manager-cache.ts   # SessionManager instance caching
│   ├── session-manager-init.ts    # Session file initialization
│   ├── system-prompt.ts           # System prompt builder
│   ├── tool-split.ts              # Split tools into builtIn vs custom
│   ├── types.ts                   # EmbeddedPiAgentMeta, EmbeddedPiRunResult
│   └── utils.ts                   # ThinkLevel mapping, error description
├── pi-embedded-subscribe.ts       # Session event subscription/dispatch
├── pi-embedded-subscribe.types.ts # SubscribeEmbeddedPiSessionParams
├── pi-embedded-subscribe.handlers.ts # Event handler factory
├── pi-embedded-subscribe.handlers.lifecycle.ts
├── pi-embedded-subscribe.handlers.types.ts
├── pi-embedded-block-chunker.ts   # Streaming block reply chunking
├── pi-embedded-messaging.ts       # Messaging tool sent tracking
├── pi-embedded-helpers.ts         # Error classification, turn validation
├── pi-embedded-helpers/           # Helper modules
├── pi-embedded-utils.ts           # Formatting utilities
├── pi-tools.ts                    # createOpenClawCodingTools()
├── pi-tools.abort.ts              # AbortSignal wrapping for tools
├── pi-tools.policy.ts             # Tool allowlist/denylist policy
├── pi-tools.read.ts               # Read tool customizations
├── pi-tools.schema.ts             # Tool schema normalization
├── pi-tools.types.ts              # AnyAgentTool type alias
├── pi-tool-definition-adapter.ts  # AgentTool -> ToolDefinition adapter
├── pi-settings.ts                 # Settings overrides
├── pi-hooks/                      # Custom pi hooks
│   ├── compaction-safeguard.ts    # Safeguard extension
│   ├── compaction-safeguard-runtime.ts
│   ├── context-pruning.ts         # Cache-TTL context pruning extension
│   └── context-pruning/
├── model-auth.ts                  # Auth profile resolution
├── auth-profiles.ts               # Profile store, cooldown, failover
├── model-selection.ts             # Default model resolution
├── models-config.ts               # models.json generation
├── model-catalog.ts               # Model catalog cache
├── context-window-guard.ts        # Context window validation
├── failover-error.ts              # FailoverError class
├── defaults.ts                    # DEFAULT_PROVIDER, DEFAULT_MODEL
├── system-prompt.ts               # buildAgentSystemPrompt()
├── system-prompt-params.ts        # System prompt parameter resolution
├── system-prompt-report.ts        # Debug report generation
├── tool-summaries.ts              # Tool description summaries
├── tool-policy.ts                 # Tool policy resolution
├── transcript-policy.ts           # Transcript validation policy
├── skills.ts                      # Skill snapshot/prompt building
├── skills/                        # Skill subsystem
├── sandbox.ts                     # Sandbox context resolution
├── sandbox/                       # Sandbox subsystem
├── channel-tools.ts               # Channel-specific tool injection
├── openclaw-tools.ts              # OpenClaw-specific tools
├── bash-tools.ts                  # exec/process tools
├── apply-patch.ts                 # apply_patch tool (OpenAI)
├── tools/                         # Individual tool implementations
│   ├── browser-tool.ts
│   ├── canvas-tool.ts
│   ├── cron-tool.ts
│   ├── gateway-tool.ts
│   ├── image-tool.ts
│   ├── message-tool.ts
│   ├── nodes-tool.ts
│   ├── session*.ts
│   ├── web-*.ts
│   └── ...
└── ...
```

Channel-specific message action runtimes now live in the plugin-owned extension
directories instead of under `src/agents/tools`, for example:

- the Discord plugin action runtime files
- the Slack plugin action runtime file
- the Telegram plugin action runtime file
- the WhatsApp plugin action runtime file

## Core Integration Flow

### 1. Running an Embedded Agent

The main entry point is `runEmbeddedPiAgent()` in `pi-embedded-runner/run.ts`:

```typescript
import { runEmbeddedPiAgent } from "./agents/pi-embedded-runner.js";

const result = await runEmbeddedPiAgent({
  sessionId: "user-123",
  sessionKey: "main:whatsapp:+1234567890",
  sessionFile: "/path/to/session.jsonl",
  workspaceDir: "/path/to/workspace",
  config: openclawConfig,
  prompt: "Hello, how are you?",
  provider: "anthropic",
  model: "claude-sonnet-4-6",
  timeoutMs: 120_000,
  runId: "run-abc",
  onBlockReply: async (payload) => {
    await sendToChannel(payload.text, payload.mediaUrls);
  },
});
```

### 2. Session Creation

Inside `runEmbeddedAttempt()` (called by `runEmbeddedPiAgent()`), the pi SDK is used:

```typescript
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@mariozechner/pi-coding-agent";

const resourceLoader = new DefaultResourceLoader({
  cwd: resolvedWorkspace,
  agentDir,
  settingsManager,
  additionalExtensionPaths,
});
await resourceLoader.reload();

const { session } = await createAgentSession({
  cwd: resolvedWorkspace,
  agentDir,
  authStorage: params.authStorage,
  modelRegistry: params.modelRegistry,
  model: params.model,
  thinkingLevel: mapThinkingLevel(params.thinkLevel),
  tools: builtInTools,
  customTools: allCustomTools,
  sessionManager,
  settingsManager,
  resourceLoader,
});

applySystemPromptOverrideToSession(session, systemPromptOverride);
```

### 3. Event Subscription

`subscribeEmbeddedPiSession()` subscribes to pi's `AgentSession` events:

```typescript
const subscription = subscribeEmbeddedPiSession({
  session: activeSession,
  runId: params.runId,
  verboseLevel: params.verboseLevel,
  reasoningMode: params.reasoningLevel,
  toolResultFormat: params.toolResultFormat,
  onToolResult: params.onToolResult,
  onReasoningStream: params.onReasoningStream,
  onBlockReply: params.onBlockReply,
  onPartialReply: params.onPartialReply,
  onAgentEvent: params.onAgentEvent,
});
```

Events handled include:

- `message_start` / `message_end` / `message_update` (streaming text/thinking)
- `tool_execution_start` / `tool_execution_update` / `tool_execution_end`
- `turn_start` / `turn_end`
- `agent_start` / `agent_end`
- `compaction_start` / `compaction_end`

### 4. Prompting

After setup, the session is prompted:

```typescript
await session.prompt(effectivePrompt, { images: imageResult.images });
```

The SDK handles the full agent loop: sending to LLM, executing tool calls, streaming responses.

Image injection is prompt-local: OpenClaw loads image refs from the current prompt and
passes them via `images` for that turn only. It does not re-scan older history turns
to re-inject image payloads.

## Tool Architecture

### Tool Pipeline

1. **Base Tools**: pi's `codingTools` (read, bash, edit, write)
2. **Custom Replacements**: OpenClaw replaces bash with `exec`/`process`, customizes read/edit/write for sandbox
3. **OpenClaw Tools**: messaging, browser, canvas, sessions, cron, gateway, etc.
4. **Channel Tools**: Discord/Telegram/Slack/WhatsApp-specific action tools
5. **Policy Filtering**: Tools filtered by profile, provider, agent, group, sandbox policies
6. **Schema Normalization**: Schemas cleaned for Gemini/OpenAI quirks
7. **AbortSignal Wrapping**: Tools wrapped to respect abort signals

### Tool Definition Adapter

pi-agent-core's `AgentTool` has a different `execute` signature than pi-coding-agent's `ToolDefinition`. The adapter in `pi-tool-definition-adapter.ts` bridges this:

```typescript
export function toToolDefinitions(tools: AnyAgentTool[]): ToolDefinition[] {
  return tools.map((tool) => ({
    name: tool.name,
    label: tool.label ?? name,
    description: tool.description ?? "",
    parameters: tool.parameters,
    execute: async (toolCallId, params, onUpdate, _ctx, signal) => {
      // pi-coding-agent signature differs from pi-agent-core
      return await tool.execute(toolCallId, params, signal, onUpdate);
    },
  }));
}
```

### Tool Split Strategy

`splitSdkTools()` passes all tools via `customTools`:

```typescript
export function splitSdkTools(options: { tools: AnyAgentTool[]; sandboxEnabled: boolean }) {
  return {
    builtInTools: [], // Empty. We override everything
    customTools: toToolDefinitions(options.tools),
  };
}
```

This ensures OpenClaw's policy filtering, sandbox integration, and extended toolset remain consistent across providers.

## System Prompt Construction

The system prompt is built in `buildAgentSystemPrompt()` (`system-prompt.ts`). It assembles a full prompt with sections including Tooling, Tool Call Style, Safety guardrails, OpenClaw CLI reference, Skills, Docs, Workspace, Sandbox, Messaging, Reply Tags, Voice, Silent Replies, Heartbeats, Runtime metadata, plus Memory and Reactions when enabled, and optional context files and extra system prompt content. Sections are trimmed for minimal prompt mode used by subagents.

The prompt is applied after session creation via `applySystemPromptOverrideToSession()`:

```typescript
const systemPromptOverride = createSystemPromptOverride(appendPrompt);
applySystemPromptOverrideToSession(session, systemPromptOverride);
```

## Session Management

### Session Files

Sessions are JSONL files with tree structure (id/parentId linking). Pi's `SessionManager` handles persistence:

```typescript
const sessionManager = SessionManager.open(params.sessionFile);
```

OpenClaw wraps this with `guardSessionManager()` for tool result safety.

### Session Caching

`session-manager-cache.ts` caches SessionManager instances to avoid repeated file parsing:

```typescript
await prewarmSessionFile(params.sessionFile);
sessionManager = SessionManager.open(params.sessionFile);
trackSessionManagerAccess(params.sessionFile);
```

### History Limiting

`limitHistoryTurns()` trims conversation history based on channel type (DM vs group).

### Compaction

Auto-compaction triggers on context overflow. Common overflow signatures
include `request_too_large`, `context length exceeded`, `input exceeds the
maximum number of tokens`, `input token count exceeds the maximum number of
input tokens`, `input is too long for the model`, and `ollama error: context
length exceeded`. `compactEmbeddedPiSessionDirect()` handles manual
compaction:

```typescript
const compactResult = await compactEmbeddedPiSessionDirect({
  sessionId, sessionFile, provider, model, ...
});
```

## Authentication & Model Resolution

### Auth Profiles

OpenClaw maintains an auth profile store with multiple API keys per provider:

```typescript
const authStore = ensureAuthProfileStore(agentDir, { allowKeychainPrompt: false });
const profileOrder = resolveAuthProfileOrder({ cfg, store: authStore, provider, preferredProfile });
```

Profiles rotate on failures with cooldown tracking:

```typescript
await markAuthProfileFailure({ store, profileId, reason, cfg, agentDir });
const rotated = await advanceAuthProfile();
```

### Model Resolution

```typescript
import { resolveModel } from "./pi-embedded-runner/model.js";

const { model, error, authStorage, modelRegistry } = resolveModel(
  provider,
  modelId,
  agentDir,
  config,
);

// Uses pi's ModelRegistry and AuthStorage
authStorage.setRuntimeApiKey(model.provider, apiKeyInfo.apiKey);
```

### Failover

`FailoverError` triggers model fallback when configured:

```typescript
if (fallbackConfigured && isFailoverErrorMessage(errorText)) {
  throw new FailoverError(errorText, {
    reason: promptFailoverReason ?? "unknown",
    provider,
    model: modelId,
    profileId,
    status: resolveFailoverStatus(promptFailoverReason),
  });
}
```

## Pi Extensions

OpenClaw loads custom pi extensions for specialized behavior:

### Compaction Safeguard

`src/agents/pi-hooks/compaction-safeguard.ts` adds guardrails to compaction, including adaptive token budgeting plus tool failure and file operation summaries:

```typescript
if (resolveCompactionMode(params.cfg) === "safeguard") {
  setCompactionSafeguardRuntime(params.sessionManager, { maxHistoryShare });
  paths.push(resolvePiExtensionPath("compaction-safeguard"));
}
```

### Context Pruning

`src/agents/pi-hooks/context-pruning.ts` implements cache-TTL based context pruning:

```typescript
if (cfg?.agents?.defaults?.contextPruning?.mode === "cache-ttl") {
  setContextPruningRuntime(params.sessionManager, {
    settings,
    contextWindowTokens,
    isToolPrunable,
    lastCacheTouchAt,
  });
  paths.push(resolvePiExtensionPath("context-pruning"));
}
```

## Streaming & Block Replies

### Block Chunking

`EmbeddedBlockChunker` manages streaming text into discrete reply blocks:

```typescript
const blockChunker = blockChunking ? new EmbeddedBlockChunker(blockChunking) : null;
```

### Thinking/Final Tag Stripping

Streaming output is processed to strip `<think>`/`<thinking>` blocks and extract `<final>` content:

```typescript
const stripBlockTags = (text: string, state: { thinking: boolean; final: boolean }) => {
  // Strip <think>...</think> content
  // If enforceFinalTag, only return <final>...</final> content
};
```

### Reply Directives

Reply directives like `[[media:url]]`, `[[voice]]`, `[[reply:id]]` are parsed and extracted:

```typescript
const { text: cleanedText, mediaUrls, audioAsVoice, replyToId } = consumeReplyDirectives(chunk);
```

## Error Handling

### Error Classification

`pi-embedded-helpers.ts` classifies errors for appropriate handling:

```typescript
isContextOverflowError(errorText)     // Context too large
isCompactionFailureError(errorText)   // Compaction failed
isAuthAssistantError(lastAssistant)   // Auth failure
isRateLimitAssistantError(...)        // Rate limited
isFailoverAssistantError(...)         // Should failover
classifyFailoverReason(errorText)     // "auth" | "rate_limit" | "quota" | "timeout" | ...
```

### Thinking Level Fallback

If a thinking level is unsupported, it falls back:

```typescript
const fallbackThinking = pickFallbackThinkingLevel({
  message: errorText,
  attempted: attemptedThinking,
});
if (fallbackThinking) {
  thinkLevel = fallbackThinking;
  continue;
}
```

## Sandbox Integration

When sandbox mode is enabled, tools and paths are constrained:

```typescript
const sandbox = await resolveSandboxContext({
  config: params.config,
  sessionKey: sandboxSessionKey,
  workspaceDir: resolvedWorkspace,
});

if (sandboxRoot) {
  // Use sandboxed read/edit/write tools
  // Exec runs in container
  // Browser uses bridge URL
}
```

## Provider-Specific Handling

### Anthropic

- Refusal magic string scrubbing
- Turn validation for consecutive roles
- Strict upstream Pi tool parameter validation

### Google/Gemini

- Plugin-owned tool schema sanitization

### OpenAI

- `apply_patch` tool for Codex models
- Thinking level downgrade handling

## TUI Integration

OpenClaw also has a local TUI mode that uses pi-tui components directly:

```typescript
// src/tui/tui.ts
import { ... } from "@mariozechner/pi-tui";
```

This provides the interactive terminal experience similar to pi's native mode.

## Key Differences from Pi CLI

| Aspect          | Pi CLI                  | OpenClaw Embedded                                                                              |
| --------------- | ----------------------- | ---------------------------------------------------------------------------------------------- |
| Invocation      | `pi` command / RPC      | SDK via `createAgentSession()`                                                                 |
| Tools           | Default coding tools    | Custom OpenClaw tool suite                                                                     |
| System prompt   | AGENTS.md + prompts     | Dynamic per-channel/context                                                                    |
| Session storage | `~/.pi/agent/sessions/` | `~/.openclaw/agents/<agentId>/sessions/` (or `$OPENCLAW_STATE_DIR/agents/<agentId>/sessions/`) |
| Auth            | Single credential       | Multi-profile with rotation                                                                    |
| Extensions      | Loaded from disk        | Programmatic + disk paths                                                                      |
| Event handling  | TUI rendering           | Callback-based (onBlockReply, etc.)                                                            |

## Future Considerations

Areas for potential rework:

1. **Tool signature alignment**: Currently adapting between pi-agent-core and pi-coding-agent signatures
2. **Session manager wrapping**: `guardSessionManager` adds safety but increases complexity
3. **Extension loading**: Could use pi's `ResourceLoader` more directly
4. **Streaming handler complexity**: `subscribeEmbeddedPiSession` has grown large
5. **Provider quirks**: Many provider-specific codepaths that pi could potentially handle

## Tests

Pi integration coverage spans these suites:

- `src/agents/pi-*.test.ts`
- `src/agents/pi-auth-json.test.ts`
- `src/agents/pi-embedded-*.test.ts`
- `src/agents/pi-embedded-helpers*.test.ts`
- `src/agents/pi-embedded-runner*.test.ts`
- `src/agents/pi-embedded-runner/**/*.test.ts`
- `src/agents/pi-embedded-subscribe*.test.ts`
- `src/agents/pi-tools*.test.ts`
- `src/agents/pi-tool-definition-adapter*.test.ts`
- `src/agents/pi-settings.test.ts`
- `src/agents/pi-hooks/**/*.test.ts`

Live/opt-in:

- `src/agents/pi-embedded-runner-extraparams.live.test.ts` (enable `OPENCLAW_LIVE_TEST=1`)

For current run commands, see [Pi Development Workflow](/pi-dev).

## Related

- [Pi development workflow](/pi-dev)
- [Install overview](/install)
