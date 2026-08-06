// Pixverse setup module handles plugin onboarding behavior.
import type {
  ProviderAuthContext,
  ProviderAuthMethod,
  ProviderAuthMethodNonInteractiveContext,
} from "openclaw/plugin-sdk/plugin-entry";
import {
  applyAuthProfileConfig,
  buildApiKeyCredential,
  ensureApiKeyFromOptionEnvOrPrompt,
  normalizeApiKeyInput,
  normalizeOptionalSecretInput,
  type OpenClawConfig,
  type SecretInput,
  upsertAuthProfileWithLock,
  validateApiKeyInput,
} from "openclaw/plugin-sdk/provider-auth-api-key";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-onboard";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  DEFAULT_PIXVERSE_REGION,
  PIXVERSE_BASE_URL_BY_REGION,
  PIXVERSE_DEFAULT_VIDEO_MODEL_REF,
  PIXVERSE_PROVIDER_ID,
  type PixVerseApiRegion,
} from "./constants.js";

const PROFILE_ID = `${PIXVERSE_PROVIDER_ID}:default`;

type PixVerseAuthResult = {
  profiles: Array<{ profileId: string; credential: ReturnType<typeof buildApiKeyCredential> }>;
  configPatch: OpenClawConfig;
  notes: string[];
};

type UpsertAuthProfileParams = Parameters<typeof upsertAuthProfileWithLock>[0];

async function upsertAuthProfileWithLockOrThrow(params: UpsertAuthProfileParams): Promise<void> {
  const updated = await upsertAuthProfileWithLock(params);
  if (!updated) {
    throw new Error(
      "Failed to update auth profile store; the auth store lock may be busy. Wait a moment and retry.",
    );
  }
}

function normalizePixVerseRegion(value: unknown): PixVerseApiRegion | undefined {
  const region = normalizeOptionalString(value)?.toLowerCase();
  switch (region) {
    case "cn":
    case "china":
    case "mainland":
    case "pai":
      return "cn";
    case "global":
    case "intl":
    case "international":
      return "international";
    default:
      return undefined;
  }
}

function pixVerseRegionNote(region: PixVerseApiRegion): string {
  const label = region === "cn" ? "CN" : "International";
  return `PixVerse endpoint: ${label} (${PIXVERSE_BASE_URL_BY_REGION[region]})`;
}

function applyPixVerseProviderConfig(
  cfg: OpenClawConfig,
  region: PixVerseApiRegion,
  options?: { resetBaseUrl?: boolean },
): OpenClawConfig {
  const existingProvider: Partial<ModelProviderConfig> =
    cfg.models?.providers?.[PIXVERSE_PROVIDER_ID] ?? {};
  const selectedBaseUrl = PIXVERSE_BASE_URL_BY_REGION[region];
  const baseUrl = options?.resetBaseUrl
    ? selectedBaseUrl
    : (normalizeOptionalString(existingProvider.baseUrl) ?? selectedBaseUrl);
  return {
    ...cfg,
    models: {
      ...cfg.models,
      providers: {
        ...cfg.models?.providers,
        [PIXVERSE_PROVIDER_ID]: {
          ...existingProvider,
          baseUrl,
          models: existingProvider.models ?? [],
          region,
        },
      },
    },
  };
}

function applyPixVerseConfig(
  cfg: OpenClawConfig,
  region: PixVerseApiRegion,
  options?: { resetBaseUrl?: boolean },
): OpenClawConfig {
  const next = applyPixVerseProviderConfig(cfg, region, options);
  if (next.agents?.defaults?.mediaModels?.video) {
    return next;
  }
  return {
    ...next,
    agents: {
      ...next.agents,
      defaults: {
        ...next.agents?.defaults,
        mediaModels: {
          ...next.agents?.defaults?.mediaModels,
          video: { primary: PIXVERSE_DEFAULT_VIDEO_MODEL_REF },
        },
      },
    },
  };
}

async function promptForPixVerseRegion(ctx: ProviderAuthContext): Promise<PixVerseApiRegion> {
  return await ctx.prompter.select<PixVerseApiRegion>({
    message: "Select PixVerse API region",
    initialValue: DEFAULT_PIXVERSE_REGION,
    options: [
      {
        value: "international",
        label: "International",
        hint: PIXVERSE_BASE_URL_BY_REGION.international,
      },
      {
        value: "cn",
        label: "CN",
        hint: PIXVERSE_BASE_URL_BY_REGION.cn,
      },
    ],
  });
}

