import { resolveAgentDir } from "openclaw/plugin-sdk/agent-runtime";
import type { PluginLogger } from "openclaw/plugin-sdk/plugin-entry";
import { resolveProviderRequestHeaders } from "openclaw/plugin-sdk/provider-http";
import type {
  RealtimeVoiceBrowserSession,
  RealtimeVoiceBrowserSessionCreateRequest,
  RealtimeVoiceProviderCapabilities,
  RealtimeVoiceProviderConfig,
  RealtimeVoiceProviderPlugin,
} from "openclaw/plugin-sdk/realtime-voice";
import { REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ } from "openclaw/plugin-sdk/realtime-voice";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  createOpenAIRealtimeClientSecret,
  resolveOpenAIProviderConfigRecord,
} from "./realtime-provider-shared.js";
import { OpenAIQuicksilverVoiceBridge } from "./realtime-quicksilver-bridge.js";
import { OpenAIQuicksilverGatewayBridge } from "./realtime-quicksilver-gateway-bridge.js";
import { buildOpenAIQuicksilverInstructions } from "./realtime-quicksilver-instructions.js";
import {
  createOpenAIQuicksilverBrowserSessionBroker,
  OPENAI_QUICKSILVER_CAPABILITIES,
  resolveOpenAIChatGptSubscriptionAuth,
} from "./realtime-quicksilver-session.js";
import { isOpenAIGptLiveModel, isSupportedOpenAIGptLiveModel } from "./realtime-quicksilver.js";
import { OpenAIRealtimeBridge } from "./realtime-voice-bridge.js";
import {
  OPENAI_REALTIME_CAPABILITIES,
  OPENAI_REALTIME_CONFIGURED_API_KEY_REJECTED,
  OPENAI_REALTIME_DEFAULT_MODEL,
  OPENAI_REALTIME_INPUT_TRANSCRIPTION_MODEL,
  OPENAI_REALTIME_MODELS,
  OPENAI_REALTIME_PLATFORM_AUTH_REQUIRED,
  OPENAI_REALTIME_VOICES,
  buildOpenAIRealtimeGaSessionPolicy,
  hasOpenAIChatGptSubscriptionAuthInput,
  hasOpenAIRealtimeApiKeyInput,
  hasOpenAIRealtimePlatformAuthInput,
  normalizeOpenAIRealtimeTools,
  normalizeOpenAIRealtimeVoice,
  normalizeProviderConfig,
  requireOpenAIRealtimePlatformAuth,
  resolveOpenAIRealtimePlatformAuth,
  resolveOpenAIQuicksilverBridgeAuth,
  type OpenAIRealtimeVoice,
  type OpenAIRealtimeVoiceProviderConfig,
} from "./realtime-voice-session-policy.js";

function resolveOpenAIRealtimeBrowserOfferHeaders(): Record<string, string> | undefined {
  const headers = resolveProviderRequestHeaders({
    provider: "openai",
    baseUrl: "https://api.openai.com/v1/realtime/calls",
    capability: "audio",
    transport: "http",
    defaultHeaders: {},
  });
  // Strip server-side-only attribution headers: browser direct fetches to
  // api.openai.com fail CORS preflight when these are present (only
  // authorization,content-type are allowed by the endpoint's CORS policy).
  const SERVER_ONLY_HEADERS = new Set(["user-agent", "originator", "version"]);
  const browserHeaders = Object.fromEntries(
    Object.entries(headers ?? {}).filter(([key]) => !SERVER_ONLY_HEADERS.has(key.toLowerCase())),
  );
  return Object.keys(browserHeaders).length > 0 ? browserHeaders : undefined;
}

type OpenAIQuicksilverBrowserSessionBroker = ReturnType<
  typeof createOpenAIQuicksilverBrowserSessionBroker
>["broker"];

type OpenAIInternalRealtimeBrowserSessionCreateRequest =
  RealtimeVoiceBrowserSessionCreateRequest & {
    agentId: string;
    ownerConnId?: string;
    workspaceDir: string;
    initialItems: Array<{
      role: "user" | "assistant";
      text: string;
    }>;
  };

type OpenAIInternalRealtimeVoiceCapabilities = RealtimeVoiceProviderCapabilities & {
  handlesAgentConsult?: boolean;
  supportsGatewayControl?: boolean;
};

