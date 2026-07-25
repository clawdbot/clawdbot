// Doctor cleanup for state left by the retired experimental Workspaces plugin.
import { lstat, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveUserPath } from "../utils.js";
import type { HealthCheck, HealthRepairEffect } from "./health-checks.js";

const CHECK_ID = "core/doctor/removed-workspaces-state";

function resolveRemovedWorkspacesStateDir(): string {
  return path.join(resolveStateDir(process.env), "workspaces");
}

async function pathKind(target: string): Promise<"directory" | "file" | null> {
  try {
    const stats = await lstat(target);
    if (stats.isDirectory()) {
      return "directory";
    }
    return stats.isFile() ? "file" : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function hasRemovedWorkspacesFingerprint(target: string): Promise<boolean> {
  if ((await pathKind(target)) !== "directory") {
    return false;
  }
  if ((await pathKind(path.join(target, "workspaces.sqlite"))) === "file") {
    return true;
  }
  const [widgetsKind, dataKind] = await Promise.all([
    pathKind(path.join(target, "widgets")),
    pathKind(path.join(target, "data")),
  ]);
  return widgetsKind === "directory" && dataKind === "directory";
}

async function canonicalPath(target: string): Promise<string> {
  const resolved = path.resolve(target);
  try {
    return await realpath(resolved);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return resolved;
    }
    throw error;
  }
}

function isSameOrDescendant(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) && !relative.startsWith(`..${path.sep}`) && relative !== "..")
  );
}

async function configuredAgentWorkspaceCollisions(
  cfg: OpenClawConfig,
  target: string,
): Promise<string[]> {
  const configured: Array<{ label: string; workspace: string | undefined }> = [
    { label: "agents.defaults.workspace", workspace: cfg.agents?.defaults?.workspace },
    ...(cfg.agents?.list ?? []).map((agent) => ({
      label: `agents.list.${agent.id}.workspace`,
      workspace: agent.workspace,
    })),
  ];
  const resolvedTarget = await canonicalPath(target);
  const resolvedEntries = await Promise.all(
    configured
      .filter(
        (entry): entry is { label: string; workspace: string } =>
          typeof entry.workspace === "string" && entry.workspace.trim().length > 0,
      )
      .map(async (entry) => ({
        label: entry.label,
        resolvedWorkspace: await canonicalPath(resolveUserPath(entry.workspace, process.env)),
      })),
  );
  return resolvedEntries
    .filter(
      (entry) =>
        isSameOrDescendant(resolvedTarget, entry.resolvedWorkspace) ||
        isSameOrDescendant(entry.resolvedWorkspace, resolvedTarget),
    )
    .map((entry) => entry.label);
}

function collisionWarning(target: string, collisions: readonly string[]): string {
  return `Retired Workspaces plugin fingerprints remain at ${target}, but ${collisions.join(
    ", ",
  )} resolves to that directory or an overlapping path. Automatic removal is disabled.`;
}

function repairEffect(target: string, dryRun: boolean): HealthRepairEffect {
  return {
    kind: "state",
    action: dryRun ? "would-remove-retired-workspaces-state" : "remove-retired-workspaces-state",
    target,
    dryRunSafe: false,
  };
}

export const removedWorkspacesStateCheck: HealthCheck = {
  id: CHECK_ID,
  kind: "core",
  description: "State from the retired experimental Workspaces plugin has been removed.",
  source: "doctor",
  async detect(ctx, scope) {
    const target = resolveRemovedWorkspacesStateDir();
    const scopedPaths = new Set(scope?.paths ?? []);
    if (
      (scopedPaths.size > 0 && !scopedPaths.has(target)) ||
      !(await hasRemovedWorkspacesFingerprint(target))
    ) {
      return [];
    }
    const collisions = await configuredAgentWorkspaceCollisions(ctx.cfg, target);
    if (collisions.length > 0) {
      return [
        {
          checkId: CHECK_ID,
          severity: "warning",
          message: collisionWarning(target, collisions),
          path: target,
        },
      ];
    }
    return [
      {
        checkId: CHECK_ID,
        severity: "warning",
        message: `Retired Workspaces plugin state remains at ${target}.`,
        path: target,
        fixHint: "Run `openclaw doctor --fix` to remove the stale plugin state.",
      },
    ];
  },
  async repair(ctx) {
    const target = resolveRemovedWorkspacesStateDir();
    if (!(await hasRemovedWorkspacesFingerprint(target))) {
      return {
        status: "skipped",
        reason: "retired Workspaces plugin fingerprints are absent",
        changes: [],
      };
    }
    const collisions = await configuredAgentWorkspaceCollisions(ctx.cfg, target);
    if (collisions.length > 0) {
      const warning = collisionWarning(target, collisions);
      return {
        status: "skipped",
        reason: warning,
        changes: [],
        warnings: [warning],
      };
    }
    const dryRun = ctx.dryRun === true;
    const effects = [repairEffect(target, dryRun)];
    if (dryRun) {
      return { changes: [`Would remove retired Workspaces plugin state at ${target}.`], effects };
    }
    await rm(target, { force: true, recursive: true });
    return { changes: [`Removed retired Workspaces plugin state at ${target}.`], effects };
  },
};
