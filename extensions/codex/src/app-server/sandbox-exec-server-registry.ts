import type { OpenClawExecServer } from "./sandbox-exec-server/types.js";

export const sandboxExecServerRegistry = {
  servers: new Map<string, Promise<OpenClawExecServer>>(),
  async close(server: OpenClawExecServer): Promise<void> {
    if (server.closed) {
      return;
    }
    server.closed = true;
    for (const client of server.server.clients) {
      client.close(1001, "shutdown");
    }
    await new Promise<void>((resolve) => {
      server.server.close(() => resolve());
    });
    const cleanup = await Promise.allSettled([
      ...server.cleanupTasks,
      ...[...server.children].map(async (child) => await child.terminate()),
    ]);
    const failures = cleanup.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (failures.length > 0) {
      throw new AggregateError(failures, "Codex sandbox exec-server child cleanup failed");
    }
  },
  async closeAll(): Promise<void> {
    const servers = await Promise.allSettled(this.servers.values());
    this.servers.clear();
    await Promise.all(
      servers.map(async (entry) => {
        if (entry.status !== "fulfilled") {
          return;
        }
        const server = entry.value;
        server.refCount = 0;
        await this.close(server);
      }),
    );
  },
};
