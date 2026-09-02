/** Frozen backup ownership and resource policy shared by archive traversal and SQLite discovery. */
import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { hasErrnoCode } from "../infra/errno.js";
import type { ResolvedPluginBackupResource } from "../plugins/manifest-backup-resources.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { isPathWithin } from "./cleanup-utils.js";

export type BackupAgentRoot = Readonly<{
  agentId: string;
  sourcePath: string;
  databasePath: string;
}>;

export type BackupRegenerableKind =
  | "agent temporary files"
  | "managed state"
  | "plugin skills"
  | "plugin resource"
  | "plugin dependencies";

type BackupRegenerableRoot = Readonly<{
  kind: BackupRegenerableKind;
  sourcePath: string;
}>;

export type BackupResourceInventory = Readonly<{
  stateDir: string;
  agentRoots: readonly BackupAgentRoot[];
  regenerableRoots: readonly BackupRegenerableRoot[];
  isIncluded: (sourcePath: string) => boolean;
  isTraversable: (sourcePath: string) => boolean;
  isPackageContent: (sourcePath: string) => boolean;
}>;

const MANAGED_STATE_ROOTS = ["dev", "git", "npm", "npm-runtime", "tmp", "tools"] as const;

async function listDefaultAgentTemporaryRoots(
  stateDir: string,
  agentRoots: readonly BackupAgentRoot[],
): Promise<string[]> {
  // Name-based scratch ownership belongs only to the shipped default layout;
  // a configured custom root keeps its durable tmp trees even when nested there.
  const customAgentRoots = agentRoots.filter(
    ({ agentId, sourcePath }) => sourcePath !== path.join(stateDir, "agents", agentId, "agent"),
  );
  const temporaryRoots: string[] = [];

  const visit = async (directoryPath: string): Promise<void> => {
    if (customAgentRoots.some(({ sourcePath }) => isPathWithin(directoryPath, sourcePath))) {
      return;
    }

    let entries: Dirent[];
    try {
      entries = await fs.readdir(directoryPath, { withFileTypes: true });
    } catch (error) {
      if (hasErrnoCode(error, "ENOENT") || hasErrnoCode(error, "ENOTDIR")) {
        return;
      }
      throw error;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const entryPath = path.join(directoryPath, entry.name);
      if (customAgentRoots.some(({ sourcePath }) => isPathWithin(entryPath, sourcePath))) {
        continue;
      }
      if (entry.name === "tmp" || entry.name === ".tmp") {
        temporaryRoots.push(entryPath);
        continue;
      }
      await visit(entryPath);
    }
  };

  let agentDirectories: Dirent[];
  try {
    agentDirectories = await fs.readdir(path.join(stateDir, "agents"), { withFileTypes: true });
  } catch (error) {
    if (hasErrnoCode(error, "ENOENT") || hasErrnoCode(error, "ENOTDIR")) {
      return temporaryRoots;
    }
    throw error;
  }
  for (const directory of agentDirectories) {
    if (directory.isDirectory()) {
      await visit(path.join(stateDir, "agents", directory.name, "agent"));
    }
  }
  return temporaryRoots;
}

