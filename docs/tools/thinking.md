---
summary: "Directive syntax for /think, /fast, /verbose, /trace, and reasoning visibility"
read_when:
  - Adjusting thinking, fast-mode, or verbose directive parsing or defaults
title: "Thinking levels"
---

## What it does

- Inline directive in any inbound body: `/t <level>`, `/think:<level>`, or `/thinking <level>`.
- Levels (aliases): `off | minimal | low | medium | high | xhigh | adaptive | max`
  - minimal → “think”
  - low → “think hard”
  - medium → “think harder”
  - high → “ultrathink” (max budget)
  - xhigh → “ultrathink+” (GPT-5.2+ and Codex models, plus Anthropic Claude Opus 4.7 effort)
  - adaptive → provider-managed adaptive thinking (supported for Claude 4.6 on Anthropic/Bedrock, Anthropic Claude Opus 4.7, and Google Gemini dynamic thinking)
  - max → provider max reasoning (Anthropic Claude Opus 4.7; Ollama maps this to its highest native `think` effort)
  - `x-high`, `x_high`, `extra-high`, `extra high`, and `extra_high` map to `xhigh`.
  - `highest` maps to `high`.
- Provider notes:
  - Thinking menus and pickers are provider-profile driven. Provider plugins declare the exact level set for the selected model, including labels such as binary `on`.
  - `adaptive`, `xhigh`, and `max` are only advertised for provider/model profiles that support them. Typed directives for unsupported levels are rejected with that model's valid options.
  - Existing stored unsupported levels are remapped by provider profile rank. `adaptive` falls back to `medium` on non-adaptive models, while `xhigh` and `max` fall back to the largest supported non-off level for the selected model.
  - Anthropic Claude 4.6 models default to `adaptive` when no explicit thinking level is set.
  - Anthropic Claude Opus 4.7 does not default to adaptive thinking. Its API effort default remains provider-owned unless you explicitly set a thinking level.
  - Anthropic Claude Opus 4.7 maps `/think xhigh` to adaptive thinking plus `output_config.effort: "xhigh"`, because `/think` is a thinking directive and `xhigh` is the Opus 4.7 effort setting.
  - Anthropic Claude Opus 4.7 also exposes `/think max`; it maps to the same provider-owned max effort path.
  - DeepSeek V4 models expose `/think xhigh|max`; both map to DeepSeek `reasoning_effort: "max"` while lower non-off levels map to `high`.
  - Ollama thinking-capable models expose `/think low|medium|high|max`; `max` maps to native `think: "high"` because Ollama's native API accepts `low`, `medium`, and `high` effort strings.
  - OpenAI GPT models map `/think` through model-specific Responses API effort support. `/think off` sends `reasoning.effort: "none"` only when the target model supports it; otherwise OpenClaw omits the disabled reasoning payload instead of sending an unsupported value.
  - Custom OpenAI-compatible catalog entries can opt into `/think xhigh` by setting `models.providers.<provider>.models[].compat.supportedReasoningEfforts` to include `"xhigh"`. This uses the same compat metadata that maps outbound OpenAI reasoning effort payloads, so menus, session validation, agent CLI, and `llm-task` agree with transport behavior.
  - Stale configured OpenRouter Hunter Alpha refs skip proxy reasoning injection because that retired route could return final answer text through reasoning fields.
  - Google Gemini maps `/think adaptive` to Gemini's provider-owned dynamic thinking. Gemini 3 requests omit a fixed `thinkingLevel`, while Gemini 2.5 requests send `thinkingBudget: -1`; fixed levels still map to the closest Gemini `thinkingLevel` or budget for that model family.
  - MiniMax (`minimax/*`) on the Anthropic-compatible streaming path defaults to `thinking: { type: "disabled" }` unless you explicitly set thinking in model params or request params. This avoids leaked `reasoning_content` deltas from MiniMax's non-native Anthropic stream format.
  - Z.AI (`zai/*`) only supports binary thinking (`on`/`off`). Any non-`off` level is treated as `on` (mapped to `low`).
  - Moonshot (`moonshot/*`) maps `/think off` to `thinking: { type: "disabled" }` and any non-`off` level to `thinking: { type: "enabled" }`. When thinking is enabled, Moonshot only accepts `tool_choice` `auto|none`; OpenClaw normalizes incompatible values to `auto`.