type OpenAIInternalRealtimeVoiceProviderApi = {
  isBrowserSessionConfigured: (ctx: {
    cfg?: RealtimeVoiceBrowserSessionCreateRequest["cfg"];
    providerConfig: RealtimeVoiceProviderConfig;
    agentId?: string;
  }) => boolean;
  resolveBrowserSessionCapabilities?: (ctx: {
    cfg?: RealtimeVoiceBrowserSessionCreateRequest["cfg"];
    providerConfig: RealtimeVoiceProviderConfig;
    agentId?: string;
    model?: string;
  }) => OpenAIInternalRealtimeVoiceCapabilities;
  isGatewayRelayConfigured?: (ctx: {
    cfg?: RealtimeVoiceBrowserSessionCreateRequest["cfg"];
    providerConfig: RealtimeVoiceProviderConfig;
    agentId?: string;
  }) => boolean | undefined;
  resolveGatewayRelayCapabilities?: (ctx: {
    cfg?: RealtimeVoiceBrowserSessionCreateRequest["cfg"];
    providerConfig: RealtimeVoiceProviderConfig;
    model?: string;
  }) => OpenAIInternalRealtimeVoiceCapabilities;
  validateGatewayRelayLaunch?: (ctx: {
    cfg?: RealtimeVoiceBrowserSessionCreateRequest["cfg"];
    providerConfig: RealtimeVoiceProviderConfig;
    model?: string;
    autoRespondToAudio?: boolean;
  }) => string | undefined;
  cancelBrowserSession?: (
    request: OpenAIInternalRealtimeBrowserSessionCreateRequest,
    session: RealtimeVoiceBrowserSession,
  ) => Promise<void> | void;
};

const INTERNAL_REALTIME_VOICE_PROVIDER = Symbol.for("openclaw.internal.realtime-voice-provider.v1");

function buildOpenAIRealtimeBrowserSessionConfig(
  req: OpenAIInternalRealtimeBrowserSessionCreateRequest,
  config: OpenAIRealtimeVoiceProviderConfig,
  model: string,
): {
  session: Record<string, unknown> & { model: string };
  voice: OpenAIRealtimeVoice;
} {
  const voice = normalizeOpenAIRealtimeVoice(req.voice) ?? config.voice ?? "alloy";
  const tools = normalizeOpenAIRealtimeTools(req.tools);
  const session: Record<string, unknown> & { model: string } = {
    type: "realtime",
    model,
    instructions: req.instructions,
    audio: {
      input: {
        noise_reduction: { type: "near_field" },
        turn_detection: {
          type: "server_vad",
          create_response: true,
          interrupt_response: true,
          ...(typeof (req.vadThreshold ?? config.vadThreshold) === "number"
            ? { threshold: req.vadThreshold ?? config.vadThreshold }
            : {}),
          ...(typeof (req.prefixPaddingMs ?? config.prefixPaddingMs) === "number"
            ? { prefix_padding_ms: req.prefixPaddingMs ?? config.prefixPaddingMs }
            : {}),
          ...(typeof (req.silenceDurationMs ?? config.silenceDurationMs) === "number"
            ? { silence_duration_ms: req.silenceDurationMs ?? config.silenceDurationMs }
            : {}),
        },
        transcription: { model: OPENAI_REALTIME_INPUT_TRANSCRIPTION_MODEL },
      },
      output: { voice },
    },
  };
  if (tools) {
    session.tools = tools;
    session.tool_choice = "auto";
  }
  const reasoningEffort = normalizeOptionalString(req.reasoningEffort) ?? config.reasoningEffort;
  if (reasoningEffort) {
    session.reasoning = { effort: reasoningEffort };
  }
  return { session, voice };
}

