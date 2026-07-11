// Grid math + hand-rolled pointer drag/drop + resize for the Workspaces view.
//
// Pure functions only — no DOM, no gateway. The view wires pointer events to
// `beginDrag`/`updateDrag` and reads back a snapped ghost rect; on drop it asks
// `resolveDrop` for the final placement (rejecting overlaps, offering the nearest
// free slot per spec-30). Keeping the geometry here makes it unit-testable and
// keeps the view a thin renderer (workboard three-way split).

import { WORKSPACE_GRID_COLUMNS, type WorkspaceGridRect, type WorkspaceWidget } from "./types.ts";

/** Fixed row height + gutter, in CSS pixels (spec-30 §Grid). */
export const WORKSPACE_ROW_HEIGHT = 56;
export const WORKSPACE_GRID_GAP = 12;
/** Mirrors the store's grid bounds (`schema.ts` validateGrid). */
export const WORKSPACE_GRID_MAX_Y = 499;
export const WORKSPACE_GRID_MAX_HEIGHT = 20;

export type WorkspaceDragMode = "move" | "resize";

export type WorkspaceDragState = {
  widgetId: string;
  mode: WorkspaceDragMode;
  /** Grid rect at the moment the drag started. */
  originRect: WorkspaceGridRect;
  /** Pointer client coords at drag start. */
  originClientX: number;
  originClientY: number;
  /** Live snapped rect, updated as the pointer moves. */
  ghostRect: WorkspaceGridRect;
  /** Width of one grid column in pixels, captured from the grid element. */
  columnWidth: number;
};

export type WorkspaceGridMetrics = {
  /** Pixel width of the grid content box. */
  width: number;
};

