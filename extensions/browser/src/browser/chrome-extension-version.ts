import chromeExtensionManifest from "../../chrome-extension/manifest.json" with { type: "json" };
import type { BrowserChromeExtensionStatus } from "./client.types.js";

const BUNDLED_CHROME_EXTENSION_VERSION = chromeExtensionManifest.version;
const CHROME_EXTENSION_VERSION_COMPONENT_MAX = 65_535;
const CHROME_EXTENSION_VERSION_COMPONENT_PATTERN = /^(?:0|[1-9]\d{0,4})$/;

export function normalizeChromeExtensionManifestVersion(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const components = value.split(".");
  // Chrome accepts 1-4 components in 0..65535, with at least one non-zero.
  // Enforce that contract before status or Doctor can echo control-bearing input.
  if (components.length > 4) {
    return null;
  }
  let hasNonZeroComponent = false;
  for (const component of components) {
    if (!CHROME_EXTENSION_VERSION_COMPONENT_PATTERN.test(component)) {
      return null;
    }
    const parsed = Number(component);
    if (parsed > CHROME_EXTENSION_VERSION_COMPONENT_MAX) {
      return null;
    }
    hasNonZeroComponent ||= parsed !== 0;
  }
  return hasNonZeroComponent ? value : null;
}

/** Classify the connected extension version against the process-stable bundled manifest. */
export function buildChromeExtensionVersionStatus(
  runningVersion: string | null | undefined,
): BrowserChromeExtensionStatus {
  const normalizedRunningVersion = normalizeChromeExtensionManifestVersion(runningVersion);
  return {
    runningVersion: normalizedRunningVersion,
    bundledVersion: BUNDLED_CHROME_EXTENSION_VERSION,
    versionState: normalizedRunningVersion
      ? normalizedRunningVersion === BUNDLED_CHROME_EXTENSION_VERSION
        ? "match"
        : "mismatch"
      : "unavailable",
  };
}
