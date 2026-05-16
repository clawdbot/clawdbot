import { modelKey } from "../agents/model-selection.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { SecretInput } from "../config/types.secrets.js";
import { ensureApiKeyFromEnvOrPrompt } from "../plugins/provider-auth-input.js";
import type { RuntimeEnv } from "../runtime.js";
import { fetchWithTimeout } from "../utils/fetch-timeout.js";
import { normalizeSecretInput } from "../utils/normalize-secret-input.js";
import { t } from "../wizard/i18n/index.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import {
  applyCustomApiConfig,
  buildAnthropicVerificationProbeRequest,
  buildEndpointIdFromUrl,
  buildOpenAiVerificationProbeRequest,
  normalizeEndpointId,
  normalizeOptionalProviderApiKey,
  resolveCustomModelAliasError,
  resolveCustomModelImageInputInference,
  resolveCustomProviderId,
  type CustomApiCompatibility,
  type CustomApiResult,
} from "./onboard-custom-config.js";
export {
  applyCustomApiConfig,
  buildAnthropicVerificationProbeRequest,
  buildOpenAiVerificationProbeRequest,
  CustomApiError,
  inferCustomModelSupportsImageInput,
  parseNonInteractiveCustomApiFlags,
  resolveCustomModelImageInputInference,
  resolveCustomProviderId,
  type ApplyCustomApiConfigParams,
  type CustomApiCompatibility,
  type CustomApiErrorCode,
  type CustomModelImageInputInference,
  type CustomApiResult,
  type ParseNonInteractiveCustomApiFlagsParams,
  type ParsedNonInteractiveCustomApiFlags,
  type ResolveCustomProviderIdParams,
  type ResolvedCustomProviderId,
} from "./onboard-custom-config.js";
import type { SecretInputMode } from "./onboard-types.js";

const VERIFY_TIMEOUT_MS = 30_000;
type CustomApiCompatibilityChoice = CustomApiCompatibility | "unknown";

const COMPATIBILITY_OPTIONS: Array<{
  value: CustomApiCompatibilityChoice;
  labelKey: string;
  hintKey: string;
}> = [
  {
    value: "openai",
    labelKey: "wizard.customProvider.compatibilityOpenAi",
    hintKey: "wizard.customProvider.compatibilityOpenAiHint",
  },
  {
    value: "anthropic",
    labelKey: "wizard.customProvider.compatibilityAnthropic",
    hintKey: "wizard.customProvider.compatibilityAnthropicHint",
  },
  {
    value: "unknown",
    labelKey: "wizard.customProvider.compatibilityUnknown",
    hintKey: "wizard.customProvider.compatibilityUnknownHint",
  },
];

function formatVerificationError(error: unknown): string {
  if (!error) {
    return "unknown error";
  }
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return "unknown error";
  }
}

type VerificationResult = {
  ok: boolean;
  status?: number;
  error?: unknown;
};

async function requestVerification(params: {
  endpoint: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}): Promise<VerificationResult> {
  try {
    const res = await fetchWithTimeout(
      params.endpoint,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...params.headers,
        },
        body: JSON.stringify(params.body),
      },
      VERIFY_TIMEOUT_MS,
    );
    return { ok: res.ok, status: res.status };
  } catch (error) {
    return { ok: false, error };
  }
}

async function requestOpenAiVerification(params: {
  baseUrl: string;
  apiKey: string;
  modelId: string;
}): Promise<VerificationResult> {
  return await requestVerification(buildOpenAiVerificationProbeRequest(params));
}

async function requestAnthropicVerification(params: {
  baseUrl: string;
  apiKey: string;
  modelId: string;
}): Promise<VerificationResult> {
  return await requestVerification(buildAnthropicVerificationProbeRequest(params));
}

