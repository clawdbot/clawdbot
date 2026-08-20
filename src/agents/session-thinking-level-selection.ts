import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { normalizeThinkLevel } from "../auto-reply/thinking.shared.js";
import type { SessionThinkingLevelSelection } from "../config/sessions/thinking-level-selection.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";

type ThinkingSelectionParams = {
  provider: string;
  model: string;
  agentRuntime?: string | null;
  level?: string | null;
};

function createSessionThinkingLevelSelection(
  params: ThinkingSelectionParams,
): SessionThinkingLevelSelection | undefined {
  const provider = normalizeProviderId(params.provider);
  const model = normalizeLowercaseStringOrEmpty(params.model);
  const agentRuntime = normalizeLowercaseStringOrEmpty(params.agentRuntime);
  const level = normalizeThinkLevel(params.level);
  return provider && model && agentRuntime && level
    ? { provider, model, agentRuntime, level }
    : undefined;
}

export function readSessionThinkingLevelSelection(
  entry: InternalSessionEntry | undefined,
): SessionThinkingLevelSelection | undefined {
  const selection = entry?.thinkingLevelSelection;
  return selection ? { ...selection } : undefined;
}

export function clearSessionThinkingLevelSelection(entry: InternalSessionEntry): void {
  delete entry.thinkingLevelSelection;
}

/** Records the exact model and harness that validated a persisted thinking override. */
export function updateSessionThinkingLevelSelection(
  entry: InternalSessionEntry,
  params: ThinkingSelectionParams,
): void {
  const selection = createSessionThinkingLevelSelection(params);
  if (selection) {
    entry.thinkingLevelSelection = selection;
  } else {
    delete entry.thinkingLevelSelection;
  }
}

export function sessionThinkingLevelSelectionMatches(params: {
  entry?: InternalSessionEntry;
  provider: string;
  model: string;
  agentRuntime: string;
  level: string;
}): boolean {
  const actual = readSessionThinkingLevelSelection(params.entry);
  const expected = createSessionThinkingLevelSelection(params);
  return (
    actual !== undefined &&
    expected !== undefined &&
    actual.provider === expected.provider &&
    actual.model === expected.model &&
    actual.agentRuntime === expected.agentRuntime &&
    actual.level === expected.level
  );
}
