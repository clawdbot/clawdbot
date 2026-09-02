import type { CronJob, ModelAuthStatusResult } from "../api/types.ts";
import type {
  SidebarAttentionStoreController as StoreController,
  SidebarAttentionStoreSources,
} from "../app/sidebar-attention-store.ts";
import { normalizeAgentLabel } from "../lib/agents/display.ts";
import { createInitialCronState, loadCronJobsPage, loadCronStatus } from "../lib/cron/index.ts";
import { loadModelAuthStatus } from "../lib/model-auth.ts";
import { normalizeAgentId } from "../lib/sessions/session-key.ts";
import {
  dismissSidebarAttention,
  dismissalStoreKey,
  isSidebarAttentionDismissed,
  loadDismissals,
  reconcileSidebarAttentionDismissals,
  type SidebarAttentionDismissals,
} from "./sidebar-attention-dismissals.ts";
import {
  buildScopeUpgradeInboxEntry,
  buildSidebarInboxEntries,
  buildUpdateInboxEntry,
  type SidebarAttentionDismissal,
  type SidebarInboxEntry,
} from "./sidebar-attention-entries.ts";
import {
  buildSidebarAttentionEntries,
  compareSidebarAttentionEntries,
} from "./sidebar-attention-items.ts";
import { resolveSidebarUpdateAttention } from "./sidebar-attention-update.ts";

type SidebarAttentionOwner = {
  connectionRevision: number;
  profileId: string | null;
};

const VISIBILITY_REFRESH_MIN_AGE_MS = 60_000;
const IDLE_REFRESH_INTERVAL_MS = 10 * 60_000;

export class SidebarAttentionStoreController implements StoreController {
  private cronJobs: CronJob[] = [];
  private cronSchedulerEnabled: boolean | null = null;
  private modelAuthStatus: ModelAuthStatusResult | null = null;
  private modelAuthAgentId: string | null = null;
  private loadedOwner: SidebarAttentionOwner | null = null;
  private loadedClient = this.sources.gateway.snapshot.client;
  private loadedAgentScope = { ...this.sources.agentSelection.state };
  private loadedAtMs = 0;
  private dismissedScope: string | null = null;
  private dismissed: SidebarAttentionDismissals = {};
  private loadGeneration = 0;
  private readonly stopGateway: () => void;
  private readonly stopEvents: () => void;
  private readonly stopSelection: () => void;
  private readonly stopAgents: () => void;
  private readonly stopOverlays: () => void;
  private readonly idleRefreshTimer: ReturnType<typeof globalThis.setInterval>;

  constructor(
    private readonly sources: SidebarAttentionStoreSources,
    private readonly onChange: () => void,
  ) {
    this.loadedClient = null;
    this.stopGateway = sources.gateway.subscribe(() => this.synchronizeGateway());
    this.stopEvents = sources.gateway.subscribeEvents((event) => {
      if (event.event === "cron") {
        this.load(false);
      }
    });
    this.stopSelection = sources.agentSelection.subscribe(() => this.synchronizeGateway());
    this.stopAgents = sources.agents.subscribe(onChange);
    this.stopOverlays = sources.overlays.subscribe(onChange);
    document.addEventListener("visibilitychange", this.refreshIfStale);
    globalThis.addEventListener("storage", this.syncDismissalsFromStorage);
    this.idleRefreshTimer = globalThis.setInterval(this.refreshIfStale, IDLE_REFRESH_INTERVAL_MS);
    this.synchronizeGateway();
  }

  get entries(): readonly SidebarInboxEntry[] {
    return this.buildEntries().filter(
      (entry) => !entry.dismissal || !isSidebarAttentionDismissed(this.dismissed, entry.dismissal),
    );
  }

  private owner(): SidebarAttentionOwner {
    return {
      connectionRevision: this.sources.gateway.connectionRevision,
      profileId: this.sources.gateway.snapshot.selfUser?.id ?? null,
    };
  }

