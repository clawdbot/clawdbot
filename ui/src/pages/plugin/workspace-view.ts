// Control UI view renders the Workspaces bundled tab: tab strip, widget grid with
// hand-rolled pointer drag/drop + resize, empty states. Pure render fns — the
// controller owns lifecycle and `lib/workspace` owns data logic.

import { html, nothing, type TemplateResult } from "lit";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import "../../components/modal-dialog.ts";
import { icons } from "../../components/icons.ts";
import {
  loadWidgetManifestView,
  type CustomWidgetHostContext,
} from "../../components/workspace-custom-widget.ts";
import {
  renderWidgetCell,
  type WorkspaceCustomWidgetContext,
  type WorkspaceWidgetCellCallbacks,
} from "../../components/workspace-widget-cell.ts";
import { t } from "../../i18n/index.ts";
import {
  beginDrag,
  collides,
  WORKSPACE_GRID_GAP,
  WORKSPACE_ROW_HEIGHT,
  gridPlacementStyle,
  gridRowCount,
  nudgeRect,
  resolveDrop,
  updateDrag,
  type WorkspaceDragState,
} from "../../lib/workspace/grid.ts";
import {
  approveWidget,
  clearActiveDrag,
  customWidgetName,
  customWidgetStatus,
  findTab,
  getWorkspaceState,
  hiddenTabs,
  hideWidget,
  loadWorkspace,
  moveWidget,
  moveWidgetToTab,
  orderedTabs,
  removeWidgetFromTab,
  resolveActiveSlug,
  registerActiveDrag,
  resolveBinding,
  setWidgetCollapsed,
  startBindingPolling,
  subscribeToWorkspaceEvents,
  updateWidgetTitle,
  visibleTabs,
  type WorkspaceBindingResult,
  type WorkspaceUiState,
} from "../../lib/workspace/index.ts";
import type {
  WorkspaceBinding,
  WorkspaceTab,
  WorkspaceWidget,
  WorkspaceDocument,
  WidgetManifestView,
} from "../../lib/workspace/types.ts";
import type { BuiltinWidgetContext } from "../../lib/workspace/widgets/index.ts";
import { getSafeLocalStorage } from "../../local-storage.ts";
import "../../styles/workspace.css";
import { pluginTabRefFromSearch } from "./route.ts";

type WorkspaceProps = {
  host: object;
  client: GatewayBrowserClient | null;
  connected: boolean;
  /** Control UI embed policy for the iframe-embed builtin (defaults to strict). */
  embed?: BuiltinWidgetContext["embed"];
  onRequestUpdate?: () => void;
  /** Gateway HTTP base path for custom-widget iframe sources (L5). */
  basePath?: string;
  /** Session key for custom-widget prompt dispatch (L5). */
  sessionKey?: string;
};

const DEFAULT_EMBED_CONTEXT: BuiltinWidgetContext["embed"] = {
  embedSandboxMode: "strict",
  allowExternalEmbedUrls: false,
};

// Per-host transient view state (menu, live drag) kept outside the data model so a
// broadcast refetch never clobbers an open menu or an in-flight drag.
type WorkspaceViewState = {
  openMenuWidgetId: string | null;
  drag: WorkspaceDragState | null;
  /** Resolved binding cache keyed by widgetId; refreshed when the doc changes. */
  bindingResults: Map<string, WorkspaceBindingResult>;
  bindingLoads: Set<string>;
  bindingVersion: number;
  /** Loaded custom-widget manifests keyed by widget name for one workspace version. */
  manifestCache: Map<string, WidgetManifestView>;
  manifestLoads: Set<string>;
  manifestVersion: number;
  manifestConnected: boolean;
  manifestEpoch: number;
  /**
   * Monotonic data-refresh counter bumped by the per-widget polling timer.
   * Folded into the binding cache key so a poll tick re-resolves data-widget
   * bindings without a workspace-version change.
   */
  dataVersion: number;
  /** Active themed dialog (#12) for edit-title / move-to-tab, or null. */
  dialog: WorkspaceDialogState | null;
  /** First-visit onboarding banner dismissed this session (#5); mirrors localStorage. */
  onboardingDismissed: boolean;
};

/** localStorage flag so the first-visit onboarding banner (#5) stays dismissed across reloads. */
const ONBOARDING_DISMISS_KEY = "openclaw:control-ui:workspace-onboarding-dismissed:v1";

