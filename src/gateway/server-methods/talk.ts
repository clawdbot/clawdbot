import { readConfigFileSnapshot } from "../../config/config.js";
import { redactConfigObject } from "../../config/redact-snapshot.js";
import {
  buildTalkConfigResponse,
  normalizeTalkSection,
  resolveActiveTalkProviderConfig,
} from "../../config/talk.js";
import type { TalkConfigResponse, TalkProviderConfig } from "../../config/types.gateway.js";
import type { OpenClawConfig, TtsConfig, TtsProviderConfigMap } from "../../config/types.js";
import {
  REALTIME_VOICE_AGENT_CONSULT_TOOL,
  REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
} from "../../realtime-voice/agent-consult-tool.js";
import { getRealtimeVoiceProvider } from "../../realtime-voice/provider-registry.js";
import { resolveConfiguredRealtimeVoiceProvider } from "../../realtime-voice/provider-resolver.js";
import type {
  RealtimeVoiceBrowserSession,
  RealtimeVoiceProviderConfig,
} from "../../realtime-voice/provider-types.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "../../shared/string-coerce.js";
import { canonicalizeSpeechProviderId, getSpeechProvider } from "../../tts/provider-registry.js";
import { synthesizeSpeech, type TtsDirectiveOverrides } from "../../tts/tts.js";
import { ADMIN_SCOPE, TALK_SECRETS_SCOPE } from "../operator-scopes.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  type TalkSpeakParams,
  validateTalkConfigParams,
  validateTalkModeParams,
  validateTalkRealtimeRelayAudioParams,
  validateTalkRealtimeRelayMarkParams,
  validateTalkRealtimeRelayStopParams,
  validateTalkRealtimeRelayToolResultParams,
  validateTalkRealtimeSessionParams,
  validateTalkSpeakParams,
} from "../protocol/index.js";
import {
  acknowledgeTalkRealtimeRelayMark,
  createTalkRealtimeRelaySession,
  sendTalkRealtimeRelayAudio,
  stopTalkRealtimeRelaySession,
  submitTalkRealtimeRelayToolResult,
} from "../talk-realtime-relay.js";
import { formatForLog } from "../ws-log.js";
import { asRecord } from "./record-shared.js";
import type { GatewayRequestHandlers } from "./types.js";

type TalkSpeakReason =
  | "talk_unconfigured"
  | "talk_provider_unsupported"
  | "method_unavailable"
  | "synthesis_failed"
  | "invalid_audio_result";

type TalkSpeakErrorDetails = {
  reason: TalkSpeakReason;
  fallbackEligible: boolean;
};
function canReadTalkSecrets(client: { connect?: { scopes?: string[] } } | null): boolean {
  const scopes = Array.isArray(client?.connect?.scopes) ? client.connect.scopes : [];
  return scopes.includes(ADMIN_SCOPE) || scopes.includes(TALK_SECRETS_SCOPE);
}

