import type { ModelCatalogEntry } from "openclaw/plugin-sdk/agent-runtime";
import { CLAUDE_CLI_BACKEND_ID, CLAUDE_CLI_DEFAULT_ALLOWLIST_REFS } from "./cli-constants.js";

// Claude CLI auth is subscription-backed, so catalog rows only need picker metadata.
const CLAUDE_CLI_DEFAULT_CONTEXT_WINDOW = 200_000;

const CLAUDE_CLI_MODEL_LABELS: Record<string, string> = {
  "claude-opus-4-7": "Claude Opus 4.7 (Claude CLI)",
  "claude-opus-4-6": "Claude Opus 4.6 (Claude CLI)",
  "claude-opus-4-5": "Claude Opus 4.5 (Claude CLI)",
  "claude-sonnet-4-6": "Claude Sonnet 4.6 (Claude CLI)",
  "claude-sonnet-4-5": "Claude Sonnet 4.5 (Claude CLI)",
  "claude-haiku-4-5": "Claude Haiku 4.5 (Claude CLI)",
};

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

export function buildClaudeCliCatalogEntries(): ModelCatalogEntry[] {
  return extractClaudeCliModelIds().map((id) => ({
    id,
    name: CLAUDE_CLI_MODEL_LABELS[id] ?? `${id} (Claude CLI)`,
    provider: CLAUDE_CLI_BACKEND_ID,
    reasoning: true,
    input: ["text", "image"],
    contextWindow: CLAUDE_CLI_DEFAULT_CONTEXT_WINDOW,
  }));
}
