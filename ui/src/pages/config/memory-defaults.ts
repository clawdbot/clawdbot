import { asNullableRecord as asConfigRecord } from "@openclaw/normalization-core/record-coerce";

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
