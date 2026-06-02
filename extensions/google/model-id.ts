const ANTIGRAVITY_BARE_PRO_IDS = new Set(["gemini-3-pro", "gemini-3.1-pro", "gemini-3-1-pro"]);
const GOOGLE_PROVIDER_PREFIX = "google/";

export function normalizeGoogleModelId(id: string): string {
  if (id.startsWith(GOOGLE_PROVIDER_PREFIX)) {
    const modelId = id.slice(GOOGLE_PROVIDER_PREFIX.length);
    const normalizedModelId = normalizeGoogleModelId(modelId);
    return normalizedModelId === modelId ? id : `${GOOGLE_PROVIDER_PREFIX}${normalizedModelId}`;
  }
  if (id === "gemini-3-pro" || id === "gemini-3-pro-preview") {
    return "gemini-3.1-pro-preview";
  }
  if (id === "gemini-3-flash") {
    return "gemini-3-flash-preview";
  }
  // Google exposes Gemini 3.1 Pro in the Gemini API as the preview-suffixed id.
  // Keep the bare form as a user convenience alias, not as a canonical API id.
  if (id === "gemini-3.1-pro") {
    return "gemini-3.1-pro-preview";
  }
  // Gemini 3.1 Flash Lite graduated to GA on 2026-05-07; the -preview
  // endpoint is deprecated (shutdown 2026-05-25). Map old preview name
  // to the stable GA id.
  if (id === "gemini-3.1-flash-lite-preview") {
    return "gemini-3.1-flash-lite";
  }
  if (id === "gemini-3.1-flash" || id === "gemini-3.1-flash-preview") {
    return "gemini-3-flash-preview";
  }
  if (id === "gemma-4-26b") {
    return "gemma-4-26b-a4b-it";
  }
  return id;
}

export function normalizeAntigravityModelId(id: string): string {
  if (ANTIGRAVITY_BARE_PRO_IDS.has(id)) {
    return `${id}-low`;
  }
  return id;
}
