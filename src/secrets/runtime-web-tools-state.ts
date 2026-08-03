/** Stores active web-tool metadata for the secrets runtime snapshot. */
import type { RuntimeWebToolsMetadata } from "./runtime-web-tools.types.js";

let activeRuntimeWebToolsMetadata: RuntimeWebToolsMetadata | null = null;

/**
 * Clears active web-tool metadata when the secrets runtime snapshot is reset.
 */
export function clearActiveRuntimeWebToolsMetadata(): void {
  activeRuntimeWebToolsMetadata = null;
}

/**
 * Stores web-tool metadata with clone isolation from caller-owned objects.
 */
export function setActiveRuntimeWebToolsMetadata(metadata: RuntimeWebToolsMetadata): void {
  activeRuntimeWebToolsMetadata = structuredClone(metadata);
}

/**
 * Returns active web-tool metadata without exposing mutable runtime state.
 */
export function getActiveRuntimeWebToolsMetadata(): RuntimeWebToolsMetadata | null {
  if (!activeRuntimeWebToolsMetadata) {
    return null;
  }
  return structuredClone(activeRuntimeWebToolsMetadata);
}
