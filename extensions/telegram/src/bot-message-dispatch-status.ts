// Telegram plugin module owns dispatch status-reaction finalization.
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import type { TelegramMessageContext } from "./bot-message-context.js";

export function createTelegramDispatchStatus(params: { context: TelegramMessageContext }) {
  const { context } = params;
  const controller =
    context.ctxPayload.InboundEventKind === "room_event" ? null : context.statusReactionController;
  const finalize = async (final: { outcome: "done" | "error" | "cancelled" }) => {
    if (!controller) {
      return;
    }
    if (final.outcome === "done") {
      await controller.setDone();
    } else if (final.outcome === "error") {
      await controller.setError();
    }
    await controller.restoreInitial();
  };

  const finalizeInBackground = (
    final: { outcome: "done" | "error" | "cancelled" },
    label: string,
  ) => {
    void finalize(final).catch((err: unknown) => {
      logVerbose(`telegram: status reaction ${label} failed: ${String(err)}`);
    });
  };

  return { controller, finalizeInBackground };
}
