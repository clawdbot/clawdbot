import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type {
  RealtimeVoiceProviderConfig,
  RealtimeVoiceProviderPlugin,
} from "openclaw/plugin-sdk/realtime-voice";
import type { VoiceCallConfig } from "./config.js";
import { resolveVoiceCallConfig, validateProviderConfig } from "./config.js";
import type { CoreAgentDeps, CoreConfig } from "./core-bridge.js";
import { CallManager } from "./manager.js";
import { resolveConfiguredCapabilityProvider } from "./provider-runtime-resolution.js";
import type { VoiceCallProvider } from "./providers/base.js";
import type { TwilioProvider } from "./providers/twilio.js";
import type { TelephonyTtsRuntime } from "./telephony-tts.js";
import { createTelephonyTtsProvider } from "./telephony-tts.js";
import { startTunnel, type TunnelResult } from "./tunnel.js";
import { VoiceCallWebhookServer } from "./webhook.js";
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

type ResolvedRealtimeProvider = {
  provider: RealtimeVoiceProviderPlugin;
  providerConfig: RealtimeVoiceProviderConfig;
};

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

function isLoopbackBind(bind: string | undefined): boolean {
  if (!bind) {
    return false;
  }
  return bind === "127.0.0.1" || bind === "::1" || bind === "localhost";
}

async function resolveProvider(config: VoiceCallConfig): Promise<VoiceCallProvider> {
  const allowNgrokFreeTierLoopbackBypass =
    config.tunnel?.provider === "ngrok" &&
    isLoopbackBind(config.serve?.bind) &&
    (config.tunnel?.allowNgrokFreeTierLoopbackBypass ?? false);

  switch (config.provider) {
    case "telnyx": {
      const { TelnyxProvider } = await import("./providers/telnyx.js");
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
      const { TwilioProvider } = await import("./providers/twilio.js");
      return new TwilioProvider(
        {
          accountSid: config.twilio?.accountSid,
          authToken: config.twilio?.authToken,
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
      const { PlivoProvider } = await import("./providers/plivo.js");
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
      const { MockProvider } = await import("./providers/mock.js");
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
  const { getRealtimeVoiceProvider, listRealtimeVoiceProviders } =
    await import("./realtime-voice.runtime.js");
  const resolution = resolveConfiguredCapabilityProvider({
    configuredProviderId: params.config.realtime.provider,
    providerConfigs: params.config.realtime.providers,
    cfg: params.fullConfig,
    cfgForResolve: params.fullConfig,
    getConfiguredProvider: (providerId) => getRealtimeVoiceProvider(providerId, params.fullConfig),
    listProviders: () => listRealtimeVoiceProviders(params.fullConfig),
    resolveProviderConfig: ({ provider, cfg, rawConfig }) =>
      provider.resolveConfig?.({ cfg, rawConfig }) ?? rawConfig,
    isProviderConfigured: ({ provider, cfg, providerConfig }) =>
      provider.isConfigured({ cfg, providerConfig }),
  });
  if (!resolution.ok && resolution.code === "missing-configured-provider") {
    throw new Error(
      `Realtime voice provider "${resolution.configuredProviderId}" is not registered`,
    );
  }
  if (!resolution.ok && resolution.code === "no-registered-provider") {
    throw new Error("No realtime voice provider registered");
  }
  if (!resolution.ok) {
    throw new Error(`Realtime voice provider "${resolution.provider?.id}" is not configured`);
  }

  const provider = resolution.provider;
  return {
    provider,
    providerConfig: resolution.providerConfig,
  };
}

export async function createVoiceCallRuntime(params: {
  config: VoiceCallConfig;
  coreConfig: CoreConfig;
  fullConfig?: OpenClawConfig;
  agentRuntime: CoreAgentDeps;
  ttsRuntime?: TelephonyTtsRuntime;
  logger?: Logger;
}): Promise<VoiceCallRuntime> {
  const { config: rawConfig, coreConfig, fullConfig, agentRuntime, ttsRuntime, logger } = params;
  const log = logger ?? {
    info: console.log,
    warn: console.warn,
    error: console.error,
    debug: console.debug,
  };

  const config = resolveVoiceCallConfig(rawConfig);

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
  const manager = new CallManager(config);
  const realtimeProvider = config.realtime.enabled
    ? await resolveRealtimeProvider({
        config,
        fullConfig: fullConfig ?? (coreConfig as OpenClawConfig),
      })
    : null;
  const webhookServer = new VoiceCallWebhookServer(
    config,
    manager,
    provider,
    coreConfig,
    fullConfig ?? (coreConfig as OpenClawConfig),
    agentRuntime,
  );
  if (realtimeProvider) {
    const { RealtimeCallHandler } = await import("./webhook/realtime-handler.js");
    webhookServer.setRealtimeHandler(
      new RealtimeCallHandler(
        config.realtime,
        manager,
        provider,
        realtimeProvider.provider,
        realtimeProvider.providerConfig,
        config.serve.path,
      ),
    );
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

    if (publicUrl && provider.name === "twilio") {
      (provider as TwilioProvider).setPublicUrl(publicUrl);
    }
    if (publicUrl && realtimeProvider) {
      webhookServer.getRealtimeHandler()?.setPublicUrl(publicUrl);
    }

    if (provider.name === "twilio" && config.streaming?.enabled) {
      const twilioProvider = provider as TwilioProvider;
      if (ttsRuntime?.textToSpeechTelephony) {
        try {
          const ttsProvider = createTelephonyTtsProvider({
            coreConfig,
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
    if (publicUrl) {
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