## Resolution order

1. Inline directive on the message (applies only to that message).
2. Session override (set by sending a directive-only message).
3. Per-agent default (`agents.list[].thinkingDefault` in config).
4. Global default (`agents.defaults.thinkingDefault` in config).
5. Fallback: provider-declared default when available; otherwise reasoning-capable models resolve to `medium` or the nearest supported non-`off` level for that model, and non-reasoning models stay `off`.

## Setting a session default

- Send a message that is **only** the directive (whitespace allowed), e.g. `/think:medium` or `/t high`.
- That sticks for the current session (per-sender by default); cleared by `/think:off` or session idle reset.
- Confirmation reply is sent (`Thinking level set to high.` / `Thinking disabled.`). If the level is invalid (e.g. `/thinking big`), the command is rejected with a hint and the session state is left unchanged.
- Send `/think` (or `/think:`) with no argument to see the current thinking level.

## Application by agent

- **Embedded Pi**: the resolved level is passed to the in-process Pi agent runtime.

## Fast mode (/fast)

- Levels: `on|off`.
- Directive-only message toggles a session fast-mode override and replies `Fast mode enabled.` / `Fast mode disabled.`.
- Send `/fast` (or `/fast status`) with no mode to see the current effective fast-mode state.
- OpenClaw resolves fast mode in this order:
  1. Inline/directive-only `/fast on|off`
  2. Session override
  3. Per-agent default (`agents.list[].fastModeDefault`)
  4. Per-model config: `agents.defaults.models["<provider>/<model>"].params.fastMode`
  5. Fallback: `off`
- For `openai/*`, fast mode maps to OpenAI priority processing by sending `service_tier=priority` on supported Responses requests.
- For `openai-codex/*`, fast mode sends the same `service_tier=priority` flag on Codex Responses. OpenClaw keeps one shared `/fast` toggle across both auth paths.
- For direct public `anthropic/*` requests, including OAuth-authenticated traffic sent to `api.anthropic.com`, fast mode maps to Anthropic service tiers: `/fast on` sets `service_tier=auto`, `/fast off` sets `service_tier=standard_only`.
- For `minimax/*` on the Anthropic-compatible path, `/fast on` (or `params.fastMode: true`) rewrites `MiniMax-M2.7` to `MiniMax-M2.7-highspeed`.
- Explicit Anthropic `serviceTier` / `service_tier` model params override the fast-mode default when both are set. OpenClaw still skips Anthropic service-tier injection for non-Anthropic proxy base URLs.
- `/status` shows `Fast` only when fast mode is enabled.

## Verbose directives (/verbose or /v)

- Levels: `on` (minimal) | `full` | `off` (default).
- Directive-only message toggles session verbose and replies `Verbose logging enabled.` / `Verbose logging disabled.`; invalid levels return a hint without changing state.
- `/verbose off` stores an explicit session override; clear it via the Sessions UI by choosing `inherit`.
- Inline directive affects only that message; session/global defaults apply otherwise.
- Send `/verbose` (or `/verbose:`) with no argument to see the current verbose level.
- When verbose is on, agents that emit structured tool results (Pi, other JSON agents) send each tool call back as its own metadata-only message, prefixed with `<emoji> <tool-name>: <arg>` when available (path/command). These tool summaries are sent as soon as each tool starts (separate bubbles), not as streaming deltas.
- Tool failure summaries remain visible in normal mode, but raw error detail suffixes are hidden unless verbose is `on` or `full`.
- When verbose is `full`, tool outputs are also forwarded after completion (separate bubble, truncated to a safe length). If you toggle `/verbose on|full|off` while a run is in-flight, subsequent tool bubbles honor the new setting.

