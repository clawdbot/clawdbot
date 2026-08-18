import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { validateSupportedA2UIJsonl } from "./a2ui-jsonl.js";

const A2UI_V08_BUNDLE_PATH = "/__openclaw__/a2ui/a2ui.bundle.js";
const A2UI_V09_BUNDLE_PATH = "/__openclaw__/a2ui/a2ui-v0.9.bundle.js";

function escapeHtmlAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function bootScript(messages: unknown[], promptGranted: boolean): string {
  const boot = JSON.stringify({ messages, actionTier: promptGranted ? "prompt" : "state" })
    .replaceAll("<", "\\u003c")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
  return `<script>globalThis.__openclawA2UIBoot=${boot};</script>`;
}

function resourceScript(path: string, url: string): string {
  if (url !== path) {
    return `<script src="${escapeHtmlAttribute(url)}"></script>`;
  }
  const serializedPath = JSON.stringify(path).replaceAll("<", "\\u003c");
  return `<script>(()=>{const match=location.pathname.match(/^\\/__openclaw__\\/cap\\/[^/]+/u);const script=document.createElement("script");script.src=(match?.[0]??"")+${serializedPath};document.head.appendChild(script);})();</script>`;
}

/** Canvas-owned A2UI source validation and document composition for boards. */
export const canvasA2UIBoardWidgetKind: Parameters<
  OpenClawPluginApi["registerBoardWidgetContentKind"]
>[0] = {
  kind: "a2ui",
  label: "A2UI",
  resources: {
    surface: "canvas",
    paths: [A2UI_V08_BUNDLE_PATH, A2UI_V09_BUNDLE_PATH],
  },
  validateSource(source) {
    validateSupportedA2UIJsonl(source);
  },
  composeDocument({ source, resourceUrls, promptGranted }) {
    const parsed = validateSupportedA2UIJsonl(source);
    const bundlePath = parsed.version === "v0.9" ? A2UI_V09_BUNDLE_PATH : A2UI_V08_BUNDLE_PATH;
    const bundleUrl = resourceUrls[bundlePath];
    if (!bundleUrl) {
      throw new Error(`A2UI renderer resource unavailable: ${bundlePath}`);
    }
    return `${bootScript(parsed.messages, promptGranted)}<style>html,body{height:100%;overflow:hidden;background:transparent}openclaw-a2ui-host{display:block;height:100%}</style><openclaw-a2ui-host></openclaw-a2ui-host>${resourceScript(bundlePath, bundleUrl)}`;
  },
};
