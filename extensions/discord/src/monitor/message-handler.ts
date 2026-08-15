// Discord plugin module implements message handler behavior.
import type { Client } from "../internal/discord.js";
import { createDiscordIngressMonitor } from "./ingress.js";
import type { DiscordMessageHandler } from "./listeners.js";
import { createDiscordMessageDispatcher } from "./message-dispatcher.js";

type DiscordMessageHandlerParams = Parameters<typeof createDiscordMessageDispatcher>[0];

type DiscordMessageHandlerWithLifecycle = DiscordMessageHandler & {
  deactivate: () => Promise<void>;
};

export function createDiscordMessageHandler(
  params: DiscordMessageHandlerParams & { client: Client },
): DiscordMessageHandlerWithLifecycle {
  const dispatcher = createDiscordMessageDispatcher(params);
  const createIngressMonitor = params.testing?.createIngressMonitor ?? createDiscordIngressMonitor;
  const ingress = createIngressMonitor({
    accountId: params.accountId,
    client: params.client,
    runtime: params.runtime,
    dispatch: (event, lifecycle) =>
      dispatcher(event, params.client, {
        abortSignal: lifecycle.abortSignal,
        turnAdoptionLifecycle: lifecycle,
      }),
  });
  ingress.start();
  const activeAdmissions = new Set<Promise<void>>();
  let accepting = true;

  const handler: DiscordMessageHandlerWithLifecycle = async (rawMessage) => {
    if (!accepting) {
      return;
    }
    const admission = ingress.accept(rawMessage);
    activeAdmissions.add(admission);
    try {
      await admission;
    } finally {
      activeAdmissions.delete(admission);
    }
  };
  handler.deactivate = async () => {
    accepting = false;
    await Promise.allSettled(activeAdmissions);
    await dispatcher.deactivate();
    await ingress.stop();
  };
  return handler;
}
