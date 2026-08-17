import { randomUUID } from "node:crypto";
import { normalizeTalkSection } from "../config/talk.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createPluginRuntime } from "../plugins/runtime/index.js";
import { BoundedSerialQueue } from "../shared/bounded-serial-queue.js";
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";
import { consultRealtimeVoiceAgent } from "../talk/agent-consult-runtime.js";
import {
  REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
  parseRealtimeVoiceAgentConsultArgs,
} from "../talk/agent-consult-tool.js";
import {
  buildRealtimeVoiceAgentCancelProviderResult,
  buildRealtimeVoiceAgentControlSpeechMessage,
  controlRealtimeVoiceAgentRun,
  parseRealtimeVoiceAgentControlToolArgs,
  REALTIME_VOICE_AGENT_CONTROL_TOOL_NAME,
  shouldAutoControlRealtimeVoiceAgentText,
} from "../talk/agent-run-control.js";
import type { RealtimeVoiceAgentControlResult } from "../talk/agent-run-control.js";
import {
  authorizeClientVoiceConfirmation,
  bindAuthorizedClientVoiceConfirmation,
} from "../talk/client-voice-confirmation.js";
import { registerClientVoiceConsultRun } from "../talk/client-voice-session.js";
import type {
  RealtimeVoiceBridge,
  RealtimeVoiceGatewayControl,
  RealtimeVoiceToolCallEvent,
} from "../talk/provider-types.js";
import {
  createRealtimeVoiceSessionHarness,
  handleRealtimeVoiceHarnessBridgeEvent,
} from "../talk/realtime-session-harness.js";
import type { TalkEvent } from "../talk/talk-events.js";
import { registerChatAbortController } from "./chat-abort.js";
import type { GatewayRequestContext } from "./server-methods/shared-types.js";
import { formatError } from "./server-utils.js";
import { registerTalkConnectionCleanup } from "./talk-session-registry.js";

type GatewayControlOwner = {
  activate: (closeProvider: () => Promise<void>) => void;
  close: (options?: {
    preserveLogicalSession?: boolean;
    preserveRuns?: boolean;
    skipProvider?: boolean;
  }) => Promise<void>;
  connId: string;
  control: RealtimeVoiceGatewayControl;
  sessionKey: string;
};

const owners = new Map<string, GatewayControlOwner>();

const REALTIME_VOICE_CONTEXT_MAX_UTF8_BYTES = 8_000;
const REALTIME_CONTROL_MAX_PENDING = 8;
const loadTalkAgentExecution = createLazyRuntimeModule(async () => {
  const [embeddedAgent, admission] = await Promise.all([
    import("../agents/embedded-agent.js"),
    import("../agents/admitted-run-context.js"),
  ]);
  return {
    runEmbeddedAgent: embeddedAgent.runEmbeddedAgent,
    createOperationalRunInstanceRef: admission.createOperationalRunInstanceRef,
    prepareAgentRunAdmission: admission.prepareAgentRunAdmission,
  };
});

function createRealtimeControlQueue(): BoundedSerialQueue {
  return new BoundedSerialQueue({
    maxPendingCount: REALTIME_CONTROL_MAX_PENDING,
    maxPendingWeight: REALTIME_CONTROL_MAX_PENDING,
  });
}

function createTalkClientAgentRuntime(params: {
  config: OpenClawConfig;
  agentId: string;
  rawSourceRef?: string;
}) {
  const agentRuntime = createPluginRuntime().agent;
  const runEmbeddedAgent: typeof agentRuntime.runEmbeddedAgent = async (runParams) => {
    runParams.abortSignal?.throwIfAborted();
    const execution = await loadTalkAgentExecution();
    runParams.abortSignal?.throwIfAborted();
    const preparedRunAdmission = execution.prepareAgentRunAdmission({
      cfg: params.config,
      operationalRunInstance: execution.createOperationalRunInstanceRef(runParams.runId),
      facts: {
        runId: runParams.runId,
        agentId: runParams.sessionTarget?.agentId ?? runParams.agentId ?? params.agentId,
        ingress: {
          kind: "gateway-client",
          boundary: "talk-agent-consult",
          state: "present",
          ...(params.rawSourceRef ? { rawSourceRef: params.rawSourceRef } : {}),
        },
      },
    });
    let closed = false;
    const close = () => {
      if (!closed) {
        closed = true;
        preparedRunAdmission.close();
      }
    };
    // Abort owns authority revocation independently of core completion; the
    // post-registration check closes the prepare-to-listener race.
    runParams.abortSignal?.addEventListener("abort", close, { once: true });
    try {
      runParams.abortSignal?.throwIfAborted();
      return await execution.runEmbeddedAgent({ ...runParams, preparedRunAdmission });
    } finally {
      runParams.abortSignal?.removeEventListener("abort", close);
      close();
    }
  };
  Object.defineProperty(agentRuntime, "runEmbeddedAgent", {
    configurable: true,
    enumerable: true,
    value: runEmbeddedAgent,
  });
  return agentRuntime;
}

