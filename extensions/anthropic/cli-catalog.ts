/**
 * Claude CLI model catalog entries. Subscription-backed CLI models use picker
 * metadata and do not require API-key auth rows.
 */
import type { ModelCatalogEntry } from "openclaw/plugin-sdk/agent-runtime";
import { CLAUDE_CLI_BACKEND_ID, CLAUDE_CLI_DEFAULT_ALLOWLIST_REFS } from "./cli-constants.js";

// Claude CLI auth is subscription-backed, so catalog rows only need picker metadata.
const CLAUDE_CLI_DEFAULT_CONTEXT_WINDOW = 200_000;
const CLAUDE_CLI_CONTEXT_WINDOWS: Record<string, number> = {
  "claude-sonnet-5": 1_000_000,
};
const CLAUDE_CLI_DEFAULT_MAX_OUTPUT_TOKENS = 64_000;
const CLAUDE_CLI_MAX_OUTPUT_TOKENS: Record<string, number> = {
  "claude-opus-4-8": 128_000,
  "claude-opus-4-7": 128_000,
  "claude-opus-4-6": 128_000,
  "claude-sonnet-5": 128_000,
  "claude-sonnet-4-6": 128_000,
};

const CLAUDE_CLI_MODEL_LABELS: Record<string, string> = {
  "claude-opus-4-8": "Claude Opus 4.8 (Claude CLI)",
  "claude-opus-4-7": "Claude Opus 4.7 (Claude CLI)",
  "claude-opus-4-6": "Claude Opus 4.6 (Claude CLI)",
  "claude-sonnet-5": "Claude Sonnet 5 (Claude CLI)",
  "claude-sonnet-4-6": "Claude Sonnet 4.6 (Claude CLI)",
};

function resolveClaudeCliImageMediaInput(id: string): ModelCatalogEntry["mediaInput"] {
  const maxSidePx =
    id === "claude-opus-4-8" || id === "claude-opus-4-7" || id === "claude-sonnet-5" ? 2576 : 1568;
  return {
    image: {
      maxSidePx,
      preferredSidePx: maxSidePx,
      tokenMode: "provider",
    },
  };
}

function extractClaudeCliModelIds(): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const ref of CLAUDE_CLI_DEFAULT_ALLOWLIST_REFS) {
    if (!ref.startsWith(`${CLAUDE_CLI_BACKEND_ID}/`)) {
      continue;
    }
    const id = ref.slice(CLAUDE_CLI_BACKEND_ID.length + 1);
    if (id.length === 0 || seen.has(id)) {
      continue;
    }
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

/** Build catalog entries for the default Claude CLI allowlist. */
export function buildClaudeCliCatalogEntries(): ModelCatalogEntry[] {
  return extractClaudeCliModelIds().map((id) => {
    return {
      id,
      name: CLAUDE_CLI_MODEL_LABELS[id] ?? `${id} (Claude CLI)`,
      provider: CLAUDE_CLI_BACKEND_ID,
      reasoning: true,
      input: ["text", "image"],
      mediaInput: resolveClaudeCliImageMediaInput(id),
      contextWindow: CLAUDE_CLI_CONTEXT_WINDOWS[id] ?? CLAUDE_CLI_DEFAULT_CONTEXT_WINDOW,
      maxTokens: CLAUDE_CLI_MAX_OUTPUT_TOKENS[id] ?? CLAUDE_CLI_DEFAULT_MAX_OUTPUT_TOKENS,
    };
  });
}