function isOnboardingDismissed(): boolean {
  try {
    return getSafeLocalStorage()?.getItem(ONBOARDING_DISMISS_KEY) === "1";
  } catch {
    return false;
  }
}

function persistOnboardingDismissed(): void {
  try {
    getSafeLocalStorage()?.setItem(ONBOARDING_DISMISS_KEY, "1");
  } catch {
    // Best effort — dismissing the hint is not a product failure.
  }
}

/** Themed-dialog state replacing the old window.prompt() flows (#12). */
type WorkspaceDialogState =
  | { kind: "editTitle"; slug: string; widgetId: string; title: string }
  | { kind: "moveToTab"; slug: string; widgetId: string };

const workspaceViewStates = new WeakMap<object, WorkspaceViewState>();

// Per-host document dismiss listener for the open kebab menu (#3). Installed while
// a menu is open so an outside pointerdown or Escape closes it; removed when the
// menu closes or the view stops. The details-based hidden-tabs menu closes via its
// own native outside-click/Escape once we drop `open` on the same signals.
type MenuDismissBinding = {
  onPointerDown: (event: PointerEvent) => void;
  onKeyDown: (event: KeyboardEvent) => void;
};
const workspaceMenuDismiss = new WeakMap<object, MenuDismissBinding>();

/** Remove the active menu-dismiss document listeners for `host`, if any. */
function teardownMenuDismiss(host: object): void {
  const binding = workspaceMenuDismiss.get(host);
  if (!binding) {
    return;
  }
  document.removeEventListener("pointerdown", binding.onPointerDown, true);
  document.removeEventListener("keydown", binding.onKeyDown, true);
  workspaceMenuDismiss.delete(host);
}

/**
 * Ensure the document-level dismiss listeners match whether a kebab menu is open.
 * When open, an outside pointerdown or Escape clears `openMenuWidgetId`; a click
 * inside the open menu/toggle is ignored so menu items still fire.
 */
function syncMenuDismiss(
  host: object,
  viewState: WorkspaceViewState,
  requestUpdate: () => void,
): void {
  const menuOpen = viewState.openMenuWidgetId !== null;
  const active = workspaceMenuDismiss.has(host);
  if (menuOpen === active) {
    return;
  }
  if (!menuOpen) {
    teardownMenuDismiss(host);
    return;
  }
  const close = () => {
    if (viewState.openMenuWidgetId === null) {
      return;
    }
    viewState.openMenuWidgetId = null;
    teardownMenuDismiss(host);
    requestUpdate();
  };
  const onPointerDown = (event: PointerEvent) => {
    const target = event.target;
    if (
      target instanceof Element &&
      target.closest(".workspace-widget__menu, .workspace-widget__menu-toggle")
    ) {
      return;
    }
    close();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
    }
  };
  document.addEventListener("pointerdown", onPointerDown, true);
  document.addEventListener("keydown", onKeyDown, true);
  workspaceMenuDismiss.set(host, { onPointerDown, onKeyDown });
}

/** View-level teardown: drop any menu-dismiss listeners. Called from the controller's stop. */
export function stopWorkspaceView(host: object): void {
  teardownMenuDismiss(host);
}

function getViewState(host: object): WorkspaceViewState {
  let state = workspaceViewStates.get(host);
  if (!state) {
    state = {
      openMenuWidgetId: null,
      drag: null,
      bindingResults: new Map(),
      bindingLoads: new Set(),
      bindingVersion: -1,
      manifestCache: new Map(),
      manifestLoads: new Set(),
      manifestVersion: -1,
      manifestConnected: false,
      manifestEpoch: 0,
      dataVersion: 0,
      dialog: null,
      onboardingDismissed: isOnboardingDismissed(),
    };
    workspaceViewStates.set(host, state);
  }
  return state;
}

/** Advance the data-refresh counter so the next render re-resolves bindings. */
function bumpWorkspaceDataVersion(host: object): void {
  getViewState(host).dataVersion += 1;
}

/** The workspace tab slug requested via the `?ws=` deep-link query param. */
function requestedWorkspaceSlug(search: string): string | null {
  const params = new URLSearchParams(search);
  const ws = params.get("ws")?.trim();
  return ws ? ws : null;
}

