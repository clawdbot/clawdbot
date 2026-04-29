---
summary: "Reference: provider-specific transcript sanitization and repair rules"
read_when:
  - You are debugging provider request rejections tied to transcript shape
  - You are changing transcript sanitization or tool-call repair logic
  - You are investigating tool-call id mismatches across providers
title: "Transcript hygiene"
---

OpenClaw applies **provider-specific fixes** to transcripts before a run (building model context). Most of these are **in-memory** adjustments used to satisfy strict provider requirements. A separate session-file repair pass may also rewrite stored JSONL before the session is loaded, either by dropping malformed JSONL lines or by repairing persisted turns that are syntactically valid but known to be rejected by a
provider during replay. When a repair occurs, the original file is backed up alongside
the session file.

Scope includes:

- Runtime-only prompt context staying out of user-visible transcript turns
- Tool call id sanitization
- Tool call input validation
- Tool result pairing repair
- Turn validation / ordering
- Thought signature cleanup
- Thinking signature cleanup
- Image payload sanitization
- Blank text-block cleanup before provider replay
- User-input provenance tagging (for inter-session routed prompts)
- Empty assistant error-turn repair for Bedrock Converse replay

If you need transcript storage details, see:

- [Session management deep dive](/reference/session-management-compaction)

---

## Global rule: runtime context is not user transcript

Runtime/system context can be added to the model prompt for a turn, but it is
not end-user-authored content. OpenClaw keeps a separate transcript-facing
prompt body for Gateway replies, queued followups, ACP, CLI, and embedded Pi
runs. Stored visible user turns use that transcript body instead of the
runtime-enriched prompt.

For legacy sessions that already persisted runtime wrappers, Gateway history
surfaces apply a display projection before returning messages to WebChat,
TUI, REST, or SSE clients.

---

## Where this runs

All transcript hygiene is centralized in the embedded runner:

- Policy selection: `src/agents/transcript-policy.ts`
- Sanitization/repair application: `sanitizeSessionHistory` in `src/agents/pi-embedded-runner/replay-history.ts`

The policy uses `provider`, `modelApi`, and `modelId` to decide what to apply.

Separate from transcript hygiene, session files are repaired (if needed) before load:

- `repairSessionFileIfNeeded` in `src/agents/session-file-repair.ts`
- Called from `run/attempt.ts` and `compact.ts` (embedded runner)

---

## Global rule: image sanitization

Image payloads are always sanitized to prevent provider-side rejection due to size
limits (downscale/recompress oversized base64 images).

This also helps control image-driven token pressure for vision-capable models.
Lower max dimensions generally reduce token usage; higher dimensions preserve detail.

Implementation:

- `sanitizeSessionMessagesImages` in `src/agents/pi-embedded-helpers/images.ts`
- `sanitizeContentBlocksImages` in `src/agents/tool-images.ts`
- Max image side is configurable via `agents.defaults.imageMaxDimensionPx` (default: `1200`).
- Blank text blocks are removed while this pass walks replay content. Assistant
  turns that become empty are dropped from the replay copy; user and tool-result
  turns that become empty receive a non-empty omitted-content placeholder.

---

## Global rule: malformed tool calls

Assistant tool-call blocks that are missing both `input` and `arguments` are dropped
before model context is built. This prevents provider rejections from partially
persisted tool calls (for example, after a rate limit failure).

Implementation:

- `sanitizeToolCallInputs` in `src/agents/session-transcript-repair.ts`
- Applied in `sanitizeSessionHistory` in `src/agents/pi-embedded-runner/replay-history.ts`

---

## Global rule: inter-session input provenance

When an agent sends a prompt into another session via `sessions_send` (including
agent-to-agent reply/announce steps), OpenClaw persists the created user turn with:

- `message.provenance.kind = "inter_session"`

OpenClaw also prepends a same-turn `[Inter-session message ... isUser=false]`
marker before the routed prompt text so the active model call can distinguish
foreign session output from external end-user instructions. This marker includes
the source session, channel, and tool when available. The transcript still uses
`role: "user"` for provider compatibility, but the visible text and provenance
metadata both mark the turn as inter-session data.

During context rebuild, OpenClaw applies the same marker to older persisted
inter-session user turns that only have provenance metadata.

