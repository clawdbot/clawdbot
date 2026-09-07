// Compile-time identity for the Control UI artifact.
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeControlUiBuildInfo } from "./build-info-normalizers.ts";
import type { ControlUiBuildInfo } from "./build-info-types.ts";

export type { ControlUiBuildInfo } from "./build-info-types.ts";

declare global {
  // Vite replaces this property with one object so the UI and service worker
  // share the exact artifact identity without separate compile-time constants.
  var OPENCLAW_CONTROL_UI_BUILD_INFO: ControlUiBuildInfo | undefined;
}

export const CONTROL_UI_BUILD_INFO =
  globalThis.OPENCLAW_CONTROL_UI_BUILD_INFO ?? normalizeControlUiBuildInfo(undefined);

/** Whether a service worker activation retires this document, so it has to
 * reload onto the announced build. The announcement (`ui/public/sw.js`) is the
 * only truthful view of which build controls the document: an update keeps the
 * registered `sw.js?v=<registering build>` URL while serving new bytes, so a
 * worker's `scriptURL` names the build that registered it, not the one it runs.
 * A worker announcing this document's own build replaces nothing. */
export function controlUiWorkerActivationRetires(message: unknown): boolean {
  return (
    isRecord(message) &&
    message.type === "sw-updated" &&
    typeof message.version === "string" &&
    message.version !== CONTROL_UI_BUILD_INFO.buildId
  );
}

/** Exact artifact comparison when both sides expose it. Configured roots opt
 * out explicitly; a missing source denotes a legacy gateway and keeps the
 * package-version fallback used before build ids shipped. */
export function controlUiBuildDiffersFrom(identity: {
  version?: string | null;
  buildId?: string | null;
  controlUiBuildSource?: "bundled" | "configured";
}): boolean {
  if (identity.controlUiBuildSource === "configured") {
    return false;
  }
  const controlUiBuildId = CONTROL_UI_BUILD_INFO.buildId?.trim();
  const gatewayBuildId = identity.buildId?.trim();
  if (controlUiBuildId && controlUiBuildId !== "dev" && gatewayBuildId) {
    return controlUiBuildId !== gatewayBuildId;
  }
  const controlUiVersion = CONTROL_UI_BUILD_INFO.version?.trim();
  const gatewayVersion = identity.version?.trim();
  return Boolean(controlUiVersion && gatewayVersion && controlUiVersion !== gatewayVersion);
}
