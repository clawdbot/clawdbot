import { Type } from "@sinclair/typebox";

import type { CoreConfig } from "./src/core-bridge.js";
import {
  VoiceCallConfigSchema,
  validateProviderConfig,
  type VoiceCallConfig,
} from "./src/config.js";
import { registerVoiceCallCli } from "./src/cli.js";
import { createVoiceCallRuntime, type VoiceCallRuntime } from "./src/runtime.js";
import { callGateway } from "../../dist/gateway/call.js";

const voiceCallConfigSchema = {
  parse(value: unknown): VoiceCallConfig {
    const raw =
      value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};

    const twilio = raw.twilio as Record<string, unknown> | undefined;
    const legacyFrom = typeof twilio?.from === "string" ? twilio.from : undefined;

    const enabled = typeof raw.enabled === "boolean" ? raw.enabled : true;
    const providerRaw = raw.provider === "log" ? "mock" : raw.provider;
    const provider = providerRaw ?? (enabled ? "mock" : undefined);

    return VoiceCallConfigSchema.parse({
      ...raw,
      enabled,
      provider,
      fromNumber: raw.fromNumber ?? legacyFrom,
    });
  },
  uiHints: {
    provider: {
      label: "Provider",
      help: "Use twilio, telnyx, or mock for dev/no-network.",
    },
    fromNumber: { label: "From Number", placeholder: "+15550001234" },
    toNumber: { label: "Default To Number", placeholder: "+15550001234" },
    inboundPolicy: { label: "Inbound Policy" },
    allowFrom: { label: "Inbound Allowlist" },
    inboundGreeting: { label: "Inbound Greeting", advanced: true },
    "telnyx.apiKey": { label: "Telnyx API Key", sensitive: true },
    "telnyx.connectionId": { label: "Telnyx Connection ID" },
    "telnyx.publicKey": { label: "Telnyx Public Key", sensitive: true },
    "twilio.accountSid": { label: "Twilio Account SID" },
    "twilio.authToken": { label: "Twilio Auth Token", sensitive: true },
    "outbound.defaultMode": { label: "Default Call Mode" },
    "outbound.notifyHangupDelaySec": {
      label: "Notify Hangup Delay (sec)",
      advanced: true,
    },
    "serve.port": { label: "Webhook Port" },
    "serve.bind": { label: "Webhook Bind" },
    "serve.path": { label: "Webhook Path" },
    "tailscale.mode": { label: "Tailscale Mode", advanced: true },
    "tailscale.path": { label: "Tailscale Path", advanced: true },
    "tunnel.provider": { label: "Tunnel Provider", advanced: true },
    "tunnel.ngrokAuthToken": {
      label: "ngrok Auth Token",
      sensitive: true,
      advanced: true,
    },
    "tunnel.ngrokDomain": { label: "ngrok Domain", advanced: true },
    "tunnel.allowNgrokFreeTier": {
      label: "Allow ngrok Free Tier",
      advanced: true,
    },
    "streaming.enabled": { label: "Enable Streaming", advanced: true },
    "streaming.openaiApiKey": {
      label: "OpenAI Realtime API Key",
      sensitive: true,
      advanced: true,
    },
    "streaming.sttModel": { label: "Realtime STT Model", advanced: true },
    "streaming.streamPath": { label: "Media Stream Path", advanced: true },
    "tts.provider": {
      label: "TTS Provider Override",
      help: "Deep-merges with messages.tts (Edge is ignored for calls).",
      advanced: true,
    },
    "tts.openai.model": { label: "OpenAI TTS Model", advanced: true },
    "tts.openai.voice": { label: "OpenAI TTS Voice", advanced: true },
    "tts.openai.apiKey": {
      label: "OpenAI API Key",
      sensitive: true,
      advanced: true,
    },
    "tts.elevenlabs.modelId": { label: "ElevenLabs Model ID", advanced: true },
    "tts.elevenlabs.voiceId": { label: "ElevenLabs Voice ID", advanced: true },
    "tts.elevenlabs.apiKey": {
      label: "ElevenLabs API Key",
      sensitive: true,
      advanced: true,
    },
    "tts.elevenlabs.baseUrl": { label: "ElevenLabs Base URL", advanced: true },
    publicUrl: { label: "Public Webhook URL", advanced: true },
    skipSignatureVerification: {
      label: "Skip Signature Verification",
      advanced: true,
    },
    store: { label: "Call Log Store Path", advanced: true },
    responseModel: { label: "Response Model", advanced: true },
    responseSystemPrompt: { label: "Response System Prompt", advanced: true },
    responseTimeoutMs: { label: "Response Timeout (ms)", advanced: true },
  },
};

