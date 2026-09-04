import type { OpenClawLeasedExecServer } from "./sandbox-exec-server/types.js";

export const sandboxExecServerRegistry = {
  servers: new Map<string, Promise<OpenClawLeasedExecServer>>(),
  async close(server: OpenClawLeasedExecServer): Promise<void> {
    if (server.closed) {
      return;
    }
    server.closed = true;
    if ("node" in server) {
      for (const lease of server.node.leases.values()) {
        if (!lease.closed) {
          lease.closed = true;
          lease.channel.close();
        }
      }
      server.node.leases.clear();
    }
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
