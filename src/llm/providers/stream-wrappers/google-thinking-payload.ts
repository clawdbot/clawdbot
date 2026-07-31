import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";

/** @deprecated Google provider-owned stream helper; do not use from third-party plugins. */
export type GoogleThinkingLevel = "MINIMAL" | "LOW" | "MEDIUM" | "HIGH";
/** @deprecated Google provider-owned stream helper; do not use from third-party plugins. */
export type GoogleThinkingInputLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "adaptive"
  | "high"
  | "max"
  | "xhigh";

// Gemini 2.5 Pro only works in thinking mode and rejects thinkingBudget=0 with
// "Budget 0 is invalid. This model only works in thinking mode."
/** @deprecated Google provider-owned stream helper; do not use from third-party plugins. */
export function isGoogleThinkingRequiredModel(modelId: string): boolean {
  return normalizeLowercaseStringOrEmpty(modelId).includes("gemini-2.5-pro");
}

/** @deprecated Google provider-owned stream helper; do not use from third-party plugins. */
export function isGoogleGemini25ThinkingBudgetModel(modelId: string): boolean {
  return /(?:^|\/)gemini-2\.5-/.test(normalizeLowercaseStringOrEmpty(modelId));
}

/** @deprecated Google provider-owned stream helper; do not use from third-party plugins. */
export function isGoogleGemini3ProModel(modelId: string): boolean {
  const normalized = normalizeLowercaseStringOrEmpty(modelId);
  return /(?:^|\/)gemini-(?:3(?:\.\d+)?-pro|pro-latest)(?:-|$)/.test(normalized);
}

/** @deprecated Google provider-owned stream helper; do not use from third-party plugins. */
export function isGoogleGemini3FlashModel(modelId: string): boolean {
  const normalized = normalizeLowercaseStringOrEmpty(modelId);
  return /(?:^|\/)gemini-(?:3(?:\.\d+)?-flash|flash(?:-lite)?-latest)(?:-|$)/.test(normalized);
}

/** @deprecated Google provider-owned stream helper; do not use from third-party plugins. */
export function isGoogleGemini3ThinkingLevelModel(modelId: string): boolean {
  return isGoogleGemini3ProModel(modelId) || isGoogleGemini3FlashModel(modelId);
}

/**
 * Maps legacy numeric/semantic thinking input onto Gemini 3's provider enum.
 * @deprecated Google provider-owned stream helper; do not use from third-party plugins.
 */
export function resolveGoogleGemini3ThinkingLevel(params: {
  modelId?: string;
  thinkingLevel?: GoogleThinkingInputLevel;
  thinkingBudget?: number;
}): GoogleThinkingLevel | undefined {
  if (typeof params.modelId !== "string") {
    return undefined;
  }
  if (isGoogleGemini3ProModel(params.modelId)) {
    switch (params.thinkingLevel) {
      case "off":
      case "minimal":
      case "low":
        return "LOW";
      case "medium":
      case "high":
      case "max":
      case "xhigh":
        return "HIGH";
      case "adaptive":
        return undefined;
      case undefined:
        break;
    }
    if (typeof params.thinkingBudget === "number") {
      if (params.thinkingBudget < 0) {
        return undefined;
      }
      return params.thinkingBudget <= 2048 ? "LOW" : "HIGH";
    }
    return undefined;
  }
  if (!isGoogleGemini3FlashModel(params.modelId)) {
    return undefined;
  }
  switch (params.thinkingLevel) {
    case "off":
    case "minimal":
      return "MINIMAL";
    case "low":
      return "LOW";
    case "medium":
      return "MEDIUM";
    case "high":
    case "max":
    case "xhigh":
      return "HIGH";
    case "adaptive":
      return undefined;
    case undefined:
      break;
  }
  if (typeof params.thinkingBudget !== "number") {
    return undefined;
  }
  if (params.thinkingBudget < 0) {
    return undefined;
  }
  if (params.thinkingBudget <= 0) {
    return "MINIMAL";
  }
  if (params.thinkingBudget <= 2048) {
    return "LOW";
  }
  if (params.thinkingBudget <= 8192) {
    return "MEDIUM";
  }
  return "HIGH";
}

/**
 * Removes `thinkingBudget=0` only for Gemini models that reject disabled thinking.
 * @deprecated Google provider-owned stream helper; do not use from third-party plugins.
 */
export function stripInvalidGoogleThinkingBudget(params: {
  thinkingConfig: Record<string, unknown>;
  modelId?: string;
}): boolean {
  if (
    params.thinkingConfig.thinkingBudget !== 0 ||
    typeof params.modelId !== "string" ||
    !isGoogleThinkingRequiredModel(params.modelId)
  ) {
    return false;
  }
  delete params.thinkingConfig.thinkingBudget;
  return true;
}

function isGemma4Model(modelId: string): boolean {
  return normalizeLowercaseStringOrEmpty(modelId).startsWith("gemma-4");
}

function mapThinkLevelToGemma4ThinkingLevel(
  thinkingLevel?: GoogleThinkingInputLevel,
): "MINIMAL" | "HIGH" | undefined {
  switch (thinkingLevel) {
    case "off":
      return undefined;
    case "minimal":
    case "low":
      return "MINIMAL";
    case "medium":
    case "adaptive":
    case "high":
    case "max":
    case "xhigh":
      return "HIGH";
    default:
      return undefined;
  }
}

