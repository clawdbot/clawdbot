// Owns plugin execution and the shipped local/npm hook-pack fallback.
import fs from "node:fs";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import type { PluginsInstallParams } from "../../packages/gateway-protocol/src/schema/plugins.js";
import { theme } from "../../packages/terminal-core/src/theme.js";
import {
  installHooksFromNpmSpec,
  installHooksFromPath,
  type InstallHooksResult,
} from "../hooks/install.js";
import { resolveArchiveKind } from "../infra/archive.js";
import { formatErrorMessage } from "../infra/errors.js";
import {
  requestDeferredPackageDirInstall,
  resolvePackageDirInstallTransaction,
} from "../infra/install-package-dir.js";
import { findBundledPluginSource } from "../plugins/bundled-sources.js";
import {
  loadConfigForInstall,
  PluginInstallConfigError,
  resolveFullyBlockedConfigMutationReason,
  type ConfigSnapshotForInstallExecution,
} from "../plugins/install-config.js";
import { resolvePluginInstallRequestContext } from "../plugins/install-request-context.js";
import type { InstallSafetyOverrides } from "../plugins/install-security-scan.js";
import { resolveBundledInstallPlanForNpmFailure } from "../plugins/install-source-plan.js";
import { PLUGIN_INSTALL_ERROR_CODE } from "../plugins/install.js";
import { ManagedPluginLifecycleError } from "../plugins/management-lifecycle-error.js";
import { installManagedPlugin } from "../plugins/management-mutations.js";
import { withPluginLifecycleLease } from "../plugins/plugin-lifecycle-lease.js";
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";
import { shortenHomePath } from "../utils.js";
import { persistHookPackInstall } from "./hook-install-persistence.js";
import { resolvePinnedNpmInstallRecordForCli } from "./npm-resolution.js";
import {
  createHookPackInstallLogger,
  formatPluginInstallWithHookFallbackError,
} from "./plugins-command-helpers.js";

type HookCompatibleSource = Extract<PluginsInstallParams, { source: "local" | "npm" }>;
type InstallParams = Parameters<typeof installManagedPlugin>[0] & {
  snapshot: ConfigSnapshotForInstallExecution;
  install?: typeof installManagedPlugin;
  allowBundledFallback?: boolean;
  runtime?: RuntimeEnv;
};
type InstallResult =
  | { ok: true }
  | {
      ok: false;
      error: string;
      code?: string;
      warning?: string;
      installSource?: ManagedPluginLifecycleError["installSource"];
    };

export function resolveInstallSafetyOverrides(
  overrides: InstallSafetyOverrides,
): InstallSafetyOverrides {
  return {
    config: overrides.config,
    dangerouslyForceUnsafeInstall: overrides.dangerouslyForceUnsafeInstall,
    onInstallPolicyWarning: overrides.onInstallPolicyWarning,
    trustedSourceLinkedOfficialInstall: overrides.trustedSourceLinkedOfficialInstall,
  };
}

async function attemptHookInstall(
  source: HookCompatibleSource,
  params: InstallParams,
  options?: {
    inspection?: "package-kind";
    expectedPackageKind?: "hook-only";
    beforePersistentApply?: () => void;
  },
  assertOwned?: () => void,
): Promise<InstallHooksResult> {
  const common = requestDeferredPackageDirInstall(
    {
      ...resolveInstallSafetyOverrides(params.safetyOverrides ?? {}),
      config: params.snapshot.config,
      mode: source.mode,
      logger: createHookPackInstallLogger(params.runtime),
      ...options,
    },
    assertOwned,
  );
  try {
    return source.source === "local"
      ? await installHooksFromPath({
          ...common,
          path: source.path,
          ...(source.link ? { dryRun: true } : {}),
        })
      : await installHooksFromNpmSpec({
          ...common,
          spec: source.spec,
          ...(source.expectedIntegrity ? { expectedIntegrity: source.expectedIntegrity } : {}),
        });
  } catch (error) {
    return { ok: false, error: formatErrorMessage(error) };
  }
}

