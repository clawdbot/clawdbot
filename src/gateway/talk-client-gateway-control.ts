import { randomUUID } from "node:crypto";
import { GATEWAY_CLIENT_CAPS } from "../../packages/gateway-protocol/src/client-info.js";
import type { ReplyToolAuthorityOverlay } from "../auto-reply/reply/reply-run-registry.contracts.js";
import { readErrorName } from "../infra/errors.js";
import { BoundedSerialQueue } from "../shared/bounded-serial-queue.js";
import {
  REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
  resolveRealtimeVoiceAgentConsultToolsAllow,
} from "../talk/agent-consult-tool.js";
import { REALTIME_VOICE_AGENT_CONTROL_FAILURE_MESSAGE } from "../talk/agent-run-control-shared.js";
import {
  buildRealtimeVoiceAgentCancelProviderResult,
  buildRealtimeVoiceAgentControlSpeechMessage,
  controlRealtimeVoiceAgentRun,
  parseRealtimeVoiceAgentControlToolArgs,
  REALTIME_VOICE_AGENT_CONTROL_TOOL_NAME,
  resolveRealtimeVoiceAgentControlIntent,
} from "../talk/agent-run-control.js";
import type { RealtimeVoiceAgentControlResult } from "../talk/agent-run-control.js";
import type {
  RealtimeVoiceAgentConsultRunner,
  RealtimeVoiceCloseDisposition,
  RealtimeVoiceGatewayControl,
  RealtimeVoiceToolCallEvent,
} from "../talk/provider-types.js";
import {
  createRealtimeVoiceSessionHarness,
  handleRealtimeVoiceHarnessBridgeEvent,
} from "../talk/realtime-session-harness.js";
import type { TalkEvent } from "../talk/talk-events.js";
import { ADMIN_SCOPE, WRITE_SCOPE } from "./operator-scopes.js";
import { resolveChatSendCallerContext } from "./server-methods/gateway-client-identity.js";
import type { GatewayRequestContext } from "./server-methods/shared-types.js";
import { resolveOwnedActiveTalkRunTarget } from "./server-methods/talk-client-run-ownership.js";
import { formatError } from "./server-utils.js";
import { registerTalkConnectionCleanup } from "./talk-session-registry.js";
import type { PreparedTalkSessionTarget } from "./talk-session-target.types.js";

type GatewayControlOwner = {
  adoptProvider: (closeProvider: () => Promise<void>) => Promise<void>;
  activate: () => void;
  assertOpen: () => void;
  close: (options?: {
    preserveLogicalSession?: boolean;
    preserveRuns?: boolean;
    skipProvider?: boolean;
  }) => Promise<void>;
  connId: string;
  control: RealtimeVoiceGatewayControl & Required<Pick<RealtimeVoiceGatewayControl, "bindControl">>;
  runAgentConsult: RealtimeVoiceAgentConsultRunner;
  sessionTarget: PreparedTalkSessionTarget;
  voiceSessionId: string;
};

type GatewayControlCommands = Parameters<
  NonNullable<RealtimeVoiceGatewayControl["bindControl"]>
>[0];

const owners = new Map<string, GatewayControlOwner>();
const pendingOwners = new Set<GatewayControlOwner>();

const REALTIME_VOICE_CONTEXT_MAX_UTF8_BYTES = 8_000;
const REALTIME_CONTROL_MAX_PENDING = 8;

export type TalkAgentConsultAuthority = {
  senderIsOwner: boolean;
  toolsAllow?: string[];
  replyCaller?: ReturnType<typeof resolveChatSendCallerContext>;
};