  private ownerEquals(left: SidebarAttentionOwner, right: SidebarAttentionOwner): boolean {
    return (
      left.connectionRevision === right.connectionRevision && left.profileId === right.profileId
    );
  }

  private clearHealth(): void {
    this.cronJobs = [];
    this.cronSchedulerEnabled = null;
    this.modelAuthStatus = null;
    this.modelAuthAgentId = null;
  }

  private cronOwnerByJobId(): ReadonlyMap<string, string> | undefined {
    const selection = this.sources.agentSelection.state;
    const roster = this.sources.agents.state.agentsList;
    if (selection.scopeId !== null || !roster) {
      return undefined;
    }
    const namesByAgentId = new Map(
      roster.agents.map((agent) => [normalizeAgentId(agent.id), normalizeAgentLabel(agent)]),
    );
    const defaultId = normalizeAgentId(roster.defaultId);
    return new Map(
      this.cronJobs.map((job) => {
        const ownerId = normalizeAgentId(job.agentId ?? defaultId);
        return [job.id, namesByAgentId.get(ownerId) ?? ownerId];
      }),
    );
  }

  private buildEntries(): SidebarInboxEntry[] {
    const gateway = this.sources.gateway.snapshot;
    if (gateway.phase !== "connected") {
      return [];
    }
    const overlay = this.sources.overlays.snapshot;
    const updateState = resolveSidebarUpdateAttention(this.sources);
    const update = buildUpdateInboxEntry({
      canDismiss: updateState.canUpdate,
      dismissal: updateState.dismissal,
      forced: updateState.forced,
      requiresAction: updateState.forced || (updateState.canUpdate && updateState.actionable),
      severity: overlay.updateStatusBanner?.tone === "danger" ? "error" : "warning",
      visible: updateState.present,
    });
    const scopeUpgrade = buildScopeUpgradeInboxEntry({
      scopes: gateway.hello?.auth?.scopes,
      state: this.sources.scopeUpgrade.state,
    });
    const attention = buildSidebarAttentionEntries({
      cronJobs: this.cronJobs,
      cronSchedulerEnabled: this.cronSchedulerEnabled,
      cronOwnerByJobId: this.cronOwnerByJobId(),
      modelAuthStatus: this.modelAuthStatus,
      modelAuthAgentId: this.modelAuthAgentId,
      now: Date.now(),
    }).toSorted(compareSidebarAttentionEntries);
    return buildSidebarInboxEntries({
      approvals: overlay.approvalQueue,
      attention,
      scopeUpgrade,
      update,
    });
  }

  private reconcileDismissals(scope: {
    cronInventoryComplete: boolean;
    modelAuthAgentId: string | null;
  }): void {
    if (!this.dismissedScope) {
      return;
    }
    this.dismissed = reconcileSidebarAttentionDismissals({
      active: this.buildEntries().flatMap((entry) => (entry.dismissal ? [entry.dismissal] : [])),
      gatewayUrl: this.dismissedScope,
      scope,
    });
  }