function asStringRecord(value: unknown): Record<string, string> | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  const next: Record<string, string> = {};
  for (const [key, entryValue] of Object.entries(record)) {
    if (typeof entryValue === "string") {
      next[key] = entryValue;
    }
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

function normalizeAliasKey(value: string): string {
  return normalizeLowercaseStringOrEmpty(value);
}

function resolveTalkVoiceId(
  providerConfig: TalkProviderConfig,
  requested: string | undefined,
): string | undefined {
  if (!requested) {
    return undefined;
  }
  const aliases = asStringRecord(providerConfig.voiceAliases);
  if (!aliases) {
    return requested;
  }
  const normalizedRequested = normalizeAliasKey(requested);
  for (const [alias, voiceId] of Object.entries(aliases)) {
    if (normalizeAliasKey(alias) === normalizedRequested) {
      return voiceId;
    }
  }
  return requested;
}

function buildTalkTtsConfig(
  config: OpenClawConfig,
):
  | { cfg: OpenClawConfig; provider: string; providerConfig: TalkProviderConfig }
  | { error: string; reason: TalkSpeakReason } {
  const resolved = resolveActiveTalkProviderConfig(config.talk);
  const provider = canonicalizeSpeechProviderId(resolved?.provider, config);
  if (!resolved || !provider) {
    return {
      error: "talk.speak unavailable: talk provider not configured",
      reason: "talk_unconfigured",
    };
  }

  const speechProvider = getSpeechProvider(provider, config);
  if (!speechProvider) {
    return {
      error: `talk.speak unavailable: speech provider "${provider}" does not support Talk mode`,
      reason: "talk_provider_unsupported",
    };
  }

  const baseTts = config.messages?.tts ?? {};
  const providerConfig = resolved.config;
  const resolvedProviderConfig =
    speechProvider.resolveTalkConfig?.({
      cfg: config,
      baseTtsConfig: baseTts as Record<string, unknown>,
      talkProviderConfig: providerConfig,
      timeoutMs: baseTts.timeoutMs ?? 30_000,
    }) ?? providerConfig;
  const talkTts: TtsConfig = {
    ...baseTts,
    auto: "always",
    provider,
    providers: {
      ...((asRecord(baseTts.providers) ?? {}) as TtsProviderConfigMap),
      [provider]: resolvedProviderConfig,
    },
  };

  return {
    provider,
    providerConfig,
    cfg: {
      ...config,
      messages: {
        ...config.messages,
        tts: talkTts,
      },
    },
  };
}

function getRecord(value: unknown): Record<string, unknown> | undefined {
  return asRecord(value) ?? undefined;
}

function getVoiceCallRealtimeConfig(config: OpenClawConfig): {
  provider?: string;
  providers?: Record<string, RealtimeVoiceProviderConfig>;
} {
  const plugins = getRecord(config.plugins);
  const entries = getRecord(plugins?.entries);
  const voiceCall = getRecord(entries?.["voice-call"]);
  const pluginConfig = getRecord(voiceCall?.config);
  const realtime = getRecord(pluginConfig?.realtime);
  const providersRaw = getRecord(realtime?.providers);
  const providers: Record<string, RealtimeVoiceProviderConfig> = {};
  if (providersRaw) {
    for (const [providerId, providerConfig] of Object.entries(providersRaw)) {
      const record = getRecord(providerConfig);
      if (record) {
        providers[providerId] = record;
      }
    }
  }
  return {
    provider: normalizeOptionalString(realtime?.provider),
    providers: Object.keys(providers).length > 0 ? providers : undefined,
  };
}

function buildTalkRealtimeConfig(config: OpenClawConfig, requestedProvider?: string) {
  const voiceCallRealtime = getVoiceCallRealtimeConfig(config);
  const talkProviderConfigs = config.talk?.providers as
    | Record<string, RealtimeVoiceProviderConfig>
    | undefined;
  const talkProvider = normalizeOptionalString(config.talk?.provider);
  const talkProviderSupportsRealtime = talkProvider
    ? Boolean(getRealtimeVoiceProvider(talkProvider, config))
    : false;
  const provider =
    normalizeOptionalString(requestedProvider) ??
    (talkProviderSupportsRealtime ? talkProvider : undefined) ??
    voiceCallRealtime.provider;
  return {
    provider,
    providers: {
      ...voiceCallRealtime.providers,
      ...talkProviderConfigs,
    },
  };
}

function buildRealtimeInstructions(): string {
  return `You are OpenClaw's realtime voice interface. Keep spoken replies concise. If the user asks for code, repository state, tools, files, current OpenClaw context, or deeper reasoning, call ${REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME} and then summarize the result naturally.`;
}

function withRealtimeBrowserOverrides(
  providerConfig: RealtimeVoiceProviderConfig,
  params: { model?: string; voice?: string },
): RealtimeVoiceProviderConfig {
  const overrides: RealtimeVoiceProviderConfig = {};
  const model = normalizeOptionalString(params.model);
  const voice = normalizeOptionalString(params.voice);
  if (model) {
    overrides.model = model;
  }
  if (voice) {
    overrides.voice = voice;
  }
  return Object.keys(overrides).length > 0 ? { ...providerConfig, ...overrides } : providerConfig;
}

function isUnsupportedBrowserWebRtcSession(session: RealtimeVoiceBrowserSession): boolean {
  const provider = normalizeLowercaseStringOrEmpty(session.provider);
  const transport = (session as { transport?: string }).transport ?? "webrtc-sdp";
  return provider === "google" && transport === "webrtc-sdp";
}

function isFallbackEligibleTalkReason(reason: TalkSpeakReason): boolean {
  return (
    reason === "talk_unconfigured" ||
    reason === "talk_provider_unsupported" ||
    reason === "method_unavailable"
  );
}

function talkSpeakError(reason: TalkSpeakReason, message: string) {
  const details: TalkSpeakErrorDetails = {
    reason,
    fallbackEligible: isFallbackEligibleTalkReason(reason),
  };
  return errorShape(ErrorCodes.UNAVAILABLE, message, { details });
}

function resolveTalkSpeed(params: TalkSpeakParams): number | undefined {
  if (typeof params.speed === "number") {
    return params.speed;
  }
  if (typeof params.rateWpm !== "number" || params.rateWpm <= 0) {
    return undefined;
  }
  const resolved = params.rateWpm / 175;
  if (resolved <= 0.5 || resolved >= 2.0) {
    return undefined;
  }
  return resolved;
}

function buildTalkSpeakOverrides(
  provider: string,
  providerConfig: TalkProviderConfig,
  config: OpenClawConfig,
  params: TalkSpeakParams,
): TtsDirectiveOverrides {
  const speechProvider = getSpeechProvider(provider, config);
  if (!speechProvider?.resolveTalkOverrides) {
    return { provider };
  }
  const resolvedSpeed = resolveTalkSpeed(params);
  const resolvedVoiceId = resolveTalkVoiceId(
    providerConfig,
    normalizeOptionalString(params.voiceId),
  );
  const providerOverrides = speechProvider.resolveTalkOverrides({
    talkProviderConfig: providerConfig,
    params: {
      ...params,
      ...(resolvedVoiceId == null ? {} : { voiceId: resolvedVoiceId }),
      ...(resolvedSpeed == null ? {} : { speed: resolvedSpeed }),
    },
  });
  if (!providerOverrides || Object.keys(providerOverrides).length === 0) {
    return { provider };
  }
  return {
    provider,
    providerOverrides: {
      [provider]: providerOverrides,
    },
  };
}

function inferMimeType(
  outputFormat: string | undefined,
  fileExtension: string | undefined,
): string | undefined {
  const normalizedOutput = normalizeOptionalLowercaseString(outputFormat);
  const normalizedExtension = normalizeOptionalLowercaseString(fileExtension);
  if (
    normalizedOutput === "mp3" ||
    normalizedOutput?.startsWith("mp3_") ||
    normalizedOutput?.endsWith("-mp3") ||
    normalizedExtension === ".mp3"
  ) {
    return "audio/mpeg";
  }
  if (
    normalizedOutput === "opus" ||
    normalizedOutput?.startsWith("opus_") ||
    normalizedExtension === ".opus" ||
    normalizedExtension === ".ogg"
  ) {
    return "audio/ogg";
  }
  if (normalizedOutput?.endsWith("-wav") || normalizedExtension === ".wav") {
    return "audio/wav";
  }
  if (normalizedOutput?.endsWith("-webm") || normalizedExtension === ".webm") {
    return "audio/webm";
  }
  return undefined;
}

function resolveTalkResponseFromConfig(params: {
  includeSecrets: boolean;
  sourceConfig: OpenClawConfig;
  runtimeConfig: OpenClawConfig;
}): TalkConfigResponse | undefined {
  const normalizedTalk = normalizeTalkSection(params.sourceConfig.talk);
  if (!normalizedTalk) {
    return undefined;
  }

  const payload = buildTalkConfigResponse(normalizedTalk);
  if (!payload) {
    return undefined;
  }

  if (params.includeSecrets) {
    return payload;
  }

  const sourceResolved = resolveActiveTalkProviderConfig(normalizedTalk);
  const runtimeResolved = resolveActiveTalkProviderConfig(params.runtimeConfig.talk);
  const activeProviderId = sourceResolved?.provider ?? runtimeResolved?.provider;
  const provider = canonicalizeSpeechProviderId(activeProviderId, params.runtimeConfig);
  if (!provider) {
    return payload;
  }

  const speechProvider = getSpeechProvider(provider, params.runtimeConfig);
  const sourceBaseTts = asRecord(params.sourceConfig.messages?.tts) ?? {};
  const runtimeBaseTts = asRecord(params.runtimeConfig.messages?.tts) ?? {};
  const sourceProviderConfig = sourceResolved?.config ?? {};
  const runtimeProviderConfig = runtimeResolved?.config ?? {};
  const selectedBaseTts =
    Object.keys(runtimeBaseTts).length > 0
      ? runtimeBaseTts
      : stripUnresolvedSecretApiKeysFromBaseTtsProviders(sourceBaseTts);
  // Prefer runtime-resolved provider config (already-substituted secrets) and
  // fall back to source. Strip any apiKey that is still a SecretRef wrapper —
  // provider plugins (ElevenLabs/OpenAI) call strict secret helpers that throw
  // on unresolved wrappers, and the discovery path doesn't need the resolved
  // value: the response's apiKey is restored from source so the UI keeps the
  // SecretRef shape, and redaction strips the value when includeSecrets=false.
  const providerInputConfig = stripUnresolvedSecretApiKey(
    Object.keys(runtimeProviderConfig).length > 0 ? runtimeProviderConfig : sourceProviderConfig,
  );
  const resolvedConfig =
    speechProvider?.resolveTalkConfig?.({
      cfg: params.runtimeConfig,
      baseTtsConfig: selectedBaseTts,
      talkProviderConfig: providerInputConfig,
      timeoutMs: typeof selectedBaseTts.timeoutMs === "number" ? selectedBaseTts.timeoutMs : 30_000,
    }) ?? providerInputConfig;
  const responseConfig =
    sourceProviderConfig.apiKey === undefined
      ? resolvedConfig
      : { ...resolvedConfig, apiKey: sourceProviderConfig.apiKey };

  return {
    ...payload,
    provider,
    resolved: {
      provider,
      config: responseConfig,
    },
  };
}

function stripUnresolvedSecretApiKey(config: TalkProviderConfig): TalkProviderConfig {
  return stripUnresolvedSecretApiKeyFromRecord(config) as TalkProviderConfig;
}

function stripUnresolvedSecretApiKeysFromBaseTtsProviders(
  base: Record<string, unknown>,
): Record<string, unknown> {
  const providers = asRecord(base.providers);
  if (!providers) {
    return base;
  }
  let mutated = false;
  // Null-prototype map so an attacker-influenced provider id like `__proto__`,
  // `constructor`, or `prototype` cannot pollute Object.prototype via the
  // dynamic `cleaned[providerId] = ...` assignment below. Provider-id keys
  // come from operator config and may be plain JSON, so we cannot assume
  // they're already validated upstream.
  const cleaned: Record<string, unknown> = Object.create(null);
  for (const [providerId, providerConfig] of Object.entries(providers)) {
    const cfg = asRecord(providerConfig);
    if (!cfg) {
      cleaned[providerId] = providerConfig;
      continue;
    }
    const next = stripUnresolvedSecretApiKeyFromRecord(cfg);
    if (next !== cfg) {
      mutated = true;
    }
    cleaned[providerId] = next;
  }
  if (!mutated) {
    return base;
  }
  return { ...base, providers: cleaned };
}

function stripUnresolvedSecretApiKeyFromRecord(
  config: Record<string, unknown>,
): Record<string, unknown> {
  if (config.apiKey === undefined || typeof config.apiKey === "string") {
    return config;
  }
  const { apiKey: _omit, ...rest } = config;
  return rest;
}

export const talkHandlers: GatewayRequestHandlers = {
  "talk.config": async ({ params, respond, client, context }) => {
    if (!validateTalkConfigParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid talk.config params: ${formatValidationErrors(validateTalkConfigParams.errors)}`,
        ),
      );
      return;
    }

    const includeSecrets = Boolean((params as { includeSecrets?: boolean }).includeSecrets);
    if (includeSecrets && !canReadTalkSecrets(client)) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `missing scope: ${TALK_SECRETS_SCOPE}`),
      );
      return;
    }

    const snapshot = await readConfigFileSnapshot();
    const runtimeConfig = context.getRuntimeConfig();
    const configPayload: Record<string, unknown> = {};

    const talk = resolveTalkResponseFromConfig({
      includeSecrets,
      sourceConfig: snapshot.config,
      runtimeConfig,
    });
    if (talk) {
      configPayload.talk = includeSecrets ? talk : redactConfigObject(talk);
    }

    const sessionMainKey = snapshot.config.session?.mainKey;
    if (typeof sessionMainKey === "string") {
      configPayload.session = { mainKey: sessionMainKey };
    }

    const seamColor = snapshot.config.ui?.seamColor;
    if (typeof seamColor === "string") {
      configPayload.ui = { seamColor };
    }

    respond(true, { config: configPayload }, undefined);
  },
  "talk.realtime.session": async ({ params, respond, context, client }) => {
    if (!validateTalkRealtimeSessionParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid talk.realtime.session params: ${formatValidationErrors(validateTalkRealtimeSessionParams.errors)}`,
        ),
      );
      return;
    }
    const typedParams = params as {
      provider?: string;
      model?: string;
      voice?: string;
    };
    try {
      const runtimeConfig = context.getRuntimeConfig();
      const realtimeConfig = buildTalkRealtimeConfig(runtimeConfig, typedParams.provider);
      const resolution = resolveConfiguredRealtimeVoiceProvider({
        configuredProviderId: realtimeConfig.provider,
        providerConfigs: realtimeConfig.providers,
        cfg: runtimeConfig,
        cfgForResolve: runtimeConfig,
        noRegisteredProviderMessage: "No realtime voice provider registered",
      });
      if (resolution.provider.createBrowserSession) {
        const session = await resolution.provider.createBrowserSession({
          providerConfig: resolution.providerConfig,
          instructions: buildRealtimeInstructions(),
          tools: [REALTIME_VOICE_AGENT_CONSULT_TOOL],
          model: normalizeOptionalString(typedParams.model),
          voice: normalizeOptionalString(typedParams.voice),
        });
        if (!isUnsupportedBrowserWebRtcSession(session)) {
          respond(true, session, undefined);
          return;
        }
      }

      const connId = client?.connId;
      if (!connId) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, "Realtime relay requires a connected browser client"),
        );
        return;
      }
      const model = normalizeOptionalString(typedParams.model);
      const voice = normalizeOptionalString(typedParams.voice);
      const session = createTalkRealtimeRelaySession({
        context,
        connId,
        provider: resolution.provider,
        providerConfig: withRealtimeBrowserOverrides(resolution.providerConfig, { model, voice }),
        instructions: buildRealtimeInstructions(),
        tools: [REALTIME_VOICE_AGENT_CONSULT_TOOL],
        model,
        voice,
      });
      respond(true, session, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
    }
  },
  "talk.realtime.relayAudio": async ({ params, respond, client }) => {
    if (!validateTalkRealtimeRelayAudioParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid talk.realtime.relayAudio params: ${formatValidationErrors(validateTalkRealtimeRelayAudioParams.errors)}`,
        ),
      );
      return;
    }
    const connId = client?.connId;
    if (!connId) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "realtime relay unavailable"));
      return;
    }
    try {
      sendTalkRealtimeRelayAudio({
        relaySessionId: params.relaySessionId,
        connId,
        audioBase64: params.audioBase64,
        timestamp: params.timestamp,
      });
      respond(true, { ok: true }, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
    }
  },
  "talk.realtime.relayMark": async ({ params, respond, client }) => {
    if (!validateTalkRealtimeRelayMarkParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid talk.realtime.relayMark params: ${formatValidationErrors(validateTalkRealtimeRelayMarkParams.errors)}`,
        ),
      );
      return;
    }
    const connId = client?.connId;
    if (!connId) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "realtime relay unavailable"));
      return;
    }
    try {
      acknowledgeTalkRealtimeRelayMark({ relaySessionId: params.relaySessionId, connId });
      respond(true, { ok: true }, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
    }
  },
  "talk.realtime.relayStop": async ({ params, respond, client }) => {
    if (!validateTalkRealtimeRelayStopParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid talk.realtime.relayStop params: ${formatValidationErrors(validateTalkRealtimeRelayStopParams.errors)}`,
        ),
      );
      return;
    }
    const connId = client?.connId;
    if (!connId) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "realtime relay unavailable"));
      return;
    }
    try {
      stopTalkRealtimeRelaySession({ relaySessionId: params.relaySessionId, connId });
      respond(true, { ok: true }, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
    }
  },
  "talk.realtime.relayToolResult": async ({ params, respond, client }) => {
    if (!validateTalkRealtimeRelayToolResultParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid talk.realtime.relayToolResult params: ${formatValidationErrors(validateTalkRealtimeRelayToolResultParams.errors)}`,
        ),
      );
      return;
    }
    const connId = client?.connId;
    if (!connId) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "realtime relay unavailable"));
      return;
    }
    try {
      submitTalkRealtimeRelayToolResult({
        relaySessionId: params.relaySessionId,
        connId,
        callId: params.callId,
        result: params.result,
      });
      respond(true, { ok: true }, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
    }
  },
  "talk.speak": async ({ params, respond, context }) => {
    if (!validateTalkSpeakParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid talk.speak params: ${formatValidationErrors(validateTalkSpeakParams.errors)}`,
        ),
      );
      return;
    }

    const typedParams = params;
    const text = normalizeOptionalString(typedParams.text);
    if (!text) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "talk.speak requires text"));
      return;
    }

    if (
      typedParams.speed == null &&
      typedParams.rateWpm != null &&
      resolveTalkSpeed(typedParams) == null
    ) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid talk.speak params: rateWpm must resolve to speed between 0.5 and 2.0`,
        ),
      );
      return;
    }

    try {
      const runtimeConfig = context.getRuntimeConfig();
      const setup = buildTalkTtsConfig(runtimeConfig);
      if ("error" in setup) {
        respond(false, undefined, talkSpeakError(setup.reason, setup.error));
        return;
      }

      const overrides = buildTalkSpeakOverrides(
        setup.provider,
        setup.providerConfig,
        runtimeConfig,
        typedParams,
      );
      const result = await synthesizeSpeech({
        text,
        cfg: setup.cfg,
        overrides,
        disableFallback: true,
      });
      if (!result.success || !result.audioBuffer) {
        respond(
          false,
          undefined,
          talkSpeakError("synthesis_failed", result.error ?? "talk synthesis failed"),
        );
        return;
      }
      if ((result.provider ?? setup.provider).trim().length === 0) {
        respond(
          false,
          undefined,
          talkSpeakError("invalid_audio_result", "talk synthesis returned empty provider"),
        );
        return;
      }
      if (result.audioBuffer.length === 0) {
        respond(
          false,
          undefined,
          talkSpeakError("invalid_audio_result", "talk synthesis returned empty audio"),
        );
        return;
      }

      respond(
        true,
        {
          audioBase64: result.audioBuffer.toString("base64"),
          provider: result.provider ?? setup.provider,
          outputFormat: result.outputFormat,
          voiceCompatible: result.voiceCompatible,
          mimeType: inferMimeType(result.outputFormat, result.fileExtension),
          fileExtension: result.fileExtension,
        },
        undefined,
      );
    } catch (err) {
      respond(false, undefined, talkSpeakError("synthesis_failed", formatForLog(err)));
    }
  },
  "talk.mode": ({ params, respond, context, client, isWebchatConnect }) => {
    if (client && isWebchatConnect(client.connect) && !context.hasConnectedMobileNode()) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "talk disabled: no connected iOS/Android nodes"),
      );
      return;
    }
    if (!validateTalkModeParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid talk.mode params: ${formatValidationErrors(validateTalkModeParams.errors)}`,
        ),
      );
      return;
    }
    const payload = {
      enabled: (params as { enabled: boolean }).enabled,
      phase: (params as { phase?: string }).phase ?? null,
      ts: Date.now(),
    };
    context.broadcast("talk.mode", payload, { dropIfSlow: true });
    respond(true, payload, undefined);
  },
};