async function promptBaseUrlAndKey(params: {
  prompter: WizardPrompter;
  config: OpenClawConfig;
  secretInputMode?: SecretInputMode;
  initialBaseUrl?: string;
}): Promise<{ baseUrl: string; apiKey?: SecretInput; resolvedApiKey: string }> {
  const baseUrlInput = await params.prompter.text({
    message: t("wizard.customProvider.apiBaseUrl"),
    initialValue: params.initialBaseUrl,
    placeholder: "https://api.example.com/v1",
    validate: (val) => {
      return URL.canParse(val) ? undefined : t("wizard.customProvider.validUrl");
    },
  });
  const baseUrl = baseUrlInput.trim();
  const providerHint = buildEndpointIdFromUrl(baseUrl) || "custom";
  let apiKeyInput: SecretInput | undefined;
  const resolvedApiKey = await ensureApiKeyFromEnvOrPrompt({
    config: params.config,
    provider: providerHint,
    envLabel: "CUSTOM_API_KEY",
    promptMessage: t("wizard.customProvider.apiKeyPrompt"),
    normalize: normalizeSecretInput,
    validate: () => undefined,
    prompter: params.prompter,
    secretInputMode: params.secretInputMode,
    setCredential: async (apiKey) => {
      apiKeyInput = apiKey;
    },
  });
  return {
    baseUrl,
    apiKey: normalizeOptionalProviderApiKey(apiKeyInput),
    resolvedApiKey: normalizeSecretInput(resolvedApiKey),
  };
}

type CustomApiRetryChoice = "baseUrl" | "model" | "both";

async function promptCustomApiRetryChoice(prompter: WizardPrompter): Promise<CustomApiRetryChoice> {
  return await prompter.select({
    message: t("wizard.customProvider.retryChoice"),
    options: [
      { value: "baseUrl", label: t("wizard.customProvider.changeBaseUrl") },
      { value: "model", label: t("wizard.customProvider.changeModel") },
      { value: "both", label: t("wizard.customProvider.changeBaseUrlAndModel") },
    ],
  });
}

async function promptCustomApiModelId(prompter: WizardPrompter): Promise<string> {
  return (
    await prompter.text({
      message: t("wizard.customProvider.modelId"),
      placeholder: t("wizard.customProvider.modelIdPlaceholder"),
      validate: (val) => (val.trim() ? undefined : t("wizard.customProvider.modelIdRequired")),
    })
  ).trim();
}

async function applyCustomApiRetryChoice(params: {
  prompter: WizardPrompter;
  config: OpenClawConfig;
  secretInputMode?: SecretInputMode;
  retryChoice: CustomApiRetryChoice;
  current: { baseUrl: string; apiKey?: SecretInput; resolvedApiKey: string; modelId: string };
}): Promise<{ baseUrl: string; apiKey?: SecretInput; resolvedApiKey: string; modelId: string }> {
  let { baseUrl, apiKey, resolvedApiKey, modelId } = params.current;
  if (params.retryChoice === "baseUrl" || params.retryChoice === "both") {
    const retryInput = await promptBaseUrlAndKey({
      prompter: params.prompter,
      config: params.config,
      secretInputMode: params.secretInputMode,
      initialBaseUrl: baseUrl,
    });
    baseUrl = retryInput.baseUrl;
    apiKey = retryInput.apiKey;
    resolvedApiKey = retryInput.resolvedApiKey;
  }
  if (params.retryChoice === "model" || params.retryChoice === "both") {
    modelId = await promptCustomApiModelId(params.prompter);
  }
  return { baseUrl, apiKey, resolvedApiKey, modelId };
}

