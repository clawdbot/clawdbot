---
summary: "Reference: provider-specific transcript sanitization and repair rules"
read_when:
  - You are debugging provider request rejections tied to transcript shape
  - You are changing transcript sanitization or tool-call repair logic
  - You are investigating tool-call id mismatches across providers
---
# Transcript Hygiene (Provider Fixups)

This document describes **provider-specific fixes** applied to transcripts before a run
(building model context). These are **in-memory** adjustments used to satisfy strict
provider requirements. They do **not** rewrite the stored JSONL transcript on disk.

Scope includes:
- Tool call id sanitization
- Tool result pairing repair
- Turn validation / ordering
- Thought signature cleanup
- Image payload sanitization

If you need transcript storage details, see:
- [/reference/session-management-compaction](/reference/session-management-compaction)

---

## Where this runs

All transcript hygiene is centralized in the embedded runner:
- Policy selection: `src/agents/transcript-policy.ts`
- Sanitization/repair application: `sanitizeSessionHistory` in `src/agents/pi-embedded-runner/google.ts`

The policy uses `provider`, `modelApi`, and `modelId` to decide what to apply.

---

## Global rule: image sanitization

Image payloads are always sanitized to prevent provider-side rejection due to size
limits (downscale/recompress oversized base64 images).

Implementation:
- `sanitizeSessionMessagesImages` in `src/agents/pi-embedded-helpers/images.ts`
- `sanitizeContentBlocksImages` in `src/agents/tool-images.ts`

---

## Provider matrix (current behavior)

**OpenAI / OpenAI Codex**
- Image sanitization only.
- On model switch into OpenAI Responses/Codex, drop orphaned reasoning signatures (standalone reasoning items without a following content block).
- No tool call id sanitization.
- No tool result pairing repair.
- No turn validation or reordering.
- No synthetic tool results.
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

Before the 2026.1.22 release, Moltbot applied multiple layers of transcript hygiene:

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
