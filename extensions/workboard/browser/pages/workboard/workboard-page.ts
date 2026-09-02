import { html, nothing, render } from "lit";
import type { ControlUiView } from "openclaw/plugin-sdk/control-ui";
import { createWorkboardClient } from "../../api/gateway.ts";
import { renderAgentPicker } from "../../components/host-components.ts";
import { icons } from "../../components/icons.ts";
import { renderWorkboardBoardGlyph } from "../../components/workboard-board-glyph.ts";
import { t } from "../../i18n/index.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { workboardBoardName } from "../../lib/workboard/board-presentation.ts";
import type { WorkboardCapability } from "../../lib/workboard/capability.ts";
import { workboardCardSessionKey } from "../../lib/workboard/card-state.ts";
import {
  configureWorkboardLiveRefresh,
  handleWorkboardChanged,
  loadWorkboard,
  refreshWorkboard,
  resetDraftState,
  resumeWorkboardLiveRefresh,
  stopWorkboardLifecycleRefresh,
  stopWorkboardLiveRefresh,
  syncWorkboardLifecycle,
  type WorkboardCard,
  type WorkboardUiState,
  WORKBOARD_CHANGED_EVENT,
} from "../../lib/workboard/index.ts";
import { createWorkboardSessionResolver } from "../../lib/workboard/session-resolution.ts";
import { matchesAgentScope } from "./agent-filter.ts";
import { matchesBoardFilter, WORKBOARD_ALL_BOARDS_FILTER } from "./board-filter.ts";
import { getVisibleDetailCard } from "./view-card-details.ts";
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
  // Preserve submitted input for retry if the pending save fails.
  if (!state.draftSaving && state.editingCardId && !remainsVisible(state.editingCardId)) {
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
    let refreshActive = false;
    let metadataGeneration = 0;
    let metadataLoad: Promise<void> | null = null;
    // Card reloads cannot clear an unresolved agent/session metadata failure.
    let metadataError: string | null = null;
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
    const sessionResolver = createWorkboardSessionResolver(host, requestUpdate);
    const stop = () => {
      // A paused page no longer owns shared loads started by session actions.
      if (!refreshActive) {
        return;
      }
      refreshActive = false;
      stopWorkboardLiveRefresh(workboard);
      stopWorkboardLifecycleRefresh(workboard);
    };
    const refreshMetadata = () => {
      if (disposed || !connected) {
        return Promise.resolve();
      }
      if (metadataLoad) {
        return metadataLoad;
      }
      const generation = metadataGeneration;
      const load = host.agents
        .refresh()
        .then(() => {
          if (disposed || generation !== metadataGeneration) {
            return;
          }
          metadataError = null;
          requestUpdate();
        })
        .catch((error: unknown) => {
          if (disposed || generation !== metadataGeneration) {
            return;
          }
          metadataError = formatUiError(error);
          requestUpdate();
        })
        .finally(() => {
          if (metadataLoad === load) {
            metadataLoad = null;
          }
        });
      metadataLoad = load;
      return load;
    };
    const synchronizeConnection = () => {
      const nextConnected = host.connection.connected;
      if (connected === nextConnected) {
        return;
      }
      connected = nextConnected;
      metadataGeneration += 1;
      metadataLoad = null;
      if (connected) {
        void refreshMetadata();
      } else {
        stop();
      }
    };
    const update = () => {
      synchronizeConnection();
      const agents = host.agents.rows;
      const defaultId = host.agents.defaultId;
      const defaultAgentId = defaultId ?? host.connection.assistantAgentId;
      const agentsList = defaultId === null ? null : { defaultId, agents: [...agents] };
      const boardId =
        context.props.boardId || context.props.boardFilter || WORKBOARD_ALL_BOARDS_FILTER;
      const scope = host.agents.scopeId;
      if (observedScope !== scope) {
        observedScope = scope;
        state.agentFilter = "all";
        reconcileCardOverlays(state, (card) => matchesAgentScope(card, defaultAgentId, scope));
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
        refreshActive = true;
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
      const focusedCard = state.draftOpen
        ? state.cards.find((card) => card.id === state.editingCardId)
        : getVisibleDetailCard(state);
      sessionResolver.sync(
        focusedCard ? workboardCardSessionKey(focusedCard) : undefined,
        connected && context.presented,
      );
      const sessionResolution = sessionResolver.resolution;
      const sessionError =
        sessionResolution && sessionResolution.status !== "resolved"
          ? sessionResolution.error
          : undefined;
      const candidates =
        sessionResolution?.status === "resolved"
          ? [sessionResolution.session]
          : (sessionResolution?.candidates ?? []);
      const sessions = [
        ...new Map(
          [...host.sessions.rows, ...candidates].map((session) => [session.key, session]),
        ).values(),
      ];
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
          ${metadataError
            ? html`<div class="callout danger" role="alert">${metadataError}</div>`
            : nothing}
          ${sessionError
            ? html`<div class="callout danger" role="alert">${sessionError}</div>`
            : nothing}
          ${renderWorkboard({
            host: workboard,
            client: connected ? client : null,
            connected,
            canWrite: host.connection.canWrite,
            canGrant: host.connection.canGrant,
            canModelOverride: host.connection.canAdmin,
            agentsList,
            defaultAgentId,
            sessions,
            sessionResolution,
            scopeAgentId: scope,
            showAgentFilter: scope === null,
            onOpenSession: host.sessions.open,
            onRefresh: () => {
              void refreshMetadata();
              sessionResolver.refresh();
              void refreshWorkboard({
                host: workboard,
                client: connected ? client : null,
                requestUpdate,
                source: "manual",
                refreshDiagnostics: host.connection.canWrite,
              });
            },
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
        sessionResolver.dispose();
        document.removeEventListener("visibilitychange", onVisibilityChange);
        stop();
        render(nothing, container);
      },
    };
  };
}
