/**
 * Runtime dependency barrel for the Browser agent tool.
 *
 * Kept separate from browser-tool.ts so tests can mock the tool boundary while
 * production still imports SDK helpers and browser client actions lazily.
 */
import { getRuntimeConfig } from "./sdk-config.js";

export { getRuntimeConfig };
/** Resolve global image downscaling for screenshots returned to agent tools. */
export function resolveRuntimeImageSanitization(): { maxDimensionPx: number } | undefined {
  const configured = getRuntimeConfig().agents?.defaults?.imageMaxDimensionPx;
  if (typeof configured !== "number" || !Number.isFinite(configured)) {
    return undefined;
  }
  return { maxDimensionPx: Math.max(1, Math.floor(configured)) };
}
export {
  callGatewayTool,
  describeImageFile,
  imageResultFromFile,
  jsonResult,
  listNodes,
  readPositiveIntegerParam,
  readStringParam,
  resolveNodeIdFromList,
  saveMediaBuffer,
  selectDefaultNodeFromList,
} from "./sdk-setup-tools.js";
export type { AnyAgentTool, NodeListNode } from "./sdk-setup-tools.js";
export { wrapExternalContent } from "./sdk-security-runtime.js";
export {
  normalizeOptionalString,
  readStringValue,
} from "openclaw/plugin-sdk/string-coerce-runtime";
export { BrowserToolSchema } from "./browser-tool.schema.js";
export {
  browserAct,
  browserArmDialog,
  browserArmFileChooser,
  browserConsoleMessages,
  browserNavigate,
  browserPdfSave,
  browserScreenshotAction,
} from "./browser/client-actions.js";
export {
  browserCloseTab,
  browserDoctor,
  browserFocusTab,
  browserOpenTab,
  browserProfiles,
  browserSnapshot,
  browserStart,
  browserStatus,
  browserStop,
  browserTabs,
} from "./browser/client.js";
export { resolveBrowserConfig, resolveProfile } from "./browser/config.js";
export { DEFAULT_AI_SNAPSHOT_MAX_CHARS } from "./browser/constants.js";
export { resolveExistingUploadPaths } from "./browser/paths.js";
export { getBrowserProfileCapabilities } from "./browser/profile-capabilities.js";
export { applyBrowserProxyPaths, persistBrowserProxyFiles } from "./browser/proxy-files.js";
export {
  touchSessionBrowserTab,
  trackSessionBrowserTab,
  untrackSessionBrowserTab,
} from "./browser/session-tab-registry.js";
