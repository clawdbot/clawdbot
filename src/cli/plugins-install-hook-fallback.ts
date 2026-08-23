// Owns hook-pack probing and plugin-to-hook fallback during plugin installation.
import fs from "node:fs";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { theme } from "../../packages/terminal-core/src/theme.js";
import {
  installHooksFromNpmSpec,
  installHooksFromPath,
  type InstallHooksResult,
} from "../hooks/install.js";
import { resolveArchiveKind } from "../infra/archive.js";
import { formatErrorMessage } from "../infra/errors.js";
import { findBundledPluginSource } from "../plugins/bundled-sources.js";
import type { InstallSafetyOverrides } from "../plugins/install-security-scan.js";
import { PLUGIN_INSTALL_ERROR_CODE } from "../plugins/install.js";
import { installManagedPluginSource } from "../plugins/management-service.js";
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";
import { shortenHomePath } from "../utils.js";
import { persistHookPackInstall } from "./hook-install-persistence.js";
import { resolvePinnedNpmInstallRecordForCli } from "./npm-resolution.js";
import { resolveBundledInstallPlanForNpmFailure } from "./plugin-install-plan.js";
import {
  createHookPackInstallLogger,
  createPluginInstallLogger,
  formatPluginInstallWithHookFallbackError,
} from "./plugins-command-helpers.js";
import {
  resolveFullyBlockedConfigMutationReason,
  type ConfigSnapshotForInstallExecution,
} from "./plugins-install-config.js";

export function resolveInstallSafetyOverrides(
  overrides: InstallSafetyOverrides,
): InstallSafetyOverrides {
  return {
    config: overrides.config,
    dangerouslyForceUnsafeInstall: overrides.dangerouslyForceUnsafeInstall,
    trustedSourceLinkedOfficialInstall: overrides.trustedSourceLinkedOfficialInstall,
  };
}

async function probeHookPackFromNpmSpec(
  params: Parameters<typeof installHooksFromNpmSpec>[0],
): Promise<InstallHooksResult> {
  try {
    return await installHooksFromNpmSpec(params);
  } catch (error) {
    return { ok: false, error: formatErrorMessage(error) };
  }
}

export async function probeHookPackFromPath(
  params: Parameters<typeof installHooksFromPath>[0],
): Promise<InstallHooksResult> {
  try {
    return await installHooksFromPath(params);
  } catch (error) {
    return { ok: false, error: formatErrorMessage(error) };
  }
}

export function isTerminalPluginInstallFailure(code?: string): boolean {
  return (
    code === PLUGIN_INSTALL_ERROR_CODE.SECURITY_SCAN_BLOCKED ||
    code === PLUGIN_INSTALL_ERROR_CODE.SECURITY_SCAN_FAILED ||
    code === PLUGIN_INSTALL_ERROR_CODE.UNSUPPORTED_PLAIN_FILE_PLUGIN
  );
}

