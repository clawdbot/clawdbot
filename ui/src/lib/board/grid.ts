/** Pure order-and-size layout for the session dashboard board. */

export const BOARD_GRID_COLUMNS = 12;
export const BOARD_GRID_ROW_HEIGHT = 56;
export const BOARD_GRID_GAP = 12;
const BOARD_GRID_MAX_HEIGHT = 20;

export type BoardGridItem = {
  name: string;
  w: number;
  h: number;
  order: number;
};

export type BoardGridRect = {
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
};

type BoardGridCell = {
  x: number;
  y: number;
};

export type BoardGridDirection = "left" | "right" | "up" | "down";

type BoardGridPreview = {
  items: BoardGridItem[];
  rects: BoardGridRect[];
};

function clampInteger(value: number, minimum: number, maximum: number): number {
  const integer = Number.isFinite(value) ? Math.round(value) : minimum;
  return Math.min(maximum, Math.max(minimum, integer));
}

function withOrder(item: BoardGridItem, order: number): BoardGridItem {
  return { name: item.name, w: item.w, h: item.h, order };
}

function canonicalItems(items: readonly BoardGridItem[]): BoardGridItem[] {
  return items
    .map((item) => ({
      name: item.name,
      w: clampInteger(item.w, 1, BOARD_GRID_COLUMNS),
      h: clampInteger(item.h, 1, BOARD_GRID_MAX_HEIGHT),
      order: Number.isFinite(item.order) ? item.order : 0,
    }))
    .toSorted((left, right) => left.order - right.order || left.name.localeCompare(right.name))
    .map(withOrder);
}

function fits(occupied: readonly boolean[][], x: number, y: number, w: number, h: number): boolean {
  for (let row = y; row < y + h; row += 1) {
    for (let column = x; column < x + w; column += 1) {
      if (occupied[row]?.[column]) {
        return false;
      }
    }
  }
  return true;
}

function occupy(occupied: boolean[][], rect: BoardGridRect): void {
  for (let row = rect.y; row < rect.y + rect.h; row += 1) {
    const cells = occupied[row] ?? Array.from({ length: BOARD_GRID_COLUMNS }, () => false);
    occupied[row] = cells;
    for (let column = rect.x; column < rect.x + rect.w; column += 1) {
      cells[column] = true;
    }
  }
}

function firstFit(occupied: readonly boolean[][], item: BoardGridItem): BoardGridRect {
  for (let y = 0; ; y += 1) {
    for (let x = 0; x <= BOARD_GRID_COLUMNS - item.w; x += 1) {
      if (fits(occupied, x, y, item.w, item.h)) {
        return { name: item.name, x, y, w: item.w, h: item.h };
      }
    }
  }
}

/**
 * Places canonical-order items at the first available row-major cell. Earlier
 * items therefore keep priority while every later item is gravity-tight.
 */
export function layout(items: readonly BoardGridItem[]): BoardGridRect[] {
  const occupied: boolean[][] = [];
  const rects: BoardGridRect[] = [];
  for (const item of canonicalItems(items)) {
    const placed = firstFit(occupied, item);
    occupy(occupied, placed);
    rects.push(placed);
  }
  return rects;
}

function contains(rect: BoardGridRect, cell: BoardGridCell): boolean {
  return (
    cell.x >= rect.x && cell.x < rect.x + rect.w && cell.y >= rect.y && cell.y < rect.y + rect.h
  );
}

/**
 * Reorders one item around the target cell, then fully reflows the board.
 * Occupied targets insert before their occupant: that item and its followers
 * are pushed aside by the normal first-fit pass.
 */
export function previewDrag(
  items: readonly BoardGridItem[],
  name: string,
  targetCell: BoardGridCell,
): BoardGridPreview {
  const canonical = canonicalItems(items);
  const movingIndex = canonical.findIndex((item) => item.name === name);
  if (movingIndex < 0) {
    return { items: canonical, rects: layout(canonical) };
  }

  const currentRects = layout(canonical);
  const cell = {
    x: clampInteger(targetCell.x, 0, BOARD_GRID_COLUMNS - 1),
    y: Math.max(0, Number.isFinite(targetCell.y) ? Math.floor(targetCell.y) : 0),
  };
  const currentRect = currentRects.find((rect) => rect.name === name);
  if (currentRect && contains(currentRect, cell)) {
    return { items: canonical, rects: currentRects };
  }

  const [moving] = canonical.splice(movingIndex, 1);
  if (!moving) {
    return { items: canonical, rects: layout(canonical) };
  }
  const occupiedTarget = currentRects.find((rect) => rect.name !== name && contains(rect, cell));
  const nextRect =
    occupiedTarget ??
    currentRects
      .filter(
        (rect) =>
          rect.name !== name && (rect.y > cell.y || (rect.y === cell.y && rect.x >= cell.x)),
      )
      .toSorted((left, right) => left.y - right.y || left.x - right.x)[0];
  const insertionIndex = nextRect
    ? canonical.findIndex((item) => item.name === nextRect.name)
    : canonical.length;
  canonical.splice(Math.max(0, insertionIndex), 0, moving);
  const reordered = canonical.map(withOrder);
  return { items: reordered, rects: layout(reordered) };
}

