import { initialState, Task } from "@lit/task";
import type { ReactiveControllerHost } from "lit";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { loadModelAuthStatus } from "../../lib/model-auth.ts";
import { UsageRefreshPolicy } from "../usage/refresh-policy.ts";
import { loadModelProviderCost, loadModelProviderUsage, type ModelProvidersData } from "./load.ts";

type SupplementalGateway = {
  connected: boolean;
  client: GatewayBrowserClient | null;
  epoch: number;
  isCurrent: (params: { client: GatewayBrowserClient; epoch: number }) => boolean;
};

type SupplementalOptions = {
  getGateway: () => SupplementalGateway;
  getAgentId: () => string;
  getData: () => ModelProvidersData | null;
  getDataClient: () => GatewayBrowserClient | null;
  setData: (data: ModelProvidersData) => void;
  setDataClient: (client: GatewayBrowserClient | null) => void;
  refreshPolicy: UsageRefreshPolicy;
};

type SupplementalKind = "usage" | "cost" | "authStatus";
type SupplementalTaskValue<T> = { client: GatewayBrowserClient; data: T; epoch: number };

/** Loads usage and cost after the provider controls have their required data. */
export class ModelProviderSupplementalLoader {
  private readonly pending = new Set<SupplementalKind>();
  private authStatusRequest: { client: GatewayBrowserClient; epoch: number } | null = null;
  private readonly authStatusTask: Task<
    [GatewayBrowserClient | null, string, number],
    SupplementalTaskValue<Awaited<ReturnType<typeof loadModelAuthStatus>>> & { agentId: string }
  >;
  private readonly usageTask: Task<
    [GatewayBrowserClient | null, number],
    SupplementalTaskValue<Awaited<ReturnType<typeof loadModelProviderUsage>>>
  >;
  private readonly costTask: Task<
    [GatewayBrowserClient | null, number],
    SupplementalTaskValue<Awaited<ReturnType<typeof loadModelProviderCost>>>
  >;

  constructor(
    host: ReactiveControllerHost,
    private readonly options: SupplementalOptions,
  ) {
    this.authStatusTask = new Task(host, {
      autoRun: false,
      task: ([client, agentId, epoch], { signal }) =>
        client && agentId
          ? loadModelAuthStatus(client, { agentId, signal }).then((data) => ({
              client,
              data,
              epoch,
              agentId,
            }))
          : initialState,
      onComplete: ({ client, data: authStatus, epoch, agentId }) => {
        this.authStatusRequest = null;
        this.pending.delete("authStatus");
        const data = this.options.getData();
        if (
          !data ||
          client !== this.options.getDataClient() ||
          agentId !== this.options.getAgentId() ||
          !this.options.getGateway().isCurrent({ client, epoch })
        ) {
          return;
        }
        const updatedAt = Date.now();
        this.options.setData({ ...data, authStatus, updatedAt });
        this.options.refreshPolicy.markProviderUsage(
          data.providerUsage,
          updatedAt,
          epoch,
          authStatus.usageRefreshPending === true,
        );
      },
      onError: () => {
        const request = this.authStatusRequest;
        this.authStatusRequest = null;
        this.pending.delete("authStatus");
        const data = this.options.getData();
        if (
          !request ||
          !data ||
          request.client !== this.options.getDataClient() ||
          !this.options.getGateway().isCurrent(request)
        ) {
          return;
        }
        this.options.refreshPolicy.markProviderUsage(
          data.providerUsage,
          data.updatedAt,
          request.epoch,
          true,
        );
      },
    });
    this.usageTask = this.createTask(
      host,
      "usage",
      loadModelProviderUsage,
      (providerUsage) => ({ providerUsage }),
      (providerUsage, epoch) =>
        this.options.refreshPolicy.markProviderUsage(
          providerUsage,
          Date.now(),
          epoch,
          this.options.getData()?.authStatus?.usageRefreshPending === true,
        ),
    );
    this.costTask = this.createTask(host, "cost", loadModelProviderCost, (costByProvider) => ({
      costByProvider,
    }));
  }

  get loading(): boolean {
    return this.pending.size > 0;
  }

  get usageLoading(): boolean {
    return this.pending.has("usage");
  }

  get authStatusLoading(): boolean {
    return this.pending.has("authStatus");
  }

