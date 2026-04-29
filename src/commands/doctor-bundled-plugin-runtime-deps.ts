import fs from "node:fs";
import path from "node:path";
import { formatCliCommand } from "../cli/command-format.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveOpenClawPackageRootSync } from "../infra/openclaw-root.js";
import {
  createBundledRuntimeDepsWritableInstallSpecs,
  repairBundledRuntimeDepsInstallRootAsync,
  resolveBundledRuntimeDependencyPackageInstallRootPlan,
  scanBundledPluginRuntimeDeps,
  type BundledRuntimeDepsInstallParams,
} from "../plugins/bundled-runtime-deps.js";
import { normalizePluginsConfig } from "../plugins/config-state.js";
import { passesManifestOwnerBasePolicy } from "../plugins/manifest-owner-policy.js";
import type { RuntimeEnv } from "../runtime.js";
import { note } from "../terminal/note.js";
import type { DoctorPrompter } from "./doctor-prompter.js";

const RUNTIME_DEPS_INSTALL_HEARTBEAT_MS = 15_000;

function collectPackagedRuntimeDepsRepairPluginIds(params: {
  bundledPluginsDir: string;
  config: OpenClawConfig;
  includeConfiguredChannels?: boolean;
}): string[] {
  if (!fs.existsSync(params.bundledPluginsDir)) {
    return [];
  }
  const plugins = normalizePluginsConfig(params.config.plugins);
  const ids = new Set<string>();
  for (const entry of fs.readdirSync(params.bundledPluginsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const pluginDir = path.join(params.bundledPluginsDir, entry.name);
    let manifest: Record<string, unknown>;
    try {
      manifest = JSON.parse(
        fs.readFileSync(path.join(pluginDir, "openclaw.plugin.json"), "utf-8"),
      ) as Record<string, unknown>;
    } catch {
      continue;
    }
    const pluginId = typeof manifest.id === "string" && manifest.id ? manifest.id : entry.name;
    if (
      !passesManifestOwnerBasePolicy({
        plugin: { id: pluginId },
        normalizedConfig: plugins,
        allowRestrictiveAllowlistBypass: true,
      })
    ) {
      continue;
    }
    if (plugins.allow.includes(pluginId) || plugins.entries[pluginId]?.enabled === true) {
      ids.add(pluginId);
      continue;
    }
    const channels = Array.isArray(manifest.channels)
      ? manifest.channels.filter((channel): channel is string => typeof channel === "string")
      : [];
    if (
      channels.some((channelId) => {
        const channelConfig = (params.config.channels as Record<string, unknown> | undefined)?.[
          channelId
        ];
        if (!channelConfig || typeof channelConfig !== "object" || Array.isArray(channelConfig)) {
          return false;
        }
        if ((channelConfig as { enabled?: unknown }).enabled === false) {
          return false;
        }
        return (
          (channelConfig as { enabled?: unknown }).enabled === true ||
          params.includeConfiguredChannels === true
        );
      })
    ) {
      ids.add(pluginId);
      continue;
    }
    const providers = Array.isArray(manifest.providers)
      ? manifest.providers.filter((provider): provider is string => typeof provider === "string")
      : [];
    if (manifest.enabledByDefault === true && providers.length === 0 && channels.length === 0) {
      ids.add(pluginId);
    }
  }
  return [...ids].toSorted((left, right) => left.localeCompare(right));
}

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
  const bundledPluginsDir = path.join(packageRoot, "dist", "extensions");
  const effectivePluginIds = params.config
    ? collectPackagedRuntimeDepsRepairPluginIds({
        bundledPluginsDir,
        config: params.config,
        includeConfiguredChannels: params.includeConfiguredChannels,
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

  let heartbeat: NodeJS.Timeout | undefined;
  let progress: { setLabel: (label: string) => void; done: () => void } | undefined;
  try {
    const { createCliProgress } = await import("../cli/progress.js");
    progress = createCliProgress({
      label: `Installing bundled plugin runtime deps (${missingSpecs.length})`,
      indeterminate: true,
      enabled: process.env.VITEST !== "true" || process.env.OPENCLAW_TEST_RUNTIME_LOG === "1",
    });
    const installStartedAt = Date.now();
    logRuntimeDepsInstallProgress(
      params.runtime,
      `Installing bundled plugin runtime deps (${missingSpecs.length} missing, ${installSpecs.length} install specs): ${missingSpecs.join(", ")}`,
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
      missingSpecs,
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