export function resolveTalkAgentConsultAuthority(
  scopes: readonly string[] | undefined,
  client?: Parameters<typeof resolveChatSendCallerContext>[0],
): TalkAgentConsultAuthority {
  const senderIsOwner = scopes?.includes(ADMIN_SCOPE) === true;
  const replyCaller = client ? resolveChatSendCallerContext(client) : undefined;
  if (replyCaller) {
    // Talk has no task-suggestion acceptance UI, even when its hosting client does.
    replyCaller.GatewayClientCaps = replyCaller.GatewayClientCaps.filter(
      (cap) => cap !== GATEWAY_CLIENT_CAPS.TASK_SUGGESTIONS,
    );
  }
  if (senderIsOwner || scopes?.includes(WRITE_SCOPE) === true) {
    return { senderIsOwner, ...(replyCaller ? { replyCaller } : {}) };
  }
  return {
    senderIsOwner: false,
    ...(replyCaller ? { replyCaller } : {}),
    toolsAllow: resolveRealtimeVoiceAgentConsultToolsAllow("safe-read-only"),
  };
}

function createRealtimeControlQueue(): BoundedSerialQueue {
  return new BoundedSerialQueue({
    maxPendingCount: REALTIME_CONTROL_MAX_PENDING,
    maxPendingWeight: REALTIME_CONTROL_MAX_PENDING,
  });
}

