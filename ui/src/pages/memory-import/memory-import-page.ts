import { consume } from "@lit/context";
import { html } from "lit";
import { state } from "lit/decorators.js";
import type {
  MigrationsMemoryApplyResult,
  MigrationsMemoryPlanResult,
} from "../../../../packages/gateway-protocol/src/schema/migrations.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { titleForRoute } from "../../app-navigation.ts";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { renderSettingsWorkspace } from "../../components/settings-workspace.ts";
import { listSelectableAgents } from "../../lib/agents/display.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import { renderMemoryImport } from "./view.ts";

type PendingMemoryImport = {
  providerId: string;
  agentId: string;
  planFingerprint: string;
  itemIds: string[];
  overwrite: boolean;
  idempotencyKey: string;
  attempted: boolean;
};

function toErrorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim()
    ? error.message
    : typeof error === "string"
      ? error
      : "request failed";
}

function createIdempotencyKey(): string {
  if (typeof globalThis.crypto.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return [...globalThis.crypto.getRandomValues(new Uint32Array(4))]
    .map((value) => value.toString(16).padStart(8, "0"))
    .join("");
}

export class MemoryImportPage extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context!: ApplicationContext;

  @state() private plan: MigrationsMemoryPlanResult | null = null;
  @state() private loading = false;
  @state() private error: string | null = null;
  @state() private replaceExisting = false;
  @state() private selectedByProvider: Record<string, string[]> = {};
  @state() private applyingProviderId: string | null = null;
  @state() private pendingImport: PendingMemoryImport | null = null;
  @state() private applyError: string | null = null;
  @state() private lastResults: Record<string, MigrationsMemoryApplyResult> = {};

  private loadedKey: string | null = null;
  private requestedKey: string | null = null;
  private loadedClient: GatewayBrowserClient | null = null;
  private requestedClient: GatewayBrowserClient | null = null;
  private refreshEpoch = 0;
  private applyEpoch = 0;
  private gatewayUnavailable = false;
  private readonly subscriptions = new SubscriptionsController(this)
    .watch(
      () => this.context?.gateway,
      (gateway, notify) => gateway.subscribe(notify),
    )
    .watch(
      () => this.context?.agents,
      (agents, notify) => agents.subscribe(notify),
    )
    .watch(
      () => this.context?.agentSelection,
      (selection, notify) => selection.subscribe(notify),
    );

  override disconnectedCallback() {
    this.refreshEpoch += 1;
    this.applyEpoch += 1;
    this.subscriptions.clear();
    super.disconnectedCallback();
  }

  override updated() {
    const snapshot = this.context.gateway.snapshot;
    if (snapshot.phase !== "connected" || !snapshot.client) {
      if (!this.gatewayUnavailable) {
        this.gatewayUnavailable = true;
        this.resetPlanState({ preserveAttemptedImport: true });
      }
      return;
    }
    this.gatewayUnavailable = false;
    if (!this.context.agents.state.agentsList) {
      void this.context.agents.ensureList();
      return;
    }
    const agentId = this.currentAgentId();
    if (!agentId) {
      return;
    }
    const key = this.planKey(agentId);
    const activeClient = this.requestedClient ?? this.loadedClient;
    const activeKey = this.requestedKey ?? this.loadedKey;
    if (
      (activeClient !== null && activeClient !== snapshot.client) ||
      (activeKey !== null && activeKey !== key)
    ) {
      this.resetPlanState({
        preserveAttemptedImport: activeClient !== null && activeClient !== snapshot.client,
      });
    }
    if (
      !this.loading &&
      (this.loadedClient !== snapshot.client || this.loadedKey !== key) &&
      (this.requestedClient !== snapshot.client || this.requestedKey !== key)
    ) {
      void this.refresh();
    }
  }

  private currentAgentId(): string | null {
    const list = this.context.agents.state.agentsList;
    if (!list) {
      return null;
    }
    const agents = listSelectableAgents(list.agents);
    const selected = this.context.agentSelection.state.selectedId;
    if (selected && agents.some((agent) => agent.id === selected)) {
      return selected;
    }
    return agents.some((agent) => agent.id === list.defaultId)
      ? list.defaultId
      : (agents[0]?.id ?? null);
  }

  private planKey(agentId: string): string {
    return `${agentId}:${this.replaceExisting ? "replace" : "safe"}`;
  }

  private resetPlanState(options: { preserveAttemptedImport?: boolean } = {}) {
    // A disconnected apply has an unknown outcome. Keep its key so reconnect retries can
    // recover the cached server result instead of repeating side effects.
    const pendingImport =
      options.preserveAttemptedImport && this.pendingImport?.attempted ? this.pendingImport : null;
    this.refreshEpoch += 1;
    this.applyEpoch += 1;
    this.plan = null;
    this.loading = false;
    this.error = null;
    this.selectedByProvider = {};
    this.applyingProviderId = null;
    this.pendingImport = pendingImport;
    this.applyError = null;
    this.lastResults = {};
    this.loadedKey = null;
    this.requestedKey = null;
    this.loadedClient = null;
    this.requestedClient = null;
  }

  private async refresh(force = false) {
    const snapshot = this.context.gateway.snapshot;
    const agentId = this.currentAgentId();
    if (snapshot.phase !== "connected" || !snapshot.client || !agentId || this.loading) {
      return;
    }
    const client = snapshot.client;
    const key = this.planKey(agentId);
    if (!force && this.loadedClient === client && this.loadedKey === key) {
      return;
    }
    const epoch = ++this.refreshEpoch;
    this.requestedKey = key;
    this.requestedClient = client;
    this.loading = true;
    this.error = null;
    try {
      const plan = await client.request<MigrationsMemoryPlanResult>("migrations.memory.plan", {
        agentId,
        overwrite: this.replaceExisting,
      });
      if (epoch !== this.refreshEpoch) {
        return;
      }
      this.plan = plan;
      this.loadedKey = key;
      this.loadedClient = client;
      this.selectedByProvider = Object.fromEntries(
        plan.providers.map((provider) => [
          provider.providerId,
          provider.items.filter((item) => item.status === "planned").map((item) => item.id),
        ]),
      );
    } catch (error) {
      if (epoch === this.refreshEpoch) {
        this.error = toErrorMessage(error);
        // Record the attempted key so reactive updates keep the stable error.
        // The Refresh action explicitly retries with force=true.
        this.loadedKey = key;
        this.loadedClient = client;
      }
    } finally {
      if (epoch === this.refreshEpoch) {
        this.loading = false;
        this.requestedKey = null;
        this.requestedClient = null;
      }
    }
  }

  private selectAgent(agentId: string) {
    this.context.agentSelection.set(agentId);
    this.resetPlanState();
  }

  private setReplaceExisting(enabled: boolean) {
    this.replaceExisting = enabled;
    this.resetPlanState();
  }

  private toggleCollection(providerId: string, itemIds: readonly string[], selected: boolean) {
    const next = new Set(this.selectedByProvider[providerId] ?? []);
    for (const itemId of itemIds) {
      if (selected) {
        next.add(itemId);
      } else {
        next.delete(itemId);
      }
    }
    this.selectedByProvider = { ...this.selectedByProvider, [providerId]: [...next] };
  }

  private requestImport(providerId: string) {
    const agentId = this.currentAgentId();
    const planFingerprint = this.plan?.providers.find(
      (provider) => provider.providerId === providerId,
    )?.planFingerprint;
    const itemIds = this.selectedByProvider[providerId] ?? [];
    if (
      this.loading ||
      this.error !== null ||
      this.applyingProviderId !== null ||
      !agentId ||
      this.plan?.agentId !== agentId ||
      !planFingerprint ||
      itemIds.length === 0
    ) {
      return;
    }
    this.applyError = null;
    this.pendingImport = {
      providerId,
      agentId,
      planFingerprint,
      itemIds: [...itemIds],
      overwrite: this.replaceExisting,
      idempotencyKey: createIdempotencyKey(),
      attempted: false,
    };
  }

  private async confirmImport() {
    if (this.applyingProviderId !== null) {
      return;
    }
    const pending = this.pendingImport;
    const snapshot = this.context.gateway.snapshot;
    if (
      !pending ||
      !snapshot.client ||
      this.currentAgentId() !== pending.agentId ||
      this.plan?.agentId !== pending.agentId
    ) {
      return;
    }
    const attemptedImport = { ...pending, attempted: true };
    this.pendingImport = attemptedImport;
    const applyEpoch = ++this.applyEpoch;
    this.applyingProviderId = attemptedImport.providerId;
    this.applyError = null;
    try {
      const result = await snapshot.client.request<MigrationsMemoryApplyResult>(
        "migrations.memory.apply",
        {
          idempotencyKey: attemptedImport.idempotencyKey,
          agentId: attemptedImport.agentId,
          providerId: attemptedImport.providerId,
          planFingerprint: attemptedImport.planFingerprint,
          itemIds: attemptedImport.itemIds,
          overwrite: attemptedImport.overwrite,
        },
      );
      if (applyEpoch !== this.applyEpoch) {
        return;
      }
      this.lastResults = { ...this.lastResults, [attemptedImport.providerId]: result };
      this.pendingImport = null;
      this.loadedKey = null;
      this.requestedKey = null;
      this.loadedClient = null;
      this.requestedClient = null;
      await this.refresh(true);
    } catch (error) {
      if (applyEpoch === this.applyEpoch) {
        this.applyError = toErrorMessage(error);
      }
    } finally {
      if (applyEpoch === this.applyEpoch) {
        this.applyingProviderId = null;
      }
    }
  }

  override render() {
    const snapshot = this.context.gateway.snapshot;
    const agentsList = this.context.agents.state.agentsList;
    const agentId = this.currentAgentId();
    const body = renderMemoryImport({
      connected: snapshot.phase === "connected",
      agents: listSelectableAgents(agentsList?.agents ?? []),
      selectedAgentId: agentId,
      plan: this.plan,
      loading: this.loading,
      error: this.error,
      applyError: this.applyError,
      replaceExisting: this.replaceExisting,
      selectedByProvider: this.selectedByProvider,
      applyingProviderId: this.applyingProviderId,
      pendingProviderId:
        this.pendingImport?.agentId === agentId ? this.pendingImport.providerId : null,
      lastResults: this.lastResults,
      onSelectAgent: (nextAgentId) => this.selectAgent(nextAgentId),
      onReplaceExisting: (enabled) => this.setReplaceExisting(enabled),
      onRefresh: () => void this.refresh(true),
      onToggleCollection: (providerId, itemIds, selected) =>
        this.toggleCollection(providerId, itemIds, selected),
      onRequestImport: (providerId) => this.requestImport(providerId),
      onConfirmImport: () => void this.confirmImport(),
      onCancelImport: () => {
        if (this.applyingProviderId === null) {
          this.pendingImport = null;
          this.applyError = null;
        }
      },
    });
    return html`
      <section class="content-header">
        <div>
          <div class="page-title">${titleForRoute("memory-import")}</div>
        </div>
      </section>
      ${renderSettingsWorkspace(body)}
    `;
  }
}

if (!customElements.get("openclaw-memory-import-page")) {
  customElements.define("openclaw-memory-import-page", MemoryImportPage);
}
