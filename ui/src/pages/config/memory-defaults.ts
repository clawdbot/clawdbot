import { asNullableRecord as asConfigRecord } from "@openclaw/normalization-core/record-coerce";
import type { RuntimeConfigCapability } from "../../lib/config/index.ts";

type ConfigRemover = Pick<RuntimeConfigCapability, "removeFormValue">;

export function resetMemoryEngine(config: ConfigRemover, disabled = false): boolean {
  if (disabled) {
    return false;
  }
  config.removeFormValue(["plugins", "slots", "memory"]);
  return true;
}

export function dreamingConfigPath(pluginId: string, path: readonly string[]) {
  return ["plugins", "entries", pluginId, "config", "dreaming", ...path];
}

export function resolveDreamingTimezoneDefault(
  configObject: Record<string, unknown> | null,
): string | null {
  const agents = asConfigRecord(configObject?.agents);
  const defaults = asConfigRecord(agents?.defaults);
  const timezone = defaults?.userTimezone;
  return typeof timezone === "string" && timezone.trim() ? timezone.trim() : null;
}
