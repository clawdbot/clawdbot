import { consume } from "@lit/context";
import { initialState, Task, TaskStatus } from "@lit/task";
import { html, nothing } from "lit";
import { state } from "lit/decorators.js";
import type { WorktreeRecord } from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { subtitleForRoute, titleForRoute } from "../../app-navigation.ts";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { showConfirmDialog } from "../../components/confirm-dialog.ts";
import { renderSessionsHubHeader } from "../../components/sessions-hub-header.ts";
import {
  renderDocsLink,
  renderSettingsEmpty,
  renderSettingsPage,
  renderSettingsRow,
  renderSettingsSection,
  renderSettingsStatus,
} from "../../components/settings-ui.ts";
import { renderSettingsWorkspace } from "../../components/settings-workspace.ts";
import { t } from "../../i18n/index.ts";
import { formatRelativeTimestamp } from "../../lib/format.ts";
import { shouldHandleNavigationClick } from "../../lib/navigation-click.ts";
import { repoName } from "../../lib/session-display.ts";
import {
  resolveSessionPreferredFaceForKey,
  sessionNavigationTarget,
} from "../../lib/sessions/route-navigation.ts";
import { createManagedWorktree } from "../../lib/worktrees/create-worktree.ts";
import { GatewayPageController } from "../../lit/gateway-page-controller.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";

const WORKTREES_DOCS_URL = "https://docs.openclaw.ai/concepts/managed-worktrees";

type WorktreesListResult = { worktrees: WorktreeRecord[] };
type WorktreesRemoveResult = { removed: boolean; snapshotError?: string };
type WorktreeBranchesResult = {
  branches: Array<{ name: string }>;
  defaultBranch?: string;
  headBranch?: string;
};

