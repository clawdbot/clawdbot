import type {
  ProviderResolveDynamicModelContext,
  ProviderRuntimeModel,
} from "openclaw/plugin-sdk/plugin-entry";
import { cloneFirstTemplateModel } from "openclaw/plugin-sdk/provider-model-shared";
import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/string-coerce-runtime";

const GOOGLE_GEMINI_CLI_PROVIDER_ID = "google-gemini-cli";
const GOOGLE_ANTIGRAVITY_PROVIDER_ID = "google-antigravity";
const GEMINI_2_5_PRO_PREFIX = "gemini-2.5-pro";
const GEMINI_2_5_FLASH_LITE_PREFIX = "gemini-2.5-flash-lite";
const GEMINI_2_5_FLASH_PREFIX = "gemini-2.5-flash";
const GEMINI_3_1_PRO_PREFIX = "gemini-3.1-pro";
const GEMINI_3_1_FLASH_LITE_PREFIX = "gemini-3.1-flash-lite";
const GEMINI_3_1_FLASH_PREFIX = "gemini-3.1-flash";
const GEMINI_3_FLASH_LITE_PREFIX = "gemini-3-flash-lite";
const GEMINI_3_FLASH_PREFIX = "gemini-3-flash";
const GEMINI_PRO_LATEST_ID = "gemini-pro-latest";
const GEMINI_FLASH_LATEST_ID = "gemini-flash-latest";
const GEMINI_FLASH_LITE_LATEST_ID = "gemini-flash-lite-latest";
const GEMMA_PREFIX = "gemma-";
const GEMINI_2_5_PRO_TEMPLATE_IDS = ["gemini-2.5-pro"] as const;
const GEMINI_2_5_FLASH_LITE_TEMPLATE_IDS = ["gemini-2.5-flash-lite"] as const;
const GEMINI_2_5_FLASH_TEMPLATE_IDS = ["gemini-2.5-flash"] as const;
const GEMINI_3_1_PRO_TEMPLATE_IDS = ["gemini-3.1-pro-preview", "gemini-3-pro-preview"] as const;
const GEMINI_3_1_FLASH_LITE_TEMPLATE_IDS = ["gemini-3.1-flash-lite-preview"] as const;
const GEMINI_3_1_FLASH_TEMPLATE_IDS = ["gemini-3-flash-preview", "gemini-2.5-flash"] as const;
const GEMINI_3_PRO_ANTIGRAVITY_TEMPLATE_IDS = ["gemini-3-pro-low", "gemini-3-pro-high"] as const;
const GEMINI_3_FLASH_ANTIGRAVITY_TEMPLATE_IDS = ["gemini-3-flash"] as const;
// Gemma uses the Gemini flash template as a forward-compat approximation
// until a dedicated Gemma template is registered in the catalog.
const GEMMA_TEMPLATE_IDS = GEMINI_3_1_FLASH_TEMPLATE_IDS;
const GOOGLE_PROVIDER_PREFIX = "google/";

function normalizeGeminiProRequestId(id: string): string {
  if (id.startsWith(GOOGLE_PROVIDER_PREFIX)) {
    const modelId = id.slice(GOOGLE_PROVIDER_PREFIX.length);
    const normalizedModelId = normalizeGeminiProRequestId(modelId);
    return normalizedModelId === modelId ? id : `${GOOGLE_PROVIDER_PREFIX}${normalizedModelId}`;
  }
  if (id === "gemini-3-pro" || id === "gemini-3-pro-preview" || id === "gemini-3.1-pro") {
    return "gemini-3.1-pro-preview";
  }
  return id;
}

function googleFamilyModelId(id: string): string {
  return id.startsWith(GOOGLE_PROVIDER_PREFIX) ? id.slice(GOOGLE_PROVIDER_PREFIX.length) : id;
}

type GoogleForwardCompatFamily = {
  googleTemplateIds: readonly string[];
  cliTemplateIds: readonly string[];
  antigravityTemplateIds?: readonly string[];
  preferExternalFirstForCli?: boolean;
};

type GoogleTemplateSource = {
  templateProviderId: string;
  templateIds: readonly string[];
};

function cloneGoogleTemplateModel(params: {
  providerId: string;
  modelId: string;
  templateProviderId: string;
  templateIds: readonly string[];
  ctx: ProviderResolveDynamicModelContext;
  patch?: Partial<ProviderRuntimeModel>;
}): ProviderRuntimeModel | undefined {
  return cloneFirstTemplateModel({
    providerId: params.templateProviderId,
    modelId: params.modelId,
    templateIds: params.templateIds,
    ctx: params.ctx,
    patch: {
      ...params.patch,
      provider: params.providerId,
    },
  });
}

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
    return family.cliTemplateIds;
  }
  if (isGoogleAntigravityProvider(templateProviderId)) {
    return family.antigravityTemplateIds ?? family.googleTemplateIds;
  }
  return family.googleTemplateIds;
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
    isGoogleGeminiCliProvider(params.providerId) &&
    params.family.preferExternalFirstForCli === true;
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
      templateProviderId: trimmed,
      templateIds: templateIdsForProvider(trimmed, params.family),
    });
  }
  return sources;
}

