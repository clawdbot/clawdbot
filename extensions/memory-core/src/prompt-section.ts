// Memory Core plugin module implements prompt section behavior.
import type { MemoryPromptSectionBuilder } from "openclaw/plugin-sdk/memory-core-host-runtime-core";

export const buildPromptSection: MemoryPromptSectionBuilder = ({
  availableTools,
  citationsMode,
}) => {
  const hasMemorySearch = availableTools.has("memory_search");
  const hasMemoryGet = availableTools.has("memory_get");
  const hasMemoryStore = availableTools.has("memory_store");

  if (!hasMemorySearch && !hasMemoryGet && !hasMemoryStore) {
    return [];
  }

  const lines = ["## Memory Recall"];
  if (hasMemorySearch && hasMemoryGet) {
    lines.push(
      "Before answering anything about prior work, decisions, dates, people, preferences, or todos: run memory_search on MEMORY.md + memory/*.md + indexed session transcripts; then use memory_get to pull only the needed lines. If low confidence after search, say you checked.",
    );
  } else if (hasMemorySearch) {
    lines.push(
      "Before answering anything about prior work, decisions, dates, people, preferences, or todos: run memory_search on MEMORY.md + memory/*.md + indexed session transcripts and answer from the matching results. If low confidence after search, say you checked.",
    );
  } else if (hasMemoryGet) {
    lines.push(
      "Before answering anything about prior work, decisions, dates, people, preferences, or todos that already point to a specific memory file or note: run memory_get to pull only the needed lines. If low confidence after reading them, say you checked.",
    );
  }
  if (hasMemoryStore) {
    lines.push(
      "For an explicit remember request, call memory_store before replying. Do not claim persistence unless the tool result includes details.memoryPersistence. A persistence receipt proves the durable write only; it does not prove semantic recall or embedding-index availability.",
    );
  }

  if (citationsMode === "off" && (hasMemorySearch || hasMemoryGet)) {
    lines.push(
      "Citations are disabled: do not mention file paths or line numbers in replies unless the user explicitly asks.",
    );
  } else if (hasMemorySearch || hasMemoryGet) {
    lines.push(
      "Citations: include Source: <path#line> when it helps the user verify memory snippets.",
    );
  }
  lines.push("");
  return lines;
};