## Plugin trace directives (/trace)

- Levels: `on` | `off` (default).
- Directive-only message toggles session plugin trace output and replies `Plugin trace enabled.` / `Plugin trace disabled.`.
- Inline directive affects only that message; session/global defaults apply otherwise.
- Send `/trace` (or `/trace:`) with no argument to see the current trace level.
- `/trace` is narrower than `/verbose`: it only exposes plugin-owned trace/debug lines such as Active Memory debug summaries.
- Trace lines can appear in `/status` and as a follow-up diagnostic message after the normal assistant reply.

## Reasoning visibility (/reasoning)

- Levels: `on|off|stream`.
- Directive-only message toggles whether thinking blocks are shown in replies.
- When enabled, reasoning is sent as a **separate message** prefixed with `Reasoning:`.
- `stream` (Telegram only): streams reasoning into the Telegram draft bubble while the reply is generating, then sends the final answer without reasoning.
- Alias: `/reason`.
- Send `/reasoning` (or `/reasoning:`) with no argument to see the current reasoning level.
- Resolution order: inline directive, then session override, then per-agent default (`agents.list[].reasoningDefault`), then fallback (`off`).

Malformed local-model reasoning tags are handled conservatively. Closed `<think>...</think>` blocks stay hidden on normal replies, and unclosed reasoning after already visible text is also hidden. If a reply is fully wrapped in a single unclosed opening tag and would otherwise deliver as empty text, OpenClaw removes the malformed opening tag and delivers the remaining text.

## Related

- Elevated mode docs live in [Elevated mode](/tools/elevated).

## Heartbeats

- Heartbeat probe body is the configured heartbeat prompt (default: `Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.`). Inline directives in a heartbeat message apply as usual (but avoid changing session defaults from heartbeats).
- Heartbeat delivery defaults to the final payload only. To also send the separate `Reasoning:` message (when available), set `agents.defaults.heartbeat.includeReasoning: true` or per-agent `agents.list[].heartbeat.includeReasoning: true`.

## Web chat UI

- The web chat thinking selector mirrors the session's stored level from the inbound session store/config when the page loads.
- Picking another level writes the session override immediately via `sessions.patch`; it does not wait for the next send and it is not a one-shot `thinkingOnce` override.
- The first option is always `Default (<resolved level>)`, where the resolved default comes from the active session model's provider thinking profile plus the same fallback logic that `/status` and `session_status` use.
- The picker uses `thinkingLevels` returned by the gateway session row/defaults, with `thinkingOptions` kept as a legacy label list. The browser UI does not keep its own provider regex list; plugins own model-specific level sets.
- `/think:<level>` still works and updates the same stored session level, so chat directives and the picker stay in sync.

## Provider profiles

- Provider plugins can expose `resolveThinkingProfile(ctx)` to define the model's supported levels and default.
- Provider plugins that proxy Claude models should reuse `resolveClaudeThinkingProfile(modelId)` from `openclaw/plugin-sdk/provider-model-shared` so direct Anthropic and proxy catalogs stay aligned.
- Each profile level has a stored canonical `id` (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `adaptive`, or `max`) and may include a display `label`. Binary providers use `{ id: "low", label: "on" }`.
- Tool plugins that need to validate an explicit thinking override should use `api.runtime.agent.resolveThinkingPolicy({ provider, model })` plus `api.runtime.agent.normalizeThinkingLevel(...)`; they should not keep their own provider/model level lists.
- Tool plugins with access to configured custom model metadata can pass `catalog` into `resolveThinkingPolicy` so `compat.supportedReasoningEfforts` opt-ins are reflected in plugin-side validation.
- Published legacy hooks (`supportsXHighThinking`, `isBinaryThinking`, and `resolveDefaultThinkingLevel`) remain as compatibility adapters, but new custom level sets should use `resolveThinkingProfile`.
- Gateway rows/defaults expose `thinkingLevels`, `thinkingOptions`, and `thinkingDefault` so ACP/chat clients render the same profile ids and labels that runtime validation uses.
