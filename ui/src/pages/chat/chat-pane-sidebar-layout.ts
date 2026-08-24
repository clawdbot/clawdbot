import { html, nothing, type TemplateResult } from "lit";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { ensureCustomElementDefined } from "../../app/lazy-custom-element.ts";
import {
  isStaleChunkImportError,
  retryStaleChunkReloadWhenReachable,
} from "../../app/stale-chunk-reload.ts";
import { renderLazyViewError } from "../../components/lazy-view-error.ts";
import { sidebarPanelDefinitions } from "./chat-pane-embedded-panels.ts";
import type { ResolvedBoardView } from "./chat-pane-shared.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import type {
  SidebarPanelDefinition,
  SidebarPanelTemplates,
  SidebarRegionCallbacks,
  SidebarSurfaceActivity,
} from "./components/chat-sidebar-region-types.ts";
import type { SidebarFullMessageLoader } from "./components/chat-sidebar.ts";
import {
  activatePanel,
  closeSlot,
  fitSidebarLayout,
  isSidebarRegionCollapsed,
  openSlot,
  reorderPanel,
  setSidebarDock,
  setSidebarExpanded,
  sidebarDock,
  type SidebarLayout,
  type SidebarSlotId,
} from "./sidebar-layout.ts";

const DETAIL_FULL_MESSAGE_MAX_CHARS = 500_000;
type LazyPanelRuntime = {
  error?: TemplateResult;
  listeners: Set<() => void>;
  pending?: Promise<void>;
};

type LazyElementKey = "region" | SidebarSlotId;
type LazyElement = readonly [tagName: string, loadModule: () => Promise<unknown>];

const LAZY_SIDEBAR_ELEMENTS: Partial<Record<LazyElementKey, LazyElement>> = {
  region: [
    "openclaw-chat-sidebar-region",
    () => import("./components/chat-sidebar-region.runtime.ts"),
  ],
  terminal: [
    "openclaw-terminal-panel",
    () => import("../../components/terminal/terminal-panel-registration.ts"),
  ],
  browser: ["openclaw-browser-panel", () => import("../../components/browser/browser-panel.ts")],
  desktop: ["openclaw-desktop-panel", () => import("../../components/desktop/desktop-panel.ts")],
  companion: ["openclaw-chat-session-rail", () => import("./components/chat-session-rail.ts")],
  discussion: [
    "openclaw-session-discussion",
    () => import("./components/session-discussion-panel.ts"),
  ],
};

const lazyRuntimes = new Map<LazyElementKey, LazyPanelRuntime>();

function ensureLazyElement(key: LazyElementKey, requestUpdate: () => void) {
  const element = LAZY_SIDEBAR_ELEMENTS[key];
  if (!element) {
    return undefined;
  }
  const [tagName, loadModule] = element;
  if (customElements.get(tagName)) {
    lazyRuntimes.delete(key);
    return undefined;
  }
  const runtime = lazyRuntimes.get(key) ?? { listeners: new Set() };
  lazyRuntimes.set(key, runtime);
  if (runtime.error !== undefined) {
    return runtime.error;
  }
  runtime.listeners.add(requestUpdate);
  if (runtime.pending) {
    return undefined;
  }
  runtime.pending = ensureCustomElementDefined(tagName, loadModule)
    .catch((error: unknown) => {
      runtime.error = renderLazyViewError({
        error,
        stale: isStaleChunkImportError(error),
        onRetry: () => void retryStaleChunkReloadWhenReachable(),
      });
    })
    .finally(() => {
      delete runtime.pending;
      runtime.listeners.forEach((listener) => listener());
      runtime.listeners.clear();
    });
  return undefined;
}

/**
 * Region callbacks: the pure layout moves resolve here, while the pane injects
 * what only it owns — the board dock, the cached discussion url, the persisted
 * resize, and the panel's open state.
 */
export function sidebarRegionCallbacks(params: {
  state: ChatPageHost;
  closePanelSlot: (slot: SidebarSlotId) => void;
  openPanelSlot: (slot: SidebarSlotId) => void;
  hideBoard: () => void;
  forgetDiscussionUrl: () => void;
  resizePanel: (columnId: string, size: number) => void;
  setPanelOpen: (open: boolean) => void;
}): SidebarRegionCallbacks {
  const { state } = params;
  return {
    activatePanel: (panelId) => {
      state.updateSidebarLayout(activatePanel(state.sidebarLayout, panelId));
      state.updateSidebarActivePanel(panelId);
    },
    closeSlot: (slot) => {
      if (slot === "chat") {
        params.hideBoard();
        return;
      }
      if (slot === "discussion") {
        params.forgetDiscussionUrl();
      }
      params.closePanelSlot(slot);
    },
    openSlot: params.openPanelSlot,
    reorderPanel: (panelId, targetPanelId, placement) =>
      state.updateSidebarLayout(
        reorderPanel(state.sidebarLayout, panelId, targetPanelId, placement),
      ),
    resizePanel: params.resizePanel,
    setDock: (dock) => state.updateSidebarLayout(setSidebarDock(state.sidebarLayout, dock)),
    setExpanded: (expanded) =>
      state.updateSidebarLayout(setSidebarExpanded(state.sidebarLayout, expanded)),
    setOpen: params.setPanelOpen,
  };
}

