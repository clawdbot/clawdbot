import { isJsonObject, type JsonObject } from "./protocol.js";

/** Applies host-selected values and any required login-shell restriction last. */
export function applyCodexManagedShellEnvironment(
  config: JsonObject,
  environment: Readonly<Record<string, string>> | undefined,
  disableLoginShell = false,
): JsonObject {
  if (!environment || Object.keys(environment).length === 0) {
    return disableLoginShell ? { ...config, allow_login_shell: false } : config;
  }
  const current = isJsonObject(config.shell_environment_policy)
    ? config.shell_environment_policy
    : {};
  const currentSet = isJsonObject(current.set) ? current.set : {};
  const names = Object.keys(environment).toSorted();
  const includeOnly = Array.isArray(current.include_only)
    ? current.include_only.filter((entry): entry is string => typeof entry === "string")
    : [];
  const filters = isJsonObject(current.filters) ? current.filters : undefined;
  const hasIncludeFilter = filters && Object.values(filters).includes("include");
  const managedConfig = {
    ...config,
    shell_environment_policy: {
      ...current,
      experimental_use_profile: false,
      set: { ...currentSet, ...environment },
      ...(filters
        ? hasIncludeFilter
          ? {
              filters: {
                ...filters,
                ...Object.fromEntries(names.map((name) => [name, "include"])),
              },
            }
          : {}
        : includeOnly.length > 0
          ? { include_only: [...new Set([...includeOnly, ...names])] }
          : {}),
    },
  };
  return disableLoginShell ? { ...managedConfig, allow_login_shell: false } : managedConfig;
}
