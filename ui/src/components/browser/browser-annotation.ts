// Annotation model for the browser panel: freehand strokes drawn over a page
// screenshot, plus the prepackaged prompt handed to the chat composer so the
// agent knows what was marked up.
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { t } from "../../i18n/index.ts";
import type { BrowserInspectedNode } from "./browser-client.ts";

/** Point in normalized [0..1] coordinates of the captured screenshot. */
type AnnotationPoint = { x: number; y: number };

export type AnnotationStroke = { points: AnnotationPoint[] };

/** Axis-aligned box in normalized [0..1] screenshot coordinates. */
export type AnnotationRegion = { x: number; y: number; width: number; height: number };

/** Payload delivered to the active chat pane when an annotation is sent. */
export type BrowserAnnotationDraft = {
  text: string;
  /** PNG data URL of the screenshot with the markup composited in. */
  dataUrl: string;
  fileName: string;
};

export const BROWSER_ANNOTATION_EVENT = "openclaw:browser-annotation";

/**
 * Hands an annotation to whichever chat pane is active. Returns false when no
 * pane consumed it (chat not mounted), so the panel can surface a hint instead
 * of silently dropping the user's markup.
 */
export function dispatchBrowserAnnotation(draft: BrowserAnnotationDraft): boolean {
  const event = new CustomEvent<BrowserAnnotationDraft>(BROWSER_ANNOTATION_EVENT, {
    detail: draft,
    cancelable: true,
  });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function strokeBoundingRegion(stroke: AnnotationStroke): AnnotationRegion | null {
  if (stroke.points.length === 0) {
    return null;
  }
  let minX = 1;
  let minY = 1;
  let maxX = 0;
  let maxY = 0;
  for (const point of stroke.points) {
    minX = Math.min(minX, clamp01(point.x));
    minY = Math.min(minY, clamp01(point.y));
    maxX = Math.max(maxX, clamp01(point.x));
    maxY = Math.max(maxY, clamp01(point.y));
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function percent(value: number): string {
  return String(Math.round(clamp01(value) * 100));
}

/**
 * Page-controlled strings (title, element names) enter the prompt as quoted
 * data only. Collapse whitespace and cap the length so a hostile page cannot
 * smuggle multi-line directives that read as the user's own instructions; the
 * prompt template additionally labels these values as page-reported.
 */
function sanitizePageText(value: string, maxLength = 80): string {
  return truncateUtf16Safe(value.replace(/\s+/g, " ").trim(), maxLength);
}

/** Selector fragments (tag/id/class) are page-controlled too: keep only
 * word characters and dashes so they cannot carry quotes or directives. */
function sanitizeSelectorToken(value: string, maxLength = 40): string {
  return value.replace(/[^\w-]/g, "").slice(0, maxLength);
}

/** Compact human/agent-readable element descriptor, e.g. `button#save.btn "Save"`. */
function describeInspectedNode(node: BrowserInspectedNode): string {
  const classes = node.classes
    .slice(0, 3)
    .map((cls) => sanitizeSelectorToken(cls))
    .filter((cls) => cls.length > 0)
    .map((cls) => `.${cls}`)
    .join("");
  const tag = sanitizeSelectorToken(node.tag) || "element";
  const id = sanitizeSelectorToken(node.id);
  const selector = `${tag}${id ? `#${id}` : ""}${classes}`;
  const sanitizedName = sanitizePageText(node.name);
  const name = sanitizedName ? ` "${sanitizedName}"` : "";
  const role = node.role ? ` (role=${sanitizePageText(node.role, 40)})` : "";
  return `${selector}${name}${role}`;
}

const MAX_PROMPT_REGIONS = 8;

/**
 * Builds the prepackaged prompt describing the markup. Regions are reported as
 * viewport percentages so the agent can relate them to the attached screenshot
 * without knowing the capture resolution.
 */
export function buildAnnotationPrompt(params: {
  url: string;
  title: string;
  strokes: AnnotationStroke[];
  element?: BrowserInspectedNode | null;
}): string {
  const title = sanitizePageText(params.title);
  const lines: string[] = [
    title
      ? t("browser.annotatePrompt.introTitled", { url: params.url, title })
      : t("browser.annotatePrompt.introUntitled", { url: params.url }),
  ];
  const regions = params.strokes.flatMap((stroke) => strokeBoundingRegion(stroke) ?? []);
  regions.slice(0, MAX_PROMPT_REGIONS).forEach((region, index) => {
    lines.push(
      t("browser.annotatePrompt.region", {
        index: String(index + 1),
        x: percent(region.x + region.width / 2),
        y: percent(region.y + region.height / 2),
        width: percent(region.width),
        height: percent(region.height),
      }),
    );
  });
  if (regions.length > MAX_PROMPT_REGIONS) {
    lines.push(
      t("browser.annotatePrompt.moreRegions", {
        count: String(regions.length - MAX_PROMPT_REGIONS),
      }),
    );
  }
  if (params.element) {
    lines.push(
      t("browser.annotatePrompt.elementDetail", {
        descriptor: describeInspectedNode(params.element),
        width: String(Math.round(params.element.rect.width)),
        height: String(Math.round(params.element.rect.height)),
        x: String(Math.round(params.element.rect.x)),
        y: String(Math.round(params.element.rect.y)),
      }),
    );
  }
  lines.push(t("browser.annotatePrompt.outro"));
  return lines.join("\n");
}

const ANNOTATION_STROKE_COLOR = "#e0442d";

function annotationStrokeWidth(imageWidth: number): number {
  return Math.max(4, Math.round(imageWidth * 0.005));
}

/**
 * Draws the strokes (and optional element highlight, both in normalized
 * screenshot coordinates) onto a 2D context sized to the capture resolution.
 * Split from the data-URL export so the panel can also paint the live overlay
 * with the same geometry.
 */
export function paintAnnotations(
  ctx: CanvasRenderingContext2D,
  params: {
    width: number;
    height: number;
    strokes: AnnotationStroke[];
    highlight?: AnnotationRegion | null;
  },
): void {
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = ANNOTATION_STROKE_COLOR;
  ctx.lineWidth = annotationStrokeWidth(params.width);
  for (const stroke of params.strokes) {
    if (stroke.points.length === 0) {
      continue;
    }
    ctx.beginPath();
    stroke.points.forEach((point, index) => {
      const x = clamp01(point.x) * params.width;
      const y = clamp01(point.y) * params.height;
      if (index === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
    });
    if (stroke.points.length === 1) {
      // A click without movement still deserves a visible dot.
      const point = stroke.points[0];
      if (point) {
        ctx.lineTo(clamp01(point.x) * params.width + 0.1, clamp01(point.y) * params.height);
      }
    }
    ctx.stroke();
  }
  if (params.highlight) {
    const { x, y, width, height } = params.highlight;
    ctx.strokeRect(
      clamp01(x) * params.width,
      clamp01(y) * params.height,
      Math.max(2, width * params.width),
      Math.max(2, height * params.height),
    );
  }
}

/** Composites the screenshot and markup into a PNG data URL for the chat attachment. */
export function composeAnnotatedImage(params: {
  image: CanvasImageSource;
  width: number;
  height: number;
  strokes: AnnotationStroke[];
  highlight?: AnnotationRegion | null;
}): string {
  const canvas = document.createElement("canvas");
  canvas.width = params.width;
  canvas.height = params.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("canvas 2d context unavailable");
  }
  ctx.drawImage(params.image, 0, 0, params.width, params.height);
  paintAnnotations(ctx, params);
  return canvas.toDataURL("image/png");
}