  adoptCoreData(client: GatewayBrowserClient | null, data: ModelProvidersData): void {
    const previous = client === this.options.getDataClient() ? this.options.getData() : null;
    // Keep the last supplemental snapshot visible until its replacement finishes.
    this.options.setData({
      ...data,
      providerUsage: previous?.providerUsage ?? data.providerUsage,
      costByProvider: previous?.costByProvider ?? data.costByProvider,
    });
    this.options.setDataClient(client);
    const accountUsagePending = data.authStatus?.usageRefreshPending === true;
    if (data.providerUsage !== null || accountUsagePending) {
      this.options.refreshPolicy.markProviderUsage(
        data.providerUsage,
        data.updatedAt,
        this.options.getGateway().epoch,
        accountUsagePending,
      );
    }
    // The same route data can be adopted more than once. Core refresh cancels
    // the prior generation before its replacement reaches this boundary.
    if (client && !this.loading && data.providerUsage === null && data.costByProvider === null) {
      void this.load(client);
    }
  }

  invalidate(): void {
    this.options.refreshPolicy.interrupt();
    this.cancelGeneration();
  }

  beginCoreRefresh(force: boolean): void {
    this.cancelGeneration();
    if (force) {
      this.options.refreshPolicy.resetPayload();
    }
  }

  private cancelGeneration(): void {
    this.pending.clear();
    this.authStatusRequest = null;
    const epoch = this.options.getGateway().epoch;
    void this.authStatusTask.run([null, "", epoch]);
    void this.usageTask.run([null, epoch]);
    void this.costTask.run([null, epoch]);
  }

  load(explicitClient?: GatewayBrowserClient): Promise<void> {
    return this.loadRequests(explicitClient, true);
  }

  loadUsage(): Promise<void> {
    return this.loadRequests(undefined, false);
  }

  loadAuthStatus(agentId: string): Promise<void> {
    const gateway = this.options.getGateway();
    const client = gateway.client;
    if (!agentId || !gateway.connected || !client) {
      this.options.refreshPolicy.markLoadDeferred();
      return Promise.resolve();
    }
    this.pending.add("authStatus");
    this.authStatusRequest = { client, epoch: gateway.epoch };
    return this.authStatusTask.run([client, agentId, gateway.epoch]);
  }

  cancelAuthStatus(): void {
    this.pending.delete("authStatus");
    this.authStatusRequest = null;
    const epoch = this.options.getGateway().epoch;
    void this.authStatusTask.run([null, "", epoch]);
  }

  private async loadRequests(
    explicitClient: GatewayBrowserClient | undefined,
    includeCost: boolean,
  ): Promise<void> {
    const gateway = this.options.getGateway();
    const client = explicitClient ?? gateway.client;
    if (!gateway.connected || !client) {
      this.options.refreshPolicy.markLoadDeferred();
      return;
    }
    this.options.refreshPolicy.beginLoad();
    this.pending.add("usage");
    const usage = this.usageTask.run([client, gateway.epoch]);
    if (!includeCost) {
      await usage;
      return;
    }
    this.pending.add("cost");
    await Promise.all([usage, this.costTask.run([client, gateway.epoch])]);
  }

  private createTask<T>(
    host: ReactiveControllerHost,
    kind: SupplementalKind,
    load: (client: GatewayBrowserClient, signal: AbortSignal) => Promise<T>,
    patch: (data: T) => Partial<Pick<ModelProvidersData, "providerUsage" | "costByProvider">>,
    onComplete?: (data: T, epoch: number) => void,
  ): Task<[GatewayBrowserClient | null, number], SupplementalTaskValue<T>> {
    return new Task(host, {
      autoRun: false,
      task: ([client, epoch], { signal }) =>
        client ? load(client, signal).then((data) => ({ client, data, epoch })) : initialState,
      onComplete: ({ client, data, epoch }) => {
        this.pending.delete(kind);
        const current = this.options.getData();
        if (
          current &&
          client === this.options.getDataClient() &&
          this.options.getGateway().isCurrent({ client, epoch })
        ) {
          this.options.setData({ ...current, ...patch(data) });
          onComplete?.(data, epoch);
        }
        this.options.refreshPolicy.flushPending();
      },
      onError: () => {
        this.pending.delete(kind);
        this.options.refreshPolicy.flushPending();
      },
    });
  }
}
