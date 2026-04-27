import path from "node:path";
import { formatCliCommand } from "../cli/command-format.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveOpenClawPackageRootSync } from "../infra/openclaw-root.js";
import {
  createBundledRuntimeDepsWritableInstallSpecs,
  repairBundledRuntimeDepsInstallRoot,
  resolveBundledRuntimeDependencyPackageInstallRootPlan,
  scanBundledPluginRuntimeDeps,
  type BundledRuntimeDepsInstallParams,
} from "../plugins/bundled-runtime-deps.js";
import { resolveEffectivePluginIds } from "../plugins/effective-plugin-ids.js";
import type { RuntimeEnv } from "../runtime.js";
import { note } from "../terminal/note.js";
import type { DoctorPrompter } from "./doctor-prompter.js";

export async function maybeRepairBundledPluginRuntimeDeps(params: {
  runtime: RuntimeEnv;
  prompter: DoctorPrompter;
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  packageRoot?: string | null;
  includeConfiguredChannels?: boolean;
  installDeps?: (params: BundledRuntimeDepsInstallParams) => void;
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
  const bundledPluginsDir = path.join(packageRoot, "dist", "extensions");
  const effectivePluginIds = params.config
    ? resolveEffectivePluginIds({
        config: params.config,
        env: {
          ...env,
          OPENCLAW_BUNDLED_PLUGINS_DIR: bundledPluginsDir,
        },
      })
    : undefined;
  const { deps, missing, conflicts } = scanBundledPluginRuntimeDeps({
    packageRoot,
    config: params.config,
    pluginIds: effectivePluginIds,
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

  const missingSpecs = missing.map((dep) => `${dep.name}@${dep.version}`);
  const installRootPlan = resolveBundledRuntimeDependencyPackageInstallRootPlan(packageRoot, {
    env,
  });
  const installSpecs = createBundledRuntimeDepsWritableInstallSpecs({
    deps,
    searchRoots: installRootPlan.searchRoots,
    installRoot: installRootPlan.installRoot,
  });
  note(
    [
      "Bundled plugin runtime deps are missing.",
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

  try {
    const result = repairBundledRuntimeDepsInstallRoot({
      installRoot: installRootPlan.installRoot,
      missingSpecs,
      installSpecs,
      env: params.env ?? process.env,
      installDeps: params.installDeps,
      warn: (message) => params.runtime.log(message),
    });
    note(`Installed bundled plugin deps: ${result.installSpecs.join(", ")}`, "Bundled plugins");
  } catch (error) {
    params.runtime.error(`Failed to install bundled plugin runtime deps: ${String(error)}`);
    throw error instanceof Error ? error : new Error(String(error));
  }
}