const VoiceCallToolSchema = Type.Union([
  Type.Object({
    action: Type.Literal("initiate_call"),
    to: Type.Optional(Type.String({ description: "Call target" })),
    message: Type.String({ description: "Intro message" }),
    mode: Type.Optional(Type.Union([Type.Literal("notify"), Type.Literal("conversation")])),
  }),
  Type.Object({
    action: Type.Literal("continue_call"),
    callId: Type.String({ description: "Call ID" }),
    message: Type.String({ description: "Follow-up message" }),
  }),
  Type.Object({
    action: Type.Literal("speak_to_user"),
    callId: Type.String({ description: "Call ID" }),
    message: Type.String({ description: "Message to speak" }),
  }),
  Type.Object({
    action: Type.Literal("end_call"),
    callId: Type.String({ description: "Call ID" }),
  }),
  Type.Object({
    action: Type.Literal("get_status"),
    callId: Type.String({ description: "Call ID" }),
  }),
  Type.Object({
    mode: Type.Optional(Type.Union([Type.Literal("call"), Type.Literal("status")])),
    to: Type.Optional(Type.String({ description: "Call target" })),
    sid: Type.Optional(Type.String({ description: "Call SID" })),
    message: Type.Optional(Type.String({ description: "Optional intro message" })),
  }),
]);

