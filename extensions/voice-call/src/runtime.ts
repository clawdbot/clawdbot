// Voice Call plugin module implements runtime behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { isLoopbackHost } from "openclaw/plugin-sdk/gateway-runtime";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import {
  assertRealtimeVoiceAgentConsultModelSelectionUnlocked,
  consultRealtimeVoiceAgent,
  REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
  resolveRealtimeVoiceAgentConsultTools,
  resolveRealtimeVoiceAgentConsultToolsAllow,
  type RealtimeVoiceAgentConsultTranscriptEntry,
  type ResolvedRealtimeVoiceProvider,
} from "openclaw/plugin-sdk/realtime-voice";
import { normalizeAgentId } from "openclaw/plugin-sdk/routing";
import type { VoiceCallConfig } from "./config.js";
import {
  resolveVoiceCallEffectiveConfig,
  resolveVoiceCallNumberRouteKeyForCall,
  resolveVoiceCallSessionKey,
  resolveTwilioAuthToken,
  resolveVoiceCallConfig,
  validateProviderConfig,
} from "./config.js";
import type { CoreAgentDeps, CoreConfig } from "./core-bridge.js";
import { CallManager } from "./manager.js";
import type { VoiceCallProvider } from "./providers/base.js";
import type { TwilioProvider } from "./providers/twilio.js";
import { buildRealtimeVoiceInstructions } from "./realtime-agent-context.js";
import { resolveRealtimeFastContextConsult } from "./realtime-fast-context.js";
import { resolveCallAgentId } from "./resolve-call-agent-id.js";
import { resolveVoiceResponseModel } from "./response-model.js";
import { setVoiceCallStateRuntime, type VoiceCallStateRuntime } from "./runtime-state.js";
import type { TelephonyTtsRuntime } from "./telephony-tts.js";
import { createTelephonyTtsProvider } from "./telephony-tts.js";
import { startTunnel, type TunnelResult } from "./tunnel.js";
import type { CallRecord } from "./types.js";
import {
  isProviderUnreachableWebhookUrl,
  providerRequiresPublicWebhook,
} from "./webhook-exposure.js";
import { VoiceCallWebhookServer } from "./webhook.js";
import type { ToolHandlerContext } from "./webhook/realtime-handler.js";
import { cleanupTailscaleExposure, setupTailscaleExposure } from "./webhook/tailscale.js";

export type VoiceCallRuntime = {
  config: VoiceCallConfig;
  provider: VoiceCallProvider;
  manager: CallManager;
  webhookServer: VoiceCallWebhookServer;
  webhookUrl: string;
  publicUrl: string | null;
  stop: () => Promise<void>;
};

type Logger = {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
  debug?: (message: string) => void;
};

type ResolvedRealtimeProvider = ResolvedRealtimeVoiceProvider;

const REALTIME_VOICE_CONSULT_SYSTEM_PROMPT = [
  "You are the configured OpenClaw agent receiving delegated requests from a live phone voice bridge.",
  "Act on behalf of the caller using the normal available tools when the caller asks you to do work.",
  "Prioritize completing the user's request and returning a fast, speakable result over exhaustive investigation.",
  "For tool-backed status checks, prefer one or two bounded read-only queries before answering.",
  "Do not print secret values or dump environment variables; only check whether required configuration is present.",
  "Be accurate, brief, and speakable.",
].join(" ");

const loadTelnyxProvider = createLazyRuntimeModule(() => import("./providers/telnyx.js"));

const loadTwilioProvider = createLazyRuntimeModule(() => import("./providers/twilio.js"));

const loadPlivoProvider = createLazyRuntimeModule(() => import("./providers/plivo.js"));

const loadMockProvider = createLazyRuntimeModule(() => import("./providers/mock.js"));

const loadRealtimeVoiceRuntime = createLazyRuntimeModule(
  () => import("./realtime-voice.runtime.js"),
);

const loadRealtimeHandler = createLazyRuntimeModule(() => import("./webhook/realtime-handler.js"));

