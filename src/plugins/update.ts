import fs from "node:fs/promises";

import type { MoltbotConfig } from "../config/config.js";
import type { UpdateChannel } from "../infra/update-channels.js";
import { resolveUserPath } from "../utils.js";
import { discoverMoltbotPlugins } from "./discovery.js";
import { installPluginFromNpmSpec, resolvePluginInstallDir } from "./install.js";
import { recordPluginInstall } from "./installs.js";
import { loadPluginManifest } from "./manifest.js";

export type PluginUpdateLogger = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
};

export type PluginUpdateStatus = "updated" | "unchanged" | "skipped" | "error";

export type PluginUpdateOutcome = {
  pluginId: string;
  status: PluginUpdateStatus;
  message: string;
  currentVersion?: string;
  nextVersion?: string;
};

export type PluginUpdateSummary = {
  config: MoltbotConfig;
  changed: boolean;
  outcomes: PluginUpdateOutcome[];
};

export type PluginChannelSyncSummary = {
  switchedToBundled: string[];
  switchedToNpm: string[];
  warnings: string[];
  errors: string[];
};

export type PluginChannelSyncResult = {
  config: MoltbotConfig;
  changed: boolean;
  summary: PluginChannelSyncSummary;
};

type BundledPluginSource = {
  pluginId: string;
  localPath: string;
  npmSpec?: string;
};