async function createOpenAIRealtimeBrowserSession(
  req: OpenAIInternalRealtimeBrowserSessionCreateRequest,
  quicksilverBroker: OpenAIQuicksilverBrowserSessionBroker | undefined,
): Promise<RealtimeVoiceBrowserSession> {
  const rawConfig = resolveOpenAIProviderConfigRecord(req.providerConfig);
  const config = normalizeProviderConfig(req.providerConfig);
  if (config.azureEndpoint || config.azureDeployment) {
    throw new Error("OpenAI Realtime browser sessions do not support Azure endpoints yet");
  }

  const model = req.model ?? config.model ?? OPENAI_REALTIME_DEFAULT_MODEL;
  if (req.gatewayControl) {
    if (isOpenAIGptLiveModel(model)) {
      throw new Error("gateway-control-v1 supports OpenAI GA Realtime models only");
    }
    if (!quicksilverBroker) {
      throw new Error("OpenAI realtime browser session broker is unavailable");
    }
    const auth = await requireOpenAIRealtimePlatformAuth({
      configuredApiKey: config.apiKey,
      cfg: req.cfg,
      agentId: req.agentId,
    });
    const voice = normalizeOpenAIRealtimeVoice(req.voice) ?? config.voice ?? "alloy";
    const sessionConfig = buildOpenAIRealtimeGaSessionPolicy({
      audioFormat: REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
      instructions: req.instructions,
      interruptResponseOnInputAudio: config.interruptResponseOnInputAudio,
      model,
      noiseReduction: { type: "near_field" },
      prefixPaddingMs: req.prefixPaddingMs ?? config.prefixPaddingMs,
      reasoningEffort: normalizeOptionalString(req.reasoningEffort) ?? config.reasoningEffort,
      silenceDurationMs: req.silenceDurationMs ?? config.silenceDurationMs,
      tools: normalizeOpenAIRealtimeTools(req.tools),
      vadThreshold: req.vadThreshold ?? config.vadThreshold,
      voice,
    });
    const gatewayControl = req.gatewayControl;
    return await quicksilverBroker.createBrowserSession(
      {
        ...req,
        model,
        voice,
        gaSideband: {
          session: sessionConfig,
          createBridge: ({ apiKey, callId, onTerminal }) => {
            const bridge = new OpenAIRealtimeBridge({
              cfg: req.cfg,
              agentId: req.agentId,
              providerConfig: req.providerConfig,
              apiKey,
              callId,
              gaSessionPolicy: sessionConfig,
              // sessionConfig above negotiates PCM16/24kHz with OpenAI - the
              // bridge's own audioFormat must match it (it defaults to
              // g711_ulaw/8kHz otherwise), since audio_end_ms accounting
              // converts delivered/played byte counts using this field. A
              // mismatch here would silently multiply every ms estimate by
              // the byte-rate ratio between the two formats.
              audioFormat: REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
              model,
              voice,
              instructions: req.instructions,
              tools: req.tools,
              interruptResponseOnInputAudio: config.interruptResponseOnInputAudio,
              reasoningEffort: req.reasoningEffort ?? config.reasoningEffort,
              vadThreshold: req.vadThreshold ?? config.vadThreshold,
              silenceDurationMs: req.silenceDurationMs ?? config.silenceDurationMs,
              prefixPaddingMs: req.prefixPaddingMs ?? config.prefixPaddingMs,
              onAudio: () => undefined,
              onClearAudio: () => undefined,
              onEvent: gatewayControl.onEvent,
              onResponseDone: gatewayControl.onResponseDone,
              onTranscript: gatewayControl.onTranscript,
              onToolCall: gatewayControl.onToolCall,
              onReady: gatewayControl.onReady,
              onError: gatewayControl.onError,
              onClose: (reason) => {
                gatewayControl.onClose?.(reason);
                onTerminal();
              },
            });
            gatewayControl.bindBridge(bridge);
            return bridge;
          },
        },
      },
      { type: "api-key", token: auth.value },
    );
  }
  if (isOpenAIGptLiveModel(model)) {
    if (!quicksilverBroker) {
      throw new Error("OpenAI GPT-Live browser session broker is unavailable");
    }
    const configuredVoice = normalizeOptionalString(rawConfig?.speakerVoice ?? rawConfig?.voice);
    const quicksilverRequest = {
      ...req,
      model,
      instructions: buildOpenAIQuicksilverInstructions(req.instructions),
      ...(req.voice ? {} : configuredVoice ? { voice: configuredVoice } : {}),
    };
    const auth = await resolveOpenAIQuicksilverBridgeAuth({
      configuredApiKey: config.apiKey,
      cfg: req.cfg,
      agentId: req.agentId,
    });
    return await quicksilverBroker.createBrowserSession(quicksilverRequest, auth);
  }
  const auth = await resolveOpenAIRealtimePlatformAuth({
    configuredApiKey: config.apiKey,
    cfg: req.cfg,
    agentId: req.agentId,
  });
  if (auth.status === "missing") {
    if (
      hasOpenAIRealtimePlatformAuthInput({
        configuredApiKey: config.apiKey,
        cfg: req.cfg,
        agentId: req.agentId,
      })
    ) {
      throw new Error(OPENAI_REALTIME_PLATFORM_AUTH_REQUIRED);
    }
    const subscriptionAuth = await resolveOpenAIChatGptSubscriptionAuth({
      cfg: req.cfg,
      agentDir: req.cfg ? resolveAgentDir(req.cfg, req.agentId) : undefined,
    });
    if (!subscriptionAuth) {
      throw new Error(OPENAI_REALTIME_PLATFORM_AUTH_REQUIRED);
    }
    if (!quicksilverBroker) {
      throw new Error("OpenAI realtime browser session broker is unavailable");
    }
    return await quicksilverBroker.createBrowserSession(
      {
        ...req,
        model,
        voice: normalizeOpenAIRealtimeVoice(req.voice) ?? config.voice ?? "alloy",
      },
      subscriptionAuth,
    );
  }

  const { session, voice } = buildOpenAIRealtimeBrowserSessionConfig(req, config, model);

  const clientSecret = await createOpenAIRealtimeClientSecret({
    authToken: auth.value,
    auditContext: "openai-realtime-browser-session",
    session,
    authRejectedMessage: OPENAI_REALTIME_CONFIGURED_API_KEY_REJECTED,
  });
  const offerHeaders = resolveOpenAIRealtimeBrowserOfferHeaders();
  return {
    provider: "openai",
    transport: "webrtc",
    clientSecret: clientSecret.value,
    offerUrl: "https://api.openai.com/v1/realtime/calls",
    ...(offerHeaders ? { offerHeaders } : {}),
    model,
    voice,
    ...(typeof clientSecret.expiresAt === "number" ? { expiresAt: clientSecret.expiresAt } : {}),
  };
}

