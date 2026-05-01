import { formatCliCommand } from "../cli/command-format.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { resolveOpenClawPackageRootSync } from "../infra/openclaw-root.js";
import type { BundledRuntimeDepsInstallParams } from "../plugins/bundled-runtime-deps-install.js";
import {
  createBundledRuntimeDepsPackagePlan,
  repairBundledRuntimeDepsPackagePlanAsync,
} from "../plugins/bundled-runtime-deps.js";
import type { RuntimeEnv } from "../runtime.js";

const POST_CONFIG_RUNTIME_DEPS_INSTALL_HEARTBEAT_MS = 15_000;

function formatElapsedMs(elapsedMs: number): string {
  if (elapsedMs < 1000) {
    return `${elapsedMs}ms`;
  }
  const seconds = Math.round(elapsedMs / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
}

function formatConflictSummary(
  conflicts: ReturnType<typeof createBundledRuntimeDepsPackagePlan>["conflicts"],
): string {
  return conflicts
    .flatMap((conflict) =>
      [`${conflict.name}: ${conflict.versions.join(", ")}`].concat(
        conflict.versions.flatMap((version) => {
          const pluginIds = conflict.pluginIdsByVersion.get(version) ?? [];
          return pluginIds.length > 0 ? [`${version}: ${pluginIds.join(", ")}`] : [];
        }),
      ),
    )
    .join("; ");
}

export async function preparePostConfigBundledRuntimeDeps(params: {
  config: OpenClawConfig;
  runtime: RuntimeEnv;
  env?: NodeJS.ProcessEnv;
  packageRoot?: string | null;
  installDeps?: (params: BundledRuntimeDepsInstallParams) => void | Promise<void>;
}): Promise<void> {
  if (params.config.gateway?.mode === "remote") {
    return;
  }

  const packageRoot =
    params.packageRoot ??
    resolveOpenClawPackageRootSync({
      argv1: process.argv[1],
      cwd: process.cwd(),
      moduleUrl: import.meta.url,
    });
  if (!packageRoot) {
    return;
  }

  const env = params.env ?? process.env;
  const plan = createBundledRuntimeDepsPackagePlan({
    packageRoot,
    config: params.config,
    includeConfiguredChannels: true,
    env,
  });
  if (plan.conflicts.length > 0) {
    const detail = formatConflictSummary(plan.conflicts);
    const message = [
      "Bundled plugin runtime deps use conflicting versions after config update.",
      detail,
      `Fix: run ${formatCliCommand("openclaw doctor --fix")} after updating bundled plugins.`,
    ]
      .filter(Boolean)
      .join(" ");
    params.runtime.error(message);
    throw new Error(message);
  }

  if (plan.missing.length === 0) {
    return;
  }

  let heartbeat: NodeJS.Timeout | undefined;
  const startedAt = Date.now();
  try {
    params.runtime.log(
      `Installing bundled plugin runtime deps (${plan.installSpecs.length} specs): ${plan.installSpecs.join(", ")}`,
    );
    heartbeat = setInterval(() => {
      params.runtime.log(
        `Still installing bundled plugin runtime deps after ${formatElapsedMs(Date.now() - startedAt)}...`,
      );
    }, POST_CONFIG_RUNTIME_DEPS_INSTALL_HEARTBEAT_MS);
    heartbeat.unref?.();

    const result = await repairBundledRuntimeDepsPackagePlanAsync({
      packageRoot,
      config: params.config,
      includeConfiguredChannels: true,
      env,
      ...(params.installDeps
        ? {
            installDeps: async (installParams: BundledRuntimeDepsInstallParams) => {
              await params.installDeps?.(installParams);
            },
          }
        : {}),
      warn: (message) => params.runtime.log(message),
      onProgress: (message) => params.runtime.log(message),
    });
    if (result.repairedSpecs.length > 0) {
      params.runtime.log(
        `Installed bundled plugin runtime deps in ${formatElapsedMs(Date.now() - startedAt)}: ${result.repairedSpecs.join(", ")}`,
      );
    }
  } catch (error) {
    const message = [
      `Failed to install bundled plugin runtime deps after config update: ${formatErrorMessage(error)}`,
      `Fix: run ${formatCliCommand("openclaw doctor --fix")} or ${formatCliCommand("openclaw plugins deps --repair")}.`,
    ].join(" ");
    params.runtime.error(message);
    throw error instanceof Error ? error : new Error(String(error));
  } finally {
    if (heartbeat) {
      clearInterval(heartbeat);
    }
  }
}
