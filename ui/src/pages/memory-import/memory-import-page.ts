import { consume } from "@lit/context";
import { initialState, Task, TaskStatus } from "@lit/task";
import { html } from "lit";
import { state } from "lit/decorators.js";
import type {
  MigrationsMemoryApplyResult,
  MigrationsMemoryPlanResult,
} from "../../../../packages/gateway-protocol/src/schema/migrations.js";
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

  @state() private replaceExisting = false;
  @state() private selectedByProvider: Record<string, string[]> = {};
  @state() private applyingProviderId: string | null = null;
  @state() private pendingImport: PendingMemoryImport | null = null;
  @state() private applyError: string | null = null;
  @state() private lastResults: Record<string, MigrationsMemoryApplyResult> = {};

  private applyEpoch = 0;
  private lastPlanValue: {
    client: NonNullable<ApplicationContext["gateway"]["snapshot"]["client"]>;
    agentId: string;
    overwrite: boolean;
    plan: MigrationsMemoryPlanResult;
  } | null = null;
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

  private readonly planTask = new Task(this, {
    args: () => {
      const snapshot = this.context?.gateway.snapshot;
      return [
        this.isConnected && snapshot?.phase === "connected" ? (snapshot.client ?? null) : null,
        this.currentAgentId(),
        this.replaceExisting,
      ] as const;
    },
    task: async ([client, agentId, overwrite], { signal }) => {
      if (!client || !agentId) {
        return initialState;
      }
      const plan = await client.request<MigrationsMemoryPlanResult>(
        "migrations.memory.plan",
        { agentId, overwrite },
        { signal },
      );
      return { client, agentId, overwrite, plan };
    },
    onComplete: (value) => {
      const previous = this.lastPlanValue;
      if (
        previous &&
        (previous.client !== value.client ||
          previous.agentId !== value.agentId ||
          previous.overwrite !== value.overwrite)
      ) {
        this.resetMutationState({ preserveAttemptedImport: previous.client !== value.client });
      }
      this.lastPlanValue = value;
      const { plan } = value;
      this.selectedByProvider = Object.fromEntries(
        plan.providers.map((provider) => [
          provider.providerId,
          provider.items.filter((item) => item.status === "planned").map((item) => item.id),
        ]),
      );
    },
  });

  override disconnectedCallback() {
    void this.planTask.run([null, null, this.replaceExisting]);
    this.applyEpoch += 1;
    this.subscriptions.clear();
    super.disconnectedCallback();
  }

  override updated() {
    const snapshot = this.context.gateway.snapshot;
    if (!this.context.agents.state.agentsList) {
      void this.context.agents.ensureList();
    }
    if (
      this.pendingImport &&
      (snapshot.phase !== "connected" ||
        snapshot.client !== (this.planTask.value ?? this.lastPlanValue)?.client ||
        this.currentAgentId() !== this.pendingImport.agentId)
    ) {
      this.resetMutationState({ preserveAttemptedImport: true });
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

  private get plan(): MigrationsMemoryPlanResult | null {
    const value = this.planTask.value ?? this.lastPlanValue;
    const snapshot = this.context.gateway.snapshot;
    const agentId = this.currentAgentId();
    return value &&
      snapshot.phase === "connected" &&
      value.client === snapshot.client &&
      value.agentId === agentId &&
      value.overwrite === this.replaceExisting
      ? value.plan
      : null;
  }

  private get loading(): boolean {
    return this.planTask.status === TaskStatus.PENDING;
  }

  private get error(): string | null {
    return this.planTask.status === TaskStatus.ERROR ? toErrorMessage(this.planTask.error) : null;
  }

  private resetMutationState(options: { preserveAttemptedImport?: boolean } = {}) {
    // A disconnected apply has an unknown outcome. Keep its key so reconnect retries can
    // recover the cached server result instead of repeating side effects.
    const pendingImport =
      options.preserveAttemptedImport && this.pendingImport?.attempted ? this.pendingImport : null;
    this.applyEpoch += 1;
    this.selectedByProvider = {};
    this.applyingProviderId = null;
    this.pendingImport = pendingImport;
    this.applyError = null;
    this.lastResults = {};
  }

  private refresh(): Promise<void> {
    return this.planTask.run();
  }

  private selectAgent(agentId: string) {
    this.context.agentSelection.set(agentId);
    this.resetMutationState();
  }

  private setReplaceExisting(enabled: boolean) {
    this.replaceExisting = enabled;
    this.resetMutationState();
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
    const client = snapshot.client;
    this.pendingImport = attemptedImport;
    const applyEpoch = ++this.applyEpoch;
    this.applyingProviderId = attemptedImport.providerId;
    this.applyError = null;
    try {
      const result = await client.request<MigrationsMemoryApplyResult>("migrations.memory.apply", {
        idempotencyKey: attemptedImport.idempotencyKey,
        agentId: attemptedImport.agentId,
        providerId: attemptedImport.providerId,
        planFingerprint: attemptedImport.planFingerprint,
        itemIds: attemptedImport.itemIds,
        overwrite: attemptedImport.overwrite,
      });
      if (
        applyEpoch !== this.applyEpoch ||
        this.context.gateway.snapshot.phase !== "connected" ||
        this.context.gateway.snapshot.client !== client ||
        this.currentAgentId() !== attemptedImport.agentId
      ) {
        return;
      }
      this.lastResults = { ...this.lastResults, [attemptedImport.providerId]: result };
      this.pendingImport = null;
      await this.refresh();
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
      onRefresh: () => void this.refresh(),
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
