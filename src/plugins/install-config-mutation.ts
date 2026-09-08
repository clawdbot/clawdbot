// Config admission shared by plugin policy changes and source installs.
import fs from "node:fs";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  hashConfigIncludeRaw,
  readConfigIncludeFileWithGuards,
  resolveConfigIncludeWritePath,
} from "../config/includes.js";
import type { ConfigWriteOptions } from "../config/io.js";
import { containsConfigIncludeDirective } from "../config/io.read-helpers.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { parseJsonWithJson5Fallback } from "../utils/parse-json-compat.js";

export type ConfigSnapshotForInstallPersist = {
  config: OpenClawConfig;
  baseHash: string | undefined;
  writeOptions: Pick<
    ConfigWriteOptions,
    | "inputBase"
    | "auditOrigin"
    | "assertConfigPathForWrite"
    | "expectedConfigPath"
    | "ownedConfigPathForWrite"
    | "envSnapshotForRestore"
    | "includeFileHashesForWrite"
    | "includeFileTargetsForWrite"
  >;
};

type ConfigMutationSection = "hooks" | "plugins";

export type ConfigMutationPreflight =
  | { mode: "allowed" }
  | { mode: "blocked"; scope: "config" | ConfigMutationSection; reason: string };

const CONFIG_MUTATION_ALLOWED = { mode: "allowed" } as const;

export function supportsInstallConfigSingleTopLevelIncludeShape(authoredSection: unknown): boolean {
  if (!containsConfigIncludeDirective(authoredSection)) {
    return true;
  }
  return (
    isRecord(authoredSection) &&
    Object.keys(authoredSection).length === 1 &&
    typeof authoredSection.$include === "string"
  );
}

function resolveSingleTopLevelIncludePath(
  parsed: Record<string, unknown>,
  configPath: string,
  section: ConfigMutationSection,
): string | null {
  const authoredSection = parsed[section];
  if (
    !isRecord(authoredSection) ||
    Object.keys(authoredSection).length !== 1 ||
    typeof authoredSection.$include !== "string"
  ) {
    return null;
  }
  return path.normalize(
    path.isAbsolute(authoredSection.$include)
      ? authoredSection.$include
      : path.resolve(path.dirname(configPath), authoredSection.$include),
  );
}

function resolveConfigMutationPreflight(params: {
  parsed: Record<string, unknown>;
  section: ConfigMutationSection;
  snapshotPath: string;
  writeOptions: ConfigSnapshotForInstallPersist["writeOptions"];
}): ConfigMutationPreflight {
  if (Object.hasOwn(params.parsed, "$include")) {
    return {
      mode: "blocked",
      scope: "config",
      reason: `Config ${params.section} are stored through an unsupported $include shape at the root; edit the included file directly or move ${params.section} into the root config before installing.`,
    };
  }
  if (!supportsInstallConfigSingleTopLevelIncludeShape(params.parsed[params.section])) {
    return {
      mode: "blocked",
      scope: params.section,
      reason: `Config ${params.section} are stored through an unsupported $include shape; edit the included file directly or move ${params.section} to a single-file top-level include before installing.`,
    };
  }
  const includePath = resolveSingleTopLevelIncludePath(
    params.parsed,
    params.snapshotPath,
    params.section,
  );
  if (!includePath) {
    return CONFIG_MUTATION_ALLOWED;
  }
  const expectedTarget = params.writeOptions.includeFileTargetsForWrite?.[includePath];
  let resolvedTarget: string | null = null;
  try {
    resolvedTarget = resolveConfigIncludeWritePath({
      configPath: params.snapshotPath,
      includePath,
      allowedRoots: [],
    });
  } catch {
    // The persistence path rejects includes that are no longer root-bound too.
  }
  if (
    expectedTarget &&
    resolvedTarget &&
    path.normalize(expectedTarget) === path.normalize(resolvedTarget)
  ) {
    const expectedHash = params.writeOptions.includeFileHashesForWrite?.[includePath];
    try {
      const raw = readConfigIncludeFileWithGuards({
        includePath,
        resolvedPath: resolvedTarget,
        rootRealDir: fs.realpathSync(path.dirname(params.snapshotPath)),
      });
      if (expectedHash !== hashConfigIncludeRaw(raw)) {
        return {
          mode: "blocked",
          scope: params.section,
          reason: `Config ${params.section} include changed since the config was read; rerun the install after reloading the config.`,
        };
      }
      if (containsConfigIncludeDirective(parseJsonWithJson5Fallback(raw))) {
        return {
          mode: "blocked",
          scope: params.section,
          reason: `Config ${params.section} are stored through a nested $include; edit the included file directly or remove the nested $include before installing.`,
        };
      }
      return CONFIG_MUTATION_ALLOWED;
    } catch {
      return {
        mode: "blocked",
        scope: params.section,
        reason: `Config ${params.section} include could not be inspected at its snapshot target; rerun the install after repairing or reloading the config.`,
      };
    }
  }
  return {
    mode: "blocked",
    scope: params.section,
    reason: `Config ${params.section} are stored in an external or unresolved top-level $include; edit the included file directly or move it under the config directory before installing.`,
  };
}

