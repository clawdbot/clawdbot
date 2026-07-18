import { consume } from "@lit/context";
import { html, nothing } from "lit";
import { state } from "lit/decorators.js";
import type { WorktreeRecord } from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { titleForRoute } from "../../app-navigation.ts";
import { pathForRoute } from "../../app-route-paths.ts";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { renderSessionsHubTabs } from "../../components/sessions-hub-tabs.ts";
import {
  renderSettingsEmpty,
  renderSettingsPage,
  renderSettingsRow,
  renderSettingsSection,
  renderSettingsStatus,
} from "../../components/settings-ui.ts";
import { renderSettingsWorkspace } from "../../components/settings-workspace.ts";
import { t } from "../../i18n/index.ts";
import { resolveEditableSnapshotConfig } from "../../lib/config/index.ts";
import { formatRelativeTimestamp } from "../../lib/format.ts";
import { searchForSession } from "../../lib/sessions/index.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";

type WorktreesListResult = { worktrees: WorktreeRecord[] };
type WorktreesRemoveResult = { removed: boolean; snapshotError?: string };
type WorktreeBranchesResult = {
  branches: Array<{ name: string }>;
  defaultBranch?: string;
  headBranch?: string;
};

type WorktreeOperationScope = {
  gateway: ApplicationContext["gateway"];
  client: GatewayBrowserClient;
  epoch: number;
};

function repoName(repoRoot: string): string {
  return repoRoot.split(/[\\/]/).findLast(Boolean) ?? repoRoot;
}

type CleanupLimitKey = "maxCount" | "maxTotalSizeGb";

// Coalesces bursts of stepper clicks into one config.patch and keeps sustained
// editing far below the control-plane config-write quota (3 writes / 60 s).
const CLEANUP_COMMIT_DELAY_MS = 2_000;

// The count is an integer, but the size limit accepts fractions (0.5 GB), so
// only maxCount gets floored; flooring the size would display 0.5 as the
// documented "disabled" value 0.
function normalizeCleanupLimit(key: CleanupLimitKey, value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return key === "maxCount" ? Math.floor(value) : value;
}

function cleanupLimitFromConfig(
  config: Record<string, unknown> | null,
  key: CleanupLimitKey,
): number {
  const worktrees = config?.worktrees;
  const cleanup =
    worktrees && typeof worktrees === "object"
      ? (worktrees as { cleanup?: unknown }).cleanup
      : undefined;
  const value =
    cleanup && typeof cleanup === "object" ? (cleanup as Record<string, unknown>)[key] : undefined;
  return typeof value === "number" ? normalizeCleanupLimit(key, value) : 0;
}

