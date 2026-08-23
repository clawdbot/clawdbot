type SkillWorkshopModelContext = {
  contextTokens?: number;
  contextWindow?: number;
};

const DEFAULT_MODEL_CONTEXT_TOKENS = 8_192;
const MODEL_CONTEXT_PROJECTION_SHARE = 0.35;
const MIN_PROJECTION_CHARS = 256;

const PROJECTION_CAPS = {
  artifactChars: 20_000,
  collectionHistoryChars: 8_000,
  historyTranscriptChars: 80_000,
  reviewTranscriptChars: 60_000,
} as const;

function positiveInteger(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

export function resolveSkillWorkshopModelContextTokens(
  model: SkillWorkshopModelContext | undefined,
): number | undefined {
  const contextTokens = positiveInteger(model?.contextTokens);
  const contextWindow = positiveInteger(model?.contextWindow);
  if (contextTokens === undefined) {
    return contextWindow;
  }
  return contextWindow === undefined ? contextTokens : Math.min(contextTokens, contextWindow);
}

export function resolveSkillWorkshopProjectionBudgets(contextTokens?: number) {
  const effectiveContextTokens = positiveInteger(contextTokens) ?? DEFAULT_MODEL_CONTEXT_TOKENS;
  const contextChars = Math.max(
    MIN_PROJECTION_CHARS,
    Math.floor(effectiveContextTokens * MODEL_CONTEXT_PROJECTION_SHARE),
  );
  return {
    artifactChars: Math.min(contextChars, PROJECTION_CAPS.artifactChars),
    collectionHistoryChars: Math.min(contextChars, PROJECTION_CAPS.collectionHistoryChars),
    historyTranscriptChars: Math.min(contextChars, PROJECTION_CAPS.historyTranscriptChars),
    reviewTranscriptChars: Math.min(contextChars, PROJECTION_CAPS.reviewTranscriptChars),
  };
}
