type MtcuteNode = typeof import("@mtcute/node");

let mtcuteNodePromise: Promise<MtcuteNode> | null = null;

async function loadMtcuteNode(): Promise<MtcuteNode> {
  mtcuteNodePromise ??= import("@mtcute/node");
  return mtcuteNodePromise;
}

export async function createTelegramUserClient(params: {
  apiId: number;
  apiHash: string;
  storagePath: string;
}): Promise<import("@mtcute/node").TelegramClient> {
  // When loaded via jiti (plugin loader), dependencies often resolve through the "require" export
  // condition. mtcute prints a deprecation warning from its CommonJS bundle. Dynamic import forces
  // the "import" condition (ESM), eliminating the warning.
  const { BaseTelegramClient, TelegramClient, NodePlatform } = await loadMtcuteNode();

  class ClawdbotTelegramUserPlatform extends NodePlatform {
    // mtcute's default NodePlatform.beforeExit installs SIGINT/SIGTERM handlers that re-send the
    // signal, which can race with Clawdbot's graceful shutdown and close sqlite while writes are
    // pending. We only hook into process exit events (no signal handlers) and rely on Clawdbot to
    // stop cleanly.
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

  const client = new BaseTelegramClient({
    apiId: params.apiId,
    apiHash: params.apiHash,
    storage: params.storagePath,
    platform: new ClawdbotTelegramUserPlatform(),
  });
  return new TelegramClient({ client });
}
