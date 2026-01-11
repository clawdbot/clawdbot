import { loadConfig } from "../config/config.js";
import type { VoiceCallConfig } from "./config.js";
import { VoiceCallConfigSchema, validateProviderConfig } from "./config.js";
import { CallManager } from "./manager.js";
import type { VoiceCallProvider } from "./providers/base.js";
import { MockProvider } from "./providers/mock.js";
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
  config: ReturnType<typeof VoiceCallConfigSchema.parse>;
  provider: VoiceCallProvider;
  manager: CallManager;
  webhookServer: VoiceCallWebhookServer;
  webhookUrl: string;
  publicUrl: string | null;
  stop: () => Promise<void>;
};

let runtimePromise: Promise<VoiceCallRuntime> | null = null;

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
    case "mock":
      return new MockProvider();
    default:
      throw new Error(
        `Unsupported voiceCall.provider: ${String(config.provider)}`,
      );
  }
}

/**
 * Initialize and keep a singleton voice-call runtime.
 *
 * Note: For real providers, your webhook URL must be publicly reachable.
 * Configure tunneling via `voiceCall.tunnel` (ngrok or tailscale) or set
 * `voiceCall.publicUrl` directly if using external tunnel management.
 */
export async function getVoiceCallRuntime(): Promise<VoiceCallRuntime> {
  if (runtimePromise) return runtimePromise;

  runtimePromise = (async () => {
    const fullCfg = loadConfig() as unknown as { voiceCall?: unknown };
    const config = VoiceCallConfigSchema.parse(fullCfg.voiceCall ?? {});

    if (!config.enabled) {
      throw new Error(
        "Voice call not enabled. Set voiceCall.enabled: true in config.",
      );
    }

    const validation = validateProviderConfig(config);
    if (!validation.valid) {
      throw new Error(
        `Invalid voiceCall config: ${validation.errors.join("; ")}`,
      );
    }

    const provider = resolveProvider(config);
    const manager = new CallManager(config);
    const webhookServer = new VoiceCallWebhookServer(config, manager, provider);

    const localUrl = await webhookServer.start();

    // Determine public URL - priority: config.publicUrl > tunnel > legacy tailscale
    let publicUrl: string | null = config.publicUrl ?? null;
    let tunnelResult: TunnelResult | null = null;

    if (
      !publicUrl &&
      config.tunnel?.provider &&
      config.tunnel.provider !== "none"
    ) {
      // Use new unified tunnel system
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
        console.error("[voice-call] Tunnel setup failed:", err);
        // Fall through to legacy tailscale
      }
    }

    // Legacy Tailscale fallback (for backward compatibility)
    if (!publicUrl && config.tailscale?.mode !== "off") {
      publicUrl = await setupTailscaleExposure(config);
    }

    const webhookUrl = publicUrl ?? localUrl;

    // Set public URL on Twilio provider for signature verification and TwiML generation
    if (publicUrl && provider.name === "twilio") {
      (provider as TwilioProvider).setPublicUrl(publicUrl);
    }

    // Wire up OpenAI TTS and media streams for Twilio provider
    if (provider.name === "twilio" && config.streaming?.enabled) {
      const twilioProvider = provider as TwilioProvider;

      // Set up OpenAI TTS provider
      const openaiApiKey =
        config.streaming.openaiApiKey || process.env.OPENAI_API_KEY;
      if (openaiApiKey) {
        try {
          const ttsProvider = new OpenAITTSProvider({
            apiKey: openaiApiKey,
            voice: config.tts.voice,
          });
          twilioProvider.setTTSProvider(ttsProvider);
          console.log("[voice-call] OpenAI TTS provider configured");
        } catch (err) {
          console.warn("[voice-call] Failed to initialize OpenAI TTS:", err);
        }
      }

      // Wire up media stream handler
      const mediaHandler = webhookServer.getMediaStreamHandler();
      if (mediaHandler) {
        twilioProvider.setMediaStreamHandler(mediaHandler);
        console.log("[voice-call] Media stream handler wired to provider");
      }
    }

    manager.initialize(provider, webhookUrl);

    const stop = async () => {
      // Stop tunnel if we started one
      if (tunnelResult) {
        await tunnelResult.stop();
      }
      // Legacy tailscale cleanup
      await cleanupTailscaleExposure(config);
      await webhookServer.stop();
    };

    console.log(`[voice-call] Runtime initialized`);
    console.log(`[voice-call] Webhook URL: ${webhookUrl}`);
    if (publicUrl) {
      console.log(`[voice-call] Public URL: ${publicUrl}`);
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
  })();

  return runtimePromise;
}

export async function stopVoiceCallRuntime(): Promise<void> {
  if (!runtimePromise) return;
  try {
    const rt = await runtimePromise;
    await rt.stop();
  } finally {
    runtimePromise = null;
  }
}
