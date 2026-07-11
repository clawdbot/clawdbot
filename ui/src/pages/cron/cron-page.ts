import { consume } from "@lit/context";
import { html } from "lit";
import { state } from "lit/decorators.js";
import type { AgentsListResult, CronJob } from "../../api/types.ts";
import { subtitleForRoute, titleForRoute } from "../../app-navigation.ts";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { renderSettingsWorkspace } from "../../components/settings-workspace.ts";
import { currentConfigObject } from "../../lib/config/index.ts";
import {
  addCronJob,
  cancelCronEdit,
  createInitialCronState,
  DEFAULT_CRON_FORM,
  getCronJobPayload,
  getVisibleCronJobs,
  hasCronFormErrors,
  loadCronJobsPage,
  loadCronModelSuggestions,
  loadCronRuns,
  loadCronStatus,
  loadMoreCronRuns,
  normalizeCronFormState,
  removeCronJob,
  resolveConfiguredCronModelSuggestions,
  runCronJob,
  startCronClone,
  startCronEdit,
  toggleCronJob,
  updateCronJobsFilter,
  updateCronRunsFilter,
  validateCronForm,
  type CronModelSuggestionsState,
  type CronState,
} from "../../lib/cron/index.ts";
import { searchForSession } from "../../lib/sessions/index.ts";
import { sortUniqueStrings } from "../../lib/string-coerce.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import { createDefaultDraft, draftToCronFormPatch, renderCronQuickCreate } from "./quick-create.ts";
import type { CronQuickCreateDraft, CronQuickCreateStep } from "./quick-create.ts";
import { renderCron } from "./view.ts";

const THINKING_SUGGESTIONS = ["off", "minimal", "low", "medium", "high"];
const TIMEZONE_SUGGESTIONS = [
  "UTC",
  "America/Los_Angeles",
  "America/Denver",
  "America/Chicago",
  "America/New_York",
  "Europe/London",
  "Europe/Berlin",
  "Asia/Tokyo",
];

function unique(values: string[]): string[] {
  return sortUniqueStrings(values.map((value) => value.trim()).filter(Boolean));
}

