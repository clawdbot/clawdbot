import { consume } from "@lit/context";
import { html, nothing, type PropertyValues } from "lit";
import { property } from "lit/decorators.js";
import { titleForRoute } from "../../app-navigation.ts";
import { pathForRoute, pathForWorkboardBoard } from "../../app-route-paths.ts";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import {
  hasOperatorAdminAccess,
  hasOperatorApprovalsAccess,
  hasOperatorWriteAccess,
} from "../../app/operator-access.ts";
import { renderAgentScopeControl } from "../../components/agent-scope-control.ts";
import { renderWorkboardBoardGlyph } from "../../components/workboard-board-glyph.ts";
import { isWorkboardEnabledInConfigSnapshot } from "../../lib/plugin-activation.ts";
import { searchForSession } from "../../lib/sessions/index.ts";
import { workboardBoardName } from "../../lib/workboard/board-presentation.ts";
import { resetDraftState } from "../../lib/workboard/card-state.ts";
import {
  configureWorkboardLiveRefresh,
  handleWorkboardChanged,
  loadWorkboard,
  resumeWorkboardLiveRefresh,
  stopWorkboardLifecycleRefresh,
  stopWorkboardLiveRefresh,
  syncWorkboardLifecycle,
  WORKBOARD_CHANGED_EVENT,
} from "../../lib/workboard/index.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import { matchesAgentScope } from "./agent-filter.ts";
import { WORKBOARD_ALL_BOARDS_FILTER } from "./board-filter.ts";
import type { WorkboardRouteData } from "./route.ts";
import { renderWorkboard } from "./view.ts";

