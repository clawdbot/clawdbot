import type { CoreConfig } from "./core-bridge.js";
import type { VoiceCallConfig } from "./config.js";
import { validateProviderConfig } from "./config.js";
import { CallManager } from "./manager.js";
import type { VoiceCallProvider } from "./providers/base.js";
import { MockProvider } from "./providers/mock.js";
import { PlivoProvider } from "./providers/plivo.js";
import { TelnyxProvider } from "./providers/telnyx.js";
import { OpenAITTSProvider } from "./providers/tts-openai.js";
import { TwilioProvider } from "./providers/twilio.js";
import { startTunnel, type TunnelResult } from "./tunnel.js";
import {
  cleanupTailscaleExposure,
  setupTailscaleExposure,
  VoiceCallWebhookServer,
} from "./webhook.js";

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
  debug: (message: string) => void;
};

function resolveProvider(config: VoiceCallConfig): VoiceCallProvider {
  switch (config.provider) {
    case "telnyx":
      return new TelnyxProvider({
        apiKey: config.telnyx?.apiKey ?? process.env.TELNYX_API_KEY,
        connectionId:
          config.telnyx?.connectionId ?? process.env.TELNYX_CONNECTION_ID,
        publicKey: config.telnyx?.publicKey ?? process.env.TELNYX_PUBLIC_KEY,
      });
    case "twilio":
      return new TwilioProvider(
        {
          accountSid:
            config.twilio?.accountSid ?? process.env.TWILIO_ACCOUNT_SID,
          authToken: config.twilio?.authToken ?? process.env.TWILIO_AUTH_TOKEN,
        },
        {
          allowNgrokFreeTier: config.tunnel?.allowNgrokFreeTier ?? true,
          publicUrl: config.publicUrl,
          skipVerification: config.skipSignatureVerification,
          streamPath: config.streaming?.enabled
            ? config.streaming.streamPath
            : undefined,
        },
      );
    case "plivo":
      return new PlivoProvider(
        {
          authId: config.plivo?.authId ?? process.env.PLIVO_AUTH_ID,
          authToken: config.plivo?.authToken ?? process.env.PLIVO_AUTH_TOKEN,
        },
        {
          publicUrl: config.publicUrl,
          skipVerification: config.skipSignatureVerification,
          ringTimeoutSec: Math.max(1, Math.floor(config.ringTimeoutMs / 1000)),
        },
      );
    case "mock":
      return new MockProvider();
    default:
      throw new Error(
        `Unsupported voice-call provider: ${String(config.provider)}`,
      );
  }
}

export async function createVoiceCallRuntime(params: {
  config: VoiceCallConfig;
  coreConfig: CoreConfig;
  logger?: Logger;
}): Promise<VoiceCallRuntime> {
  const { config, coreConfig, logger } = params;
  const log = logger ?? {
    info: console.log,
    warn: console.warn,
    error: console.error,
    debug: console.debug,
  };

  if (!config.enabled) {
    throw new Error(
      "Voice call disabled. Enable the plugin entry in config.",
    );
  }

  const validation = validateProviderConfig(config);
  if (!validation.valid) {
    throw new Error(`Invalid voice-call config: ${validation.errors.join("; ")}`);
  }

  const provider = resolveProvider(config);
  const manager = new CallManager(config);
  const webhookServer = new VoiceCallWebhookServer(
    config,
    manager,
    provider,
    coreConfig,
  );

  const localUrl = await webhookServer.start();

  // Determine public URL - priority: config.publicUrl > tunnel > legacy tailscale
  let publicUrl: string | null = config.publicUrl ?? null;
  let tunnelResult: TunnelResult | null = null;

  if (!publicUrl && config.tunnel?.provider && config.tunnel.provider !== "none") {
    try {
      tunnelResult = await startTunnel({
        provider: config.tunnel.provider,
        port: config.serve.port,
        path: config.serve.path,
        ngrokAuthToken:
          config.tunnel.ngrokAuthToken ?? process.env.NGROK_AUTHTOKEN,
        ngrokDomain: config.tunnel.ngrokDomain ?? process.env.NGROK_DOMAIN,
      });
      publicUrl = tunnelResult?.publicUrl ?? null;
    } catch (err) {
      log.error(
        `[voice-call] Tunnel setup failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  if (!publicUrl && config.tailscale?.mode !== "off") {
    publicUrl = await setupTailscaleExposure(config);
  }

  const webhookUrl = publicUrl ?? localUrl;

  if (publicUrl && provider.name === "twilio") {
    (provider as TwilioProvider).setPublicUrl(publicUrl);
  }

  if (provider.name === "twilio" && config.streaming?.enabled) {
    const twilioProvider = provider as TwilioProvider;
    const openaiApiKey =
      config.streaming.openaiApiKey || process.env.OPENAI_API_KEY;
    if (openaiApiKey) {
      try {
        const ttsProvider = new OpenAITTSProvider({
          apiKey: openaiApiKey,
          voice: config.tts.voice,
          model: config.tts.model,
          instructions: config.tts.instructions,
        });
        twilioProvider.setTTSProvider(ttsProvider);
        log.info("[voice-call] OpenAI TTS provider configured");
      } catch (err) {
        log.warn(
          `[voice-call] Failed to initialize OpenAI TTS: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    } else {
      log.warn("[voice-call] OpenAI TTS key missing; streaming TTS disabled");
    }

    const mediaHandler = webhookServer.getMediaStreamHandler();
    if (mediaHandler) {
      twilioProvider.setMediaStreamHandler(mediaHandler);
      log.info("[voice-call] Media stream handler wired to provider");
    }
  }

  manager.initialize(provider, webhookUrl);

  const stop = async () => {
    if (tunnelResult) {
      await tunnelResult.stop();
    }
    await cleanupTailscaleExposure(config);
    await webhookServer.stop();
  };

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
}
