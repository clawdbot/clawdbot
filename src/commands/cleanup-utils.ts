// Shared destructive-cleanup planning and guarded removal helpers.
import fs from "node:fs/promises";
import path from "node:path";
import { listAgentIds, resolveAgentWorkspaceDir } from "../agents/agent-scope-config.js";
import { resolveDefaultAgentWorkspaceDir } from "../agents/workspace-default.js";
import {
  resolveWorkspaceAttestationPaths,
  shouldRemoveWorkspaceAttestation,
} from "../agents/workspace.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isPathInside } from "../infra/path-guards.js";
import type { RuntimeEnv } from "../runtime.js";
import { resolveHomeDir, shortenHomeInString } from "../utils.js";

type RemovalResult = {
  ok: boolean;
  skipped?: boolean;
};

type CleanupResolvedPaths = {
  stateDir: string;
  configPath: string;
  oauthDir: string;
  configInsideState: boolean;
  oauthInsideState: boolean;
};

type RemovalOptions = {
  dryRun?: boolean;
  label?: string;
};

type StateRemovalOptions = {
  dryRun?: boolean;
  preservePaths?: readonly string[];
};

function collectWorkspaceDirs(cfg: OpenClawConfig | undefined): string[] {
  const dirs = new Set<string>();
  if (!cfg) {
    dirs.add(resolveDefaultAgentWorkspaceDir());
    return [...dirs];
  }
  for (const agentId of listAgentIds(cfg)) {
    dirs.add(resolveAgentWorkspaceDir(cfg, agentId));
  }
  return [...dirs];
}

/** Determine which config, credential, and workspace paths cleanup should consider. */
export function buildCleanupPlan(params: {
  cfg: OpenClawConfig | undefined;
  stateDir: string;
  configPath: string;
  oauthDir: string;
}): {
  configInsideState: boolean;
  oauthInsideState: boolean;
  workspaceDirs: string[];
} {
  return {
    configInsideState: isPathWithin(params.configPath, params.stateDir),
    oauthInsideState: isPathWithin(params.oauthDir, params.stateDir),
    workspaceDirs: collectWorkspaceDirs(params.cfg),
  };
}

/** Return true when `child` resolves inside `parent`. */
export function isPathWithin(child: string, parent: string): boolean {
  return isPathInside(parent, child);
}

function isUnsafeRemovalTarget(target: string): boolean {
  if (!target.trim()) {
    return true;
  }
  const resolved = path.resolve(target);
  const root = path.parse(resolved).root;
  if (resolved === root) {
    return true;
  }
  const home = resolveHomeDir();
  if (home && resolved === path.resolve(home)) {
    return true;
  }
  if (isPathWithin(path.resolve(process.cwd()), resolved)) {
    return true;
  }
  return false;
}

/** Remove one path after rejecting empty/root/home targets and honoring dry-run mode. */
export async function removePath(
  target: string,
  runtime: RuntimeEnv,
  opts?: RemovalOptions,
): Promise<RemovalResult> {
  if (!target?.trim()) {
    return { ok: false, skipped: true };
  }
  const resolved = path.resolve(target);
  const label = opts?.label ?? resolved;
  const displayLabel = shortenHomeInString(label);
  if (isUnsafeRemovalTarget(resolved)) {
    runtime.error(`Refusing to remove unsafe path: ${displayLabel}`);
    return { ok: false };
  }
  if (opts?.dryRun) {
    runtime.log(`[dry-run] remove ${displayLabel}`);
    return { ok: true, skipped: true };
  }
  try {
    await fs.rm(resolved, { recursive: true, force: true });
    runtime.log(`Removed ${displayLabel}`);
    return { ok: true };
  } catch (err) {
    runtime.error(`Failed to remove ${displayLabel}: ${String(err)}`);
    return { ok: false };
  }
}

/** Remove workspace attestation files associated with cleanup-target workspaces. */
export async function removeWorkspaceAttestationPaths(
  workspaceDirs: readonly string[],
  runtime: RuntimeEnv,
  opts?: RemovalOptions,
): Promise<void> {
  for (const workspaceDir of workspaceDirs) {
    for (const [index, attestationPath] of resolveWorkspaceAttestationPaths(
      workspaceDir,
    ).entries()) {
      if (await shouldRemoveWorkspaceAttestation(attestationPath, { trustUnknown: index === 0 })) {
        await removePath(attestationPath, runtime, opts);
      }
    }
  }
}

