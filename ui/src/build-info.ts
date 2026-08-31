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

/** Reports whether the reload was started, so callers can tell an outcome they
 * still have to present from one the reloaded document will present instead. */
export function reloadControlUiIfStale(identity: {
  version: string | null;
  sha: string | null;
}): boolean {
  if (
    typeof window !== "undefined" &&
    controlUiVersionDiffersFrom(identity.version ?? undefined, identity.sha ?? undefined)
  ) {
    window.location.reload();
    return true;
  }
  return false;
}

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
  return controlUiVersionDiffersFrom(identity.version ?? undefined);
}

function controlUiVersionDiffersFrom(
  gatewayVersion: string | undefined,
  gatewayCommit?: string,
): boolean {
  const controlUiVersion = CONTROL_UI_BUILD_INFO.version?.trim();
  const normalizedGatewayVersion = gatewayVersion?.trim();
  if (
    controlUiVersion &&
    normalizedGatewayVersion &&
    controlUiVersion !== normalizedGatewayVersion
  ) {
    return true;
  }
  const controlUiCommit = CONTROL_UI_BUILD_INFO.commit?.trim().toLowerCase();
  const normalizedGatewayCommit = gatewayCommit?.trim().toLowerCase();
  return Boolean(
    controlUiCommit &&
    normalizedGatewayCommit &&
    !controlUiCommit.startsWith(normalizedGatewayCommit) &&
    !normalizedGatewayCommit.startsWith(controlUiCommit),
  );
}
