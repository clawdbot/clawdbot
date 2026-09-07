import { resolveOptionalIntegerOption } from "openclaw/plugin-sdk/number-runtime";
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
  const maxDimensionPx = resolveOptionalIntegerOption(
    getRuntimeConfig().agents?.defaults?.imageMaxDimensionPx,
    { min: 1 },
  );
  if (maxDimensionPx === undefined) {
    return undefined;
  }
  return { maxDimensionPx };
}
export {
  callGatewayTool,
  describeImageFile,
  hasGatewayToolRoutingContext,
  imageResultFromFile,
  jsonResult,
  listNodes,
  readPositiveIntegerParam,
  readStringParam,
  saveMediaBuffer,
} from "./sdk-setup-tools.js";
export type { AnyAgentTool } from "./sdk-setup-tools.js";
export { wrapExternalContent } from "./sdk-security-runtime.js";
export {
  normalizeOptionalString,
  readStringValue,
} from "openclaw/plugin-sdk/string-coerce-runtime";
export {
  BrowserToolOutputSchema,
  createBrowserToolSchema,
  resolveBrowserToolCapabilities,
} from "./browser-tool.schema.js";
export type { BrowserToolCapabilities } from "./browser-tool.schema.js";
export {
  browserAct,
  browserArmDialog,
  browserArmFileChooser,
  browserConsoleMessages,
  browserRequests,
  browserErrors,
  browserPageText,
  browserEmulateSetting,
  browserDownload,
  browserNavigate,
  browserPdfSave,
  browserScreenshotAction,
  browserWaitForDownload,
} from "./browser/client-actions.js";
export {
  browserCloseTab,
  browserDoctor,
  browserFocusTab,
  browserImportProfile,
  normalizeBrowserTabsResult,
  browserOpenTab,
  browserProfiles,
  browserSystemProfiles,
  browserSnapshot,
  browserStart,
  browserStatus,
  browserStop,
  browserTabs,
} from "./browser/client.js";
export type { BrowserTabsResult } from "./browser/client.js";
export { fetchBrowserJson } from "./browser/client-fetch.js";
export { resolveBrowserConfig, resolveProfile } from "./browser/config.js";
export { DEFAULT_AI_SNAPSHOT_MAX_CHARS } from "./browser/constants.js";
export { resolveExistingUploadPaths } from "./browser/paths.js";
export { getBrowserProfileCapabilities } from "./browser/profile-capabilities.js";
export { persistBrowserProxyResultFiles } from "./browser/proxy-files.js";
export { stageBrowserScreenshotForSharing } from "./browser/screenshot-sharing.js";
export {
  touchSessionBrowserTab,
  trackSessionBrowserTab,
  untrackSessionBrowserTab,
} from "./browser/session-tab-registry.js";
