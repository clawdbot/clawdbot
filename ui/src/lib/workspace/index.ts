// Control UI controller for Workspaces: gateway state, live-update
// subscription, optimistic mutations with revert, and the minimal builtin binding
// resolver (spec-30 scope: stat-card + markdown; L4 extends the registry).
//
// Follows the workboard three-way split — this module owns all logic; the view is
// pure render fns and the page/controller is thin lifecycle glue.

import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { GatewayBrowserClient, GatewayEventFrame } from "../../api/gateway.ts";
import { buildSessionUsageDateParams } from "../sessions/usage.ts";
import { resolveActiveSlug } from "./tab-selection.ts";
export {
  customWidgetName,
  customWidgetStatus,
  findTab,
  hiddenTabs,
  orderedTabs,
  visibleTabs,
} from "./tab-selection.ts";
import {
  WORKSPACE_GRID_COLUMNS,
  workspaceAgentProvenance,
  type WorkspaceBinding,
  type WorkspaceChangedEvent,
  type WorkspaceGridRect,
  type WorkspaceTab,
  type WorkspaceWidget,
  type WorkspaceWidgetRegistryEntry,
  type WorkspaceWidgetStatus,
  type WorkspaceDocument,
} from "./types.ts";

const CHANGED_EVENT = "plugin.workspaces.changed";

export type WorkspaceUiState = {
  loading: boolean;
  loadGeneration: number;
  loadingGeneration: number | null;
  loaded: boolean;
  error: string | null;
  workspace: WorkspaceDocument | null;
  /** Slug of the workspace tab in view; null until the doc resolves a default. */
  activeSlug: string | null;
  /** Monotonic user/load selection revision used to reject stale navigation intent. */
  activeSlugRevision: number;
  /** Whether the hidden-tabs overflow menu is open. */
  hiddenMenuOpen: boolean;
  /** Widgets with an in-flight mutation, for optimistic-state affordances. */
  pendingWidgetIds: Set<string>;
  /** Transient error surfaced after a failed mutation (reverted state + toast). */
  actionError: string | null;
  requestUpdate: (() => void) | null;
};

type WorkspaceHost = object;

const workspaceStates = new WeakMap<WorkspaceHost, WorkspaceUiState>();
const workspaceEventUnsubscribers = new WeakMap<WorkspaceHost, () => void>();
const workspaceEventClients = new WeakMap<WorkspaceHost, GatewayBrowserClient>();
// Per-host data-refresh polling: a single interval per host that fires the view's
// tick (re-resolve data-widget bindings) only while the document is visible.
const workspacePollTimers = new WeakMap<WorkspaceHost, ReturnType<typeof setInterval>>();
const workspacePollActive = new WeakMap<WorkspaceHost, boolean>();
const workspaceMutationQueues = new WeakMap<WorkspaceUiState, Promise<void>>();
type WorkspaceLoadIntent = { slug: string; activeSlugRevision: number };
const workspaceLoadIntents = new WeakMap<WorkspaceUiState, WorkspaceLoadIntent>();

/** Default data-refresh interval (ms); the L4 spec's 30–60s window, floored at 10s. */
const WORKSPACE_POLL_INTERVAL_MS = 45_000;
// Per-host teardown for an in-flight hand-rolled drag: the view registers window
// pointermove/pointerup listeners while dragging, so a tab-switch/disconnect that
// calls stopWorkspace must cancel the drag (remove listeners, neutralize the
// pending pointerup) rather than leak closures over the now-stale view state.
const workspaceActiveDragCancel = new WeakMap<WorkspaceHost, () => void>();

/**
 * Register the teardown for an active drag on `host`. The view calls this when a
 * drag begins; `cancel` must remove its window listeners and make any later
 * pointerup a no-op. A previously registered drag is cancelled first so only one
 * drag is ever live per host.
 */
export function registerActiveDrag(host: WorkspaceHost, cancel: () => void): void {
  workspaceActiveDragCancel.get(host)?.();
  workspaceActiveDragCancel.set(host, cancel);
}

/** Clear the active-drag teardown for `host` once the drag settles normally. */
export function clearActiveDrag(host: WorkspaceHost): void {
  workspaceActiveDragCancel.delete(host);
}

