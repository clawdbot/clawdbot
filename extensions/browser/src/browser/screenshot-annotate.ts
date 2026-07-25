// extensions/browser/src/browser/screenshot-annotate.ts
//
// Pure helper module for screenshot label annotations.
// Has no Playwright / CDP / page dependency: takes document-space inputs,
// returns coordinate-projected annotations + IIFE strings the caller can
// hand to page.evaluate / Runtime.evaluate.
//
// Used by:
//   - pw-tools-core.interactions.ts (Playwright path, M1.2-a)
//   - planned: raw-CDP path in M1.2-b
//
// chrome-mcp path keeps its own inline overlay (renderChromeMcpLabels) for now.

const ANNOTATION_OVERLAY_ATTR = "data-openclaw-labels";
const ANNOTATION_OVERLAY_ROOT_ID = "__openclaw-annotations__";
export const ANNOTATION_MAX_LABELS_DEFAULT = 150;

export type CoordinateSpace = "viewport" | "fullpage" | "element";

export interface RawAnnotationInput {
  ref: string;
  role: string;
  name?: string;
  /** Bounding box in document coordinates (viewport top-left + scroll). */
  doc: { x: number; y: number; width: number; height: number };
}

interface AnnotationBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface AnnotationItem {
  ref: string;
  number: number;
  role: string;
  name?: string;
  box: AnnotationBox;
}

