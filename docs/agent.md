# Agent Abstraction Refactor Plan

Goal: support multiple agent CLIs (Claude, Codex, Pi, Opencode, Gemini) cleanly, without legacy flags, and make parsing/injection per-agent. Keep WhatsApp/Twilio plumbing intact.

## Overview
- Introduce a pluggable agent layer (`src/agents/*`), selected by config.
- Normalize config (`agent` block) and remove `claudeOutputFormat` legacy knobs.
- Provide per-agent argv builders and output parsers (including NDJSON streams).
- Preserve MEDIA-token handling and shared queue/heartbeat behavior.

## Configuration
- New shape (no backward compat):
  ```json5
  inbound: {
    reply: {
      mode: "command",
      agent: {
        kind: "claude" | "opencode" | "pi" | "codex" | "gemini",
        format?: "text" | "json",
        identityPrefix?: string
      },
      command: ["claude", "{{Body}}"],
      cwd?: string,
      session?: { ... },
      timeoutSeconds?: number,
      bodyPrefix?: string,
      mediaUrl?: string,
      mediaMaxMb?: number,
      typingIntervalSeconds?: number,
      heartbeatMinutes?: number
    }
  }
  ```
- Validation moves to `config.ts` (new `AgentKind`/`AgentConfig` types).
- If `agent` is missing → config error.

## Agent modules
- `src/agents/types.ts` – `AgentKind`, `AgentSpec`:
  - `buildArgs(argv: string[], body: string, ctx: { sessionId?, isNewSession?, sendSystemOnce?, systemSent?, identityPrefix? }): string[]`
  - `parse(stdout: string): { text?: string; mediaUrls?: string[]; meta?: AgentMeta }`
- `src/agents/claude.ts` – current flag injection (`--output-format`, `-p`), identity prepend.
- `src/agents/opencode.ts` – reuse `parseOpencodeJson` (from PR #5), inject `--format json`, session flag `--session` defaults, identity prefix.
- `src/agents/pi.ts` – parse NDJSON `AssistantMessageEvent` (final `message_end.message.content[text]`), inject `--mode json`/`-p` defaults, session flags.
- `src/agents/codex.ts` – parse Codex JSONL (last `item` with `type:"agent_message"`; usage from `turn.completed`), inject `codex exec --json --skip-git-repo-check`, sandbox default read-only.
- `src/agents/gemini.ts` – minimal parsing (plain text), identity prepend, honors `--output-format` when `format` is set, and defaults to `--resume {{SessionId}}` for session resume (new sessions need no flag). Override `sessionArgNew/sessionArgResume` if you use a different session strategy.
- Shared MEDIA extraction stays in `media/parse.ts`.

## Command runner changes
- `runCommandReply`:
  - Resolve agent spec from config.
  - Apply `buildArgs` (handles identity prepend and session args per agent).
  - Run command; send stdout to `spec.parse` → `text`, `mediaUrls`, `meta` (stored as `agentMeta`).
  - Remove `claudeMeta` naming; tests updated to `agentMeta`.

## Sessions
- Session arg defaults become agent-specific (Claude: `--resume/--session-id`; Opencode/Pi/Codex: `--session`).
- Still overridable via `sessionArgNew/sessionArgResume` in config.

## Tests
- Update existing tests to new config (no `claudeOutputFormat`).
- Add fixtures:
  - Opencode NDJSON sample (from PR #5) → parsed text + meta.
  - Codex NDJSON sample (captured: thread/turn/item/usage) → parsed text.
  - Pi NDJSON sample (AssistantMessageEvent) → parsed text.
- Ensure MEDIA token parsing works on agent text output.

## Docs
- README: rename “Claude-aware” → “Multi-agent (Claude, Codex, Pi, Opencode)”.
- New short guide per agent (Opencode doc from PR #5; add Codex/Pi snippets).
- Mention identityPrefix override and session arg differences.

## Migration
- Breaking change: configs must specify `agent`. Remove old `claudeOutputFormat` keys.
- Provide migration note in CHANGELOG 1.3.x.

## Out of scope
- No media binary support; still relies on MEDIA tokens in text.
- No UI changes; WhatsApp/Twilio plumbing unchanged.
