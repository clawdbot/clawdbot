// Google provider module implements model/runtime integration.
import type {
  ProviderResolveDynamicModelContext,
  ProviderRuntimeModel,
} from "openclaw/plugin-sdk/plugin-entry";
import { resolveFamilyForwardCompatModel } from "openclaw/plugin-sdk/provider-model-shared";
import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { normalizeGoogleModelId } from "./model-id.js";

const GOOGLE_GEMINI_CLI_PROVIDER_ID = "google-gemini-cli";
const GOOGLE_ANTIGRAVITY_PROVIDER_ID = "google-antigravity";
const GEMINI_2_5_PRO_PREFIX = "gemini-2.5-pro";
const GEMINI_2_5_FLASH_LITE_PREFIX = "gemini-2.5-flash-lite";
const GEMINI_2_5_FLASH_PREFIX = "gemini-2.5-flash";
const GEMINI_3_PRO_RE = /^gemini-3(?:\.\d+)?-pro(?:-|$)/;
const GEMINI_3_FLASH_LITE_RE = /^gemini-3(?:\.\d+)?-flash-lite(?:-|$)/;
const GEMINI_3_FLASH_RE = /^gemini-3(?:\.\d+)?-flash(?:-|$)/;
const GEMINI_PRO_LATEST_ID = "gemini-pro-latest";
const GEMINI_FLASH_LATEST_ID = "gemini-flash-latest";
const GEMINI_FLASH_LITE_LATEST_ID = "gemini-flash-lite-latest";
const GEMMA_PREFIX = "gemma-";
const GEMINI_2_5_PRO_TEMPLATE_IDS = ["gemini-2.5-pro"] as const;
const GEMINI_2_5_FLASH_LITE_TEMPLATE_IDS = ["gemini-2.5-flash-lite"] as const;
const GEMINI_2_5_FLASH_TEMPLATE_IDS = ["gemini-2.5-flash"] as const;
const GEMINI_3_1_PRO_TEMPLATE_IDS = ["gemini-3.1-pro-preview", "gemini-3-pro-preview"] as const;
const GEMINI_3_1_FLASH_LITE_TEMPLATE_IDS = ["gemini-3.1-flash-lite"] as const;
const GEMINI_3_1_FLASH_TEMPLATE_IDS = ["gemini-3-flash-preview", "gemini-2.5-flash"] as const;
const GEMINI_3_PRO_ANTIGRAVITY_TEMPLATE_IDS = ["gemini-3-pro-low", "gemini-3-pro-high"] as const;
const GEMINI_3_FLASH_ANTIGRAVITY_TEMPLATE_IDS = ["gemini-3-flash"] as const;
// Gemma uses the Gemini flash template as a forward-compat approximation
// until a dedicated Gemma template is registered in the catalog.
const GEMMA_TEMPLATE_IDS = GEMINI_3_1_FLASH_TEMPLATE_IDS;
const GOOGLE_PROVIDER_PREFIX = "google/";
const GOOGLE_NON_TEXT_MODEL_ID_MARKERS = ["-image", "-tts", "-live", "native-audio"] as const;

function normalizeGeminiProRequestId(id: string): string {
  if (id.startsWith(GOOGLE_PROVIDER_PREFIX)) {
    const modelId = id.slice(GOOGLE_PROVIDER_PREFIX.length);
    const normalizedModelId = normalizeGeminiProRequestId(modelId);
    return normalizedModelId === modelId ? id : `${GOOGLE_PROVIDER_PREFIX}${normalizedModelId}`;
  }
  if (id === "gemini-3-pro" || id === "gemini-3-pro-preview" || id === "gemini-3.1-pro") {
    return "gemini-3.1-pro-preview";
  }
  if (id === "gemma-4-26b") {
    return normalizeGoogleModelId(id);
  }
  return id;
}