async function existingPaths(paths: readonly string[]): Promise<string[]> {
  const existing: string[] = [];
  for (const target of paths) {
    if (!target?.trim()) {
      continue;
    }
    const resolved = path.resolve(target);
    try {
      await fs.lstat(resolved);
      existing.push(resolved);
    } catch {
      // Missing workspaces do not need preservation during destructive cleanup.
    }
  }
  return existing;
}

function shouldPreservePath(target: string, preservePaths: readonly string[]): boolean {
  return preservePaths.some((preservePath) => isPathWithin(target, preservePath));
}

function pathContainsPreservedPath(target: string, preservePaths: readonly string[]): boolean {
  return preservePaths.some((preservePath) => isPathWithin(preservePath, target));
}

async function removePathPreserving(
  target: string,
  preservePaths: readonly string[],
  runtime: RuntimeEnv,
  opts?: RemovalOptions,
): Promise<RemovalResult> {
  if (!target?.trim()) {
    return { ok: false, skipped: true };
  }
  const resolved = path.resolve(target);
  const label = opts?.label ?? resolved;
  const displayLabel = shortenHomeInString(label);
  if (isUnsafeRemovalTarget(resolved)) {
    runtime.error(`Refusing to remove unsafe path: ${displayLabel}`);
    return { ok: false };
  }
  if (shouldPreservePath(resolved, preservePaths)) {
    return { ok: true, skipped: true };
  }
  if (!pathContainsPreservedPath(resolved, preservePaths)) {
    return removePath(resolved, runtime, opts);
  }
  if (opts?.dryRun) {
    const preserved = preservePaths
      .filter((preservePath) => isPathWithin(preservePath, resolved))
      .map((preservePath) => shortenHomeInString(preservePath))
      .join(", ");
    runtime.log(`[dry-run] remove ${displayLabel} preserving ${preserved}`);
    return { ok: true, skipped: true };
  }
  try {
    const stat = await fs.lstat(resolved);
    if (!stat.isDirectory()) {
      return removePath(resolved, runtime, opts);
    }
    const entries = await fs.readdir(resolved);
    for (const entry of entries) {
      await removePathPreserving(path.join(resolved, entry), preservePaths, runtime);
    }
    runtime.log(`Removed contents of ${displayLabel}`);
    return { ok: true };
  } catch (err) {
    runtime.error(`Failed to remove ${displayLabel}: ${String(err)}`);
    return { ok: false };
  }
}

/** Remove state plus config/OAuth paths, preserving selected paths nested inside state. */
export async function removeStateAndLinkedPaths(
  cleanup: CleanupResolvedPaths,
  runtime: RuntimeEnv,
  opts?: StateRemovalOptions,
): Promise<void> {
  const stateDir = path.resolve(cleanup.stateDir);
  const preservePaths = (
    opts?.dryRun
      ? (opts.preservePaths ?? []).map((target) => path.resolve(target))
      : await existingPaths(opts?.preservePaths ?? [])
  ).filter((target) => isPathWithin(target, stateDir));
  if (preservePaths.length > 0) {
    await removePathPreserving(stateDir, preservePaths, runtime, {
      dryRun: opts?.dryRun,
      label: cleanup.stateDir,
    });
  } else {
    await removePath(cleanup.stateDir, runtime, {
      dryRun: opts?.dryRun,
      label: cleanup.stateDir,
    });
  }
  if (!cleanup.configInsideState) {
    await removePath(cleanup.configPath, runtime, {
      dryRun: opts?.dryRun,
      label: cleanup.configPath,
    });
  }
  if (!cleanup.oauthInsideState) {
    await removePath(cleanup.oauthDir, runtime, {
      dryRun: opts?.dryRun,
      label: cleanup.oauthDir,
    });
  }
}

/** Remove all workspace directories selected by the cleanup plan. */
export async function removeWorkspaceDirs(
  workspaceDirs: readonly string[],
  runtime: RuntimeEnv,
  opts?: { dryRun?: boolean },
): Promise<void> {
  for (const workspace of workspaceDirs) {
    await removePath(workspace, runtime, {
      dryRun: opts?.dryRun,
      label: workspace,
    });
  }
}

/** List per-agent session directories beneath a state directory. */
export async function listAgentSessionDirs(stateDir: string): Promise<string[]> {
  const root = path.join(stateDir, "agents");
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(root, entry.name, "sessions"));
  } catch {
    return [];
  }
}