interface OverlayItem {
  ref: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

interface AnnotationPlan {
  /** Always document-space items, fed to buildOverlayInjectionScript. */
  overlayItems: OverlayItem[];
  /** Items projected into the capture mode's image-space coordinates. */
  annotations: AnnotationItem[];
  /** Refs dropped because of maxLabels truncation. */
  skipped: number;
}

interface PlanAnnotationsParams {
  inputs: RawAnnotationInput[];
  space: CoordinateSpace;
  /** Required when space === "viewport". */
  scroll?: { x: number; y: number };
  /**
   * Viewport size (CSS px). Only meaningful when space === "viewport". When
   * provided, refs whose document box falls outside the current viewport rect
   * (`scroll` + this size) are counted as skipped instead of drawn, preserving
   * the shipped `labelsSkipped` contract. Omit it to disable that accounting.
   */
  viewport?: { width: number; height: number };
  /** Required when space === "element". */
  elementRect?: { x: number; y: number; width: number; height: number };
  maxLabels?: number;
}

function refToNumber(ref: string): number {
  const match = ref.match(/(\d+)/);
  if (!match) {
    return 0;
  }
  const n = Number(match[1]);
  return Number.isFinite(n) ? n : 0;
}

export function planAnnotations(params: PlanAnnotationsParams): AnnotationPlan {
  const maxLabels = params.maxLabels ?? ANNOTATION_MAX_LABELS_DEFAULT;

  if (params.space === "viewport" && !params.scroll) {
    throw new Error("planAnnotations: scroll is required when space is 'viewport'");
  }
  if (params.space === "element" && !params.elementRect) {
    throw new Error("planAnnotations: elementRect is required when space is 'element'");
  }

  // Element-mode filter: discard inputs that do not overlap the element rect.
  let kept = params.inputs;
  if (params.space === "element" && params.elementRect) {
    const er = params.elementRect;
    kept = params.inputs.filter((input) => rectsOverlap(input.doc, er));
  }

  // Viewport capture only shows refs inside the current viewport rect. An
  // off-viewport ref is still surfaced in `annotations` (with its real,
  // possibly out-of-image box) so callers can locate it, but it is not drawn
  // and is counted as skipped. This keeps the shipped `labelsSkipped` meaning
  // ("refs not present in the captured viewport image") instead of silently
  // narrowing it. Only applied when the caller supplies the viewport size;
  // without it we cannot decide off-screen state and skip nothing.
  const viewportRect =
    params.space === "viewport" && params.scroll && params.viewport
      ? {
          x: params.scroll.x,
          y: params.scroll.y,
          width: params.viewport.width,
          height: params.viewport.height,
        }
      : undefined;

  const overlayItems: OverlayItem[] = [];
  const annotations: AnnotationItem[] = [];
  let skipped = 0;

  for (const input of kept) {
    if (viewportRect && !rectsOverlap(input.doc, viewportRect)) {
      // Outside the captured viewport: count as skipped (compat) but still
      // report the annotation; do not draw it or consume the label budget.
      skipped += 1;
      annotations.push(toAnnotation(input, params));
      continue;
    }
    if (overlayItems.length >= maxLabels) {
      skipped += 1;
      continue;
    }
    overlayItems.push({
      ref: input.ref,
      x: input.doc.x,
      y: input.doc.y,
      w: input.doc.width,
      h: input.doc.height,
    });
    annotations.push(toAnnotation(input, params));
  }

  return { overlayItems, annotations, skipped };
}

function toAnnotation(input: RawAnnotationInput, params: PlanAnnotationsParams): AnnotationItem {
  return {
    ref: input.ref,
    number: refToNumber(input.ref),
    role: input.role,
    ...(input.name ? { name: input.name } : {}),
    box: projectBox(input.doc, params),
  };
}

function projectBox(
  doc: { x: number; y: number; width: number; height: number },
  params: PlanAnnotationsParams,
): AnnotationBox {
  if (params.space === "viewport") {
    const scroll = params.scroll!;
    return {
      x: doc.x - scroll.x,
      y: doc.y - scroll.y,
      width: doc.width,
      height: doc.height,
    };
  }
  if (params.space === "element") {
    const er = params.elementRect!;
    // NOTE: width/height pass through unchanged even when the input rect
    // partially extends past the element. The capture backend (e.g.
    // locator.screenshot) is responsible for clipping; the box may have
    // negative x/y or extend past elementRect width/height for partial overlaps.
    return {
      x: doc.x - er.x,
      y: doc.y - er.y,
      width: doc.width,
      height: doc.height,
    };
  }
  // fullpage: document coordinates as-is
  return { x: doc.x, y: doc.y, width: doc.width, height: doc.height };
}

function rectsOverlap(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

export function buildOverlayInjectionScript(params: {
  items: OverlayItem[];
  captureY?: number;
}): string {
  const itemsJson = JSON.stringify(
    params.items.map((it) => ({
      ref: it.ref,
      x: round(it.x),
      y: round(it.y),
      w: Math.max(1, round(it.w)),
      h: Math.max(1, round(it.h)),
    })),
  );
  const attr = ANNOTATION_OVERLAY_ATTR;
  const rootId = ANNOTATION_OVERLAY_ROOT_ID;
  const captureY = Number.isFinite(params.captureY) ? round(params.captureY ?? 0) : 0;
  return `(() => {
  var items = ${itemsJson};
  var captureY = ${captureY};
  var existing = document.querySelectorAll("[${attr}]");
  for (var k = 0; k < existing.length; k++) existing[k].remove();
  var root = document.createElement("div");
  root.id = ${JSON.stringify(rootId)};
  root.setAttribute("${attr}", "1");
  root.style.cssText = "position:absolute;top:0;left:0;width:0;height:0;pointer-events:none;z-index:2147483647;font-family:'SF Mono','SFMono-Regular',Menlo,Monaco,Consolas,'Liberation Mono','Courier New',monospace;";
  for (var i = 0; i < items.length; i++) {
    var it = items[i];
    var box = document.createElement("div");
    box.setAttribute("${attr}", "1");
    box.style.cssText = "position:absolute;left:" + it.x + "px;top:" + it.y + "px;width:" + it.w + "px;height:" + it.h + "px;border:2px solid #ffb020;box-sizing:border-box;pointer-events:none;";
    var tag = document.createElement("div");
    tag.setAttribute("${attr}", "1");
    tag.textContent = String(it.ref);
    var relativeY = it.y - captureY;
    var labelTop = relativeY < 14 ? (it.y + 2) : (it.y - 14);
    tag.style.cssText = "position:absolute;left:" + it.x + "px;top:" + labelTop + "px;background:#ffb020;color:#1a1a1a;font:bold 11px/14px monospace;padding:0 4px;border-radius:2px;white-space:nowrap;pointer-events:none;";
    root.appendChild(box);
    root.appendChild(tag);
  }
  document.documentElement.appendChild(root);
  return true;
})();`;
}

export function buildOverlayClearScript(): string {
  const attr = ANNOTATION_OVERLAY_ATTR;
  return `(() => {
  var existing = document.querySelectorAll("[${attr}]");
  for (var k = 0; k < existing.length; k++) existing[k].remove();
  return true;
})();`;
}

/**
 * Scale annotation boxes by independent x/y factors. Used to keep annotation
 * coordinates aligned with the saved image after the response pipeline
 * resizes the screenshot (e.g. via normalizeBrowserScreenshot capping the
 * longest side or the byte budget). Returns a new array; inputs are not
 * mutated. When both factors are 1 the boxes are returned unchanged (modulo
 * structural copy) so callers can share the same code path for resized and
 * non-resized captures.
 */
export function scaleAnnotations(
  items: AnnotationItem[],
  scaleX: number,
  scaleY: number,
): AnnotationItem[] {
  if (!Number.isFinite(scaleX) || !Number.isFinite(scaleY) || scaleX <= 0 || scaleY <= 0) {
    return items.map((it) => ({ ...it, box: { ...it.box } }));
  }
  if (scaleX === 1 && scaleY === 1) {
    return items.map((it) => ({ ...it, box: { ...it.box } }));
  }
  return items.map((it) => ({
    ...it,
    box: {
      x: round(it.box.x * scaleX),
      y: round(it.box.y * scaleY),
      width: Math.max(1, round(it.box.width * scaleX)),
      height: Math.max(1, round(it.box.height * scaleY)),
    },
  }));
}

function round(v: number): number {
  return Math.round(v);
}