export function createTalkRealtimeRunControlOwner(params: {
  hasActiveRun: () => boolean;
  execute: (args: unknown) => Promise<RealtimeVoiceAgentControlResult>;
  speak: (message: string) => void;
  warn: (message: string) => void;
}) {
  const queue = createRealtimeControlQueue();
  const enqueue = (
    args: unknown,
    options: {
      ready?: Promise<void>;
      onResult?: (result: RealtimeVoiceAgentControlResult) => void | Promise<void>;
      onError?: (error: unknown) => void | Promise<void>;
    } = {},
  ): boolean => {
    const admission = queue.enqueue(async () => {
      await options.ready;
      try {
        const result = await params.execute(args);
        await options.onResult?.(result);
      } catch (error) {
        if (!options.onError) {
          throw error;
        }
        await options.onError(error);
      }
    });
    if (!admission.accepted) {
      params.warn(`realtime Talk control queue rejected work: ${admission.reason}`);
      return false;
    }
    void admission.completion.catch((error: unknown) => {
      params.warn(`realtime Talk control failed: ${formatError(error)}`);
    });
    return true;
  };
  return {
    enqueue,
    handleSpoken: (text: string, ready?: Promise<void>): boolean => {
      if (!params.hasActiveRun() || !shouldAutoControlRealtimeVoiceAgentText(text)) {
        return false;
      }
      enqueue(
        { text },
        {
          ready,
          onResult: (result) => {
            if (result.speak && !result.suppress && result.message.trim()) {
              params.speak(buildRealtimeVoiceAgentControlSpeechMessage(result.message));
            }
          },
        },
      );
      return true;
    },
    close: () => {
      queue.seal();
      return queue.flush();
    },
  };
}

export function boundTalkClientRealtimeInitialItems(
  items: readonly { role: "user" | "assistant"; text: string }[],
): Array<{ role: "user" | "assistant"; text: string }> {
  // Keep startup context below provider byte ceilings while retaining the newest
  // complete turns; truncating an individual entry would change transcript meaning.
  let remainingBytes = REALTIME_VOICE_CONTEXT_MAX_UTF8_BYTES;
  const newestFirst: Array<{ role: "user" | "assistant"; text: string }> = [];
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (!item) {
      continue;
    }
    const itemBytes = Buffer.byteLength(item.text, "utf8");
    if (itemBytes > remainingBytes) {
      break;
    }
    newestFirst.push(item);
    remainingBytes -= itemBytes;
  }
  return newestFirst.toReversed();
}