/** Deep-link to a workspace tab: update `?ws=` and drive the router via popstate. */
function navigateToWorkspaceTab(slug: string): void {
  const url = new URL(window.location.href);
  const ref = pluginTabRefFromSearch(url.search);
  url.searchParams.set("plugin", ref.pluginId);
  url.searchParams.set("id", ref.id);
  url.searchParams.set("ws", slug);
  window.history.pushState({}, "", `${url.pathname}${url.search}${url.hash}`);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

/** Primary binding for a widget (first declared), if any. */
function primaryBinding(widget: WorkspaceWidget): WorkspaceBinding | null {
  const bindings = widget.bindings;
  if (!bindings) {
    return null;
  }
  const first = Object.values(bindings)[0];
  return first ?? null;
}

/**
 * Cache key mixing the workspace version with the data-refresh counter: a doc
 * change OR a poll tick both invalidate resolved bindings. Overflow-safe: only
 * equality is compared.
 */
function bindingCacheKey(workspace: WorkspaceDocument, viewState: WorkspaceViewState): number {
  return workspace.workspaceVersion * 1_000_003 + viewState.dataVersion;
}

/** Kick off binding resolution for widgets on the active tab; cache per version. */
function ensureBindings(
  viewState: WorkspaceViewState,
  client: GatewayBrowserClient | null,
  workspace: WorkspaceDocument,
  tab: WorkspaceTab,
  requestUpdate: (() => void) | null,
): void {
  const key = bindingCacheKey(workspace, viewState);
  if (viewState.bindingVersion !== key) {
    viewState.bindingResults.clear();
    viewState.bindingLoads.clear();
    viewState.bindingVersion = key;
  }
  for (const widget of tab.widgets) {
    const binding = primaryBinding(widget);
    if (
      !binding ||
      viewState.bindingResults.has(widget.id) ||
      viewState.bindingLoads.has(widget.id)
    ) {
      continue;
    }
    viewState.bindingLoads.add(widget.id);
    void resolveBinding(client, binding).then((result) => {
      if (viewState.bindingVersion !== key) {
        return;
      }
      viewState.bindingResults.set(widget.id, result);
      viewState.bindingLoads.delete(widget.id);
      requestUpdate?.();
    });
  }
}

function gridMetrics(host: object): { width: number } {
  const grid =
    host instanceof HTMLElement ? host.querySelector<HTMLElement>(".workspace-grid") : null;
  return { width: grid?.clientWidth ?? 0 };
}

/**
 * Close the hidden-tabs overflow `<details>` on Escape (#3). Native details close
 * on summary click but not on Escape, so wire it explicitly.
 */
function onHiddenTabsKeydown(event: KeyboardEvent): void {
  if (event.key !== "Escape") {
    return;
  }
  const details = (event.currentTarget as HTMLElement).closest("details");
  if (details?.open) {
    event.preventDefault();
    details.open = false;
    (details.querySelector("summary") as HTMLElement | null)?.focus();
  }
}

/**
 * When the hidden-tabs overflow opens, arm a one-shot document pointerdown that
 * closes it on an outside click (#3); native details never dismiss on outside
 * click. Self-removing on close so no listener leaks.
 */
function onHiddenTabsToggle(event: Event): void {
  const details = event.currentTarget as HTMLDetailsElement;
  if (!details.open) {
    return;
  }
  const onOutside = (pointerEvent: PointerEvent) => {
    if (pointerEvent.target instanceof Node && details.contains(pointerEvent.target)) {
      return;
    }
    details.open = false;
    document.removeEventListener("pointerdown", onOutside, true);
  };
  const onClosed = () => {
    if (!details.open) {
      document.removeEventListener("pointerdown", onOutside, true);
      details.removeEventListener("toggle", onClosed);
    }
  };
  document.addEventListener("pointerdown", onOutside, true);
  details.addEventListener("toggle", onClosed);
}

/**
 * First-visit onboarding banner (#5) teaching the two ways to add a tab: ask the
 * agent (primary) or the CLI command (secondary). Dismissible; the flag persists
 * in localStorage. The zero-tabs onboarding card is kept separately.
 */
function renderOnboardingBanner(
  viewState: WorkspaceViewState,
  requestUpdate: () => void,
): TemplateResult | typeof nothing {
  if (viewState.onboardingDismissed) {
    return nothing;
  }
  const dismiss = () => {
    viewState.onboardingDismissed = true;
    persistOnboardingDismissed();
    requestUpdate();
  };
  return html`
    <div class="workspace-onboarding" role="note" data-test-id="workspace-onboarding">
      <span class="workspace-onboarding__icon" aria-hidden="true">${icons.spark}</span>
      <div class="workspace-onboarding__body">
        <div class="workspace-onboarding__title">${t("workspaces.onboarding.title")}</div>
        <div class="workspace-onboarding__sub">${t("workspaces.onboarding.primary")}</div>
        <div class="workspace-onboarding__sub">
          ${t("workspaces.onboarding.secondary")}
          <code class="workspace-onboarding__cmd">${t("workspaces.empty.onboardingCommand")}</code>
        </div>
      </div>
      <button
        class="workspace-onboarding__dismiss"
        type="button"
        data-test-id="workspace-onboarding-dismiss"
        aria-label=${t("common.dismiss")}
        @click=${dismiss}
      >
        ${icons.x}
      </button>
    </div>
  `;
}

function renderTabStrip(state: WorkspaceUiState, workspace: WorkspaceDocument): TemplateResult {
  const tabs = visibleTabs(workspace);
  const hidden = hiddenTabs(workspace);
  return html`
    <nav class="workspace-tabs" role="tablist" aria-label=${t("workspaces.tabs.label")}>
      ${tabs.map((tab) => {
        const active = tab.slug === state.activeSlug;
        return html`
          <button
            class="workspace-tab ${active ? "workspace-tab--active" : ""}"
            type="button"
            role="tab"
            aria-selected=${active ? "true" : "false"}
            data-test-id="workspace-tab"
            data-ws=${tab.slug}
            @click=${() => navigateToWorkspaceTab(tab.slug)}
          >
            ${tab.icon && Object.hasOwn(icons, tab.icon)
              ? html`<span class="workspace-tab__icon" aria-hidden="true"
                  >${icons[tab.icon as keyof typeof icons]}</span
                >`
              : nothing}
            <span class="workspace-tab__label">${tab.title}</span>
          </button>
        `;
      })}
      ${hidden.length > 0
        ? html`
            <details
              class="workspace-tabs__hidden"
              @toggle=${onHiddenTabsToggle}
              @keydown=${onHiddenTabsKeydown}
            >
              <summary class="workspace-tab workspace-tab--overflow">
                <span class="workspace-tab__icon" aria-hidden="true">${icons.eyeOff}</span>
                <span class="workspace-tab__label"
                  >${t("workspaces.tabs.hidden", { count: String(hidden.length) })}</span
                >
              </summary>
              <div class="workspace-tabs__hidden-menu" role="menu">
                ${hidden.map(
                  (tab) => html`
                    <button
                      class="workspace-tabs__hidden-item"
                      type="button"
                      role="menuitem"
                      @click=${() => navigateToWorkspaceTab(tab.slug)}
                    >
                      ${tab.title}
                    </button>
                  `,
                )}
              </div>
            </details>
          `
        : nothing}
    </nav>
  `;
}

/**
 * Load `widget.json` manifests for the APPROVED custom widgets on the active tab.
 * Only approved widgets ever build an iframe, so only they need a manifest; a
 * pending/rejected widget never fetches one. Workspace changes, reconnects, and
 * approaching server expiry clear the cache: capabilities are approval-scoped
 * and process-local, so they must never outlive either boundary.
 */
function ensureManifests(
  viewState: WorkspaceViewState,
  props: WorkspaceProps,
  workspace: WorkspaceDocument,
  tab: WorkspaceTab,
): void {
  if (!props.connected || !props.client) {
    return;
  }
  if (viewState.manifestVersion !== workspace.workspaceVersion) {
    viewState.manifestCache.clear();
    viewState.manifestLoads.clear();
    viewState.manifestVersion = workspace.workspaceVersion;
  }
  const manifestVersion = viewState.manifestVersion;
  const manifestEpoch = viewState.manifestEpoch;
  for (const widget of tab.widgets) {
    const name = customWidgetName(widget.kind);
    const cached = name ? viewState.manifestCache.get(name) : undefined;
    if (name && cached?.frameExpiresAt && cached.frameExpiresAt <= Date.now() + 60_000) {
      viewState.manifestCache.delete(name);
    }
    if (
      !name ||
      customWidgetStatus(workspace, widget.kind) !== "approved" ||
      viewState.manifestCache.has(name) ||
      viewState.manifestLoads.has(name)
    ) {
      continue;
    }
    viewState.manifestLoads.add(name);
    void loadWidgetManifestView(props.client, name).then((manifest) => {
      // A fetch started for an older approval must not repopulate the cache after
      // a workspace update invalidated it.
      if (
        viewState.manifestVersion !== manifestVersion ||
        viewState.manifestEpoch !== manifestEpoch
      ) {
        return;
      }
      viewState.manifestLoads.delete(name);
      if (manifest) {
        viewState.manifestCache.set(name, manifest);
        props.onRequestUpdate?.();
      }
    });
  }
}

/** Builds the L5 custom-widget context for one `custom:<name>` widget, or null. */
function buildCustomContext(
  props: WorkspaceProps,
  state: WorkspaceUiState,
  viewState: WorkspaceViewState,
  workspace: WorkspaceDocument,
  widget: WorkspaceWidget,
): WorkspaceCustomWidgetContext | null {
  const name = customWidgetName(widget.kind);
  if (!name) {
    return null;
  }
  const host: CustomWidgetHostContext = {
    client: props.client,
    basePath: props.basePath ?? "",
    sessionKey: props.sessionKey ?? "main",
  };
  const createdBy = workspace.widgetsRegistry[name]?.createdBy;
  return {
    status: customWidgetStatus(workspace, widget.kind),
    ...(createdBy ? { createdBy } : {}),
    manifest: viewState.manifestCache.get(name) ?? null,
    host,
    onApprove: () => void approveWidget(state, props.client, { name, decision: "approved" }),
    onReject: () => void approveWidget(state, props.client, { name, decision: "rejected" }),
  };
}

function renderGrid(
  props: WorkspaceProps,
  state: WorkspaceUiState,
  viewState: WorkspaceViewState,
  workspace: WorkspaceDocument,
  tab: WorkspaceTab,
): TemplateResult {
  ensureBindings(viewState, props.client, workspace, tab, props.onRequestUpdate ?? null);
  ensureManifests(viewState, props, workspace, tab);
  if (tab.widgets.length === 0) {
    // #15: dashed placeholder card with an icon so an empty tab reads as an
    // intentional drop zone.
    return html`
      <div class="workspace-empty workspace-empty--tab" data-test-id="workspace-empty-tab">
        <span class="workspace-empty__icon" aria-hidden="true">${icons.plus}</span>
        <div class="workspace-empty__title">${t("workspaces.empty.tabTitle")}</div>
        <div class="workspace-empty__sub">${t("workspaces.empty.tabSubtitle")}</div>
      </div>
    `;
  }
  const callbacks = makeCallbacks(props, state, viewState, tab);
  const builtinContext: BuiltinWidgetContext = {
    basePath: props.basePath ?? "",
    embed: props.embed ?? DEFAULT_EMBED_CONTEXT,
  };
  const rows = gridRowCount(tab.widgets);
  const minHeight = rows * WORKSPACE_ROW_HEIGHT + Math.max(0, rows - 1) * WORKSPACE_GRID_GAP;
  return html`
    <div class="workspace-grid" style="min-height: ${minHeight}px" data-test-id="workspace-grid">
      ${tab.widgets.map((widget) => {
        const custom = buildCustomContext(props, state, viewState, workspace, widget);
        return renderWidgetCell({
          widget,
          binding: viewState.bindingResults.get(widget.id) ?? null,
          menuOpen: viewState.openMenuWidgetId === widget.id,
          pending: state.pendingWidgetIds.has(widget.id),
          dragging: viewState.drag?.widgetId === widget.id,
          builtinContext,
          callbacks,
          ...(custom ? { custom } : {}),
        });
      })}
      ${renderDragGhost(viewState, tab)}
    </div>
  `;
}

/**
 * Snapped drop-target ghost for the active move/resize drag (#4). Placed in the
 * same grid slot the drop would land in so the target is obvious. An overlapping
 * (reject-bound) target reads distinctly via `--invalid`.
 */
function renderDragGhost(
  viewState: WorkspaceViewState,
  tab: WorkspaceTab,
): TemplateResult | typeof nothing {
  const drag = viewState.drag;
  if (!drag) {
    return nothing;
  }
  const invalid = collides(drag.ghostRect, tab.widgets, drag.widgetId);
  return html`
    <div
      class="workspace-ghost ${invalid ? "workspace-ghost--invalid" : ""}"
      style=${gridPlacementStyle(drag.ghostRect)}
      aria-hidden="true"
      data-test-id="workspace-drag-ghost"
    ></div>
  `;
}

function makeCallbacks(
  props: WorkspaceProps,
  state: WorkspaceUiState,
  viewState: WorkspaceViewState,
  tab: WorkspaceTab,
): WorkspaceWidgetCellCallbacks {
  const requestUpdate = () => props.onRequestUpdate?.();
  const commitDrag = (widget: WorkspaceWidget, event: PointerEvent, mode: "move" | "resize") => {
    const metrics = gridMetrics(props.host);
    if (metrics.width <= 0) {
      return;
    }
    const drag = beginDrag({
      widget,
      mode,
      clientX: event.clientX,
      clientY: event.clientY,
      metrics,
    });
    viewState.drag = drag;
    const target = event.target as Element;
    if (target.setPointerCapture) {
      target.setPointerCapture(event.pointerId);
    }
    // Once cancelled (tab-switch/disconnect via stopWorkspace), the window
    // listeners are removed and any late pointerup becomes a no-op so it cannot
    // fire moveWidget against a stale tab/client.
    let settled = false;
    const teardown = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    const cancel = () => {
      if (settled) {
        return;
      }
      settled = true;
      teardown();
      viewState.drag = null;
      requestUpdate();
    };
    const onMove = (moveEvent: PointerEvent) => {
      updateDrag(drag, moveEvent.clientX, moveEvent.clientY);
      requestUpdate();
    };
    const onUp = () => {
      if (settled) {
        return;
      }
      settled = true;
      teardown();
      clearActiveDrag(props.host);
      const resolved = resolveDrop({
        requested: drag.ghostRect,
        widgets: tab.widgets,
        widgetId: widget.id,
      });
      viewState.drag = null;
      requestUpdate();
      if (
        resolved &&
        (resolved.x !== widget.grid.x ||
          resolved.y !== widget.grid.y ||
          resolved.w !== widget.grid.w ||
          resolved.h !== widget.grid.h)
      ) {
        void moveWidget(state, props.client, {
          slug: tab.slug,
          widgetId: widget.id,
          grid: resolved,
        });
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    registerActiveDrag(props.host, cancel);
  };
  return {
    onToggleCollapse: (widget) =>
      void setWidgetCollapsed(state, props.client, {
        slug: tab.slug,
        widgetId: widget.id,
        collapsed: !widget.collapsed,
      }),
    onToggleMenu: (widget) => {
      viewState.openMenuWidgetId = viewState.openMenuWidgetId === widget.id ? null : widget.id;
      requestUpdate();
    },
    onHide: (widget) => {
      viewState.openMenuWidgetId = null;
      // Hiding removes the widget from view and persists the hidden flag; distinct
      // from remove, which deletes it from the document.
      void hideWidget(state, props.client, { slug: tab.slug, widgetId: widget.id });
    },
    onRemove: (widget) => {
      viewState.openMenuWidgetId = null;
      void removeWidgetFromTab(state, props.client, { slug: tab.slug, widgetId: widget.id });
    },
    onEditTitle: (widget) => {
      viewState.openMenuWidgetId = null;
      // #12: open the themed edit-title dialog instead of window.prompt().
      viewState.dialog = {
        kind: "editTitle",
        slug: tab.slug,
        widgetId: widget.id,
        title: widget.title,
      };
      requestUpdate();
    },
    onMoveToTab: (widget) => {
      viewState.openMenuWidgetId = null;
      // #12: open the themed move-to-tab dialog (a select of existing tabs, not a
      // free-text slug entry).
      viewState.dialog = { kind: "moveToTab", slug: tab.slug, widgetId: widget.id };
      requestUpdate();
    },
    onMovePointerDown: (widget, event) => {
      if (event.button !== 0) {
        return;
      }
      event.preventDefault();
      commitDrag(widget, event, "move");
    },
    onResizePointerDown: (widget, event) => {
      if (event.button !== 0) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      commitDrag(widget, event, "resize");
    },
    onKeyboardNudge: (widget, mode, direction) => {
      const next = nudgeRect(widget.grid, mode, direction);
      const resolved = resolveDrop({ requested: next, widgets: tab.widgets, widgetId: widget.id });
      if (resolved) {
        void moveWidget(state, props.client, {
          slug: tab.slug,
          widgetId: widget.id,
          grid: resolved,
        });
      }
    },
  };
}

/**
 * Themed edit-title / move-to-tab dialog (#12), replacing window.prompt(). Reuses
 * the app's openclaw-modal-dialog (Escape/backdrop cancel, focus trap) and the
 * exec-approval card idiom. Move-to-tab offers a select of existing tabs.
 */
function renderDialog(
  props: WorkspaceProps,
  state: WorkspaceUiState,
  viewState: WorkspaceViewState,
): TemplateResult | typeof nothing {
  const dialog = viewState.dialog;
  if (!dialog) {
    return nothing;
  }
  const requestUpdate = () => props.onRequestUpdate?.();
  const close = () => {
    viewState.dialog = null;
    requestUpdate();
  };

  if (dialog.kind === "editTitle") {
    const title = t("workspaces.widget.editTitleTitle");
    const submit = (event: Event) => {
      event.preventDefault();
      const input = (event.currentTarget as HTMLElement).querySelector<HTMLInputElement>(
        "input[name='workspace-widget-title']",
      );
      const next = input?.value.trim() ?? "";
      if (next && next !== dialog.title) {
        void updateWidgetTitle(state, props.client, {
          slug: dialog.slug,
          widgetId: dialog.widgetId,
          title: next,
        });
      }
      close();
    };
    return html`
      <openclaw-modal-dialog label=${title} @modal-cancel=${close}>
        <form class="exec-approval-card" @submit=${submit}>
          <div class="exec-approval-header">
            <div class="exec-approval-title">${title}</div>
          </div>
          <input
            class="workspace-dialog__input"
            type="text"
            name="workspace-widget-title"
            data-test-id="workspace-edit-title-input"
            .value=${dialog.title}
            aria-label=${t("workspaces.widget.editTitleLabel")}
            style="margin-top: 12px; width: 100%;"
          />
          <div class="exec-approval-actions">
            <button class="btn btn--primary" type="submit">${t("common.save")}</button>
            <button class="btn" type="button" @click=${close}>${t("common.cancel")}</button>
          </div>
        </form>
      </openclaw-modal-dialog>
    `;
  }

  const title = t("workspaces.widget.moveToTabTitle");
  const targets = state.workspace
    ? orderedTabs(state.workspace).filter((candidate) => candidate.slug !== dialog.slug)
    : [];
  const submit = (event: Event) => {
    event.preventDefault();
    const select = (event.currentTarget as HTMLElement).querySelector<HTMLSelectElement>(
      "select[name='workspace-move-target']",
    );
    const toSlug = select?.value ?? "";
    if (toSlug && toSlug !== dialog.slug) {
      void moveWidgetToTab(state, props.client, {
        fromSlug: dialog.slug,
        toSlug,
        widgetId: dialog.widgetId,
      });
    }
    close();
  };
  return html`
    <openclaw-modal-dialog label=${title} @modal-cancel=${close}>
      <form class="exec-approval-card" @submit=${submit}>
        <div class="exec-approval-header">
          <div class="exec-approval-title">${title}</div>
        </div>
        ${targets.length === 0
          ? html`<div class="exec-approval-sub" style="margin-top: 12px;">
              ${t("workspaces.widget.moveToTabEmpty")}
            </div>`
          : html`<select
              class="workspace-dialog__input"
              name="workspace-move-target"
              data-test-id="workspace-move-target"
              aria-label=${title}
              style="margin-top: 12px; width: 100%;"
            >
              ${targets.map(
                (candidate) => html`<option value=${candidate.slug}>${candidate.title}</option>`,
              )}
            </select>`}
        <div class="exec-approval-actions">
          <button class="btn btn--primary" type="submit" ?disabled=${targets.length === 0}>
            ${t("workspaces.widget.menu.moveToTab")}
          </button>
          <button class="btn" type="button" @click=${close}>${t("common.cancel")}</button>
        </div>
      </form>
    </openclaw-modal-dialog>
  `;
}

export function renderWorkspace(props: WorkspaceProps): TemplateResult {
  const state = getWorkspaceState(props.host);
  const viewState = getViewState(props.host);
  state.requestUpdate = props.onRequestUpdate ?? null;
  // Keep the outside-click / Escape dismiss listeners in sync with the open kebab
  // menu (#3). Cheap no-op when the open state is unchanged.
  syncMenuDismiss(props.host, viewState, () => props.onRequestUpdate?.());

  const requestedSlug = requestedWorkspaceSlug(window.location.search);
  const active = props.connected;
  // Gateway restart revokes every in-memory frame capability without changing
  // workspaceVersion. A disconnect/reconnect therefore starts a new cache epoch.
  if (viewState.manifestConnected !== active) {
    viewState.manifestConnected = active;
    viewState.manifestEpoch += 1;
    viewState.manifestCache.clear();
    viewState.manifestLoads.clear();
    viewState.manifestVersion = -1;
  }
  subscribeToWorkspaceEvents(props.host, state, active ? props.client : null);
  // Per-widget data refresh: a visibility-gated timer bumps the data version so
  // the next render re-resolves data-widget bindings. stopWorkspace clears it on
  // tab-leave/disconnect (logbook's stop discipline — no orphan timers).
  startBindingPolling(props.host, active ? props.client : null, () => {
    bumpWorkspaceDataVersion(props.host);
    props.onRequestUpdate?.();
  });
  if (active && !state.loaded && !state.loading && !state.error) {
    void loadWorkspace(state, props.client, { requestedSlug });
  }

  // Deep-link: a changed `?ws=` re-points the active tab without a refetch.
  if (state.workspace && requestedSlug && requestedSlug !== state.activeSlug) {
    state.activeSlug = resolveActiveSlug(state.workspace, requestedSlug);
  }

  return html`
    <section class="workspace" data-test-id="workspace">
      ${state.actionError
        ? html`<div class="callout danger workspace__toast" role="alert">${state.actionError}</div>`
        : nothing}
      ${renderBody(props, state, viewState)} ${renderDialog(props, state, viewState)}
    </section>
  `;
}

function renderBody(
  props: WorkspaceProps,
  state: WorkspaceUiState,
  viewState: WorkspaceViewState,
): TemplateResult {
  if (state.error) {
    return html`
      <div class="card lazy-view-state" role="alert">
        <div class="card-title">${t("workspaces.error.title")}</div>
        <div class="card-sub">${t("workspaces.error.subtitle")}</div>
        <details class="workspace-error-detail">
          <summary>${t("workspaces.error.detailSummary")}</summary>
          <div class="workspace-error-detail__text">${state.error}</div>
        </details>
        <button
          class="btn btn--small"
          type="button"
          @click=${() => void loadWorkspace(state, props.client)}
        >
          ${t("common.reload")}
        </button>
      </div>
    `;
  }
  const workspace = state.workspace;
  if (!workspace) {
    // #19: skeleton cards instead of a bare "Loading…" line.
    return html`
      <div class="workspace-skeleton" role="status" aria-label=${t("common.loading")}>
        ${[0, 1, 2, 3, 4, 5].map(() => html`<div class="workspace-skeleton__card"></div>`)}
      </div>
    `;
  }
  if (workspace.tabs.length === 0) {
    return html`
      <div class="workspace-empty workspace-empty--onboarding" data-test-id="workspace-empty">
        <div class="workspace-empty__title">${t("workspaces.empty.onboardingTitle")}</div>
        <div class="workspace-empty__sub">${t("workspaces.empty.onboardingSubtitle")}</div>
        <code class="workspace-empty__cmd">${t("workspaces.empty.onboardingCommand")}</code>
      </div>
    `;
  }
  const tab = findTab(workspace, state.activeSlug) ?? visibleTabs(workspace)[0];
  if (!tab) {
    return html`<div class="card lazy-view-state" role="status">
      <div class="card-sub">${t("workspaces.empty.noVisibleTabs")}</div>
    </div>`;
  }
  return html`
    ${renderWorkspacesHeader(tab)}
    ${renderOnboardingBanner(viewState, () => props.onRequestUpdate?.())}
    ${renderTabStrip(state, workspace)} ${renderGrid(props, state, viewState, workspace, tab)}
  `;
}

/**
 * Page-header treatment for the Workspaces view (#7): the active workspace tab as
 * the title with a subtitle line, matching the app's .page-title / .page-sub
 * idiom used by the other top-level pages.
 */
function renderWorkspacesHeader(tab: WorkspaceTab): TemplateResult {
  return html`
    <div class="workspace-page-header" data-test-id="workspace-page-header">
      <div class="page-title">${tab.title}</div>
      <div class="page-sub">${t("workspaces.header.subtitle")}</div>
    </div>
  `;
}