export function renderSidebarRegion(params: {
  availableWidth: number;
  callbacks: SidebarRegionCallbacks;
  availableSlots: SidebarSlotId[];
  layout: SidebarLayout;
  narrow: boolean;
  panelDefinitions?: SidebarPanelDefinition[];
  panelActions: SidebarPanelTemplates;
  panelTemplates: SidebarPanelTemplates;
  primary: TemplateResult;
  requestUpdate: () => void;
  surfaceComposer?: TemplateResult | typeof nothing;
  surfaceActivity?: SidebarSurfaceActivity | null;
  surfaceSlot?: "browser" | "desktop" | "terminal";
}): TemplateResult {
  const panelOpen = params.layout.open === true;
  const regionError = panelOpen ? ensureLazyElement("region", params.requestUpdate) : undefined;
  let panelTemplates: SidebarPanelTemplates | null = null;
  for (const panel of params.layout.columns[0]?.panels ?? []) {
    const error = ensureLazyElement(panel.slot, params.requestUpdate);
    if (error !== undefined) {
      panelTemplates ??= { ...params.panelTemplates };
      panelTemplates[panel.slot] = error;
    }
  }
  const availableWidth =
    params.availableWidth > 0 ? params.availableWidth : Number.POSITIVE_INFINITY;
  const collapsed = params.narrow || isSidebarRegionCollapsed(params.layout, availableWidth);
  return html`<div
    class="sidebar-region ${collapsed && panelOpen ? "sidebar-region--narrow" : ""} ${panelOpen &&
    params.layout.expanded
      ? "sidebar-region--expanded"
      : ""} ${panelOpen && sidebarDock(params.layout) === "bottom" ? "sidebar-region--bottom" : ""}"
  >
    ${regionError !== undefined
      ? null
      : html`<openclaw-chat-sidebar-region
          .layout=${params.layout}
          .panelDefinitions=${params.panelDefinitions ?? sidebarPanelDefinitions()}
          .panelTemplates=${panelTemplates ?? params.panelTemplates}
          .panelActions=${params.panelActions}
          .availableSlots=${params.availableSlots}
          .callbacks=${params.callbacks}
          .narrow=${params.narrow}
          .availableWidth=${params.availableWidth}
          .surfaceComposer=${params.surfaceComposer ?? nothing}
          .surfaceActivity=${params.surfaceActivity ?? null}
          .surfaceSlot=${params.surfaceSlot ?? null}
        ></openclaw-chat-sidebar-region>`}
    <div class="sidebar-region__primary">${params.primary}</div>
    <div class="sidebar-region__right-runtime">${regionError ?? null}</div>
  </div>`;
}

export function resolveSidebarLayoutForBoard(params: {
  board: ResolvedBoardView;
  layout: SidebarLayout;
  paneWidth: number;
}): SidebarLayout {
  let layout = params.layout;
  const chatSide =
    params.board.hasBoard &&
    params.board.face === "dashboard" &&
    (params.board.dock === "left" || params.board.dock === "right")
      ? params.board.dock
      : null;
  if (!chatSide) {
    layout = closeSlot(layout, "chat");
    return fitSidebarLayout(layout, params.paneWidth) ?? layout;
  }
  const explicitlyClosed = layout.columns.length > 0 && layout.open === false;
  const selectedPanelId = layout.columns[0]?.activePanelId;
  layout = openSlot(layout, "chat");
  // Board projection must guarantee the chat tab exists without stealing the
  // user's selected side-panel tab on every render.
  if (selectedPanelId) {
    layout = activatePanel(layout, selectedPanelId);
  }
  layout = { ...layout, open: !explicitlyClosed };
  return fitSidebarLayout(layout, params.paneWidth) ?? layout;
}

export function createSidebarFullMessageLoader(
  state: { client: GatewayBrowserClient | null; connected: boolean },
  disabled: boolean,
): SidebarFullMessageLoader | null {
  if (disabled || !state.client || !state.connected) {
    return null;
  }
  return async (request) => {
    if (!state.client || !state.connected) {
      return null;
    }
    return state.client.request("chat.message.get", {
      sessionKey: request.sessionKey,
      ...(request.agentId ? { agentId: request.agentId } : {}),
      messageId: request.messageId,
      maxChars: DETAIL_FULL_MESSAGE_MAX_CHARS,
    });
  };
}