function googleFamilyModelId(id: string): string {
  return id.startsWith(GOOGLE_PROVIDER_PREFIX) ? id.slice(GOOGLE_PROVIDER_PREFIX.length) : id;
}

export function isGoogleTextGenerationModelId(id: string): boolean {
  const lower = normalizeOptionalLowercaseString(googleFamilyModelId(id)) ?? "";
  if (GOOGLE_NON_TEXT_MODEL_ID_MARKERS.some((marker) => lower.includes(marker))) {
    return false;
  }
  return (
    lower.startsWith(GEMINI_2_5_PRO_PREFIX) ||
    lower.startsWith(GEMINI_2_5_FLASH_LITE_PREFIX) ||
    lower.startsWith(GEMINI_2_5_FLASH_PREFIX) ||
    GEMINI_3_PRO_RE.test(lower) ||
    GEMINI_3_FLASH_LITE_RE.test(lower) ||
    GEMINI_3_FLASH_RE.test(lower) ||
    lower === GEMINI_PRO_LATEST_ID ||
    lower === GEMINI_FLASH_LATEST_ID ||
    lower === GEMINI_FLASH_LITE_LATEST_ID ||
    lower.startsWith(GEMMA_PREFIX)
  );
}

type GoogleForwardCompatFamily = readonly [
  googleTemplateIds: readonly string[],
  cliTemplateIds: readonly string[],
  antigravityTemplateIds?: readonly string[],
  preferExternalFirstForCli?: boolean,
];

type GoogleTemplateSource = {
  providerId?: string;
  templateIds: readonly string[];
};

function isGoogleGeminiCliProvider(providerId: string): boolean {
  return normalizeOptionalLowercaseString(providerId) === GOOGLE_GEMINI_CLI_PROVIDER_ID;
}

function isGoogleAntigravityProvider(providerId: string): boolean {
  return normalizeOptionalLowercaseString(providerId) === GOOGLE_ANTIGRAVITY_PROVIDER_ID;
}

function templateIdsForProvider(
  templateProviderId: string,
  family: GoogleForwardCompatFamily,
): readonly string[] {
  if (isGoogleGeminiCliProvider(templateProviderId)) {
    return family[1];
  }
  if (isGoogleAntigravityProvider(templateProviderId)) {
    return family[2] ?? family[0];
  }
  return family[0];
}

function buildGoogleTemplateSources(params: {
  providerId: string;
  templateProviderId?: string;
  family: GoogleForwardCompatFamily;
}): GoogleTemplateSource[] {
  const defaultTemplateProviderId = params.templateProviderId?.trim()
    ? params.templateProviderId
    : isGoogleGeminiCliProvider(params.providerId)
      ? "google"
      : GOOGLE_GEMINI_CLI_PROVIDER_ID;
  const preferredExternalFirst =
    isGoogleGeminiCliProvider(params.providerId) && params.family[3] === true;
  const orderedTemplateProviderIds = preferredExternalFirst
    ? [defaultTemplateProviderId, params.providerId]
    : [params.providerId, defaultTemplateProviderId];

  const seen = new Set<string>();
  const sources: GoogleTemplateSource[] = [];
  for (const providerId of orderedTemplateProviderIds) {
    const trimmed = providerId?.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    sources.push({
      providerId: trimmed,
      templateIds: templateIdsForProvider(trimmed, params.family),
    });
  }
  return sources;
}

type FamilyForwardCompatCase = Parameters<
  typeof resolveFamilyForwardCompatModel
>[0]["cases"][number];
type GoogleForwardCompatCase = Pick<FamilyForwardCompatCase, "match" | "patch"> & {
  family: GoogleForwardCompatFamily;
};

