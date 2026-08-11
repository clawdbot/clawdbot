import { consume } from "@lit/context";
import { html, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import type { AuditRunInspectResult } from "../../../../packages/gateway-protocol/src/schema/audit-run.js";
import type { EventLogEntry } from "../../api/event-log.ts";
import {
  GatewayRequestError,
  type GatewayBrowserClient,
  type GatewayEventFrame,
} from "../../api/gateway.ts";
import { titleForRoute } from "../../app-navigation.ts";
import {
  applicationContext,
  type ApplicationContext,
  type ApplicationGatewaySnapshot,
} from "../../app/context.ts";
import { loadSettings } from "../../app/settings.ts";
import { renderHubTabs } from "../../components/hub-tabs.ts";
import { renderSettingsWorkspace } from "../../components/settings-workspace.ts";
import { t } from "../../i18n/index.ts";
import { isMissingOperatorReadScopeError } from "../../lib/gateway-errors.ts";
import { canCallGatewayMethod, isGatewayMethodAdvertised } from "../../lib/gateway-methods.ts";
import { resolveSessionKey } from "../../lib/sessions/index.ts";
import { uiSessionEventMatches } from "../../lib/sessions/session-key.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { StreamAutoFollowController } from "../../lit/stream-auto-follow-controller.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import {
  resolveActivityRouteData,
  type ActivityRouteData,
  type RunInspectorSelector,
  type RunInspectorState,
} from "./run-inspector-model.ts";
import { renderRunInspector } from "./run-inspector-view.ts";
import {
  parseActivityEvent,
  updateToolActivity,
  type ActivityEntry,
  type ActivityStatus,
} from "./tool-activity.ts";
import { renderActivity } from "./view.ts";

let activityClearBoundary: EventLogEntry | undefined;

function selectorKey(selector: RunInspectorSelector | null): string | null {
  return selector ? `${selector.kind}:${selector.id}` : null;
}

class ActivityPage extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context!: ApplicationContext;

  @property({ attribute: false }) routeSearch = "";
  private routeData: ActivityRouteData = { mode: "live", selector: null };

  @state() private entries: ActivityEntry[] = [];
  @state() private filterText = "";
  @state() private statusFilters: Record<ActivityStatus, boolean> = {
    running: true,
    done: true,
    error: true,
  };
  @state() private toolFilter = "";
  @state() private expandedIds = new Set<string>();
  @state() private autoFollow = true;
  @state() private runInspector: RunInspectorState = { status: "empty" };

  private sessionKey = "";
  private inspectorAbort: AbortController | null = null;
  private inspectorClient: GatewayBrowserClient | null = null;
  private inspectorEpoch = 0;
  private inspectorSelectorKey: string | null = null;
  private readonly streamFollow = new StreamAutoFollowController(this, {
    selector: ".activity-stream",
    isEnabled: () => this.autoFollow,
  });
  private readonly subscriptions = new SubscriptionsController(this).effect(
    () => this.context?.gateway,
    (gateway) => {
      this.applyGatewaySnapshot(gateway, gateway.snapshot, true);
      const stopEvents = gateway.subscribeEvents((event) => {
        this.applyGatewayEvent(gateway, event, Date.now());
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
    if (changed.has("routeSearch")) {
      this.routeData = resolveActivityRouteData(this.routeSearch);
    }
  }

  override updated(changed: PropertyValues) {
    if (changed.has("routeSearch")) {
      this.bindInspectorRoute();
    }
    if (
      this.autoFollow &&
      this.streamFollow.atBottom &&
      (changed.has("entries") || changed.has("autoFollow"))
    ) {
      this.streamFollow.schedule(changed.has("autoFollow"));
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
    const previousSessionKey = this.sessionKey;
    this.sessionKey = resolveSessionKey(loadSettings().sessionKey, snapshot.hello);
    if (sourceChanged || this.sessionKey !== previousSessionKey) {
      this.rebuildEntries(gateway, snapshot);
    }
    this.syncRunInspector(gateway, snapshot, sourceChanged);
  }

  private bindInspectorRoute() {
    const route = this.routeData;
    const selector = route?.mode === "run" ? route.selector : null;
    const nextSelectorKey = selectorKey(selector);
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
    this.inspectorSelectorKey = selectorKey(selector);
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
  ) {
    this.cancelInspectorRequest();
    const epoch = this.inspectorEpoch;
    const abort = new AbortController();
    this.inspectorAbort = abort;
    this.inspectorClient = client;
    this.runInspector = { status: "loading", waitingForGateway: false };
    const requestSelectorKey = selectorKey(selector);
    const isCurrent = () =>
      this.inspectorEpoch === epoch &&
      this.context.gateway === gateway &&
      gateway.snapshot.client === client &&
      gateway.snapshot.phase === "connected" &&
      this.routeData?.mode === "run" &&
      selectorKey(this.routeData.selector) === requestSelectorKey;
    try {
      const params =
        selector.kind === "run"
          ? { runId: selector.id, decisionLimit: 50, executionLimit: 50 }
          : { executionId: selector.id, decisionLimit: 50 };
      const result = await client.request<AuditRunInspectResult>("audit.run.inspect", params, {
        signal: abort.signal,
      });
      if (isCurrent()) {
        this.runInspector = { status: "ready", result };
      }
    } catch (error) {
      if (!isCurrent() || abort.signal.aborted) {
        return;
      }
      this.runInspector = isMissingOperatorReadScopeError(error)
        ? { status: "unauthorized" }
        : this.isUnknownInspectMethod(error)
          ? { status: "unsupported" }
          : { status: "error" };
    } finally {
      if (this.inspectorAbort === abort) {
        this.inspectorAbort = null;
      }
    }
  }

  private selectMode(mode: "live" | "run") {
    if (mode === "live") {
      this.context.navigate("activity", { search: "" });
      return;
    }
    const search = new URLSearchParams({ view: "run" });
    if (this.routeData?.mode === "run" && this.routeData.selector) {
      search.set(this.routeData.selector.kind, this.routeData.selector.id);
    }
    this.context.navigate("activity", { search: `?${search.toString()}` });
  }

  private rebuildEntries(
    gateway: ApplicationContext["gateway"],
    snapshot: ApplicationGatewaySnapshot,
  ) {
    let entries: ActivityEntry[] = [];
    const eventLog = gateway.eventLog;
    const clearIndex = activityClearBoundary ? eventLog.indexOf(activityClearBoundary) : -1;
    const visibleEvents = clearIndex < 0 ? eventLog : eventLog.slice(0, clearIndex);
    for (const event of visibleEvents.toReversed()) {
      entries = this.reduceGatewayEvent(entries, snapshot, event.event, event.payload, event.ts);
    }
    if (entries.length > 0 || this.entries.length > 0) {
      this.entries = entries;
    }
    if (this.expandedIds.size > 0) {
      this.expandedIds = new Set();
    }
    this.streamFollow.atBottom = true;
  }

  private applyGatewayEvent(
    gateway: ApplicationContext["gateway"],
    event: GatewayEventFrame,
    receivedAt: number,
  ) {
    if (this.context.gateway !== gateway) {
      return;
    }
    const nextEntries = this.reduceGatewayEvent(
      this.entries,
      gateway.snapshot,
      event.event,
      event.payload,
      receivedAt,
    );
    if (nextEntries !== this.entries) {
      this.entries = nextEntries;
    }
  }

  private reduceGatewayEvent(
    entries: ActivityEntry[],
    gateway: ApplicationGatewaySnapshot,
    eventName: string,
    payload: unknown,
    receivedAt: number,
  ): ActivityEntry[] {
    if (eventName !== "agent" && eventName !== "session.tool") {
      return entries;
    }
    const event = parseActivityEvent(payload, receivedAt);
    if (!event) {
      return entries;
    }
    if (
      !uiSessionEventMatches(
        {
          sessionKey: this.sessionKey,
          assistantAgentId: gateway.assistantAgentId,
          hello: gateway.hello,
        },
        event.sessionKey,
        event.agentId,
      )
    ) {
      return entries;
    }
    return updateToolActivity(entries, event);
  }

  private clearEntries() {
    activityClearBoundary = this.context.gateway.eventLog[0];
    this.entries = [];
    this.expandedIds = new Set();
    this.streamFollow.atBottom = true;
  }

  override render() {
    const liveActivity = renderActivity({
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
      onToggleAutoFollow: (next) => {
        this.autoFollow = next;
        if (next) {
          this.streamFollow.schedule(true);
        }
      },
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
    });
    const mode = this.routeData?.mode ?? "live";
    const body = html`
      ${renderHubTabs({
        id: "activity-mode",
        active: mode,
        tabs: [
          { value: "live", label: t("activity.runInspector.liveMode") },
          { value: "run", label: t("activity.runInspector.mode") },
        ],
        ariaLabel: t("activity.runInspector.activityView"),
        panelId: "activity-mode-panel",
        className: "activity-mode-tabs",
        variant: "sub",
        onSelect: (selected) => this.selectMode(selected),
      })}
      <div id="activity-mode-panel" role="tabpanel" aria-labelledby=${`activity-mode-tab-${mode}`}>
        ${mode === "run"
          ? renderRunInspector({
              basePath: this.context.basePath,
              state: this.runInspector,
              onRetry: () =>
                this.syncRunInspector(this.context.gateway, this.context.gateway.snapshot, true),
            })
          : html`<div id="activity-live-panel">${liveActivity}</div>`}
      </div>
    `;
    return html`
      <section class="content-header">
        <div>
          <div class="page-title">${titleForRoute("activity")}</div>
        </div>
      </section>
      ${renderSettingsWorkspace(body, { fillHeight: true })}
    `;
  }
}

export const activityPageComponent = {
  header: true,
  render: (search: unknown) => html`<openclaw-activity-page
    .routeSearch=${typeof search === "string" ? search : ""}
  ></openclaw-activity-page>`,
};

if (!customElements.get("openclaw-activity-page")) {
  customElements.define("openclaw-activity-page", ActivityPage);
}
