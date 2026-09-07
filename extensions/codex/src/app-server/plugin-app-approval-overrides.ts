import type { CodexPluginOwnedApp } from "./plugin-inventory.js";
import { isJsonObject, type JsonObject } from "./protocol.js";

/** Projects ask approvals into the native session layer without changing saved settings. */
export function buildCodexAppApprovalOverrides(
  config: Record<string, unknown>,
  app: Pick<CodexPluginOwnedApp, "id" | "approvalOverrideToolConfigKeys">,
): JsonObject {
  const appsRoot = config.apps;
  const appConfig = isJsonObject(appsRoot) ? appsRoot[app.id] : undefined;
  if (!isJsonObject(appConfig)) {
    return {};
  }
  const overrides: JsonObject = {};
  const keys = app.approvalOverrideToolConfigKeys;
  // Link and tool policy outrank app defaults. Session overlays survive native
  // user-config reloads; durable writes cannot acknowledge every loaded thread.
  for (const [section, fields] of [
    ["tools", { approval_mode: "auto" }],
    ["links", { approvals_reviewer: "user", default_tools_approval_mode: "auto" }],
  ] as const) {
    const entries = appConfig[section];
    if (!isJsonObject(entries)) {
      continue;
    }
    const projected: Array<[string, JsonObject]> = [];
    for (const [name, value] of Object.entries(entries).toSorted(([left], [right]) =>
      left.localeCompare(right),
    )) {
      if (!isJsonObject(value) || (section === "tools" && keys && !keys.includes(name))) {
        continue;
      }
      if (
        Object.keys(fields).some((field) => value[field] !== undefined && value[field] !== null)
      ) {
        // Merge only approval fields, preserving native disabled tools and other settings.
        projected.push([name, fields]);
      }
    }
    if (projected.length > 0) {
      overrides[section] = Object.fromEntries(projected);
    }
  }
  return overrides;
}
