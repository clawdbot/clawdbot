// Compile-time identity for the Control UI artifact.
import { normalizeControlUiBuildInfo } from "./build-info-normalizers.ts";
import type { ControlUiBuildInfo } from "./build-info-types.ts";

export type { ControlUiBuildInfo } from "./build-info-types.ts";

declare global {
  // Vite replaces this property with one object so the UI and service worker
  // share the exact artifact identity without separate compile-time constants.
  var OPENCLAW_CONTROL_UI_BUILD_INFO: ControlUiBuildInfo | undefined;
}

const injectedBuildInfo = globalThis.OPENCLAW_CONTROL_UI_BUILD_INFO;

export const CONTROL_UI_BUILD_INFO = normalizeControlUiBuildInfo(injectedBuildInfo);