function resolveVoiceCallConsultSessionKey(call: {
  config: VoiceCallConfig;
  coreSession?: OpenClawConfig["session"];
  sessionKey?: string;
  from?: string;
  to?: string;
  direction?: "inbound" | "outbound";
  callId: string;
}): string {
  return resolveVoiceCallSessionKey({
    config: call.config,
    callId: call.callId,
    phone: call.direction === "outbound" ? call.to : call.from,
    explicitSessionKey: call.sessionKey,
    coreSession: call.coreSession,
  });
}

function mapVoiceCallConsultTranscript(
  call: {
    transcript?: Array<{ speaker: "user" | "bot"; text: string }>;
  },
  context?: ToolHandlerContext,
): RealtimeVoiceAgentConsultTranscriptEntry[] {
  const transcript: RealtimeVoiceAgentConsultTranscriptEntry[] = (call.transcript ?? []).map(
    (entry) => ({
      role: entry.speaker === "bot" ? "assistant" : "user",
      text: entry.text,
    }),
  );
  const partial = context?.partialUserTranscript?.trim();
  if (partial && transcript.at(-1)?.text !== partial) {
    transcript.push({ role: "user", text: partial });
  }
  return transcript;
}

function createRuntimeResourceLifecycle(params: {
  config: VoiceCallConfig;
  webhookServer: VoiceCallWebhookServer;
}): {
  setTunnelResult: (result: TunnelResult | null) => void;
  stop: (opts?: { suppressErrors?: boolean }) => Promise<void>;
} {
  let tunnelResult: TunnelResult | null = null;
  let stopped = false;

  const runStep = async (step: () => Promise<void>, suppressErrors: boolean) => {
    if (suppressErrors) {
      await step().catch(() => {});
      return;
    }
    await step();
  };

  return {
    setTunnelResult: (result) => {
      tunnelResult = result;
    },
    stop: async (opts) => {
      if (stopped) {
        return;
      }
      stopped = true;
      const suppressErrors = opts?.suppressErrors ?? false;
      await runStep(async () => {
        if (tunnelResult) {
          await tunnelResult.stop();
        }
      }, suppressErrors);
      await runStep(async () => {
        await cleanupTailscaleExposure(params.config);
      }, suppressErrors);
      await runStep(async () => {
        await params.webhookServer.stop();
      }, suppressErrors);
    },
  };
}

async function resolveProvider(config: VoiceCallConfig): Promise<VoiceCallProvider> {
  const allowNgrokFreeTierLoopbackBypass =
    config.tunnel?.provider === "ngrok" &&
    isLoopbackHost(config.serve?.bind ?? "") &&
    (config.tunnel?.allowNgrokFreeTierLoopbackBypass ?? false);

  switch (config.provider) {
    case "telnyx": {
      const { TelnyxProvider } = await loadTelnyxProvider();
      return new TelnyxProvider(
        {
          apiKey: config.telnyx?.apiKey,
          connectionId: config.telnyx?.connectionId,
          publicKey: config.telnyx?.publicKey,
        },
        {
          skipVerification: config.skipSignatureVerification,
        },
      );
    }
    case "twilio": {
      const { TwilioProvider } = await loadTwilioProvider();
      return new TwilioProvider(
        {
          accountSid: config.twilio?.accountSid,
          authToken: resolveTwilioAuthToken(config),
          region: config.twilio?.region,
        },
        {
          allowNgrokFreeTierLoopbackBypass,
          publicUrl: config.publicUrl,
          skipVerification: config.skipSignatureVerification,
          streamPath: config.streaming?.enabled ? config.streaming.streamPath : undefined,
          webhookSecurity: config.webhookSecurity,
        },
      );
    }
    case "plivo": {
      const { PlivoProvider } = await loadPlivoProvider();
      return new PlivoProvider(
        {
          authId: config.plivo?.authId,
          authToken: config.plivo?.authToken,
        },
        {
          publicUrl: config.publicUrl,
          skipVerification: config.skipSignatureVerification,
          ringTimeoutSec: Math.max(1, Math.floor(config.ringTimeoutMs / 1000)),
          webhookSecurity: config.webhookSecurity,
        },
      );
    }
    case "mock": {
      const { MockProvider } = await loadMockProvider();
      return new MockProvider();
    }
    default:
      throw new Error(`Unsupported voice-call provider: ${String(config.provider)}`);
  }
}

