// Pixverse plugin module implements constants behavior.
export const PIXVERSE_PROVIDER_ID = "pixverse";

export const PIXVERSE_BASE_URL_BY_REGION = {
  international: "https://app-api.pixverse.ai/openapi/v2",
  cn: "https://app-api.pixverseai.cn/openapi/v2",
} as const;

export type PixVerseApiRegion = keyof typeof PIXVERSE_BASE_URL_BY_REGION;

export const DEFAULT_PIXVERSE_REGION = "international" satisfies PixVerseApiRegion;
export const DEFAULT_PIXVERSE_MODEL_ID = "v6";
export const PIXVERSE_DEFAULT_VIDEO_MODEL_REF = `${PIXVERSE_PROVIDER_ID}/${DEFAULT_PIXVERSE_MODEL_ID}`;