/** Cancel any in-flight drag on `host` (used by stopWorkspace and re-registration). */
function cancelActiveDrag(host: WorkspaceHost): void {
  const cancel = workspaceActiveDragCancel.get(host);
  if (cancel) {
    workspaceActiveDragCancel.delete(host);
    cancel();
  }
}

export function getWorkspaceState(host: WorkspaceHost): WorkspaceUiState {
  let state = workspaceStates.get(host);
  if (!state) {
    state = {
      loading: false,
      loadGeneration: 0,
      loadingGeneration: null,
      loaded: false,
      error: null,
      workspace: null,
      activeSlug: null,
      activeSlugRevision: 0,
      hiddenMenuOpen: false,
      pendingWidgetIds: new Set(),
      actionError: null,
      requestUpdate: null,
    };
    workspaceStates.set(host, state);
  }
  return state;
}

function notify(state: WorkspaceUiState): void {
  state.requestUpdate?.();
}

function readString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function readNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function normalizeRect(value: unknown): WorkspaceGridRect {
  const record = isRecord(value) ? value : {};
  const w = Math.min(WORKSPACE_GRID_COLUMNS, Math.max(1, Math.trunc(readNumber(record.w, 4))));
  const h = Math.max(1, Math.trunc(readNumber(record.h, 2)));
  const x = Math.min(WORKSPACE_GRID_COLUMNS - w, Math.max(0, Math.trunc(readNumber(record.x, 0))));
  const y = Math.max(0, Math.trunc(readNumber(record.y, 0)));
  return { x, y, w, h };
}

function normalizeBinding(value: unknown): WorkspaceBinding | null {
  if (!isRecord(value)) {
    return null;
  }
  const source = value.source;
  if (source !== "rpc" && source !== "file" && source !== "static") {
    return null;
  }
  return {
    source,
    ...(typeof value.method === "string" ? { method: value.method } : {}),
    ...(typeof value.path === "string" ? { path: value.path } : {}),
    ...(typeof value.pointer === "string" ? { pointer: value.pointer } : {}),
    ...(isRecord(value.params) ? { params: value.params } : {}),
    ...("value" in value ? { value: value.value } : {}),
  };
}

function normalizeBindings(value: unknown): Record<string, WorkspaceBinding> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const bindings: Record<string, WorkspaceBinding> = {};
  for (const [key, raw] of Object.entries(value)) {
    const binding = normalizeBinding(raw);
    if (binding) {
      bindings[key] = binding;
    }
  }
  return Object.keys(bindings).length ? bindings : undefined;
}

function normalizeWidget(value: unknown): WorkspaceWidget | null {
  if (!isRecord(value)) {
    return null;
  }
  const id = readString(value.id).trim();
  const kind = readString(value.kind).trim();
  if (!id || !kind) {
    return null;
  }
  return {
    id,
    kind,
    title: readString(value.title),
    grid: normalizeRect(value.grid),
    collapsed: value.collapsed === true,
    ...(typeof value.createdBy === "string" ? { createdBy: value.createdBy } : {}),
    ...(normalizeBindings(value.bindings) ? { bindings: normalizeBindings(value.bindings) } : {}),
    ...(isRecord(value.props) ? { props: value.props } : {}),
  };
}

function normalizeTab(value: unknown): WorkspaceTab | null {
  if (!isRecord(value)) {
    return null;
  }
  const slug = readString(value.slug).trim();
  if (!slug) {
    return null;
  }
  // A hidden widget never enters the UI read model, so the grid, the collision
  // math, and layout persistence all agree on one widget list without re-checking
  // the flag. The document still holds it: an agent, the CLI, or undo can bring it
  // back. The Control UI has no un-hide affordance by design.
  const widgets = Array.isArray(value.widgets)
    ? value.widgets
        .filter((raw) => !(isRecord(raw) && raw.hidden === true))
        .map(normalizeWidget)
        .filter((w): w is WorkspaceWidget => w !== null)
    : [];
  return {
    slug,
    title: readString(value.title, slug),
    hidden: value.hidden === true,
    widgets,
    ...(typeof value.icon === "string" ? { icon: value.icon } : {}),
    ...(typeof value.createdBy === "string" ? { createdBy: value.createdBy } : {}),
  };
}

