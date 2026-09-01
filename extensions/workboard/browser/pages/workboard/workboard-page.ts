import { html, nothing, render } from "lit";
import type { ControlUiView } from "openclaw/plugin-sdk/control-ui";
import { createWorkboardClient } from "../../api/gateway.ts";
import type { AgentsListResult } from "../../api/types.ts";
import { renderAgentPicker } from "../../components/host-components.ts";
import { icons } from "../../components/icons.ts";
import { renderWorkboardBoardGlyph } from "../../components/workboard-board-glyph.ts";
import { t } from "../../i18n/index.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { workboardBoardName } from "../../lib/workboard/board-presentation.ts";
import type { WorkboardCapability } from "../../lib/workboard/capability.ts";
import {
  configureWorkboardLiveRefresh,
  handleWorkboardChanged,
  loadWorkboard,
  resetDraftState,
  resumeWorkboardLiveRefresh,
  stopWorkboardLifecycleRefresh,
  stopWorkboardLiveRefresh,
  syncWorkboardLifecycle,
  type WorkboardCard,
  type WorkboardUiState,
  WORKBOARD_CHANGED_EVENT,
} from "../../lib/workboard/index.ts";
import { matchesAgentScope } from "./agent-filter.ts";
import { matchesBoardFilter, WORKBOARD_ALL_BOARDS_FILTER } from "./board-filter.ts";
import { renderWorkboard } from "./view.ts";

export function workboardPageTarget(boardId?: string) {
  return {
    id: "workboard",
    path: boardId && boardId !== WORKBOARD_ALL_BOARDS_FILTER ? [boardId] : [],
  };
}

function reconcileCardOverlays(state: WorkboardUiState, visible: (card: WorkboardCard) => boolean) {
  const remainsVisible = (id: string) =>
    state.cards.some((card) => card.id === id && visible(card));
  if (state.detailCardId && !remainsVisible(state.detailCardId)) {
    state.detailCardId = null;
    state.detailCommentBody = "";
  }
  if (state.editingCardId && !remainsVisible(state.editingCardId)) {
    resetDraftState(state);
  }
}

