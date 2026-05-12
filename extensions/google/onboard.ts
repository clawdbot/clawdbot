import {
  applyAgentDefaultModelPrimary,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-onboard";

export const GOOGLE_GEMINI_DEFAULT_MODEL = "google/gemini-3.1-pro-preview";
const RETIRED_GOOGLE_GEMINI_MODEL_REFS = new Set([
  "gemini-3-pro",
  "gemini-3-pro-preview",
  "google/gemini-3-pro",
  "google/gemini-3-pro-preview",
]);

function isRetiredGeminiModelRef(value: unknown): boolean {
  if (typeof value !== "string") {
    return false;
  }
  const modelRef = value.trim();
  if (RETIRED_GOOGLE_GEMINI_MODEL_REFS.has(modelRef)) {
    return true;
  }
  return modelRef.endsWith("/gemini-3-pro") || modelRef.endsWith("/gemini-3-pro-preview");
}

function hasRetiredGeminiDefaultModelRefs(cfg: OpenClawConfig): boolean {
  const defaults = cfg.agents?.defaults;
  const model = defaults?.model as unknown;
  if (model && typeof model === "object") {
    const fallbacks = (model as { fallbacks?: unknown }).fallbacks;
    if (
      Array.isArray(fallbacks) &&
      fallbacks.some((fallback) => isRetiredGeminiModelRef(fallback))
    ) {
      return true;
    }
  }

  const models = defaults?.models;
  if (
    models &&
    typeof models === "object" &&
    Object.keys(models).some((modelRef) => isRetiredGeminiModelRef(modelRef))
  ) {
    return true;
  }

  const providerConfigs = cfg.models?.providers;
  if (!providerConfigs) {
    return false;
  }
  return Object.values(providerConfigs).some((providerConfig) =>
    Array.isArray(providerConfig.models)
      ? providerConfig.models.some((providerModel) => isRetiredGeminiModelRef(providerModel.id))
      : false,
  );
}

export function applyGoogleGeminiModelDefault(cfg: OpenClawConfig): {
  next: OpenClawConfig;
  changed: boolean;
} {
  const current = cfg.agents?.defaults?.model as unknown;
  const currentPrimary =
    typeof current === "string"
      ? current.trim() || undefined
      : current &&
          typeof current === "object" &&
          typeof (current as { primary?: unknown }).primary === "string"
        ? ((current as { primary: string }).primary || "").trim() || undefined
        : undefined;
  if (currentPrimary === GOOGLE_GEMINI_DEFAULT_MODEL && !hasRetiredGeminiDefaultModelRefs(cfg)) {
    return { next: cfg, changed: false };
  }
  return {
    next: applyAgentDefaultModelPrimary(cfg, GOOGLE_GEMINI_DEFAULT_MODEL),
    changed: true,
  };
}