const WIDGET_STATUSES = new Set<WorkspaceWidgetStatus>(["pending", "approved", "rejected"]);

function normalizeRegistryEntry(value: unknown): WorkspaceWidgetRegistryEntry | null {
  if (!isRecord(value)) {
    return null;
  }
  const status = value.status;
  if (typeof status !== "string" || !WIDGET_STATUSES.has(status as WorkspaceWidgetStatus)) {
    return null;
  }
  return {
    status: status as WorkspaceWidgetStatus,
    ...(typeof value.createdBy === "string" ? { createdBy: value.createdBy } : {}),
    ...(typeof value.approvedBy === "string" ? { approvedBy: value.approvedBy } : {}),
    ...(typeof value.approvedAt === "string" ? { approvedAt: value.approvedAt } : {}),
  };
}

function normalizeWidgetsRegistry(value: unknown): Record<string, WorkspaceWidgetRegistryEntry> {
  if (!isRecord(value)) {
    return {};
  }
  const registry: Record<string, WorkspaceWidgetRegistryEntry> = {};
  for (const [name, raw] of Object.entries(value)) {
    const entry = normalizeRegistryEntry(raw);
    if (entry) {
      registry[name] = entry;
    }
  }
  return registry;
}

function normalizeWorkspace(payload: unknown): WorkspaceDocument {
  const record = isRecord(payload) ? payload : {};
  const tabs = Array.isArray(record.tabs)
    ? record.tabs.map(normalizeTab).filter((tab): tab is WorkspaceTab => tab !== null)
    : [];
  const prefsRecord = isRecord(record.prefs) ? record.prefs : {};
  const tabOrder = Array.isArray(prefsRecord.tabOrder)
    ? prefsRecord.tabOrder.filter((slug): slug is string => typeof slug === "string")
    : [];
  return {
    schemaVersion: readNumber(record.schemaVersion, 1),
    workspaceVersion: readNumber(record.workspaceVersion, 0),
    tabs,
    prefs: { tabOrder },
    widgetsRegistry: normalizeWidgetsRegistry(record.widgetsRegistry),
  };
}

function applyActiveWorkspaceSlug(
  state: WorkspaceUiState,
  workspace: WorkspaceDocument,
  requestedSlug: string | null,
): void {
  state.activeSlug = resolveActiveSlug(workspace, requestedSlug);
  state.activeSlugRevision += 1;
}

/** Apply explicit navigation and invalidate navigation intent owned by older loads. */
export function setActiveWorkspaceSlug(
  state: WorkspaceUiState,
  workspace: WorkspaceDocument,
  requestedSlug: string | null,
): void {
  const intent = workspaceLoadIntents.get(state);
  if (intent?.slug === requestedSlug) {
    return;
  }
  if (requestedSlug === state.activeSlug) {
    if (intent) {
      workspaceLoadIntents.delete(state);
      state.activeSlugRevision += 1;
    }
    return;
  }
  workspaceLoadIntents.delete(state);
  applyActiveWorkspaceSlug(state, workspace, requestedSlug);
}

/** Cancel load-owned navigation while preserving the current tab selection. */
export function cancelWorkspaceLoadIntent(state: WorkspaceUiState): void {
  if (workspaceLoadIntents.delete(state)) {
    state.activeSlugRevision += 1;
  }
}

function formatError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim();
  }
  if (typeof error === "string" && error.trim()) {
    return error.trim();
  }
  return "Unknown workspace error.";
}

