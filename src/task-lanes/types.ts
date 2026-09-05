/** Neutral task-lane contracts shared by providers, the gateway RPC, and the UI pane. */

export const TASK_LANE_SCHEMA_VERSION = 1;

/** Maximum file size the generic JSON provider will read (bytes). */
export const TASK_LANE_MAX_FILE_BYTES = 262144;
/** Maximum lanes a single provider snapshot may contain. */
export const TASK_LANE_MAX_LANES = 20;
/** Maximum items per lane. */
export const TASK_LANE_MAX_ITEMS_PER_LANE = 200;
/** Maximum rendered title length; longer titles are truncated by the provider. */
export const TASK_LANE_MAX_TITLE_CHARS = 200;
/** Maximum outcome summary length; longer text is truncated by the provider. */
export const TASK_LANE_MAX_OUTCOME_CHARS = 500;

export type TaskLaneItemState =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "canceled"
  | "unknown";

export type TaskLaneItem = {
  id: string;
  /** Set by snapshot assembly; provider-authored items omit it. */
  laneId?: string;
  title: string;
  state: TaskLaneItemState;
  /** Item start or enqueue time. */
  startedAtMs?: number;
  /** Last provider heartbeat, when liveness is tracked. */
  heartbeatAtMs?: number;
  /** Short producer-authored outcome summary. */
  outcome?: string;
  /**
   * http(s) URL. The generic JSON provider drops any other scheme, absolute
   * paths, traversal segments, and whitespace/control characters.
   */
  artifactUrl?: string;
};

export type TaskLane = {
  id: string;
  label: string;
  items: TaskLaneItem[];
  /** Set by snapshot assembly; provider-authored lanes omit it. */
  providerId?: string;
  /**
   * Total items the provider reported for this lane. Snapshot pages can leave
   * a lane with zero rendered items while its queue is non-empty, so clients
   * need the real total to tell emptiness from omission.
   */
  totalItems?: number;
  /** Items of this lane left outside the current snapshot page. */
  omittedItems?: number;
};

export type TaskLaneProviderDiagnostic =
  | {
      providerId: string;
      ok: true;
      laneCount: number;
      itemCount: number;
      /**
       * Lanes the provider's own count cap dropped before the registry saw
       * them. Zero/absent when the source input was within bounds; clients
       * surface this so a "Showing 20 of 25 lanes" notice is visible instead
       * of a silently-cropped lane set.
       */
      omittedLanes?: number;
      /**
       * Items the provider's per-lane count cap dropped before the registry
       * saw them. Aggregated across the provider's lanes; the registry
       * reports per-lane totals separately for paging. Clients surface this
       * as a truncation notice so a 200-item cap is not silently treated as
       * the full queue.
       */
      omittedItems?: number;
    }
  | { providerId: string; ok: false; error: string };

export type TaskLaneSnapshotPaging = {
  /** Flat-item offset the snapshot page starts at. */
  offset: number;
  /** Flat-item page size that was applied. */
  limit: number;
  /** Items across every lane before paging. */
  totalItems: number;
  /** Items included in this page. */
  returnedItems: number;
};

export type TaskLaneSnapshot = {
  lanes: TaskLane[];
  diagnostics: TaskLaneProviderDiagnostic[];
  /** Page coordinates so clients can detect and follow truncation. */
  paging: TaskLaneSnapshotPaging;
};

export type TaskLaneProvider = {
  id: string;
  label: string;
  /**
   * Loads the lane set; read ops wraps this call, so throwing is allowed.
   * Providers may report source-level omissions (lanes or items dropped by
   * their own count caps) so the registry can surface a truncation notice
   * instead of silently presenting a capped set as the full picture.
   */
  load: () => Promise<{
    lanes: TaskLane[];
    omittedLanes?: number;
    omittedItems?: number;
  }>;
};

/** Collapses any producer value into the six buyer-visible item states. */
export function normalizeTaskLaneItemState(state: unknown): TaskLaneItemState {
  return state === "pending" ||
    state === "running" ||
    state === "succeeded" ||
    state === "failed" ||
    state === "canceled"
    ? state
    : "unknown";
}

/** Truncates free text to a bounded length with an ellipsis marker. */
export function truncateTaskLaneText(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
}