export function buildOpenAIRealtimeVoiceProvider(options?: {
  quicksilverBrowserSessionBroker?: OpenAIQuicksilverBrowserSessionBroker;
  logger?: Pick<PluginLogger, "debug" | "warn">;
}): RealtimeVoiceProviderPlugin {
  const provider: RealtimeVoiceProviderPlugin = {
    id: "openai",
    label: "OpenAI Realtime Voice",
    defaultModel: OPENAI_REALTIME_DEFAULT_MODEL,
    // GA and GPT-Live accept the same ten voices; quicksilver validates at call
    // creation because voice is immutable once the session starts.
    models: OPENAI_REALTIME_MODELS,
    voices: OPENAI_REALTIME_VOICES,
    autoSelectOrder: 10,
    capabilities: OPENAI_REALTIME_CAPABILITIES,
    resolveConfig: ({ rawConfig }) => normalizeProviderConfig(rawConfig),
    isConfigured: ({ cfg, providerConfig, agentId }) => {
      const config = normalizeProviderConfig(providerConfig);
      if (config.azureEndpoint || config.azureDeployment) {
        return hasOpenAIRealtimeApiKeyInput(config.apiKey);
      }
      if (
        hasOpenAIRealtimePlatformAuthInput({
          configuredApiKey: config.apiKey,
          cfg,
          agentId,
        })
      ) {
        return true;
      }
      return false;
    },
    createBridge: (req) => {
      const config = normalizeProviderConfig(req.providerConfig);
      const model = config.model;
      if (model && isOpenAIGptLiveModel(model)) {
        if (config.azureEndpoint || config.azureDeployment) {
          throw new Error(
            "GPT-Live backend WebSocket sessions do not support Azure endpoints or deployments",
          );
        }
        if (req.runAgentConsult) {
          return new OpenAIQuicksilverGatewayBridge({
            ...req,
            model,
            voice: config.voice ?? "marin",
            instructions: buildOpenAIQuicksilverInstructions(req.instructions),
            logger: options?.logger ?? { debug: () => undefined, warn: () => undefined },
            resolveAuth: () =>
              resolveOpenAIQuicksilverBridgeAuth({
                configuredApiKey: config.apiKey,
                cfg: req.cfg,
                agentId: req.agentId,
              }),
          });
        }
        return new OpenAIQuicksilverVoiceBridge({
          ...req,
          model,
          voice: config.voice,
          instructions: buildOpenAIQuicksilverInstructions(req.instructions),
          resolveAuth: async () => ({
            type: "api-key",
            token: (
              await requireOpenAIRealtimePlatformAuth({
                configuredApiKey: config.apiKey,
                cfg: req.cfg,
                agentId: req.agentId,
              })
            ).value,
          }),
        });
      }
      return new OpenAIRealtimeBridge({
        ...req,
        apiKey: config.apiKey,
        model: config.model,
        voice: config.voice,
        temperature: config.temperature,
        vadThreshold: config.vadThreshold,
        silenceDurationMs: config.silenceDurationMs,
        prefixPaddingMs: config.prefixPaddingMs,
        interruptResponseOnInputAudio:
          req.interruptResponseOnInputAudio ?? config.interruptResponseOnInputAudio,
        minBargeInAudioEndMs: config.minBargeInAudioEndMs,
        reasoningEffort: config.reasoningEffort,
        azureEndpoint: config.azureEndpoint,
        azureDeployment: config.azureDeployment,
        azureApiVersion: config.azureApiVersion,
      });
    },
    createBrowserSession: (req) =>
      createOpenAIRealtimeBrowserSession(
        req as OpenAIInternalRealtimeBrowserSessionCreateRequest,
        options?.quicksilverBrowserSessionBroker,
      ),
  };
  const internalApi: OpenAIInternalRealtimeVoiceProviderApi = {
    isBrowserSessionConfigured: ({ cfg, providerConfig, agentId }) => {
      const config = normalizeProviderConfig(providerConfig);
      if (config.azureEndpoint || config.azureDeployment) {
        return false;
      }
      const model = config.model ?? OPENAI_REALTIME_DEFAULT_MODEL;
      if (isOpenAIGptLiveModel(model)) {
        if (!isSupportedOpenAIGptLiveModel(model)) {
          return false;
        }
        return (
          options?.quicksilverBrowserSessionBroker !== undefined &&
          (hasOpenAIRealtimePlatformAuthInput({
            configuredApiKey: config.apiKey,
            cfg,
            agentId,
          }) ||
            hasOpenAIChatGptSubscriptionAuthInput({ cfg, agentId }))
        );
      }
      return (
        hasOpenAIRealtimePlatformAuthInput({
          configuredApiKey: config.apiKey,
          cfg,
          agentId,
        }) ||
        (options?.quicksilverBrowserSessionBroker !== undefined &&
          hasOpenAIChatGptSubscriptionAuthInput({ cfg, agentId }))
      );
    },
    resolveBrowserSessionCapabilities: ({ cfg, providerConfig, agentId, model }) => {
      const config = normalizeProviderConfig(providerConfig);
      if (isSupportedOpenAIGptLiveModel(model ?? config.model)) {
        return {
          ...OPENAI_REALTIME_CAPABILITIES,
          ...OPENAI_QUICKSILVER_CAPABILITIES,
        };
      }
      return {
        ...OPENAI_REALTIME_CAPABILITIES,
        ...(options?.quicksilverBrowserSessionBroker !== undefined &&
        hasOpenAIRealtimePlatformAuthInput({ configuredApiKey: config.apiKey, cfg, agentId })
          ? { supportsGatewayControl: true }
          : {}),
      };
    },
    isGatewayRelayConfigured: ({ cfg, providerConfig, agentId }) => {
      const config = normalizeProviderConfig(providerConfig);
      if (!isOpenAIGptLiveModel(config.model)) {
        return undefined;
      }
      if (config.azureEndpoint || config.azureDeployment) {
        return false;
      }
      return (
        isSupportedOpenAIGptLiveModel(config.model) &&
        (hasOpenAIRealtimePlatformAuthInput({
          configuredApiKey: config.apiKey,
          cfg,
          agentId,
        }) ||
          hasOpenAIChatGptSubscriptionAuthInput({ cfg, agentId }))
      );
    },
    resolveGatewayRelayCapabilities: ({ providerConfig, model }) => {
      const config = normalizeProviderConfig(providerConfig);
      if (isSupportedOpenAIGptLiveModel(model ?? config.model)) {
        return {
          ...OPENAI_REALTIME_CAPABILITIES,
          ...OPENAI_QUICKSILVER_CAPABILITIES,
        };
      }
      return OPENAI_REALTIME_CAPABILITIES;
    },
    validateGatewayRelayLaunch: ({ providerConfig, model, autoRespondToAudio }) => {
      const config = normalizeProviderConfig(providerConfig);
      if (autoRespondToAudio === false && isOpenAIGptLiveModel(model ?? config.model)) {
        return "GPT-Live gateway-relay sessions cannot use forced agent consult routing; GPT-Live delegates to the agent natively";
      }
      return undefined;
    },
    cancelBrowserSession: (_request, session) =>
      options?.quicksilverBrowserSessionBroker?.cancelBrowserSession(session),
  };
  Object.defineProperty(provider, INTERNAL_REALTIME_VOICE_PROVIDER, {
    configurable: true,
    value: internalApi,
  });
  return provider;
}