/** Build the one immutable owner inventory used by backup planning and archive consumers. */
export async function createBackupResourceInventory(params: {
  stateDir: string;
  configPath: string;
  oauthDir: string;
  workspaceDirs: readonly string[];
  excludedWorkspaceDirs: readonly string[];
  agentRoots: readonly BackupAgentRoot[];
  pluginResources: readonly ResolvedPluginBackupResource[];
  pluginRoots: readonly string[];
  onlyConfig?: boolean;
}): Promise<BackupResourceInventory> {
  const stateDir = path.resolve(params.stateDir);
  const agentRoots = Object.freeze(
    params.agentRoots.map((root) =>
      Object.freeze({
        agentId: root.agentId,
        sourcePath: path.resolve(root.sourcePath),
        databasePath: path.resolve(root.databasePath),
      }),
    ),
  );
  const protectedPathSet = new Set<string>([
    path.resolve(params.configPath),
    resolveOpenClawStateSqlitePath({ ...process.env, OPENCLAW_STATE_DIR: stateDir }),
  ]);
  const regenerableRoots: BackupRegenerableRoot[] = [];
  const exclude = (kind: BackupRegenerableKind, sourcePath: string): void => {
    regenerableRoots.push({ kind, sourcePath: path.resolve(sourcePath) });
  };

  if (!params.onlyConfig) {
    protectedPathSet.add(path.resolve(params.oauthDir));
    for (const workspaceDir of params.workspaceDirs) {
      protectedPathSet.add(path.resolve(workspaceDir));
    }
    for (const root of agentRoots) {
      protectedPathSet.add(root.sourcePath);
      protectedPathSet.add(root.databasePath);
    }
    for (const root of MANAGED_STATE_ROOTS) {
      exclude("managed state", path.join(stateDir, root));
    }
    for (const temporaryRoot of await listDefaultAgentTemporaryRoots(stateDir, agentRoots)) {
      exclude("agent temporary files", temporaryRoot);
    }
    exclude("plugin skills", path.join(stateDir, "plugin-skills"));

    for (const resource of params.pluginResources) {
      const anchors = resource.scope === "state" ? [{ sourcePath: stateDir }] : agentRoots;
      for (const anchor of anchors) {
        const sourcePath = path.resolve(anchor.sourcePath, ...resource.relativePath.split("/"));
        if (!isPathWithin(sourcePath, anchor.sourcePath)) {
          throw new Error(
            `Plugin ${resource.pluginId} backup resource escapes its ${resource.scope} root: ${resource.relativePath}`,
          );
        }
        if (resource.disposition === "include") {
          protectedPathSet.add(sourcePath);
        } else {
          exclude("plugin resource", sourcePath);
        }
      }
    }
    for (const pluginRoot of params.pluginRoots) {
      exclude("plugin dependencies", path.join(pluginRoot, "node_modules"));
    }
  }

  const seenRegenerableRoots = new Set<string>();
  const uniqueRegenerableRoots = Object.freeze(
    regenerableRoots
      .toSorted(
        (left, right) =>
          left.sourcePath.localeCompare(right.sourcePath) || left.kind.localeCompare(right.kind),
      )
      .filter((resource) => {
        const key = `${resource.kind}\0${resource.sourcePath}`;
        if (seenRegenerableRoots.has(key)) {
          return false;
        }
        seenRegenerableRoots.add(key);
        return true;
      }),
  );
  const protectedPaths = Object.freeze([...protectedPathSet].toSorted());
  // Workspace exclusions stop traversal but are not regenerable resources;
  // protected nested owners remain reachable through isIncluded below.
  const excludedPaths = Object.freeze(
    [
      ...uniqueRegenerableRoots.map((resource) => resource.sourcePath),
      ...new Set(params.excludedWorkspaceDirs.map((dir) => path.resolve(dir))),
    ].toSorted((left, right) => right.length - left.length || left.localeCompare(right)),
  );

  const isIncluded = (sourcePath: string): boolean => {
    const candidate = path.resolve(sourcePath);
    const exclusion = excludedPaths.find((excludedPath) => isPathWithin(candidate, excludedPath));
    if (!exclusion) {
      return true;
    }
    // Broad state/agent roots cannot resurrect a narrower owner exclusion;
    // only an explicit include inside the excluded subtree overrides it.
    return protectedPaths.some(
      (protectedPath) =>
        isPathWithin(candidate, protectedPath) && isPathWithin(protectedPath, exclusion),
    );
  };
  const isTraversable = (sourcePath: string): boolean => {
    const candidate = path.resolve(sourcePath);
    return (
      isIncluded(candidate) ||
      protectedPaths.some((protectedPath) => isPathWithin(protectedPath, candidate))
    );
  };
  const isPackageContent = (sourcePath: string): boolean => {
    const candidate = path.resolve(sourcePath);
    // Explicit config, workspace, agent, and plugin ownership may live inside
    // node_modules; keep both those paths and their traversal ancestors.
    if (
      protectedPaths.some(
        (protectedPath) =>
          isPathWithin(candidate, protectedPath) || isPathWithin(protectedPath, candidate),
      )
    ) {
      return false;
    }
    if (!isPathWithin(candidate, stateDir)) {
      return false;
    }
    const segments = path.relative(stateDir, candidate).split(path.sep);
    // Default-layout agent ids can themselves be node_modules. Preserve the
    // canonical database, its sidecars, and traversal ancestors as agent state.
    if (
      segments[0] === "agents" &&
      segments[1] &&
      (segments.length === 2 ||
        (segments[2] === "agent" &&
          (segments.length === 3 ||
            (segments.length === 4 &&
              /^openclaw-agent\.sqlite(?:-wal|-shm|-journal)?$/u.test(segments[3] ?? "")))))
    ) {
      return false;
    }
    return segments.includes("node_modules");
  };

  return Object.freeze({
    stateDir,
    agentRoots,
    regenerableRoots: uniqueRegenerableRoots,
    isIncluded,
    isTraversable,
    isPackageContent,
  });
}
