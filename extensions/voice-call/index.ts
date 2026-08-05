// Voice Call plugin entrypoint registers its OpenClaw integration.
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { ErrorCodes, errorShape } from "openclaw/plugin-sdk/gateway-runtime";
import { normalizeAgentId, parseAgentSessionKey } from "openclaw/plugin-sdk/routing";
import {
  asOptionalRecord,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { jsonResult as json } from "openclaw/plugin-sdk/tool-results";
import { Type } from "typebox";
import {
  definePluginEntry,
  type GatewayRequestHandlerOptions,
  type OpenClawPluginApi,
} from "./api.js";
import { VOICE_CALL_CLI_DESCRIPTOR } from "./cli-output-mode.js";
import { createVoiceCallRuntime, type VoiceCallRuntime } from "./runtime-entry.js";
import { registerVoiceCallCli } from "./src/cli.js";
import {
  createVoiceCallCommandService,
  VoiceCallCommandInputError,
} from "./src/command-service.js";
import {
  VoiceCallConfigSchema,
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
    const config = asOptionalRecord(value) ?? {};
    const enabled = typeof config.enabled === "boolean" ? config.enabled : true;
    return VoiceCallConfigSchema.parse({
      ...config,
      enabled,
      provider: config.provider ?? (enabled ? "mock" : undefined),
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
    "twilio.region": { label: "Twilio Region", advanced: true },
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
    "streaming.enabled": {
      label: "Enable Streaming",
      help: "Classic streaming transcription currently requires the Twilio call provider.",
      advanced: true,
    },
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
      help: "Injects a compact agent identity and workspace context capsule into realtime voice instructions.",
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
      help: "Deep-merges with tts (Microsoft is ignored for calls).",
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
            stateRuntime: api.runtime.state,
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

    const commands = createVoiceCallCommandService(ensureRuntime);
    const registerGatewayCommand = (
      method: string,
      handler: (options: GatewayRequestHandlerOptions) => unknown,
      scope: typeof VOICE_CALL_WRITE_METHOD_SCOPE | typeof VOICE_CALL_READ_METHOD_SCOPE,
    ) => {
      api.registerGatewayMethod(
        method,
        async (options: GatewayRequestHandlerOptions) => {
          try {
            options.respond(true, await handler(options));
          } catch (err) {
            const code =
              err instanceof VoiceCallCommandInputError
                ? ErrorCodes.INVALID_REQUEST
                : ErrorCodes.UNAVAILABLE;
            options.respond(false, undefined, errorShape(code, formatErrorMessage(err)));
          }
        },
        scope,
      );
    };

    registerGatewayCommand(
      "voicecall.initiate",
      async ({ params }) => {
        const message = normalizeOptionalString(params?.message);
        if (!message) {
          throw new VoiceCallCommandInputError("message required");
        }
        return await commands.initiate({
          to: normalizeOptionalString(params?.to),
          message,
          mode:
            params?.mode === "notify" || params?.mode === "conversation" ? params.mode : undefined,
          sessionKey: normalizeOptionalString(params?.sessionKey),
          requesterSessionKey: normalizeOptionalString(params?.requesterSessionKey),
        });
      },
      VOICE_CALL_WRITE_METHOD_SCOPE,
    );

    registerGatewayCommand(
      "voicecall.continue",
      ({ params }) =>
        commands.continueCall(
          normalizeOptionalString(params?.callId),
          normalizeOptionalString(params?.message),
        ),
      VOICE_CALL_WRITE_METHOD_SCOPE,
    );

    registerGatewayCommand(
      "voicecall.continue.start",
      async ({ params }) =>
        continueOperationStore.start(
          await commands.prepareContinue(
            normalizeOptionalString(params?.callId),
            normalizeOptionalString(params?.message),
          ),
        ),
      VOICE_CALL_WRITE_METHOD_SCOPE,
    );

    registerGatewayCommand(
      "voicecall.continue.result",
      ({ params }) => {
        const operationId = normalizeOptionalString(params?.operationId);
        if (!operationId) {
          throw new VoiceCallCommandInputError("operationId required");
        }
        const operation = continueOperationStore.read(operationId);
        if (!operation.ok) {
          throw new VoiceCallCommandInputError(operation.error);
        }
        return operation.payload;
      },
      VOICE_CALL_READ_METHOD_SCOPE,
    );

    registerGatewayCommand(
      "voicecall.speak",
      ({ params }) =>
        commands.speak({
          callId: normalizeOptionalString(params?.callId),
          message: normalizeOptionalString(params?.message),
          allowTwimlFallback: params?.allowTwimlFallback !== false,
        }),
      VOICE_CALL_WRITE_METHOD_SCOPE,
    );

    registerGatewayCommand(
      "voicecall.dtmf",
      ({ params }) =>
        commands.sendDtmf(
          normalizeOptionalString(params?.callId),
          normalizeOptionalString(params?.digits),
        ),
      VOICE_CALL_WRITE_METHOD_SCOPE,
    );

    registerGatewayCommand(
      "voicecall.end",
      ({ params }) => commands.endCall(normalizeOptionalString(params?.callId)),
      VOICE_CALL_WRITE_METHOD_SCOPE,
    );

    registerGatewayCommand(
      "voicecall.status",
      ({ params }) =>
        commands.status(
          normalizeOptionalString(params?.callId) ?? normalizeOptionalString(params?.sid),
        ),
      VOICE_CALL_READ_METHOD_SCOPE,
    );

    registerGatewayCommand(
      "voicecall.start",
      async ({ params, client }) => {
        const to = normalizeOptionalString(params?.to);
        const requestedAgentId = normalizeOptionalString(params?.agentId);
        const normalizedAgentId = requestedAgentId ? normalizeAgentId(requestedAgentId) : undefined;
        const pluginOwnerId = normalizeOptionalString(client?.internal?.pluginRuntimeOwnerId);
        if (
          requestedAgentId &&
          (!pluginOwnerId || normalizedAgentId !== requestedAgentId.toLowerCase())
        ) {
          throw new VoiceCallCommandInputError(
            "agentId requires a trusted plugin caller and a valid agent id",
          );
        }
        if (!to) {
          throw new VoiceCallCommandInputError("to required");
        }
        return await commands.initiate({
          to,
          message: normalizeOptionalString(params?.message),
          mode:
            params?.mode === "notify" || params?.mode === "conversation" ? params.mode : undefined,
          dtmfSequence: normalizeOptionalString(params?.dtmfSequence),
          sessionKey: normalizeOptionalString(params?.sessionKey),
          requesterSessionKey: normalizeOptionalString(params?.requesterSessionKey),
          agentId: normalizedAgentId,
        });
      },
      VOICE_CALL_WRITE_METHOD_SCOPE,
    );

    api.registerTool((toolContext) => ({
      name: "voice_call",
      label: "Voice Call",
      description: "Make phone calls and have voice conversations via the voice-call plugin.",
      parameters: VoiceCallToolSchema,
      async execute(_toolCallId, params) {
        const rawParams = asParamRecord(params);
        const requesterSessionKey = normalizeOptionalString(toolContext.sessionKey);
        // Agent ownership and requester lineage come from trusted tool context.
        // Some harnesses omit agentId but retain its canonical session key.
        const contextAgentId =
          normalizeOptionalString(toolContext.agentId) ??
          parseAgentSessionKey(requesterSessionKey)?.agentId;
        const agentId = contextAgentId ? normalizeAgentId(contextAgentId) : undefined;
        try {
          // Preserve tool error precedence: runtime availability is checked before model input.
          await ensureRuntime();
          if (typeof rawParams.action === "string") {
            switch (rawParams.action) {
              case "initiate_call": {
                const message = normalizeOptionalString(rawParams.message);
                if (!message) {
                  throw new VoiceCallCommandInputError("message required");
                }
                return json(
                  await commands.initiate({
                    to: normalizeOptionalString(rawParams.to),
                    message,
                    dtmfSequence: normalizeOptionalString(rawParams.dtmfSequence),
                    mode:
                      rawParams.mode === "notify" || rawParams.mode === "conversation"
                        ? rawParams.mode
                        : undefined,
                    sessionKey: normalizeOptionalString(rawParams.sessionKey),
                    agentId,
                    requesterSessionKey,
                  }),
                );
              }
              case "continue_call":
                return json(
                  await commands.continueCall(
                    normalizeOptionalString(rawParams.callId),
                    normalizeOptionalString(rawParams.message),
                  ),
                );
              case "speak_to_user":
                return json(
                  await commands.speak({
                    callId: normalizeOptionalString(rawParams.callId),
                    message: normalizeOptionalString(rawParams.message),
                  }),
                );
              case "send_dtmf":
                return json(
                  await commands.sendDtmf(
                    normalizeOptionalString(rawParams.callId),
                    normalizeOptionalString(rawParams.digits),
                  ),
                );
              case "end_call":
                return json(await commands.endCall(normalizeOptionalString(rawParams.callId)));
              case "get_status": {
                const callId = normalizeOptionalString(rawParams.callId);
                if (!callId) {
                  throw new VoiceCallCommandInputError("callId required");
                }
                return json(await commands.status(callId));
              }
            }
          }

          const mode = rawParams.mode ?? "call";
          if (mode === "status") {
            const sid = normalizeOptionalString(rawParams.sid) ?? "";
            if (!sid) {
              throw new Error("sid required for status");
            }
            return json(await commands.status(sid));
          }

          return json(
            await commands.initiate(
              {
                to: normalizeOptionalString(rawParams.to),
                dtmfSequence: normalizeOptionalString(rawParams.dtmfSequence),
                message: normalizeOptionalString(rawParams.message),
                sessionKey: normalizeOptionalString(rawParams.sessionKey),
                agentId,
                requesterSessionKey,
              },
              "to required for call",
            ),
          );
        } catch (err) {
          return json({
            error: formatErrorMessage(err),
          });
        }
      },
    }));

    api.registerCli(
      ({ program }) =>
        registerVoiceCallCli({
          program,
          config,
          ensureRuntime,
          stateRuntime: api.runtime.state,
          logger: api.logger,
        }),
      { commands: ["voicecall"], descriptors: [VOICE_CALL_CLI_DESCRIPTOR] },
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
        void ensureRuntime().catch((err: unknown) => {
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
