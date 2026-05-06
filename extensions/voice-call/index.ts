import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { ErrorCodes, errorShape } from "openclaw/plugin-sdk/gateway-runtime";
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
import { createVoiceCallContinueOperationStore } from "./src/gateway-continue-operation.js";

const VOICE_CALL_WRITE_METHOD_SCOPE = { scope: "operator.write" as const };
const VOICE_CALL_READ_METHOD_SCOPE = { scope: "operator.read" as const };

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
    numbers: {
      label: "Per-number Routing",
      help: "Inbound overrides keyed by dialed E.164 number.",
      advanced: true,
    },
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
    "realtime.consultPolicy": {
      label: "Realtime Consult Policy",
      help: "Guides when the realtime voice model should call openclaw_agent_consult.",
      advanced: true,
    },
    "realtime.fastContext.enabled": {
      label: "Enable Fast Realtime Context",
      help: "Searches memory/session context before the full consult agent.",
      advanced: true,
    },
    "realtime.fastContext.timeoutMs": {
      label: "Fast Context Timeout",
      advanced: true,
    },
    "realtime.fastContext.maxResults": {
      label: "Fast Context Result Limit",
      advanced: true,
    },
    "realtime.fastContext.sources": {
      label: "Fast Context Sources",
      advanced: true,
    },
    "realtime.fastContext.fallbackToConsult": {
      label: "Fallback To Full Consult",
      advanced: true,
    },
    "realtime.agentContext.enabled": {
      label: "Enable Agent Voice Context",
      help: "Injects a compact agent identity, system prompt, and workspace context capsule into realtime voice instructions.",
      advanced: true,
    },
    "realtime.agentContext.maxChars": {
      label: "Agent Voice Context Limit",
      advanced: true,
    },
    "realtime.agentContext.includeIdentity": {
      label: "Include Agent Identity",
      advanced: true,
    },
    "realtime.agentContext.includeSystemPrompt": {
      label: "Include Agent System Prompt",
      advanced: true,
    },
    "realtime.agentContext.includeWorkspaceFiles": {
      label: "Include Agent Workspace Files",
      advanced: true,
    },
    "realtime.agentContext.files": {
      label: "Agent Voice Context Files",
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
    sessionKey: Type.Optional(Type.String({ description: "OpenClaw session key for the call" })),
    requesterSessionKey: Type.Optional(
      Type.String({ description: "OpenClaw session key that initiated the call" }),
    ),
    dtmfSequence: Type.Optional(Type.String({ description: "DTMF digits to play before connect" })),
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
    sessionKey: Type.Optional(Type.String({ description: "OpenClaw session key for the call" })),
    requesterSessionKey: Type.Optional(
      Type.String({ description: "OpenClaw session key that initiated the call" }),
    ),
    dtmfSequence: Type.Optional(Type.String({ description: "DTMF digits to play before connect" })),
  }),
]);

function asParamRecord(params: unknown): Record<string, unknown> {
  return params && typeof params === "object" && !Array.isArray(params)
    ? (params as Record<string, unknown>)
    : {};
}

