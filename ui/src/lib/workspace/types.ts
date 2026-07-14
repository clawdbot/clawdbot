// Control UI workspace types mirror the Workspaces plugin document schema.
//
// KEEP IN SYNC: the plugin store in `extensions/workspaces/` owns the canonical
// schema (00-vision-and-architecture §1). These are the UI-side read models the
// bundled Workspaces view renders from; only the fields the shell reads are
// modelled here, and every payload is normalized defensively on load because the
// gateway boundary is untyped.

export const WORKSPACE_GRID_COLUMNS = 12;

/** Provenance stamp: who authored a tab or widget. `agent:<id>` renders a chip. */
export type WorkspaceCreatedBy = string;

type WorkspaceWidgetKind = string;

type WorkspaceBindingSource = "rpc" | "file" | "static";

export type WorkspaceBinding = {
  source: WorkspaceBindingSource;
  /** `rpc` bindings name an allowlisted read method resolved client-side. */
  method?: string;
  /** `file` bindings name a path under the plugin's data dir. */
  path?: string;
  /** JSON pointer into the resolved document. */
  pointer?: string;
  params?: Record<string, unknown>;
  /** `static` bindings carry their value inline. */
  value?: unknown;
};

export type WorkspaceGridRect = {
  x: number;
  y: number;
  w: number;
  h: number;
};

export type WorkspaceWidget = {
  id: string;
  kind: WorkspaceWidgetKind;
  title: string;
  grid: WorkspaceGridRect;
  collapsed: boolean;
  createdBy?: WorkspaceCreatedBy;
  bindings?: Record<string, WorkspaceBinding>;
  props?: Record<string, unknown>;
};

export type WorkspaceTab = {
  slug: string;
  title: string;
  icon?: string;
  hidden: boolean;
  createdBy?: WorkspaceCreatedBy;
  widgets: WorkspaceWidget[];
};

type WorkspacePrefs = {
  tabOrder: string[];
};

/** Custom-widget registry status (00 §6). Only `approved` widgets get an iframe. */
export type WorkspaceWidgetStatus = "pending" | "approved" | "rejected";

/** UI read model of one `widgetsRegistry` entry (custom-widget approval state). */
export type WorkspaceWidgetRegistryEntry = {
  status: WorkspaceWidgetStatus;
  createdBy?: WorkspaceCreatedBy;
  approvedBy?: WorkspaceCreatedBy;
  approvedAt?: string;
};

export type WorkspaceDocument = {
  schemaVersion: number;
  workspaceVersion: number;
  tabs: WorkspaceTab[];
  prefs: WorkspacePrefs;
  /** Custom-widget install/approval state, keyed by widget name (`custom:<name>`). */
  widgetsRegistry: Record<string, WorkspaceWidgetRegistryEntry>;
};

/** Capability names a custom widget may hold (00 §2). */
export type WorkspaceWidgetCapability = "data:read" | "prompt:send";

/**
 * The subset of a custom widget's `widget.json` manifest the parent bridge needs
 * to gate child requests: the approved binding grants and capabilities. Loaded
 * on demand by the host through the authenticated plugin gateway.
 */
export type WidgetManifestView = {
  name: string;
  /** Server-minted capability used in every approved asset path and bridge bootstrap. */
  frameToken: string;
  /** Server expiry for the in-memory capability; the host refreshes before this time. */
  frameExpiresAt?: number;
  /** The file the sandboxed iframe loads; the manifest declares it. */
  entrypoint: string;
  bindings: Record<string, WorkspaceBinding>;
  capabilities: WorkspaceWidgetCapability[];
};

/** Payload of the `plugin.workspaces.changed` broadcast (01-conventions §Event naming). */
export type WorkspaceChangedEvent = {
  workspaceVersion: number;
  changedTabSlug?: string;
  actor?: string;
};

/** Provenance is an agent authorship when the stamp is prefixed `agent:`. */
export function workspaceAgentProvenance(createdBy: WorkspaceCreatedBy | undefined): string | null {
  if (typeof createdBy !== "string") {
    return null;
  }
  const trimmed = createdBy.trim();
  return trimmed.startsWith("agent:") ? trimmed.slice("agent:".length) || "agent" : null;
}