class WorkboardPage extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context?: ApplicationContext;

  @property({ attribute: false }) routeData?: WorkboardRouteData;

  private readonly requestPageUpdate = () => this.context?.workboard.notify();
  private observedAgentScopeId: string | null | undefined;
  private canonicalizedLocation = "";
  private redirectedMissingBoardId = "";
  private readonly subscriptions = new SubscriptionsController(this)
    .watch(
      () => this.context?.agents,
      (agents, notify) => agents.subscribe(notify),
    )
    .effect(
      () => this.context?.agentSelection,
      (selection) => {
        const sync = () => this.syncWorkboardAgentScope();
        sync();
        return selection.subscribe(sync);
      },
    )
    .effect(
      () => this.context?.runtimeConfig,
      (runtimeConfig) => {
        const handleChange = () => {
          this.requestUpdate();
          this.ensureInitialData();
        };
        handleChange();
        return runtimeConfig.subscribe(handleChange);
      },
    )
    .watch(
      () => this.context?.sessions,
      (sessions, notify) => sessions.subscribe(notify),
    )
    .effect(
      () => this.context?.workboard,
      (workboard) => {
        this.syncWorkboardAgentScope();
        const unsubscribe = workboard.subscribe(() => {
          this.syncWorkboardBoardRoute();
          this.requestUpdate();
        });
        return () => {
          unsubscribe();
          stopWorkboardLiveRefresh(workboard);
          stopWorkboardLifecycleRefresh(workboard);
        };
      },
    )
    .effect(
      () => this.context?.gateway,
      (gateway) => {
        const handleSnapshot = (snapshot: ApplicationContext["gateway"]["snapshot"]) => {
          if (snapshot.phase === "connected" && snapshot.client) {
            this.ensureInitialData();
          } else if (this.context?.workboard) {
            // Teardown at the observed disconnect, not a later render that a fast reconnect may skip.
            stopWorkboardLiveRefresh(this.context.workboard);
            stopWorkboardLifecycleRefresh(this.context.workboard);
          }
          this.requestUpdate();
        };
        handleSnapshot(gateway.snapshot);
        return gateway.subscribe(handleSnapshot);
      },
    )
    .effect(
      () => this.context?.gateway,
      (gateway) =>
        gateway.subscribeEvents((event) => {
          const workboard = this.context?.workboard;
          if (
            workboard &&
            gateway.snapshot.phase === "connected" &&
            event.event === WORKBOARD_CHANGED_EVENT
          ) {
            handleWorkboardChanged(workboard, event.payload);
          }
        }),
    );

  private readonly handleVisibilityChange = () => {
    if (document.visibilityState === "visible" && this.context?.workboard) {
      resumeWorkboardLiveRefresh(this.context.workboard);
    }
  };

  override connectedCallback() {
    super.connectedCallback();
    this.ensureInitialData();
    this.syncWorkboardBoardFilter();
    this.syncCanonicalLocation();
    this.syncWorkboardBoardRoute();
    this.syncWorkboardRuntime();
    document.addEventListener("visibilitychange", this.handleVisibilityChange);
  }

  override updated(changed: PropertyValues<this>) {
    if (changed.has("routeData")) {
      this.syncWorkboardBoardFilter();
      this.syncCanonicalLocation();
      this.syncWorkboardBoardRoute();
    }
    this.syncWorkboardRuntime();
    if (this.context?.workboard) {
      resumeWorkboardLiveRefresh(this.context.workboard);
    }
  }

  override disconnectedCallback() {
    document.removeEventListener("visibilitychange", this.handleVisibilityChange);
    this.subscriptions.clear();
    super.disconnectedCallback();
  }

  private ensureInitialData() {
    const context = this.context;
    const gateway = context?.gateway.snapshot;
    if (!context || gateway?.phase !== "connected" || !gateway.client) {
      return;
    }
    if (!context.runtimeConfig.state.configSnapshot && !context.runtimeConfig.state.configLoading) {
      void context.runtimeConfig.ensureLoaded();
    }
    if (!context.agents.state.agentsList && !context.agents.state.agentsLoading) {
      void context.agents.ensureList();
    }
    if (!context.sessions.state.result && !context.sessions.state.loading) {
      void context.sessions.refresh();
    }
  }

  private pluginEnabled(): boolean | null {
    const snapshot = this.context?.runtimeConfig.state.configSnapshot;
    return snapshot ? isWorkboardEnabledInConfigSnapshot(snapshot) : null;
  }

  private syncWorkboardRuntime() {
    const context = this.context;
    const gateway = context?.gateway.snapshot;
    const pluginEnabled = this.pluginEnabled();
    if (!context || gateway?.phase !== "connected" || !gateway.client || pluginEnabled !== true) {
      if (context) {
        stopWorkboardLiveRefresh(context.workboard);
        stopWorkboardLifecycleRefresh(context.workboard);
      }
      return;
    }
    const state = context.workboard.state;
    const requiresCanonicalReload = configureWorkboardLiveRefresh({
      host: context.workboard,
      client: gateway.client,
      requestUpdate: this.requestPageUpdate,
    });
    void loadWorkboard({
      host: context.workboard,
      client: gateway.client,
      requestUpdate: this.requestPageUpdate,
      force: requiresCanonicalReload,
      refreshDiagnostics: hasOperatorWriteAccess(gateway.hello?.auth ?? null),
    });
    if (!state.dispatching) {
      void syncWorkboardLifecycle({
        host: context.workboard,
        client: gateway.client,
        sessions: context.sessions.state.result?.sessions ?? [],
        canWrite: hasOperatorWriteAccess(gateway.hello?.auth ?? null),
        requestUpdate: this.requestPageUpdate,
      });
    }
  }

  private reloadConfig() {
    const context = this.context;
    if (!context) {
      return;
    }
    void context.runtimeConfig.refresh({ discardPendingChanges: true });
  }

  private syncWorkboardAgentScope() {
    const context = this.context;
    if (!context) {
      return;
    }
    const nextScopeId = context.agentSelection.state.scopeId;
    if (this.observedAgentScopeId !== nextScopeId) {
      this.observedAgentScopeId = nextScopeId;
      const state = context.workboard.state;
      const agentsList = context.agents.state.agentsList;
      const remainsVisible = (cardId: string) => {
        const card = state.cards.find((entry) => entry.id === cardId);
        return Boolean(card && matchesAgentScope(card, agentsList, nextScopeId));
      };
      // The board's richer agent filter is a secondary control available only
      // in all-agent scope; a chip switch must not retain a hidden subfilter.
      state.agentFilter = "all";
      if (state.detailCardId && !remainsVisible(state.detailCardId)) {
        state.detailCardId = null;
        state.detailCommentBody = "";
      }
      if (state.editingCardId && !remainsVisible(state.editingCardId)) {
        resetDraftState(state);
      }
      context.workboard.notify();
    }
  }

  private syncWorkboardBoardFilter() {
    const context = this.context;
    const boardFilter = this.routeData?.boardFilter;
    if (!context || !boardFilter || context.workboard.state.boardFilter === boardFilter) {
      return;
    }
    context.workboard.state.boardFilter = boardFilter;
    context.workboard.notify();
  }

  private syncCanonicalLocation() {
    const canonical = this.routeData?.canonicalLocation;
    const context = this.context;
    if (!canonical) {
      this.canonicalizedLocation = "";
      return;
    }
    if (!context) {
      return;
    }
    const key = `${canonical.pathname}${canonical.search}${canonical.hash}`;
    if (this.canonicalizedLocation === key) {
      return;
    }
    this.canonicalizedLocation = key;
    context.replace("workboard", canonical);
  }

  private setWorkboardBoardFilter(boardFilter: string) {
    const context = this.context;
    if (!context) {
      return;
    }
    context.replace("workboard", {
      pathname:
        boardFilter === WORKBOARD_ALL_BOARDS_FILTER
          ? pathForRoute("workboard", context.basePath)
          : pathForWorkboardBoard(boardFilter, context.basePath),
      search: this.routeData?.search ?? "",
    });
  }

  private syncWorkboardBoardRoute() {
    const context = this.context;
    const boardId = this.routeData?.boardFilter;
    if (
      !context ||
      !boardId ||
      boardId === WORKBOARD_ALL_BOARDS_FILTER ||
      !context.workboard.boardsReady
    ) {
      this.redirectedMissingBoardId = "";
      return;
    }
    if (context.workboard.state.boards.some((board) => board.id === boardId)) {
      this.redirectedMissingBoardId = "";
      return;
    }
    if (this.redirectedMissingBoardId === boardId) {
      return;
    }
    this.redirectedMissingBoardId = boardId;
    context.replace("workboard", {
      pathname: pathForRoute("workboard", context.basePath),
      search: this.routeData?.search ?? "",
    });
  }

  private selectedBoard() {
    const context = this.context;
    const boardId = this.routeData?.boardFilter;
    if (!context || !boardId || boardId === WORKBOARD_ALL_BOARDS_FILTER) {
      return null;
    }
    const board = context.workboard.state.boards.find((candidate) => candidate.id === boardId);
    if (board || context.workboard.boardsReady) {
      return board ?? null;
    }
    return {
      id: boardId,
      total: 0,
      active: 0,
      archived: 0,
      byStatus: {},
    };
  }

  override render() {
    const context = this.context;
    if (!context) {
      return nothing;
    }
    const gateway = context.gateway.snapshot;
    const config = context.runtimeConfig.state;
    const auth = gateway.hello?.auth ?? null;
    const pluginEnabled = this.pluginEnabled();
    const selectedBoard = this.selectedBoard();
    return html`
      <section class="content-header content-header--page">
        <div>
          <div class="page-title workboard-page-title">
            ${selectedBoard
              ? renderWorkboardBoardGlyph(selectedBoard, "workboard-board-glyph--header")
              : nothing}
            <span
              >${selectedBoard
                ? workboardBoardName(selectedBoard)
                : titleForRoute("workboard")}</span
            >
          </div>
          ${selectedBoard
            ? html`<div class="page-subtitle">${titleForRoute("workboard")}</div>`
            : nothing}
        </div>
        ${renderAgentScopeControl({
          agents: context.agents.state.agentsList?.agents ?? [],
          selection: context.agentSelection,
        })}
      </section>
      ${renderWorkboard({
        host: context.workboard,
        client: gateway.client,
        connected: gateway.phase === "connected",
        canWrite: hasOperatorWriteAccess(auth),
        canGrant: hasOperatorApprovalsAccess(auth),
        canModelOverride: hasOperatorAdminAccess(auth),
        pluginEnabled,
        pluginEnablementError:
          !config.configSnapshot && !config.configLoading ? config.lastError : null,
        agentsList: context.agents.state.agentsList,
        sessions: context.sessions.state.result?.sessions ?? [],
        scopeAgentId: context.agentSelection.state.scopeId,
        showAgentFilter: context.agentSelection.state.scopeId === null,
        onOpenSession: (sessionKey) => {
          context.navigate("chat", { search: searchForSession(sessionKey), hash: "" });
        },
        onReloadConfig: () => this.reloadConfig(),
        onBoardFilterChange: (boardFilter) => this.setWorkboardBoardFilter(boardFilter),
        onRequestUpdate: this.requestPageUpdate,
      })}
    `;
  }
}

if (!customElements.get("openclaw-workboard-page")) {
  customElements.define("openclaw-workboard-page", WorkboardPage);
}
