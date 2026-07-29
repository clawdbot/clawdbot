import {
  buildAnnotationPrompt,
  composeAnnotatedImage,
  dispatchBrowserAnnotation,
  paintAnnotations,
  type AnnotationRegion,
  type AnnotationStroke,
} from "./browser-annotation.ts";
import type {
  BrowserInspectedNode,
  BrowserPageMetrics,
  BrowserPanelTab,
} from "./browser-client.ts";

const FORWARDED_KEYS = new Set([
  "Enter",
  "Backspace",
  "Delete",
  "Tab",
  "Escape",
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "Home",
  "End",
  "PageUp",
  "PageDown",
]);

/** One rendered page snapshot plus the geometry needed to map pointer coords. */
export type BrowserPanelView = {
  targetId: string;
  dataUrl: string;
  image: HTMLImageElement;
  url: string;
  metrics: BrowserPageMetrics | null;
};

export function loadBrowserPanelImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.addEventListener("load", () => resolve(image));
    image.addEventListener("error", () => reject(new Error("screenshot decode failed")));
    image.src = dataUrl;
  });
}

export function browserPanelShouldForwardKey(key: string): boolean {
  return FORWARDED_KEYS.has(key) || key.length === 1;
}

/** Normalized [0..1] stage coordinates for a pointer event. */
export function browserPanelNormalizedPoint(
  stage: HTMLElement | null,
  event: MouseEvent,
): { x: number; y: number } | null {
  if (!stage) {
    return null;
  }
  const rect = stage.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) {
    return null;
  }
  return {
    x: (event.clientX - rect.left) / rect.width,
    y: (event.clientY - rect.top) / rect.height,
  };
}

/** Remote CSS-pixel coordinates for a pointer event. */
export function browserPanelRemotePoint(
  stage: HTMLElement | null,
  event: MouseEvent,
  view: BrowserPanelView | null,
): { x: number; y: number } | null {
  const point = browserPanelNormalizedPoint(stage, event);
  if (!point || !view) {
    return null;
  }
  const cssWidth = view.metrics?.cssWidth ?? view.image.naturalWidth;
  const cssHeight = view.metrics?.cssHeight ?? view.image.naturalHeight;
  return { x: point.x * cssWidth, y: point.y * cssHeight };
}

export function browserPanelInspectHighlightRegion(
  view: BrowserPanelView | null,
  node: BrowserInspectedNode | null,
): AnnotationRegion | null {
  if (!view || !node) {
    return null;
  }
  const cssWidth = view.metrics?.cssWidth ?? view.image.naturalWidth;
  const cssHeight = view.metrics?.cssHeight ?? view.image.naturalHeight;
  if (cssWidth <= 0 || cssHeight <= 0) {
    return null;
  }
  return {
    x: node.rect.x / cssWidth,
    y: node.rect.y / cssHeight,
    width: node.rect.width / cssWidth,
    height: node.rect.height / cssHeight,
  };
}

export function paintBrowserPanelOverlay(
  canvas: HTMLCanvasElement | null,
  stage: HTMLElement | null,
  strokes: AnnotationStroke[],
  highlight: AnnotationRegion | null,
): void {
  if (!canvas || !stage) {
    return;
  }
  const width = Math.max(1, Math.round(stage.clientWidth));
  const height = Math.max(1, Math.round(stage.clientHeight));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const context = canvas.getContext("2d");
  if (!context) {
    return;
  }
  context.clearRect(0, 0, width, height);
  paintAnnotations(context, { width, height, strokes, highlight });
}

export function dispatchCompositedBrowserAnnotation(
  view: BrowserPanelView,
  tab: BrowserPanelTab | undefined,
  strokes: AnnotationStroke[],
  element: BrowserInspectedNode | null,
  highlight: AnnotationRegion | null,
): boolean {
  const url = view.metrics?.url || view.url || tab?.url || "";
  const title = view.metrics?.title || tab?.title || "";
  const text = buildAnnotationPrompt({ url, title, strokes, element });
  const dataUrl = composeAnnotatedImage({
    image: view.image,
    width: view.image.naturalWidth,
    height: view.image.naturalHeight,
    strokes,
    highlight,
  });
  return dispatchBrowserAnnotation({ text, dataUrl, fileName: "annotated-page.png" });
}
