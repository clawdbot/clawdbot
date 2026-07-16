// Telegram plugin module owns dispatch status-reaction finalization.
import {
  DEFAULT_TIMING,
  logAckFailure,
  removeAckReactionAfterReply,
} from "openclaw/plugin-sdk/channel-feedback";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { logVerbose, sleepWithAbort } from "openclaw/plugin-sdk/runtime-env";
import type { TelegramMessageContext } from "./bot-message-context.js";

export function createTelegramDispatchStatus(params: {
  cfg: OpenClawConfig;
  context: TelegramMessageContext;
}) {
  const { context } = params;
  const controller =
    context.ctxPayload.InboundEventKind === "room_event" ? null : context.statusReactionController;
  const timing = { ...DEFAULT_TIMING, ...params.cfg.messages?.statusReactions?.timing };

  const clear = async () => {
    if (!context.msg.message_id || !context.reactionApi) {
      return;
    }
    await context.reactionApi(context.chatId, context.msg.message_id, []);
  };

  const finalize = async (final: { outcome: "done" | "error"; hasFinalResponse: boolean }) => {
    if (!controller) {
      return;
    }
    if (final.outcome === "done") {
      await controller.setDone();
      if (context.removeAckAfterReply) {
        await sleepWithAbort(timing.doneHoldMs);
        await clear();
      } else {
        await controller.restoreInitial();
      }
      return;
    }
    await controller.setError();
    if (final.hasFinalResponse) {
      if (context.removeAckAfterReply) {
        await sleepWithAbort(timing.errorHoldMs);
        await clear();
      } else {
        await controller.restoreInitial();
      }
      return;
    }
    if (context.removeAckAfterReply) {
      await sleepWithAbort(timing.errorHoldMs);
    }
    await controller.restoreInitial();
  };

  const removeAck = () => {
    removeAckReactionAfterReply({
      removeAfterReply: context.removeAckAfterReply,
      ackReactionPromise: context.ackReactionPromise,
      ackReactionValue: context.ackReactionPromise ? "ack" : null,
      remove: () =>
        (
          context.reactionApi?.(context.chatId, context.msg.message_id ?? 0, []) ??
          Promise.resolve()
        ).then(() => {}),
      onError: (err) => {
        if (!context.msg.message_id) {
          return;
        }
        logAckFailure({
          log: logVerbose,
          channel: "telegram",
          target: `${context.chatId}/${context.msg.message_id}`,
          error: err,
        });
      },
    });
  };

  const finalizeInBackground = (
    final: { outcome: "done" | "error"; hasFinalResponse: boolean },
    label: string,
  ) => {
    void finalize(final).catch((err: unknown) => {
      logVerbose(`telegram: status reaction ${label} failed: ${String(err)}`);
    });
  };

  return { controller, finalizeInBackground, removeAck };
}
