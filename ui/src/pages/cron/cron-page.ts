import { consume } from "@lit/context";
import { html } from "lit";
import { state } from "lit/decorators.js";
import type { AgentsListResult, CronJob } from "../../api/types.ts";
import { titleForRoute } from "../../app-navigation.ts";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { readGatewayOperatorAccess } from "../../app/operator-access.ts";
import { renderAgentScopeControl } from "../../components/agent-scope-control.ts";
import { showConfirmDialog } from "../../components/confirm-dialog.ts";
import { renderSettingsWorkspace } from "../../components/settings-workspace.ts";
import { t } from "../../i18n/index.ts";
import { watchAgentScope } from "../../lib/agents/index.ts";
import {
  addCronJob,
  cancelCronEdit,
  createInitialCronState,
  getVisibleCronJobs,
  hasCronFormErrors,
  loadCronFailingCount,
  loadCronJobsPage,
  loadCronModelSuggestions,
  loadCronRuns,
  loadCronScopeStats,
  loadCronStatus,
  loadMoreCronRuns,
  normalizeCronFormState,
  removeCronJob,
  runCronJob,
  startCronClone,
  startCronEdit,
  toggleCronJob,
  updateCronJobsFilter,
  updateCronRunsFilter,
  validateCronForm,
  type CronFormState,
  type CronModelSuggestionsState,
  type CronState,
} from "../../lib/cron/index.ts";
import {
  resolveSessionNavigationAgentId,
  sessionNavigationTarget,
} from "../../lib/sessions/route-navigation.ts";
import { GatewayPageController } from "../../lit/gateway-page-controller.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import { buildCronSuggestions, THINKING_SUGGESTIONS } from "./form-suggestions.ts";
import { renderCron, type CronDetailTab, type CronListTab } from "./view.ts";

