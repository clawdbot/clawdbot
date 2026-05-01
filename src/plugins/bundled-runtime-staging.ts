import type { OpenClawConfig } from "../config/types.openclaw.js";
import { measureDiagnosticsTimelineSpanSync } from "../infra/diagnostics-timeline.js";
import {
  installBundledRuntimeDeps,
  type BundledRuntimeDepsInstallParams,
} from "./bundled-runtime-deps-install.js";
import { registerBundledRuntimeDependencyJitiAliases } from "./bundled-runtime-deps-jiti-aliases.js";
import {
  prepareBundledPluginRuntimeLoadRoot,
  type PreparedBundledPluginRuntimeLoadRoot,
} from "./bundled-runtime-root.js";
import type { PluginLogger } from "./types.js";

export function prepareBundledRuntimeLoadRootForPlugin(params: {
  pluginId: string;
  pluginRoot: string;
  modulePath: string;
  setupModulePath?: string;
  env: NodeJS.ProcessEnv;
  config: OpenClawConfig;
  installMissingDeps: boolean;
  previousRepairError?: unknown;
  shouldLog: boolean;
  logger: PluginLogger;
  installer?: (params: BundledRuntimeDepsInstallParams) => void;
}): PreparedBundledPluginRuntimeLoadRoot {
  let installStartedAt: number | null = null;
  let installSpecs: string[] = [];
  try {
    return prepareBundledPluginRuntimeLoadRoot({
      pluginId: params.pluginId,
      pluginRoot: params.pluginRoot,
      modulePath: params.modulePath,
      ...(params.setupModulePath ? { setupModulePath: params.setupModulePath } : {}),
      env: params.env,
      config: params.config,
      installMissingDeps: params.installMissingDeps,
      previousRepairError: params.previousRepairError,
      memoizePreparedRoot: true,
      registerRuntimeAliasRoot: registerBundledRuntimeDependencyJitiAliases,
      installDeps: (installParams) => {
        installSpecs = installParams.installSpecs ?? installParams.missingSpecs;
        installStartedAt = Date.now();
        if (params.shouldLog) {
          params.logger.info(
            `[plugins] ${params.pluginId} staging bundled runtime deps (${installSpecs.length} specs): ${installSpecs.join(", ")}`,
          );
        }
        const installer =
          params.installer ??
          ((runtimeDepsInstallParams: BundledRuntimeDepsInstallParams) =>
            installBundledRuntimeDeps({
              installRoot: runtimeDepsInstallParams.installRoot,
              ...(runtimeDepsInstallParams.installExecutionRoot
                ? { installExecutionRoot: runtimeDepsInstallParams.installExecutionRoot }
                : {}),
              missingSpecs:
                runtimeDepsInstallParams.installSpecs ?? runtimeDepsInstallParams.missingSpecs,
              installSpecs: runtimeDepsInstallParams.installSpecs,
              env: params.env,
              force: true,
              warn: (message) => params.logger.warn(`[plugins] ${params.pluginId}: ${message}`),
            }));
        measureDiagnosticsTimelineSpanSync("runtimeDeps.stage", () => installer(installParams), {
          phase: "startup",
          config: params.config,
          env: params.env,
          attributes: {
            pluginId: params.pluginId,
            dependencyCount: installSpecs.length,
          },
        });
      },
      logInstalled: (installedSpecs) => {
        if (!params.shouldLog) {
          return;
        }
        const elapsed = installStartedAt === null ? "" : ` in ${Date.now() - installStartedAt}ms`;
        params.logger.info(
          `[plugins] ${params.pluginId} installed bundled runtime deps${elapsed}: ${installedSpecs.join(", ")}`,
        );
      },
    });
  } catch (error) {
    if (params.shouldLog && installStartedAt !== null) {
      params.logger.error(
        `[plugins] ${params.pluginId} failed to stage bundled runtime deps after ${Date.now() - installStartedAt}ms: ${installSpecs.join(", ")}`,
      );
    }
    throw error;
  }
}