export function createTalkRealtimeRunControlOwner(params: {
  controlSource?: "delegation" | "transcript";
  supportsToolCalls?: boolean;
  hasActiveRun: () => boolean;
  prepare: (args: unknown) => () => Promise<RealtimeVoiceAgentControlResult>;
  speak: (message: string) => void;
  warn: (message: string) => void;
}) {
  const queue = createRealtimeControlQueue();
  const enqueue = (
    args: unknown,
    options: {
      ready?: () => Promise<void>;
      onResult?: (result: RealtimeVoiceAgentControlResult) => void | Promise<void>;
      onError?: (error: unknown) => void | Promise<void>;
    } = {},
  ): boolean => {
    // Capture the owner (including absence) before any FIFO/readiness wait.
    let execute: () => Promise<RealtimeVoiceAgentControlResult>;
    try {
      execute = params.prepare(args);
    } catch (error) {
      execute = async () => {
        throw error;
      };
    }
    const admission = queue.enqueue(
      async () => {
        let result: RealtimeVoiceAgentControlResult;
        try {
          await options.ready?.();
          result = await execute();
        } catch (error) {
          if (!options.onError) {
            throw error;
          }
          await options.onError(error);
          return;
        }
        // Reply failures are transport failures, not another execution failure to answer twice.
        await options.onResult?.(result);
      },
      { sealOnOverflow: false },
    );
    if (!admission.accepted) {
      params.warn(`realtime Talk control queue rejected work: ${admission.reason}`);
      return false;
    }
    void admission.completion.catch((error: unknown) => {
      params.warn(`realtime Talk control failed: ${formatError(error)}`);
    });
    return true;
  };
  const handleInput = (
    text: string,
    respond: (message: string) => void,
    ready?: () => Promise<void>,
  ): "control" | "consult" => {
    const intent = resolveRealtimeVoiceAgentControlIntent({ text });
    const intrinsic = intent.mode === "status" || intent.mode === "cancel";
    const allowIdle = params.controlSource === "delegation" || params.supportsToolCalls === false;
    if (!intent.shouldAutoControl || (!params.hasActiveRun() && !(allowIdle && intrinsic))) {
      return "consult";
    }
    const reply = (message: string) =>
      respond(buildRealtimeVoiceAgentControlSpeechMessage(message));
    if (
      !enqueue(
        { text, mode: intent.mode },
        {
          ready,
          onResult: (result) => {
            if (result.speak && !result.suppress && result.message.trim()) {
              reply(result.message);
            }
          },
          onError: () => reply(REALTIME_VOICE_AGENT_CONTROL_FAILURE_MESSAGE),
        },
      )
    ) {
      reply(
        "OpenClaw's voice control queue is full. Please try again after the pending controls finish.",
      );
    }
    return "control";
  };
  return {
    enqueue,
    handleDelegationInput: params.controlSource === "delegation" ? handleInput : undefined,
    handleSpoken: (text: string, ready?: () => Promise<void>): boolean =>
      params.controlSource !== "delegation" && handleInput(text, params.speak, ready) === "control",
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

export function createTalkClientGatewayControlOwner(params: {
  voiceSessionId: string;
  providerId?: string;
  supportsToolCalls?: boolean;
  controlSource?: "delegation" | "transcript";
  sessionTarget: PreparedTalkSessionTarget;
  connId: string;
  context: Pick<
    GatewayRequestContext,
    "broadcastToConnIds" | "logGateway" | "chatAbortControllers"
  >;
  assertConnectionOpen?: () => void;
  runAgentConsult: (args: unknown, signal: AbortSignal) => Promise<{ text: string }>;
  appendTranscript: (entry: {
    entryId: string;
    role: "user" | "assistant";
    text: string;
  }) => Promise<void>;
  flushTranscript: () => Promise<void>;
  closeLogicalSession: () => Promise<void>;
  controlAgentRun?: typeof controlRealtimeVoiceAgentRun;
  getToolAuthorityOverlay?: (source?: "reply" | "attempt") => ReplyToolAuthorityOverlay;
}): GatewayControlOwner {
  let commands: GatewayControlCommands | undefined;
  let closeProvider: (() => Promise<void>) | undefined;
  let closing: Promise<void> | undefined;
  const lifetime = new AbortController();
  const { signal } = lifetime;
  let transcriptSequence = 0;
  const entryPrefix = `gateway-${randomUUID()}`;
  const consultQueue = createRealtimeControlQueue();
  const consultControllers = new Map<
    string | symbol,
    { controller: AbortController; closeDisposition: RealtimeVoiceCloseDisposition }
  >();
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

  const assertActive = () => {
    owner.assertOpen();
    if (owners.get(params.voiceSessionId) !== owner) {
      throw new Error("Realtime voice session is not active");
    }
  };
  const admitConsult = async (args: unknown, consultSignal: AbortSignal) => {
    assertActive();
    consultSignal.throwIfAborted();
    await params.flushTranscript();
    // Admit in the same continuation as the liveness check: another await
    // would let flush-completion teardown close the owner before the run starts.
    assertActive();
    consultSignal.throwIfAborted();
    return params.runAgentConsult(args, consultSignal);
  };
  const bindControl = (nextCommands: GatewayControlCommands) => {
    owner.assertOpen();
    if (!pendingOwners.has(owner) && owners.get(params.voiceSessionId) !== owner) {
      throw new Error("Realtime voice session is not active");
    }
    commands = nextCommands;
  };
  const submit = async (callId: string, result: unknown): Promise<void> => {
    assertActive();
    if (!commands?.submitToolResult) {
      throw new Error("Realtime voice tool control is not available");
    }
    await commands.submitToolResult(callId, result);
  };
  const rejectToolCall = (callId: string, message: string) => {
    void submit(callId, { error: message }).catch((error: unknown) => {
      warn(`talk Gateway control rejection failed: ${formatError(error)}`);
    });
  };

  const resolveRunTarget = () =>
    resolveOwnedActiveTalkRunTarget({
      context: params.context,
      clientConnId: params.connId,
      sessionTarget: params.sessionTarget,
      scope: { kind: "voice-session", voiceSessionId: params.voiceSessionId },
      assertCurrent: assertActive,
    });

  const prepareControl = (args: unknown) => {
    assertActive();
    const parsed = parseRealtimeVoiceAgentControlToolArgs(args);
    const runTarget = resolveRunTarget();
    const admittedConsults = [...consultControllers.values()];
    const getToolAuthorityOverlay = params.getToolAuthorityOverlay;
    return async () => {
      assertActive();
      const result = await (params.controlAgentRun ?? controlRealtimeVoiceAgentRun)({
        sessionKey: params.sessionTarget.canonicalKey,
        runTarget,
        getToolAuthorityOverlay: getToolAuthorityOverlay
          ? () => getToolAuthorityOverlay(runTarget?.toolAuthoritySource)
          : undefined,
        text: parsed.text,
        mode: parsed.mode,
      });
      assertActive();
      if (result.mode === "cancel" && result.ok) {
        for (const { controller } of admittedConsults) {
          controller.abort(new Error("Realtime voice consult cancelled"));
        }
      }
      return result;
    };
  };

  const runConsult = async (
    event: RealtimeVoiceToolCallEvent,
    controller: AbortController,
  ): Promise<void> => {
    try {
      const result = await admitConsult(event.args, controller.signal);
      if (signal.aborted) {
        return;
      }
      await submit(event.callId, { result: result.text });
    } catch (error) {
      if (signal.aborted) {
        return;
      }
      const result =
        controller.signal.aborted || readErrorName(error) === "AbortError"
          ? buildRealtimeVoiceAgentCancelProviderResult()
          : { error: formatError(error) };
      await submit(event.callId, result);
    } finally {
      if (consultControllers.get(event.callId)?.controller === controller) {
        consultControllers.delete(event.callId);
      }
    }
  };

  const runControl = createTalkRealtimeRunControlOwner({
    controlSource: params.controlSource,
    supportsToolCalls: params.supportsToolCalls,
    hasActiveRun: () => consultControllers.size > 0 || resolveRunTarget() !== null,
    prepare: prepareControl,
    speak: (message) => {
      assertActive();
      if (!commands?.sendUserMessage) {
        throw new Error("Realtime voice speech control is not available");
      }
      commands.sendUserMessage(message);
    },
    warn,
  });

  const handleToolCall = (event: RealtimeVoiceToolCallEvent): void => {
    if (signal.aborted) {
      return;
    }
    if (event.name === REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME) {
      const controller = new AbortController();
      consultControllers.set(event.callId, { controller, closeDisposition: "abort" });
      const admission = consultQueue.enqueue(() => runConsult(event, controller));
      if (!admission.accepted) {
        consultControllers.delete(event.callId);
        rejectToolCall(event.callId, "Realtime Talk consult queue is full");
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
        rejectToolCall(event.callId, "Realtime Talk control queue is full");
      }
      return;
    }
    rejectToolCall(event.callId, `Unsupported realtime Talk tool: ${event.name}`);
  };

  const handleTranscript = (role: "user" | "assistant", text: string, final: boolean): void => {
    if (signal.aborted || !text.trim()) {
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
      runControl.handleSpoken(text, params.flushTranscript);
    }
  };

  const owner: GatewayControlOwner = {
    connId: params.connId,
    sessionTarget: params.sessionTarget,
    voiceSessionId: params.voiceSessionId,
    assertOpen: () => {
      signal.throwIfAborted();
      params.assertConnectionOpen?.();
    },
    runAgentConsult: async ({ prompt, signal: consultSignal = new AbortController().signal }) => {
      assertActive();
      const consultId = Symbol("provider-consult");
      const controller = new AbortController();
      const delegatedSignal = AbortSignal.any([consultSignal, controller.signal]);
      // Spoken controls see both kinds of consult. Transport detachment still
      // leaves accepted provider work under its own cancellation owner.
      consultControllers.set(consultId, { controller, closeDisposition: "detach" });
      try {
        return await admitConsult({ question: prompt }, delegatedSignal);
      } finally {
        consultControllers.delete(consultId);
      }
    },
    control: {
      bindControl,
      bindBridge: bindControl,
      onEvent: (event) => {
        if (signal.aborted) {
          return;
        }
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
      ...(runControl.handleDelegationInput
        ? {
            handleDelegationInput: (text, respond) => {
              assertActive();
              return runControl.handleDelegationInput!(
                text,
                (message) => {
                  // The call owns this reply even when cancellation ended its backing task.
                  assertActive();
                  respond(message);
                },
                params.flushTranscript,
              );
            },
          }
        : {}),
      onToolCall: handleToolCall,
      onResponseDone: (outcome) => {
        if (signal.aborted) {
          return;
        }
        const terminal = harness.finishResponse(outcome);
        if (terminal.ok && (outcome.status === "failed" || outcome.status === "incomplete")) {
          warn(`talk Gateway control ${outcome.message}`);
        }
      },
      onReady: () => {
        if (!signal.aborted) {
          harness.emit({ type: "session.ready", payload: talkPayload() });
        }
      },
      onError: (error) => {
        if (signal.aborted) {
          return;
        }
        warn(`talk Gateway control provider error: ${error.message}`);
        harness.emit({
          type: "session.error",
          payload: { ...talkPayload(), message: error.message },
          final: true,
        });
      },
      onClose: () => {
        if (signal.aborted) {
          return;
        }
        harness.emit({ type: "session.closed", payload: talkPayload(), final: true });
        harness.close();
        void owner.close({ skipProvider: true }).catch((error: unknown) => {
          warn(`talk Gateway control close failed: ${formatError(error)}`);
        });
      },
    },
    adoptProvider: async (nextCloseProvider) => {
      if (signal.aborted) {
        await nextCloseProvider();
        signal.throwIfAborted();
      }
      closeProvider = nextCloseProvider;
      owner.assertOpen();
    },
    activate: () => {
      owner.assertOpen();
      pendingOwners.delete(owner);
      const previous = owners.get(params.voiceSessionId);
      owners.set(params.voiceSessionId, owner);
      if (previous && previous !== owner) {
        void previous
          .close({ preserveLogicalSession: true, preserveRuns: true })
          .catch((error: unknown) => {
            warn(`talk replaced Gateway transport close failed: ${formatError(error)}`);
          });
      }
    },
    close: (options) => {
      if (closing) {
        return closing;
      }
      // Fence admission synchronously, then defer teardown so provider callbacks
      // can re-enter close after the closing promise has been assigned.
      closing = Promise.resolve().then(async () => {
        pendingOwners.delete(owner);
        harness.close();
        if (owners.get(params.voiceSessionId) === owner) {
          owners.delete(params.voiceSessionId);
        }
        if (!options?.preserveRuns) {
          for (const { controller, closeDisposition } of consultControllers.values()) {
            if (closeDisposition === "abort") {
              controller.abort(new Error("Realtime voice session closed"));
            }
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
      lifetime.abort(new Error("Realtime voice session closed"));
      return closing;
    },
  };
  // Track creation before the provider resolves. Replacement activates only after
  // startup succeeds, so a failed new transport cannot evict the current one.
  owner.assertOpen();
  pendingOwners.add(owner);
  registerTalkConnectionCleanup(params.connId, "browser-control", () => {
    for (const current of [...pendingOwners, ...owners.values()]) {
      if (current.connId === params.connId) {
        void current.close().catch((error: unknown) => {
          warn(`talk disconnected Gateway control close failed: ${formatError(error)}`);
        });
      }
    }
  });
  return owner;
}

export async function closeTalkClientGatewayControlSession(params: {
  voiceSessionId: string;
  sessionKey: string;
  connId?: string;
}): Promise<boolean> {
  const matching = [...pendingOwners, ...owners.values()].filter(
    (owner) => owner.voiceSessionId === params.voiceSessionId,
  );
  if (matching.length === 0) {
    return false;
  }
  const owned = matching.filter(
    (owner) =>
      owner.sessionTarget.sessionKey === params.sessionKey.trim() && owner.connId === params.connId,
  );
  if (owned.length === 0) {
    throw new Error("Gateway-controlled voice session is not owned by this client");
  }
  await Promise.all(owned.map((owner) => owner.close()));
  return true;
}