/** Load the workspace document; seeds `activeSlug` from the requested deep-link slug. */
export async function loadWorkspace(
  state: WorkspaceUiState,
  client: GatewayBrowserClient | null,
  opts?: { requestedSlug?: string | null; silent?: boolean },
): Promise<void> {
  if (!client) {
    return;
  }
  let intent: WorkspaceLoadIntent | undefined;
  if (opts?.requestedSlug != null) {
    intent = {
      slug: opts.requestedSlug,
      activeSlugRevision: state.activeSlugRevision,
    };
    workspaceLoadIntents.set(state, intent);
  } else if (opts?.silent) {
    intent = workspaceLoadIntents.get(state);
  } else if (!opts?.silent) {
    workspaceLoadIntents.delete(state);
  }
  // Carry navigation intent into a superseding silent refresh without exposing
  // an unvalidated slug as the active selection before a load succeeds.
  const generation = ++state.loadGeneration;
  if (!opts?.silent) {
    state.loadingGeneration = generation;
    state.loading = true;
    state.error = null;
    notify(state);
  }
  let staleDocumentApplied = false;
  try {
    const payload = await client.request("workspaces.get", {});
    const workspace = normalizeWorkspace(
      // workspaces.get responds { doc, workspaceVersion } — read `doc`
      // (a bare payload is tolerated for forward-compat).
      isRecord(payload) && "doc" in payload ? payload.doc : payload,
    );
    const currentVersion = state.workspace?.workspaceVersion;
    if (generation !== state.loadGeneration) {
      // Request generation owns navigation and status, but workspaceVersion owns
      // document freshness when handlers complete out of order.
      if (currentVersion === undefined || workspace.workspaceVersion > currentVersion) {
        const retainedIntent = workspaceLoadIntents.get(state);
        const retainedIntentIsCurrent =
          retainedIntent?.activeSlugRevision === state.activeSlugRevision;
        state.workspace = workspace;
        state.activeSlug = resolveActiveSlug(
          workspace,
          retainedIntentIsCurrent ? retainedIntent.slug : state.activeSlug,
        );
        if (retainedIntentIsCurrent && workspaceLoadIntents.get(state) === retainedIntent) {
          workspaceLoadIntents.delete(state);
          // Consuming the shared intent invalidates copies already captured by
          // newer in-flight loads, so they cannot revive removed navigation.
          state.activeSlugRevision += 1;
        }
        state.loaded = true;
        staleDocumentApplied = true;
      }
      return;
    }
    if (currentVersion !== undefined && workspace.workspaceVersion < currentVersion) {
      if (state.workspace && intent?.activeSlugRevision === state.activeSlugRevision) {
        applyActiveWorkspaceSlug(state, state.workspace, intent.slug);
      }
      if (workspaceLoadIntents.get(state) === intent) {
        workspaceLoadIntents.delete(state);
      }
      state.error = null;
      state.loaded = true;
      return;
    }
    const requestedSlug =
      intent && intent.activeSlugRevision === state.activeSlugRevision
        ? intent.slug
        : state.activeSlug;
    state.workspace = workspace;
    applyActiveWorkspaceSlug(state, workspace, requestedSlug);
    if (workspaceLoadIntents.get(state) === intent) {
      workspaceLoadIntents.delete(state);
    }
    state.error = null;
    state.loaded = true;
  } catch (err) {
    if (generation === state.loadGeneration) {
      // Retain intent for a later silent retry; explicit navigation or foreground
      // reload cancels it through the owner paths above.
      state.error = formatError(err);
    }
  } finally {
    const isCurrent = generation === state.loadGeneration;
    let shouldNotify = isCurrent || staleDocumentApplied;
    if (state.loadingGeneration === generation || (isCurrent && state.loadingGeneration !== null)) {
      // A current silent completion supersedes any older foreground owner; keep
      // no spinner tied to a response that can only finish stale.
      state.loadingGeneration = null;
      state.loading = false;
      shouldNotify = true;
    }
    if (shouldNotify) {
      notify(state);
    }
  }
}

/**
 * Subscribe to `plugin.workspaces.changed` and refetch on a newer version (skips
 * stale/own-echo events by comparing `workspaceVersion`). Push path per spec-30 —
 * the WS client surfaces event frames via `addEventListener`.
 */
export function subscribeToWorkspaceEvents(
  host: WorkspaceHost,
  state: WorkspaceUiState,
  client: GatewayBrowserClient | null,
): void {
  if (!client) {
    stopWorkspaceEvents(host);
    return;
  }
  if (workspaceEventClients.get(host) === client) {
    return;
  }
  stopWorkspaceEvents(host);
  const unsubscribe = client.addEventListener((evt: GatewayEventFrame) => {
    if (evt.event !== CHANGED_EVENT) {
      return;
    }
    const payload = isRecord(evt.payload) ? (evt.payload as WorkspaceChangedEvent) : undefined;
    const incomingVersion = readNumber(payload?.workspaceVersion, Number.NaN);
    const currentVersion = state.workspace?.workspaceVersion ?? -1;
    // Skip our own echo / stale replays: only a strictly newer version refetches.
    if (Number.isFinite(incomingVersion) && incomingVersion <= currentVersion) {
      return;
    }
    void loadWorkspace(state, client, { silent: true });
  });
  workspaceEventUnsubscribers.set(host, unsubscribe);
  workspaceEventClients.set(host, client);
}

