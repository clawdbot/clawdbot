import type { GatewayBrowserClient } from "./api/gateway.ts";
import type { WorkboardCapability } from "./lib/workboard/capability.ts";
import { normalizeBoardsPayload } from "./lib/workboard/normalization.ts";
import { getWorkboardState } from "./lib/workboard/runtime.ts";
import type { WorkboardBoardSummary } from "./lib/workboard/types.ts";

type WorkboardCatalogSnapshot = {
  boards: readonly Pick<WorkboardBoardSummary, "id" | "name" | "icon" | "color">[];
  ready: boolean;
};
type WorkboardCatalogRuntime = {
  sync(client: GatewayBrowserClient | null, connected: boolean): void;
  handleGatewayEvent(event: string): void;
  dispose(): void;
};

const WORKBOARD_CHANGED_EVENT = "plugin.workboard.changed";
const RETRY_MS = 2_000;

type CatalogLoad = { client: GatewayBrowserClient; promise: Promise<boolean> };

class WorkboardCatalog implements WorkboardCatalogRuntime {
  private client: GatewayBrowserClient | null = null;
  private connected = false;
  private disposed = false;
  private generation = 0;
  private connectionGeneration = 0;
  private load: CatalogLoad | null = null;
  private retryTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private snapshot: WorkboardCatalogSnapshot = { boards: [], ready: false };

  constructor(
    private readonly onSnapshot: (snapshot: WorkboardCatalogSnapshot) => void,
    private readonly host: WorkboardCapability,
  ) {}

  sync(client: GatewayBrowserClient | null, connected: boolean): void {
    if (this.disposed) {
      return;
    }
    const reconnecting = connected && !this.connected && this.snapshot.ready;
    if (this.connected !== connected || this.client !== client) {
      this.connectionGeneration += 1;
    }
    this.connected = connected;
    if (!connected || !client) {
      if (this.load) {
        // Preserve the cached catalog, but prevent an old request from publishing
        // after disconnect or blocking a fresh load on a fast reconnect.
        this.generation += 1;
        this.load = null;
      }
      this.clearRetry();
      return;
    }
    if (this.client !== client) {
      this.client = client;
      this.generation += 1;
      this.load = null;
      this.publishCatalog([], false);
    }
    this.ensureAndRecover(reconnecting);
  }

  handleGatewayEvent(event: string): void {
    if (event === WORKBOARD_CHANGED_EVENT && this.connected && this.client) {
      this.ensureAndRecover(true);
    }
  }

  dispose(): void {
    this.disposed = true;
    this.connectionGeneration += 1;
    this.generation += 1;
    this.load = null;
    this.clearRetry();
    this.host.clearBoards();
  }

  private ensureAndRecover(force: boolean): void {
    const client = this.client;
    if (!client || !this.connected) {
      return;
    }
    const connectionGeneration = this.connectionGeneration;
    void this.ensure(client, force).then((loaded) => {
      if (
        this.disposed ||
        !this.connected ||
        this.client !== client ||
        connectionGeneration !== this.connectionGeneration
      ) {
        return;
      }
      if (loaded) {
        this.clearRetry();
        return;
      }
      if (!force && this.snapshot.ready) {
        return;
      }
      if (this.retryTimer === null) {
        this.retryTimer = globalThis.setTimeout(() => {
          this.retryTimer = null;
          this.ensureAndRecover(true);
        }, RETRY_MS);
      }
    });
  }

  private async ensure(client: GatewayBrowserClient, force: boolean): Promise<boolean> {
    if (this.disposed || !this.connected || this.client !== client) {
      return false;
    }
    if (!force && this.snapshot.ready) {
      return false;
    }
    const currentLoad = this.load;
    if (currentLoad?.client === client) {
      const loaded = await currentLoad.promise;
      if (this.disposed || !this.connected || this.client !== client) {
        return false;
      }
      if (!force) {
        return loaded;
      }
      if (this.load && this.load !== currentLoad) {
        return await this.load.promise;
      }
      if (this.load === currentLoad) {
        this.load = null;
      }
      return await this.ensure(client, true);
    }
    const generation = ++this.generation;
    const pending = (async () => {
      try {
        const boards = normalizeBoardsPayload(await client.request("workboard.boards.list", {}));
        if (
          !boards ||
          this.disposed ||
          !this.connected ||
          this.client !== client ||
          generation !== this.generation
        ) {
          return false;
        }
        this.publishCatalog(boards, true);
        return true;
      } catch {
        return false;
      }
    })();
    const load = { client, promise: pending };
    this.load = load;
    try {
      return await pending;
    } finally {
      if (this.load === load) {
        this.load = null;
      }
    }
  }

  private publishCatalog(boards: WorkboardBoardSummary[], ready: boolean): void {
    getWorkboardState(this.host).boards = boards;
    this.host.setBoardsReady(ready);
    this.host.notify();
    const snapshot: WorkboardCatalogSnapshot = {
      boards: boards.map(({ id, name, icon, color }) => ({
        id,
        ...(name ? { name } : {}),
        ...(icon ? { icon } : {}),
        ...(color ? { color } : {}),
      })),
      ready,
    };
    this.snapshot = snapshot;
    this.onSnapshot(snapshot);
  }

  private clearRetry(): void {
    if (this.retryTimer !== null) {
      globalThis.clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }
}

export function createWorkboardCatalogRuntime(
  onSnapshot: (snapshot: WorkboardCatalogSnapshot) => void,
  host: WorkboardCapability,
): WorkboardCatalogRuntime {
  return new WorkboardCatalog(onSnapshot, host);
}