async function resolveRealtimeProvider(params: {
  config: VoiceCallConfig;
  fullConfig: OpenClawConfig;
}): Promise<ResolvedRealtimeProvider> {
  const { resolveConfiguredRealtimeVoiceProvider } = await loadRealtimeVoiceRuntime();
  return resolveConfiguredRealtimeVoiceProvider({
    configuredProviderId: params.config.realtime.provider,
    providerConfigs: params.config.realtime.providers,
    cfg: params.fullConfig,
  });
}

function listRealtimeAgentIds(config: VoiceCallConfig, coreConfig: OpenClawConfig): string[] {
  const agentIds = new Set<string>([normalizeAgentId(config.agentId)]);
  for (const agent of coreConfig.agents?.list ?? []) {
    agentIds.add(normalizeAgentId(agent.id));
  }
  for (const route of Object.values(config.numbers)) {
    if (route.agentId) {
      agentIds.add(normalizeAgentId(route.agentId));
    }
  }
  return [...agentIds];
}

async function createRealtimeInstructionsResolver(params: {
  config: VoiceCallConfig;
  coreConfig: OpenClawConfig;
  agentRuntime: CoreAgentDeps;
}): Promise<(call: CallRecord) => string> {
  const genericConfig: VoiceCallConfig = {
    ...params.config,
    realtime: {
      ...params.config.realtime,
      agentContext: { ...params.config.realtime.agentContext, enabled: false },
    },
  };
  const genericInstructions = await buildRealtimeVoiceInstructions({
    baseInstructions: params.config.realtime.instructions,
    config: genericConfig,
    coreConfig: params.coreConfig,
    agentRuntime: params.agentRuntime,
  });
  const entries = await Promise.all(
    listRealtimeAgentIds(params.config, params.coreConfig).map(async (agentId) => {
      const instructions = await buildRealtimeVoiceInstructions({
        baseInstructions: params.config.realtime.instructions,
        config: { ...params.config, agentId },
        coreConfig: params.coreConfig,
        agentRuntime: params.agentRuntime,
      });
      return [agentId, instructions] as const;
    }),
  );
  const instructionsByAgentId = new Map(entries);
  return (call) => {
    const numberRouteKey = resolveVoiceCallNumberRouteKeyForCall(call);
    const effectiveConfig = resolveVoiceCallEffectiveConfig(params.config, numberRouteKey).config;
    return (
      instructionsByAgentId.get(resolveCallAgentId(call, effectiveConfig)) ?? genericInstructions
    );
  };
}