function stopWorkspaceEvents(host: WorkspaceHost): void {
  workspaceEventUnsubscribers.get(host)?.();
  workspaceEventUnsubscribers.delete(host);
  workspaceEventClients.delete(host);
}

/**
 * Start (idempotently) the per-host data-refresh timer. The timer fires `onTick`
 * every `intervalMs`, but ONLY while the document is visible — a background tab
 * skips the tick so we don't hammer the gateway when nobody's watching. Passing a
 * null client stops any running timer (disconnect). A second call with a live
 * client is a no-op so re-renders don't stack timers.
 */
export function startBindingPolling(
  host: WorkspaceHost,
  client: GatewayBrowserClient | null,
  onTick: () => void,
  intervalMs: number = WORKSPACE_POLL_INTERVAL_MS,
): void {
  if (!client) {
    stopBindingPolling(host);
    return;
  }
  if (workspacePollActive.get(host)) {
    return;
  }
  const clamped = Math.max(10_000, intervalMs);
  const timer = setInterval(() => {
    // Visibility gate: only refresh when the tab is foreground. On a hidden tab
    // (or SSR/no-document env) we skip; the next visible render re-resolves.
    if (typeof document !== "undefined" && document.visibilityState === "hidden") {
      return;
    }
    onTick();
  }, clamped);
  workspacePollTimers.set(host, timer);
  workspacePollActive.set(host, true);
}

/** Stop the per-host data-refresh timer (tab-leave/disconnect). */
function stopBindingPolling(host: WorkspaceHost): void {
  const timer = workspacePollTimers.get(host);
  if (timer !== undefined) {
    clearInterval(timer);
    workspacePollTimers.delete(host);
  }
  workspacePollActive.delete(host);
}

/** Full lifecycle teardown for the bundled-view `stop` hook. */
export function stopWorkspace(host: WorkspaceHost): void {
  cancelActiveDrag(host);
  stopWorkspaceEvents(host);
  stopBindingPolling(host);
}

function replaceWidget(
  workspace: WorkspaceDocument,
  slug: string,
  widgetId: string,
  update: (widget: WorkspaceWidget) => WorkspaceWidget,
): WorkspaceDocument {
  return {
    ...workspace,
    tabs: workspace.tabs.map((tab) =>
      tab.slug !== slug
        ? tab
        : {
            ...tab,
            widgets: tab.widgets.map((widget) =>
              widget.id === widgetId ? update(widget) : widget,
            ),
          },
    ),
  };
}

function removeWidget(
  workspace: WorkspaceDocument,
  slug: string,
  widgetId: string,
): WorkspaceDocument {
  return {
    ...workspace,
    tabs: workspace.tabs.map((tab) =>
      tab.slug !== slug
        ? tab
        : { ...tab, widgets: tab.widgets.filter((widget) => widget.id !== widgetId) },
    ),
  };
}

/**
 * Run an optimistic mutation: apply `optimistic` locally, fire the RPC, and revert
 * to the pre-mutation snapshot on failure (surfacing `actionError` for a toast).
 * All shell mutations funnel through here so revert semantics stay consistent.
 */
async function optimisticMutation(
  state: WorkspaceUiState,
  client: GatewayBrowserClient | null,
  params: {
    widgetId: string;
    optimistic: (workspace: WorkspaceDocument) => WorkspaceDocument;
    method: string;
    rpcParams: Record<string, unknown>;
  },
): Promise<void> {
  const previous = workspaceMutationQueues.get(state) ?? Promise.resolve();
  const current = previous
    .catch(() => undefined)
    .then(async () => {
      await runOptimisticMutation(state, client, params);
    });
  workspaceMutationQueues.set(state, current);
  await current.finally(() => {
    if (workspaceMutationQueues.get(state) === current) {
      workspaceMutationQueues.delete(state);
    }
  });
}