---

## Provider matrix (current behavior)

**OpenAI / OpenAI Codex**

- Image sanitization only.
- Drop orphaned reasoning signatures (standalone reasoning items without a following content block) for OpenAI Responses/Codex transcripts, and drop replayable OpenAI reasoning after a model route switch.
- Preserve replayable OpenAI Responses reasoning item payloads, including encrypted empty-summary items, so manual/WebSocket replay keeps required `rs_*` state paired with assistant output items.
- No tool call id sanitization.
- Tool result pairing repair may move real matched outputs and synthesize Codex-style `aborted` outputs for missing tool calls.
- No turn validation or reordering.
- Missing OpenAI Responses-family tool outputs are synthesized as `aborted` to match Codex replay normalization.
- No thought signature stripping.

**OpenAI-compatible Gemma 4**

- Historical assistant thinking/reasoning blocks are stripped before replay so local
  OpenAI-compatible Gemma 4 servers do not receive prior-turn reasoning content.
- Current same-turn tool-call continuations keep the assistant reasoning block
  attached to the tool call until the tool result has been replayed.

**Google (Generative AI / Gemini CLI / Antigravity)**

- Tool call id sanitization: strict alphanumeric.
- Tool result pairing repair and synthetic tool results.
- Turn validation (Gemini-style turn alternation).
- Google turn ordering fixup (prepend a tiny user bootstrap if history starts with assistant).
- Antigravity Claude: normalize thinking signatures; drop unsigned thinking blocks.

**Anthropic / Minimax (Anthropic-compatible)**

- Tool result pairing repair and synthetic tool results.
- Turn validation (merge consecutive user turns to satisfy strict alternation).
- Trailing assistant prefill turns are stripped from outgoing Anthropic Messages
  payloads when thinking is enabled, including Cloudflare AI Gateway routes.
- Thinking blocks with missing, empty, or blank replay signatures are stripped
  before provider conversion. If that empties an assistant turn, OpenClaw keeps
  turn shape with non-empty omitted-reasoning text.
- Older thinking-only assistant turns that must be stripped are replaced with
  non-empty omitted-reasoning text so provider adapters do not drop the replay
  turn.

**Amazon Bedrock (Converse API)**

- Empty assistant stream-error turns are repaired to a non-empty fallback text block
  before replay. Bedrock Converse rejects assistant messages with `content: []`, so
  persisted assistant turns with `stopReason: "error"` and empty content are also
  repaired on disk before load.
- Assistant stream-error turns that contain only blank text blocks are dropped
  from the in-memory replay copy instead of replaying an invalid blank block.
- Claude thinking blocks with missing, empty, or blank replay signatures are
  stripped before Converse replay. If that empties an assistant turn, OpenClaw
  keeps turn shape with non-empty omitted-reasoning text.
- Older thinking-only assistant turns that must be stripped are replaced with
  non-empty omitted-reasoning text so the Converse replay keeps strict turn shape.
- Replay filters OpenClaw delivery-mirror and gateway-injected assistant turns.
- Image sanitization applies through the global rule.

**Mistral (including model-id based detection)**

- Tool call id sanitization: strict9 (alphanumeric length 9).

**OpenRouter Gemini**

- Thought signature cleanup: strip non-base64 `thought_signature` values (keep base64).

**Everything else**

- Image sanitization only.

---

## Historical behavior (pre-2026.1.22)

Before the 2026.1.22 release, OpenClaw applied multiple layers of transcript hygiene:

- A **transcript-sanitize extension** ran on every context build and could:
  - Repair tool use/result pairing.
  - Sanitize tool call ids (including a non-strict mode that preserved `_`/`-`).
- The runner also performed provider-specific sanitization, which duplicated work.
- Additional mutations occurred outside the provider policy, including:
  - Stripping `<final>` tags from assistant text before persistence.
  - Dropping empty assistant error turns.
  - Trimming assistant content after tool calls.

This complexity caused cross-provider regressions (notably `openai-responses`
`call_id|fc_id` pairing). The 2026.1.22 cleanup removed the extension, centralized
logic in the runner, and made OpenAI **no-touch** beyond image sanitization.

## Related

- [Session management](/concepts/session)
- [Session pruning](/concepts/session-pruning)
