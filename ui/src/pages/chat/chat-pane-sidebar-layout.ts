import { html, type TemplateResult } from "lit";
import { styleMap } from "lit/directives/style-map.js";
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
} from "./components/chat-sidebar-region-types.ts";
import type { SidebarFullMessageLoader } from "./components/chat-sidebar.ts";
import {
  activatePanel,
  closeSlot,
  ensureSidebarConversation,
  fitSidebarLayout,
  isSidebarRegionCollapsed,
  openSlot,
  reorderPanel,
  setSidebarExpanded,
  sidebarDock,
  sidebarMainPanel,
  isSidebarSlotVisible,
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

function ensureLazyElement(
  key: LazyElementKey,
  requestUpdate: () => void,
): TemplateResult | null | undefined {
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
    return null;
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
  return null;
}

/**
 * Region callbacks: the pure layout moves resolve here, while the pane injects
 * what only it owns — the board dock, the cached discussion url, the persisted
 * resize, and the panel's open state.
 */
export function sidebarRegionCallbacks(params: {
  state: ChatPageHost;
  layout: SidebarLayout;
  closePanelSlot: (slot: SidebarSlotId) => void;
  openPanelSlot: (slot: SidebarSlotId) => void;
  appendComposerText: (text: string) => void;
  forgetDiscussionUrl: () => void;
  resizePanel: (columnId: string, size: number) => void;
  setPanelOpen: (open: boolean) => void;
}): SidebarRegionCallbacks {
  const { layout, state } = params;
  return {
    activatePanel: (panelId) => {
      state.updateSidebarLayout(activatePanel(layout, panelId));
      state.updateSidebarActivePanel(panelId);
    },
    closeSlot: (slot) => {
      if (slot === "conversation") {
        params.setPanelOpen(false);
        return;
      }
      if (slot === "discussion") {
        params.forgetDiscussionUrl();
      }
      params.closePanelSlot(slot);
    },
    openSlot: params.openPanelSlot,
    appendComposerText: params.appendComposerText,
    reorderPanel: (panelId, targetPanelId, placement) =>
      state.updateSidebarLayout(reorderPanel(layout, panelId, targetPanelId, placement)),
    resizePanel: params.resizePanel,
    setExpanded: (expanded) =>
      state.updateSidebarLayout(setSidebarExpanded(ensureSidebarConversation(layout), expanded)),
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
}): TemplateResult {
  const panelDefinitions = params.panelDefinitions ?? sidebarPanelDefinitions();
  const panelOpen = params.layout.open === true;
  const hasPanels = params.layout.columns.length > 0;
  const regionError = hasPanels ? ensureLazyElement("region", params.requestUpdate) : undefined;
  let panelTemplates: SidebarPanelTemplates | null = null;
  for (const panel of params.layout.columns[0]?.panels ?? []) {
    const lazyState = ensureLazyElement(panel.slot, params.requestUpdate);
    if (lazyState !== undefined) {
      panelTemplates ??= { ...params.panelTemplates };
      panelTemplates[panel.slot] =
        lazyState ?? panelDefinitions.find((definition) => definition.slot === panel.slot)?.loading;
    }
  }
  const availableWidth =
    params.availableWidth > 0 ? params.availableWidth : Number.POSITIVE_INFINITY;
  const collapsed = params.narrow || isSidebarRegionCollapsed(params.layout, availableWidth);
  const main = sidebarMainPanel(params.layout);
  const chatMain = !main || main.slot === "conversation";
  const column = params.layout.columns[0];
  const activePanelId = params.layout.columns[0]?.activePanelId;
  const activePanelSlot = params.layout.columns[0]?.panels.find(
    (panel) => panel.id === activePanelId,
  )?.slot;
  const regionLoading = panelDefinitions.find(
    (definition) => definition.slot === activePanelSlot,
  )?.loading;
  return html`<div
    class="sidebar-region ${collapsed ? "sidebar-region--narrow" : ""} ${
      params.layout.expanded ? "sidebar-region--expanded" : ""
    } sidebar-region--${sidebarDock(params.layout)} ${panelOpen ? "sidebar-region--open" : ""}"
    style=${styleMap({
      "--side-panel-width": `${column?.width ?? 480}px`,
      "--side-panel-height": `${column?.height ?? 360}px`,
    })}
  >
    ${
      regionError !== undefined
        ? regionError === null
          ? (regionLoading ?? null)
          : null
        : html`<openclaw-chat-sidebar-region
            .layout=${params.layout}
            .panelDefinitions=${panelDefinitions}
            .panelTemplates=${panelTemplates ?? params.panelTemplates}
            .panelActions=${params.panelActions}
            .availableSlots=${params.availableSlots}
            .callbacks=${params.callbacks}
            .narrow=${params.narrow}
            .availableWidth=${params.availableWidth}
          ></openclaw-chat-sidebar-region>`
    }
    <div
      class="sidebar-region__primary"
      data-region=${chatMain ? "main" : "side"}
      ?hidden=${!isSidebarSlotVisible(params.layout, "conversation")}
    >
      ${params.primary}
    </div>
    <div class="sidebar-region__right-runtime">${regionError ?? null}</div>
  </div>`;
}

export function resolveSidebarLayoutForBoard(params: {
  board: ResolvedBoardView;
  layout: SidebarLayout;
  paneWidth: number;
}): SidebarLayout {
  let layout = params.layout;
  if (!params.board.hasBoard) {
    if (params.board.provider.hasLoadedSnapshot) {
      layout = closeSlot(layout, "dashboard");
    }
    return fitSidebarLayout(layout, params.paneWidth) ?? layout;
  }
  if (params.board.face !== "dashboard" || layout.columns.length > 0) {
    return fitSidebarLayout(layout, params.paneWidth) ?? layout;
  }
  layout = openSlot(layout, "dashboard");
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
