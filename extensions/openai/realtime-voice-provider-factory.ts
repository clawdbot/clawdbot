import type { PluginLogger } from "openclaw/plugin-sdk/plugin-entry";
import type {
  RealtimeVoiceBrowserSession,
  RealtimeVoiceBrowserSessionCreateRequest,
  RealtimeVoiceProviderCapabilities,
  RealtimeVoiceProviderConfig,
  RealtimeVoiceProviderPlugin,
} from "openclaw/plugin-sdk/realtime-voice";
import { REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ } from "openclaw/plugin-sdk/realtime-voice-provider";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveOpenAIChatGptSubscriptionAuth } from "./realtime-auth.js";
import type { OpenAIRealtimeHost } from "./realtime-host.js";
import { createOpenAIRealtimeClientSecret } from "./realtime-provider-shared.js";
import { OpenAIQuicksilverVoiceBridge } from "./realtime-quicksilver-bridge.js";
import { OpenAIQuicksilverGatewayBridge } from "./realtime-quicksilver-gateway-bridge.js";
import { buildOpenAIQuicksilverInstructions } from "./realtime-quicksilver-instructions.js";
import type { createOpenAIQuicksilverBrowserSessionBroker } from "./realtime-quicksilver-session.js";
import {
  OPENAI_QUICKSILVER_CAPABILITIES,
  isOpenAIGptLiveModel,
  isSupportedOpenAIGptLiveModel,
  OPENAI_GPT_LIVE_DEFAULT_VOICE,
} from "./realtime-quicksilver.js";
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
  voicesByModel?: Record<string, readonly string[]>;
  authMethods?: readonly { id: string; label: string }[];
  selectedAuthMethod?: string;
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
    clientControl?: RealtimeVoiceBrowserSessionCreateRequest["clientControl"];
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
  warn: OpenAIRealtimeHost["warn"],
): {
  session: Record<string, unknown> & { model: string };
  voice: OpenAIRealtimeVoice;
} {
  const voice =
    normalizeOpenAIRealtimeVoice(req.voice) ??
    normalizeOpenAIRealtimeVoice(config.voice) ??
    "alloy";
  const tools = normalizeOpenAIRealtimeTools(req.tools, warn);
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
  logger: Pick<PluginLogger, "warn">,
  context: OpenAIRealtimeHost,
): Promise<RealtimeVoiceBrowserSession> {
  const { resolveAgentDir } = context;
  const config = normalizeProviderConfig(req.providerConfig);
  if (config.azureEndpoint || config.azureDeployment) {
    throw new Error("OpenAI Realtime browser sessions do not support Azure endpoints yet");
  }

  const model = req.model ?? config.model ?? OPENAI_REALTIME_DEFAULT_MODEL;
  if (isOpenAIGptLiveModel(model)) {
    if (!quicksilverBroker) {
      throw new Error("OpenAI GPT-Live browser session broker is unavailable");
    }
    const quicksilverRequest = {
      ...req,
      model,
      instructions: buildOpenAIQuicksilverInstructions(req.instructions),
      voice: req.voice ?? config.voice,
    };
    const auth = await resolveOpenAIQuicksilverBridgeAuth(
      {
        authMethod: config.authMethod,
        configuredApiKey: config.apiKey,
        cfg: req.cfg,
        agentId: req.agentId,
      },
      context,
    );
    return {
      ...(await quicksilverBroker.createBrowserSession(quicksilverRequest, auth)),
      authMethod: auth.type,
    };
  }
  if (req.gatewayControl) {
    if (config.authMethod === "oauth") {
      throw new Error(
        "OpenAI GA OAuth requires client-owned WebRTC control; gateway-control-v1 is unavailable",
      );
    }
    if (!quicksilverBroker) {
      throw new Error("OpenAI realtime browser session broker is unavailable");
    }
    const auth = await requireOpenAIRealtimePlatformAuth(
      {
        configuredApiKey: config.apiKey,
        cfg: req.cfg,
        agentId: req.agentId,
      },
      context,
    );
    const voice =
      normalizeOpenAIRealtimeVoice(req.voice) ??
      normalizeOpenAIRealtimeVoice(config.voice) ??
      "alloy";
    const sessionConfig = buildOpenAIRealtimeGaSessionPolicy({
      audioFormat: REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
      instructions: req.instructions,
      interruptResponseOnInputAudio: config.interruptResponseOnInputAudio,
      model,
      noiseReduction: { type: "near_field" },
      prefixPaddingMs: req.prefixPaddingMs ?? config.prefixPaddingMs,
      reasoningEffort: normalizeOptionalString(req.reasoningEffort) ?? config.reasoningEffort,
      silenceDurationMs: req.silenceDurationMs ?? config.silenceDurationMs,
      tools: normalizeOpenAIRealtimeTools(req.tools, context.warn),
      vadThreshold: req.vadThreshold ?? config.vadThreshold,
      voice,
    });
    const gatewayControl = req.gatewayControl;
    return await quicksilverBroker.createBrowserSession(
      {
        ...req,
        model,
        voice,
        clientControl: { owner: "gateway" },
        gatewayControl,
        gaSession: sessionConfig,
        gaSideband: {
          createBridge: ({ apiKey, callId, onTerminal }) => {
            const bridge = new OpenAIRealtimeBridge(
              {
                cfg: req.cfg,
                agentId: req.agentId,
                providerConfig: req.providerConfig,
                apiKey,
                callId,
                audioFormat: REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
                gaSessionPolicy: sessionConfig,
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
                  try {
                    gatewayControl.onClose?.(reason);
                  } finally {
                    onTerminal();
                  }
                },
                logger,
              },
              context,
            );
            if (gatewayControl.bindControl) {
              gatewayControl.bindControl({
                submitToolResult: bridge.submitToolResult.bind(bridge),
                sendUserMessage: bridge.sendUserMessage.bind(bridge),
              });
            } else {
              // v2026.8.1 hosts expose only bindBridge. Remove this fallback when the
              // minimum supported host includes bindControl; native negotiation never uses it.
              gatewayControl.bindBridge(bridge);
            }
            return bridge;
          },
        },
      },
      { type: "api-key", token: auth.value },
    );
  }
  const { session, voice } = buildOpenAIRealtimeBrowserSessionConfig(
    req,
    config,
    model,
    context.warn,
  );
  const auth =
    config.authMethod === "oauth"
      ? { status: "missing" as const }
      : await resolveOpenAIRealtimePlatformAuth(
          { configuredApiKey: config.apiKey, cfg: req.cfg, agentId: req.agentId },
          context,
        );
  if (auth.status === "missing") {
    if (config.authMethod === "api-key") {
      throw new Error(OPENAI_REALTIME_PLATFORM_AUTH_REQUIRED);
    }
    if (
      config.authMethod !== "oauth" &&
      hasOpenAIRealtimePlatformAuthInput(
        {
          configuredApiKey: config.apiKey,
          cfg: req.cfg,
          agentId: req.agentId,
        },
        context,
      )
    ) {
      throw new Error(OPENAI_REALTIME_PLATFORM_AUTH_REQUIRED);
    }
    const subscriptionAuth = await resolveOpenAIChatGptSubscriptionAuth(
      {
        cfg: req.cfg,
        agentDir: req.cfg ? resolveAgentDir(req.cfg, req.agentId) : undefined,
      },
      context,
    );
    if (!subscriptionAuth) {
      throw new Error(
        config.authMethod === "oauth"
          ? "OpenAI Talk selected ChatGPT OAuth, but no usable OAuth profile is available. Sign in again; API-key fallback is disabled."
          : OPENAI_REALTIME_PLATFORM_AUTH_REQUIRED,
      );
    }
    if (!quicksilverBroker) {
      throw new Error("OpenAI realtime browser session broker is unavailable");
    }
    return {
      ...(await quicksilverBroker.createBrowserSession(
        { ...req, model, voice, gaSession: session },
        subscriptionAuth,
      )),
      authMethod: "oauth",
    };
  }

  const clientSecret = await createOpenAIRealtimeClientSecret(
    {
      authToken: auth.value,
      auditContext: "openai-realtime-browser-session",
      session,
      authRejectedMessage: OPENAI_REALTIME_CONFIGURED_API_KEY_REJECTED,
    },
    context,
  );
  const headers = context.resolveProviderRequestHeaders({
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
  const offerHeaders = Object.keys(browserHeaders).length > 0 ? browserHeaders : undefined;
  return {
    provider: "openai",
    transport: "webrtc",
    clientSecret: clientSecret.value,
    authMethod: "api-key",
    offerUrl: "https://api.openai.com/v1/realtime/calls",
    offerResponseMaxBytes: 256 * 1024,
    ...(offerHeaders ? { offerHeaders } : {}),
    model,
    voice,
    ...(typeof clientSecret.expiresAt === "number" ? { expiresAt: clientSecret.expiresAt } : {}),
  };
}

export function buildOpenAIRealtimeVoiceProvider(
  context: OpenAIRealtimeHost,
  options?: {
    quicksilverBrowserSessionBroker?: OpenAIQuicksilverBrowserSessionBroker;
    logger?: Pick<PluginLogger, "debug" | "warn">;
  },
): RealtimeVoiceProviderPlugin {
  const provider: RealtimeVoiceProviderPlugin = {
    id: "openai",
    label: "OpenAI Realtime Voice",
    defaultModel: OPENAI_REALTIME_DEFAULT_MODEL,
    // GA is the provider default; model-specific GPT-Live voices are in the capabilities.
    models: OPENAI_REALTIME_MODELS,
    voices: OPENAI_REALTIME_VOICES,
    autoSelectOrder: 10,
    capabilities: OPENAI_REALTIME_CAPABILITIES,
    resolveConfig: ({ rawConfig }) => normalizeProviderConfig(rawConfig),
    isConfigured: ({ cfg, providerConfig, agentId }) => {
      const config = normalizeProviderConfig(providerConfig);
      if (config.authMethod === "oauth") {
        return false;
      }
      if (config.azureEndpoint || config.azureDeployment) {
        return hasOpenAIRealtimeApiKeyInput(config.apiKey);
      }
      if (
        hasOpenAIRealtimePlatformAuthInput(
          {
            configuredApiKey: config.apiKey,
            cfg,
            agentId,
          },
          context,
        )
      ) {
        return true;
      }
      return false;
    },
    createBridge: (req) => {
      const config = normalizeProviderConfig(req.providerConfig);
      if (
        config.authMethod === "oauth" &&
        (!isOpenAIGptLiveModel(config.model) || !req.runAgentConsult)
      ) {
        throw new Error(
          "Selected OAuth authentication requires client-owned WebRTC for this Talk session",
        );
      }
      const model = config.model;
      if (model && isOpenAIGptLiveModel(model)) {
        if (config.azureEndpoint || config.azureDeployment) {
          throw new Error(
            "GPT-Live backend WebSocket sessions do not support Azure endpoints or deployments",
          );
        }
        if (req.runAgentConsult) {
          return new OpenAIQuicksilverGatewayBridge(
            {
              ...req,
              model,
              voice: config.voice ?? OPENAI_GPT_LIVE_DEFAULT_VOICE,
              instructions: buildOpenAIQuicksilverInstructions(req.instructions),
              logger: options?.logger ?? { debug: () => undefined, warn: () => undefined },
              resolveAuth: () =>
                resolveOpenAIQuicksilverBridgeAuth(
                  {
                    authMethod: config.authMethod,
                    configuredApiKey: config.apiKey,
                    cfg: req.cfg,
                    agentId: req.agentId,
                  },
                  context,
                ),
            },
            context,
          );
        }
        return new OpenAIQuicksilverVoiceBridge(
          {
            ...req,
            model,
            voice: config.voice,
            instructions: buildOpenAIQuicksilverInstructions(req.instructions),
            logger: options?.logger ?? { warn: () => undefined },
            resolveAuth: async () => ({
              type: "api-key",
              token: (
                await requireOpenAIRealtimePlatformAuth(
                  {
                    configuredApiKey: config.apiKey,
                    cfg: req.cfg,
                    agentId: req.agentId,
                  },
                  context,
                )
              ).value,
            }),
          },
          context,
        );
      }
      return new OpenAIRealtimeBridge(
        {
          ...req,
          apiKey: config.apiKey,
          model: config.model,
          voice: normalizeOpenAIRealtimeVoice(config.voice),
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
          logger: options?.logger ?? { warn: () => undefined },
        },
        context,
      );
    },
    createBrowserSession: (req) =>
      createOpenAIRealtimeBrowserSession(
        // SAFETY: Talk client creation supplies the private agent/workspace context before this call.
        req as OpenAIInternalRealtimeBrowserSessionCreateRequest,
        options?.quicksilverBrowserSessionBroker,
        options?.logger ?? { warn: () => undefined },
        context,
      ),
  };
  const internalApi: OpenAIInternalRealtimeVoiceProviderApi = {
    isBrowserSessionConfigured: ({ cfg, providerConfig, agentId }) => {
      const config = normalizeProviderConfig(providerConfig);
      if (config.azureEndpoint || config.azureDeployment) {
        return false;
      }
      if (config.authMethod === "oauth") {
        return (
          options?.quicksilverBrowserSessionBroker !== undefined &&
          (!isOpenAIGptLiveModel(config.model) || isSupportedOpenAIGptLiveModel(config.model)) &&
          hasOpenAIChatGptSubscriptionAuthInput({ cfg, agentId }, context)
        );
      }
      if (config.authMethod === "api-key") {
        return (
          (!isOpenAIGptLiveModel(config.model) ||
            (isSupportedOpenAIGptLiveModel(config.model) &&
              options?.quicksilverBrowserSessionBroker !== undefined)) &&
          hasOpenAIRealtimePlatformAuthInput(
            { configuredApiKey: config.apiKey, cfg, agentId },
            context,
          )
        );
      }
      const model = config.model ?? OPENAI_REALTIME_DEFAULT_MODEL;
      if (isOpenAIGptLiveModel(model)) {
        if (!isSupportedOpenAIGptLiveModel(model)) {
          return false;
        }
        return (
          options?.quicksilverBrowserSessionBroker !== undefined &&
          (hasOpenAIRealtimePlatformAuthInput(
            {
              configuredApiKey: config.apiKey,
              cfg,
              agentId,
            },
            context,
          ) ||
            hasOpenAIChatGptSubscriptionAuthInput({ cfg, agentId }, context))
        );
      }
      return (
        hasOpenAIRealtimePlatformAuthInput(
          {
            configuredApiKey: config.apiKey,
            cfg,
            agentId,
          },
          context,
        ) ||
        (options?.quicksilverBrowserSessionBroker !== undefined &&
          hasOpenAIChatGptSubscriptionAuthInput({ cfg, agentId }, context))
      );
    },
    resolveBrowserSessionCapabilities: ({ cfg, providerConfig, agentId, model, clientControl }) => {
      const config = normalizeProviderConfig(providerConfig);
      const effectiveModel = model ?? config.model;
      const selection = {
        authMethods: [
          { id: "oauth", label: "ChatGPT OAuth only" },
          { id: "api-key", label: "OpenAI Platform API key only" },
        ],
        selectedAuthMethod: config.authMethod,
      };
      if (isSupportedOpenAIGptLiveModel(effectiveModel)) {
        // Older hosts do not prepare this control claim, even when they own native delegations.
        const supportsGatewayControl =
          clientControl?.owner === "gateway" &&
          internalApi.isBrowserSessionConfigured({
            cfg,
            providerConfig: { ...providerConfig, model: effectiveModel },
            agentId,
          });
        return {
          ...OPENAI_REALTIME_CAPABILITIES,
          ...OPENAI_QUICKSILVER_CAPABILITIES,
          ...selection,
          ...(supportsGatewayControl ? { supportsGatewayControl: true } : {}),
        };
      }
      return {
        ...OPENAI_REALTIME_CAPABILITIES,
        ...selection,
        ...(config.authMethod === "oauth" ? { transports: ["webrtc" as const] } : {}),
        ...(config.authMethod !== "oauth" &&
        options?.quicksilverBrowserSessionBroker !== undefined &&
        hasOpenAIRealtimePlatformAuthInput(
          { configuredApiKey: config.apiKey, cfg, agentId },
          context,
        )
          ? { supportsGatewayControl: true }
          : {}),
      };
    },
    isGatewayRelayConfigured: ({ cfg, providerConfig, agentId }) => {
      const config = normalizeProviderConfig(providerConfig);
      if (!isOpenAIGptLiveModel(config.model)) {
        return config.authMethod === "oauth" ? false : undefined;
      }
      if (config.azureEndpoint || config.azureDeployment) {
        return false;
      }
      return (
        isSupportedOpenAIGptLiveModel(config.model) &&
        ((config.authMethod !== "oauth" &&
          hasOpenAIRealtimePlatformAuthInput(
            {
              configuredApiKey: config.apiKey,
              cfg,
              agentId,
            },
            context,
          )) ||
          (config.authMethod !== "api-key" &&
            hasOpenAIChatGptSubscriptionAuthInput({ cfg, agentId }, context)))
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
