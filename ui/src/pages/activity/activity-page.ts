import { consume } from "@lit/context";
import { asNullableRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import type { RouteLocation } from "@openclaw/uirouter";
import { html, nothing, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import type { AuditRunInspectResult } from "../../../../packages/gateway-protocol/src/schema/audit-run.js";
import {
  GatewayRequestError,
  type GatewayBrowserClient,
  type GatewayEventFrame,
} from "../../api/gateway.ts";
import { titleForRoute } from "../../app-navigation.ts";
import { activityPersonFromPath, pathForRoute } from "../../app-route-paths.ts";
import {
  applicationContext,
  type ApplicationContext,
  type ApplicationGatewaySnapshot,
} from "../../app/context.ts";
import { readPresenceEntries, type PresencePayload } from "../../app/user-profile.ts";
import { renderHubTabs } from "../../components/hub-tabs.ts";
import { icons } from "../../components/icons.ts";
import { renderSettingsWorkspace } from "../../components/settings-workspace.ts";
import { t } from "../../i18n/index.ts";
import { isMissingOperatorReadScopeError } from "../../lib/gateway-errors.ts";
import { canCallGatewayMethod, isGatewayMethodAdvertised } from "../../lib/gateway-methods.ts";
import { projectPresencePayload } from "../../lib/presence-users.ts";
import { readSessionChangedEvent } from "../../lib/sessions/reconcile.ts";
import {
  isUiGlobalScopeConfigured,
  resolveUiConfiguredMainKey,
  resolveUiDefaultAgentId,
} from "../../lib/sessions/session-key.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { StreamAutoFollowController } from "../../lit/stream-auto-follow-controller.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import { renderCurrentWork } from "./current-work-view.ts";
import type { LiveActivity } from "./live-activity.ts";
import {
  activityRunInspectorSearch,
  mergeDecisionPage,
  receiptPageCursors,
  resolveActivityRouteData,
  type ActivityRouteData,
  type RunInspectorSelector,
  type RunInspectorState,
} from "./run-inspector-model.ts";
import { renderRunInspector } from "./run-inspector-view.ts";
import { SessionActivityController } from "./session-activity-controller.ts";
import { renderSessionActivityView } from "./session-activity-view.ts";
import type { ActivityEntry, ActivityStatus } from "./tool-activity.ts";
import { renderActivity } from "./view.ts";

function selectorKey(selector: RunInspectorSelector | null): string | null {
  return selector ? `${selector.kind}:${selector.id}` : null;
}

function inspectorRequestKey(route: ActivityRouteData): string | null {
  if (route.mode !== "run" || !route.selector) {
    return null;
  }
  return `${selectorKey(route.selector)}:${route.decisionCursor ?? ""}`;
}

function isExpiredDecisionCursorError(error: unknown): boolean {
  const record = asRecord(error);
  return (
    (record?.gatewayCode === "INVALID_REQUEST" || record?.code === "INVALID_REQUEST") &&
    record.retryable !== true
  );
}

class ActivityPage extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context!: ApplicationContext;

  @property({ attribute: false }) routeLocation: RouteLocation = {
    pathname: "/activity",
    search: "",
    hash: "",
  };
  private routeData: ActivityRouteData = {
    mode: "sessions",
    filters: { personId: null, query: "", time: "7d" },
    selector: null,
  };

  @state() private entries: readonly ActivityEntry[] = [];
  @state() private filterText = "";
  @state() private statusFilters: Record<ActivityStatus, boolean> = {
    running: true,
    done: true,
    error: true,
  };
  @state() private toolFilter = "";
  @state() private expandedIds = new Set<string>();
  @state() private expandedAutomationDays = new Set<string>();
  @state() private autoFollow = true;
  @state() private runInspector: RunInspectorState = { status: "empty" };
  @state() private presencePayload: PresencePayload | undefined;

  private liveActivitySource: LiveActivity | null = null;
  private liveActivityRevision = -1;
  private readonly sessionActivity = new SessionActivityController(this);
  private sessionActivityRevision = -1;
  private inspectorAbort: AbortController | null = null;
  private inspectorClient: GatewayBrowserClient | null = null;
  private inspectorEpoch = 0;
  private inspectorSelectorKey: string | null = null;
  private presenceClient: GatewayBrowserClient | null = null;
  private readonly streamFollow = new StreamAutoFollowController(this, {
    selector: ".activity-stream",
    isEnabled: () => this.autoFollow,
  });
  private readonly subscriptions = new SubscriptionsController(this)
    .watch(
      () => this.context?.agents,
      (agents, notify) => agents.subscribe(notify),
    )
    .watch(
      () => this.context?.liveActivity,
      (activity, notify) => activity.subscribe(notify),
      (activity) => {
        const snapshot = activity.snapshot;
        const reset =
          activity !== this.liveActivitySource || snapshot.revision !== this.liveActivityRevision;
        this.liveActivitySource = activity;
        this.liveActivityRevision = snapshot.revision;
        this.entries = snapshot.entries;
        if (reset) {
          this.expandedIds = new Set();
          this.streamFollow.atBottom = true;
        }
      },
    )
    .effect(
      () => this.context?.gateway,
      (gateway) => {
        this.applyGatewaySnapshot(gateway, gateway.snapshot, true);
        const stopEvents = gateway.subscribeEvents((event) => {
          this.applyGatewayEvent(gateway, event);
        });
        const stopGateway = gateway.subscribe((snapshot) =>
          this.applyGatewaySnapshot(gateway, snapshot, false),
        );
        return () => {
          stopGateway();
          stopEvents();
        };
      },
    );

  override willUpdate(changed: PropertyValues) {
    if (changed.has("routeLocation")) {
      this.routeData = resolveActivityRouteData(
        this.routeLocation.search,
        activityPersonFromPath(this.routeLocation.pathname, this.context?.basePath),
      );
      this.syncSessionActivity();
    }
  }

  override updated(changed: PropertyValues) {
    if (changed.has("routeLocation")) {
      this.bindInspectorRoute();
    }
    const canonical = this.sessionActivity.canonicalLocation(
      this.routeLocation,
      this.context.basePath,
      projectPresencePayload(this.presencePayload).users,
    );
    if (canonical) {
      this.context.replace("activity", canonical);
    }
    const autoFollowEnabled = this.autoFollow && changed.has("autoFollow");
    if (
      autoFollowEnabled ||
      (this.autoFollow && this.streamFollow.atBottom && changed.has("entries"))
    ) {
      this.streamFollow.schedule(autoFollowEnabled);
    }
  }

  override disconnectedCallback() {
    this.subscriptions.clear();
    this.cancelInspectorRequest();
    super.disconnectedCallback();
  }

  private applyGatewaySnapshot(
    gateway: ApplicationContext["gateway"],
    snapshot: ApplicationGatewaySnapshot,
    sourceChanged: boolean,
  ) {
    if (sourceChanged || gateway.eventLogRevision !== this.sessionActivityRevision) {
      this.sessionActivityRevision = gateway.eventLogRevision;
      this.sessionActivity.load(null, null);
    }
    if (sourceChanged || snapshot.client !== this.presenceClient) {
      this.presenceClient = snapshot.client;
      const presence =
        snapshot.phase === "connected" ? readPresenceEntries(snapshot.hello?.snapshot) : undefined;
      this.presencePayload = presence ? { presence } : undefined;
    } else if (snapshot.phase !== "connected" && this.presencePayload) {
      this.presencePayload = undefined;
    }
    this.syncRunInspector(gateway, snapshot, sourceChanged);
    this.syncSessionActivity();
  }

  private syncSessionActivity(reason: "query" | "retry" = "query") {
    const snapshot = this.context?.gateway.snapshot;
    this.sessionActivity.load(
      snapshot?.phase === "connected" ? snapshot.client : null,
      this.routeData.mode === "sessions"
        ? this.routeData.filters
        : this.routeData.mode === "live"
          ? "current"
          : null,
      reason,
    );
  }

  private bindInspectorRoute() {
    const route = this.routeData;
    const selector = route?.mode === "run" ? route.selector : null;
    const nextSelectorKey = inspectorRequestKey(route);
    if (nextSelectorKey === this.inspectorSelectorKey && route?.mode === "run") {
      return;
    }
    this.inspectorSelectorKey = nextSelectorKey;
    this.cancelInspectorRequest();
    this.inspectorClient = null;
    this.runInspector = selector
      ? { status: "loading", waitingForGateway: true }
      : { status: "empty" };
    if (route?.mode === "run") {
      this.syncRunInspector(this.context.gateway, this.context.gateway.snapshot, true);
    }
  }

  private cancelInspectorRequest() {
    this.inspectorEpoch += 1;
    this.inspectorAbort?.abort();
    this.inspectorAbort = null;
  }

  private syncRunInspector(
    gateway: ApplicationContext["gateway"],
    snapshot: ApplicationGatewaySnapshot,
    force = false,
  ) {
    const route = this.routeData;
    if (route?.mode !== "run") {
      return;
    }
    const selector = route.selector;
    if (!selector) {
      this.runInspector = { status: "empty" };
      return;
    }
    this.inspectorSelectorKey = inspectorRequestKey(route);
    if (snapshot.phase !== "connected" || !snapshot.client) {
      this.cancelInspectorRequest();
      this.inspectorClient = null;
      this.runInspector = { status: "disconnected" };
      return;
    }
    if (isGatewayMethodAdvertised(snapshot, "audit.run.inspect") === false) {
      this.cancelInspectorRequest();
      this.inspectorClient = snapshot.client;
      this.runInspector = { status: "unsupported" };
      return;
    }
    if (!canCallGatewayMethod(snapshot, "audit.run.inspect", "operator.read")) {
      this.cancelInspectorRequest();
      this.inspectorClient = snapshot.client;
      this.runInspector = { status: "unauthorized" };
      return;
    }
    if (
      !force &&
      this.inspectorClient === snapshot.client &&
      (this.runInspector.status === "loading" || this.runInspector.status === "ready")
    ) {
      return;
    }
    void this.loadRunInspector(gateway, snapshot.client, selector);
  }

  private isUnknownInspectMethod(error: unknown): boolean {
    return (
      error instanceof GatewayRequestError &&
      error.gatewayCode === "INVALID_REQUEST" &&
      (error.message === "unknown method: audit.run.inspect" ||
        error.message === "missing scope: operator.admin")
    );
  }

  private async loadRunInspector(
    gateway: ApplicationContext["gateway"],
    client: GatewayBrowserClient,
    selector: RunInspectorSelector,
    previousState?: Extract<RunInspectorState, { status: "ready" }>,
  ) {
    this.cancelInspectorRequest();
    const epoch = this.inspectorEpoch;
    const abort = new AbortController();
    this.inspectorAbort = abort;
    this.inspectorClient = client;
    this.runInspector = previousState
      ? { ...previousState, executionPageStatus: "loading" }
      : { status: "loading", waitingForGateway: false };
    const requestSelectorKey = inspectorRequestKey(this.routeData);
    const isCurrent = () =>
      this.inspectorEpoch === epoch &&
      this.context.gateway === gateway &&
      gateway.snapshot.client === client &&
      gateway.snapshot.phase === "connected" &&
      this.routeData?.mode === "run" &&
      inspectorRequestKey(this.routeData) === requestSelectorKey;
    const decisionCursor = this.routeData.mode === "run" ? this.routeData.decisionCursor : null;
    try {
      const params =
        selector.kind === "run"
          ? {
              runId: selector.id,
              decisionLimit: 50,
              executionLimit: 50,
              ...(decisionCursor ? { decisionCursor } : {}),
              ...(previousState?.result.nextExecutionCursor
                ? { executionCursor: previousState.result.nextExecutionCursor }
                : {}),
            }
          : {
              executionId: selector.id,
              decisionLimit: 50,
              ...(decisionCursor ? { decisionCursor } : {}),
            };
      const result = await client.request<AuditRunInspectResult>("audit.run.inspect", params, {
        signal: abort.signal,
      });
      if (isCurrent()) {
        if (
          previousState?.result.identity.state === "ambiguous" &&
          result.identity.state === "ambiguous"
        ) {
          const candidates = new Map(
            previousState.result.identity.candidates.map((candidate) => [
              candidate.executionId,
              candidate,
            ]),
          );
          for (const candidate of result.identity.candidates) {
            candidates.set(candidate.executionId, candidate);
          }
          this.runInspector = {
            status: "ready",
            result: {
              ...result,
              identity: { ...result.identity, candidates: [...candidates.values()] },
            },
            receiptPageCursors: previousState.receiptPageCursors,
          };
        } else {
          this.runInspector = {
            status: "ready",
            result,
            receiptPageCursors: receiptPageCursors(
              result.decisionDisplays,
              decisionCursor ?? undefined,
            ),
          };
        }
      }
    } catch (error) {
      if (!isCurrent() || abort.signal.aborted) {
        return;
      }
      this.runInspector = isMissingOperatorReadScopeError(error)
        ? { status: "unauthorized" }
        : this.isUnknownInspectMethod(error)
          ? { status: "unsupported" }
          : previousState
            ? { ...previousState, executionPageStatus: "error" }
            : {
                status: "error",
                recovery:
                  decisionCursor && isExpiredDecisionCursorError(error) ? "restart" : "retry",
              };
    } finally {
      if (this.inspectorAbort === abort) {
        this.inspectorAbort = null;
      }
    }
  }

  private loadMoreExecutions() {
    const route = this.routeData;
    const snapshot = this.context.gateway.snapshot;
    const inspectorState = this.runInspector;
    if (
      route?.mode !== "run" ||
      route.selector?.kind !== "run" ||
      snapshot.phase !== "connected" ||
      !snapshot.client ||
      inspectorState.status !== "ready" ||
      inspectorState.executionPageStatus === "loading" ||
      inspectorState.result.identity.state !== "ambiguous" ||
      !inspectorState.result.nextExecutionCursor
    ) {
      return;
    }
    void this.loadRunInspector(
      this.context.gateway,
      snapshot.client,
      route.selector,
      inspectorState,
    );
  }

  private loadMoreDecisions() {
    const route = this.routeData;
    const gateway = this.context.gateway;
    const snapshot = gateway.snapshot;
    const inspectorState = this.runInspector;
    if (
      route.mode !== "run" ||
      !route.selector ||
      snapshot.phase !== "connected" ||
      !snapshot.client ||
      inspectorState.status !== "ready" ||
      inspectorState.decisionPageStatus === "loading" ||
      inspectorState.result.identity.state !== "present" ||
      !inspectorState.result.nextDecisionCursor
    ) {
      return;
    }
    const cursor = inspectorState.result.nextDecisionCursor;
    const selector = route.selector;
    const client = snapshot.client;
    const requestSelectorKey = inspectorRequestKey(route);
    this.cancelInspectorRequest();
    const epoch = this.inspectorEpoch;
    const abort = new AbortController();
    this.inspectorAbort = abort;
    this.runInspector = { ...inspectorState, decisionPageStatus: "loading" };
    const isCurrent = () =>
      this.inspectorEpoch === epoch &&
      this.context.gateway === gateway &&
      gateway.snapshot.client === client &&
      gateway.snapshot.phase === "connected" &&
      inspectorRequestKey(this.routeData) === requestSelectorKey;
    const params =
      selector.kind === "run"
        ? { runId: selector.id, decisionCursor: cursor, decisionLimit: 50, executionLimit: 50 }
        : { executionId: selector.id, decisionCursor: cursor, decisionLimit: 50 };
    void client
      .request<AuditRunInspectResult>("audit.run.inspect", params, { signal: abort.signal })
      .then((page) => {
        if (!isCurrent()) {
          return;
        }
        const result = mergeDecisionPage(inspectorState.result, page);
        if (!result) {
          this.runInspector = { ...inspectorState, decisionPageStatus: "error" };
          return;
        }
        const cursors = new Map(inspectorState.receiptPageCursors);
        for (const receipt of page.decisionDisplays) {
          cursors.set(receipt.selectorId, cursor);
        }
        this.runInspector = { status: "ready", result, receiptPageCursors: cursors };
      })
      .catch((error: unknown) => {
        if (!isCurrent() || abort.signal.aborted) {
          return;
        }
        this.runInspector = isMissingOperatorReadScopeError(error)
          ? { status: "unauthorized" }
          : this.isUnknownInspectMethod(error)
            ? { status: "unsupported" }
            : { ...inspectorState, decisionPageStatus: "error" };
      })
      .finally(() => {
        if (this.inspectorAbort === abort) {
          this.inspectorAbort = null;
        }
      });
  }

  private restartRunInspector() {
    const route = this.routeData;
    if (route.mode !== "run" || !route.selector) {
      return;
    }
    this.context.navigate("activity", { search: activityRunInspectorSearch(route.selector) });
  }

  private selectMode(mode: "sessions" | "live") {
    this.context.navigate("activity", { search: mode === "live" ? "?view=live" : "" });
  }

  private applyGatewayEvent(gateway: ApplicationContext["gateway"], event: GatewayEventFrame) {
    if (this.context.gateway !== gateway) {
      return;
    }
    const change =
      event.event === "session.message" ? readSessionChangedEvent(event.payload) : null;
    const terminalMessage =
      change &&
      (change.hasActiveRun === false ||
        (change.status !== null && change.status !== "running" && change.status !== "queued"));
    if (event.event === "sessions.changed" || (this.routeData.mode === "live" && terminalMessage)) {
      this.sessionActivity.invalidate(event.payload);
    }
    if (event.event === "presence") {
      const presence = readPresenceEntries(event.payload);
      this.presencePayload = presence ? { presence } : undefined;
    }
  }

  private clearEntries() {
    this.context.liveActivity.clear();
  }

  private renderMode() {
    const route = this.routeData;
    if (route.mode === "sessions") {
      const presenceViewers = projectPresencePayload(this.presencePayload).users;
      return renderSessionActivityView({
        context: this.context,
        expandedAutomationDays: this.expandedAutomationDays,
        filters: {
          ...route.filters,
          personId: this.sessionActivity.result?.involvingProfileId ?? route.filters.personId,
        },
        presenceViewers,
        result: this.sessionActivity.result,
        loading: this.sessionActivity.loading,
        retrying: this.sessionActivity.retrying,
        error: this.sessionActivity.error,
        onRetry: () => this.syncSessionActivity("retry"),
        onAutomationDayToggle: (dayKey) => {
          const next = new Set(this.expandedAutomationDays);
          if (next.has(dayKey)) {
            next.delete(dayKey);
          } else {
            next.add(dayKey);
          }
          this.expandedAutomationDays = next;
        },
        onFiltersChange: (next) =>
          this.context.navigate(
            "activity",
            this.sessionActivity.locationForFilters(
              next,
              this.routeLocation,
              this.context.basePath,
              presenceViewers,
            ),
          ),
      });
    }
    if (route.mode === "run") {
      return html`<a
          class="activity-run-inspector-back"
          href=${pathForRoute("activity", this.context.basePath)}
          >${icons.arrowLeft}${t("activityFeed.backToSessions")}</a
        >
        ${renderRunInspector({
          basePath: this.context.basePath,
          state: this.runInspector,
          onLoadMoreExecutions: () => this.loadMoreExecutions(),
          onLoadMoreDecisions: () => this.loadMoreDecisions(),
          selectorId: route.selectorId,
          selector: route.selector,
          onRestart: () => this.restartRunInspector(),
          onRetry: () =>
            this.syncRunInspector(this.context.gateway, this.context.gateway.snapshot, true),
        })}`;
    }
    const sessionHost = {
      agentsList: this.context.agents.state.agentsList,
      hello: this.context.gateway.snapshot.hello,
    };
    return html`<div id="activity-live-panel">
      ${renderCurrentWork({
        basePath: this.context.basePath,
        fallbackAgentId: resolveUiDefaultAgentId(sessionHost),
        mainKey: resolveUiConfiguredMainKey(sessionHost),
        globalScope: isUiGlobalScopeConfigured(sessionHost),
        navigate: this.context.navigate,
        connected: this.context.gateway.snapshot.phase === "connected",
        result: this.sessionActivity.result,
        loading: this.sessionActivity.loading,
        incomplete: this.sessionActivity.incomplete,
        error: this.sessionActivity.error,
        onRetry: () => this.syncSessionActivity("retry"),
      })}
      ${renderActivity({
        basePath: this.context.basePath,
        entries: this.entries,
        filterText: this.filterText,
        statusFilters: this.statusFilters,
        toolFilter: this.toolFilter,
        expandedIds: this.expandedIds,
        autoFollow: this.autoFollow,
        onFilterTextChange: (next) => (this.filterText = next),
        onToolFilterChange: (next) => (this.toolFilter = next),
        onStatusToggle: (status, enabled) => {
          this.statusFilters = { ...this.statusFilters, [status]: enabled };
        },
        onToggleAutoFollow: (next) => (this.autoFollow = next),
        onClear: () => this.clearEntries(),
        onExpandAll: () => {
          this.expandedIds = new Set(this.entries.map((entry) => entry.id));
        },
        onCollapseAll: () => {
          this.expandedIds = new Set();
        },
        onEntryToggle: (id, open) => {
          const next = new Set(this.expandedIds);
          if (open) {
            next.add(id);
          } else {
            next.delete(id);
          }
          this.expandedIds = next;
        },
        onScroll: (event) => this.streamFollow.handleScroll(event),
      })}
    </div>`;
  }

  override render() {
    const mode = this.routeData.mode;
    const body = html`
      ${
        mode === "run"
          ? nothing
          : renderHubTabs({
              id: "activity-mode",
              active: mode,
              tabs: [
                { value: "sessions", label: t("activityFeed.sessionsMode") },
                { value: "live", label: t("activity.runInspector.liveMode") },
              ],
              ariaLabel: t("activity.runInspector.activityView"),
              panelId: "activity-mode-panel",
              className: "activity-mode-tabs",
              variant: "sub",
              onSelect: (selected) => this.selectMode(selected),
            })
      }
      <div
        id="activity-mode-panel"
        role=${mode === "run" ? nothing : "tabpanel"}
        aria-labelledby=${mode === "run" ? nothing : `activity-mode-tab-${mode}`}
      >
        ${this.renderMode()}
      </div>
    `;
    return html`
      <section class="content-header">
        <div>
          <div class="page-title">${titleForRoute("activity")}</div>
          ${
            mode === "live" ? nothing : html`<div class="page-sub">${t("subtitles.activity")}</div>`
          }
        </div>
      </section>
      ${renderSettingsWorkspace(body, { fillHeight: true })}
    `;
  }
}

export const activityPageComponent = {
  header: true,
  render: (location: RouteLocation = { pathname: "/activity", search: "", hash: "" }) =>
    html`<openclaw-activity-page .routeLocation=${location}></openclaw-activity-page>`,
};

if (!customElements.get("openclaw-activity-page")) {
  customElements.define("openclaw-activity-page", ActivityPage);
}
