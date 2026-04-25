---
summary: "Reference: provider-specific transcript sanitization and repair rules"
read_when:
  - You are debugging provider request rejections tied to transcript shape
  - You are changing transcript sanitization or tool-call repair logic
  - You are investigating tool-call id mismatches across providers
title: "Transcript hygiene"
---

This document describes **provider-specific fixes** applied to transcripts before a run
(building model context). These are **in-memory** adjustments used to satisfy strict
provider requirements. These hygiene steps do **not** rewrite the stored JSONL transcript
on disk; however, a separate session-file repair pass may rewrite malformed JSONL files
by dropping invalid lines before the session is loaded. When a repair occurs, the original
file is backed up alongside the session file.

Scope includes:

- Runtime-only prompt context staying out of user-visible transcript turns
- Tool call id sanitization
- Tool call input validation
- Tool result pairing repair
- Turn validation / ordering
- Thought signature cleanup
- Image payload sanitization
- User-input provenance tagging (for inter-session routed prompts)

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

This metadata is written at transcript append time and does not change role
(`role: "user"` remains for provider compatibility). Transcript readers can use
this to avoid treating routed internal prompts as end-user-authored instructions.

During context rebuild, OpenClaw also prepends a short `[Inter-session message]`
marker to those user turns in-memory so the model can distinguish them from
external end-user instructions.

---

## Provider matrix (current behavior)

**OpenAI / OpenAI Codex**

- Image sanitization only.
- Drop orphaned reasoning signatures (standalone reasoning items without a following content block) for OpenAI Responses/Codex transcripts, and drop replayable OpenAI reasoning after a model route switch.
- No tool call id sanitization.
- Tool result pairing repair may move real matched outputs and synthesize Codex-style `aborted` outputs for missing tool calls.
- No turn validation or reordering.
- Missing OpenAI Responses-family tool outputs are synthesized as `aborted` to match Codex replay normalization.
- No thought signature stripping.

**Google (Generative AI / Gemini CLI / Antigravity)**

- Tool call id sanitization: strict alphanumeric.
- Tool result pairing repair and synthetic tool results.
- Turn validation (Gemini-style turn alternation).
- Google turn ordering fixup (prepend a tiny user bootstrap if history starts with assistant).
- Antigravity Claude: normalize thinking signatures; drop unsigned thinking blocks.

**Anthropic / Minimax (Anthropic-compatible)**

- Tool result pairing repair and synthetic tool results.
- Turn validation (merge consecutive user turns to satisfy strict alternation).

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