async function installHookPack(
  source: HookCompatibleSource,
  params: InstallParams,
  expectedPackageKind?: "hook-only",
): Promise<InstallResult> {
  // Online plugin rejection can precede this fallback; acquire and reread only for the hook write.
  return await withPluginLifecycleLease({ signal: params.signal }, async (lease) => {
    const request = resolvePluginInstallRequestContext({
      rawSpec: source.source === "local" ? source.path : source.spec,
    });
    if (!request.ok) {
      return request;
    }
    const snapshot = await loadConfigForInstall(request.request).catch((error: unknown) => {
      if (
        expectedPackageKind === "hook-only" &&
        error instanceof PluginInstallConfigError &&
        error.blockedSnapshot
      ) {
        // A verified hook artifact uses the fresh hook preflight even when
        // its official package identity independently blocks plugin writes.
        return error.blockedSnapshot;
      }
      throw error;
    });
    if (snapshot.hookMutation.mode === "blocked") {
      return { ok: false, error: snapshot.hookMutation.reason };
    }
    const linked = source.source === "local" && source.link;
    if (linked && !fs.statSync(source.path).isDirectory()) {
      return { ok: false, error: "Linked hook pack paths must be directories." };
    }
    const beforePersistentApply = () => {
      params.signal?.throwIfAborted();
      lease.assertOwned();
      snapshot.writeOptions.assertConfigPathForWrite?.();
      params.beforePersistentApply?.();
    };
    const result = await attemptHookInstall(
      source,
      { ...params, snapshot },
      { expectedPackageKind, beforePersistentApply },
      lease.assertOwned.bind(lease),
    );
    if (!result.ok) {
      return result;
    }
    const runtime = params.runtime ?? defaultRuntime;
    const config = snapshot.config;
    const pinMessages: string[] = [];
    await persistHookPackInstall({
      snapshot: linked
        ? {
            ...snapshot,
            config: {
              ...config,
              hooks: {
                ...config.hooks,
                internal: {
                  ...config.hooks?.internal,
                  load: {
                    ...config.hooks?.internal?.load,
                    extraDirs: uniqueStrings([
                      ...(config.hooks?.internal?.load?.extraDirs ?? []),
                      source.path,
                    ]),
                  },
                },
              },
            },
          }
        : snapshot,
      hookPackId: result.hookPackId,
      hooks: result.hooks,
      install:
        source.source === "local"
          ? {
              source: resolveArchiveKind(source.path) ? "archive" : "path",
              sourcePath: source.path,
              installPath: linked ? source.path : result.targetDir,
              version: result.version,
            }
          : resolvePinnedNpmInstallRecordForCli(
              source.spec,
              Boolean(source.pin),
              result.targetDir,
              result.version,
              result.npmResolution,
              (message) => pinMessages.push(message),
              theme.warn,
            ),
      ...(linked
        ? { successMessage: `Linked hook pack path: ${shortenHomePath(source.path)}` }
        : {}),
      runtime,
      beforePersistentApply,
      payloadTransaction: resolvePackageDirInstallTransaction(result),
    });
    // Output failures must not strand a payload whose config has not committed.
    for (const message of pinMessages) {
      runtime.log(message);
    }
    return { ok: true };
  });
}

async function installInspectedHookPack(
  source: HookCompatibleSource,
  params: InstallParams,
): Promise<InstallResult | undefined> {
  const probe = await attemptHookInstall(source, params, { inspection: "package-kind" });
  if (!probe.ok || probe.packageKind !== "hook-only") {
    return undefined;
  }
  const pinned =
    source.source !== "local" && probe.npmResolution?.integrity
      ? { ...source, expectedIntegrity: probe.npmResolution.integrity }
      : source;
  return await installHookPack(pinned, params, "hook-only");
}