async function runOptimisticMutation(
  state: WorkspaceUiState,
  client: GatewayBrowserClient | null,
  params: {
    widgetId: string;
    optimistic: (workspace: WorkspaceDocument) => WorkspaceDocument;
    method: string;
    rpcParams: Record<string, unknown>;
  },
): Promise<void> {
  if (!client || !state.workspace) {
    return;
  }
  const previous = state.workspace;
  const optimistic = params.optimistic(previous);
  state.workspace = optimistic;
  state.pendingWidgetIds.add(params.widgetId);
  state.actionError = null;
  notify(state);
  try {
    await client.request(params.method, params.rpcParams);
  } catch (err) {
    // Revert ONLY if we are still showing the exact optimistic doc we installed.
    // A concurrent loadWorkspace (e.g. a plugin.workspaces.changed refetch) may
    // have landed a FRESHER doc while the RPC was in flight; reverting to the
    // stale pre-mutation snapshot in that case would stomp the fresher state.
    if (state.workspace === optimistic) {
      state.workspace = previous;
    }
    state.actionError = formatError(err);
  } finally {
    state.pendingWidgetIds.delete(params.widgetId);
    notify(state);
  }
}

export function moveWidget(
  state: WorkspaceUiState,
  client: GatewayBrowserClient | null,
  params: { slug: string; widgetId: string; grid: WorkspaceGridRect },
): Promise<void> {
  return optimisticMutation(state, client, {
    widgetId: params.widgetId,
    method: "workspaces.widget.move",
    rpcParams: { tab: params.slug, id: params.widgetId, grid: params.grid },
    optimistic: (workspace) =>
      replaceWidget(workspace, params.slug, params.widgetId, (widget) => ({
        ...widget,
        grid: params.grid,
      })),
  });
}

export function setWidgetCollapsed(
  state: WorkspaceUiState,
  client: GatewayBrowserClient | null,
  params: { slug: string; widgetId: string; collapsed: boolean },
): Promise<void> {
  return optimisticMutation(state, client, {
    widgetId: params.widgetId,
    method: "workspaces.widget.update",
    rpcParams: { tab: params.slug, id: params.widgetId, patch: { collapsed: params.collapsed } },
    optimistic: (workspace) =>
      replaceWidget(workspace, params.slug, params.widgetId, (widget) => ({
        ...widget,
        collapsed: params.collapsed,
      })),
  });
}

export function updateWidgetTitle(
  state: WorkspaceUiState,
  client: GatewayBrowserClient | null,
  params: { slug: string; widgetId: string; title: string },
): Promise<void> {
  return optimisticMutation(state, client, {
    widgetId: params.widgetId,
    method: "workspaces.widget.update",
    rpcParams: { tab: params.slug, id: params.widgetId, patch: { title: params.title } },
    optimistic: (workspace) =>
      replaceWidget(workspace, params.slug, params.widgetId, (widget) => ({
        ...widget,
        title: params.title,
      })),
  });
}

export function hideWidget(
  state: WorkspaceUiState,
  client: GatewayBrowserClient | null,
  params: { slug: string; widgetId: string },
): Promise<void> {
  return optimisticMutation(state, client, {
    widgetId: params.widgetId,
    method: "workspaces.widget.update",
    rpcParams: { tab: params.slug, id: params.widgetId, patch: { hidden: true } },
    optimistic: (workspace) => removeWidget(workspace, params.slug, params.widgetId),
  });
}

export function removeWidgetFromTab(
  state: WorkspaceUiState,
  client: GatewayBrowserClient | null,
  params: { slug: string; widgetId: string },
): Promise<void> {
  return optimisticMutation(state, client, {
    widgetId: params.widgetId,
    method: "workspaces.widget.remove",
    rpcParams: { tab: params.slug, id: params.widgetId },
    optimistic: (workspace) => removeWidget(workspace, params.slug, params.widgetId),
  });
}

