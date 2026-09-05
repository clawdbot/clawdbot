import type { ReactionTypeEmoji } from "grammy/types";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import type { BuildTelegramMessageContextParams } from "./bot-message-context.types.js";

export type TelegramReactionApi = (
  chatId: BuildTelegramMessageContextParams["primaryCtx"]["message"]["chat"]["id"],
  messageId: number,
  reactions: Array<{ type: "emoji"; emoji: ReactionTypeEmoji["emoji"] }>,
) => Promise<unknown>;

export type TelegramStatusReactionController = {
  setQueued: () => void | Promise<void>;
  setThinking: () => void | Promise<void>;
  setTool: (name: string) => void | Promise<void>;
  setCompacting: () => void | Promise<void>;
  cancelPending: () => void;
  setError: () => void | Promise<void>;
  setDone: () => void | Promise<void>;
  restoreInitial: () => void | Promise<void>;
};

export function createTelegramStatusReactionGate(
  controller: TelegramStatusReactionController | null,
  deferred: boolean,
): {
  controller: TelegramStatusReactionController | null;
  open: () => void;
} {
  if (!controller || !deferred) {
    return { controller, open: () => undefined };
  }
  let open = false;
  const pending: Array<() => void | Promise<void>> = [];
  const run = (operation: () => void | Promise<void>) => {
    if (open) {
      return operation();
    }
    pending.push(operation);
  };
  const runAsync = async (operation: () => void | Promise<void>) => {
    if (open) {
      await operation();
      return;
    }
    pending.push(operation);
  };
  return {
    controller: {
      setQueued: () => run(() => controller.setQueued()),
      setThinking: () => run(() => controller.setThinking()),
      setTool: (name) => run(() => controller.setTool(name)),
      setCompacting: () => run(() => controller.setCompacting()),
      cancelPending: () => {
        void run(() => controller.cancelPending());
      },
      setDone: async () => await runAsync(() => controller.setDone()),
      setError: async () => await runAsync(() => controller.setError()),
      restoreInitial: async () => await runAsync(() => controller.restoreInitial()),
    },
    open: () => {
      if (open) {
        return;
      }
      open = true;
      const operations = pending.splice(0);
      void (async () => {
        for (const operation of operations) {
          try {
            await operation();
          } catch (error) {
            // Deferred feedback is optional, but every failure must be observed so a rejected
            // Telegram API call cannot become an unhandled process rejection.
            logVerbose(`telegram deferred status reaction failed: ${String(error)}`);
          }
        }
      })();
    },
  };
}
