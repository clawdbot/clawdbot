import { asRecord } from "@openclaw/normalization-core/record-coerce";
import createDOMPurify from "dompurify";
import type { MermaidConfig } from "mermaid";
import mermaidScriptUrl from "mermaid/dist/mermaid.min.js?url&no-inline";
import frameScriptUrl from "./frame.js?url&no-inline";

export type MermaidTheme = {
  background: string;
  foreground: string;
  muted: string;
  border: string;
  accent: string;
  fontFamily: string;
  darkMode: boolean;
};

// Native hosts must not retain engine failures in their permanent failure cache.
export class MermaidTransientError extends Error {}

const MAX_SOURCE_LENGTH = 20_000;
const MAX_EDGES = 200;
const MAX_SVG_LENGTH = 1_000_000;
const MAX_SVG_ELEMENTS = 5_000;
const RENDER_TIMEOUT_MS = 15_000;
const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const LOCAL_REFERENCE = /^url\(["']?(#[^\s"'()]+)["']?\)$/u;
const SVG_TAGS = [
  "svg",
  "g",
  "defs",
  "marker",
  "path",
  "rect",
  "circle",
  "ellipse",
  "polygon",
  "polyline",
  "line",
  "text",
  "tspan",
  "title",
  "desc",
  "clipPath",
  "mask",
  "linearGradient",
  "radialGradient",
  "stop",
  "pattern",
];
const SVG_ATTRIBUTES = [
  "id",
  "xmlns",
  "viewBox",
  "width",
  "height",
  "x",
  "y",
  "dx",
  "dy",
  "x1",
  "y1",
  "x2",
  "y2",
  "cx",
  "cy",
  "r",
  "rx",
  "ry",
  "d",
  "points",
  "transform",
  "preserveAspectRatio",
  "fill",
  "fill-opacity",
  "fill-rule",
  "stroke",
  "stroke-width",
  "stroke-opacity",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-dasharray",
  "stroke-dashoffset",
  "opacity",
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "text-anchor",
  "dominant-baseline",
  "alignment-baseline",
  "baseline-shift",
  "text-decoration",
  "letter-spacing",
  "word-spacing",
  "visibility",
  "display",
  "markerWidth",
  "markerHeight",
  "refX",
  "refY",
  "orient",
  "markerUnits",
  "marker-start",
  "marker-mid",
  "marker-end",
  "clip-path",
  "mask",
  "gradientUnits",
  "gradientTransform",
  "offset",
  "stop-color",
  "stop-opacity",
  "patternUnits",
  "patternContentUnits",
  "patternTransform",
  "role",
];

type MermaidFrame = {
  frame: HTMLIFrameElement;
  ready: Promise<void>;
  render: (source: string, config: MermaidConfig) => Promise<string>;
  dispose: (error: Error) => void;
};

let renderer: MermaidFrame | undefined;
let renderQueue = Promise.resolve();

function sanitizeMermaidSvg(source: string, backgroundColor: string): string {
  if (source.length > MAX_SVG_LENGTH) {
    throw new Error("Mermaid diagram output is too large.");
  }
  // This instance must not inherit the generic Markdown sanitizer's link hooks.
  const purifier = createDOMPurify(window);
  const fragment = purifier.sanitize(source, {
    ALLOWED_TAGS: SVG_TAGS,
    ALLOWED_ATTR: SVG_ATTRIBUTES,
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: true,
    RETURN_DOM_FRAGMENT: true,
  });
  const svg = fragment.firstElementChild;
  if (fragment.childElementCount !== 1 || !(svg instanceof SVGSVGElement)) {
    throw new Error("Mermaid returned an invalid diagram.");
  }
  const elements = [svg, ...svg.querySelectorAll("*")];
  if (elements.length > MAX_SVG_ELEMENTS) {
    throw new Error("Mermaid diagram contains too many elements.");
  }
  const colorParser = document.createElement("canvas").getContext("2d");
  if (!colorParser) {
    throw new MermaidTransientError("Mermaid diagram colors could not be prepared.");
  }
  for (const element of elements) {
    for (const attribute of ["marker-start", "marker-mid", "marker-end", "clip-path", "mask"]) {
      const value = element.getAttribute(attribute);
      if (value && value !== "none" && !LOCAL_REFERENCE.test(value)) {
        element.removeAttribute(attribute);
      }
    }
    for (const attribute of ["fill", "stroke", "stop-color"]) {
      const value = element.getAttribute(attribute);
      if (!value || value === "none" || LOCAL_REFERENCE.test(value)) {
        continue;
      }
      // Canvas accepts CSS colors, never paint URLs or unresolved CSS variables.
      colorParser.fillStyle = "#000000";
      colorParser.fillStyle = value;
      element.setAttribute(attribute, colorParser.fillStyle);
    }
  }
  svg.setAttribute("xmlns", SVG_NAMESPACE);
  // The image also opens over the lightbox backdrop. Paint its own theme
  // background so labels and edges stay readable outside the chat card.
  const background = document.createElementNS(SVG_NAMESPACE, "rect");
  const bounds = svg.viewBox.baseVal;
  background.setAttribute("x", String(bounds.x));
  background.setAttribute("y", String(bounds.y));
  background.setAttribute("width", "100%");
  background.setAttribute("height", "100%");
  colorParser.fillStyle = backgroundColor;
  background.setAttribute("fill", colorParser.fillStyle);
  svg.prepend(background);
  return new XMLSerializer().serializeToString(svg);
}

