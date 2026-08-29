import { initialState, Task } from "@lit/task";
import type { ReactiveControllerHost } from "lit";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { UsageRefreshPolicy } from "../usage/refresh-policy.ts";
import { loadModelProvidersSupplementalData, type ModelProvidersData } from "./load.ts";

type SupplementalGateway = {
  connected: boolean;
  client: GatewayBrowserClient | null;
  epoch: number;
  isCurrent: (params: { client: GatewayBrowserClient; epoch: number }) => boolean;
};

type SupplementalOptions = {
  getGateway: () => SupplementalGateway;
  getData: () => ModelProvidersData | null;
  getDataClient: () => GatewayBrowserClient | null;
  setData: (data: ModelProvidersData) => void;
  setDataClient: (client: GatewayBrowserClient | null) => void;
  refreshPolicy: UsageRefreshPolicy;
};

type SupplementalTaskValue = {
  client: GatewayBrowserClient;
  data: Awaited<ReturnType<typeof loadModelProvidersSupplementalData>>;
  epoch: number;
};

/** Loads usage and cost after the provider controls have their required data. */
export class ModelProviderSupplementalLoader {
  private activeClient: GatewayBrowserClient | null = null;
  private readonly task: Task<[GatewayBrowserClient | null, number], SupplementalTaskValue>;

  constructor(
    host: ReactiveControllerHost,
    private readonly options: SupplementalOptions,
  ) {
    this.task = new Task(host, {
      autoRun: false,
      task: ([client, epoch], { signal }) =>
        client
          ? loadModelProvidersSupplementalData(client, signal).then((data) => ({
              client,
              data,
              epoch,
            }))
          : initialState,
      onComplete: ({ client, data, epoch }) => {
        this.activeClient = null;
        const current = this.options.getData();
        if (
          current &&
          client === this.options.getDataClient() &&
          this.options.getGateway().isCurrent({ client, epoch })
        ) {
          this.options.setData({ ...current, ...data });
          this.options.refreshPolicy.markProviderUsage(data.providerUsage, Date.now(), epoch);
        }
        this.options.refreshPolicy.flushPending();
      },
      onError: () => {
        this.activeClient = null;
        this.options.refreshPolicy.flushPending();
      },
    });
  }

  get loading(): boolean {
    return this.activeClient !== null;
  }

  adoptCoreData(client: GatewayBrowserClient | null, data: ModelProvidersData): void {
    const previous = client === this.options.getDataClient() ? this.options.getData() : null;
    // Keep the last usage snapshot visible until its replacement finishes.
    this.options.setData({
      ...data,
      providerUsage: previous?.providerUsage ?? data.providerUsage,
      costByProvider: previous?.costByProvider ?? data.costByProvider,
    });
    this.options.setDataClient(client);
    if (data.providerUsage !== null) {
      this.options.refreshPolicy.markProviderUsage(
        data.providerUsage,
        data.updatedAt,
        this.options.getGateway().epoch,
      );
    }
    // Core route data leaves both fields empty; populated route data already has its snapshot.
    if (client && !this.loading && data.providerUsage === null && data.costByProvider === null) {
      void this.load(client);
    }
  }

  invalidate(): void {
    this.options.refreshPolicy.interrupt();
    this.activeClient = null;
    void this.task.run([null, this.options.getGateway().epoch]);
  }

  load(explicitClient?: GatewayBrowserClient): Promise<void> {
    const gateway = this.options.getGateway();
    const client = explicitClient ?? gateway.client;
    if (!gateway.connected || !client) {
      this.options.refreshPolicy.markLoadDeferred();
      return Promise.resolve();
    }
    this.options.refreshPolicy.beginLoad();
    this.activeClient = client;
    return this.task.run([client, gateway.epoch]);
  }
}