export async function promptCustomApiConfig(params: {
  prompter: WizardPrompter;
  runtime: RuntimeEnv;
  config: OpenClawConfig;
  secretInputMode?: SecretInputMode;
}): Promise<CustomApiResult> {
  const { prompter, runtime, config } = params;

  const baseInput = await promptBaseUrlAndKey({
    prompter,
    config,
    secretInputMode: params.secretInputMode,
  });
  let baseUrl = baseInput.baseUrl;
  let apiKey = baseInput.apiKey;
  let resolvedApiKey = baseInput.resolvedApiKey;

  const compatibilityChoice = await prompter.select({
    message: t("wizard.customProvider.compatibility"),
    options: COMPATIBILITY_OPTIONS.map((option) => ({
      value: option.value,
      label: t(option.labelKey),
      hint: t(option.hintKey),
    })),
  });

  let modelId = await promptCustomApiModelId(prompter);

  let compatibility: CustomApiCompatibility | null =
    compatibilityChoice === "unknown" ? null : compatibilityChoice;

  while (true) {
    let verifiedFromProbe = false;
    if (!compatibility) {
      const probeSpinner = prompter.progress(t("wizard.customProvider.detectionProgress"));
      const openaiProbe = await requestOpenAiVerification({
        baseUrl,
        apiKey: resolvedApiKey,
        modelId,
      });
      if (openaiProbe.ok) {
        probeSpinner.stop(t("wizard.customProvider.detectedOpenAi"));
        compatibility = "openai";
        verifiedFromProbe = true;
      } else {
        const anthropicProbe = await requestAnthropicVerification({
          baseUrl,
          apiKey: resolvedApiKey,
          modelId,
        });
        if (anthropicProbe.ok) {
          probeSpinner.stop(t("wizard.customProvider.detectedAnthropic"));
          compatibility = "anthropic";
          verifiedFromProbe = true;
        } else {
          probeSpinner.stop(t("wizard.customProvider.detectionFailed"));
          await prompter.note(
            t("wizard.customProvider.detectionFailedNote"),
            t("wizard.customProvider.detectionNoteTitle"),
          );
          const retryChoice = await promptCustomApiRetryChoice(prompter);
          ({ baseUrl, apiKey, resolvedApiKey, modelId } = await applyCustomApiRetryChoice({
            prompter,
            config,
            secretInputMode: params.secretInputMode,
            retryChoice,
            current: { baseUrl, apiKey, resolvedApiKey, modelId },
          }));
          continue;
        }
      }
    }

    if (verifiedFromProbe) {
      break;
    }

    const verifySpinner = prompter.progress(t("wizard.customProvider.verifying"));
    const result =
      compatibility === "anthropic"
        ? await requestAnthropicVerification({ baseUrl, apiKey: resolvedApiKey, modelId })
        : await requestOpenAiVerification({ baseUrl, apiKey: resolvedApiKey, modelId });
    if (result.ok) {
      verifySpinner.stop(t("wizard.customProvider.verificationSuccessful"));
      break;
    }
    if (result.status !== undefined) {
      verifySpinner.stop(
        t("wizard.customProvider.verificationFailedStatus", { status: result.status }),
      );
    } else {
      verifySpinner.stop(
        t("wizard.customProvider.verificationFailedError", {
          error: formatVerificationError(result.error),
        }),
      );
    }
    const retryChoice = await promptCustomApiRetryChoice(prompter);
    ({ baseUrl, apiKey, resolvedApiKey, modelId } = await applyCustomApiRetryChoice({
      prompter,
      config,
      secretInputMode: params.secretInputMode,
      retryChoice,
      current: { baseUrl, apiKey, resolvedApiKey, modelId },
    }));
    if (compatibilityChoice === "unknown") {
      compatibility = null;
    }
  }

  const suggestedId = buildEndpointIdFromUrl(baseUrl);
  const providerIdInput = await prompter.text({
    message: t("wizard.customProvider.endpointId"),
    initialValue: suggestedId,
    placeholder: "custom",
    validate: (value) => {
      const normalized = normalizeEndpointId(value);
      if (!normalized) {
        return t("wizard.customProvider.endpointIdRequired");
      }
      return undefined;
    },
  });
  const aliasInput = await prompter.text({
    message: t("wizard.customProvider.modelAlias"),
    placeholder: t("wizard.customProvider.modelAliasPlaceholder"),
    initialValue: "",
    validate: (value) => {
      const resolvedProvider = resolveCustomProviderId({
        config,
        baseUrl,
        providerId: providerIdInput,
      });
      const modelRef = modelKey(resolvedProvider.providerId, modelId);
      return resolveCustomModelAliasError({ raw: value, cfg: config, modelRef });
    },
  });
  const imageInputInference = resolveCustomModelImageInputInference(modelId);
  const supportsImageInput =
    imageInputInference.confidence === "known"
      ? imageInputInference.supportsImageInput
      : await prompter.confirm({
          message: t("wizard.customProvider.imageInput"),
          initialValue: imageInputInference.supportsImageInput,
        });
  const resolvedCompatibility = compatibility ?? "openai";
  const result = applyCustomApiConfig({
    config,
    baseUrl,
    modelId,
    compatibility: resolvedCompatibility,
    apiKey,
    providerId: providerIdInput,
    alias: aliasInput,
    supportsImageInput,
  });

  if (result.providerIdRenamedFrom && result.providerId) {
    await prompter.note(
      t("wizard.customProvider.endpointIdRenamed", {
        from: result.providerIdRenamedFrom,
        to: result.providerId,
      }),
      t("wizard.customProvider.endpointIdTitle"),
    );
  }

  runtime.log(`Configured custom provider: ${result.providerId}/${result.modelId}`);
  return result;
}