  private load(refreshModelAuth = true): void {
    const gateway = this.sources.gateway.snapshot;
    const client = gateway.client;
    if (gateway.phase !== "connected" || !client) {
      return;
    }
    const owner = this.owner();
    const agentScope = { ...this.sources.agentSelection.state };
    const generation = ++this.loadGeneration;
    this.loadedOwner = owner;
    this.loadedClient = client;
    this.loadedAgentScope = agentScope;
    const cron = createInitialCronState({ client, connected: true });
    cron.cronAgentId = agentScope.scopeId;
    const current = () =>
      generation === this.loadGeneration &&
      this.sources.gateway.snapshot.client === client &&
      this.ownerEquals(owner, this.owner()) &&
      this.sources.agentSelection.state.selectedId === agentScope.selectedId &&
      this.sources.agentSelection.state.scopeId === agentScope.scopeId;
    const publishSource = (scope: {
      cronInventoryComplete: boolean;
      modelAuthAgentId: string | null;
    }) => {
      if (!current()) {
        return;
      }
      this.loadedAtMs = Date.now();
      this.reconcileDismissals(scope);
      this.onChange();
    };
    void Promise.all([loadCronJobsPage(cron), loadCronStatus(cron)]).then(() => {
      if (current()) {
        this.cronJobs = cron.cronJobs;
        this.cronSchedulerEnabled = cron.cronStatus?.enabled ?? null;
        publishSource({
          cronInventoryComplete: agentScope.scopeId === null,
          modelAuthAgentId: null,
        });
      }
    });
    if (
      (refreshModelAuth || agentScope.selectedId !== this.modelAuthAgentId) &&
      agentScope.selectedId
    ) {
      void loadModelAuthStatus(client, { agentId: agentScope.selectedId })
        .catch(() => null)
        .then((status) => {
          if (current()) {
            this.modelAuthStatus = status;
            this.modelAuthAgentId = agentScope.selectedId;
            publishSource({
              cronInventoryComplete: false,
              modelAuthAgentId: agentScope.selectedId,
            });
          }
        });
    } else if (!agentScope.selectedId) {
      this.modelAuthStatus = null;
      this.modelAuthAgentId = null;
    }
  }

  private synchronizeGateway(): void {
    const snapshot = this.sources.gateway.snapshot;
    const gatewayUrl = this.sources.gateway.connection.gatewayUrl;
    if (gatewayUrl && gatewayUrl !== this.dismissedScope) {
      this.dismissedScope = gatewayUrl;
      this.dismissed = loadDismissals(gatewayUrl);
    }
    if (snapshot.phase !== "connected" || !snapshot.client) {
      this.loadGeneration += 1;
      this.loadedOwner = null;
      this.loadedClient = null;
      this.clearHealth();
      this.onChange();
      return;
    }
    const owner = this.owner();
    const agentScope = this.sources.agentSelection.state;
    const ownerChanged = this.loadedOwner !== null && !this.ownerEquals(owner, this.loadedOwner);
    if (ownerChanged) {
      this.clearHealth();
      this.onChange();
    }
    if (
      !ownerChanged &&
      snapshot.client === this.loadedClient &&
      agentScope.selectedId === this.loadedAgentScope.selectedId &&
      agentScope.scopeId === this.loadedAgentScope.scopeId
    ) {
      return;
    }
    let scopeChanged = false;
    if (agentScope.selectedId !== this.loadedAgentScope.selectedId) {
      this.modelAuthStatus = null;
      this.modelAuthAgentId = null;
      scopeChanged = true;
    }
    if (agentScope.scopeId !== this.loadedAgentScope.scopeId) {
      this.cronJobs = [];
      scopeChanged = true;
    }
    if (scopeChanged) {
      this.onChange();
    }
    this.load();
  }

  private readonly refreshIfStale = () => {
    if (
      document.visibilityState === "visible" &&
      Date.now() - this.loadedAtMs >= VISIBILITY_REFRESH_MIN_AGE_MS
    ) {
      this.load();
    }
  };

  private readonly syncDismissalsFromStorage = (event: StorageEvent) => {
    if (
      this.dismissedScope &&
      (event.key === null || event.key === dismissalStoreKey(this.dismissedScope))
    ) {
      this.syncDismissals();
    }
  };

  syncDismissals(): void {
    if (this.dismissedScope) {
      this.dismissed = loadDismissals(this.dismissedScope);
      this.onChange();
    }
  }

  dismiss(dismissal: SidebarAttentionDismissal): void {
    if (this.dismissedScope) {
      this.dismissed = dismissSidebarAttention(this.dismissedScope, dismissal);
      this.onChange();
    }
  }

  dispose(): void {
    this.loadGeneration += 1;
    this.stopGateway();
    this.stopEvents();
    this.stopSelection();
    this.stopAgents();
    this.stopOverlays();
    document.removeEventListener("visibilitychange", this.refreshIfStale);
    globalThis.removeEventListener("storage", this.syncDismissalsFromStorage);
    globalThis.clearInterval(this.idleRefreshTimer);
  }
}