/** Returns a new canonical item list with one clamped size change. */
export function resize(
  items: readonly BoardGridItem[],
  name: string,
  w: number,
  h: number,
): BoardGridItem[] {
  return canonicalItems(items).map((item) =>
    item.name === name
      ? {
          name: item.name,
          w: clampInteger(w, 1, BOARD_GRID_COLUMNS),
          h: clampInteger(h, 1, BOARD_GRID_MAX_HEIGHT),
          order: item.order,
        }
      : item,
  );
}

/** Arrow-key fallback: left/up move earlier; right/down move later. */
export function nudge(
  items: readonly BoardGridItem[],
  name: string,
  direction: BoardGridDirection,
): BoardGridItem[] {
  const canonical = canonicalItems(items);
  const index = canonical.findIndex((item) => item.name === name);
  if (index < 0) {
    return canonical;
  }
  const delta = direction === "left" || direction === "up" ? -1 : 1;
  const target = Math.min(canonical.length - 1, Math.max(0, index + delta));
  if (target !== index) {
    const [moving] = canonical.splice(index, 1);
    if (moving) {
      canonical.splice(target, 0, moving);
    }
  }
  return canonical.map(withOrder);
}

/** CSS grid lines are one-based; engine cells are zero-based. */
export function toCssPlacement(rect: BoardGridRect): string {
  return `grid-column: ${rect.x + 1} / span ${rect.w}; grid-row: ${rect.y + 1} / span ${rect.h};`;
}

// Keep this numeric inset aligned with the app-level --widget-frame-inset token.
const BOARD_WIDGET_FRAME_INSET = 12;
const BOARD_WIDGET_AUTO_MIN_ROWS = 2;
const BOARD_WIDGET_AUTO_MAX_ROWS = 20;
// Mirrors the 38px header grid row in board.css: coarse-pointer layouts keep
// the bar in flow, so auto height must reserve it or content clips by one bar.
const BOARD_WIDGET_TOUCH_BAR_PX = 38;

export const FINE_POINTER_QUERY = "(hover: hover) and (pointer: fine)";

export function boardChromeRowPx(): number {
  // jsdom lacks matchMedia; missing capability data defaults to the overlay
  // (fine-pointer) layout where the bar reserves no row space.
  return typeof window.matchMedia === "function" && !window.matchMedia(FINE_POINTER_QUERY).matches
    ? BOARD_WIDGET_TOUCH_BAR_PX
    : 0;
}

export function effectiveBoardWidgetRows(
  widget: BoardWidgetSizingInput,
  contentHeightPx: number | undefined,
  chromeRowPx = 0,
): number {
  // Absent heightMode means auto BY DESIGN, including widgets pinned before
  // the contract existed: retroactive content-fitting is the product goal, and
  // one menu click re-pins. Only an explicit "fixed" preserves stored height.
  if (
    widget.contentKind !== "html" ||
    widget.heightMode === "fixed" ||
    contentHeightPx === undefined ||
    !Number.isFinite(contentHeightPx) ||
    contentHeightPx <= 0
  ) {
    return widget.sizeH;
  }
  const requiredHeight =
    contentHeightPx +
    chromeRowPx +
    ((widget.presentation ?? "card") === "card" ? BOARD_WIDGET_FRAME_INSET * 2 : 0);
  const rows = Math.ceil(
    (requiredHeight + BOARD_GRID_GAP) / (BOARD_GRID_ROW_HEIGHT + BOARD_GRID_GAP),
  );
  return Math.min(BOARD_WIDGET_AUTO_MAX_ROWS, Math.max(BOARD_WIDGET_AUTO_MIN_ROWS, rows));
}

/** Structural sizing inputs so pure grid math stays free of view-type imports. */
type BoardWidgetSizingInput = {
  contentKind: string;
  heightMode?: "auto" | "fixed";
  presentation?: "card" | "full-bleed" | "frameless";
  sizeH: number;
};
