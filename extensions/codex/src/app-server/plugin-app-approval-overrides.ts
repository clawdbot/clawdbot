import type { ResolvedCodexPluginPolicy } from "./config.js";
import type { CodexPluginOwnedApp, CodexPluginRuntimeRequest } from "./plugin-inventory.js";
import { isJsonObject, type CodexConfigEdit, type JsonObject } from "./protocol.js";

export type CodexAppApprovalOverrideDiagnostic = {
  code: "approval_overrides_clear_failed";
  plugin?: ResolvedCodexPluginPolicy;
  message: string;
};

export async function clearPersistedAppApprovalOverrides(params: {
  request: CodexPluginRuntimeRequest;
  configCwd?: string;
  config: JsonObject;
  plugin?: ResolvedCodexPluginPolicy;
  app: CodexPluginOwnedApp;
  diagnostics: Pick<CodexAppApprovalOverrideDiagnostic[], "push">;
}): Promise<boolean> {
  try {
    const overrideKeyPaths = readPersistedAppApprovalOverrideKeyPaths(params.config, params.app);
    if (overrideKeyPaths.length === 0) {
      return true;
    }
    const edits = overrideKeyPaths.map(
      (keyPath): CodexConfigEdit => ({
        keyPath,
        value: null,
        mergeStrategy: "replace",
      }),
    );
    const response = await params.request("config/batchWrite", { edits });
    if (
      !isJsonObject(response) ||
      (response.status !== "ok" && response.status !== "okOverridden")
    ) {
      throw new Error("Codex did not confirm the approval override batch");
    }
    if (response.status === "okOverridden") {
      throw new Error(
        `approval override for ${overrideKeyPaths.join(", ")} is controlled by another config layer`,
      );
    }
    const confirmed = await params.request("config/read", {
      includeLayers: false,
      ...(params.configCwd ? { cwd: params.configCwd } : {}),
    });
    if (!isJsonObject(confirmed) || !isJsonObject(confirmed.config)) {
      throw new Error("Codex did not confirm effective app approval configuration");
    }
    const remainingOverrideKeyPaths = readPersistedAppApprovalOverrideKeyPaths(
      confirmed.config,
      params.app,
    );
    if (remainingOverrideKeyPaths.length > 0) {
      throw new Error(
        `effective approval overrides remain for ${remainingOverrideKeyPaths.join(", ")}`,
      );
    }
    return true;
  } catch (error) {
    params.diagnostics.push({
      code: "approval_overrides_clear_failed",
      ...(params.plugin ? { plugin: params.plugin } : {}),
      message: `Could not clear durable Codex app approval overrides for ${params.app.id}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    });
    return false;
  }
}

function readPersistedAppApprovalOverrideKeyPaths(
  config: JsonObject,
  app: CodexPluginOwnedApp,
): string[] {
  const appsRoot = config.apps;
  const appConfig = isJsonObject(appsRoot) ? appsRoot[app.id] : undefined;
  if (!isJsonObject(appConfig)) {
    return [];
  }
  const keys = app.approvalOverrideToolConfigKeys;
  const appKeyPath = `apps.${quoteConfigKeyPathSegment(app.id)}`;
  const overrideKeyPaths: string[] = [];
  // Native account-link policy takes precedence over the app defaults used by ask.
  for (const [section, fields] of [
    ["tools", ["approval_mode"]],
    ["links", ["approvals_reviewer", "default_tools_approval_mode"]],
  ] as const) {
    const entries = appConfig[section];
    if (!isJsonObject(entries)) {
      continue;
    }
    for (const [name, value] of Object.entries(entries)) {
      if (!isJsonObject(value) || (section === "tools" && keys && !keys.includes(name))) {
        continue;
      }
      for (const field of fields) {
        // Codex returns null for cleared optionals; those must not deny app admission.
        if (value[field] !== undefined && value[field] !== null) {
          overrideKeyPaths.push(
            `${appKeyPath}.${section}.${quoteConfigKeyPathSegment(name)}.${field}`,
          );
        }
      }
    }
  }
  return overrideKeyPaths.toSorted();
}

function quoteConfigKeyPathSegment(segment: string): string {
  return `"${segment.replace(/["\\]/g, (char) => `\\${char}`)}"`;
}