class WorktreesPage extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context!: ApplicationContext;

  @state() private loading = false;
  @state() private records: WorktreeRecord[] = [];
  @state() private error: string | null = null;
  @state() private busyId: string | null = null;
  @state() private createOpen = false;
  @state() private createRepoRoot = "";
  @state() private createName = "";
  @state() private createBaseRef = "";
  @state() private createBranches: string[] = [];
  @state() private creating = false;
  @state() private cleanupLoaded = false;
  @state() private cleanupMaxCount = 0;
  @state() private cleanupMaxSizeGb = 0;

  // Debounced stepper commits: rapid clicks fold into one rate-limited config.patch.
  private cleanupCommitTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingCleanupPatch: Partial<Record<CleanupLimitKey, number>> = {};
  // Pending edits stay bound to the capability they were made against so a
  // replaced gateway context never receives another gateway's limits.
  private pendingCleanupSource: ApplicationContext["runtimeConfig"] | null = null;
  private cleanupCommitInFlight: Promise<boolean> | null = null;

  private client: GatewayBrowserClient | null = null;
  private gatewayConnected = false;
  private gatewaySource?: ApplicationContext["gateway"];
  private hasBoundGateway = false;
  private loadGeneration = 0;
  private branchesGeneration = 0;
  private operationEpoch = 0;
  private readonly subscriptions = new SubscriptionsController(this)
    .effect(
      () => this.context?.gateway,
      (gateway) => {
        const sourceChanged = this.hasBoundGateway && this.gatewaySource !== gateway;
        this.gatewaySource = gateway;
        this.hasBoundGateway = true;
        this.applyGatewaySnapshot(gateway.snapshot, sourceChanged);
        return gateway.subscribe((snapshot) => {
          if (this.gatewaySource === gateway && this.context.gateway === gateway) {
            this.applyGatewaySnapshot(snapshot);
          }
        });
      },
    )
    .effect(
      () => this.context?.runtimeConfig,
      (runtimeConfig) => {
        // A replaced capability invalidates drafts made against the old one;
        // controls stay inert until the new snapshot populates them.
        this.resetCleanupDraft();
        void runtimeConfig.ensureLoaded();
        this.syncCleanupFromConfig();
        return runtimeConfig.subscribe(() => this.syncCleanupFromConfig());
      },
    );

  private resetCleanupDraft() {
    if (this.cleanupCommitTimer) {
      clearTimeout(this.cleanupCommitTimer);
      this.cleanupCommitTimer = null;
    }
    this.pendingCleanupPatch = {};
    this.pendingCleanupSource = null;
    this.cleanupLoaded = false;
  }

  override disconnectedCallback() {
    this.subscriptions.clear();
    this.invalidateLoad();
    this.invalidateOperations();
    // Flush a pending edit so navigating away does not drop it.
    void this.flushCleanupEdits();
    this.gatewaySource = undefined;
    this.client = null;
    this.gatewayConnected = false;
    super.disconnectedCallback();
  }

  private syncCleanupFromConfig() {
    // A pending local edit owns the draft values until its patch settles.
    if (this.cleanupCommitTimer || Object.keys(this.pendingCleanupPatch).length > 0) {
      return;
    }
    const runtimeConfig = this.context?.runtimeConfig;
    if (!runtimeConfig) {
      return;
    }
    const config = resolveEditableSnapshotConfig(runtimeConfig.state.configSnapshot);
    if (!config) {
      return;
    }
    this.cleanupLoaded = true;
    this.cleanupMaxCount = cleanupLimitFromConfig(config, "maxCount");
    this.cleanupMaxSizeGb = cleanupLimitFromConfig(config, "maxTotalSizeGb");
  }

  private setCleanupLimit(key: CleanupLimitKey, rawValue: number) {
    const value = normalizeCleanupLimit(key, rawValue);
    if (key === "maxCount") {
      this.cleanupMaxCount = value;
    } else {
      this.cleanupMaxSizeGb = value;
    }
    this.pendingCleanupPatch[key] = value;
    this.pendingCleanupSource = this.context?.runtimeConfig ?? null;
    if (this.cleanupCommitTimer) {
      clearTimeout(this.cleanupCommitTimer);
    }
    this.cleanupCommitTimer = setTimeout(() => {
      this.cleanupCommitTimer = null;
      void this.commitCleanupLimits();
    }, CLEANUP_COMMIT_DELAY_MS);
  }

  /**
   * Cancels the debounce timer and commits pending cleanup edits now. A failed
   * in-flight commit re-queues its draft, so the serialized retry below still
   * reports false and callers refuse to act on limits that never saved.
   */
  private async flushCleanupEdits(): Promise<boolean> {
    if (this.cleanupCommitTimer) {
      clearTimeout(this.cleanupCommitTimer);
      this.cleanupCommitTimer = null;
    }
    return await this.commitCleanupLimits();
  }

  private async commitCleanupLimits(): Promise<boolean> {
    // Serialize config writes: starting while another commit is in flight
    // would reuse its stale base hash and could land limits out of order.
    while (this.cleanupCommitInFlight) {
      await this.cleanupCommitInFlight;
    }
    const patch = this.pendingCleanupPatch;
    if (Object.keys(patch).length === 0) {
      return true;
    }
    const source = this.pendingCleanupSource;
    this.pendingCleanupPatch = {};
    this.pendingCleanupSource = null;
    const runtimeConfig = this.context?.runtimeConfig;
    if (!runtimeConfig || (source !== null && source !== runtimeConfig)) {
      // Dropping an edit made against a replaced context beats writing one
      // gateway's limits into another gateway's config.
      return false;
    }
    // A failed save re-queues the draft (newer edits win per key) so a later
    // flush retries instead of reporting the unsaved limits as committed.
    const restoreDraft = () => {
      if (this.context?.runtimeConfig !== runtimeConfig) {
        // The capability was replaced while this write was in flight; its
        // draft must not leak into the replacement gateway's config.
        return;
      }
      this.pendingCleanupPatch = { ...patch, ...this.pendingCleanupPatch };
      this.pendingCleanupSource = this.pendingCleanupSource ?? source;
    };
    const commit = (async () => {
      try {
        await runtimeConfig.ensureLoaded();
        const patched = await runtimeConfig.patch({
          raw: { worktrees: { cleanup: patch } },
          note: "worktrees: update cleanup limits",
        });
        if (!patched) {
          this.error = runtimeConfig.state.lastError ?? t("worktrees.cleanupSaveFailed");
          restoreDraft();
          return false;
        }
        await runtimeConfig.refresh();
        this.syncCleanupFromConfig();
        return true;
      } catch (error) {
        this.error = String(error);
        restoreDraft();
        return false;
      }
    })();
    this.cleanupCommitInFlight = commit;
    try {
      return await commit;
    } finally {
      if (this.cleanupCommitInFlight === commit) {
        this.cleanupCommitInFlight = null;
      }
    }
  }

  private applyGatewaySnapshot(
    snapshot: ApplicationContext["gateway"]["snapshot"],
    sourceChanged = false,
  ) {
    const clientChanged = snapshot.client !== this.client;
    const connectionChanged = snapshot.connected !== this.gatewayConnected;
    const identityChanged = sourceChanged || clientChanged;
    this.client = snapshot.client;
    this.gatewayConnected = snapshot.connected;
    if (identityChanged || connectionChanged) {
      this.invalidateLoad();
      this.invalidateOperations();
    }
    if (identityChanged) {
      this.records = [];
      this.error = null;
    }
    if (snapshot.connected && snapshot.client) {
      void this.load();
    }
  }

  private invalidateLoad() {
    this.loadGeneration += 1;
    this.loading = false;
  }

  private invalidateOperations() {
    this.operationEpoch += 1;
    // Stale operation promises skip their finalizers, so reset every epoch-owned flag here.
    this.busyId = null;
    this.creating = false;
  }

  private captureOperationScope(): WorktreeOperationScope | null {
    const gateway = this.gatewaySource;
    const client = this.client;
    if (
      !gateway ||
      !client ||
      !this.gatewayConnected ||
      !this.isConnected ||
      this.context.gateway !== gateway
    ) {
      return null;
    }
    return { gateway, client, epoch: this.operationEpoch };
  }

  private isOperationScopeCurrent(scope: WorktreeOperationScope): boolean {
    return (
      this.isConnected &&
      this.gatewayConnected &&
      this.gatewaySource === scope.gateway &&
      this.context.gateway === scope.gateway &&
      this.client === scope.client &&
      this.operationEpoch === scope.epoch
    );
  }

  // Reads and writes share one page-level lane. Otherwise a stale list can
  // overwrite a completed mutation, while busyId can only represent one row.
  private get operationPending(): boolean {
    return this.loading || this.busyId !== null || this.creating;
  }

  private async load(options: { preserveError?: boolean } = {}) {
    const client = this.client;
    if (!client || !this.gatewayConnected || this.operationPending) {
      return;
    }
    const generation = ++this.loadGeneration;
    this.loading = true;
    if (!options.preserveError) {
      this.error = null;
    }
    try {
      const result = await client.request<WorktreesListResult>("worktrees.list", {});
      if (generation === this.loadGeneration && client === this.client) {
        // Registry order is insertion order; recently used checkouts matter most.
        this.records = result.worktrees.toSorted((a, b) => b.lastActiveAt - a.lastActiveAt);
      }
    } catch (error) {
      if (generation === this.loadGeneration && client === this.client) {
        this.error = String(error);
      }
    } finally {
      if (generation === this.loadGeneration && client === this.client) {
        this.loading = false;
      }
    }
  }

  private async removeWorktree(record: WorktreeRecord) {
    const scope = this.captureOperationScope();
    if (
      !scope ||
      this.operationPending ||
      !window.confirm(t("worktrees.confirmDelete", { name: record.name }))
    ) {
      return;
    }
    // Both attempts belong to one Gateway epoch. A force retry must never jump
    // to a replacement client after the first request reports snapshot failure.
    this.busyId = record.id;
    this.error = null;
    try {
      const result = await scope.client.request<WorktreesRemoveResult>("worktrees.remove", {
        id: record.id,
      });
      if (!this.isOperationScopeCurrent(scope) || result.removed) {
        return;
      }
      // Structured snapshot failure: the caller decides whether to force.
      const reason = result.snapshotError ?? "";
      const force = window.confirm(t("worktrees.confirmForceDelete", { error: reason }));
      if (!force) {
        this.error = reason || null;
        return;
      }
      if (!this.isOperationScopeCurrent(scope)) {
        return;
      }
      try {
        await scope.client.request("worktrees.remove", { id: record.id, force: true });
      } catch (forceError) {
        if (this.isOperationScopeCurrent(scope)) {
          this.error = String(forceError);
        }
      }
    } catch (error) {
      if (this.isOperationScopeCurrent(scope)) {
        this.error = String(error);
      }
    } finally {
      if (this.isOperationScopeCurrent(scope)) {
        this.busyId = null;
        await this.load({ preserveError: true });
      }
    }
  }

  private async restore(record: WorktreeRecord) {
    const scope = this.captureOperationScope();
    if (!scope || this.operationPending) {
      return;
    }
    this.busyId = record.id;
    this.error = null;
    try {
      await scope.client.request("worktrees.restore", { id: record.id });
    } catch (error) {
      if (this.isOperationScopeCurrent(scope)) {
        this.error = String(error);
      }
    } finally {
      if (this.isOperationScopeCurrent(scope)) {
        this.busyId = null;
        await this.load({ preserveError: true });
      }
    }
  }

  private async gc() {
    const scope = this.captureOperationScope();
    if (!scope || this.operationPending) {
      return;
    }
    this.loading = true;
    this.error = null;
    // A pending stepper edit must reach the config before gc reads it,
    // otherwise Clean up now evicts against the previous limits.
    const flushed = await this.flushCleanupEdits();
    if (!this.isOperationScopeCurrent(scope)) {
      return;
    }
    if (!flushed) {
      // The failed commit already surfaced its error; gc must not run
      // against limits the operator just tried to change.
      this.loading = false;
      return;
    }
    try {
      await scope.client.request("worktrees.gc", {});
    } catch (error) {
      if (this.isOperationScopeCurrent(scope)) {
        this.error = String(error);
      }
    } finally {
      if (this.isOperationScopeCurrent(scope)) {
        this.loading = false;
        await this.load({ preserveError: true });
      }
    }
  }

  private toggleCreate() {
    // A successful create closes and resets this shared draft, so the submitted
    // snapshot must stay atomic until its request settles.
    if (this.creating) {
      return;
    }
    this.createOpen = !this.createOpen;
    if (this.createOpen && !this.createRepoRoot) {
      const agents = this.context.agents.state.agentsList;
      const defaultAgent = agents?.agents.find((agent) => agent.id === agents.defaultId);
      this.createRepoRoot = defaultAgent?.workspace ?? "";
      this.loadCreateBranches();
    }
  }

  private loadCreateBranches() {
    const generation = ++this.branchesGeneration;
    const scope = this.captureOperationScope();
    const repoRoot = this.createRepoRoot.trim();
    if (!scope || !repoRoot) {
      this.createBranches = [];
      return;
    }
    void scope.client
      .request<WorktreeBranchesResult>("worktrees.branches", { repoRoot })
      .then((result) => {
        // Only the latest picker request owns branch state, including after same-path retries.
        if (generation === this.branchesGeneration && this.isOperationScopeCurrent(scope)) {
          this.createBranches = result.branches.map((branch) => branch.name);
          if (!this.createBaseRef) {
            this.createBaseRef = result.defaultBranch ?? result.headBranch ?? "";
          }
        }
      })
      .catch(() => {
        if (generation === this.branchesGeneration && this.isOperationScopeCurrent(scope)) {
          this.createBranches = [];
        }
      });
  }

  private async createWorktree() {
    const scope = this.captureOperationScope();
    const repoRoot = this.createRepoRoot.trim();
    if (!scope || !repoRoot || this.operationPending) {
      return;
    }
    this.creating = true;
    this.error = null;
    try {
      await scope.client.request("worktrees.create", {
        repoRoot,
        ...(this.createName.trim() ? { name: this.createName.trim() } : {}),
        ...(this.createBaseRef.trim() ? { baseRef: this.createBaseRef.trim() } : {}),
      });
      if (this.isOperationScopeCurrent(scope)) {
        this.createOpen = false;
        this.createName = "";
      }
    } catch (error) {
      if (this.isOperationScopeCurrent(scope)) {
        this.error = String(error);
      }
    } finally {
      if (this.isOperationScopeCurrent(scope)) {
        this.creating = false;
        await this.load({ preserveError: true });
      }
    }
  }

  private renderOwner(record: WorktreeRecord) {
    if (record.ownerKind === "session" && record.ownerId) {
      const href = `${pathForRoute("chat", this.context.basePath)}${searchForSession(record.ownerId)}`;
      return html`<a href=${href} title=${record.ownerId}>${t("worktrees.ownerSession")}</a>`;
    }
    if (record.ownerKind === "workboard") {
      return html`<span title=${record.ownerId ?? ""}>${t("worktrees.ownerWorkboard")}</span>`;
    }
    return html`<span>${t("worktrees.ownerManual")}</span>`;
  }

  private renderCreateRows() {
    if (!this.createOpen) {
      return nothing;
    }
    return html`
      ${renderSettingsRow({
        title: t("worktrees.repo"),
        control: html`
          <input
            class="settings-input"
            type="text"
            aria-label=${t("worktrees.repo")}
            ?disabled=${this.creating}
            .value=${this.createRepoRoot}
            @change=${(event: Event) => {
              this.createRepoRoot = (event.target as HTMLInputElement).value;
              this.createBaseRef = "";
              this.loadCreateBranches();
            }}
          />
        `,
      })}
      ${renderSettingsRow({
        title: t("worktrees.name"),
        control: html`
          <input
            class="settings-input"
            type="text"
            aria-label=${t("worktrees.name")}
            ?disabled=${this.creating}
            placeholder=${t("newSession.worktreeNamePlaceholder")}
            .value=${this.createName}
            @input=${(event: Event) => {
              this.createName = (event.target as HTMLInputElement).value;
            }}
          />
        `,
      })}
      ${renderSettingsRow({
        title: t("newSession.baseBranch"),
        control: html`
          <input
            class="settings-input"
            type="text"
            aria-label=${t("newSession.baseBranch")}
            ?disabled=${this.creating}
            list="worktrees-create-branches"
            .value=${this.createBaseRef}
            @input=${(event: Event) => {
              this.createBaseRef = (event.target as HTMLInputElement).value;
            }}
          />
          <datalist id="worktrees-create-branches">
            ${this.createBranches.map((name) => html`<option value=${name}></option>`)}
          </datalist>
        `,
      })}
      ${renderSettingsRow({
        title: t("worktrees.newWorktree"),
        control: html`
          <button
            class="btn btn--sm"
            ?disabled=${this.operationPending || !this.createRepoRoot.trim()}
            @click=${() => void this.createWorktree()}
          >
            ${this.creating ? t("common.loading") : t("common.create")}
          </button>
        `,
      })}
    `;
  }

  private renderCleanupRow(key: CleanupLimitKey, label: string, help: string, value: number) {
    // Controls stay inert until the config snapshot populates the draft values,
    // otherwise an early edit would commit 0 over the operator's real limits.
    const disabled = !this.cleanupLoaded || !this.gatewayConnected;
    return renderSettingsRow({
      title: label,
      description: help,
      control: html`
        <input
          class="settings-input"
          type="number"
          min="0"
          step=${key === "maxCount" ? "1" : "any"}
          aria-label=${label}
          .value=${String(value)}
          ?disabled=${disabled}
          @change=${(event: Event) => {
            this.setCleanupLimit(key, Number((event.target as HTMLInputElement).value));
          }}
        />
      `,
    });
  }

  private renderRecordRow(record: WorktreeRecord) {
    return renderSettingsRow({
      title: record.name,
      description: html`
        <span title=${record.repoRoot}>${repoName(record.repoRoot)}</span> · ${record.branch} ·
        ${this.renderOwner(record)} · ${formatRelativeTimestamp(record.lastActiveAt)}
      `,
      control: html`
        ${record.removedAt
          ? renderSettingsStatus({ kind: "muted", label: t("worktrees.restorable") })
          : renderSettingsStatus({ kind: "ok", label: t("common.active") })}
        <button
          class=${record.removedAt ? "btn btn--sm" : "btn btn--sm danger"}
          ?disabled=${this.operationPending}
          @click=${() =>
            void (record.removedAt ? this.restore(record) : this.removeWorktree(record))}
        >
          ${record.removedAt ? t("worktrees.restore") : t("common.delete")}
        </button>
      `,
    });
  }

  override render() {
    const actions = html`
      <button class="btn" ?disabled=${this.creating} @click=${() => this.toggleCreate()}>
        ${t("worktrees.newWorktree")}
      </button>
      <button class="btn" ?disabled=${this.operationPending} @click=${() => void this.gc()}>
        ${this.loading ? t("common.loading") : t("worktrees.cleanNow")}
      </button>
    `;
    const rows = html`
      ${this.renderCreateRows()}
      ${this.records.length === 0
        ? renderSettingsEmpty(t("worktrees.empty"))
        : this.records.map((record) => this.renderRecordRow(record))}
    `;
    const body = renderSettingsPage(
      html`
        ${this.error ? html`<div class="callout danger">${this.error}</div>` : nothing}
        ${renderSettingsSection(
          { title: t("worktrees.title"), description: t("worktrees.subtitle"), actions },
          rows,
        )}
        ${renderSettingsSection(
          { title: t("worktrees.cleanupTitle"), description: t("worktrees.cleanupSubtitle") },
          html`
            ${this.renderCleanupRow(
              "maxCount",
              t("worktrees.cleanupMaxCount"),
              t("worktrees.cleanupMaxCountHelp"),
              this.cleanupMaxCount,
            )}
            ${this.renderCleanupRow(
              "maxTotalSizeGb",
              t("worktrees.cleanupMaxSize"),
              t("worktrees.cleanupMaxSizeHelp"),
              this.cleanupMaxSizeGb,
            )}
          `,
        )}
      `,
      { wide: true },
    );
    return html`
      <section class="content-header">
        <div>
          <div class="page-title">${titleForRoute("sessions")}</div>
        </div>
        ${renderSessionsHubTabs({
          active: "worktrees",
          onSelect: (tab) => {
            if (tab !== "worktrees") {
              this.context?.navigate(tab);
            }
          },
        })}
      </section>
      ${renderSettingsWorkspace(body, { id: "sessions-hub-panel" })}
    `;
  }
}

if (!customElements.get("openclaw-worktrees-page")) {
  customElements.define("openclaw-worktrees-page", WorktreesPage);
}