async function runPixVerseApiKeyAuth(ctx: ProviderAuthContext): Promise<PixVerseAuthResult> {
  let capturedSecretInput: SecretInput | undefined;
  let capturedCredential = false;
  let capturedMode: "plaintext" | "ref" | undefined;

  await ensureApiKeyFromOptionEnvOrPrompt({
    token:
      normalizeOptionalSecretInput(ctx.opts?.pixverseApiKey) ??
      normalizeOptionalSecretInput(ctx.opts?.token),
    tokenProvider: normalizeOptionalSecretInput(ctx.opts?.pixverseApiKey)
      ? PIXVERSE_PROVIDER_ID
      : normalizeOptionalSecretInput(ctx.opts?.tokenProvider),
    secretInputMode:
      ctx.allowSecretRefPrompt === false
        ? (ctx.secretInputMode ?? "plaintext")
        : ctx.secretInputMode,
    config: ctx.config,
    env: ctx.env,
    expectedProviders: [PIXVERSE_PROVIDER_ID],
    provider: PIXVERSE_PROVIDER_ID,
    envLabel: "PIXVERSE_API_KEY",
    promptMessage: "Enter PixVerse API key",
    normalize: normalizeApiKeyInput,
    validate: validateApiKeyInput,
    prompter: ctx.prompter,
    setCredential: async (apiKey, mode) => {
      capturedSecretInput = apiKey;
      capturedCredential = true;
      capturedMode = mode;
    },
  });

  if (!capturedCredential) {
    throw new Error("Missing PixVerse API key.");
  }

  const region = await promptForPixVerseRegion(ctx);
  return {
    profiles: [
      {
        profileId: PROFILE_ID,
        credential: buildApiKeyCredential(
          PIXVERSE_PROVIDER_ID,
          capturedSecretInput ?? "",
          undefined,
          capturedMode
            ? {
                secretInputMode: capturedMode,
                config: ctx.config,
              }
            : undefined,
        ),
      },
    ],
    configPatch: applyPixVerseConfig(ctx.config, region, { resetBaseUrl: true }),
    notes: [pixVerseRegionNote(region)],
  };
}

async function runPixVerseApiKeyAuthNonInteractive(ctx: ProviderAuthMethodNonInteractiveContext) {
  const resolved = await ctx.resolveApiKey({
    provider: PIXVERSE_PROVIDER_ID,
    flagValue: normalizeOptionalSecretInput(ctx.opts.pixverseApiKey),
    flagName: "--pixverse-api-key",
    envVar: "PIXVERSE_API_KEY",
  });
  if (!resolved) {
    return null;
  }

  if (resolved.source !== "profile") {
    const credential = ctx.toApiKeyCredential({
      provider: PIXVERSE_PROVIDER_ID,
      resolved,
    });
    if (!credential) {
      return null;
    }
    await upsertAuthProfileWithLockOrThrow({
      profileId: PROFILE_ID,
      credential,
      agentDir: ctx.agentDir,
    });
  }

  const next = applyAuthProfileConfig(ctx.config, {
    profileId: PROFILE_ID,
    provider: PIXVERSE_PROVIDER_ID,
    mode: "api_key",
  });
  const explicitRegion = normalizePixVerseRegion(ctx.opts.pixverseRegion);
  return applyPixVerseConfig(next, explicitRegion ?? DEFAULT_PIXVERSE_REGION, {
    resetBaseUrl: explicitRegion !== undefined,
  });
}

export function buildPixVerseApiKeyAuthMethod(): ProviderAuthMethod {
  return {
    id: "api-key",
    label: "PixVerse API key",
    hint: "Video generation API key",
    kind: "api_key",
    wizard: {
      choiceId: "pixverse-api-key",
      choiceLabel: "PixVerse API key",
      choiceHint: "Prompts for International or CN endpoint",
      groupId: "pixverse",
      groupLabel: "PixVerse",
      groupHint: "Video generation",
      onboardingScopes: ["image-generation"],
    },
    run: runPixVerseApiKeyAuth,
    runNonInteractive: runPixVerseApiKeyAuthNonInteractive,
  };
}