const voiceCallPlugin = {
  id: "voice-call",
  name: "Voice Call",
  description: "Voice-call plugin with Telnyx/Twilio/Plivo providers",
  configSchema: voiceCallConfigSchema,
  register(api) {
    const cfg = voiceCallConfigSchema.parse(api.pluginConfig);
    const validation = validateProviderConfig(cfg);

    if (api.pluginConfig && typeof api.pluginConfig === "object") {
      const raw = api.pluginConfig as Record<string, unknown>;
      const twilio = raw.twilio as Record<string, unknown> | undefined;
      if (raw.provider === "log") {
        api.logger.warn(
          "[voice-call] provider \"log\" is deprecated; use \"mock\" instead",
        );
      }
      if (typeof twilio?.from === "string") {
        api.logger.warn(
          "[voice-call] twilio.from is deprecated; use fromNumber instead",
        );
      }
    }

    let runtimePromise: Promise<VoiceCallRuntime> | null = null;
    let runtime: VoiceCallRuntime | null = null;

    const ensureRuntime = async () => {
      if (!cfg.enabled) {
        throw new Error("Voice call disabled in plugin config");
      }
      if (!validation.valid) {
        throw new Error(validation.errors.join("; "));
      }
      if (runtime) return runtime;
      if (!runtimePromise) {
        runtimePromise = createVoiceCallRuntime({
          config: cfg,
          coreConfig: api.config as CoreConfig,
          ttsRuntime: api.runtime.tts,
          logger: api.logger,
        });
      }
      runtime = await runtimePromise;
      return runtime;
    };

    // PATCHED: Use proper error format for gateway responses
    // respond(false, undefined, { message: "error" }) instead of respond(false, { error: "..." })
    const respondError = (respond: (ok: boolean, payload?: unknown, error?: unknown) => void, msg: string) => {
      respond(false, undefined, { message: msg });
    };

    const sendError = (respond: (ok: boolean, payload?: unknown, error?: unknown) => void, err: unknown) => {
      respond(false, undefined, { message: err instanceof Error ? err.message : String(err) });
    };

    api.registerGatewayMethod("voicecall.initiate", async ({ params, respond }) => {
      try {
        const message =
          typeof params?.message === "string" ? params.message.trim() : "";
        if (!message) {
          respondError(respond, "message required");
          return;
        }
        const rt = await ensureRuntime();
        const to =
          typeof params?.to === "string" && params.to.trim()
            ? params.to.trim()
            : rt.config.toNumber;
        if (!to) {
          respondError(respond, "to required");
          return;
        }
        const mode =
          params?.mode === "notify" || params?.mode === "conversation"
            ? params.mode
            : undefined;
        const result = await rt.manager.initiateCall(to, undefined, {
          message,
          mode,
        });
        if (!result.success) {
          respondError(respond, result.error || "initiate failed");
          return;
        }
        respond(true, { callId: result.callId, initiated: true });
      } catch (err) {
        sendError(respond, err);
      }
    });

    api.registerGatewayMethod("voicecall.continue", async ({ params, respond }) => {
      try {
        const callId =
          typeof params?.callId === "string" ? params.callId.trim() : "";
        const message =
          typeof params?.message === "string" ? params.message.trim() : "";
        if (!callId || !message) {
          respondError(respond, "callId and message required");
          return;
        }
        const rt = await ensureRuntime();
        const result = await rt.manager.continueCall(callId, message);
        if (!result.success) {
          respondError(respond, result.error || "continue failed");
          return;
        }
        respond(true, { success: true, transcript: result.transcript });
      } catch (err) {
        sendError(respond, err);
      }
    });

    api.registerGatewayMethod("voicecall.speak", async ({ params, respond }) => {
      try {
        const callId =
          typeof params?.callId === "string" ? params.callId.trim() : "";
        const message =
          typeof params?.message === "string" ? params.message.trim() : "";
        if (!callId || !message) {
          respondError(respond, "callId and message required");
          return;
        }
        const rt = await ensureRuntime();
        const result = await rt.manager.speak(callId, message);
        if (!result.success) {
          respondError(respond, result.error || "speak failed");
          return;
        }
        respond(true, { success: true });
      } catch (err) {
        sendError(respond, err);
      }
    });

    api.registerGatewayMethod("voicecall.end", async ({ params, respond }) => {
      try {
        const callId =
          typeof params?.callId === "string" ? params.callId.trim() : "";
        if (!callId) {
          respondError(respond, "callId required");
          return;
        }
        const rt = await ensureRuntime();
        const result = await rt.manager.endCall(callId);
        if (!result.success) {
          respondError(respond, result.error || "end failed");
          return;
        }
        respond(true, { success: true });
      } catch (err) {
        sendError(respond, err);
      }
    });

    api.registerGatewayMethod("voicecall.status", async ({ params, respond }) => {
      try {
        const raw =
          typeof params?.callId === "string"
            ? params.callId.trim()
            : typeof params?.sid === "string"
              ? params.sid.trim()
              : "";
        if (!raw) {
          respondError(respond, "callId required");
          return;
        }
        const rt = await ensureRuntime();
        const call =
          rt.manager.getCall(raw) || rt.manager.getCallByProviderCallId(raw);
        if (!call) {
          respond(true, { found: false });
          return;
        }
        respond(true, { found: true, call });
      } catch (err) {
        sendError(respond, err);
      }
    });

    api.registerGatewayMethod("voicecall.start", async ({ params, respond }) => {
      try {
        const to = typeof params?.to === "string" ? params.to.trim() : "";
        const message =
          typeof params?.message === "string" ? params.message.trim() : "";
        if (!to) {
          respondError(respond, "to required");
          return;
        }
        const rt = await ensureRuntime();
        const result = await rt.manager.initiateCall(to, undefined, {
          message: message || undefined,
        });
        if (!result.success) {
          respondError(respond, result.error || "initiate failed");
          return;
        }
        respond(true, { callId: result.callId, initiated: true });
      } catch (err) {
        sendError(respond, err);
      }
    });

    // PATCHED: Detect embedded vs sandbox mode and use appropriate call path
    // In embedded mode (runtime available): use ensureRuntime() directly
    // In sandbox mode (runtime null): use gateway RPC
    api.registerTool({
      name: "voice_call",
      label: "Voice Call",
      description:
        "Make phone calls and have voice conversations via the voice-call plugin.",
      parameters: VoiceCallToolSchema,
      async execute(_toolCallId, params) {
        const json = (payload: unknown) => ({
          content: [
            { type: "text", text: JSON.stringify(payload, null, 2) },
          ],
          details: payload,
        });

        // Detect mode: if runtime exists, we're in gateway process (embedded)
        // If runtime is null, we're in sandbox - use gateway RPC
        const useDirectCalls = runtime !== null;

        // Gateway RPC helper (for sandbox mode)
        const gatewayCall = async (method: string, callParams: Record<string, unknown>): Promise<Record<string, unknown>> => {
          try {
            const result = await callGateway({
              method,
              params: callParams,
              timeoutMs: 10000,
            });
            return result as Record<string, unknown>;
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return { error: msg };
          }
        };

        // Direct call helper (for embedded mode)
        const directCall = async (action: string, callParams: Record<string, unknown>): Promise<Record<string, unknown>> => {
          const rt = await ensureRuntime();
          switch (action) {
            case "initiate": {
              const to = callParams.to as string | undefined ?? rt.config.toNumber;
              if (!to) return { error: "to required" };
              const result = await rt.manager.initiateCall(to, undefined, {
                message: callParams.message as string | undefined,
                mode: callParams.mode as "notify" | "conversation" | undefined,
              });
              if (!result.success) return { error: result.error || "initiate failed" };
              return { callId: result.callId, initiated: true };
            }
            case "continue": {
              const result = await rt.manager.continueCall(
                callParams.callId as string,
                callParams.message as string
              );
              if (!result.success) return { error: result.error || "continue failed" };
              return { success: true, transcript: result.transcript };
            }
            case "speak": {
              const result = await rt.manager.speak(
                callParams.callId as string,
                callParams.message as string
              );
              if (!result.success) return { error: result.error || "speak failed" };
              return { success: true };
            }
            case "end": {
              const result = await rt.manager.endCall(callParams.callId as string);
              if (!result.success) return { error: result.error || "end failed" };
              return { success: true };
            }
            case "status": {
              const raw = callParams.callId as string;
              const call = rt.manager.getCall(raw) || rt.manager.getCallByProviderCallId(raw);
              if (!call) return { found: false };
              return { found: true, call };
            }
            default:
              return { error: "unknown action" };
          }
        };

        // Unified call function that routes based on mode
        const doCall = async (action: string, callParams: Record<string, unknown>): Promise<Record<string, unknown>> => {
          if (useDirectCalls) {
            return directCall(action, callParams);
          } else {
            const methodMap: Record<string, string> = {
              initiate: "voicecall.initiate",
              continue: "voicecall.continue",
              speak: "voicecall.speak",
              end: "voicecall.end",
              status: "voicecall.status",
            };
            return gatewayCall(methodMap[action] || action, callParams);
          }
        };

        try {
          if (typeof params?.action === "string") {
            switch (params.action) {
              case "initiate_call": {
                const message = String(params.message || "").trim();
                if (!message) throw new Error("message required");
                const to = typeof params.to === "string" && params.to.trim()
                  ? params.to.trim()
                  : undefined;
                const mode = params.mode === "notify" || params.mode === "conversation"
                  ? params.mode
                  : undefined;
                const result = await doCall("initiate", { to, message, mode });
                if (result.error) throw new Error(String(result.error));
                return json({ callId: result.callId, initiated: true });
              }
              case "continue_call": {
                const callId = String(params.callId || "").trim();
                const message = String(params.message || "").trim();
                if (!callId || !message) throw new Error("callId and message required");
                const result = await doCall("continue", { callId, message });
                if (result.error) throw new Error(String(result.error));
                return json({ success: true, transcript: result.transcript });
              }
              case "speak_to_user": {
                const callId = String(params.callId || "").trim();
                const message = String(params.message || "").trim();
                if (!callId || !message) throw new Error("callId and message required");
                const result = await doCall("speak", { callId, message });
                if (result.error) throw new Error(String(result.error));
                return json({ success: true });
              }
              case "end_call": {
                const callId = String(params.callId || "").trim();
                if (!callId) throw new Error("callId required");
                const result = await doCall("end", { callId });
                if (result.error) throw new Error(String(result.error));
                return json({ success: true });
              }
              case "get_status": {
                const callId = String(params.callId || "").trim();
                if (!callId) throw new Error("callId required");
                const result = await doCall("status", { callId });
                return json(result);
              }
            }
          }

          // Legacy mode-based params
          const mode = params?.mode ?? "call";
          if (mode === "status") {
            const sid = typeof params.sid === "string" ? params.sid.trim() : "";
            if (!sid) throw new Error("sid required for status");
            const result = await doCall("status", { callId: sid });
            return json(result);
          }

          // Default: initiate call
          const to = typeof params.to === "string" && params.to.trim()
            ? params.to.trim()
            : undefined;
          const message = typeof params.message === "string" && params.message.trim()
            ? params.message.trim()
            : undefined;
          const result = await doCall("initiate", { to, message });
          if (result.error) throw new Error(String(result.error));
          return json({ callId: result.callId, initiated: true });

        } catch (err) {
          return json({
            error: err instanceof Error ? err.message : String(err),
          });
        }
      },
    });

    api.registerCli(
      ({ program }) =>
        registerVoiceCallCli({
          program,
          config: cfg,
          ensureRuntime,
          logger: api.logger,
        }),
      { commands: ["voicecall"] },
    );

    api.registerService({
      id: "voicecall",
      start: async () => {
        if (!cfg.enabled) return;
        try {
          await ensureRuntime();
        } catch (err) {
          api.logger.error(
            `[voice-call] Failed to start runtime: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      },
      stop: async () => {
        if (!runtimePromise) return;
        try {
          const rt = await runtimePromise;
          await rt.stop();
        } finally {
          runtimePromise = null;
          runtime = null;
        }
      },
    });
  },
};

export default voiceCallPlugin;