function normalizeGemma4ThinkingLevel(value: unknown): "MINIMAL" | "HIGH" | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  switch (value.trim().toUpperCase()) {
    case "MINIMAL":
    case "LOW":
      return "MINIMAL";
    case "MEDIUM":
    case "HIGH":
      return "HIGH";
    default:
      return undefined;
  }
}

/**
 * Normalizes Google thinking config across SDK payload shapes before provider transport.
 * @deprecated Google provider-owned stream helper; do not use from third-party plugins.
 */
export function sanitizeGoogleThinkingPayload(params: {
  payload: unknown;
  modelId?: string;
  thinkingLevel?: GoogleThinkingInputLevel;
}): void {
  if (!params.payload || typeof params.payload !== "object") {
    return;
  }
  const payloadObj = params.payload as Record<string, unknown>;
  sanitizeGoogleThinkingConfigContainer({
    container: payloadObj.config,
    modelId: params.modelId,
    thinkingLevel: params.thinkingLevel,
  });
  sanitizeGoogleThinkingConfigContainer({
    container: payloadObj.generationConfig,
    modelId: params.modelId,
    thinkingLevel: params.thinkingLevel,
  });
}

function sanitizeGoogleThinkingConfigContainer(params: {
  container: unknown;
  modelId?: string;
  thinkingLevel?: GoogleThinkingInputLevel;
}): void {
  if (!params.container || typeof params.container !== "object") {
    return;
  }
  const configObj = params.container as Record<string, unknown>;
  const thinkingConfig = configObj.thinkingConfig;
  if (!thinkingConfig || typeof thinkingConfig !== "object") {
    return;
  }
  const thinkingConfigObj = thinkingConfig as Record<string, unknown>;

  if (typeof params.modelId === "string" && isGemma4Model(params.modelId)) {
    // Gemma 4 accepts thinkingLevel but not thinkingBudget; map legacy budget
    // inputs before deleting the unsupported numeric field.
    const normalizedThinkingLevel = normalizeGemma4ThinkingLevel(thinkingConfigObj.thinkingLevel);
    const explicitMappedLevel = mapThinkLevelToGemma4ThinkingLevel(params.thinkingLevel);
    const disabledViaBudget =
      typeof thinkingConfigObj.thinkingBudget === "number" && thinkingConfigObj.thinkingBudget <= 0;
    const hadThinkingBudget = thinkingConfigObj.thinkingBudget !== undefined;
    delete thinkingConfigObj.thinkingBudget;

    if (
      params.thinkingLevel === "off" ||
      (disabledViaBudget && explicitMappedLevel === undefined && !normalizedThinkingLevel)
    ) {
      delete thinkingConfigObj.thinkingLevel;
      if (Object.keys(thinkingConfigObj).length === 0) {
        delete configObj.thinkingConfig;
      }
      return;
    }

    const mappedLevel =
      explicitMappedLevel ?? normalizedThinkingLevel ?? (hadThinkingBudget ? "MINIMAL" : undefined);

    if (mappedLevel) {
      thinkingConfigObj.thinkingLevel = mappedLevel;
    }
    return;
  }

  const thinkingBudget = thinkingConfigObj.thinkingBudget;

  if (
    params.thinkingLevel === "adaptive" &&
    typeof params.modelId === "string" &&
    isGoogleGemini25ThinkingBudgetModel(params.modelId)
  ) {
    delete thinkingConfigObj.thinkingLevel;
    thinkingConfigObj.thinkingBudget = -1;
    return;
  }

  if (
    params.thinkingLevel === "adaptive" &&
    typeof params.modelId === "string" &&
    isGoogleGemini3ThinkingLevelModel(params.modelId)
  ) {
    // Gemini 3 adaptive mode means omit both controls so the provider chooses.
    delete thinkingConfigObj.thinkingBudget;
    delete thinkingConfigObj.thinkingLevel;
    if (Object.keys(thinkingConfigObj).length === 0) {
      delete configObj.thinkingConfig;
    }
    return;
  }

  if (typeof params.modelId === "string" && isGoogleGemini3ThinkingLevelModel(params.modelId)) {
    const mappedLevel = resolveGoogleGemini3ThinkingLevel({
      modelId: params.modelId,
      thinkingLevel: params.thinkingLevel,
      thinkingBudget: typeof thinkingBudget === "number" ? thinkingBudget : undefined,
    });
    delete thinkingConfigObj.thinkingBudget;
    if (mappedLevel) {
      // Gemini 3 uses thinkingLevel; leaving thinkingBudget would make mixed-mode payloads.
      thinkingConfigObj.thinkingLevel = mappedLevel;
    }
    if (Object.keys(thinkingConfigObj).length === 0) {
      delete configObj.thinkingConfig;
    }
    return;
  }

  if (
    stripInvalidGoogleThinkingBudget({ thinkingConfig: thinkingConfigObj, modelId: params.modelId })
  ) {
    if (Object.keys(thinkingConfigObj).length === 0) {
      delete configObj.thinkingConfig;
    }
    return;
  }

  if (typeof thinkingBudget !== "number" || thinkingBudget >= 0) {
    return;
  }

  // shared model runtime can emit thinkingBudget=-1 for some Google model IDs; a negative budget
  // is invalid for Google-compatible backends and can lead to malformed handling.
  delete thinkingConfigObj.thinkingBudget;
  if (Object.keys(thinkingConfigObj).length === 0) {
    delete configObj.thinkingConfig;
  }
}
