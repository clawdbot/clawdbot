import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import { Type } from "typebox";
import {
  definePluginEntry,
  type GatewayRequestHandlerOptions,
  type OpenClawPluginApi,
} from "./api.js";
import { createVoiceCallRuntime, type VoiceCallRuntime } from "./runtime-entry.js";
import { registerVoiceCallCli } from "./src/cli.js";
import {
  formatVoiceCallLegacyConfigWarnings,
  normalizeVoiceCallLegacyConfigInput,
  parseVoiceCallPluginConfig,
} from "./src/config-compat.js";
import {
  resolveVoiceCallConfig,
  validateProviderConfig,
  type VoiceCallConfig,
} from "./src/config.js";
import type { CoreConfig } from "./src/core-bridge.js";

const voiceCallConfigSchema = {
  parse(value: unknown): VoiceCallConfig {
    const normalized = normalizeVoiceCallLegacyConfigInput(value);
    const enabled = typeof normalized.enabled === "boolean" ? normalized.enabled : true;
    return parseVoiceCallPluginConfig({
      ...normalized,
      enabled,
      provider: normalized.provider ?? (enabled ? "mock" : undefined),
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
    "tunnel.allowNgrokFreeTierLoopbackBypass": {
      label: "Allow ngrok Free Tier (Loopback Bypass)",
      advanced: true,
    },
    "streaming.enabled": { label: "Enable Streaming", advanced: true },
    "streaming.provider": {
      label: "Streaming Provider",
      help: "Uses the first registered realtime transcription provider when unset.",
      advanced: true,
    },
    "streaming.providers": { label: "Streaming Provider Config", advanced: true },
    "streaming.streamPath": { label: "Media Stream Path", advanced: true },
    "realtime.enabled": { label: "Enable Realtime Voice", advanced: true },
    "realtime.provider": {
      label: "Realtime Voice Provider",
      help: "Uses the first registered realtime voice provider when unset.",
      advanced: true,
    },
    "realtime.streamPath": { label: "Realtime Stream Path", advanced: true },
    "realtime.instructions": { label: "Realtime Instructions", advanced: true },
    "realtime.toolPolicy": {
      label: "Realtime Tool Policy",
      help: "Controls the shared openclaw_agent_consult tool.",
      advanced: true,
    },
    "realtime.providers": { label: "Realtime Provider Config", advanced: true },
    "tts.provider": {
      label: "TTS Provider Override",
      help: "Deep-merges with messages.tts (Microsoft is ignored for calls).",
      advanced: true,
    },
    "tts.providers": { label: "TTS Provider Config", advanced: true },
    publicUrl: { label: "Public Webhook URL", advanced: true },
    skipSignatureVerification: {
      label: "Skip Signature Verification",
      advanced: true,
    },
    store: { label: "Call Log Store Path", advanced: true },
    agentId: {
      label: "Response Agent ID",
      help: 'Agent workspace used for voice response generation. Defaults to "main".',
      advanced: true,
    },
    responseModel: {
      label: "Response Model",
      help: "Optional override. Falls back to the runtime default model when unset.",
      advanced: true,
    },
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
    action: Type.Literal("send_dtmf"),
    callId: Type.String({ description: "Call ID" }),
    digits: Type.String({ description: "DTMF digits to send" }),
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

function asParamRecord(params: unknown): Record<string, unknown> {
  return params && typeof params === "object" && !Array.isArray(params)
    ? (params as Record<string, unknown>)
    : {};
}

const VOICE_CALL_RUNTIME_KEY = Symbol.for("openclaw.voice-call.runtime");
const VOICE_CALL_RUNTIME_PROMISE_KEY = Symbol.for("openclaw.voice-call.runtimePromise");
const VOICE_CALL_RUNTIME_STOP_PROMISE_KEY = Symbol.for("openclaw.voice-call.runtimeStopPromise");

type VoiceCallRuntimeGlobalState = typeof globalThis & {
  [VOICE_CALL_RUNTIME_KEY]?: VoiceCallRuntime | null;
  [VOICE_CALL_RUNTIME_PROMISE_KEY]?: Promise<VoiceCallRuntime> | null;
  [VOICE_CALL_RUNTIME_STOP_PROMISE_KEY]?: Promise<void> | null;
};

function getVoiceCallRuntimeGlobalState(): VoiceCallRuntimeGlobalState {
  const state = globalThis as VoiceCallRuntimeGlobalState;
  state[VOICE_CALL_RUNTIME_KEY] ??= null;
  state[VOICE_CALL_RUNTIME_PROMISE_KEY] ??= null;
  state[VOICE_CALL_RUNTIME_STOP_PROMISE_KEY] ??= null;
  return state;
}

export default definePluginEntry({
  id: "voice-call",
  name: "Voice Call",
  description: "Voice-call plugin with Telnyx/Twilio/Plivo providers",
  configSchema: voiceCallConfigSchema,
  register(api: OpenClawPluginApi) {
    const config = resolveVoiceCallConfig(voiceCallConfigSchema.parse(api.pluginConfig));
    const validation = validateProviderConfig(config);

    if (api.pluginConfig && typeof api.pluginConfig === "object") {
      for (const warning of formatVoiceCallLegacyConfigWarnings({
        value: api.pluginConfig,
        configPathPrefix: "plugins.entries.voice-call.config",
        doctorFixCommand: "openclaw doctor --fix",
      })) {
        api.logger.warn(warning);
      }
    }

    const runtimeState = getVoiceCallRuntimeGlobalState();

    const ensureRuntime = async (): Promise<VoiceCallRuntime> => {
      if (!config.enabled) {
        throw new Error("Voice call disabled in plugin config");
      }
      if (!validation.valid) {
        throw new Error(validation.errors.join("; "));
      }

      while (true) {
        if (runtimeState[VOICE_CALL_RUNTIME_STOP_PROMISE_KEY]) {
          await runtimeState[VOICE_CALL_RUNTIME_STOP_PROMISE_KEY];
          continue;
        }

        const runtime = runtimeState[VOICE_CALL_RUNTIME_KEY];
        if (runtime) {
          return runtime;
        }

        let runtimePromise = runtimeState[VOICE_CALL_RUNTIME_PROMISE_KEY];
        if (!runtimePromise) {
          runtimePromise = createVoiceCallRuntime({
            config,
            coreConfig: api.config as CoreConfig,
            fullConfig: api.config,
            agentRuntime: api.runtime.agent,
            ttsRuntime: api.runtime.tts,
            logger: api.logger,
          });
          runtimeState[VOICE_CALL_RUNTIME_PROMISE_KEY] = runtimePromise;
        }

        try {
          const createdRuntime = await runtimePromise;
          if (runtimeState[VOICE_CALL_RUNTIME_STOP_PROMISE_KEY]) {
            continue;
          }
          if (runtimeState[VOICE_CALL_RUNTIME_PROMISE_KEY] !== runtimePromise) {
            continue;
          }
          runtimeState[VOICE_CALL_RUNTIME_KEY] = createdRuntime;
          return createdRuntime;
        } catch (err) {
          if (runtimeState[VOICE_CALL_RUNTIME_PROMISE_KEY] === runtimePromise) {
            // Reset shared state so the next call can retry instead of caching
            // a rejected promise across plugin contexts. See: #32387, #58115.
            runtimeState[VOICE_CALL_RUNTIME_PROMISE_KEY] = null;
            runtimeState[VOICE_CALL_RUNTIME_KEY] = null;
          }
          throw err;
        }
      }
    };

    const sendError = (respond: (ok: boolean, payload?: unknown) => void, err: unknown) => {
      respond(false, { error: formatErrorMessage(err) });
    };

    const resolveCallMessageRequest = async (params: GatewayRequestHandlerOptions["params"]) => {
      const callId = normalizeOptionalString(params?.callId) ?? "";
      const message = normalizeOptionalString(params?.message) ?? "";
      if (!callId || !message) {
        return { error: "callId and message required" } as const;
      }
      const rt = await ensureRuntime();
      return { rt, callId, message } as const;
    };
    const initiateCallAndRespond = async (params: {
      rt: VoiceCallRuntime;
      respond: GatewayRequestHandlerOptions["respond"];
      to: string;
      message?: string;
      mode?: "notify" | "conversation";
    }) => {
      const result = await params.rt.manager.initiateCall(params.to, undefined, {
        message: params.message,
        mode: params.mode,
      });
      if (!result.success) {
        params.respond(false, { error: result.error || "initiate failed" });
        return;
      }
      params.respond(true, { callId: result.callId, initiated: true });
    };

    const respondToCallMessageAction = async (params: {
      requestParams: GatewayRequestHandlerOptions["params"];
      respond: GatewayRequestHandlerOptions["respond"];
      action: (
        request: Exclude<Awaited<ReturnType<typeof resolveCallMessageRequest>>, { error: string }>,
      ) => Promise<{
        success: boolean;
        error?: string;
        transcript?: string;
      }>;
      failure: string;
      includeTranscript?: boolean;
    }) => {
      const request = await resolveCallMessageRequest(params.requestParams);
      if ("error" in request) {
        params.respond(false, { error: request.error });
        return;
      }
      const result = await params.action(request);
      if (!result.success) {
        params.respond(false, { error: result.error || params.failure });
        return;
      }
      params.respond(
        true,
        params.includeTranscript
          ? { success: true, transcript: result.transcript }
          : { success: true },
      );
    };

    api.registerGatewayMethod(
      "voicecall.initiate",
      async ({ params, respond }: GatewayRequestHandlerOptions) => {
        try {
          const message = normalizeOptionalString(params?.message) ?? "";
          if (!message) {
            respond(false, { error: "message required" });
            return;
          }
          const rt = await ensureRuntime();
          const to = normalizeOptionalString(params?.to) ?? rt.config.toNumber;
          if (!to) {
            respond(false, { error: "to required" });
            return;
          }
          const mode =
            params?.mode === "notify" || params?.mode === "conversation" ? params.mode : undefined;
          await initiateCallAndRespond({
            rt,
            respond,
            to,
            message,
            mode,
          });
        } catch (err) {
          sendError(respond, err);
        }
      },
    );

    api.registerGatewayMethod(
      "voicecall.continue",
      async ({ params, respond }: GatewayRequestHandlerOptions) => {
        try {
          await respondToCallMessageAction({
            requestParams: params,
            respond,
            action: (request) => request.rt.manager.continueCall(request.callId, request.message),
            failure: "continue failed",
            includeTranscript: true,
          });
        } catch (err) {
          sendError(respond, err);
        }
      },
    );

    api.registerGatewayMethod(
      "voicecall.speak",
      async ({ params, respond }: GatewayRequestHandlerOptions) => {
        try {
          await respondToCallMessageAction({
            requestParams: params,
            respond,
            action: (request) => request.rt.manager.speak(request.callId, request.message),
            failure: "speak failed",
          });
        } catch (err) {
          sendError(respond, err);
        }
      },
    );

    api.registerGatewayMethod(
      "voicecall.dtmf",
      async ({ params, respond }: GatewayRequestHandlerOptions) => {
        try {
          const callId = normalizeOptionalString(params?.callId) ?? "";
          const digits = normalizeOptionalString(params?.digits) ?? "";
          if (!callId || !digits) {
            respond(false, { error: "callId and digits required" });
            return;
          }
          const rt = await ensureRuntime();
          const result = await rt.manager.sendDtmf(callId, digits);
          if (!result.success) {
            respond(false, { error: result.error || "dtmf failed" });
            return;
          }
          respond(true, { success: true });
        } catch (err) {
          sendError(respond, err);
        }
      },
    );

    api.registerGatewayMethod(
      "voicecall.end",
      async ({ params, respond }: GatewayRequestHandlerOptions) => {
        try {
          const callId = normalizeOptionalString(params?.callId) ?? "";
          if (!callId) {
            respond(false, { error: "callId required" });
            return;
          }
          const rt = await ensureRuntime();
          const result = await rt.manager.endCall(callId);
          if (!result.success) {
            respond(false, { error: result.error || "end failed" });
            return;
          }
          respond(true, { success: true });
        } catch (err) {
          sendError(respond, err);
        }
      },
    );

    api.registerGatewayMethod(
      "voicecall.status",
      async ({ params, respond }: GatewayRequestHandlerOptions) => {
        try {
          const raw =
            normalizeOptionalString(params?.callId) ?? normalizeOptionalString(params?.sid) ?? "";
          if (!raw) {
            respond(false, { error: "callId required" });
            return;
          }
          const rt = await ensureRuntime();
          const call = rt.manager.getCall(raw) || rt.manager.getCallByProviderCallId(raw);
          if (!call) {
            respond(true, { found: false });
            return;
          }
          respond(true, { found: true, call });
        } catch (err) {
          sendError(respond, err);
        }
      },
    );

    api.registerGatewayMethod(
      "voicecall.start",
      async ({ params, respond }: GatewayRequestHandlerOptions) => {
        try {
          const to = normalizeOptionalString(params?.to) ?? "";
          const message = normalizeOptionalString(params?.message) ?? "";
          if (!to) {
            respond(false, { error: "to required" });
            return;
          }
          const rt = await ensureRuntime();
          await initiateCallAndRespond({
            rt,
            respond,
            to,
            message: message || undefined,
          });
        } catch (err) {
          sendError(respond, err);
        }
      },
    );

    api.registerTool({
      name: "voice_call",
      label: "Voice Call",
      description: "Make phone calls and have voice conversations via the voice-call plugin.",
      parameters: VoiceCallToolSchema,
      async execute(_toolCallId, params) {
        const rawParams = asParamRecord(params);
        const json = (payload: unknown) => ({
          content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
          details: payload,
        });

        try {
          const rt = await ensureRuntime();

          if (typeof rawParams.action === "string") {
            switch (rawParams.action) {
              case "initiate_call": {
                const message = normalizeOptionalString(rawParams.message) ?? "";
                if (!message) {
                  throw new Error("message required");
                }
                const to = normalizeOptionalString(rawParams.to) ?? rt.config.toNumber;
                if (!to) {
                  throw new Error("to required");
                }
                const result = await rt.manager.initiateCall(to, undefined, {
                  message,
                  mode:
                    rawParams.mode === "notify" || rawParams.mode === "conversation"
                      ? rawParams.mode
                      : undefined,
                });
                if (!result.success) {
                  throw new Error(result.error || "initiate failed");
                }
                return json({ callId: result.callId, initiated: true });
              }
              case "continue_call": {
                const callId = normalizeOptionalString(rawParams.callId) ?? "";
                const message = normalizeOptionalString(rawParams.message) ?? "";
                if (!callId || !message) {
                  throw new Error("callId and message required");
                }
                const result = await rt.manager.continueCall(callId, message);
                if (!result.success) {
                  throw new Error(result.error || "continue failed");
                }
                return json({ success: true, transcript: result.transcript });
              }
              case "speak_to_user": {
                const callId = normalizeOptionalString(rawParams.callId) ?? "";
                const message = normalizeOptionalString(rawParams.message) ?? "";
                if (!callId || !message) {
                  throw new Error("callId and message required");
                }
                const result = await rt.manager.speak(callId, message);
                if (!result.success) {
                  throw new Error(result.error || "speak failed");
                }
                return json({ success: true });
              }
              case "send_dtmf": {
                const callId = normalizeOptionalString(rawParams.callId) ?? "";
                const digits = normalizeOptionalString(rawParams.digits) ?? "";
                if (!callId || !digits) {
                  throw new Error("callId and digits required");
                }
                const result = await rt.manager.sendDtmf(callId, digits);
                if (!result.success) {
                  throw new Error(result.error || "dtmf failed");
                }
                return json({ success: true });
              }
              case "end_call": {
                const callId = normalizeOptionalString(rawParams.callId) ?? "";
                if (!callId) {
                  throw new Error("callId required");
                }
                const result = await rt.manager.endCall(callId);
                if (!result.success) {
                  throw new Error(result.error || "end failed");
                }
                return json({ success: true });
              }
              case "get_status": {
                const callId = normalizeOptionalString(rawParams.callId) ?? "";
                if (!callId) {
                  throw new Error("callId required");
                }
                const call =
                  rt.manager.getCall(callId) || rt.manager.getCallByProviderCallId(callId);
                return json(call ? { found: true, call } : { found: false });
              }
            }
          }

          const mode = rawParams.mode ?? "call";
          if (mode === "status") {
            const sid = normalizeOptionalString(rawParams.sid) ?? "";
            if (!sid) {
              throw new Error("sid required for status");
            }
            const call = rt.manager.getCall(sid) || rt.manager.getCallByProviderCallId(sid);
            return json(call ? { found: true, call } : { found: false });
          }

          const to = normalizeOptionalString(rawParams.to) ?? rt.config.toNumber;
          if (!to) {
            throw new Error("to required for call");
          }
          const result = await rt.manager.initiateCall(to, undefined, {
            message: normalizeOptionalString(rawParams.message),
          });
          if (!result.success) {
            throw new Error(result.error || "initiate failed");
          }
          return json({ callId: result.callId, initiated: true });
        } catch (err) {
          return json({
            error: formatErrorMessage(err),
          });
        }
      },
    });

    api.registerCli(
      ({ program }) =>
        registerVoiceCallCli({
          program,
          config,
          ensureRuntime,
          logger: api.logger,
        }),
      { commands: ["voicecall"] },
    );

    api.registerService({
      id: "voicecall",
      start: async () => {
        if (!config.enabled) {
          return;
        }
        if (!validation.valid) {
          api.logger.warn(
            `[voice-call] Runtime not started; setup incomplete: ${validation.errors.join("; ")}`,
          );
          return;
        }
        try {
          await ensureRuntime();
        } catch (err) {
          api.logger.error(`[voice-call] Failed to start runtime: ${formatErrorMessage(err)}`);
        }
      },
      stop: async () => {
        if (runtimeState[VOICE_CALL_RUNTIME_STOP_PROMISE_KEY]) {
          await runtimeState[VOICE_CALL_RUNTIME_STOP_PROMISE_KEY];
          return;
        }
        const runtime = runtimeState[VOICE_CALL_RUNTIME_KEY];
        const runtimePromise = runtimeState[VOICE_CALL_RUNTIME_PROMISE_KEY];
        if (!runtime && !runtimePromise) {
          return;
        }
        runtimeState[VOICE_CALL_RUNTIME_KEY] = null;
        runtimeState[VOICE_CALL_RUNTIME_PROMISE_KEY] = null;
        const stopPromise = (async () => {
          const rt = runtime ?? (await runtimePromise!);
          await rt.stop();
        })();
        runtimeState[VOICE_CALL_RUNTIME_STOP_PROMISE_KEY] = stopPromise;
        try {
          await stopPromise;
        } finally {
          if (runtimeState[VOICE_CALL_RUNTIME_STOP_PROMISE_KEY] === stopPromise) {
            runtimeState[VOICE_CALL_RUNTIME_STOP_PROMISE_KEY] = null;
          }
        }
      },
    });
  },
});