const GOOGLE_FORWARD_COMPAT_CASES: readonly GoogleForwardCompatCase[] = [
  {
    match: (id) => id.startsWith(GEMINI_2_5_PRO_PREFIX),
    family: [GEMINI_2_5_PRO_TEMPLATE_IDS, GEMINI_3_1_PRO_TEMPLATE_IDS, undefined, true],
  },
  {
    match: (id) => id.startsWith(GEMINI_2_5_FLASH_LITE_PREFIX),
    family: [
      GEMINI_2_5_FLASH_LITE_TEMPLATE_IDS,
      GEMINI_3_1_FLASH_LITE_TEMPLATE_IDS,
      undefined,
      true,
    ],
  },
  {
    match: (id) => id.startsWith(GEMINI_2_5_FLASH_PREFIX),
    family: [GEMINI_2_5_FLASH_TEMPLATE_IDS, GEMINI_3_1_FLASH_TEMPLATE_IDS, undefined, true],
  },
  {
    match: (id) => GEMINI_3_PRO_RE.test(id) || id === GEMINI_PRO_LATEST_ID,
    family: [
      GEMINI_3_1_PRO_TEMPLATE_IDS,
      GEMINI_3_1_PRO_TEMPLATE_IDS,
      GEMINI_3_PRO_ANTIGRAVITY_TEMPLATE_IDS,
    ],
    patch: ({ providerId }) =>
      providerId === "google" || providerId === GOOGLE_GEMINI_CLI_PROVIDER_ID
        ? { reasoning: true }
        : undefined,
  },
  {
    match: (id) => GEMINI_3_FLASH_LITE_RE.test(id) || id === GEMINI_FLASH_LITE_LATEST_ID,
    family: [
      GEMINI_3_1_FLASH_LITE_TEMPLATE_IDS,
      GEMINI_3_1_FLASH_LITE_TEMPLATE_IDS,
      GEMINI_3_FLASH_ANTIGRAVITY_TEMPLATE_IDS,
    ],
  },
  {
    match: (id) => GEMINI_3_FLASH_RE.test(id) || id === GEMINI_FLASH_LATEST_ID,
    family: [
      GEMINI_3_1_FLASH_TEMPLATE_IDS,
      GEMINI_3_1_FLASH_TEMPLATE_IDS,
      GEMINI_3_FLASH_ANTIGRAVITY_TEMPLATE_IDS,
    ],
  },
  {
    match: (id) => id.startsWith(GEMMA_PREFIX),
    family: [GEMMA_TEMPLATE_IDS, GEMMA_TEMPLATE_IDS],
    patch: ({ normalizedModelId }) =>
      normalizedModelId.startsWith("gemma-4") ? { reasoning: true } : undefined,
  },
];

export function resolveGoogleGeminiForwardCompatModel(params: {
  providerId: string;
  templateProviderId?: string;
  ctx: ProviderResolveDynamicModelContext;
}): ProviderRuntimeModel | undefined {
  const trimmed = normalizeGeminiProRequestId(params.ctx.modelId.trim());
  const lower = normalizeOptionalLowercaseString(googleFamilyModelId(trimmed)) ?? "";

  return resolveFamilyForwardCompatModel({
    providerId: params.providerId,
    modelId: trimmed,
    normalizedModelId: isGoogleTextGenerationModelId(lower) ? lower : "",
    ctx: params.ctx,
    patch: { provider: params.providerId },
    cases: GOOGLE_FORWARD_COMPAT_CASES.map(({ family, match, patch }) => ({
      match,
      templateSources: buildGoogleTemplateSources({
        providerId: params.providerId,
        templateProviderId: params.templateProviderId,
        family,
      }),
      patch,
    })),
  });
}

export function isModernGoogleModel(modelId: string): boolean {
  const lower = normalizeOptionalLowercaseString(modelId) ?? "";
  return (
    lower.startsWith("gemini-2.5") ||
    lower.startsWith("gemini-3") ||
    lower === GEMINI_PRO_LATEST_ID ||
    lower === GEMINI_FLASH_LATEST_ID ||
    lower === GEMINI_FLASH_LITE_LATEST_ID ||
    lower.startsWith(GEMMA_PREFIX)
  );
}