export function createTalkClientAgentConsultRunner(params: {
  config: OpenClawConfig;
  context: Pick<GatewayRequestContext, "chatAbortControllers" | "logGateway">;
  agentId: string;
  sessionKey: string;
  ownerConnId?: string;
  getVoiceSessionId: () => string | undefined;
  initialItems: Array<{ role: "user" | "assistant"; text: string }>;
  runIdPrefix?: string;
  surface?: string;
  registerRun?: (params: { runId: string }) => void;
}) {
  let agentRuntime: ReturnType<typeof createPluginRuntime>["agent"] | undefined;
  const runArgs = async (args: unknown, signal?: AbortSignal) => {
    const parsedArgs = parseRealtimeVoiceAgentConsultArgs(args);
    const voiceSessionId = params.getVoiceSessionId();
    if (!voiceSessionId) {
      throw new Error("Realtime browser voice session is not ready for agent consult");
    }
    const confirmationGrant = parsedArgs.confirmationId
      ? authorizeClientVoiceConfirmation({
          agentId: params.agentId,
          voiceSessionId,
          confirmationId: parsedArgs.confirmationId,
        })
      : undefined;
    agentRuntime ??= createTalkClientAgentRuntime({
      config: params.config,
      agentId: params.agentId,
      ...(params.ownerConnId ? { rawSourceRef: params.ownerConnId } : {}),
    });
    const talkConfig = normalizeTalkSection(params.config.talk);
    return await consultRealtimeVoiceAgent({
      cfg: params.config,
      agentRuntime,
      logger: params.context.logGateway,
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      messageProvider: "webchat",
      lane: "talk",
      runIdPrefix: params.runIdPrefix ?? "talk-realtime-consult",
      args: parsedArgs,
      transcript: params.initialItems,
      surface: params.surface ?? "a browser Talk session",
      userLabel: "User",
      questionSourceLabel: "user",
      thinkLevel: talkConfig?.consultThinkingLevel,
      fastMode: talkConfig?.consultFastMode,
      abortSignal: signal,
      onRunStarted: ({ runId, sessionId, timeoutMs }) => {
        if (params.registerRun) {
          params.registerRun({ runId });
        } else {
          registerClientVoiceConsultRun({
            agentId: params.agentId,
            sessionKey: params.sessionKey,
            voiceSessionId,
            runId,
            config: params.config,
          });
        }
        if (confirmationGrant) {
          bindAuthorizedClientVoiceConfirmation({ grant: confirmationGrant, runId });
        }
        if (!params.ownerConnId) {
          return undefined;
        }
        const registration = registerChatAbortController({
          chatAbortControllers: params.context.chatAbortControllers,
          runId,
          sessionId,
          sessionKey: params.sessionKey,
          agentId: params.agentId,
          timeoutMs,
          ownerConnId: params.ownerConnId,
          controlUiVisible: false,
          kind: "chat-send",
        });
        return { abortSignal: registration.controller.signal, cleanup: registration.cleanup };
      },
    });
  };
  return {
    runArgs,
    runPrompt: async ({ prompt, signal }: { prompt: string; signal?: AbortSignal }) =>
      await runArgs({ question: prompt }, signal),
  };
}

