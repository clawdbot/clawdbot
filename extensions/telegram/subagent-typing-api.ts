// Telegram API module wires detached-subagent progress into typing feedback.
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-entry-contract";
import { logTypingFailure } from "openclaw/plugin-sdk/channel-feedback";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { parseTelegramThreadId } from "./src/outbound-params.js";
import { loadTelegramSendModule } from "./src/send-runtime.js";

const loadTelegramSubagentTyping = createLazyRuntimeModule(
  () => import("./src/subagent-typing.js"),
);

export function registerTelegramSubagentTyping(api: OpenClawPluginApi): void {
  let controllerPromise:
    | Promise<ReturnType<typeof import("./src/subagent-typing.js").createTelegramSubagentTyping>>
    | undefined;

  const getController = () => {
    controllerPromise ??= loadTelegramSubagentTyping().then(({ createTelegramSubagentTyping }) =>
      createTelegramSubagentTyping({
        sendTyping: async (route) => {
          const { sendTypingTelegram } = await loadTelegramSendModule();
          await sendTypingTelegram(route.to, {
            cfg: api.config,
            ...(route.accountId ? { accountId: route.accountId } : {}),
            messageThreadId: parseTelegramThreadId(route.threadId),
          });
        },
        onTypingError: (err, route) => {
          logTypingFailure({
            log: (message) => api.logger.debug?.(message),
            channel: "telegram",
            target: route.to,
            error: err,
          });
        },
      }),
    );
    return controllerPromise;
  };

  api.on("subagent_progress", (event) => {
    void getController()
      .then((controller) => controller.handle(event))
      .catch((err: unknown) => {
        api.logger.debug?.(`telegram subagent typing unavailable: ${String(err)}`);
      });
  });

  api.lifecycle.registerRuntimeLifecycle({
    id: "telegram-subagent-typing",
    cleanup: () =>
      controllerPromise
        ?.then((controller) => controller.dispose())
        .catch((err: unknown) => {
          api.logger.debug?.(`telegram subagent typing cleanup failed: ${String(err)}`);
        }),
  });
}
