import type { ModelAuthOrderSetResult } from "../../../../src/gateway/server-methods/models-auth-status.types.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ModelProviderLogoutTarget } from "./data.ts";
import type { ModelProvidersData } from "./load.ts";

type PendingProfileOrder = {
  cardId: string;
  profileIds: string[] | null;
  optimisticOrder: string[];
};

type ProfileActionsControllerOptions = {
  getAgentEpoch: () => number;
  getAgentId: () => string;
  getClient: () => GatewayBrowserClient | null;
  getClientEpoch: () => number;
  getData: () => ModelProvidersData | null;
  getOrders: () => Record<string, string[]>;
  setData: (data: ModelProvidersData) => void;
  setOrders: (orders: Record<string, string[]>) => void;
  canMutate: () => boolean;
  isBusy: (key: string) => boolean;
  setBusy: (key: string, value: boolean) => void;
  clearProbe: (cardId: string) => void;
  clearMessage: (cardId: string) => void;
  setError: (cardId: string, error: unknown) => void;
  setLogoutSuccess: (cardId: string) => void;
  cancelRefresh: () => void;
  refresh: () => Promise<void>;
  isCurrentClient: (client: GatewayBrowserClient, epoch: number) => boolean;
};

export class ModelProviderProfileActionsController {
  private readonly pendingOrders = new Map<string, PendingProfileOrder>();
  private readonly activeOrderProviders = new Set<string>();

  constructor(private readonly options: ProfileActionsControllerOptions) {}

  resetOrders(): void {
    this.pendingOrders.clear();
    this.options.setOrders({});
  }

  setOrder(cardId: string, provider: string, profileIds: string[] | null): void {
    const providerStatus = this.options
      .getData()
      ?.authStatus?.providers.find((candidate) => candidate.provider === provider);
    const optimisticOrder =
      profileIds ?? providerStatus?.profiles.map((profile) => profile.profileId) ?? [];
    this.options.setOrders({ ...this.options.getOrders(), [provider]: optimisticOrder });
    this.pendingOrders.set(provider, { cardId, profileIds, optimisticOrder });
    this.options.clearMessage(cardId);
    void this.flushOrder(provider);
  }

  flushPendingOrders(): void {
    if (!this.options.canMutate()) {
      return;
    }
    for (const provider of this.pendingOrders.keys()) {
      void this.flushOrder(provider);
    }
  }

  async logout(cardId: string, target: ModelProviderLogoutTarget): Promise<void> {
    const client = this.options.getClient();
    const key = `logout:${cardId}`;
    if (!client || !this.options.canMutate() || this.options.isBusy(key)) {
      return;
    }
    const clientEpoch = this.options.getClientEpoch();
    const agentId = this.options.getAgentId();
    const agentEpoch = this.options.getAgentEpoch();
    const isCurrentScope = () => this.isCurrentScope(client, clientEpoch, agentEpoch, agentId);
    this.options.clearProbe(cardId);
    this.options.setBusy(key, true);
    this.options.clearMessage(cardId);
    try {
      let logoutError: unknown;
      try {
        await client.request("models.authLogout", { ...target, agentId });
      } catch (error) {
        logoutError = error;
      }
      // A logout can change credentials before reporting failure. Refresh either
      // outcome, but never update a different agent or a newer visit to this agent.
      if (!isCurrentScope()) {
        return;
      }
      await this.options.refresh();
      if (!isCurrentScope()) {
        return;
      }
      if (logoutError) {
        this.options.setError(cardId, logoutError);
        return;
      }
      this.options.setLogoutSuccess(cardId);
    } catch (error) {
      if (isCurrentScope()) {
        this.options.setError(cardId, error);
      }
    } finally {
      if (isCurrentScope()) {
        this.options.setBusy(key, false);
      }
    }
  }

  private async flushOrder(provider: string): Promise<void> {
    if (this.activeOrderProviders.has(provider)) {
      return;
    }
    this.activeOrderProviders.add(provider);
    try {
      while (true) {
        const pending = this.pendingOrders.get(provider);
        if (!pending) {
          return;
        }
        const client = this.options.getClient();
        if (!client || !this.options.canMutate()) {
          return;
        }
        this.pendingOrders.delete(provider);
        const clientEpoch = this.options.getClientEpoch();
        const agentEpoch = this.options.getAgentEpoch();
        const agentId = this.options.getAgentId();
        try {
          const result = await client.request<ModelAuthOrderSetResult>("models.authOrderSet", {
            provider,
            ...(pending.profileIds ? { profileIds: pending.profileIds } : {}),
            agentId,
          });
          if (!this.isCurrentScope(client, clientEpoch, agentEpoch, agentId)) {
            return;
          }
          if (pending.profileIds && !result.warning) {
            this.options.cancelRefresh();
            this.applyOrder(provider, pending.profileIds);
            void this.options.refresh();
          } else {
            await this.options.refresh();
            if (!this.isCurrentScope(client, clientEpoch, agentEpoch, agentId)) {
              return;
            }
          }
          if (this.clearOptimisticOrder(provider, pending.optimisticOrder) && result.warning) {
            this.options.setError(pending.cardId, result.warning);
          }
        } catch (error) {
          if (!this.isCurrentScope(client, clientEpoch, agentEpoch, agentId)) {
            return;
          }
          if (this.clearOptimisticOrder(provider, pending.optimisticOrder)) {
            this.options.setError(pending.cardId, error);
          }
        }
      }
    } finally {
      this.activeOrderProviders.delete(provider);
      // A stale save can finish after a new agent queued the same provider.
      // Re-enter after releasing the slot so the new scope's intent is not stranded.
      if (this.pendingOrders.has(provider) && this.options.canMutate()) {
        void this.flushOrder(provider);
      }
    }
  }

  private isCurrentScope(
    client: GatewayBrowserClient,
    clientEpoch: number,
    agentEpoch: number,
    agentId: string,
  ): boolean {
    return (
      this.options.isCurrentClient(client, clientEpoch) &&
      this.options.getAgentEpoch() === agentEpoch &&
      this.options.getAgentId() === agentId
    );
  }

  private clearOptimisticOrder(provider: string, expected: string[]): boolean {
    const orders = this.options.getOrders();
    if (orders[provider] !== expected) {
      return false;
    }
    const next = { ...orders };
    delete next[provider];
    this.options.setOrders(next);
    return true;
  }

  private applyOrder(provider: string, profileIds: string[]): void {
    const data = this.options.getData();
    const authStatus = data?.authStatus;
    if (!data || !authStatus) {
      return;
    }
    const providers = [...authStatus.providers];
    for (const [index, candidate] of providers.entries()) {
      if ((candidate.authProvider ?? candidate.provider) !== provider) {
        continue;
      }
      const { profileOrder: _order, profileOrderStored: _stored, ...base } = candidate;
      providers[index] = {
        ...base,
        profileOrder: [...profileIds],
        profileOrderStored: true,
      };
    }
    this.options.setData({ ...data, authStatus: { ...authStatus, providers } });
  }
}