export function moveWidgetToTab(
  state: WorkspaceUiState,
  client: GatewayBrowserClient | null,
  params: { fromSlug: string; toSlug: string; widgetId: string },
): Promise<void> {
  return optimisticMutation(state, client, {
    widgetId: params.widgetId,
    method: "workspaces.widget.move",
    rpcParams: { tab: params.fromSlug, id: params.widgetId, toTab: params.toSlug },
    optimistic: (workspace) => {
      const source = workspace.tabs.find((tab) => tab.slug === params.fromSlug);
      const widget = source?.widgets.find((w) => w.id === params.widgetId);
      if (!widget) {
        return workspace;
      }
      return {
        ...workspace,
        tabs: workspace.tabs.map((tab) => {
          if (tab.slug === params.fromSlug) {
            return { ...tab, widgets: tab.widgets.filter((w) => w.id !== params.widgetId) };
          }
          if (tab.slug === params.toSlug) {
            return { ...tab, widgets: [...tab.widgets, widget] };
          }
          return tab;
        }),
      };
    },
  });
}

/**
 * Approve or reject a pending custom widget (operator-only) → `workspaces.widget.approve`
 * (WRITE). The registry is not part of the optimistic widget model, so this fires
 * the RPC and lets the resulting `plugin.workspaces.changed` broadcast refetch the
 * new status; a failure surfaces `actionError` for the toast.
 */
export async function approveWidget(
  state: WorkspaceUiState,
  client: GatewayBrowserClient | null,
  params: { name: string; decision: "approved" | "rejected" },
): Promise<void> {
  if (!client) {
    return;
  }
  state.actionError = null;
  notify(state);
  try {
    await client.request("workspaces.widget.approve", {
      name: params.name,
      decision: params.decision,
    });
  } catch (err) {
    state.actionError = formatError(err);
    notify(state);
  }
}

// --- Minimal builtin binding resolution (spec-30 scope; L4 extends) ----------

export type WorkspaceBindingResult = { value: unknown } | { error: string };

/**
 * Resolve a widget binding into a value the builtin renderers consume. Wire is:
 * - `static`: literal value from the binding.
 * - `rpc`: resolved CLIENT-SIDE on the page's own gateway client (00 §3 amendment).
 * - `file`: served by `workspaces.data.read`; the JSON pointer is applied here.
 *
 * `workspaces.data.read` serves file/static only and answers rpc bindings with
 * `{ code: "binding_client_resolved" }`, so rpc never routes through it.
 */
export async function resolveBinding(
  client: GatewayBrowserClient | null,
  binding: WorkspaceBinding,
): Promise<WorkspaceBindingResult> {
  try {
    if (binding.source === "static") {
      return { value: binding.value };
    }
    if (!client) {
      return { error: "Not connected." };
    }
    if (binding.source === "rpc") {
      if (!binding.method) {
        return { error: "Binding is missing an rpc method." };
      }
      const params =
        binding.method === "usage.cost" && binding.params?.mode === undefined
          ? { ...binding.params, ...buildSessionUsageDateParams("local") }
          : (binding.params ?? {});
      const value = await client.request(binding.method, params);
      return { value: applyPointer(value, binding.pointer) };
    }
    // file: `workspaces.data.read` accepts ONLY a `binding` param (its readParams
    // whitelist rejects anything else), and it resolves the file AND applies the
    // JSON pointer server-side, returning the final value under `data`. So we send
    // the whole binding and must NOT re-apply the pointer here (that would
    // double-resolve it).
    const payload = await client.request("workspaces.data.read", { binding });
    return { value: isRecord(payload) && "data" in payload ? payload.data : payload };
  } catch (err) {
    return { error: formatError(err) };
  }
}

/** Apply a JSON pointer (RFC 6901 subset) to a value; returns the value if empty. */
function applyPointer(value: unknown, pointer: string | undefined): unknown {
  if (!pointer) {
    return value;
  }
  const segments = pointer
    .split("/")
    .slice(1)
    .map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"));
  let current: unknown = value;
  for (const segment of segments) {
    if (Array.isArray(current)) {
      const index = Number(segment);
      current = Number.isInteger(index) ? current[index] : undefined;
    } else if (isRecord(current)) {
      current = current[segment];
    } else {
      return undefined;
    }
  }
  return current;
}

export { workspaceAgentProvenance };