export function resolveGoogleGeminiForwardCompatModel(params: {
  providerId: string;
  templateProviderId?: string;
  ctx: ProviderResolveDynamicModelContext;
}): ProviderRuntimeModel | undefined {
  const trimmed = normalizeGeminiProRequestId(params.ctx.modelId.trim());
  const lower = normalizeOptionalLowercaseString(googleFamilyModelId(trimmed)) ?? "";

  let family: GoogleForwardCompatFamily;
  let patch: Partial<ProviderRuntimeModel> | undefined;
  if (lower.startsWith(GEMINI_2_5_PRO_PREFIX)) {
    family = {
      googleTemplateIds: GEMINI_2_5_PRO_TEMPLATE_IDS,
      cliTemplateIds: GEMINI_3_1_PRO_TEMPLATE_IDS,
      preferExternalFirstForCli: true,
    };
  } else if (lower.startsWith(GEMINI_2_5_FLASH_LITE_PREFIX)) {
    family = {
      googleTemplateIds: GEMINI_2_5_FLASH_LITE_TEMPLATE_IDS,
      cliTemplateIds: GEMINI_3_1_FLASH_LITE_TEMPLATE_IDS,
      preferExternalFirstForCli: true,
    };
  } else if (lower.startsWith(GEMINI_2_5_FLASH_PREFIX)) {
    family = {
      googleTemplateIds: GEMINI_2_5_FLASH_TEMPLATE_IDS,
      cliTemplateIds: GEMINI_3_1_FLASH_TEMPLATE_IDS,
      preferExternalFirstForCli: true,
    };
  } else if (lower.startsWith(GEMINI_3_1_PRO_PREFIX) || lower === GEMINI_PRO_LATEST_ID) {
    family = {
      googleTemplateIds: GEMINI_3_1_PRO_TEMPLATE_IDS,
      cliTemplateIds: GEMINI_3_1_PRO_TEMPLATE_IDS,
      antigravityTemplateIds: GEMINI_3_PRO_ANTIGRAVITY_TEMPLATE_IDS,
    };
    if (params.providerId === "google" || params.providerId === GOOGLE_GEMINI_CLI_PROVIDER_ID) {
      patch = { reasoning: true };
    }
  } else if (
    lower.startsWith(GEMINI_3_1_FLASH_LITE_PREFIX) ||
    lower.startsWith(GEMINI_3_FLASH_LITE_PREFIX) ||
    lower === GEMINI_FLASH_LITE_LATEST_ID
  ) {
    family = {
      googleTemplateIds: GEMINI_3_1_FLASH_LITE_TEMPLATE_IDS,
      cliTemplateIds: GEMINI_3_1_FLASH_LITE_TEMPLATE_IDS,
      antigravityTemplateIds: GEMINI_3_FLASH_ANTIGRAVITY_TEMPLATE_IDS,
    };
  } else if (
    lower.startsWith(GEMINI_3_1_FLASH_PREFIX) ||
    lower.startsWith(GEMINI_3_FLASH_PREFIX) ||
    lower === GEMINI_FLASH_LATEST_ID
  ) {
    family = {
      googleTemplateIds: GEMINI_3_1_FLASH_TEMPLATE_IDS,
      cliTemplateIds: GEMINI_3_1_FLASH_TEMPLATE_IDS,
      antigravityTemplateIds: GEMINI_3_FLASH_ANTIGRAVITY_TEMPLATE_IDS,
    };
  } else if (lower.startsWith(GEMMA_PREFIX)) {
    family = {
      googleTemplateIds: GEMMA_TEMPLATE_IDS,
      cliTemplateIds: GEMMA_TEMPLATE_IDS,
    };
    if (lower.startsWith("gemma-4")) {
      patch = { reasoning: true };
    }
  } else {
    return undefined;
  }

  for (const source of buildGoogleTemplateSources({
    providerId: params.providerId,
    templateProviderId: params.templateProviderId,
    family,
  })) {
    const model = cloneGoogleTemplateModel({
      providerId: params.providerId,
      modelId: trimmed,
      templateProviderId: source.templateProviderId,
      templateIds: source.templateIds,
      ctx: params.ctx,
      patch,
    });
    if (model) {
      return model;
    }
  }

  return undefined;
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
