import path from "node:path";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveOpenClawPackageRootSync } from "../infra/openclaw-root.js";
import { pruneUnknownBundledRuntimeDepsRoots } from "../plugins/bundled-runtime-deps-roots.js";
import {
  createBundledRuntimeDepsPackagePlan,
  repairBundledRuntimeDepsPackagePlanAsync,
  type BundledRuntimeDepsPackagePlan,
} from "../plugins/bundled-runtime-deps.js";
import { defaultRuntime } from "../runtime.js";
import { getTerminalTableWidth, renderTable } from "../terminal/table.js";
import { theme } from "../terminal/theme.js";
import { shortenHomePath } from "../utils.js";

export type PluginsDepsOptions = {
  json?: boolean;
  packageRoot?: string;
  prune?: boolean;
  repair?: boolean;
};

function resolvePackageRoot(rawPackageRoot: string | undefined): string | null {
  if (rawPackageRoot?.trim()) {
    return path.resolve(rawPackageRoot.trim());
  }
  return resolveOpenClawPackageRootSync({
    argv1: process.argv[1],
    cwd: process.cwd(),
    moduleUrl: import.meta.url,
  });
}

function formatRuntimeDepOwners(pluginIds: readonly string[]): string {
  return pluginIds.length > 0 ? pluginIds.join(", ") : "-";
}

function formatRuntimeDepConflicts(conflicts: BundledRuntimeDepsPackagePlan["conflicts"]) {
  return conflicts.map((conflict) => ({
    name: conflict.name,
    versions: conflict.versions,
    pluginIdsByVersion: Object.fromEntries(conflict.pluginIdsByVersion),
  }));
}

function createWarningSink(params: { json?: boolean; warnings: string[] }) {
  return (message: string) => {
    params.warnings.push(message);
    if (!params.json) {
      defaultRuntime.log(theme.warn(message));
    }
  };
}

export async function runPluginsDepsCommand(params: {
  config: OpenClawConfig;
  options: PluginsDepsOptions;
}): Promise<void> {
  const packageRoot = resolvePackageRoot(params.options.packageRoot);
  if (!packageRoot) {
    const message = "Could not resolve the OpenClaw package root for bundled plugin deps.";
    if (params.options.json) {
      defaultRuntime.writeJson({ ok: false, error: message });
      return;
    }
    defaultRuntime.error(message);
    return defaultRuntime.exit(1);
  }

  const warnings: string[] = [];
  const warn = createWarningSink({ json: params.options.json, warnings });
  const pruned = params.options.prune
    ? pruneUnknownBundledRuntimeDepsRoots({
        env: process.env,
        warn,
      })
    : undefined;
  const createRuntimeDepsPlan = () =>
    createBundledRuntimeDepsPackagePlan({
      packageRoot,
      config: params.config,
      includeConfiguredChannels: true,
      env: process.env,
    });
  let plan = createRuntimeDepsPlan();
  let repairedSpecs: string[] = [];
  let reusedSpecs: string[] = [];
  let reusedFromRoot: string | undefined;

  if (params.options.repair && plan.missingSpecs.length > 0) {
    const result = await repairBundledRuntimeDepsPackagePlanAsync({
      packageRoot,
      config: params.config,
      includeConfiguredChannels: true,
      env: process.env,
      warn,
      onProgress: (message) => {
        if (!params.options.json) {
          defaultRuntime.log(theme.muted(message));
        }
      },
    });
    repairedSpecs = result.repairedSpecs;
    reusedSpecs = result.reusedSpecs ?? [];
    reusedFromRoot = result.reusedFromRoot;
    plan = createRuntimeDepsPlan();
  }

  if (params.options.json) {
    defaultRuntime.writeJson({
      packageRoot,
      installRoot: plan.installRootPlan.installRoot,
      installRootExternal: plan.installRootPlan.external,
      searchRoots: plan.installRootPlan.searchRoots,
      deps: plan.deps,
      missing: plan.missing,
      conflicts: formatRuntimeDepConflicts(plan.conflicts),
      installSpecs: plan.installSpecs,
      missingSpecs: plan.missingSpecs,
      repairedSpecs,
      ...(reusedSpecs.length > 0 ? { reusedSpecs } : {}),
      ...(reusedFromRoot ? { reusedFromRoot } : {}),
      warnings,
      ...(pruned ? { pruned } : {}),
    });
    return;
  }

  const lines = [
    theme.heading("Bundled Plugin Runtime Deps"),
    `${theme.muted("Package root:")} ${shortenHomePath(packageRoot)}`,
    `${theme.muted("Install root:")} ${shortenHomePath(plan.installRootPlan.installRoot)}${
      plan.installRootPlan.external ? theme.muted(" (external)") : ""
    }`,
  ];
  if (pruned) {
    lines.push(
      `${theme.muted("Pruned unknown roots:")} ${pruned.removed}/${pruned.scanned}${
        pruned.skippedLocked > 0 ? theme.muted(` (${pruned.skippedLocked} locked)`) : ""
      }`,
    );
  }
  if (plan.conflicts.length > 0) {
    lines.push("");
    lines.push(theme.error("Version conflicts:"));
    for (const conflict of plan.conflicts) {
      const owners = conflict.versions
        .map((version) => `${version}: ${conflict.pluginIdsByVersion.get(version)?.join(", ")}`)
        .join("; ");
      lines.push(`- ${conflict.name}: ${owners}`);
    }
  }
  if (plan.deps.length === 0) {
    lines.push("");
    lines.push(theme.muted("No packaged bundled runtime deps are required for this checkout."));
    defaultRuntime.log(lines.join("\n"));
    return;
  }

  lines.push("");
  lines.push(
    `${theme.muted("Status:")} ${
      plan.missing.length === 0 ? theme.success("materialized") : theme.warn("missing")
    }`,
  );
  if (repairedSpecs.length > 0) {
    lines.push(`${theme.muted("Repaired:")} ${repairedSpecs.join(", ")}`);
  } else if (reusedSpecs.length > 0) {
    lines.push(`${theme.muted("Reused:")} ${reusedSpecs.join(", ")}`);
  } else if (params.options.repair && plan.conflicts.length > 0) {
    lines.push(theme.warn("Repair skipped because runtime dependency versions conflict."));
  }
  lines.push("");
  lines.push(
    renderTable({
      width: getTerminalTableWidth(),
      columns: [
        { key: "Name", header: "Name", minWidth: 18, flex: true },
        { key: "Version", header: "Version", minWidth: 12 },
        { key: "Status", header: "Status", minWidth: 12 },
        { key: "Plugins", header: "Plugins", minWidth: 24, flex: true },
      ],
      rows: plan.deps.map((dep) => ({
        Name: dep.name,
        Version: dep.version,
        Status: plan.missing.some(
          (missing) => missing.name === dep.name && missing.version === dep.version,
        )
          ? theme.warn("missing")
          : theme.success("ok"),
        Plugins: formatRuntimeDepOwners(dep.pluginIds),
      })),
    }).trimEnd(),
  );
  defaultRuntime.log(lines.join("\n"));
}