/** Every source uses the same plugin executor; hook fallback needs an eligible artifact. */
export async function installPluginWithHookFallback(params: InstallParams): Promise<InstallResult> {
  const { request, snapshot } = params;
  const compatible = request.source === "local" || request.source === "npm" ? request : undefined;
  const blocked = resolveFullyBlockedConfigMutationReason(snapshot);
  if (blocked) {
    return { ok: false, error: blocked };
  }
  if (compatible) {
    if (snapshot.pluginMutation.mode === "blocked" || snapshot.hookMutation.mode === "blocked") {
      const hook = await installInspectedHookPack(compatible, params);
      if (hook) {
        return hook;
      }
      if (snapshot.pluginMutation.mode === "blocked") {
        return { ok: false, error: snapshot.pluginMutation.reason };
      }
    }
  }
  const install = async (installRequest: PluginsInstallParams): Promise<InstallResult> => {
    try {
      const result = await (params.install ?? installManagedPlugin)({
        ...params,
        request: installRequest,
      });
      const runtime = params.runtime ?? defaultRuntime;
      for (const warning of result.warnings ?? []) {
        runtime.log(theme.warn(warning));
      }
      runtime.log(
        installRequest.source === "local" && installRequest.link
          ? `Linked plugin path: ${shortenHomePath(installRequest.path)}`
          : `Installed plugin: ${result.plugin.id}`,
      );
      runtime.log(
        result.application
          ? `Applied in Gateway generation ${result.application.generation}.`
          : "Saved for the next Gateway start.",
      );
      return { ok: true };
    } catch (error) {
      if (!(error instanceof ManagedPluginLifecycleError) || !error.installRejected) {
        throw error;
      }
      return {
        ok: false,
        error: error.message,
        code: error.code,
        warning: error.warning,
        installSource: error.installSource,
      };
    }
  };
  const result = await install(request);
  if (result.ok) {
    return result;
  }
  const selectedSource = result.installSource;
  // Only the install owner knows which declared artifact failed. A ClawHub
  // rejection must never probe an npm namesake or the catalog's display id.
  const hookSource: HookCompatibleSource | undefined =
    request.source === "official" &&
    (result.code === PLUGIN_INSTALL_ERROR_CODE.MISSING_OPENCLAW_EXTENSIONS ||
      result.code === PLUGIN_INSTALL_ERROR_CODE.CONFIG_MUTATION_BLOCKED) &&
    selectedSource?.source === "npm"
      ? {
          source: "npm",
          spec: selectedSource.spec,
          expectedIntegrity: selectedSource.expectedIntegrity,
          mode: request.mode,
          pin: request.pin,
        }
      : compatible;
  if (result.code === PLUGIN_INSTALL_ERROR_CODE.CONFIG_MUTATION_BLOCKED) {
    return (hookSource && (await installInspectedHookPack(hookSource, params))) ?? result;
  }
  if (
    !hookSource ||
    [
      PLUGIN_INSTALL_ERROR_CODE.SECURITY_SCAN_BLOCKED,
      PLUGIN_INSTALL_ERROR_CODE.SECURITY_SCAN_FAILED,
      PLUGIN_INSTALL_ERROR_CODE.RELEASE_COHORT_UNAVAILABLE,
      PLUGIN_INSTALL_ERROR_CODE.UNSUPPORTED_PLAIN_FILE_PLUGIN,
    ].some((code) => code === result.code)
  ) {
    return result;
  }
  if (request.source === "npm" && params.allowBundledFallback) {
    const fallback = resolveBundledInstallPlanForNpmFailure({
      rawSpec: request.spec,
      code: result.code,
      findBundledSource: (lookup) => findBundledPluginSource({ lookup }),
    });
    if (fallback) {
      (params.runtime ?? defaultRuntime).log(theme.warn(fallback.warning));
      return await install({ source: "bundled", pluginId: fallback.bundledSource.pluginId });
    }
  }
  const hook = await installHookPack(hookSource, params);
  return hook.ok
    ? hook
    : { ...result, error: formatPluginInstallWithHookFallbackError(result.error, hook) };
}