export function createWorkboardPage(workboard: WorkboardCapability): ControlUiView {
  return (container, initialContext) => {
    const host = initialContext.host;
    let context = initialContext;
    let disposed = false;
    let queued = false;
    let connected = false;
    let agentsList: AgentsListResult | null = null;
    let metadataGeneration = 0;
    let observedScope: string | null | undefined;
    let redirectedBoard = "";
    const client = createWorkboardClient(host);
    const state = workboard.state;
    const requestUpdate = () => {
      if (disposed || queued) {
        return;
      }
      queued = true;
      queueMicrotask(() => {
        queued = false;
        if (!disposed) {
          update();
        }
      });
    };
    const stop = () => {
      stopWorkboardLiveRefresh(workboard);
      stopWorkboardLifecycleRefresh(workboard);
    };
    const synchronizeConnection = () => {
      const nextConnected = host.connection.connected;
      if (connected === nextConnected) {
        return;
      }
      connected = nextConnected;
      const generation = ++metadataGeneration;
      if (!connected) {
        stop();
        return;
      }
      void Promise.all([
        host.agents.refresh(),
        host.sessions.refresh(),
        host.request<AgentsListResult>("agents.list", {}),
      ])
        .then((results) => {
          if (disposed || generation !== metadataGeneration) {
            return;
          }
          agentsList = results[2];
          requestUpdate();
        })
        .catch((error: unknown) => {
          if (disposed || generation !== metadataGeneration) {
            return;
          }
          state.error = formatUiError(error);
          requestUpdate();
        });
    };
    const update = () => {
      synchronizeConnection();
      const boardId =
        context.props.boardId || context.props.boardFilter || WORKBOARD_ALL_BOARDS_FILTER;
      const scope = host.agents.scopeId;
      if (observedScope !== scope) {
        observedScope = scope;
        state.agentFilter = "all";
        reconcileCardOverlays(state, (card) => matchesAgentScope(card, agentsList, scope));
      }
      if (state.boardFilter !== boardId) {
        state.boardFilter = boardId;
        reconcileCardOverlays(state, (card) => matchesBoardFilter(card, boardId));
      }
      if (
        boardId !== WORKBOARD_ALL_BOARDS_FILTER &&
        workboard.boardsReady &&
        !state.boards.some((board) => board.id === boardId)
      ) {
        if (redirectedBoard !== boardId) {
          redirectedBoard = boardId;
          host.navigation.openPage(workboardPageTarget(), {
            replace: true,
            preserveSearch: true,
          });
        }
      } else {
        redirectedBoard = "";
      }
      if (connected && context.presented) {
        const force = configureWorkboardLiveRefresh({ host: workboard, client, requestUpdate });
        void loadWorkboard({
          host: workboard,
          client,
          requestUpdate,
          force,
          refreshDiagnostics: host.connection.canWrite,
        });
        if (!state.dispatching) {
          void syncWorkboardLifecycle({ host: workboard, client, requestUpdate });
        }
        resumeWorkboardLiveRefresh(workboard);
      } else {
        stop();
      }
      const selectedBoard =
        boardId === WORKBOARD_ALL_BOARDS_FILTER
          ? null
          : state.boards.find((board) => board.id === boardId);
      const agents = host.agents.rows;
      const currentAgents = agentsList ? { ...agentsList, agents: [...agents] } : null;
      render(
        html`
          <section class="content-header content-header--page">
            <div>
              <div class="page-title workboard-page-title">
                ${selectedBoard
                  ? renderWorkboardBoardGlyph(selectedBoard, "workboard-board-glyph--header")
                  : nothing}
                <span>${selectedBoard ? workboardBoardName(selectedBoard) : "Workboard"}</span>
                ${selectedBoard?.automationJobId
                  ? html`<a
                      class="chip workboard-automation-chip"
                      href=${`${host.basePath}/automations`}
                      title=${t("workboard.automationAttachedTitle")}
                      aria-label=${t("workboard.automationAttachedTitle")}
                      >${icons.calendarClock}<span>${t("workboard.automationAttached")}</span></a
                    >`
                  : nothing}
              </div>
              ${selectedBoard ? html`<div class="page-subtitle">Workboard</div>` : nothing}
            </div>
            ${renderAgentPicker(
              {
                options: [
                  { value: "", label: t("workboard.allAgents"), icon: "users" },
                  ...agents
                    .filter((agent) => agent.kind !== "system")
                    .map((agent) => ({
                      value: agent.id,
                      label: agent.name ?? agent.identity?.name ?? agent.id,
                      agent,
                    })),
                ],
                value: scope ?? "",
                accessibleLabel: t("workboard.agentFilter"),
                onSelect: (value) => host.agents.setScope(value || null),
              },
              "agent-scope-control",
            )}
          </section>
          ${renderWorkboard({
            host: workboard,
            client: connected ? client : null,
            connected,
            canWrite: host.connection.canWrite,
            canGrant: host.connection.canGrant,
            canModelOverride: host.connection.canAdmin,
            pluginEnabled: true,
            agentsList: currentAgents,
            defaultAgentId: host.connection.assistantAgentId,
            sessions: [...host.sessions.rows],
            scopeAgentId: scope,
            showAgentFilter: scope === null,
            onOpenSession: host.sessions.open,
            onBoardFilterChange: (boardFilter) =>
              host.navigation.openPage(workboardPageTarget(boardFilter), {
                replace: true,
                preserveSearch: true,
              }),
            onRequestUpdate: requestUpdate,
          })}
        `,
        container,
      );
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        resumeWorkboardLiveRefresh(workboard);
      }
    };
    const unsubscribeHost = host.subscribe(() => {
      if (disposed) {
        return;
      }
      synchronizeConnection();
      requestUpdate();
    });
    const unsubscribeState = workboard.subscribe(requestUpdate);
    const unsubscribeEvents = host.onEvent(WORKBOARD_CHANGED_EVENT, (payload) => {
      if (!disposed && connected && context.presented) {
        handleWorkboardChanged(workboard, payload);
      }
    });
    document.addEventListener("visibilitychange", onVisibilityChange);
    update();
    return {
      update(next) {
        context = next;
        requestUpdate();
      },
      dispose() {
        disposed = true;
        metadataGeneration += 1;
        unsubscribeHost();
        unsubscribeState();
        unsubscribeEvents();
        document.removeEventListener("visibilitychange", onVisibilityChange);
        stop();
        render(nothing, container);
      },
    };
  };
}
