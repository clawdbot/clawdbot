import { consume } from "@lit/context";
import type { PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import {
  DASHBOARD_DOCUMENT_ELEMENT,
  ensureCustomElementDefined,
} from "../../app/lazy-custom-element.ts";
import { completePanelRefresh, failPanelRefresh } from "../../components/panel-refresh-status.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { fetchPagedSessionRows } from "../../lib/sessions/paged-session-rows.ts";
import { GatewayPageController } from "../../lit/gateway-page-controller.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import { dashboardSessionListQuery, dashboardsRouteData } from "./route.ts";
import {
  renderDashboards,
  type DashboardGalleryFilters,
  type DashboardsRouteData,
} from "./view.ts";

class DashboardsPage extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context?: ApplicationContext;

  @property({ attribute: false }) routeData?: DashboardsRouteData;

  @state() private filters: DashboardGalleryFilters = {
    query: "",
    ownerId: "",
    sort: "updated",
  };
  @state() private previewError: string | null = null;

  private observedSessions?: ApplicationContext["sessions"];
  private observedScopeId?: string | null;
  private unsubscribeList?: () => void;
  private data?: DashboardsRouteData;
  private listGeneration = 0;
  private readonly gateway = new GatewayPageController(this, {
    getGateway: () => this.context?.gateway,
  });
  private readonly subscriptions = new SubscriptionsController(this).effect(
    () => this.context?.agentSelection,
    (agentSelection) => {
      this.bindList();
      return agentSelection.subscribe(() => this.bindList());
    },
  );

  override connectedCallback() {
    super.connectedCallback();
    void ensureCustomElementDefined(
      DASHBOARD_DOCUMENT_ELEMENT.tagName,
      DASHBOARD_DOCUMENT_ELEMENT.loadModule,
    )
      .then(() => this.requestUpdate())
      .catch((error: unknown) => {
        this.previewError = formatUiError(error);
      });
  }

  override disconnectedCallback() {
    this.listGeneration += 1;
    this.unsubscribeList?.();
    this.unsubscribeList = undefined;
    this.observedSessions = undefined;
    this.observedScopeId = undefined;
    this.subscriptions.clear();
    super.disconnectedCallback();
  }

  override willUpdate(changed: PropertyValues<this>) {
    if (changed.has("routeData")) {
      this.data = this.routeData;
    }
    this.bindList();
  }

  private bindList(): void {
    const context = this.context;
    if (!context) {
      return;
    }
    const sessions = context.sessions;
    const scopeId = context.agentSelection.state.scopeId?.trim() || null;
    if (sessions === this.observedSessions && scopeId === this.observedScopeId) {
      return;
    }
    this.unsubscribeList?.();
    this.observedSessions = sessions;
    this.observedScopeId = scopeId;
    const query = dashboardSessionListQuery(context);
    const apply = (snapshot: ReturnType<typeof sessions.listSnapshot>) => {
      if (
        this.context !== context ||
        this.observedSessions !== sessions ||
        this.observedScopeId !== scopeId ||
        (!snapshot.result && !snapshot.error && this.data?.result)
      ) {
        return;
      }
      this.data = dashboardsRouteData(context, snapshot);
      this.requestUpdate();
      this.completeList(context, sessions, scopeId, query, snapshot);
    };
    this.unsubscribeList = sessions.subscribeList(query, apply);
    const snapshot = sessions.listSnapshot(query);
    apply(snapshot);
    if (!snapshot.result && !snapshot.loading && context.gateway.snapshot.phase === "connected") {
      void sessions.refreshList({ ...query, force: true });
    }
  }

  private completeList(
    context: ApplicationContext,
    sessions: ApplicationContext["sessions"],
    scopeId: string | null,
    query: ReturnType<typeof dashboardSessionListQuery>,
    snapshot: ReturnType<ApplicationContext["sessions"]["listSnapshot"]>,
  ): void {
    const initialResult = snapshot.result;
    const generation = ++this.listGeneration;
    const gatewayScope = this.gateway.capture();
    if (!initialResult?.hasMore || snapshot.loading || snapshot.error || !gatewayScope) {
      return;
    }
    const isCurrent = () =>
      this.context === context &&
      this.observedSessions === sessions &&
      this.observedScopeId === scopeId &&
      this.listGeneration === generation &&
      this.gateway.isCurrent(gatewayScope);
    void fetchPagedSessionRows({
      initialResult,
      list: (offset) => sessions.list({ ...query, offset }),
      isCurrent,
      missingResultError: "dashboard enumeration returned no result",
      stalledPaginationError: "dashboard enumeration did not advance",
      incompletePaginationError: "dashboard enumeration was incomplete",
    })
      .then((rows) => {
        if (!rows || !isCurrent()) {
          return;
        }
        this.data = dashboardsRouteData(context, {
          ...snapshot,
          result: {
            ...initialResult,
            count: rows.length,
            hasMore: false,
            nextOffset: null,
            sessions: rows,
          },
        });
        this.requestUpdate();
      })
      .catch((error: unknown) => {
        if (!isCurrent()) {
          return;
        }
        const status = failPanelRefresh(completePanelRefresh(), error, context.gateway.snapshot);
        this.data = dashboardsRouteData(context, { ...snapshot, error: status.error });
        this.requestUpdate();
      });
  }

  override render() {
    return renderDashboards(
      this.data,
      this.filters,
      {
        onQueryChange: (query) => {
          this.filters = { ...this.filters, query };
        },
        onOwnerChange: (ownerId) => {
          this.filters = { ...this.filters, ownerId };
        },
        onSortChange: (sort) => {
          this.filters = { ...this.filters, sort };
        },
      },
      this.context?.gateway.snapshot,
      this.previewError,
    );
  }
}

if (!customElements.get("openclaw-dashboards-page")) {
  customElements.define("openclaw-dashboards-page", DashboardsPage);
}
