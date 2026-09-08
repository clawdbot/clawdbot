import { consume } from "@lit/context";
import { html, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import type {
  AgentsListResult,
  CronJob,
  CronScratchGetResult,
  ModelCatalogResult,
} from "../../api/types.ts";
import { subtitleForRoute, titleForRoute } from "../../app-navigation.ts";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { readGatewayOperatorAccess } from "../../app/operator-access.ts";
import { renderAgentScopeControl } from "../../components/agent-scope-control.ts";
import { showConfirmDialog } from "../../components/confirm-dialog.ts";
import { renderSettingsPageHeader } from "../../components/settings-ui.ts";
import { renderSettingsWorkspace } from "../../components/settings-workspace.ts";
import { t } from "../../i18n/index.ts";
import { watchAgentScope } from "../../lib/agents/index.ts";
import {
  addCronJob,
  cancelCronEdit,
  createInitialCronState,
  hasCronFormErrors,
  invalidateCronRefresh,
  loadCronJobsPage,
  loadCronRuns,
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
  type CronState,
} from "../../lib/cron/index.ts";
import { formatUiError } from "../../lib/format-error.ts";
import {
  resolveSessionNavigationAgentId,
  sessionNavigationTarget,
} from "../../lib/sessions/route-navigation.ts";
import { GatewayPageController } from "../../lit/gateway-page-controller.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import { buildCronSuggestions, THINKING_SUGGESTIONS } from "./form-suggestions.ts";
import { resolveCronRouteData } from "./route-model.ts";
import { renderCron, type CronDetailTab, type CronListTab } from "./view.ts";

class CronPage extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context!: ApplicationContext;

  @property({ attribute: false }) routeSearch = "";
  @state() private cron = createInitialCronState();
  @state() private agentsList: AgentsListResult | null = null;
  @state() private cronModelSuggestions: string[] = [];
  @state() private modelSuggestionsError: string | null = null;
  @state() private listTab: CronListTab = "tasks";
  @state() private detailTab: CronDetailTab = "settings";
  @state() private heartbeatScratch = "";

  private pendingRouteData: ReturnType<typeof resolveCronRouteData> | null = null;
  private routeJobState: CronState | null = null;
  private highlightedRunId: string | null = null;
  private pendingRunScroll = false;
  private modelSuggestionsRequest: { state: CronState; agentId: string } | null = null;
  private heartbeatScratchRequest = 0;
  private pageHidden = document.visibilityState === "hidden";
  private readonly gateway = new GatewayPageController(this, {
    getGateway: () => this.context?.gateway,
    invalidateRequests: (change) => this.resetGatewayState(change.snapshot),
    onSnapshot: (change) => {
      if (change.initial) {
        this.resetGatewayState(change.snapshot);
      } else if (!readGatewayOperatorAccess(change.snapshot).canAdmin) {
        this.clearHeartbeatScratch();
      }
    },
    ensureInitialData: () => this.ensureInitialData(),
    onPageActivation: () => {
      const hidden = document.visibilityState === "hidden";
      const resumed = this.pageHidden && !hidden;
      this.pageHidden = hidden;
      if (resumed) {
        this.ensureInitialData(true);
      }
    },
  });
  private readonly observeAgentScope = watchAgentScope((scopeId) => {
    this.pendingRouteData = null;
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
            this.gateway.client
          ) {
            if (event.event === "cron") {
              void this.refreshCron({ tableFilters: true, coalesce: true });
            } else if (
              event.event === "config.changed" ||
              event.event === "chat.metadata.changed"
            ) {
              void this.loadModelSuggestions(this.cron);
            }
          }
        }),
    );

  override disconnectedCallback() {
    this.subscriptions.clear();
    super.disconnectedCallback();
  }

  private resetGatewayState(snapshot?: ApplicationContext["gateway"]["snapshot"]) {
    this.clearHeartbeatScratch();
    invalidateCronRefresh(this.cron);
    const connected = snapshot?.phase === "connected";
    const cron = createInitialCronState({
      client: snapshot?.client ?? null,
      connected,
    });
    cron.canRefresh = () => this.canRefreshCron(cron);
    this.cron = cron;
    this.pageHidden = document.visibilityState === "hidden";
    this.cron.cronAgentId = this.context.agentSelection.state.scopeId;
    this.agentsList = connected ? this.context.agents.state.agentsList : null;
    this.cronModelSuggestions = [];
    this.modelSuggestionsError = null;
    this.modelSuggestionsRequest = null;
  }

  private syncAgentsState() {
    this.agentsList = this.context.agents.state.agentsList;
  }

  private canRefreshCron(cron: CronState = this.cron) {
    return this.isConnected && this.cron === cron && document.visibilityState !== "hidden";
  }

  private ensureInitialData(forceRefresh = false) {
    if (!this.canRefreshCron() || !this.cron.connected || !this.cron.client) {
      return;
    }
    if (!this.agentsList && !this.context.agents.state.agentsLoading) {
      void this.context.agents.ensureList();
    }
    if (forceRefresh || (!this.cron.cronStatus && !this.cron.cronLoading)) {
      void this.refreshCron({ tableFilters: true, coalesce: true });
    } else if (!this.cron.cronRuns.length && !this.cron.cronRunsLoadingMore) {
      void this.loadRuns(this.cron.cronRunsScope === "all" ? null : this.cron.cronRunsJobId);
    }
    if (this.modelSuggestionsRequest?.state !== this.cron) {
      void this.loadModelSuggestions(this.cron);
    }
  }

  private requestCronUpdate(cronState: CronState = this.cron) {
    if (this.cron === cronState) {
      this.requestUpdate();
    }
  }

  private lastPanelKey: string | null = null;

  override willUpdate(changed: PropertyValues) {
    if (changed.has("routeSearch")) {
      this.cron.cronError = null;
      const routeData = resolveCronRouteData(this.routeSearch);
      this.pendingRouteData = routeData.jobId ? routeData : null;
      this.routeJobState = null;
      this.highlightedRunId = null;
      this.pendingRunScroll = false;
    }
  }

  override updated() {
    // Switching between list and detail (or between two jobs) keeps the same
    // page scroller alive, so reset scroll and the detail tab per target.
    const editingJobId = this.cron.cronEditingJob?.id ?? null;
    const mode = editingJobId ? "job" : this.cron.cronCreateOpen ? "create" : "overview";
    const panelKey = `${mode}:${editingJobId ?? ""}`;
    if (panelKey !== this.lastPanelKey) {
      this.lastPanelKey = panelKey;
      this.detailTab = editingJobId && this.highlightedRunId ? "history" : "settings";
      const scroller = this.closest(".content");
      if (scroller instanceof HTMLElement && typeof scroller.scrollTo === "function") {
        scroller.scrollTo({ top: 0 });
      }
    }
    const routeData = this.pendingRouteData;
    const client = this.cron.client;
    if (routeData && client && this.cron.connected && this.routeJobState !== this.cron) {
      this.routeJobState = this.cron;
      void this.runCronTask(async (current) => {
        const isCurrent = () =>
          this.isConnected && this.cron === current && this.pendingRouteData === routeData;
        try {
          // Links identify an exact job; a filtered inventory page cannot resolve them.
          const job = await client.request<CronJob>("cron.get", { id: routeData.jobId });
          if (isCurrent()) {
            this.selectJob(job, routeData.runId);
          }
        } catch (error) {
          if (isCurrent()) {
            this.pendingRouteData = null;
            current.cronError = formatUiError(error);
          }
        }
      });
    }
    if (this.pendingRunScroll) {
      const run = this.querySelector<HTMLElement>(".cron-run-entry--highlighted");
      if (run) {
        run.scrollIntoView?.({ block: "nearest" });
        this.pendingRunScroll = false;
      }
    }
  }

  private async refreshCron(options: { tableFilters: boolean; coalesce?: boolean }) {
    const cronState = this.cron;
    if (!this.canRefreshCron(cronState) || !cronState.connected || !cronState.client) {
      return;
    }
    const activeCronJobId = cronState.cronRunsScope === "job" ? cronState.cronRunsJobId : null;
    void this.loadRuns(activeCronJobId, options.coalesce);
    void this.context.channels.refresh(false);
    await Promise.all([
      this.runCronTask((current) => loadCronStatus(current, options)),
      this.runCronTask((current) =>
        loadCronJobsPage(current, { tableFilters: options.tableFilters }),
      ),
    ]);
  }

  private loadRuns(jobId: string | null, coalesce = false) {
    return this.runCronTask((cronState) => loadCronRuns(cronState, jobId, { coalesce }));
  }

  private async loadModelSuggestions(cronState: CronState) {
    const client = cronState.client;
    const agentId = this.context.agentSelection.state.selectedId;
    if (!client || !cronState.connected || !agentId) {
      return;
    }
    const request = { state: cronState, agentId };
    this.modelSuggestionsRequest = request;
    // A publication can replace a pending read without changing the page or agent.
    // Only that latest request may publish suggestions or a failure.
    const isCurrent = () =>
      this.cron === cronState &&
      this.modelSuggestionsRequest === request &&
      this.context.agentSelection.state.selectedId === agentId;
    try {
      const result = await client.request<ModelCatalogResult>("models.list", {
        agentId,
        view: "configured",
        preparedOnly: true,
      });
      if (isCurrent()) {
        this.cronModelSuggestions = result.models.map((entry) => entry.id);
        this.modelSuggestionsError = result.providerOutcomes?.some(
          (outcome) => outcome.status !== "ready",
        )
          ? t("chat.modelControls.modelsRefreshFailed")
          : null;
      }
    } catch (error) {
      if (isCurrent()) {
        this.modelSuggestionsError = formatUiError(error);
      }
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
    this.cron.cronForm = normalizeCronFormState({ ...this.cron.cronForm, ...patch }, patch);
    this.cron.cronFieldErrors = validateCronForm(this.cron.cronForm);
    this.requestCronUpdate();
  }

  private selectJob(job: CronJob, runId: string | null = null) {
    this.clearHeartbeatScratch();
    this.pendingRouteData = null;
    this.highlightedRunId = runId;
    this.pendingRunScroll = Boolean(runId);
    if (runId) {
      this.detailTab = "history";
    }
    this.cron.cronCreateOpen = false;
    startCronEdit(this.cron, job);
    this.requestCronUpdate();
    if (job.payload?.kind === "heartbeat") {
      void this.loadHeartbeatScratch(this.cron, job.id, this.heartbeatScratchRequest);
    }
    void this.runCronTask(async (cronState) => {
      updateCronRunsFilter(cronState, { cronRunsScope: "job" });
      // Claim the run pane before awaiting: loadCronRuns drops responses whose
      // job no longer matches, so a slower earlier selection cannot overwrite
      // this task's history.
      cronState.cronRunsJobId = job.id;
      await loadCronRuns(cronState, job.id);
    });
  }

  private clearHeartbeatScratch() {
    this.heartbeatScratchRequest += 1;
    this.heartbeatScratch = "";
  }

  private async loadHeartbeatScratch(cronState: CronState, jobId: string, requestId: number) {
    const client = cronState.client;
    if (!this.canManageCron || !client || !cronState.connected) {
      return;
    }
    const connectionScope = this.gateway.capture();
    if (!connectionScope) {
      return;
    }
    // Scratch is admin-only and selection-owned. Revalidate every owner after
    // the request so a stale response cannot survive a scope or panel change.
    const isCurrent = () =>
      this.cron === cronState &&
      this.heartbeatScratchRequest === requestId &&
      this.gateway.isCurrent(connectionScope) &&
      this.canManageCron &&
      cronState.cronEditingJob?.id === jobId &&
      cronState.cronForm.payloadKind === "heartbeat";
    try {
      const result = await client.request<CronScratchGetResult>("cron.scratch.get", { id: jobId });
      if (isCurrent()) {
        this.heartbeatScratch = result.scratch?.content ?? "";
      }
    } catch (error) {
      if (isCurrent()) {
        cronState.cronError = formatUiError(error);
        this.requestCronUpdate(cronState);
      }
    }
  }

  private openCreate(patch?: Partial<CronFormState>) {
    if (!this.canManageCron) {
      return;
    }
    this.clearHeartbeatScratch();
    this.pendingRouteData = null;
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
    this.clearHeartbeatScratch();
    this.pendingRouteData = null;
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
    const selectedJob =
      cronState.cronEditingJob?.id === job.id
        ? cronState.cronEditingJob
        : cronState.cronJobs.find(
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
    const currentJob =
      cronState.cronEditingJob?.id === selectedJobId
        ? cronState.cronEditingJob
        : cronState.cronJobs.find((entry) => entry.id === selectedJobId);
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
    this.clearHeartbeatScratch();
    this.pendingRouteData = null;
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
      const result = await addCronJob(cronState);
      if (!result.saved) {
        return;
      }
      if (cronState.cronEditingJob) {
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
    return html`
      ${renderSettingsPageHeader({
        title: titleForRoute("cron"),
        subtitle: subtitleForRoute("cron"),
        actions: renderAgentScopeControl({
          agents: this.agentsList?.agents ?? [],
          selection: this.context.agentSelection,
        }),
      })}
      ${renderSettingsWorkspace(
        renderCron({
          basePath: this.context.basePath,
          agentId: fallbackAgentId,
          loading: this.cron.cronLoading,
          hasLoaded: this.cron.cronJobsSnapshotRevision !== null,
          listError: this.cron.cronJobsError,
          canManage,
          status: this.cron.cronStatus,
          jobs: this.cron.cronJobs,
          jobsLoadingMore: this.cron.cronJobsLoadingMore,
          jobsTotal: this.cron.cronJobsTotal,
          jobsHasMore: this.cron.cronJobsHasMore,
          jobsQuery: this.cron.cronJobsQuery,
          jobsEnabledFilter: this.cron.cronJobsEnabledFilter,
          jobsScheduleKindFilter: this.cron.cronJobsScheduleKindFilter,
          jobsLastStatusFilter: this.cron.cronJobsLastStatusFilter,
          jobsTriggerFilter: this.cron.cronJobsTriggerFilter,
          jobsSortBy: this.cron.cronJobsSortBy,
          jobsSortDir: this.cron.cronJobsSortDir,
          editingJob: this.cron.cronEditingJob,
          createOpen: this.cron.cronCreateOpen,
          listTab: this.listTab,
          detailTab: this.detailTab,
          error: this.cron.cronError ?? this.modelSuggestionsError,
          busy: this.cron.cronBusy,
          form: this.cron.cronForm,
          heartbeatScratch: canManage ? this.heartbeatScratch : "",
          channels: channels.channelsSnapshot?.channelMeta?.length
            ? channels.channelsSnapshot.channelMeta.map((entry) => entry.id)
            : (channels.channelsSnapshot?.channelOrder ?? []),
          channelLabels: channels.channelsSnapshot?.channelLabels ?? {},
          channelMeta: channels.channelsSnapshot?.channelMeta ?? [],
          runs: this.cron.cronRuns,
          highlightedRunId: this.highlightedRunId,
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
            this.runCronAdminTask((cronState) => toggleCronJob(cronState, job, enabled)),
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
                cronJobsTriggerFilter: "all",
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

export const cronPageComponent = {
  header: true,
  render: (search: unknown) => html`<openclaw-cron-page
    .routeSearch=${typeof search === "string" ? search : ""}
  ></openclaw-cron-page>`,
};

// Module re-evaluation can retain the shared registry (for example, in Vitest).
if (!customElements.get("openclaw-cron-page")) {
  customElements.define("openclaw-cron-page", CronPage);
}
