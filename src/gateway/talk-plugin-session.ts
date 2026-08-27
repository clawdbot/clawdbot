import { randomUUID } from "node:crypto";
import type { TalkSessionCreateResult } from "../../packages/gateway-protocol/src/index.js";
import { formatErrorMessage } from "../infra/errors.js";
import { getPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { BoundedSerialQueue } from "../shared/bounded-serial-queue.js";
import {
  PLUGIN_TALK_AUDIO_FORMAT,
  type OpenPluginTalkSessionParams,
  type PluginTalkSession,
  type PluginTalkSessionEvent,
} from "../talk/plugin-session.js";
import { authorizeOperatorScopesForMethod } from "./method-scopes.js";
import { dispatchGatewayMethodInProcess } from "./server-plugin-in-process-dispatch.js";
import type { TalkRealtimeRelayEvent } from "./talk-realtime-relay-state.js";
import {
  cancelTalkRealtimeRelayTurn,
  sendTalkRealtimeRelayAudio,
  stopTalkRealtimeRelaySession,
} from "./talk-realtime-relay.js";
import { withPluginTalkSessionDispatchContext } from "./talk-realtime-session-create.js";

const PCM16_24KHZ_MONO_BYTES_PER_MS = 48;
const MAX_PENDING_PLUGIN_TALK_EVENTS = 128;

function talkSessionAbortError(signal: AbortSignal, fallback: string): Error {
  return signal.reason instanceof Error ? signal.reason : new Error(fallback);
}

function requirePluginTalkScope() {
  const scope = getPluginRuntimeGatewayRequestScope();
  if (
    !scope?.context ||
    !scope.pluginId ||
    !scope.client?.connId ||
    !scope.routeSignal ||
    scope.gatewayMethodDispatchAllowed !== true
  ) {
    throw new Error(
      "Interactive Talk sessions require a plugin request route that declares the gatewayMethodDispatch contract.",
    );
  }
  const operatorScopes = scope.client?.connect.scopes ?? [];
  if (!authorizeOperatorScopesForMethod("talk.session.create", operatorScopes).allowed) {
    throw new Error(
      "Interactive Talk sessions require an authenticated plugin request with Talk access.",
    );
  }
  return {
    clientConnId: scope.client.connId,
    context: scope.context,
    ownerId: `plugin:${scope.pluginId}:${randomUUID()}`,
    quotaOwnerId: `plugin:${scope.pluginId}:${scope.client.connId}`,
    routeSignal: scope.routeSignal,
  };
}

function createPluginTalkEventSink(
  params: OpenPluginTalkSessionParams,
  onDeliveryError: (error: unknown) => void,
) {
  let generation = 0;
  let sequence = 0;
  let ptsMs = 0;
  let state: Extract<PluginTalkSessionEvent, { type: "state" }>["state"] = "idle";
  let closed = false;
  let deliveryFailed = false;
  let terminalDeliveryAfterOverflow = false;
  const deliveryQueue = new BoundedSerialQueue({
    maxPendingCount: MAX_PENDING_PLUGIN_TALK_EVENTS,
    maxPendingWeight: MAX_PENDING_PLUGIN_TALK_EVENTS,
  });

  const failDelivery = (error: unknown): void => {
    if (deliveryFailed) {
      return;
    }
    deliveryFailed = true;
    deliveryQueue.seal();
    onDeliveryError(error);
  };
  const deliver = (event: PluginTalkSessionEvent): void => {
    if (deliveryFailed) {
      return;
    }
    const admission = deliveryQueue.enqueue(async () => {
      if (deliveryFailed) {
        return;
      }
      try {
        await params.onEvent(event);
      } catch (error) {
        failDelivery(error);
      }
    });
    if (!admission.accepted) {
      terminalDeliveryAfterOverflow = true;
      failDelivery(new Error("Plugin Talk event delivery could not keep up with realtime audio"));
      return;
    }
    void admission.completion.catch(failDelivery);
  };
  const setState = (next: typeof state): void => {
    if (state === next || closed) {
      return;
    }
    state = next;
    deliver({ type: "state", generation, ptsMs, state });
  };

  return {
    get closed() {
      return closed;
    },
    eventSink(event: TalkRealtimeRelayEvent): void {
      switch (event.type) {
        case "ready":
        case "inputAudio":
          setState("listening");
          return;
        case "audioDone":
          setState("listening");
          return;
        case "audio": {
          setState("speaking");
          const pcm = Buffer.from(event.audioBase64, "base64");
          deliver({ type: "audio", generation, sequence, ptsMs, pcm });
          sequence += 1;
          ptsMs += pcm.byteLength / PCM16_24KHZ_MONO_BYTES_PER_MS;
          return;
        }
        case "transcript":
          if (event.role === "user" && event.final && event.text.trim()) {
            setState("thinking");
          }
          return;
        case "toolCall":
          setState("thinking");
          return;
        case "clear":
          generation += 1;
          sequence = 0;
          ptsMs = 0;
          deliver({
            type: "clear",
            generation,
            reason: event.reason === "barge-in" ? "barge-in" : "cancel",
          });
          setState("listening");
          return;
        case "error":
          setState("error");
          return;
        case "close":
          if (closed) {
            return;
          }
          closed = true;
          if (terminalDeliveryAfterOverflow) {
            const terminalEvent: PluginTalkSessionEvent = {
              type: "closed",
              generation,
              reason: event.reason,
            };
            // Overflow seals normal admission, but the terminal callback is the
            // plugin's cleanup contract. Drain the accepted prefix, then bypass
            // the sealed queue exactly once so the renderer cannot be orphaned.
            void deliveryQueue
              .flush()
              .then(() => params.onEvent(terminalEvent))
              .catch(onDeliveryError);
          } else {
            deliver({ type: "closed", generation, reason: event.reason });
          }
          break;
        case "mark":
        case "toolCallCancelled":
        case "toolProgress":
        case "toolResult":
          break;
      }
    },
  };
}

export async function openPluginTalkSession(
  params: OpenPluginTalkSessionParams,
): Promise<PluginTalkSession> {
  const sessionKey = params.sessionKey.trim();
  if (!sessionKey) {
    throw new Error(
      "Choose an OpenClaw session before starting voice so the conversation uses the intended agent and workspace.",
    );
  }
  const { clientConnId, context, ownerId, quotaOwnerId, routeSignal } = requirePluginTalkScope();
  const signal = AbortSignal.any([params.signal, routeSignal]);
  if (signal.aborted) {
    throw talkSessionAbortError(signal, "Talk session was cancelled before it opened");
  }
  const lifecycle: { relaySessionId?: string; aborted: boolean; removeAbortListener?: () => void } =
    {
      aborted: false,
    };
  const stopRelay = (disposition?: "detach"): void => {
    const relaySessionId = lifecycle.relaySessionId;
    if (!relaySessionId || events.closed) {
      return;
    }
    try {
      stopTalkRealtimeRelaySession({
        relaySessionId,
        connId: ownerId,
        ...(disposition ? { disposition } : {}),
      });
    } catch (error) {
      context.logGateway.warn(`plugin Talk session cleanup failed: ${formatErrorMessage(error)}`);
    }
  };
  let deliveryError: unknown;
  const events = createPluginTalkEventSink(params, (error) => {
    deliveryError ??= error;
    context.logGateway.warn(`plugin Talk event delivery failed: ${formatErrorMessage(error)}`);
    stopRelay();
  });
  const abort = (): void => {
    lifecycle.aborted = true;
    stopRelay("detach");
  };
  signal.addEventListener("abort", abort, { once: true });
  lifecycle.removeAbortListener = () => signal.removeEventListener("abort", abort);
  let session: TalkSessionCreateResult;
  try {
    session = await withPluginTalkSessionDispatchContext(
      {
        clientConnId,
        ownerId,
        quotaOwnerId,
        signal,
        eventSink: (event) => {
          events.eventSink(event);
          if (event.type === "close") {
            lifecycle.removeAbortListener?.();
          }
        },
      },
      async () =>
        await dispatchGatewayMethodInProcess<TalkSessionCreateResult>(
          "talk.session.create",
          {
            sessionKey,
            mode: "realtime",
            transport: "gateway-relay",
            brain: "agent-consult",
            ...(params.provider ? { provider: params.provider } : {}),
            ...(params.model ? { model: params.model } : {}),
            ...(params.voice ? { voice: params.voice } : {}),
            ...(params.language ? { language: params.language } : {}),
          },
          { requireScopedClient: true },
        ),
    );
  } catch (error) {
    lifecycle.removeAbortListener();
    throw error;
  }
  const relaySessionId = session.relaySessionId;
  if (!relaySessionId) {
    lifecycle.removeAbortListener();
    throw new Error("Gateway did not return a realtime Talk relay session");
  }
  lifecycle.relaySessionId = relaySessionId;
  if (lifecycle.aborted || deliveryError) {
    stopRelay(lifecycle.aborted ? "detach" : undefined);
    lifecycle.removeAbortListener();
    if (deliveryError) {
      throw deliveryError instanceof Error
        ? deliveryError
        : new Error(`Plugin Talk event delivery failed: ${formatErrorMessage(deliveryError)}`);
    }
    throw talkSessionAbortError(signal, "Talk session was cancelled while opening");
  }

  return {
    audio: PLUGIN_TALK_AUDIO_FORMAT,
    sendAudio(pcm, options) {
      if (events.closed) {
        throw new Error("Talk session is closed");
      }
      const delivery = sendTalkRealtimeRelayAudio({
        relaySessionId,
        connId: ownerId,
        audioBase64: Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString("base64"),
        timestamp: options?.timestamp,
      });
      void delivery?.catch((error: unknown) => {
        context.logGateway.warn(`plugin Talk audio delivery failed: ${formatErrorMessage(error)}`);
      });
    },
    cancelOutput(reason) {
      if (events.closed) {
        return;
      }
      const cancellation = cancelTalkRealtimeRelayTurn({
        relaySessionId,
        connId: ownerId,
        reason: reason?.trim() || "plugin-cancelled",
      });
      void cancellation?.catch((error: unknown) => {
        context.logGateway.warn(`plugin Talk cancellation failed: ${formatErrorMessage(error)}`);
      });
    },
    close() {
      if (events.closed) {
        return;
      }
      lifecycle.removeAbortListener?.();
      stopTalkRealtimeRelaySession({ relaySessionId, connId: ownerId });
    },
  };
}
