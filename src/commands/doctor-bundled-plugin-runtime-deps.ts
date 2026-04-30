import { formatCliCommand } from "../cli/command-format.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveOpenClawPackageRootSync } from "../infra/openclaw-root.js";
import {
  createBundledRuntimeDepsInstallSpecs,
  repairBundledRuntimeDepsInstallRootAsync,
  resolveBundledRuntimeDependencyPackageInstallRootPlan,
  scanBundledPluginRuntimeDeps,
  type BundledRuntimeDepsInstallParams,
} from "../plugins/bundled-runtime-deps.js";
import type { RuntimeEnv } from "../runtime.js";
import { note } from "../terminal/note.js";
import type { DoctorPrompter } from "./doctor-prompter.js";

const RUNTIME_DEPS_INSTALL_HEARTBEAT_MS = 15_000;

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

function logRuntimeDepsInstallProgress(runtime: RuntimeEnv, message: string): void {
  runtime.log(message);
}

export async function maybeRepairBundledPluginRuntimeDeps(params: {
  runtime: RuntimeEnv;
  prompter: DoctorPrompter;
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  packageRoot?: string | null;
  includeConfiguredChannels?: boolean;
  installDeps?: (params: BundledRuntimeDepsInstallParams) => void | Promise<void>;
}): Promise<void> {
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
  const { deps, missing, conflicts } = scanBundledPluginRuntimeDeps({
    packageRoot,
    config: params.config,
    includeConfiguredChannels: params.includeConfiguredChannels,
    env,
  });
  if (conflicts.length > 0) {
    const conflictLines = conflicts.flatMap((conflict) =>
      [`- ${conflict.name}: ${conflict.versions.join(", ")}`].concat(
        conflict.versions.flatMap((version) => {
          const pluginIds = conflict.pluginIdsByVersion.get(version) ?? [];
          return pluginIds.length > 0 ? [`  - ${version}: ${pluginIds.join(", ")}`] : [];
        }),
      ),
    );
    note(
      [
        "Bundled plugin runtime deps use conflicting versions.",
        ...conflictLines,
        `Update bundled plugins and rerun ${formatCliCommand("openclaw doctor")}.`,
      ].join("\n"),
      "Bundled plugins",
    );
  }

  if (missing.length === 0) {
    return;
  }

  const installRootPlan = resolveBundledRuntimeDependencyPackageInstallRootPlan(packageRoot, {
    env,
  });
  const installSpecs = createBundledRuntimeDepsInstallSpecs({
    deps,
  });
  note(
    [
      "Bundled plugin runtime deps need staging.",
      ...missing.map((dep) => `- ${dep.name}@${dep.version} (used by ${dep.pluginIds.join(", ")})`),
      `Fix: run ${formatCliCommand("openclaw doctor --fix")} to install them.`,
    ].join("\n"),
    "Bundled plugins",
  );

  const shouldRepair =
    params.prompter.shouldRepair ||
    params.prompter.repairMode.nonInteractive ||
    (await params.prompter.confirmAutoFix({
      message: "Install missing bundled plugin runtime deps now?",
      initialValue: true,
    }));
  if (!shouldRepair) {
    return;
  }

  let heartbeat: NodeJS.Timeout | undefined;
  let progress: { setLabel: (label: string) => void; done: () => void } | undefined;
  try {
    const { createCliProgress } = await import("../cli/progress.js");
    progress = createCliProgress({
      label: `Installing bundled plugin runtime deps (${installSpecs.length})`,
      indeterminate: true,
      enabled: process.env.VITEST !== "true" || process.env.OPENCLAW_TEST_RUNTIME_LOG === "1",
    });
    const installStartedAt = Date.now();
    logRuntimeDepsInstallProgress(
      params.runtime,
      `Installing bundled plugin runtime deps (${installSpecs.length} specs): ${installSpecs.join(", ")}`,
    );
    heartbeat = setInterval(() => {
      logRuntimeDepsInstallProgress(
        params.runtime,
        `Still installing bundled plugin runtime deps after ${formatElapsedMs(Date.now() - installStartedAt)}...`,
      );
    }, RUNTIME_DEPS_INSTALL_HEARTBEAT_MS);
    heartbeat.unref?.();
    const result = await repairBundledRuntimeDepsInstallRootAsync({
      installRoot: installRootPlan.installRoot,
      missingSpecs: installSpecs,
      installSpecs,
      env: params.env ?? process.env,
      installDeps: params.installDeps
        ? async (installParams) => {
            await params.installDeps?.(installParams);
          }
        : undefined,
      warn: (message) => logRuntimeDepsInstallProgress(params.runtime, message),
      onProgress: (message) => progress?.setLabel(message),
    });
    logRuntimeDepsInstallProgress(
      params.runtime,
      `Installed bundled plugin runtime deps in ${formatElapsedMs(Date.now() - installStartedAt)}: ${result.installSpecs.join(", ")}`,
    );
    note(`Installed bundled plugin deps: ${result.installSpecs.join(", ")}`, "Bundled plugins");
  } catch (error) {
    params.runtime.error(`Failed to install bundled plugin runtime deps: ${String(error)}`);
    throw error instanceof Error ? error : new Error(String(error));
  } finally {
    if (heartbeat) {
      clearInterval(heartbeat);
    }
    progress?.done();
  }
}