class WorktreesPage extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context!: ApplicationContext;

  @state() private records: WorktreeRecord[] = [];
  @state() private error: string | null = null;
  @state() private busyId: string | null = null;
  @state() private createOpen = false;
  @state() private createRepoRoot = "";
  @state() private createName = "";
  @state() private createBaseRef = "";
  @state() private createBranches: string[] = [];
  @state() private creating = false;
  @state() private gcLoading = false;
  private listClient: GatewayBrowserClient | null = null;
  private readonly gateway = new GatewayPageController(this, {
    getGateway: () => this.context?.gateway,
    onIdentityChange: () => {
      this.records = [];
      this.error = null;
    },
    invalidateRequests: (change) => {
      if (change.snapshot.phase !== "connected" || !change.snapshot.client) {
        this.listClient = null;
        void this.listTask.run([null]);
      }
      void this.branchesTask.run([null, ""]);
      this.invalidateOperations();
    },
    ensureInitialData: () => void this.load(),
  });

  private readonly listTask = new Task(this, {
    autoRun: false,
    args: () => [this.gateway.connected ? this.gateway.client : null] as const,
    task: ([client], { signal }) =>
      client ? client.request<WorktreesListResult>("worktrees.list", {}, { signal }) : initialState,
    onComplete: (result) => {
      this.records = result.worktrees.toSorted((a, b) => b.lastActiveAt - a.lastActiveAt);
    },
    onError: (error) => {
      this.error = String(error);
    },
  });

  private readonly branchesTask = new Task(this, {
    autoRun: false,
    args: () =>
      [this.gateway.connected ? this.gateway.client : null, this.createRepoRoot.trim()] as const,
    task: ([client, repoRoot], { signal }) =>
      client && repoRoot
        ? client.request<WorktreeBranchesResult>("worktrees.branches", { repoRoot }, { signal })
        : initialState,
    onComplete: (result) => {
      this.createBranches = result.branches.map((branch) => branch.name);
      if (!this.createBaseRef) {
        this.createBaseRef = result.defaultBranch ?? result.headBranch ?? "";
      }
    },
    onError: () => {
      this.createBranches = [];
    },
  });

  override disconnectedCallback() {
    this.listClient = null;
    void this.listTask.run([null]);
    void this.branchesTask.run([null, ""]);
    super.disconnectedCallback();
  }

  private invalidateOperations() {
    this.busyId = null;
    this.creating = false;
    this.gcLoading = false;
  }

  private get operationPending(): boolean {
    return this.loading || this.busyId !== null || this.creating;
  }

  private get loading(): boolean {
    return this.gcLoading || this.listTask.status === TaskStatus.PENDING;
  }

  private async load(options: { preserveError?: boolean } = {}) {
    const client = this.gateway.client;
    if (
      !client ||
      !this.gateway.connected ||
      this.busyId !== null ||
      this.creating ||
      this.gcLoading ||
      (this.listTask.status === TaskStatus.PENDING && this.listClient === client)
    ) {
      return;
    }
    this.listClient = client;
    if (!options.preserveError) {
      this.error = null;
    }
    await this.listTask.run([client]);
  }

  private async removeWorktree(record: WorktreeRecord) {
    const scope = this.gateway.capture();
    if (!scope || this.operationPending) {
      return;
    }
    if (
      !(await showConfirmDialog({
        message: t("worktrees.confirmDelete", { name: record.name }),
        confirmLabel: t("common.delete"),
        danger: true,
      })) ||
      !this.gateway.isCurrent(scope) ||
      this.operationPending
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
      if (!this.gateway.isCurrent(scope) || result.removed) {
        return;
      }
      const reason = result.snapshotError ?? "";
      const force = await showConfirmDialog({
        message: t("worktrees.confirmForceDelete", { error: reason }),
        confirmLabel: t("common.delete"),
        danger: true,
      });
      if (!this.gateway.isCurrent(scope)) {
        return;
      }
      if (!force) {
        this.error = reason || null;
        return;
      }
      try {
        await scope.client.request("worktrees.remove", { id: record.id, force: true });
      } catch (forceError) {
        if (this.gateway.isCurrent(scope)) {
          this.error = String(forceError);
        }
      }
    } catch (error) {
      if (this.gateway.isCurrent(scope)) {
        this.error = String(error);
      }
    } finally {
      if (this.gateway.isCurrent(scope)) {
        this.busyId = null;
        await this.load({ preserveError: true });
      }
    }
  }

  private async restore(record: WorktreeRecord) {
    const scope = this.gateway.capture();
    if (!scope || this.operationPending) {
      return;
    }
    this.busyId = record.id;
    this.error = null;
    try {
      await scope.client.request("worktrees.restore", { id: record.id });
    } catch (error) {
      if (this.gateway.isCurrent(scope)) {
        this.error = String(error);
      }
    } finally {
      if (this.gateway.isCurrent(scope)) {
        this.busyId = null;
        await this.load({ preserveError: true });
      }
    }
  }

  private async gc() {
    const scope = this.gateway.capture();
    if (!scope || this.operationPending) {
      return;
    }
    this.gcLoading = true;
    this.error = null;
    try {
      await scope.client.request("worktrees.gc", {});
    } catch (error) {
      if (this.gateway.isCurrent(scope)) {
        this.error = String(error);
      }
    } finally {
      if (this.gateway.isCurrent(scope)) {
        this.gcLoading = false;
        await this.load({ preserveError: true });
      }
    }
  }

  private toggleCreate() {
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
    const client = this.gateway.connected ? this.gateway.client : null;
    const repoRoot = this.createRepoRoot.trim();
    if (!client || !repoRoot) {
      this.createBranches = [];
      void this.branchesTask.run([null, ""]);
      return;
    }
    void this.branchesTask.run([client, repoRoot]);
  }

  private async createWorktree() {
    const scope = this.gateway.capture();
    const repoRoot = this.createRepoRoot.trim();
    if (!scope || !repoRoot || this.operationPending) {
      return;
    }
    this.creating = true;
    this.error = null;
    try {
      await createManagedWorktree(scope.client, {
        repoRoot,
        name: this.createName,
        baseRef: this.createBaseRef,
      });
      if (this.gateway.isCurrent(scope)) {
        this.createOpen = false;
        this.createName = "";
      }
    } catch (error) {
      if (this.gateway.isCurrent(scope)) {
        this.error = String(error);
      }
    } finally {
      if (this.gateway.isCurrent(scope)) {
        this.creating = false;
        await this.load({ preserveError: true });
      }
    }
  }

  private renderOwner(record: WorktreeRecord) {
    if (record.ownerKind === "session" && record.ownerId) {
      const face = resolveSessionPreferredFaceForKey(this.context, record.ownerId);
      const target = sessionNavigationTarget({
        context: this.context,
        face,
        sessionKey: record.ownerId,
        preferenceDerivedFace: true,
      });
      // The clean href stays shareable; the in-app click navigates with the options so an
      // uncached owner still carries the marker that resolves its stored face.
      return html`<a
        href=${target.href}
        title=${record.ownerId}
        @click=${(event: MouseEvent) => {
          if (!shouldHandleNavigationClick(event)) {
            return;
          }
          event.preventDefault();
          this.context.navigate(face, target.options);
        }}
        >${t("worktrees.ownerSession")}</a
      >`;
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
      `,
      { wide: true },
    );
    return html`
      ${renderSessionsHubHeader({
        active: "worktrees",
        title: titleForRoute("sessions"),
        subtitle: html`${subtitleForRoute("worktrees")}
        ${renderDocsLink(WORKTREES_DOCS_URL, t("common.learnMore"))}`,
        onSelect: (tab) => {
          if (tab !== "worktrees") {
            this.context?.navigate(tab);
          }
        },
      })}
      ${renderSettingsWorkspace(body, { id: "sessions-hub-panel" })}
    `;
  }
}

if (!customElements.get("openclaw-worktrees-page")) {
  customElements.define("openclaw-worktrees-page", WorktreesPage);
}