export function createTalkClientGatewayControlOwner(params: {
  voiceSessionId: string;
  providerId?: string;
  sessionKey: string;
  connId: string;
  context: Pick<GatewayRequestContext, "broadcastToConnIds" | "logGateway">;
  runAgentConsult: (args: unknown, signal: AbortSignal) => Promise<{ text: string }>;
  appendTranscript: (entry: {
    entryId: string;
    role: "user" | "assistant";
    text: string;
  }) => Promise<void>;
  flushTranscript: () => Promise<void>;
  closeLogicalSession: () => Promise<void>;
  controlAgentRun?: (params: {
    sessionKey: string;
    text: string;
    mode?: unknown;
  }) => Promise<RealtimeVoiceAgentControlResult>;
}): GatewayControlOwner {
  let bridge: RealtimeVoiceBridge | undefined;
  let closeProvider: (() => Promise<void>) | undefined;
  let closing: Promise<void> | undefined;
  let closed = false;
  let transcriptSequence = 0;
  const entryPrefix = `gateway-${randomUUID()}`;
  const consultQueue = createRealtimeControlQueue();
  const consultControllers = new Map<string, AbortController>();
  const warn = (message: string) => params.context.logGateway.warn(message);
  const talkPayload = () => ({ voiceSessionId: params.voiceSessionId });
  const harness = createRealtimeVoiceSessionHarness({
    talk: {
      sessionId: params.voiceSessionId,
      mode: "realtime",
      transport: "webrtc",
      brain: "agent-consult",
      provider: params.providerId,
    },
    talkPayloads: {
      turnStarted: talkPayload,
      turnEnded: (reason) => ({ ...talkPayload(), reason }),
      inputAudioDelta: (audio) => ({ ...talkPayload(), byteLength: audio.byteLength }),
      outputAudioStarted: talkPayload,
      outputAudioDelta: (audio) => ({ ...talkPayload(), byteLength: audio.byteLength }),
      outputAudioDone: (reason) => ({ ...talkPayload(), reason }),
    },
    onTalkEvent: (talkEvent: TalkEvent) =>
      params.context.broadcastToConnIds(
        "talk.event",
        { voiceSessionId: params.voiceSessionId, talkEvent },
        new Set([params.connId]),
        { dropIfSlow: talkEvent.final !== true },
      ),
    captureBridgeEvents: false,
  });

  const submit = async (callId: string, result: unknown): Promise<void> => {
    if (!bridge) {
      throw new Error("OpenAI Realtime Gateway control bridge is not ready");
    }
    await bridge.submitToolResult(callId, result);
  };

  const applyControl = async (args: unknown) => {
    const parsed = parseRealtimeVoiceAgentControlToolArgs(args);
    const result = await (params.controlAgentRun ?? controlRealtimeVoiceAgentRun)({
      sessionKey: params.sessionKey,
      text: parsed.text,
      mode: parsed.mode,
    });
    if (result.mode === "cancel" && result.ok) {
      for (const controller of consultControllers.values()) {
        controller.abort(new Error("Realtime voice consult cancelled"));
      }
    }
    return result;
  };

  const runConsult = async (
    event: RealtimeVoiceToolCallEvent,
    controller: AbortController,
  ): Promise<void> => {
    try {
      controller.signal.throwIfAborted();
      await params.flushTranscript();
      const result = await params.runAgentConsult(event.args, controller.signal);
      if (closed) {
        return;
      }
      await submit(event.callId, { result: result.text });
    } catch (error) {
      if (closed) {
        return;
      }
      const result = controller.signal.aborted
        ? buildRealtimeVoiceAgentCancelProviderResult()
        : { error: formatError(error) };
      await submit(event.callId, result);
    } finally {
      if (consultControllers.get(event.callId) === controller) {
        consultControllers.delete(event.callId);
      }
    }
  };

  const runControl = createTalkRealtimeRunControlOwner({
    hasActiveRun: () => consultControllers.size > 0,
    execute: applyControl,
    speak: (message) => bridge?.sendUserMessage?.(message),
    warn,
  });

  const handleToolCall = (event: RealtimeVoiceToolCallEvent): void => {
    if (closed) {
      return;
    }
    if (event.name === REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME) {
      const controller = new AbortController();
      consultControllers.set(event.callId, controller);
      const admission = consultQueue.enqueue(() => runConsult(event, controller));
      if (!admission.accepted) {
        consultControllers.delete(event.callId);
        void submit(event.callId, { error: "Realtime Talk consult queue is full" });
        return;
      }
      void admission.completion.catch((error: unknown) => {
        warn(`talk Gateway control consult failed: ${formatError(error)}`);
      });
      return;
    }
    if (event.name === REALTIME_VOICE_AGENT_CONTROL_TOOL_NAME) {
      if (
        !runControl.enqueue(event.args, {
          onResult: (result) => submit(event.callId, result),
          onError: (error) => submit(event.callId, { error: formatError(error) }),
        })
      ) {
        void submit(event.callId, { error: "Realtime Talk control queue is full" });
      }
      return;
    }
    void submit(event.callId, {
      error: `Unsupported realtime Talk tool: ${event.name}`,
    }).catch((error: unknown) => {
      warn(`talk Gateway control rejection failed: ${formatError(error)}`);
    });
  };

  const handleTranscript = (role: "user" | "assistant", text: string, final: boolean): void => {
    if (closed || !text.trim()) {
      return;
    }
    const turnId = harness.ensureTurn();
    harness.emit({
      type:
        role === "assistant"
          ? final
            ? "output.text.done"
            : "output.text.delta"
          : final
            ? "transcript.done"
            : "transcript.delta",
      turnId,
      payload: role === "assistant" ? { text } : { role, text },
      final,
    });
    if (!final) {
      return;
    }
    transcriptSequence += 1;
    const entryId = `${entryPrefix}-${transcriptSequence}`;
    void params.appendTranscript({ entryId, role, text }).catch((error: unknown) => {
      warn(`talk Gateway control transcript failed: ${formatError(error)}`);
    });
    if (role === "user") {
      runControl.handleSpoken(text, params.flushTranscript());
    }
  };

  const owner: GatewayControlOwner = {
    connId: params.connId,
    sessionKey: params.sessionKey,
    control: {
      bindBridge: (nextBridge) => {
        bridge = nextBridge;
      },
      onEvent: (event) => {
        const legacyOutcome = handleRealtimeVoiceHarnessBridgeEvent(harness, event);
        if (
          legacyOutcome &&
          (legacyOutcome.status === "failed" || legacyOutcome.status === "incomplete")
        ) {
          warn(`talk Gateway control ${legacyOutcome.message}`);
        }
        if (
          event.direction === "server" &&
          (event.type === "conversation.output_audio.delta" ||
            event.type === "response.audio.delta" ||
            event.type === "response.output_audio.delta")
        ) {
          const turnId = harness.ensureTurn();
          harness.talk.startOutputAudio({ turnId, payload: talkPayload() });
        }
      },
      onTranscript: handleTranscript,
      onToolCall: handleToolCall,
      onResponseDone: (outcome) => {
        const terminal = harness.finishResponse(outcome);
        if (terminal.ok && (outcome.status === "failed" || outcome.status === "incomplete")) {
          warn(`talk Gateway control ${outcome.message}`);
        }
      },
      onReady: () => harness.emit({ type: "session.ready", payload: talkPayload() }),
      onError: (error) => {
        warn(`talk Gateway control provider error: ${error.message}`);
        harness.emit({
          type: "session.error",
          payload: { ...talkPayload(), message: error.message },
          final: true,
        });
      },
      onClose: () => {
        harness.emit({ type: "session.closed", payload: talkPayload(), final: true });
        harness.close();
        void owner.close({ skipProvider: true }).catch((error: unknown) => {
          warn(`talk Gateway control close failed: ${formatError(error)}`);
        });
      },
    },
    activate: (nextCloseProvider) => {
      closeProvider = nextCloseProvider;
      const previous = owners.get(params.voiceSessionId);
      owners.set(params.voiceSessionId, owner);
      if (previous && previous !== owner) {
        void previous
          .close({ preserveLogicalSession: true, preserveRuns: true })
          .catch((error: unknown) => {
            warn(`talk replaced Gateway transport close failed: ${formatError(error)}`);
          });
      }
      registerTalkConnectionCleanup(params.connId, "browser-control", () => {
        for (const current of owners.values()) {
          if (current.connId === params.connId) {
            void current.close().catch((error: unknown) => {
              warn(`talk disconnected Gateway control close failed: ${formatError(error)}`);
            });
          }
        }
      });
    },
    close: (options) => {
      if (closing) {
        return closing;
      }
      // Defer teardown until after `closing` is assigned so provider callbacks
      // can re-enter close without starting a second cleanup.
      closing = Promise.resolve().then(async () => {
        closed = true;
        harness.close();
        if (owners.get(params.voiceSessionId) === owner) {
          owners.delete(params.voiceSessionId);
        }
        if (!options?.preserveRuns) {
          for (const controller of consultControllers.values()) {
            controller.abort(new Error("Realtime voice session closed"));
          }
        }
        consultQueue.seal();
        const providerClose = options?.skipProvider
          ? Promise.resolve()
          : Promise.resolve().then(() => closeProvider?.());
        const [providerResult] = await Promise.allSettled([
          providerClose,
          params.flushTranscript(),
          runControl.close(),
          consultQueue.flush(),
        ]);
        if (!options?.preserveLogicalSession) {
          await params.closeLogicalSession();
        }
        if (providerResult?.status === "rejected") {
          throw providerResult.reason;
        }
      });
      return closing;
    },
  };
  return owner;
}

export async function closeTalkClientGatewayControlSession(params: {
  voiceSessionId: string;
  sessionKey: string;
  connId?: string;
}): Promise<boolean> {
  const owner = owners.get(params.voiceSessionId);
  if (!owner) {
    return false;
  }
  if (
    owner.sessionKey !== params.sessionKey.trim() ||
    !params.connId ||
    owner.connId !== params.connId
  ) {
    throw new Error("Gateway-controlled voice session is not owned by this client");
  }
  await owner.close();
  return true;
}