/** Column width in pixels given the grid content width. Gaps sit between cells. */
export function columnWidth(metrics: WorkspaceGridMetrics): number {
  const totalGap = WORKSPACE_GRID_GAP * (WORKSPACE_GRID_COLUMNS - 1);
  return Math.max(1, (metrics.width - totalGap) / WORKSPACE_GRID_COLUMNS);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Snap a fractional column delta to whole grid units. */
export function snapCells(deltaPx: number, unitPx: number): number {
  if (unitPx <= 0) {
    return 0;
  }
  return Math.round(deltaPx / (unitPx + WORKSPACE_GRID_GAP));
}

/**
 * Clamp a rect into the grid the store will accept. The bounds mirror
 * `extensions/workspaces/src/schema.ts` exactly: a rect the UI lets you build but
 * the server rejects shows up as an optimistic move that snaps back.
 */
export function clampRect(rect: WorkspaceGridRect): WorkspaceGridRect {
  const w = clamp(rect.w, 1, WORKSPACE_GRID_COLUMNS);
  const h = clamp(rect.h, 1, WORKSPACE_GRID_MAX_HEIGHT);
  const x = clamp(rect.x, 0, WORKSPACE_GRID_COLUMNS - w);
  const y = clamp(rect.y, 0, WORKSPACE_GRID_MAX_Y);
  return { x, y, w, h };
}

export function rectsEqual(a: WorkspaceGridRect, b: WorkspaceGridRect): boolean {
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
}

/** Do two grid rects share any cell? Touching edges do NOT overlap. */
export function rectsOverlap(a: WorkspaceGridRect, b: WorkspaceGridRect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** Rects of every widget except the one identified by `exceptId`. */
function otherRects(widgets: readonly WorkspaceWidget[], exceptId: string): WorkspaceGridRect[] {
  return widgets.filter((widget) => widget.id !== exceptId).map((widget) => widget.grid);
}

/** Does `rect` overlap any widget other than `exceptId`? */
export function collides(
  rect: WorkspaceGridRect,
  widgets: readonly WorkspaceWidget[],
  exceptId: string,
): boolean {
  return otherRects(widgets, exceptId).some((other) => rectsOverlap(rect, other));
}

/** Begin a drag/resize gesture from a pointer-down on a widget's chrome. */
export function beginDrag(params: {
  widget: WorkspaceWidget;
  mode: WorkspaceDragMode;
  clientX: number;
  clientY: number;
  metrics: WorkspaceGridMetrics;
}): WorkspaceDragState {
  return {
    widgetId: params.widget.id,
    mode: params.mode,
    originRect: { ...params.widget.grid },
    originClientX: params.clientX,
    originClientY: params.clientY,
    ghostRect: { ...params.widget.grid },
    columnWidth: columnWidth(params.metrics),
  };
}

/** Advance a drag with the current pointer position; returns the snapped ghost rect. */
export function updateDrag(
  drag: WorkspaceDragState,
  clientX: number,
  clientY: number,
): WorkspaceGridRect {
  const rowUnit = WORKSPACE_ROW_HEIGHT;
  const deltaCols = snapCells(clientX - drag.originClientX, drag.columnWidth);
  const deltaRows = snapCells(clientY - drag.originClientY, rowUnit);
  const next =
    drag.mode === "move"
      ? {
          x: drag.originRect.x + deltaCols,
          y: drag.originRect.y + deltaRows,
          w: drag.originRect.w,
          h: drag.originRect.h,
        }
      : {
          x: drag.originRect.x,
          y: drag.originRect.y,
          w: drag.originRect.w + deltaCols,
          h: drag.originRect.h + deltaRows,
        };
  const clamped = clampRect(next);
  drag.ghostRect = clamped;
  return clamped;
}

/**
 * Resolve where a dropped widget lands. Overlapping drops are rejected (spec-30:
 * "reject drops that overlap, offer nearest free slot"); the nearest collision-free
 * slot to the requested position is returned instead. Returns null only if the
 * grid genuinely has no free slot for the widget's size (defensive; the grid is
 * unbounded downward so this is unreachable in practice).
 */
export function resolveDrop(params: {
  requested: WorkspaceGridRect;
  widgets: readonly WorkspaceWidget[];
  widgetId: string;
}): WorkspaceGridRect | null {
  const requested = clampRect(params.requested);
  if (!collides(requested, params.widgets, params.widgetId)) {
    return requested;
  }
  return nearestFreeSlot(requested, params.widgets, params.widgetId);
}

/**
 * Search outward from the requested position (increasing Manhattan-ish rings) for
 * the closest slot that fits `requested`'s size without colliding. The grid grows
 * downward, so a fit is always found within a bounded number of rows.
 */
export function nearestFreeSlot(
  requested: WorkspaceGridRect,
  widgets: readonly WorkspaceWidget[],
  widgetId: string,
): WorkspaceGridRect | null {
  const w = clamp(requested.w, 1, WORKSPACE_GRID_COLUMNS);
  const h = Math.max(1, requested.h);
  const maxX = WORKSPACE_GRID_COLUMNS - w;
  const occupiedRows = otherRects(widgets, widgetId).reduce(
    (max, rect) => Math.max(max, rect.y + rect.h),
    0,
  );
  // One extra band below everything usually guarantees a free row, but never search
  // past the last row the store accepts: a slot at y=500 would be "nearest" and then
  // rejected by schema validation, snapping the drop back.
  const maxY = Math.min(Math.max(requested.y, occupiedRows) + h, WORKSPACE_GRID_MAX_Y - h + 1);
  let best: { rect: WorkspaceGridRect; distance: number } | null = null;
  for (let y = 0; y <= maxY; y += 1) {
    // Past the requested row every further row is at least one unit farther away,
    // and the closest slot on it is directly below the requested column. Stop only
    // once even that ideal slot could not beat the best found — breaking on the
    // first row that merely HAS a fit would return a far same-row slot over a
    // near one a row down.
    if (best && y >= requested.y && y - requested.y >= best.distance) {
      break;
    }
    for (let x = 0; x <= maxX; x += 1) {
      const candidate: WorkspaceGridRect = { x, y, w, h };
      if (collides(candidate, widgets, widgetId)) {
        continue;
      }
      const distance = Math.abs(x - requested.x) + Math.abs(y - requested.y);
      if (!best || distance < best.distance) {
        best = { rect: candidate, distance };
      }
    }
  }
  return best?.rect ?? null;
}

/** CSS grid-column/grid-row shorthand for a rect (1-based grid lines). */
export function gridPlacementStyle(rect: WorkspaceGridRect): string {
  return [
    `grid-column: ${rect.x + 1} / span ${rect.w}`,
    `grid-row: ${rect.y + 1} / span ${rect.h}`,
  ].join("; ");
}

/** Total rows a set of widgets spans (for sizing the grid's min-height). */
export function gridRowCount(widgets: readonly WorkspaceWidget[]): number {
  return widgets.reduce((max, widget) => Math.max(max, widget.grid.y + widget.grid.h), 0);
}

export const KEYBOARD_MOVE_STEP = 1;

/** Nudge a rect by keyboard for the a11y move/resize fallback (spec-30). */
export function nudgeRect(
  rect: WorkspaceGridRect,
  mode: WorkspaceDragMode,
  direction: "left" | "right" | "up" | "down",
): WorkspaceGridRect {
  const step = KEYBOARD_MOVE_STEP;
  if (mode === "move") {
    const dx = direction === "left" ? -step : direction === "right" ? step : 0;
    const dy = direction === "up" ? -step : direction === "down" ? step : 0;
    return clampRect({ ...rect, x: rect.x + dx, y: rect.y + dy });
  }
  const dw = direction === "left" ? -step : direction === "right" ? step : 0;
  const dh = direction === "up" ? -step : direction === "down" ? step : 0;
  return clampRect({ ...rect, w: rect.w + dw, h: rect.h + dh });
}