export async function createVoiceCallRuntime(params: {
  config: VoiceCallConfig;
  coreConfig: CoreConfig;
  fullConfig?: OpenClawConfig;
  agentRuntime: CoreAgentDeps;
  stateRuntime?: VoiceCallStateRuntime["state"];
  ttsRuntime?: TelephonyTtsRuntime;
  logger?: Logger;
}): Promise<VoiceCallRuntime> {
  const {
    config: rawConfig,
    coreConfig,
    fullConfig,
    agentRuntime,
    stateRuntime,
    ttsRuntime,
    logger,
  } = params;
  const log = logger ?? {
    info: console.log,
    warn: console.warn,
    error: console.error,
    debug: console.debug,
  };

  const config = resolveVoiceCallConfig(rawConfig);
  const cfg = fullConfig ?? (coreConfig as OpenClawConfig);

  if (!config.enabled) {
    throw new Error("Voice call disabled. Enable the plugin entry in config.");
  }

  if (config.skipSignatureVerification) {
    log.warn(
      "[voice-call] SECURITY WARNING: skipSignatureVerification=true disables webhook signature verification (development only). Do not use in production.",
    );
  }

  const validation = validateProviderConfig(config);
  if (!validation.valid) {
    throw new Error(`Invalid voice-call config: ${validation.errors.join("; ")}`);
  }

  const provider = await resolveProvider(config);
  if (stateRuntime) {
    setVoiceCallStateRuntime({ state: stateRuntime });
  }
  const manager = new CallManager(config, undefined, cfg.session);
  const realtimeProvider = config.realtime.enabled
    ? await resolveRealtimeProvider({
        config,
        fullConfig: cfg,
      })
    : null;
  const webhookServer = new VoiceCallWebhookServer(
    config,
    manager,
    provider,
    coreConfig,
    fullConfig ?? (coreConfig as OpenClawConfig),
    agentRuntime,
    log,
  );
  if (realtimeProvider) {
    const { RealtimeCallHandler } = await loadRealtimeHandler();
    const resolveRealtimeInstructions = await createRealtimeInstructionsResolver({
      config,
      coreConfig: cfg,
      agentRuntime,
    });
    const realtimeConfig = {
      ...config.realtime,
      tools: resolveRealtimeVoiceAgentConsultTools(
        config.realtime.toolPolicy,
        config.realtime.tools,
      ),
    };
    const realtimeHandler = new RealtimeCallHandler(
      realtimeConfig,
      manager,
      provider,
      realtimeProvider.provider,
      realtimeProvider.providerConfig,
      config.serve.path,
      cfg,
      resolveRealtimeInstructions,
    );
    if (config.realtime.toolPolicy !== "none") {
      realtimeHandler.registerToolHandler(
        REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
        async (args, callId, handlerContext) => {
          const call = manager.getCall(callId);
          if (!call) {
            return { error: `Call "${callId}" not found` };
          }
          const numberRouteKey = resolveVoiceCallNumberRouteKeyForCall(call);
          const effectiveConfig = resolveVoiceCallEffectiveConfig(config, numberRouteKey).config;
          const agentId = resolveCallAgentId(call, effectiveConfig);
          const sessionKey = resolveVoiceCallConsultSessionKey({
            ...call,
            config: { ...effectiveConfig, agentId },
            coreSession: cfg.session,
          });
          const requesterSessionKey =
            typeof call.metadata?.requesterSessionKey === "string"
              ? call.metadata.requesterSessionKey
              : undefined;
          const modelLockParams = {
            cfg,
            agentRuntime,
            agentId,
            sessionKey,
            spawnedBy: requesterSessionKey,
          };
          assertRealtimeVoiceAgentConsultModelSelectionUnlocked(modelLockParams);
          const fastContext = await resolveRealtimeFastContextConsult({
            cfg,
            agentId,
            sessionKey,
            config: effectiveConfig.realtime.fastContext,
            args,
            logger: log,
          });
          if (fastContext.handled) {
            assertRealtimeVoiceAgentConsultModelSelectionUnlocked(modelLockParams);
            return fastContext.result;
          }
          const { provider: agentProvider, model } = resolveVoiceResponseModel({
            voiceConfig: effectiveConfig,
            agentRuntime,
          });
          const thinkLevel =
            effectiveConfig.realtime.consultThinkingLevel ??
            agentRuntime.resolveThinkingDefault({
              cfg,
              provider: agentProvider,
              model,
            });
          return await consultRealtimeVoiceAgent({
            cfg,
            agentRuntime,
            logger: log,
            agentId,
            sessionKey,
            messageProvider: "voice",
            lane: "voice",
            runIdPrefix: `voice-realtime-consult:${callId}`,
            args,
            transcript: mapVoiceCallConsultTranscript(call, handlerContext),
            surface: "a live phone call",
            userLabel: "Caller",
            assistantLabel: "Agent",
            questionSourceLabel: "caller",
            provider: agentProvider,
            model,
            thinkLevel,
            fastMode: effectiveConfig.realtime.consultFastMode,
            timeoutMs: effectiveConfig.responseTimeoutMs,
            spawnedBy: requesterSessionKey,
            contextMode: requesterSessionKey ? "fork" : undefined,
            toolsAllow: resolveRealtimeVoiceAgentConsultToolsAllow(
              effectiveConfig.realtime.toolPolicy,
            ),
            extraSystemPrompt: REALTIME_VOICE_CONSULT_SYSTEM_PROMPT,
          });
        },
      );
    }
    webhookServer.setRealtimeHandler(realtimeHandler);
  }
  const lifecycle = createRuntimeResourceLifecycle({ config, webhookServer });

  const localUrl = await webhookServer.start();

  // Wrap remaining initialization in try/catch so the webhook server is
  // properly stopped if any subsequent step fails.  Without this, the server
  // keeps the port bound while the runtime promise rejects, causing
  // EADDRINUSE on the next attempt.  See: #32387
  try {
    // Determine public URL - priority: config.publicUrl > tunnel > legacy tailscale
    let publicUrl: string | null = config.publicUrl ?? null;

    if (!publicUrl && config.tunnel?.provider && config.tunnel.provider !== "none") {
      try {
        const nextTunnelResult = await startTunnel({
          provider: config.tunnel.provider,
          port: config.serve.port,
          path: config.serve.path,
          ngrokAuthToken: config.tunnel.ngrokAuthToken,
          ngrokDomain: config.tunnel.ngrokDomain,
        });
        lifecycle.setTunnelResult(nextTunnelResult);
        publicUrl = nextTunnelResult?.publicUrl ?? null;
      } catch (err) {
        log.error(`[voice-call] Tunnel setup failed: ${formatErrorMessage(err)}`);
      }
    }

    if (!publicUrl && config.tailscale?.mode !== "off") {
      publicUrl = await setupTailscaleExposure(config);
    }

    const webhookUrl = publicUrl ?? localUrl;

    if (
      providerRequiresPublicWebhook(provider.name) &&
      isProviderUnreachableWebhookUrl(webhookUrl)
    ) {
      throw new Error(
        `[voice-call] ${provider.name} requires a publicly reachable webhook URL. ` +
          `Refusing to use local-only webhook ${webhookUrl}. ` +
          "Set plugins.entries.voice-call.config.publicUrl or enable tunnel/tailscale exposure.",
      );
    }

    if (publicUrl) {
      provider.setPublicUrl?.(publicUrl);
    }
    if (publicUrl && realtimeProvider) {
      webhookServer.getRealtimeHandler()?.setPublicUrl(publicUrl);
    }

    const realtimeHandler = webhookServer.getRealtimeHandler();
    if (realtimeHandler) {
      manager.streamSessionIssuer = (request) => realtimeHandler.issueStreamSession(request);
    }

    if (provider.name === "twilio" && config.streaming?.enabled) {
      const twilioProvider = provider as TwilioProvider;
      if (ttsRuntime?.textToSpeechTelephony) {
        try {
          const ttsProvider = await createTelephonyTtsProvider({
            coreConfig: cfg,
            ttsOverride: config.tts,
            runtime: ttsRuntime,
            logger: log,
          });
          twilioProvider.setTTSProvider(ttsProvider);
          log.info("[voice-call] Telephony TTS provider configured");
        } catch (err) {
          log.warn(`[voice-call] Failed to initialize telephony TTS: ${formatErrorMessage(err)}`);
        }
      } else {
        log.warn("[voice-call] Telephony TTS unavailable; streaming TTS disabled");
      }

      const mediaHandler = webhookServer.getMediaStreamHandler();
      if (mediaHandler) {
        twilioProvider.setMediaStreamHandler(mediaHandler);
        log.info("[voice-call] Media stream handler wired to provider");
      }
    }

    if (realtimeProvider) {
      log.info(`[voice-call] Realtime voice provider: ${realtimeProvider.provider.id}`);
    }

    await manager.initialize(provider, webhookUrl);

    const stop = async () => await lifecycle.stop();

    log.info("[voice-call] Runtime initialized");
    log.info(`[voice-call] Webhook URL: ${webhookUrl}`);
    if (publicUrl && publicUrl !== webhookUrl) {
      log.info(`[voice-call] Public URL: ${publicUrl}`);
    }

    return {
      config,
      provider,
      manager,
      webhookServer,
      webhookUrl,
      publicUrl,
      stop,
    };
  } catch (err) {
    // If any step after the server started fails, clean up every provisioned
    // resource (tunnel, tailscale exposure, and webhook server) so retries
    // don't leak processes or keep the port bound.
    await lifecycle.stop({ suppressErrors: true });
    throw err;
  }
}