class CronPage extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context!: ApplicationContext;

  @state() private cron = createInitialCronState();
  @state() private agentsList: AgentsListResult | null = null;
  @state() private cronModelSuggestions: string[] = [];
  @state() private quickCreateOpen = false;
  @state() private quickCreateStep: CronQuickCreateStep = "what";
  @state() private quickCreateDraft: CronQuickCreateDraft | null = null;

  private modelSuggestionsState: CronState | null = null;
  private gatewaySource?: ApplicationContext["gateway"];
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
      () => this.context?.gateway,
      (gateway) => {
        const sourceChanged = this.gatewaySource !== undefined && this.gatewaySource !== gateway;
        this.gatewaySource = gateway;
        this.syncGatewayState(gateway.snapshot, sourceChanged);
        this.ensureInitialData();
        return gateway.subscribe((snapshot) => {
          if (this.gatewaySource === gateway) {
            this.syncGatewayState(snapshot, false);
            this.ensureInitialData();
          }
        });
      },
    )
    .effect(
      () => this.context?.gateway,
      (gateway) =>
        gateway.subscribeEvents((event) => {
          if (
            this.gatewaySource === gateway &&
            gateway.snapshot.connected &&
            gateway.snapshot.client &&
            event.event === "cron"
          ) {
            void this.refreshCron({ tableFilters: true });
          }
        }),
    );

  override disconnectedCallback() {
    this.gatewaySource = undefined;
    this.resetGatewayState();
    this.subscriptions.clear();
    super.disconnectedCallback();
  }

  private resetGatewayState(snapshot: Partial<Pick<CronState, "client" | "connected">> = {}) {
    this.cron = createInitialCronState(snapshot);
    this.agentsList = snapshot.connected ? this.context.agents.state.agentsList : null;
    this.cronModelSuggestions = [];
    this.modelSuggestionsState = null;
    this.quickCreateOpen = false;
    this.quickCreateStep = "what";
    this.quickCreateDraft = null;
  }

  private syncGatewayState(
    snapshot: ApplicationContext["gateway"]["snapshot"],
    sourceChanged: boolean,
  ) {
    if (
      sourceChanged ||
      this.cron.client !== snapshot.client ||
      this.cron.connected !== snapshot.connected
    ) {
      // Each connection epoch owns a fresh mutable state object. In-flight work
      // can finish against the old object without leaking into the next session.
      this.resetGatewayState(snapshot);
    }
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
    await loadCronModelSuggestions(suggestionState);
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

  private openQuickCreate(patch?: Partial<CronQuickCreateDraft>) {
    this.quickCreateOpen = true;
    this.quickCreateStep = "what";
    this.quickCreateDraft = { ...createDefaultDraft(), ...patch };
  }

  private closeQuickCreate() {
    this.quickCreateOpen = false;
  }

  private draftToForm() {
    const draft = this.quickCreateDraft ?? createDefaultDraft();
    this.cron.cronEditingJobId = null;
    this.cron.cronForm = normalizeCronFormState({
      ...DEFAULT_CRON_FORM,
      ...draftToCronFormPatch(draft),
    });
    this.cron.cronFieldErrors = validateCronForm(this.cron.cronForm);
    this.requestCronUpdate();
  }

  private async createFromQuickCreate(options?: { runNow?: boolean }) {
    this.draftToForm();
    const cronState = this.cron;
    const result = await this.runCronTask((current) => addCronJob(current));
    if (!result.saved || this.cron !== cronState) {
      return;
    }
    this.quickCreateOpen = false;
    this.quickCreateStep = "what";
    this.quickCreateDraft = null;
    if (options?.runNow && result.jobId) {
      // Immediate first run so a freshly created job shows output right away
      // instead of staying silent until its first scheduled tick.
      const jobId = result.jobId;
      await this.runCronTask((current) => runCronJob(current, jobId, "force"));
    }
  }

  private suggestions() {
    const channels = this.context.channels.state;
    const configValue = currentConfigObject(this.context.runtimeConfig.state);
    const channel = this.cron.cronForm.deliveryChannel.trim() || "last";
    const agentSuggestions = unique([
      ...(this.agentsList?.agents.map((entry) => entry.id.trim()) ?? []),
      ...this.cron.cronJobs.map((job) =>
        typeof job.agentId === "string" ? job.agentId.trim() : "",
      ),
    ]);
    const modelSuggestions = unique([
      ...this.cronModelSuggestions,
      ...resolveConfiguredCronModelSuggestions(configValue),
      ...this.cron.cronJobs.map((job) => {
        const payload = getCronJobPayload(job);
        return payload?.kind === "agentTurn" && typeof payload.model === "string"
          ? payload.model.trim()
          : "";
      }),
    ]);
    const jobTargets = this.cron.cronJobs
      .map((job) => (typeof job.delivery?.to === "string" ? job.delivery.to.trim() : ""))
      .filter(Boolean);
    const accountTargets = (
      channel === "last"
        ? Object.values(channels.channelsSnapshot?.channelAccounts ?? {}).flat()
        : (channels.channelsSnapshot?.channelAccounts?.[channel] ?? [])
    )
      .flatMap((account) => [account.accountId, account.name])
      .filter((value): value is string => typeof value === "string")
      .map((value) => value.trim())
      .filter(Boolean);
    const deliveryTargets = unique([...jobTargets, ...accountTargets]);
    return {
      agentSuggestions,
      modelSuggestions,
      accountTargets,
      deliveryToSuggestions:
        this.cron.cronForm.deliveryMode === "webhook"
          ? deliveryTargets.filter((value) => /^https?:\/\//i.test(value))
          : deliveryTargets,
    };
  }

  private editJob(job: CronJob) {
    this.cron.cronFormCollapsed = false;
    startCronEdit(this.cron, job);
    this.requestCronUpdate();
  }

  private cloneJob(job: CronJob) {
    this.cron.cronFormCollapsed = false;
    startCronClone(this.cron, job);
    this.requestCronUpdate();
  }

  override render() {
    const channels = this.context.channels.state;
    const suggestions = this.suggestions();
    return html`
      <section class="content-header">
        <div>
          <div class="page-title">${titleForRoute("cron")}</div>
          <div class="page-sub">${subtitleForRoute("cron")}</div>
        </div>
      </section>
      ${renderSettingsWorkspace(html`
        ${renderCronQuickCreate({
          open: this.quickCreateOpen,
          step: this.quickCreateStep,
          draft: this.quickCreateDraft ?? createDefaultDraft(),
          modelSuggestions: suggestions.modelSuggestions,
          onCancel: () => this.closeQuickCreate(),
          onStepChange: (step) => (this.quickCreateStep = step),
          onDraftChange: (patch) => {
            this.quickCreateDraft = {
              ...(this.quickCreateDraft ?? createDefaultDraft()),
              ...patch,
            };
          },
          onCreate: (options) => void this.createFromQuickCreate(options),
          onAdvancedCreate: () => {
            this.draftToForm();
            this.quickCreateOpen = false;
            this.quickCreateStep = "what";
            this.quickCreateDraft = null;
            this.cron.cronFormCollapsed = false;
            this.requestCronUpdate();
          },
        })}
        ${renderCron({
          basePath: this.context.basePath,
          loading: this.cron.cronLoading,
          status: this.cron.cronStatus,
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
          error: this.cron.cronError,
          busy: this.cron.cronBusy,
          form: this.cron.cronForm,
          cronFormCollapsed: this.cron.cronFormCollapsed,
          channels: channels.channelsSnapshot?.channelMeta?.length
            ? channels.channelsSnapshot.channelMeta.map((entry) => entry.id)
            : (channels.channelsSnapshot?.channelOrder ?? []),
          channelLabels: channels.channelsSnapshot?.channelLabels ?? {},
          channelMeta: channels.channelsSnapshot?.channelMeta ?? [],
          runsJobId: this.cron.cronRunsJobId,
          runs: this.cron.cronRuns,
          runsTotal: this.cron.cronRunsTotal,
          runsHasMore: this.cron.cronRunsHasMore,
          runsLoadingMore: this.cron.cronRunsLoadingMore,
          runsScope: this.cron.cronRunsScope,
          runsStatuses: this.cron.cronRunsStatuses,
          runsDeliveryStatuses: this.cron.cronRunsDeliveryStatuses,
          runsStatusFilter: this.cron.cronRunsStatusFilter,
          runsQuery: this.cron.cronRunsQuery,
          runsSortDir: this.cron.cronRunsSortDir,
          fieldErrors: this.cron.cronFieldErrors,
          canSubmit: !hasCronFormErrors(this.cron.cronFieldErrors),
          agentSuggestions: suggestions.agentSuggestions,
          modelSuggestions: suggestions.modelSuggestions,
          thinkingSuggestions: THINKING_SUGGESTIONS,
          timezoneSuggestions: TIMEZONE_SUGGESTIONS,
          deliveryToSuggestions: suggestions.deliveryToSuggestions,
          accountSuggestions: suggestions.accountTargets,
          onFormChange: (patch) => {
            this.cron.cronForm = normalizeCronFormState({ ...this.cron.cronForm, ...patch });
            this.cron.cronFieldErrors = validateCronForm(this.cron.cronForm);
            this.requestCronUpdate();
          },
          onRefresh: () => void this.refreshCron({ tableFilters: true }),
          onAdd: () =>
            void this.runCronTask(async (cronState) => {
              if ((await addCronJob(cronState)).saved) {
                cronState.cronFormCollapsed = true;
              }
            }),
          onEdit: (job) => this.editJob(job),
          onClone: (job) => this.cloneJob(job),
          onCancelEdit: () => {
            cancelCronEdit(this.cron);
            this.cron.cronFormCollapsed = true;
            this.requestCronUpdate();
          },
          onToggleFormCollapsed: (collapsed) => {
            this.cron.cronFormCollapsed = collapsed;
            this.requestCronUpdate();
          },
          onToggle: (job, enabled) =>
            void this.runCronTask((cronState) => toggleCronJob(cronState, job, enabled)),
          onRun: (job, mode) =>
            void this.runCronTask((cronState) => runCronJob(cronState, job.id, mode ?? "force")),
          onRemove: (job) => void this.runCronTask((cronState) => removeCronJob(cronState, job)),
          onQuickCreate: () => this.openQuickCreate(),
          onUseSuggestion: (draft) => this.openQuickCreate(draft),
          onLoadRuns: (jobId) =>
            void this.runCronTask(async (cronState) => {
              updateCronRunsFilter(cronState, { cronRunsScope: "job" });
              await loadCronRuns(cronState, jobId);
            }),
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
                cronJobsQuery: "",
                cronJobsEnabledFilter: "all",
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
            this.context.navigate("chat", { search: searchForSession(sessionKey) }),
        })}
      `)}
    `;
  }
}

// Module re-evaluation can retain the shared registry (for example, in Vitest).
if (!customElements.get("openclaw-cron-page")) {
  customElements.define("openclaw-cron-page", CronPage);
}
