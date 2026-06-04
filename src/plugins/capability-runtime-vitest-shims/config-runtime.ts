import { resolveActiveTalkProviderConfig } from "../../config/talk.js";
import type { OpenClawConfig } from "../../config/types.js";

/** Vitest shim re-export for config runtime compatibility in capability tests. */
export { resolveActiveTalkProviderConfig };

/** Capability-test shim snapshot; tests inject config through direct helpers instead. */
export function getRuntimeConfigSnapshot(): OpenClawConfig | null {
  return null;
}
