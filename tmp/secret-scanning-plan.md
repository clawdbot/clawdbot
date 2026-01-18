# Runtime Secret Scanning Plan (Off / Redact / Block)

## Goals
- Provide **three modes**: **off**, **redact**, or **block**.
- Overflow behavior is **independent of mode** (ignored when off):
  - **truncate** (scan up to cap, mark truncated)
  - **block** (fail closed on overflow)
- Use **RE2** for regex safety with untrusted input.
- Keep scanner warm (compile once, minimal per-call allocations).

## Decisions Needed (confirm)
- Default scan cap (e.g., 32k vs 64k chars).
- Whether to include a hard max cap beyond configurable cap.
- Overflow policy default: **truncate** or **block**.
- Error message copy for “blocked due to size” and “blocked due to secret detection”.

## Proposed Config Surface
- New config section: `security.secretScanning`.
  - `mode: "off" | "redact" | "block"` (default: "off").
  - `maxChars: number` (cap; block if exceeded). **Default: 32768**.
  - `overflow: "truncate" | "block"` (default: "truncate").
  - `logSecretMatches: "off" | "redacted"` (default: "off").
  - **Warning**: when `overflow: "truncate"` and input exceeds `maxChars`, emit a warning
    like “Secret scan truncated to ${maxChars} chars (set security.secretScanning.maxChars to increase).”

## Core Module (PR 1)
- New module: `src/security/secret-scan/`.
  - `scanText(text, opts)` returns `{ blocked: boolean; reason; matches; truncated: boolean; redactedText; }`.
  - **Overflow behavior**:
    - `overflow: "block"`: if `text.length > maxChars` ⇒ `blocked: true`, `reason: "too_long"`.
    - `overflow: "truncate"`: scan `text.slice(0, maxChars)` and set `truncated: true`.
  - Detector families:
    - **Known formats**: token prefixes (sk-, ghp_, xoxb-, etc.), Authorization headers, PEM blocks.
    - **Entropy detectors**: base64/hex candidates with thresholds.
    - **Heuristics**: sensitive key names + assignments / headers / JSON fields.
  - Precompile regexes with RE2; keep pattern table as data.
  - Redaction helper for producing safe previews (mask middle).
- Tests (`*.test.ts`):
  - Format detector coverage.
  - Entropy thresholds (positive/negative cases).
  - Overflow blocking.
  - Redaction output stability.
- Micro-benchmark (optional): scan typical payloads + adversarial inputs.

## Integration (PR 2)
- Apply scan at the **runtime boundaries** where user-controlled text enters or leaves:
  - Inbound messages before they are sent to providers / LLM calls.
  - Outbound tool messages before they hit logs / consoles / replies.
- On block:
  - Return explicit error response: “Message blocked: secret scanning is enabled and input exceeds limit” or “secret detected.”
  - Do **not** leak raw secrets in errors.
 - On redact:
   - Redact detected spans in the scanned content (and only within scanned range if truncated).

## Rollout
- Default **off** to avoid breaking existing installs.
- Document config in `docs/gateway/security.md` + `docs/gateway/configuration.md`.

## Deliverables
- PR 1: core module + tests + config schema.
- PR 2: wiring + errors + docs.