export function resolveInstallConfigMutationPreflights(params: {
  parsed: Record<string, unknown>;
  snapshotPath: string;
  writeOptions: ConfigSnapshotForInstallPersist["writeOptions"];
}): {
  hookMutation: ConfigMutationPreflight;
  pluginMutation: ConfigMutationPreflight;
} {
  const pluginMutation = resolveConfigMutationPreflight({
    ...params,
    section: "plugins",
  });
  const hookMutation = resolveConfigMutationPreflight({
    ...params,
    section: "hooks",
  });
  const pluginIncludePath = resolveSingleTopLevelIncludePath(
    params.parsed,
    params.snapshotPath,
    "plugins",
  );
  const hookIncludePath = resolveSingleTopLevelIncludePath(
    params.parsed,
    params.snapshotPath,
    "hooks",
  );
  const pluginTarget = pluginIncludePath
    ? params.writeOptions.includeFileTargetsForWrite?.[pluginIncludePath]
    : undefined;
  const hookTarget = hookIncludePath
    ? params.writeOptions.includeFileTargetsForWrite?.[hookIncludePath]
    : undefined;
  if (pluginTarget && hookTarget && path.normalize(pluginTarget) === path.normalize(hookTarget)) {
    const blocked = {
      mode: "blocked",
      scope: "config",
      reason:
        "Config plugins and hooks share the same top-level $include target; split them into separate include files before installing.",
    } as const;
    return { hookMutation: blocked, pluginMutation: blocked };
  }
  return { hookMutation, pluginMutation };
}

export function resolveCombinedPluginAndHookConfigMutationPreflight(params: {
  parsed: Record<string, unknown>;
  snapshotPath: string;
}): ConfigMutationPreflight {
  const pluginIncludePath = resolveSingleTopLevelIncludePath(
    params.parsed,
    params.snapshotPath,
    "plugins",
  );
  const hookIncludePath = resolveSingleTopLevelIncludePath(
    params.parsed,
    params.snapshotPath,
    "hooks",
  );
  if (!pluginIncludePath && !hookIncludePath) {
    return CONFIG_MUTATION_ALLOWED;
  }
  return {
    mode: "blocked",
    scope: "config",
    reason:
      "Config plugins and hooks cannot be updated together while either section uses a top-level $include; update them separately.",
  };
}

export function selectInstallMutationWriteOptions(
  writeOptions: ConfigWriteOptions,
): ConfigSnapshotForInstallPersist["writeOptions"] {
  // Install work may outlive its config read. Keep only mutation-start ownership
  // and conflict facts; plugin metadata must come from the commit-time read.
  return {
    inputBase: "source",
    auditOrigin: "plugin-install",
    assertConfigPathForWrite: writeOptions.assertConfigPathForWrite,
    expectedConfigPath: writeOptions.expectedConfigPath,
    ownedConfigPathForWrite: writeOptions.ownedConfigPathForWrite,
    envSnapshotForRestore: writeOptions.envSnapshotForRestore,
    includeFileHashesForWrite: writeOptions.includeFileHashesForWrite,
    includeFileTargetsForWrite: writeOptions.includeFileTargetsForWrite,
  };
}
