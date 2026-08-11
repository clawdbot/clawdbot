// Compile-time identity for the Control UI artifact.
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

export function reloadControlUiIfStale(identity: {
  version: string | null;
  sha: string | null;
}): void {
  if (
    typeof window !== "undefined" &&
    controlUiVersionDiffersFrom(identity.version ?? undefined, identity.sha ?? undefined)
  ) {
    window.location.reload();
  }
}

export function controlUiVersionDiffersFrom(
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