class CronPage extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context!: ApplicationContext;

  @state() private cron = createInitialCronState();
  @state() private agentsList: AgentsListResult | null = null;
  @state() private cronModelSuggestions: string[] = [];
  @state() private listTab: CronListTab = "tasks";
  @state() private detailTab: CronDetailTab = "settings";

  private modelSuggestionsState: CronState | null = null;
  private readonly gateway = new GatewayPageController(this, {
    getGateway: () => this.context?.gateway,
    invalidateRequests: (change) => this.resetGatewayState(change.snapshot),
    onSnapshot: (change) => {
      if (change.initial) {
        this.resetGatewayState(change.snapshot);
      }
    },
    ensureInitialData: () => this.ensureInitialData(),
  });
  private readonly observeAgentScope = watchAgentScope((scopeId) => {
    // Replace the mutable request state so responses started for the old
    // scope cannot populate the newly selected agent's page.
    this.resetGatewayState(this.context.gateway.snapshot);
    this.cron.cronAgentId = scopeId;
    this.listTab = "tasks";
    this.detailTab = "settings";
    this.ensureInitialData();
    this.requestUpdate();
  });
  private get canManageCron(): boolean {
    return readGatewayOperatorAccess(this.context.gateway.snapshot).canAdmin;
  }

  private readonly subscriptions = new SubscriptionsController(this)
    .watch(
      () => this.context?.agents,
      (agents, notify) => agents.subscribe(notify),
      () => this.syncAgentsState(),
    )
    .watch(
      () => this.context?.channels,
      (channels, notify) => channels.subscribe(notify),
    )
    .watch(
      () => this.context?.runtimeConfig,
      (runtimeConfig, notify) => runtimeConfig.subscribe(notify),
    )
    .effect(
      () => this.context?.agentSelection,
      (agentSelection) => this.observeAgentScope(agentSelection),
    )
    .effect(
      () => this.context?.gateway,
      (gateway) =>
        gateway.subscribeEvents((event) => {
          if (
            this.gateway.gateway === gateway &&
            this.context.gateway === gateway &&
            this.gateway.connected &&
            this.gateway.client &&
            event.event === "cron"
          ) {
            void this.refreshCron({ tableFilters: true });
          }
        }),
    );

  override disconnectedCallback() {
    this.subscriptions.clear();
    super.disconnectedCallback();
  }

  private resetGatewayState(snapshot?: ApplicationContext["gateway"]["snapshot"]) {
    const connected = snapshot?.phase === "connected";
    this.cron = createInitialCronState({
      client: snapshot?.client ?? null,
      connected,
    });
    this.cron.cronAgentId = this.context.agentSelection.state.scopeId;
    this.agentsList = connected ? this.context.agents.state.agentsList : null;
    this.cronModelSuggestions = [];
    this.modelSuggestionsState = null;
  }

  private syncAgentsState() {
    this.agentsList = this.context.agents.state.agentsList;
  }

  private ensureInitialData() {
    if (!this.cron.connected || !this.cron.client) {
      return;
    }
    if (!this.agentsList && !this.context.agents.state.agentsLoading) {
      void this.context.agents.ensureList();
    }
    if (!this.cron.cronStatus && !this.cron.cronLoading) {
      void this.refreshCron({ tableFilters: true });
    } else if (!this.cron.cronRuns.length && !this.cron.cronRunsLoadingMore) {
      void this.loadRuns(this.cron.cronRunsScope === "all" ? null : this.cron.cronRunsJobId);
    }
    if (this.modelSuggestionsState !== this.cron) {
      const cronState = this.cron;
      this.modelSuggestionsState = cronState;
      void this.loadModelSuggestions(cronState);
    }
  }

  private requestCronUpdate(cronState: CronState = this.cron) {
    if (this.cron === cronState) {
      this.requestUpdate();
    }
  }

  private lastPanelKey: string | null = null;

  override updated() {
    // Switching between list and detail (or between two jobs) keeps the same
    // page scroller alive, so reset scroll and the detail tab per target.
    const mode = this.cron.cronEditingJobId
      ? "job"
      : this.cron.cronCreateOpen
        ? "create"
        : "overview";
    const panelKey = `${mode}:${this.cron.cronEditingJobId ?? ""}`;
    if (panelKey !== this.lastPanelKey) {
      this.lastPanelKey = panelKey;
      this.detailTab = "settings";
      const scroller = this.closest(".content");
      if (scroller instanceof HTMLElement && typeof scroller.scrollTo === "function") {
        scroller.scrollTo({ top: 0 });
      }
    }
  }

  private async refreshCron(options: { tableFilters: boolean }) {
    const cronState = this.cron;
    if (!cronState.connected || !cronState.client) {
      return;
    }
    const activeCronJobId = cronState.cronRunsScope === "job" ? cronState.cronRunsJobId : null;
    void this.loadRuns(activeCronJobId);
    void this.context.channels.refresh(false);
    await Promise.all([
      this.runCronTask((current) => loadCronStatus(current)),
      this.runCronTask((current) => loadCronFailingCount(current)),
      this.runCronTask((current) => loadCronScopeStats(current)),
      this.runCronTask((current) =>
        loadCronJobsPage(current, { tableFilters: options.tableFilters }),
      ),
    ]);
  }

  private loadRuns(jobId: string | null) {
    return this.runCronTask((cronState) => loadCronRuns(cronState, jobId));
  }

  private async loadModelSuggestions(cronState: CronState) {
    const suggestionState: CronModelSuggestionsState = {
      client: cronState.client,
      connected: cronState.connected,
      cronModelSuggestions: this.cronModelSuggestions,
    };
    await loadCronModelSuggestions(suggestionState, this.context.agentSelection.state.selectedId);
    if (
      this.isConnected &&
      this.cron === cronState &&
      this.modelSuggestionsState === cronState &&
      cronState.connected &&
      suggestionState.client === cronState.client
    ) {
      this.cronModelSuggestions = suggestionState.cronModelSuggestions;
    }
  }

  private async runCronTask<T>(task: (cronState: CronState) => Promise<T>): Promise<T> {
    const cronState = this.cron;
    try {
      const result = task(cronState);
      this.requestCronUpdate(cronState);
      return await result;
    } finally {
      this.requestCronUpdate(cronState);
    }
  }

  private runCronAdminTask<T>(task: (cronState: CronState) => Promise<T>): void {
    // Scope can change between render and click after a reconnect. Recheck at
    // dispatch so a stale control cannot send an admin-only Gateway request.
    if (!this.canManageCron) {
      return;
    }
    void this.runCronTask(task);
  }

  private patchForm(patch: Partial<CronFormState>) {
    if (!this.canManageCron) {
      return;
    }
    this.cron.cronForm = normalizeCronFormState({ ...this.cron.cronForm, ...patch });
    this.cron.cronFieldErrors = validateCronForm(this.cron.cronForm);
    this.requestCronUpdate();
  }

  private selectJob(job: CronJob) {
    this.cron.cronCreateOpen = false;
    startCronEdit(this.cron, job);
    this.requestCronUpdate();
    void this.runCronTask(async (cronState) => {
      updateCronRunsFilter(cronState, { cronRunsScope: "job" });
      // Claim the run pane before awaiting: loadCronRuns drops responses whose
      // job no longer matches, so a slower earlier selection cannot overwrite
      // this task's history.
      cronState.cronRunsJobId = job.id;
      await loadCronRuns(cronState, job.id);
    });
  }

  private openCreate(patch?: Partial<CronFormState>) {
    if (!this.canManageCron) {
      return;
    }
    cancelCronEdit(this.cron, this.context.agentSelection.state.selectedId);
    this.cron.cronCreateOpen = true;
    if (patch) {
      this.patchForm(patch);
      return;
    }
    this.requestCronUpdate();
  }

  private cloneJob(job: CronJob) {
    if (!this.canManageCron) {
      return;
    }
    // A clone is a prefilled create: the editor submits cron.add, not update.
    startCronClone(this.cron, job);
    this.cron.cronCreateOpen = true;
    this.requestCronUpdate();
  }

  private async removeJob(job: CronJob) {
    const context = this.context;
    const cronState = this.cron;
    const connectionScope = this.gateway.capture();
    const hadAdminAccess = this.canManageCron;
    const selectedJob = cronState.cronJobs.find(
      (entry) => entry.id === job.id && entry.updatedAtMs === job.updatedAtMs,
    );
    if (!connectionScope || !hadAdminAccess || !selectedJob) {
      return;
    }
    const selectedJobId = selectedJob.id;
    const selectedJobRevision = selectedJob.updatedAtMs;
    const selectedJobName = selectedJob.name;
    const confirmed = await showConfirmDialog({
      title: t("cron.actions.removeConfirmTitle", { name: selectedJobName }),
      message: t("cron.actions.removeConfirmMessage"),
      confirmLabel: t("cron.actions.remove"),
      danger: true,
    });
    const currentJob = cronState.cronJobs.find((entry) => entry.id === selectedJobId);
    // The modal yields while every owner can rotate. Reject stale decisions so
    // an old row can never delete a replacement task on a new page or Gateway.
    if (
      !confirmed ||
      this.context !== context ||
      this.cron !== cronState ||
      !this.gateway.isCurrent(connectionScope) ||
      !this.canManageCron ||
      !currentJob ||
      currentJob.updatedAtMs !== selectedJobRevision
    ) {
      return;
    }
    await this.runCronTask(async (current) => {
      await removeCronJob(current, currentJob);
      // Removing the selected task drops the panel back to overview;
      // the runs scope must follow or recent activity stays empty.
      if (current.cronRunsScope === "job" && current.cronRunsJobId === null) {
        updateCronRunsFilter(current, { cronRunsScope: "all" });
        await loadCronRuns(current, null);
      }
    });
  }

  private closePanel() {
    cancelCronEdit(this.cron, this.context.agentSelection.state.selectedId);
    this.cron.cronCreateOpen = false;
    this.requestCronUpdate();
    void this.runCronTask(async (cronState) => {
      updateCronRunsFilter(cronState, { cronRunsScope: "all" });
      cronState.cronRunsJobId = null;
      await loadCronRuns(cronState, null);
    });
  }

  private submitForm(options: { runNow?: boolean } = {}) {
    this.runCronAdminTask(async (cronState) => {
      const editingJobId = cronState.cronEditingJobId;
      const result = await addCronJob(cronState);
      if (!result.saved) {
        return;
      }
      if (editingJobId) {
        // Saving an update clears the edit state; re-select the refreshed job so
        // the detail pane stays on it instead of snapping back to overview.
        const saved = cronState.cronJobs.find((job) => job.id === editingJobId);
        if (saved) {
          startCronEdit(cronState, saved);
        }
        return;
      }
      if (options.runNow && result.jobId) {
        // Create & run now: kick the new task once so the first result arrives
        // immediately instead of waiting for the first scheduled tick.
        await runCronJob(cronState, result.jobId, "force");
      }
      cronState.cronCreateOpen = false;
      // Creating from a selected task drops back to overview; recent activity
      // must cover all tasks again, not the previously selected job.
      if (cronState.cronRunsScope === "job") {
        updateCronRunsFilter(cronState, { cronRunsScope: "all" });
        cronState.cronRunsJobId = null;
        await loadCronRuns(cronState, null);
      }
    });
  }

  override render() {
    const channels = this.context.channels.state;
    const fallbackAgentId = resolveSessionNavigationAgentId(this.context);
    const suggestions = buildCronSuggestions({
      channels,
      runtimeConfig: this.context.runtimeConfig.state,
      cron: this.cron,
      agentsList: this.agentsList,
      modelSuggestions: this.cronModelSuggestions,
    });
    const canManage = this.canManageCron;
    const editingJob = this.cron.cronJobs.find((job) => job.id === this.cron.cronEditingJobId);
    return html`
      <section class="content-header">
        <div>
          <div class="page-title">${titleForRoute("cron")}</div>
        </div>
        ${renderAgentScopeControl({
          agents: this.agentsList?.agents ?? [],
          selection: this.context.agentSelection,
        })}
      </section>
      ${renderSettingsWorkspace(
        renderCron({
          basePath: this.context.basePath,
          agentId: fallbackAgentId,
          loading: this.cron.cronLoading,
          canManage,
          status: this.cron.cronStatus,
          failingCount: this.cron.cronFailingCount,
          agentScoped: this.cron.cronAgentId !== null,
          scopedTotal: this.cron.cronScopedTotal,
          scopedNextWakeAtMs: this.cron.cronScopedNextWakeAtMs,
          jobs: getVisibleCronJobs(this.cron),
          jobsLoadingMore: this.cron.cronJobsLoadingMore,
          jobsTotal: this.cron.cronJobsTotal,
          jobsHasMore: this.cron.cronJobsHasMore,
          jobsQuery: this.cron.cronJobsQuery,
          jobsEnabledFilter: this.cron.cronJobsEnabledFilter,
          jobsScheduleKindFilter: this.cron.cronJobsScheduleKindFilter,
          jobsLastStatusFilter: this.cron.cronJobsLastStatusFilter,
          jobsSortBy: this.cron.cronJobsSortBy,
          jobsSortDir: this.cron.cronJobsSortDir,
          editingJobId: this.cron.cronEditingJobId,
          editingJob,
          createOpen: this.cron.cronCreateOpen,
          listTab: this.listTab,
          detailTab: this.detailTab,
          error: this.cron.cronError,
          busy: this.cron.cronBusy,
          form: this.cron.cronForm,
          channels: channels.channelsSnapshot?.channelMeta?.length
            ? channels.channelsSnapshot.channelMeta.map((entry) => entry.id)
            : (channels.channelsSnapshot?.channelOrder ?? []),
          channelLabels: channels.channelsSnapshot?.channelLabels ?? {},
          channelMeta: channels.channelsSnapshot?.channelMeta ?? [],
          runs: this.cron.cronRuns,
          runsTotal: this.cron.cronRunsTotal,
          runsHasMore: this.cron.cronRunsHasMore,
          runsLoadingMore: this.cron.cronRunsLoadingMore,
          runsStatuses: this.cron.cronRunsStatuses,
          runsDeliveryStatuses: this.cron.cronRunsDeliveryStatuses,
          runsQuery: this.cron.cronRunsQuery,
          runsSortDir: this.cron.cronRunsSortDir,
          fieldErrors: this.cron.cronFieldErrors,
          canSubmit: !hasCronFormErrors(this.cron.cronFieldErrors),
          agentSuggestions: suggestions.agentSuggestions,
          modelSuggestions: suggestions.modelSuggestions,
          thinkingSuggestions: THINKING_SUGGESTIONS,
          timezoneSuggestions: suggestions.timezoneSuggestions,
          deliveryToSuggestions: suggestions.deliveryToSuggestions,
          accountSuggestions: suggestions.accountTargets,
          onListTabChange: (tab) => {
            this.listTab = tab;
          },
          onDetailTabChange: (tab) => {
            this.detailTab = tab;
          },
          onFormChange: (patch) => this.patchForm(patch),
          onRefresh: () => void this.refreshCron({ tableFilters: true }),
          onSubmit: () => this.submitForm(),
          onSubmitRunNow: () => this.submitForm({ runNow: true }),
          onSelectJob: (job) => this.selectJob(job),
          onOpenCreate: (patch) => this.openCreate(patch),
          onClosePanel: () => this.closePanel(),
          onClone: (job) => this.cloneJob(job),
          onToggle: (job, enabled) =>
            this.runCronAdminTask(async (cronState) => {
              const updated = await toggleCronJob(cronState, job, enabled);
              // Header pause/resume must not be undone by a later Save: the
              // editor form still carries the pre-toggle enabled value. Sync
              // to the confirmed write, not the jobs cache — the reload can be
              // queued behind an in-flight list request or fail silently.
              if (updated && cronState.cronEditingJobId === job.id) {
                cronState.cronForm = { ...cronState.cronForm, enabled };
              }
            }),
          onRun: (job, mode) =>
            this.runCronAdminTask((cronState) => runCronJob(cronState, job.id, mode ?? "force")),
          onRemove: (job) => void this.removeJob(job),
          onLoadMoreJobs: () =>
            void this.runCronTask((cronState) =>
              loadCronJobsPage(cronState, { append: true, tableFilters: true }),
            ),
          onJobsFiltersChange: (patch) =>
            void this.runCronTask(async (cronState) => {
              updateCronJobsFilter(cronState, patch);
              await loadCronJobsPage(cronState, { append: false, tableFilters: true });
            }),
          onJobsFiltersReset: () =>
            void this.runCronTask(async (cronState) => {
              updateCronJobsFilter(cronState, {
                cronJobsScheduleKindFilter: "all",
                cronJobsLastStatusFilter: "all",
                cronJobsSortBy: "nextRunAtMs",
                cronJobsSortDir: "asc",
              });
              await loadCronJobsPage(cronState, { append: false, tableFilters: true });
            }),
          onLoadMoreRuns: () => void this.runCronTask((cronState) => loadMoreCronRuns(cronState)),
          onRunsFiltersChange: (patch) =>
            void this.runCronTask(async (cronState) => {
              updateCronRunsFilter(cronState, patch);
              await loadCronRuns(
                cronState,
                cronState.cronRunsScope === "all" ? null : cronState.cronRunsJobId,
              );
            }),
          onNavigateToChat: (sessionKey) =>
            this.context.navigate(
              "chat",
              sessionNavigationTarget({
                context: this.context,
                face: "chat",
                sessionKey,
              }).options,
            ),
        }),
      )}
    `;
  }
}

// Module re-evaluation can retain the shared registry (for example, in Vitest).
if (!customElements.get("openclaw-cron-page")) {
  customElements.define("openclaw-cron-page", CronPage);
}
