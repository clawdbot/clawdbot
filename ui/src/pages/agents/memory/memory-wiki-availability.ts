import type { ConfigSnapshot } from "../../../api/types.ts";
import { isPluginEnabledInConfigSnapshot } from "../../../lib/plugin-activation.ts";

export function isMemoryWikiEnabled(configSnapshot: ConfigSnapshot | null): boolean {
  return isPluginEnabledInConfigSnapshot(configSnapshot, "memory-wiki", {
    enabledByDefault: false,
  });
}
