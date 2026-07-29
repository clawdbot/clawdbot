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
import { isGatewayMethodAdvertised } from "../../lib/gateway-methods.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import {
  renderMemoryImport,
  type SessionBackfillGatewayResult,
  type SessionBackfillProgress,
  type SessionBackfillRollbackResult,
} from "./view.ts";

const SESSION_BACKFILL_BATCH_DAYS = 14;

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
  @state() private backfillFrom = "";
  @state() private backfillTo = "";
  @state() private backfillBusy: "preview" | "apply" | "rollback" | null = null;
  @state() private backfillError: string | null = null;
  @state() private backfillPreview: SessionBackfillGatewayResult | null = null;
  @state() private backfillProgress: SessionBackfillProgress | null = null;
  @state() private backfillRollbackResult: SessionBackfillRollbackResult | null = null;
  @state() private backfillRollbackPending = false;

  private applyEpoch = 0;
  private backfillEpoch = 0;
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
        if (previous.client !== value.client || previous.agentId !== value.agentId) {
          this.resetBackfillState();
        }
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
    this.backfillEpoch += 1;
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
    if (
      snapshot.phase !== "connected" &&
      (this.backfillBusy !== null || this.backfillRollbackPending)
    ) {
      this.resetBackfillState();
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
    this.resetBackfillState();
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
      this.backfillBusy === "apply" ||
      this.backfillBusy === "rollback" ||
      this.backfillRollbackPending ||
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
    if (
      this.applyingProviderId !== null ||
      this.backfillBusy === "apply" ||
      this.backfillBusy === "rollback" ||
      this.backfillRollbackPending
    ) {
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

  private resetBackfillState() {
    this.backfillEpoch += 1;
    this.backfillFrom = "";
    this.backfillTo = "";
    this.backfillBusy = null;
    this.backfillError = null;
    this.backfillPreview = null;
    this.backfillProgress = null;
    this.backfillRollbackResult = null;
    this.backfillRollbackPending = false;
  }

  private backfillRequest(agentId: string) {
    return {
      agentId,
      ...(this.backfillFrom ? { from: this.backfillFrom } : {}),
      ...(this.backfillTo ? { to: this.backfillTo } : {}),
      limitDays: SESSION_BACKFILL_BATCH_DAYS,
    };
  }

  private isCurrentBackfillRequest(
    epoch: number,
    client: NonNullable<ApplicationContext["gateway"]["snapshot"]["client"]>,
    agentId: string,
  ): boolean {
    return (
      epoch === this.backfillEpoch &&
      this.context.gateway.snapshot.phase === "connected" &&
      this.context.gateway.snapshot.client === client &&
      this.currentAgentId() === agentId
    );
  }

  private async previewBackfill() {
    const snapshot = this.context.gateway.snapshot;
    const client = snapshot.client;
    const agentId = this.currentAgentId();
    if (!client || !agentId || this.backfillBusy !== null || this.applyingProviderId !== null) {
      return;
    }
    const epoch = ++this.backfillEpoch;
    this.backfillBusy = "preview";
    this.backfillError = null;
    this.backfillPreview = null;
    this.backfillProgress = null;
    this.backfillRollbackResult = null;
    try {
      const result = await client.request<SessionBackfillGatewayResult>(
        "memory.sessionBackfill.preview",
        this.backfillRequest(agentId),
      );
      if (this.isCurrentBackfillRequest(epoch, client, agentId)) {
        this.backfillPreview = result;
      }
    } catch (error) {
      if (this.isCurrentBackfillRequest(epoch, client, agentId)) {
        this.backfillError = toErrorMessage(error);
      }
    } finally {
      if (this.isCurrentBackfillRequest(epoch, client, agentId)) {
        this.backfillBusy = null;
      }
    }
  }

  private async applyBackfill() {
    const snapshot = this.context.gateway.snapshot;
    const client = snapshot.client;
    const agentId = this.currentAgentId();
    if (!client || !agentId || this.backfillBusy !== null || this.applyingProviderId !== null) {
      return;
    }
    const epoch = ++this.backfillEpoch;
    this.backfillBusy = "apply";
    this.backfillError = null;
    this.backfillPreview = null;
    this.backfillRollbackResult = null;
    this.backfillProgress = {
      days: 0,
      candidates: 0,
      staged: 0,
      complete: false,
    };
    let progress = this.backfillProgress;
    const processedDays = new Set<string>();
    try {
      while (true) {
        const chunk = await client.request<SessionBackfillGatewayResult>(
          "memory.sessionBackfill.apply",
          this.backfillRequest(agentId),
        );
        if (!this.isCurrentBackfillRequest(epoch, client, agentId)) {
          return;
        }
        if (chunk.candidates > 0 && chunk.cursor?.advanced !== true) {
          throw new Error("Session backfill stopped because the server cursor did not advance.");
        }
        if (chunk.candidates === 0 && chunk.cursor?.exhausted !== true) {
          throw new Error("Session backfill stopped because the server cursor was not exhausted.");
        }
        for (const day of chunk.perDay) {
          processedDays.add(day.day);
        }
        progress = {
          days: processedDays.size,
          candidates: progress.candidates + chunk.candidates,
          staged: progress.staged + chunk.staged,
          complete: chunk.candidates === 0,
        };
        this.backfillProgress = progress;
        // A zero-candidate call is the idempotent completion sentinel; cursor metadata proves
        // that the server's persisted scan agrees before the client stops driving chunks.
        if (chunk.candidates === 0) {
          break;
        }
      }
    } catch (error) {
      if (this.isCurrentBackfillRequest(epoch, client, agentId)) {
        this.backfillError = toErrorMessage(error);
      }
    } finally {
      if (this.isCurrentBackfillRequest(epoch, client, agentId)) {
        this.backfillBusy = null;
      }
    }
  }

  private async confirmBackfillRollback() {
    const snapshot = this.context.gateway.snapshot;
    const client = snapshot.client;
    const agentId = this.currentAgentId();
    if (
      !client ||
      !agentId ||
      this.backfillBusy !== null ||
      this.applyingProviderId !== null ||
      !this.backfillRollbackPending
    ) {
      return;
    }
    const epoch = ++this.backfillEpoch;
    this.backfillBusy = "rollback";
    this.backfillError = null;
    try {
      const result = await client.request<SessionBackfillRollbackResult>(
        "memory.sessionBackfill.rollback",
        { agentId },
      );
      if (this.isCurrentBackfillRequest(epoch, client, agentId)) {
        this.backfillRollbackResult = result;
        this.backfillPreview = null;
        this.backfillProgress = null;
        this.backfillRollbackPending = false;
      }
    } catch (error) {
      if (this.isCurrentBackfillRequest(epoch, client, agentId)) {
        this.backfillError = toErrorMessage(error);
      }
    } finally {
      if (this.isCurrentBackfillRequest(epoch, client, agentId)) {
        this.backfillBusy = null;
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
      backfillAvailable:
        isGatewayMethodAdvertised(snapshot, "memory.sessionBackfill.preview") !== false,
      backfillFrom: this.backfillFrom,
      backfillTo: this.backfillTo,
      backfillBusy: this.backfillBusy,
      backfillError: this.backfillError,
      backfillPreview: this.backfillPreview,
      backfillProgress: this.backfillProgress,
      backfillRollbackResult: this.backfillRollbackResult,
      backfillRollbackPending: this.backfillRollbackPending,
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
      onBackfillFromChange: (value) => {
        this.backfillFrom = value;
        this.backfillPreview = null;
        this.backfillProgress = null;
        this.backfillRollbackResult = null;
        this.backfillError = null;
      },
      onBackfillToChange: (value) => {
        this.backfillTo = value;
        this.backfillPreview = null;
        this.backfillProgress = null;
        this.backfillRollbackResult = null;
        this.backfillError = null;
      },
      onBackfillPreview: () => void this.previewBackfill(),
      onBackfillApply: () => void this.applyBackfill(),
      onBackfillRollbackRequest: () => {
        if (this.backfillBusy === null) {
          this.backfillRollbackPending = true;
          this.backfillError = null;
        }
      },
      onBackfillRollbackConfirm: () => void this.confirmBackfillRollback(),
      onBackfillRollbackCancel: () => {
        if (this.backfillBusy === null) {
          this.backfillRollbackPending = false;
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