export async function tryInstallHookPackFromLocalPath(params: {
  snapshot: ConfigSnapshotForInstallExecution;
  resolvedPath: string;
  installMode: "install" | "update";
  safetyOverrides?: InstallSafetyOverrides;
  link?: boolean;
  expectedPackageKind?: "hook-only";
  runtime?: RuntimeEnv;
}): Promise<{ ok: true } | Extract<InstallHooksResult, { ok: false }>> {
  if (params.snapshot.hookMutation.mode === "blocked") {
    return { ok: false, error: params.snapshot.hookMutation.reason };
  }
  if (params.link) {
    const stat = fs.statSync(params.resolvedPath);
    if (!stat.isDirectory()) {
      return { ok: false, error: "Linked hook pack paths must be directories." };
    }

    const probe = await installHooksFromPath({
      ...resolveInstallSafetyOverrides(params.safetyOverrides ?? {}),
      path: params.resolvedPath,
      dryRun: true,
      ...(params.expectedPackageKind ? { expectedPackageKind: params.expectedPackageKind } : {}),
    });
    if (!probe.ok) {
      return probe;
    }

    const existing = params.snapshot.config.hooks?.internal?.load?.extraDirs ?? [];
    const merged = uniqueStrings([...existing, params.resolvedPath]);
    await persistHookPackInstall({
      snapshot: {
        ...params.snapshot,
        config: {
          ...params.snapshot.config,
          hooks: {
            ...params.snapshot.config.hooks,
            internal: {
              ...params.snapshot.config.hooks?.internal,
              enabled: true,
              load: {
                ...params.snapshot.config.hooks?.internal?.load,
                extraDirs: merged,
              },
            },
          },
        },
      },
      hookPackId: probe.hookPackId,
      hooks: probe.hooks,
      install: {
        source: "path",
        sourcePath: params.resolvedPath,
        installPath: params.resolvedPath,
        version: probe.version,
      },
      successMessage: `Linked hook pack path: ${shortenHomePath(params.resolvedPath)}`,
      runtime: params.runtime,
    });
    return { ok: true };
  }

  const result = await installHooksFromPath({
    ...resolveInstallSafetyOverrides(params.safetyOverrides ?? {}),
    path: params.resolvedPath,
    mode: params.installMode,
    ...(params.expectedPackageKind ? { expectedPackageKind: params.expectedPackageKind } : {}),
    logger: createHookPackInstallLogger(params.runtime),
  });
  if (!result.ok) {
    return result;
  }

  const source: "archive" | "path" = resolveArchiveKind(params.resolvedPath) ? "archive" : "path";
  await persistHookPackInstall({
    snapshot: params.snapshot,
    hookPackId: result.hookPackId,
    hooks: result.hooks,
    install: {
      source,
      sourcePath: params.resolvedPath,
      installPath: result.targetDir,
      version: result.version,
    },
    runtime: params.runtime,
  });
  return { ok: true };
}

async function tryInstallHookPackFromNpmSpec(params: {
  snapshot: ConfigSnapshotForInstallExecution;
  installMode: "install" | "update";
  spec: string;
  pin?: boolean;
  expectedIntegrity?: string;
  expectedPackageKind?: "hook-only";
  runtime?: RuntimeEnv;
}): Promise<{ ok: true } | Extract<InstallHooksResult, { ok: false }>> {
  if (params.snapshot.hookMutation.mode === "blocked") {
    return { ok: false, error: params.snapshot.hookMutation.reason };
  }
  const result = await installHooksFromNpmSpec({
    config: params.snapshot.config,
    spec: params.spec,
    mode: params.installMode,
    ...(params.expectedIntegrity ? { expectedIntegrity: params.expectedIntegrity } : {}),
    ...(params.expectedPackageKind ? { expectedPackageKind: params.expectedPackageKind } : {}),
    logger: createHookPackInstallLogger(params.runtime),
  });
  if (!result.ok) {
    return result;
  }

  const installRecord = resolvePinnedNpmInstallRecordForCli(
    params.spec,
    Boolean(params.pin),
    result.targetDir,
    result.version,
    result.npmResolution,
    params.runtime?.log ?? defaultRuntime.log,
    theme.warn,
  );
  await persistHookPackInstall({
    snapshot: params.snapshot,
    hookPackId: result.hookPackId,
    hooks: result.hooks,
    install: installRecord,
    runtime: params.runtime,
  });
  return { ok: true };
}