function createMermaidFrame(): MermaidFrame {
  const frame = document.createElement("iframe");
  const channel = new MessageChannel();
  let readyResolve: () => void;
  let readyReject: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  let pending:
    | {
        id: number;
        resolve: (svg: string) => void;
        reject: (error: Error) => void;
      }
    | undefined;
  let nextId = 0;
  let initialized = false;
  let loaded = false;
  let disposed = false;
  let timeout: number;
  const instance: MermaidFrame = {
    frame,
    ready,
    dispose(error) {
      if (disposed) {
        return;
      }
      disposed = true;
      window.clearTimeout(timeout);
      channel.port1.close();
      channel.port2.close();
      frame.remove();
      readyReject(error);
      pending?.reject(error);
      pending = undefined;
      if (renderer === instance) {
        renderer = undefined;
      }
    },
    render(source, config) {
      if (disposed || !frame.isConnected) {
        return Promise.reject(new MermaidTransientError("Mermaid renderer is unavailable."));
      }
      return new Promise((resolve, reject) => {
        const id = ++nextId;
        pending = { id, resolve, reject };
        timeout = window.setTimeout(
          () => instance.dispose(new MermaidTransientError("Mermaid diagram rendering timed out.")),
          RENDER_TIMEOUT_MS,
        );
        channel.port1.postMessage({
          id,
          source,
          config,
          maxSvgLength: MAX_SVG_LENGTH,
          maxSvgElements: MAX_SVG_ELEMENTS,
        });
      });
    },
  };
  channel.port1.addEventListener("message", (event: MessageEvent<unknown>) => {
    if (disposed || !frame.isConnected) {
      return;
    }
    const result = asRecord(event.data);
    if (!initialized && result.type === "ready") {
      initialized = true;
      window.clearTimeout(timeout);
      readyResolve();
      return;
    }
    const request = pending;
    if (!initialized || !request || result.id !== request.id) {
      return;
    }
    pending = undefined;
    window.clearTimeout(timeout);
    if (typeof result.error === "string") {
      request.reject(new Error(result.error.slice(0, 1_000)));
    } else if (typeof result.svg === "string" && result.svg.length <= MAX_SVG_LENGTH) {
      request.resolve(result.svg);
    } else {
      request.reject(new Error("Mermaid returned an invalid diagram."));
    }
  });
  channel.port1.start();
  frame.addEventListener("load", () => {
    if (loaded) {
      instance.dispose(new MermaidTransientError("Mermaid renderer navigated unexpectedly."));
      return;
    }
    loaded = true;
    // The frame has an opaque origin. Only this exact window receives the port;
    // all subsequent diagram data travels on that private channel.
    frame.contentWindow?.postMessage({ type: "openclaw:mermaid-init" }, "*", [channel.port2]);
  });
  frame.setAttribute("sandbox", "allow-scripts");
  frame.setAttribute("aria-hidden", "true");
  frame.tabIndex = -1;
  frame.inert = true;
  frame.referrerPolicy = "no-referrer";
  frame.style.cssText =
    "position:fixed;left:-10000px;top:0;width:1024px;height:768px;border:0;visibility:hidden;pointer-events:none";
  const scripts = [mermaidScriptUrl, frameScriptUrl].map((url) => new URL(url, location.href).href);
  const policy = `default-src 'none'; script-src ${scripts.join(" ")}; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'`;
  const page = document.implementation.createHTMLDocument("");
  const meta = page.createElement("meta");
  meta.httpEquiv = "Content-Security-Policy";
  meta.content = policy;
  page.head.append(meta);
  for (const url of scripts) {
    const script = page.createElement("script");
    script.src = url;
    page.head.append(script);
  }
  frame.srcdoc = `<!doctype html>${page.documentElement.outerHTML}`;
  timeout = window.setTimeout(
    () => instance.dispose(new MermaidTransientError("Mermaid renderer could not be loaded.")),
    RENDER_TIMEOUT_MS,
  );
  document.body.append(frame);
  return instance;
}

export function renderMermaidSvg(source: string, theme: MermaidTheme): Promise<string> {
  if (!source.trim() || source.length > MAX_SOURCE_LENGTH) {
    return Promise.reject(
      new Error(`Mermaid diagrams must contain 1–${MAX_SOURCE_LENGTH} characters.`),
    );
  }
  // Mermaid's initialization and rendering share global config. Keep them in
  // one serialized owner, including after a failed render or a theme change.
  const result = renderQueue.then(async () => {
    if (renderer && !renderer.frame.isConnected) {
      renderer.dispose(new MermaidTransientError("Mermaid renderer was removed."));
    }
    renderer ??= createMermaidFrame();
    const active = renderer;
    try {
      await active.ready;
      const config: MermaidConfig = {
        startOnLoad: false,
        securityLevel: "strict",
        secure: ["dompurifyConfig"],
        htmlLabels: false,
        suppressErrorRendering: true,
        maxTextSize: MAX_SOURCE_LENGTH,
        maxEdges: MAX_EDGES,
        arrowMarkerAbsolute: false,
        theme: "base",
        themeCSS: "",
        fontFamily: theme.fontFamily,
        themeVariables: {
          darkMode: theme.darkMode,
          background: theme.background,
          primaryColor: theme.background,
          primaryTextColor: theme.foreground,
          primaryBorderColor: theme.border,
          lineColor: theme.muted,
          secondaryColor: theme.accent,
          tertiaryColor: theme.background,
          textColor: theme.foreground,
          edgeLabelBackground: theme.background,
        },
      };
      return sanitizeMermaidSvg(await active.render(source, config), theme.background);
    } catch (error) {
      active.dispose(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  });
  renderQueue = result.then(
    () => {},
    () => {},
  );
  return result;
}

window.addEventListener("pagehide", () =>
  renderer?.dispose(new MermaidTransientError("Mermaid renderer closed.")),
);
