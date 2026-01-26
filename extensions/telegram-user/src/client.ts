import { BaseTelegramClient, NodePlatform, TelegramClient } from "@mtcute/node";

class ClawdbotTelegramUserPlatform extends NodePlatform {
  // mtcute's NodePlatform.beforeExit installs SIGINT/SIGTERM handlers that re-send the signal,
  // which can race with Clawdbot's graceful shutdown and close sqlite while writes are pending.
  // We only hook into process exit events (no signal handlers) and rely on Clawdbot to stop cleanly.
  override beforeExit(fn: () => void): () => void {
    const onBeforeExit = () => fn();
    const onExit = () => fn();
    process.once("beforeExit", onBeforeExit);
    process.once("exit", onExit);
    return () => {
      process.off("beforeExit", onBeforeExit);
      process.off("exit", onExit);
    };
  }
}

export function createTelegramUserClient(params: {
  apiId: number;
  apiHash: string;
  storagePath: string;
}) {
  const client = new BaseTelegramClient({
    apiId: params.apiId,
    apiHash: params.apiHash,
    storage: params.storagePath,
    platform: new ClawdbotTelegramUserPlatform(),
  });
  return new TelegramClient({ client });
}
