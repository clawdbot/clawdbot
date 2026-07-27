import type { ReplyPayload } from "openclaw/plugin-sdk/reply-payload";
import {
  isTelegramCurrentDmRecoverySemanticFinal,
  markReplyPayloadAsTelegramCurrentDmRecoverySemanticFinal,
} from "openclaw/plugin-sdk/reply-payload";
import type { ReplyDispatcher, ReplyDispatchRuntimeInfo } from "openclaw/plugin-sdk/reply-runtime";
import type { TelegramBotDeps } from "./bot-deps.js";
import type { TelegramMessageContext } from "./bot-message-context.js";
import type { TelegramCurrentDmRecoveryOptions } from "./bot.types.js";
import type {
  CurrentDmRecoveryCoordinator,
  CurrentDmRecoveryIdentity,
} from "./current-dm-recovery-coordinator.js";

export type CurrentDmRecoveryHost = {
  onDispatcherReady(dispatcher: ReplyDispatcher): void;
  onAgentRunStart(runId: string): void;
  beforeDeliver(
    payload: ReplyPayload,
    info: ReplyDispatchRuntimeInfo,
  ): Promise<ReplyPayload | null>;
  noteActivity(): void;
  cancel(): void;
  markError(): void;
  ownsSemanticFinal(payload?: ReplyPayload): boolean;
};