async function readInstalledPackageVersion(dir: string): Promise<string | undefined> {
  try {
    const raw = await fs.readFile(`${dir}/package.json`, "utf-8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : undefined;
  } catch {
    return undefined;
  }
}

function resolveBundledPluginSources(params: {
  workspaceDir?: string;
}): Map<string, BundledPluginSource> {
  const discovery = discoverMoltbotPlugins({ workspaceDir: params.workspaceDir });
  const bundled = new Map<string, BundledPluginSource>();

  for (const candidate of discovery.candidates) {
    if (candidate.origin !== "bundled") continue;
    const manifest = loadPluginManifest(candidate.rootDir);
    if (!manifest.ok) continue;
    const pluginId = manifest.manifest.id;
    if (bundled.has(pluginId)) continue;

    const npmSpec =
      candidate.packageMoltbot?.install?.npmSpec?.trim() ||
      candidate.packageName?.trim() ||
      undefined;

    bundled.set(pluginId, {
      pluginId,
      localPath: candidate.rootDir,
      npmSpec,
    });
  }

  return bundled;
}

function pathsEqual(left?: string, right?: string): boolean {
  if (!left || !right) return false;
  return resolveUserPath(left) === resolveUserPath(right);
}

function buildLoadPathHelpers(existing: string[]) {
  let paths = [...existing];
  const resolveSet = () => new Set(paths.map((entry) => resolveUserPath(entry)));
  let resolved = resolveSet();
  let changed = false;

  const addPath = (value: string) => {
    const normalized = resolveUserPath(value);
    if (resolved.has(normalized)) return;
    paths.push(value);
    resolved.add(normalized);
    changed = true;
  };

  const removePath = (value: string) => {
    const normalized = resolveUserPath(value);
    if (!resolved.has(normalized)) return;
    paths = paths.filter((entry) => resolveUserPath(entry) !== normalized);
    resolved = resolveSet();
    changed = true;
  };

  return {
    addPath,
    removePath,
    get changed() {
      return changed;
    },
    get paths() {
      return paths;
    },
  };
}

export async function updateNpmInstalledPlugins(params: {
  config: MoltbotConfig;
  logger?: PluginUpdateLogger;
  pluginIds?: string[];
  skipIds?: Set<string>;
  dryRun?: boolean;
}): Promise<PluginUpdateSummary> {
  const logger = params.logger ?? {};
  const installs = params.config.plugins?.installs ?? {};
  const targets = params.pluginIds?.length ? params.pluginIds : Object.keys(installs);
  const outcomes: PluginUpdateOutcome[] = [];
  let next = params.config;
  let changed = false;

  for (const pluginId of targets) {
    if (params.skipIds?.has(pluginId)) {
      outcomes.push({
        pluginId,
        status: "skipped",
        message: `Skipping "${pluginId}" (already updated).`,
      });
      continue;
    }

    const record = installs[pluginId];
    if (!record) {
      outcomes.push({
        pluginId,
        status: "skipped",
        message: `No install record for "${pluginId}".`,
      });
      continue;
    }

    if (record.source !== "npm") {
      outcomes.push({
        pluginId,
        status: "skipped",
        message: `Skipping "${pluginId}" (source: ${record.source}).`,
      });
      continue;
    }

    if (!record.spec) {
      outcomes.push({
        pluginId,
        status: "skipped",
        message: `Skipping "${pluginId}" (missing npm spec).`,
      });
      continue;
    }

    const installPath = record.installPath ?? resolvePluginInstallDir(pluginId);
    const currentVersion = await readInstalledPackageVersion(installPath);

    if (params.dryRun) {
      let probe: Awaited<ReturnType<typeof installPluginFromNpmSpec>>;
      try {
        probe = await installPluginFromNpmSpec({
          spec: record.spec,
          mode: "update",
          dryRun: true,
          expectedPluginId: pluginId,
          logger,
        });
      } catch (err) {
        outcomes.push({
          pluginId,
          status: "error",
          message: `Failed to check ${pluginId}: ${String(err)}`,
        });
        continue;
      }
      if (!probe.ok) {
        outcomes.push({
          pluginId,
          status: "error",
          message: `Failed to check ${pluginId}: ${probe.error}`,
        });
        continue;
      }

      const nextVersion = probe.version ?? "unknown";
      const currentLabel = currentVersion ?? "unknown";
      if (currentVersion && probe.version && currentVersion === probe.version) {
        outcomes.push({
          pluginId,
          status: "unchanged",
          currentVersion: currentVersion ?? undefined,
          nextVersion: probe.version ?? undefined,
          message: `${pluginId} is up to date (${currentLabel}).`,
        });
      } else {
        outcomes.push({
          pluginId,
          status: "updated",
          currentVersion: currentVersion ?? undefined,
          nextVersion: probe.version ?? undefined,
          message: `Would update ${pluginId}: ${currentLabel} -> ${nextVersion}.`,
        });
      }
      continue;
    }

    let result: Awaited<ReturnType<typeof installPluginFromNpmSpec>>;
    try {
      result = await installPluginFromNpmSpec({
        spec: record.spec,
        mode: "update",
        expectedPluginId: pluginId,
        logger,
      });
    } catch (err) {
      outcomes.push({
        pluginId,
        status: "error",
        message: `Failed to update ${pluginId}: ${String(err)}`,
      });
      continue;
    }
    if (!result.ok) {
      outcomes.push({
        pluginId,
        status: "error",
        message: `Failed to update ${pluginId}: ${result.error}`,
      });
      continue;
    }

    const nextVersion = result.version ?? (await readInstalledPackageVersion(result.targetDir));
    next = recordPluginInstall(next, {
      pluginId,
      source: "npm",
      spec: record.spec,
      installPath: result.targetDir,
      version: nextVersion,
    });
    changed = true;

    const currentLabel = currentVersion ?? "unknown";
    const nextLabel = nextVersion ?? "unknown";
    if (currentVersion && nextVersion && currentVersion === nextVersion) {
      outcomes.push({
        pluginId,
        status: "unchanged",
        currentVersion: currentVersion ?? undefined,
        nextVersion: nextVersion ?? undefined,
        message: `${pluginId} already at ${currentLabel}.`,
      });
    } else {
      outcomes.push({
        pluginId,
        status: "updated",
        currentVersion: currentVersion ?? undefined,
        nextVersion: nextVersion ?? undefined,
        message: `Updated ${pluginId}: ${currentLabel} -> ${nextLabel}.`,
      });
    }
  }

  return { config: next, changed, outcomes };
}

export async function syncPluginsForUpdateChannel(params: {
  config: MoltbotConfig;
  channel: UpdateChannel;
  workspaceDir?: string;
  logger?: PluginUpdateLogger;
}): Promise<PluginChannelSyncResult> {
  const summary: PluginChannelSyncSummary = {
    switchedToBundled: [],
    switchedToNpm: [],
    warnings: [],
    errors: [],
  };
  const bundled = resolveBundledPluginSources({ workspaceDir: params.workspaceDir });
  if (bundled.size === 0) {
    return { config: params.config, changed: false, summary };
  }

  let next = params.config;
  const loadHelpers = buildLoadPathHelpers(next.plugins?.load?.paths ?? []);
  const installs = next.plugins?.installs ?? {};
  let changed = false;

  if (params.channel === "dev") {
    for (const [pluginId, record] of Object.entries(installs)) {
      const bundledInfo = bundled.get(pluginId);
      if (!bundledInfo) continue;

      loadHelpers.addPath(bundledInfo.localPath);

      const alreadyBundled =
        record.source === "path" && pathsEqual(record.sourcePath, bundledInfo.localPath);
      if (alreadyBundled) continue;

      next = recordPluginInstall(next, {
        pluginId,
        source: "path",
        sourcePath: bundledInfo.localPath,
        installPath: bundledInfo.localPath,
        spec: record.spec ?? bundledInfo.npmSpec,
        version: record.version,
      });
      summary.switchedToBundled.push(pluginId);
      changed = true;
    }
  } else {
    for (const [pluginId, record] of Object.entries(installs)) {
      const bundledInfo = bundled.get(pluginId);
      if (!bundledInfo) continue;

      if (record.source === "npm") {
        loadHelpers.removePath(bundledInfo.localPath);
        continue;
      }

      if (record.source !== "path") continue;
      if (!pathsEqual(record.sourcePath, bundledInfo.localPath)) continue;

      const spec = record.spec ?? bundledInfo.npmSpec;
      if (!spec) {
        summary.warnings.push(`Missing npm spec for ${pluginId}; keeping local path.`);
        continue;
      }

      let result: Awaited<ReturnType<typeof installPluginFromNpmSpec>>;
      try {
        result = await installPluginFromNpmSpec({
          spec,
          mode: "update",
          expectedPluginId: pluginId,
          logger: params.logger,
        });
      } catch (err) {
        summary.errors.push(`Failed to install ${pluginId}: ${String(err)}`);
        continue;
      }
      if (!result.ok) {
        summary.errors.push(`Failed to install ${pluginId}: ${result.error}`);
        continue;
      }

      next = recordPluginInstall(next, {
        pluginId,
        source: "npm",
        spec,
        installPath: result.targetDir,
        version: result.version,
        sourcePath: undefined,
      });
      summary.switchedToNpm.push(pluginId);
      changed = true;
      loadHelpers.removePath(bundledInfo.localPath);
    }
  }

  if (loadHelpers.changed) {
    next = {
      ...next,
      plugins: {
        ...next.plugins,
        load: {
          ...next.plugins?.load,
          paths: loadHelpers.paths,
        },
      },
    };
    changed = true;
  }

  return { config: next, changed, summary };
}
