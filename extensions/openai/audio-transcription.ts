import type {
  AudioTranscriptionRequest,
  MediaUnderstandingProvider,
} from "openclaw/plugin-sdk/media-understanding";
import { transcribeOpenAiCompatibleAudio } from "openclaw/plugin-sdk/media-understanding";
import {
  findNormalizedProviderValue,
  hasConfiguredSecretInput,
} from "openclaw/plugin-sdk/provider-auth";
import {
  collectProviderApiKeysForExecution,
  executeWithApiKeyRotation,
  isProviderAuthError,
  requireApiKey,
  resolveApiKeyForProvider,
} from "openclaw/plugin-sdk/provider-auth-runtime";
import { providerOperationRetryConfig } from "openclaw/plugin-sdk/provider-http";
import { classifyOpenAIBaseUrl, OPENAI_API_BASE_URL } from "./base-url.js";
import { OPENAI_DEFAULT_AUDIO_TRANSCRIPTION_MODEL } from "./default-models.js";

export async function transcribeOpenAiAudio(params: AudioTranscriptionRequest) {
  return await transcribeOpenAiCompatibleAudio({
    ...params,
    provider: "openai",
    defaultBaseUrl: OPENAI_API_BASE_URL,
    defaultModel: OPENAI_DEFAULT_AUDIO_TRANSCRIPTION_MODEL,
  });
}

export const transcribeOpenAiAudioWithContext: NonNullable<
  MediaUnderstandingProvider["transcribeAudioWithContext"]
> = async (context) => {
  const providerConfig = findNormalizedProviderValue(context.cfg.models?.providers, "openai");
  const hasConfiguredKey = hasConfiguredSecretInput(
    providerConfig?.apiKey,
    context.cfg.secrets?.defaults,
  );
  const endpointKind = classifyOpenAIBaseUrl(context.baseUrl);
  const nativeEndpoint =
    endpointKind === "unresolved" || endpointKind === "platform" || endpointKind === "chatgpt";
  // Audio's authored provider key owns billing before ambient profiles. This request-local
  // projection preserves that order without changing the agent's text-inference configuration.
  const cfg =
    !context.profile &&
    providerConfig &&
    hasConfiguredKey &&
    (!providerConfig.auth || providerConfig.auth === "api-key")
      ? {
          ...context.cfg,
          models: {
            ...context.cfg.models,
            providers: {
              ...context.cfg.models?.providers,
              openai: { ...providerConfig, auth: "api-key" as const },
            },
          },
        }
      : context.cfg;
  const params = {
    provider: "openai",
    cfg,
    agentDir: context.agentDir,
    workspaceDir: context.workspaceDir,
    profileId: context.profile,
    preferredProfile: context.preferredProfile,
    lockedProfile: Boolean(context.profile),
  };
  const explicitSubscription = providerConfig?.auth === "oauth" || providerConfig?.auth === "token";
  let auth: Awaited<ReturnType<typeof resolveApiKeyForProvider>>;
  let credential: string;
  try {
    auth = await resolveApiKeyForProvider({
      ...params,
      modelApi: context.profile || explicitSubscription ? undefined : "openai-audio-transcriptions",
    }).catch((error: unknown) => {
      if (
        context.profile ||
        hasConfiguredKey ||
        !nativeEndpoint ||
        !isProviderAuthError(error, "missing-provider-auth")
      ) {
        throw error;
      }
      // Only absent API-key credentials allow subscription selection. Failed credentials
      // and rejected uploads never switch accounts or credential classes.
      return resolveApiKeyForProvider(params);
    });
    credential = requireApiKey(auth, "openai");
    if (auth.mode !== "api-key") {
      if (auth.mode !== "oauth" && auth.mode !== "token") {
        throw new Error("OpenAI audio transcription requires an API key or OAuth profile.");
      }
      if (!nativeEndpoint || context.headers || context.request) {
        throw new Error(
          "OpenAI OAuth audio transcription requires the official endpoint without custom request overrides. Remove the overrides or select an OpenAI API-key profile.",
        );
      }
    }
  } catch (error) {
    // This result is exclusively a rejection before uploading audio. HTTP failures
    // below must throw so automatic selection cannot send the file to another provider.
    return { ok: false, error };
  }
  const transcribe = (apiKey: string) =>
    transcribeOpenAiAudio({
      ...context,
      // Official text-inference bases do not select the batch-audio endpoint.
      baseUrl: nativeEndpoint ? OPENAI_API_BASE_URL : context.baseUrl,
      apiKey,
      ...(auth.mode === "api-key" ? { auth: { kind: "api-key" as const, apiKey } } : {}),
    });
  const value =
    auth.mode === "api-key"
      ? await executeWithApiKeyRotation({
          provider: "openai",
          apiKeys: collectProviderApiKeysForExecution({
            provider: "openai",
            primaryApiKey: credential,
          }),
          transientRetry: providerOperationRetryConfig("read"),
          execute: transcribe,
        })
      : await transcribe(credential);
  return { ok: true, value };
};
