import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type { SessionEntry } from "./types.js";

type SessionContextTokenOwner = Pick<
  SessionEntry,
  | "agentHarnessId"
  | "contextTokens"
  | "contextTokensSource"
  | "model"
  | "modelProvider"
  | "modelSelectionLocked"
>;

/** Returns persisted telemetry only when it belongs to the current producing selection. */
export function resolveTrustedSessionContextTokens(params: {
  entry: SessionContextTokenOwner | undefined;
  provider: string | null | undefined;
  model: string | null | undefined;
  agentHarnessId: string | null | undefined;
}): number | undefined {
  const contextTokens = params.entry?.contextTokens;
  if (typeof contextTokens !== "number" || !Number.isFinite(contextTokens) || contextTokens <= 0) {
    return undefined;
  }
  // Locked sessions own their native window, including rows created before
  // context-window provenance was persisted.
  if (params.entry?.modelSelectionLocked === true) {
    return contextTokens;
  }
  if (params.entry?.contextTokensSource !== "runtime") {
    return undefined;
  }
  const entryProvider = normalizeLowercaseStringOrEmpty(params.entry.modelProvider);
  const entryModel = normalizeLowercaseStringOrEmpty(params.entry.model);
  const entryHarness = normalizeLowercaseStringOrEmpty(params.entry.agentHarnessId);
  const currentProvider = normalizeLowercaseStringOrEmpty(params.provider);
  const currentModel = normalizeLowercaseStringOrEmpty(params.model);
  const currentHarness = normalizeLowercaseStringOrEmpty(params.agentHarnessId);
  if (
    !entryProvider ||
    !entryModel ||
    !entryHarness ||
    !currentProvider ||
    !currentModel ||
    !currentHarness
  ) {
    return undefined;
  }
  return entryProvider === currentProvider &&
    entryModel === currentModel &&
    entryHarness === currentHarness
    ? contextTokens
    : undefined;
}
