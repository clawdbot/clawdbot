// Shared speech-provider implementation helpers for bundled and third-party plugins.
import type { PreparedSimpleCompletionModel } from "../agents/simple-completion-runtime.js";
import { summarizeTextCore } from "../tts/tts-core.js";

type SummaryDependencies = NonNullable<Parameters<typeof summarizeTextCore>[1]>;
type LegacySummaryDependencies = Omit<SummaryDependencies, "acquireSimpleCompletionModel"> & {
  prepareSimpleCompletionModel: (
    params: Parameters<SummaryDependencies["acquireSimpleCompletionModel"]>[0],
  ) => Promise<PreparedSimpleCompletionModel>;
};

/** Preserve the v2026.9.1 caller-owned dependency contract at the public SDK boundary. */
export async function summarizeText(
  params: Parameters<typeof summarizeTextCore>[0],
  deps?: LegacySummaryDependencies,
) {
  return await summarizeTextCore(
    params,
    deps
      ? {
          completeWithPreparedSimpleCompletionModel: deps.completeWithPreparedSimpleCompletionModel,
          requireApiKey: deps.requireApiKey,
          acquireSimpleCompletionModel: async (selection) => {
            const prepared = await deps.prepareSimpleCompletionModel(selection);
            // A supplied preparer owns its model resources; the SDK never owned their disposal.
            return "error" in prepared ? prepared : { ...prepared, release() {} };
          },
        }
      : undefined,
  );
}

export type { SpeechProviderPlugin } from "../plugins/types.js";
export type { ResolvedTtsConfig, ResolvedTtsModelOverrides } from "../tts/tts-types.js";
export type {
  SpeechDirectiveTokenParseContext,
  SpeechDirectiveTokenParseResult,
  SpeechListVoicesRequest,
  SpeechModelOverridePolicy,
  SpeechProviderConfig,
  SpeechProviderConfiguredContext,
  SpeechProviderPreparedSynthesis,
  SpeechProviderPrepareSynthesisContext,
  SpeechProviderResolveConfigContext,
  SpeechProviderResolveTalkConfigContext,
  SpeechProviderResolveTalkOverridesContext,
  SpeechProviderOverrides,
  SpeechSynthesisRequest,
  SpeechSynthesisStreamRequest,
  SpeechSynthesisStreamResult,
  SpeechSynthesisTarget,
  SpeechTelephonySynthesisRequest,
  SpeechVoiceOption,
  TtsDirectiveOverrides,
  TtsDirectiveParseResult,
} from "../tts/provider-types.js";

export {
  scheduleCleanup,
  normalizeApplyTextNormalization,
  normalizeLanguageCode,
  normalizeSeed,
  requireInRange,
  resolveSpeechProviderApiKey,
} from "../tts/tts-core.js";
export { parseTtsDirectives } from "../tts/directives.js";
export { parseSpeechDirectiveNumberOverride } from "../tts/directive-number.js";
export {
  canonicalizeSpeechProviderId,
  listLoadedSpeechProviders,
  normalizeSpeechProviderId,
} from "../tts/provider-registry.js";
export { resolveEffectiveTtsConfig } from "../tts/tts-config.js";
export type { TtsConfigResolutionContext } from "../tts/tts-config.js";
export { normalizeTtsAutoMode, TTS_AUTO_MODES } from "../tts/tts-auto-mode.js";
// Public compatibility: preserve the established `asObject` export name.
export { asOptionalRecord as asObject } from "@openclaw/normalization-core/record-coerce";
export {
  asBoolean,
  asFiniteNumber,
  assertOkOrThrowProviderError,
  createProviderHttpError,
  extractProviderErrorDetail,
  extractProviderRequestId,
  formatProviderErrorPayload,
  formatProviderHttpErrorMessage,
  readResponseTextLimited,
  trimToUndefined,
  truncateErrorDetail,
} from "../agents/provider-http-errors.js";

export {
  getSpeechProvider,
  listSpeechProviders,
  acquireSpeechProvider,
  acquireSpeechProviders,
} from "./speech-registry-runtime.js";