function isCliOnlyProcess(): boolean {
  return process.env.OPENCLAW_CLI === "1" && !process.argv.slice(2).includes("gateway");
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
    const continueOperationStore = createVoiceCallContinueOperationStore({
      config,
      coreConfig: api.config as CoreConfig,
    });

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

    const respondError = (
      respond: GatewayRequestHandlerOptions["respond"],
      message: string,
      code: (typeof ErrorCodes)[keyof typeof ErrorCodes] = ErrorCodes.UNAVAILABLE,
    ) => {
      respond(false, undefined, errorShape(code, message));
    };

    const sendError = (respond: GatewayRequestHandlerOptions["respond"], err: unknown) => {
      respondError(respond, formatErrorMessage(err));
    };

    const describeHistoricalCall = async (rt: VoiceCallRuntime, callId: string) => {
      const history = await rt.manager.getCallHistory(100);
      const call = history
        .toReversed()
        .find((candidate) => candidate.callId === callId || candidate.providerCallId === callId);
      if (!call) {
        return undefined;
      }
      const details = [
        `last state=${call.state}`,
        call.endReason ? `endReason=${call.endReason}` : undefined,
        call.endedAt ? `endedAt=${new Date(call.endedAt).toISOString()}` : undefined,
      ].filter(Boolean);
      return `call is not active (${details.join(", ")})`;
    };

    const resolveCallMessageRequest = async (params: GatewayRequestHandlerOptions["params"]) => {
      const callId = normalizeOptionalString(params?.callId) ?? "";
      const message = normalizeOptionalString(params?.message) ?? "";
      if (!callId || !message) {
        return { error: "callId and message required" } as const;
      }
      const rt = await ensureRuntime();
      const activeCall = rt.manager.getCall(callId) ?? rt.manager.getCallByProviderCallId(callId);
      if (activeCall) {
        return { rt, callId: activeCall.callId, message } as const;
      }
      return { error: (await describeHistoricalCall(rt, callId)) ?? "Call not found" } as const;
    };

    const initiateCallAndRespond = async (params: {
      rt: VoiceCallRuntime;
      respond: GatewayRequestHandlerOptions["respond"];
      to: string;
      message?: string;
      mode?: "notify" | "conversation";
      dtmfSequence?: string;
      sessionKey?: string;
      requesterSessionKey?: string;
    }) => {
      const result = await params.rt.manager.initiateCall(params.to, params.sessionKey, {
        message: params.message,
        mode: params.mode,
        dtmfSequence: params.dtmfSequence,
        ...(params.requesterSessionKey ? { requesterSessionKey: params.requesterSessionKey } : {}),
      });
      if (!result.success) {
        respondError(params.respond, result.error || "initiate failed");
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
        respondError(
          params.respond,
          request.error ?? "callId and message required",
          ErrorCodes.INVALID_REQUEST,
        );
        return;
      }
      const result = await params.action(request);
      if (!result.success) {
        respondError(params.respond, result.error || params.failure);
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
            respondError(respond, "message required", ErrorCodes.INVALID_REQUEST);
            return;
          }
          const rt = await ensureRuntime();
          const to = normalizeOptionalString(params?.to) ?? rt.config.toNumber;
          if (!to) {
            respondError(respond, "to required", ErrorCodes.INVALID_REQUEST);
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
            sessionKey: normalizeOptionalString(params?.sessionKey),
            requesterSessionKey: normalizeOptionalString(params?.requesterSessionKey),
          });
        } catch (err) {
          sendError(respond, err);
        }
      },
      VOICE_CALL_WRITE_METHOD_SCOPE,
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
      VOICE_CALL_WRITE_METHOD_SCOPE,
    );

    api.registerGatewayMethod(
      "voicecall.continue.start",
      async ({ params, respond }: GatewayRequestHandlerOptions) => {
        try {
          const request = await resolveCallMessageRequest(params);
          if ("error" in request) {
            respondError(
              respond,
              request.error ?? "callId and message required",
              ErrorCodes.INVALID_REQUEST,
            );
            return;
          }
          respond(true, continueOperationStore.start(request));
        } catch (err) {
          sendError(respond, err);
        }
      },
      VOICE_CALL_WRITE_METHOD_SCOPE,
    );

    api.registerGatewayMethod(
      "voicecall.continue.result",
      async ({ params, respond }: GatewayRequestHandlerOptions) => {
        try {
          const operationId = normalizeOptionalString(params?.operationId) ?? "";
          if (!operationId) {
            respondError(respond, "operationId required", ErrorCodes.INVALID_REQUEST);
            return;
          }
          const operation = continueOperationStore.read(operationId);
          if (!operation.ok) {
            respondError(respond, operation.error, ErrorCodes.INVALID_REQUEST);
            return;
          }
          respond(true, operation.payload);
        } catch (err) {
          sendError(respond, err);
        }
      },
      VOICE_CALL_READ_METHOD_SCOPE,
    );

    api.registerGatewayMethod(
      "voicecall.speak",
      async ({ params, respond }: GatewayRequestHandlerOptions) => {
        try {
          const request = await resolveCallMessageRequest(params);
          if ("error" in request) {
            respondError(
              respond,
              request.error ?? "callId and message required",
              ErrorCodes.INVALID_REQUEST,
            );
            return;
          }
          if (request.rt.config.realtime.enabled) {
            const realtimeResult = request.rt.webhookServer.speakRealtime(
              request.callId,
              request.message,
            );
            if (realtimeResult.success) {
              respond(true, { success: true });
              return;
            }
            if (params?.allowTwimlFallback === false) {
              respond(true, {
                success: false,
                error: realtimeResult.error ?? "Realtime bridge is not active",
              });
              return;
            }
          }
          const result = await request.rt.manager.speak(request.callId, request.message);
          if (!result.success) {
            respondError(respond, result.error || "speak failed");
            return;
          }
          respond(true, { success: true });
        } catch (err) {
          sendError(respond, err);
        }
      },
      VOICE_CALL_WRITE_METHOD_SCOPE,
    );

    api.registerGatewayMethod(
      "voicecall.dtmf",
      async ({ params, respond }: GatewayRequestHandlerOptions) => {
        try {
          const callId = normalizeOptionalString(params?.callId) ?? "";
          const digits = normalizeOptionalString(params?.digits) ?? "";
          if (!callId || !digits) {
            respondError(respond, "callId and digits required", ErrorCodes.INVALID_REQUEST);
            return;
          }
          const rt = await ensureRuntime();
          const result = await rt.manager.sendDtmf(callId, digits);
          if (!result.success) {
            respondError(respond, result.error || "dtmf failed");
            return;
          }
          respond(true, { success: true });
        } catch (err) {
          sendError(respond, err);
        }
      },
      VOICE_CALL_WRITE_METHOD_SCOPE,
    );

    api.registerGatewayMethod(
      "voicecall.end",
      async ({ params, respond }: GatewayRequestHandlerOptions) => {
        try {
          const callId = normalizeOptionalString(params?.callId) ?? "";
          if (!callId) {
            respondError(respond, "callId required", ErrorCodes.INVALID_REQUEST);
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
      },
      VOICE_CALL_WRITE_METHOD_SCOPE,
    );

    api.registerGatewayMethod(
      "voicecall.status",
      async ({ params, respond }: GatewayRequestHandlerOptions) => {
        try {
          const raw =
            normalizeOptionalString(params?.callId) ?? normalizeOptionalString(params?.sid) ?? "";
          const rt = await ensureRuntime();
          if (!raw) {
            respond(true, { found: true, calls: rt.manager.getActiveCalls() });
            return;
          }
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
      VOICE_CALL_READ_METHOD_SCOPE,
    );

    api.registerGatewayMethod(
      "voicecall.start",
      async ({ params, respond }: GatewayRequestHandlerOptions) => {
        try {
          const to = normalizeOptionalString(params?.to) ?? "";
          const message = normalizeOptionalString(params?.message) ?? "";
          const dtmfSequence = normalizeOptionalString(params?.dtmfSequence);
          const sessionKey = normalizeOptionalString(params?.sessionKey);
          const requesterSessionKey = normalizeOptionalString(params?.requesterSessionKey);
          if (!to) {
            respondError(respond, "to required", ErrorCodes.INVALID_REQUEST);
            return;
          }
          const mode =
            params?.mode === "notify" || params?.mode === "conversation" ? params.mode : undefined;
          const rt = await ensureRuntime();
          await initiateCallAndRespond({
            rt,
            respond,
            to,
            message: message || undefined,
            mode,
            dtmfSequence,
            sessionKey,
            ...(requesterSessionKey ? { requesterSessionKey } : {}),
          });
        } catch (err) {
          sendError(respond, err);
        }
      },
      VOICE_CALL_WRITE_METHOD_SCOPE,
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
                  dtmfSequence: normalizeOptionalString(rawParams.dtmfSequence),
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
          const result = await rt.manager.initiateCall(
            to,
            normalizeOptionalString(rawParams.sessionKey),
            {
              dtmfSequence: normalizeOptionalString(rawParams.dtmfSequence),
              message: normalizeOptionalString(rawParams.message),
              ...(normalizeOptionalString(rawParams.requesterSessionKey)
                ? { requesterSessionKey: normalizeOptionalString(rawParams.requesterSessionKey) }
                : {}),
            },
          );
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
      start: () => {
        if (isCliOnlyProcess()) {
          return;
        }
        if (!config.enabled) {
          return;
        }
        if (!validation.valid) {
          api.logger.warn(
            `[voice-call] Runtime not started; setup incomplete: ${validation.errors.join("; ")}`,
          );
          return;
        }
        void ensureRuntime().catch((err) => {
          api.logger.error(`[voice-call] Failed to start runtime: ${formatErrorMessage(err)}`);
        });
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