/** Preserve npm plugin and hook ownership without executing a blocked mutation. */
export async function tryInstallPluginOrHookPackFromNpmSpec(params: {
  snapshot: ConfigSnapshotForInstallExecution;
  installMode: "install" | "update";
  spec: string;
  pin?: boolean;
  safetyOverrides: InstallSafetyOverrides;
  allowBundledFallback: boolean;
  expectedPluginId?: string;
  expectedIntegrity?: string;
  trustedSourceLinkedOfficialInstall?: boolean;
  official?: boolean;
  invalidateRuntimeCache?: boolean;
  runtime?: RuntimeEnv;
}): Promise<{ ok: true } | { ok: false }> {
  const runtime = params.runtime ?? defaultRuntime;
  const fullyBlockedReason = resolveFullyBlockedConfigMutationReason(params.snapshot);
  if (fullyBlockedReason) {
    runtime.error(fullyBlockedReason);
    return { ok: false };
  }
  if (
    params.snapshot.pluginMutation.mode === "blocked" ||
    params.snapshot.hookMutation.mode === "blocked"
  ) {
    const hookProbe = await probeHookPackFromNpmSpec({
      config: params.snapshot.config,
      spec: params.spec,
      mode: params.installMode,
      inspection: "package-kind",
      ...(params.expectedIntegrity ? { expectedIntegrity: params.expectedIntegrity } : {}),
      logger: createHookPackInstallLogger(params.runtime),
    });
    if (hookProbe.ok && hookProbe.packageKind === "hook-only") {
      if (params.snapshot.hookMutation.mode === "blocked") {
        runtime.error(params.snapshot.hookMutation.reason);
        return { ok: false };
      }
      const hookFallback = await tryInstallHookPackFromNpmSpec({
        snapshot: params.snapshot,
        installMode: params.installMode,
        spec: params.spec,
        pin: params.pin,
        expectedIntegrity: hookProbe.npmResolution?.integrity ?? params.expectedIntegrity,
        expectedPackageKind: "hook-only",
        runtime: params.runtime,
      });
      if (hookFallback.ok) {
        return { ok: true };
      }
      runtime.error(hookFallback.error);
      return { ok: false };
    }
    if (params.snapshot.pluginMutation.mode === "blocked") {
      runtime.error(params.snapshot.pluginMutation.reason);
      return { ok: false };
    }
  }

  const result = await installManagedPluginSource({
    request: params.official
      ? {
          source: "official",
          spec: params.spec,
          pluginId: params.expectedPluginId ?? params.spec,
          mode: params.installMode,
          pin: params.pin,
          ...(params.expectedIntegrity ? { expectedIntegrity: params.expectedIntegrity } : {}),
        }
      : {
          source: "npm",
          spec: params.spec,
          mode: params.installMode,
          pin: params.pin,
          ...(params.expectedPluginId ? { expectedPluginId: params.expectedPluginId } : {}),
          ...(params.expectedIntegrity ? { expectedIntegrity: params.expectedIntegrity } : {}),
          ...(params.trustedSourceLinkedOfficialInstall
            ? { trustedSourceLinkedOfficialInstall: true }
            : {}),
        },
    snapshot: params.snapshot,
    safetyOverrides: params.safetyOverrides,
    logger: createPluginInstallLogger(params.runtime),
    invalidateRuntimeCache: params.invalidateRuntimeCache,
    runtime: params.runtime,
  });
  if (!result.ok) {
    if (isTerminalPluginInstallFailure(result.code)) {
      runtime.error(result.error);
      return { ok: false };
    }
    if (params.allowBundledFallback) {
      const bundledFallbackPlan = resolveBundledInstallPlanForNpmFailure({
        rawSpec: params.spec,
        code: result.code,
        findBundledSource: (lookup) => findBundledPluginSource({ lookup }),
      });
      if (bundledFallbackPlan) {
        const bundledResult = await installManagedPluginSource({
          request: {
            source: "bundled",
            rawSpec: params.spec,
            bundledSource: bundledFallbackPlan.bundledSource,
            warning: bundledFallbackPlan.warning,
          },
          snapshot: params.snapshot,
          invalidateRuntimeCache: params.invalidateRuntimeCache,
          runtime: params.runtime,
        });
        if (!bundledResult.ok) {
          runtime.error(bundledResult.error);
          return { ok: false };
        }
        return { ok: true };
      }
    }
    const hookFallback = await tryInstallHookPackFromNpmSpec({
      snapshot: params.snapshot,
      installMode: params.installMode,
      spec: params.spec,
      pin: params.pin,
      expectedIntegrity: params.expectedIntegrity,
      runtime: params.runtime,
    });
    if (hookFallback.ok) {
      return { ok: true };
    }
    runtime.error(formatPluginInstallWithHookFallbackError(result.error, hookFallback));
    return { ok: false };
  }

  if (params.pin) {
    const resolvedSpec = result.npmResolution?.resolvedSpec;
    runtime.log(
      resolvedSpec
        ? `Pinned npm install record to ${resolvedSpec}.`
        : theme.warn("Could not resolve exact npm version for --pin; storing original npm spec."),
    );
  }
  return { ok: true };
}
