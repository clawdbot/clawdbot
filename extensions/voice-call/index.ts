// Voice Call plugin entrypoint registers its OpenClaw integration.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { ErrorCodes, errorShape } from "openclaw/plugin-sdk/gateway-runtime";
import { resolveGlobalSingleton } from "openclaw/plugin-sdk/global-singleton";
import { normalizeAgentId, parseAgentSessionKey } from "openclaw/plugin-sdk/routing";
import {
  asNonArrayRecord as asParamRecord,
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

function isCliOnlyProcess(): boolean {
  return process.env.OPENCLAW_CLI === "1" && !process.argv.slice(2).includes("gateway");
}

const VOICE_CALL_RUNTIME_COORDINATOR_KEY = Symbol.for("openclaw.voice-call.runtimeCoordinator");

type VoiceCallRuntimeGeneration = {
  retired: boolean;
  serviceHealth?: Parameters<
    Parameters<OpenClawPluginApi["registerService"]>[0]["start"]
  >[0]["serviceHealth"];
};

type VoiceCallRuntimeRegistration = {
  epoch: number;
  generation: VoiceCallRuntimeGeneration;
};

type VoiceCallRuntimeSlot =
  | {
      state: "starting";
      owner: VoiceCallRuntimeGeneration;
      promise: Promise<VoiceCallRuntime>;
    }
  | {
      state: "running";
      owner: VoiceCallRuntimeGeneration;
      runtime: VoiceCallRuntime;
    }
  | {
      state: "stopping";
      owner: VoiceCallRuntimeGeneration;
      promise: Promise<void>;
    };

type VoiceCallRuntimeCoordinator = {
  current?: VoiceCallRuntimeRegistration;
  epochCounter: number;
  slot?: VoiceCallRuntimeSlot;
};

class VoiceCallRuntimeLifecycleError extends Error {}

function getVoiceCallRuntimeCoordinator(): VoiceCallRuntimeCoordinator {
  return resolveGlobalSingleton(VOICE_CALL_RUNTIME_COORDINATOR_KEY, () => ({
    epochCounter: 0,
  }));
}

function activateVoiceCallRuntimeGeneration(
  coordinator: VoiceCallRuntimeCoordinator,
  registration: VoiceCallRuntimeRegistration,
  generation: VoiceCallRuntimeGeneration,
): void {
  if (
    registration.epoch < (coordinator.current?.epoch ?? 0) ||
    registration.generation !== generation
  ) {
    throw new VoiceCallRuntimeLifecycleError(
      "Voice call runtime generation was superseded; use the current plugin registration",
    );
  }
  if (generation.retired) {
    throw new VoiceCallRuntimeLifecycleError(
      "Voice call runtime generation is retired; use the current plugin registration",
    );
  }
  if (coordinator.current !== registration) {
    if (coordinator.current) {
      coordinator.current.generation.retired = true;
    }
    coordinator.current = registration;
  }
}

function stopVoiceCallRuntimeGeneration(
  coordinator: VoiceCallRuntimeCoordinator,
  generation: VoiceCallRuntimeGeneration,
): Promise<void> {
  const ownedSlot = coordinator.slot?.owner === generation ? coordinator.slot : undefined;
  if (!ownedSlot || ownedSlot.state === "stopping") {
    return ownedSlot?.promise ?? Promise.resolve();
  }
  const stopPromise = Promise.resolve().then(async () => {
    const runtime = ownedSlot.state === "running" ? ownedSlot.runtime : await ownedSlot.promise;
    await runtime.stop();
  });
  const stoppingSlot = { state: "stopping" as const, owner: generation, promise: stopPromise };
  if (coordinator.slot === ownedSlot) {
    coordinator.slot = stoppingSlot;
  }
  return stopPromise.finally(() => {
    if (coordinator.slot === stoppingSlot) {
      coordinator.slot = undefined;
    }
  });
}

export default definePluginEntry({
  id: "voice-call",
  name: "Voice Call",
  description: "Voice-call plugin with Asterisk/Plivo/Telnyx/Twilio providers",
  configSchema: voiceCallConfigSchema,
  register(api: OpenClawPluginApi) {
    const config = resolveVoiceCallConfig(voiceCallConfigSchema.parse(api.pluginConfig));
    const validation = validateProviderConfig(config);

    const runtimeCoordinator = getVoiceCallRuntimeCoordinator();
    const runtimeRegistration: VoiceCallRuntimeRegistration =
      api.registrationMode !== "full" && runtimeCoordinator.current
        ? runtimeCoordinator.current
        : {
            epoch: ++runtimeCoordinator.epochCounter,
            generation: { retired: false },
          };
    const continueOperationStore = createVoiceCallContinueOperationStore({
      config,
      coreConfig: api.config as OpenClawConfig,
    });
    const activateRuntimeGeneration = (generation: VoiceCallRuntimeGeneration) =>
      activateVoiceCallRuntimeGeneration(runtimeCoordinator, runtimeRegistration, generation);

    const ensureRuntimeForGeneration = async (
      runtimeGeneration: VoiceCallRuntimeGeneration,
    ): Promise<VoiceCallRuntime> => {
      activateRuntimeGeneration(runtimeGeneration);
      if (!config.enabled) {
        throw new Error("Voice call disabled in plugin config");
      }
      if (!validation.valid) {
        throw new Error(validation.errors.join("; "));
      }

      while (true) {
        activateRuntimeGeneration(runtimeGeneration);
        const slot = runtimeCoordinator.slot;
        if (slot) {
          if (slot.owner !== runtimeGeneration) {
            if (slot.owner.retired) {
              await stopVoiceCallRuntimeGeneration(runtimeCoordinator, slot.owner);
              continue;
            }
            throw new VoiceCallRuntimeLifecycleError(
              "A previous voice call runtime generation is still active; retry after it stops",
            );
          }

          if (slot.state === "running") {
            return slot.runtime;
          }
          if (slot.state === "stopping") {
            await slot.promise;
            continue;
          }

          let createdRuntime: VoiceCallRuntime;
          try {
            createdRuntime = await slot.promise;
          } catch (err) {
            if (runtimeCoordinator.slot === slot) {
              runtimeCoordinator.slot = undefined;
            }
            throw err;
          }
          activateRuntimeGeneration(runtimeGeneration);
          if (runtimeCoordinator.slot !== slot) {
            continue;
          }
          runtimeCoordinator.slot = {
            state: "running",
            owner: runtimeGeneration,
            runtime: createdRuntime,
          };
          return createdRuntime;
        }

        const runtimePromise = createVoiceCallRuntime({
          config,
          coreConfig: api.config as OpenClawConfig,
          fullConfig: api.config,
          agentRuntime: api.runtime.agent,
          stateRuntime: api.runtime.state,
          ttsRuntime: api.runtime.tts,
          logger: api.logger,
        });
        const startingSlot: VoiceCallRuntimeSlot = {
          state: "starting",
          owner: runtimeGeneration,
          promise: runtimePromise,
        };
        runtimeCoordinator.slot = startingSlot;
      }
    };
    const ensureRuntime = async (
      runtimeGeneration = runtimeRegistration.generation,
    ): Promise<VoiceCallRuntime> => {
      try {
        const runtime = await ensureRuntimeForGeneration(runtimeGeneration);
        runtimeGeneration.serviceHealth?.clearFailure();
        return runtime;
      } catch (err) {
        if (!(err instanceof VoiceCallRuntimeLifecycleError)) {
          runtimeGeneration.serviceHealth?.reportFailure(err);
        }
        throw err;
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
      start: (ctx) => {
        if (isCliOnlyProcess()) {
          return;
        }
        try {
          if (runtimeRegistration.generation.retired) {
            if (runtimeCoordinator.current !== runtimeRegistration) {
              throw new VoiceCallRuntimeLifecycleError(
                "Voice call runtime generation was superseded; use the current plugin registration",
              );
            }
            runtimeRegistration.generation = { retired: false };
          }
          runtimeRegistration.generation.serviceHealth = ctx.serviceHealth;
          activateRuntimeGeneration(runtimeRegistration.generation);
        } catch (err) {
          ctx.serviceHealth?.reportFailure(err);
          api.logger.error(`[voice-call] Failed to start runtime: ${formatErrorMessage(err)}`);
          return;
        }
        if (!config.enabled) {
          return;
        }
        if (!validation.valid) {
          const error = new Error(`setup incomplete: ${validation.errors.join("; ")}`);
          ctx.serviceHealth?.reportFailure(error);
          api.logger.error(`[voice-call] Runtime not started: ${error.message}`);
          return;
        }
        const startingGeneration = runtimeRegistration.generation;
        void ensureRuntime(startingGeneration).catch((err: unknown) => {
          if (err instanceof VoiceCallRuntimeLifecycleError) {
            return;
          }
          ctx.serviceHealth?.reportFailure(err);
          api.logger.error(`[voice-call] Failed to start runtime: ${formatErrorMessage(err)}`);
        });
      },
      stop: async () => {
        const runtimeGeneration = runtimeRegistration.generation;
        runtimeGeneration.retired = true;
        try {
          await stopVoiceCallRuntimeGeneration(runtimeCoordinator, runtimeGeneration);
        } finally {
          runtimeGeneration.serviceHealth = undefined;
        }
      },
    });
  },
});
