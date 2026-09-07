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

function resolvePositiveContextTokens(value: number | null | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function isExactProducerSelection(params: {
  entry: SessionContextTokenOwner | undefined;
  provider: string | null | undefined;
  model: string | null | undefined;
  agentHarnessId: string | null | undefined;
}): boolean {
  const entryProvider = normalizeLowercaseStringOrEmpty(params.entry?.modelProvider);
  const entryModel = normalizeLowercaseStringOrEmpty(params.entry?.model);
  const entryHarness = normalizeLowercaseStringOrEmpty(params.entry?.agentHarnessId);
  const currentProvider = normalizeLowercaseStringOrEmpty(params.provider);
  const currentModel = normalizeLowercaseStringOrEmpty(params.model);
  const currentHarness = normalizeLowercaseStringOrEmpty(params.agentHarnessId);
  return Boolean(
    entryProvider &&
    entryModel &&
    entryHarness &&
    currentProvider &&
    currentModel &&
    currentHarness &&
    entryProvider === currentProvider &&
    entryModel === currentModel &&
    entryHarness === currentHarness,
  );
}

/** Returns a persisted effective resolution only for its exact producing selection. */
function resolveMatchingPersistedResolution(params: {
  entry: SessionContextTokenOwner | undefined;
  provider: string | null | undefined;
  model: string | null | undefined;
  agentHarnessId: string | null | undefined;
}): number | undefined {
  if (params.entry?.contextTokensSource !== "resolved-v1") {
    return undefined;
  }
  return isExactProducerSelection(params)
    ? resolvePositiveContextTokens(params.entry?.contextTokens)
    : undefined;
}

/** Returns persisted telemetry only when it belongs to the current producing selection. */
function resolveTrustedSessionContextTokens(params: {
  entry: SessionContextTokenOwner | undefined;
  provider: string | null | undefined;
  model: string | null | undefined;
  agentHarnessId: string | null | undefined;
}): number | undefined {
  const contextTokens = resolvePositiveContextTokens(params.entry?.contextTokens);
  if (contextTokens === undefined) {
    return undefined;
  }
  const entryProvider = normalizeLowercaseStringOrEmpty(params.entry?.modelProvider);
  const entryModel = normalizeLowercaseStringOrEmpty(params.entry?.model);
  const currentProvider = normalizeLowercaseStringOrEmpty(params.provider);
  const currentModel = normalizeLowercaseStringOrEmpty(params.model);
  // Locked sessions own their native window, including rows created before
  // context-window provenance was persisted. A known selection mismatch is a
  // different owner, while missing identity remains a supported legacy state.
  if (params.entry?.modelSelectionLocked === true) {
    if (
      (entryProvider && currentProvider && entryProvider !== currentProvider) ||
      (entryModel && currentModel && entryModel !== currentModel)
    ) {
      return undefined;
    }
    return contextTokens;
  }
  if (params.entry?.contextTokensSource !== "runtime") {
    return undefined;
  }
  return isExactProducerSelection(params) ? contextTokens : undefined;
}

type SessionContextTokenProjectionParams = {
  entry: SessionContextTokenOwner | undefined;
  provider: string | null | undefined;
  model: string | null | undefined;
  agentHarnessId: string | null | undefined;
  resolvedContextTokens: number | null | undefined;
  resolvedContextTokensSource?: "resolved" | "resolved-v1";
  authoredContextTokens?: number | null | undefined;
};

export type ProjectedSessionContextTokenBudget = {
  contextTokens: number;
  contextTokensSource: SessionEntry["contextTokensSource"];
};

/** Projects the context budget and its owner for the current session selection. */
export function resolveProjectedSessionContextTokenBudget(
  params: SessionContextTokenProjectionParams,
): ProjectedSessionContextTokenBudget | undefined {
  const resolvedContextTokens = resolvePositiveContextTokens(params.resolvedContextTokens);
  const authoredContextTokens = resolvePositiveContextTokens(params.authoredContextTokens);
  const trustedContextTokens = resolveTrustedSessionContextTokens(params);
  if (params.entry?.modelSelectionLocked === true && trustedContextTokens !== undefined) {
    return {
      contextTokens: trustedContextTokens,
      contextTokensSource: params.entry.contextTokensSource,
    };
  }

  const resolvedContextTokensSource = params.resolvedContextTokensSource ?? "resolved";
  if (authoredContextTokens !== undefined) {
    if (resolvedContextTokens === undefined) {
      return { contextTokens: authoredContextTokens, contextTokensSource: "resolved" };
    }
    return {
      contextTokens: Math.min(authoredContextTokens, resolvedContextTokens),
      contextTokensSource:
        authoredContextTokens < resolvedContextTokens ? "resolved" : resolvedContextTokensSource,
    };
  }
  if (trustedContextTokens !== undefined && resolvedContextTokens !== undefined) {
    return trustedContextTokens <= resolvedContextTokens
      ? {
          contextTokens: trustedContextTokens,
          contextTokensSource: params.entry?.contextTokensSource,
        }
      : {
          contextTokens: resolvedContextTokens,
          contextTokensSource: resolvedContextTokensSource,
        };
  }
  if (trustedContextTokens !== undefined) {
    return {
      contextTokens: trustedContextTokens,
      contextTokensSource: params.entry?.contextTokensSource,
    };
  }
  if (resolvedContextTokens !== undefined) {
    return {
      contextTokens: resolvedContextTokens,
      contextTokensSource: resolvedContextTokensSource,
    };
  }
  const persistedResolution = resolveMatchingPersistedResolution(params);
  return persistedResolution === undefined
    ? undefined
    : { contextTokens: persistedResolution, contextTokensSource: "resolved-v1" };
}

/** Projects the context window owned by the current session selection. */
export function resolveProjectedSessionContextTokens(
  params: SessionContextTokenProjectionParams,
): number | undefined {
  return resolveProjectedSessionContextTokenBudget(params)?.contextTokens;
}