export function applyCurrentDmRecoveryBeforeDeliver(
  recovery: CurrentDmRecoveryHost | undefined,
  payload: ReplyPayload,
  info: ReplyDispatchRuntimeInfo,
): Promise<ReplyPayload | null> {
  return recovery ? recovery.beforeDeliver(payload, info) : Promise.resolve(payload);
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isBoundedPlaintextFinal(payload: ReplyPayload): boolean {
  const text = nonEmpty(payload.text);
  if (!text || text.length > 4_096) {
    return false;
  }
  const { text: _text, ...unsupported } = payload;
  return Object.values(unsupported).every((value) => value === undefined || value === false);
}

export function createCurrentDmRecoveryHost(params: {
  context: TelegramMessageContext;
  options?: TelegramCurrentDmRecoveryOptions;
  telegramDeps: TelegramBotDeps;
  resolveSessionId: () => string | undefined;
  onSemanticFinalOwned: () => void;
}): CurrentDmRecoveryHost | undefined {
  const options = params.options;
  const startCoordinator = params.telegramDeps.startCurrentDmRecoveryCoordinator;
  const captureDelivery = params.telegramDeps.captureReplyDispatchDeliveryOutcome;
  if (options?.enabled !== true || !startCoordinator || !captureDelivery) {
    return undefined;
  }

  const inboundMessageId = positiveInteger(params.context.msg.message_id);
  const inboundUpdateId = positiveInteger(
    (params.context.primaryCtx.update as { update_id?: unknown } | undefined)?.update_id,
  );
  const ingressGeneration = positiveInteger(options.ingressGeneration);
  const featureGateGeneration = positiveInteger(options.featureGateGeneration);
  const sessionKey = nonEmpty(params.context.ctxPayload.SessionKey);
  const senderId = nonEmpty(params.context.ctxPayload.SenderId);
  const threadId = params.context.threadSpec.id;
  if (
    params.context.route.agentId !== "main" ||
    params.context.route.accountId !== "default" ||
    String(params.context.chatId) !== "5397261498" ||
    params.context.ctxPayload.ChatType !== "direct" ||
    senderId !== "5397261498" ||
    threadId != null ||
    sessionKey !== "agent:main:telegram:direct:5397261498" ||
    !inboundMessageId ||
    !inboundUpdateId ||
    !ingressGeneration ||
    !featureGateGeneration ||
    !sessionKey
  ) {
    return undefined;
  }

  let dispatcher: ReplyDispatcher | undefined;
  let runId: string | undefined;
  let startPromise: Promise<CurrentDmRecoveryCoordinator | undefined> | undefined;
  let terminal: "final" | "cancel" | "error" | undefined;
  let semanticFinalOwned = false;
  let semanticFinalObserved = false;

  const withCoordinator = (
    action: (coordinator: CurrentDmRecoveryCoordinator) => Promise<void>,
  ): void => {
    const promise = startPromise;
    if (!promise) {
      return;
    }
    void promise
      .then((coordinator) => (coordinator ? action(coordinator) : undefined))
      .catch(() => {});
  };

  const settleTerminal = (coordinator: CurrentDmRecoveryCoordinator): Promise<void> => {
    if (terminal === "final") {
      return coordinator.markFinalAccepted();
    }
    if (terminal === "cancel") {
      return coordinator.cancel();
    }
    if (terminal === "error") {
      return coordinator.markError();
    }
    return Promise.resolve();
  };

  const maybeStart = () => {
    if (startPromise || !dispatcher || !runId) {
      return;
    }
    const sessionId = nonEmpty(params.resolveSessionId());
    if (!sessionId) {
      return;
    }
    const identity: CurrentDmRecoveryIdentity = {
      agentId: params.context.route.agentId,
      provider: "telegram",
      accountId: params.context.route.accountId,
      chatId: String(params.context.chatId),
      senderId,
      ...(threadId == null ? {} : { threadId: String(threadId) }),
      inboundMessageId,
      inboundUpdateId,
      ingressGeneration,
      featureGateGeneration,
      sessionKey,
      sessionId,
      runId,
      turnId: `telegram:${inboundUpdateId}:${inboundMessageId}`,
    };
    const nativeDispatcher = dispatcher;
    startPromise = startCoordinator({
      enabled: true,
      identity,
      store: options.store,
      scheduler: options.scheduler,
      checkFreshness: options.checkFreshness,
      sendProgress: async ({ text }) => {
        const payload = { text };
        const outcome = captureDelivery(payload);
        if (!nativeDispatcher.sendBlockReply(payload) || !outcome.isTracked()) {
          throw new Error("Recovery progress was not admitted by the native ReplyDispatcher.");
        }
        if ((await outcome.promise) !== "delivered") {
          throw new Error("Recovery progress did not settle as a durable delivery.");
        }
      },
    }).then(async (coordinator) => {
      if (coordinator && terminal) {
        await settleTerminal(coordinator);
      }
      return coordinator;
    });
    void startPromise.catch(() => {});
  };

  return {
    onDispatcherReady(value) {
      dispatcher = value;
      maybeStart();
    },
    onAgentRunStart(value) {
      runId = nonEmpty(value);
      maybeStart();
    },
    async beforeDeliver(payload, info) {
      if (info.kind !== "final" || !isBoundedPlaintextFinal(payload)) {
        return payload;
      }
      if (semanticFinalObserved || terminal) {
        return null;
      }
      const startedCoordinator = await startPromise?.catch(() => undefined);
      if (!startedCoordinator || terminal) {
        return payload;
      }
      semanticFinalObserved = true;
      semanticFinalOwned = true;
      markReplyPayloadAsTelegramCurrentDmRecoverySemanticFinal(payload);
      params.onSemanticFinalOwned();
      const outcome = captureDelivery(payload);
      void outcome.promise
        .then((value) => {
          if (value === "delivered") {
            if (!terminal) {
              terminal = "final";
              withCoordinator((coordinator) => coordinator.markFinalAccepted());
            }
            return;
          }
          if (!terminal) {
            terminal = value === "cancelled" ? "cancel" : "error";
            withCoordinator((coordinator) =>
              value === "cancelled" ? coordinator.cancel() : coordinator.markError(),
            );
          }
        })
        .catch(() => {
          if (!terminal) {
            terminal = "error";
            withCoordinator((coordinator) => coordinator.markError());
          }
        });
      return payload;
    },
    noteActivity() {
      withCoordinator((coordinator) => coordinator.noteActivity());
    },
    cancel() {
      if (terminal) {
        return;
      }
      terminal = "cancel";
      withCoordinator((coordinator) => coordinator.cancel());
    },
    markError() {
      if (terminal) {
        return;
      }
      terminal = "error";
      withCoordinator((coordinator) => coordinator.markError());
    },
    ownsSemanticFinal: (payload) =>
      payload ? isTelegramCurrentDmRecoverySemanticFinal(payload) : semanticFinalOwned,
  };
}
