/**
 * Sandbox skill runtime input selection.
 *
 * Sandboxed runs must build prompt-facing skill entries from readable in-sandbox
 * copies instead of reusing host-path snapshots.
 */
import path from "node:path";
import { buildSkillSnapshot } from "../../skills/loading/workspace-skill-prompt.js";
import type { SkillEligibilityContext, SkillSnapshot, SkillUsagePath } from "../../skills/types.js";
import type { SkillEntry } from "../../skills/types.js";
import type { SandboxContext } from "../sandbox/types.js";

const MATERIALIZED_SKILLS_WORKSPACE_CONTAINER_PARTS = [".openclaw", "sandbox-skills"] as const;
type SandboxSkillRuntimeContext = Pick<SandboxContext, "enabled"> &
  Partial<
    Pick<
      SandboxContext,
      | "skillsEligibility"
      | "skillsWorkspaceDir"
      | "skillsSnapshot"
      | "containerWorkdir"
      | "workspaceAccess"
    >
  >;

function containerJoin(root: string, ...parts: string[]): string {
  const normalizedRoot = root.replace(/\\/g, "/").replace(/\/+$/, "") || "/";
  const suffix = parts
    .map((part) => part.replace(/^\/+|\/+$/g, ""))
    .filter(Boolean)
    .join("/");
  return suffix ? `${normalizedRoot}/${suffix}` : normalizedRoot;
}

function pathEscapesRoot(relativePath: string): boolean {
  return (
    relativePath === ".." ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath)
  );
}

function mapPathFromWorkspaceToContainer(params: {
  filePath: string | undefined;
  sourceWorkspaceDir: string;
  targetWorkspaceDir: string;
}): string | undefined {
  if (!params.filePath || !path.isAbsolute(params.filePath)) {
    return params.filePath;
  }
  const relativePath = path.relative(
    path.resolve(params.sourceWorkspaceDir),
    path.resolve(params.filePath),
  );
  if (pathEscapesRoot(relativePath)) {
    return params.filePath;
  }
  if (!relativePath) {
    return params.targetWorkspaceDir.replace(/\\/g, "/");
  }
  return containerJoin(params.targetWorkspaceDir, ...relativePath.split(path.sep).filter(Boolean));
}

export function mapSandboxSkillEntriesForPrompt(params: {
  entries?: SkillEntry[];
  skillsWorkspaceDir: string;
  skillsPromptWorkspaceDir: string;
}): SkillEntry[] | undefined {
  if (!params.entries || params.skillsWorkspaceDir === params.skillsPromptWorkspaceDir) {
    return params.entries;
  }
  return params.entries.map((entry) => {
    const filePath =
      mapPathFromWorkspaceToContainer({
        filePath: entry.skill.filePath,
        sourceWorkspaceDir: params.skillsWorkspaceDir,
        targetWorkspaceDir: params.skillsPromptWorkspaceDir,
      }) ?? entry.skill.filePath;
    const baseDir =
      mapPathFromWorkspaceToContainer({
        filePath: entry.skill.baseDir,
        sourceWorkspaceDir: params.skillsWorkspaceDir,
        targetWorkspaceDir: params.skillsPromptWorkspaceDir,
      }) ?? entry.skill.baseDir;
    const sourceInfoPath =
      mapPathFromWorkspaceToContainer({
        filePath: entry.skill.sourceInfo.path,
        sourceWorkspaceDir: params.skillsWorkspaceDir,
        targetWorkspaceDir: params.skillsPromptWorkspaceDir,
      }) ?? entry.skill.sourceInfo.path;
    const sourceInfoBaseDir = mapPathFromWorkspaceToContainer({
      filePath: entry.skill.sourceInfo.baseDir,
      sourceWorkspaceDir: params.skillsWorkspaceDir,
      targetWorkspaceDir: params.skillsPromptWorkspaceDir,
    });
    return {
      ...entry,
      skill: {
        ...entry.skill,
        filePath,
        baseDir,
        sourceInfo: {
          ...entry.skill.sourceInfo,
          path: sourceInfoPath,
          ...(sourceInfoBaseDir === undefined ? {} : { baseDir: sourceInfoBaseDir }),
        },
      },
    };
  });
}

export function mapSandboxSkillUsagePaths(params: {
  paths?: SkillUsagePath[];
  skillsWorkspaceDir: string;
  skillsPromptWorkspaceDir: string;
}): SkillUsagePath[] | undefined {
  if (!params.paths || params.skillsWorkspaceDir === params.skillsPromptWorkspaceDir) {
    return params.paths;
  }
  return params.paths.map((entry) => ({
    ...entry,
    readPath:
      mapPathFromWorkspaceToContainer({
        filePath: entry.readPath,
        sourceWorkspaceDir: params.skillsWorkspaceDir,
        targetWorkspaceDir: params.skillsPromptWorkspaceDir,
      }) ?? entry.readPath,
  }));
}

function remapMaterializedSkillsSnapshotForPrompt(params: {
  skillsSnapshot: SkillSnapshot;
  skillsWorkspaceDir: string;
  skillsPromptWorkspaceDir: string;
  skillsEligibility?: SkillEligibilityContext;
}): SkillSnapshot {
  if (params.skillsWorkspaceDir === params.skillsPromptWorkspaceDir) {
    return params.skillsSnapshot;
  }
  const hostEntries = (params.skillsSnapshot.resolvedSkills ?? []).map((skill) => ({ skill }));
  const mappedEntries = mapSandboxSkillEntriesForPrompt({
    entries: hostEntries,
    skillsWorkspaceDir: params.skillsWorkspaceDir,
    skillsPromptWorkspaceDir: params.skillsPromptWorkspaceDir,
  });
  const remapped = buildSkillSnapshot(params.skillsPromptWorkspaceDir, {
    entries: mappedEntries,
    eligibility: params.skillsEligibility,
    snapshotVersion: params.skillsSnapshot.version,
  });
  // Preserve the full eligible identity list (including prompt-hidden skills)
  // from the sync-published generation; only prompt paths need container remap.
  return {
    ...remapped,
    skills: params.skillsSnapshot.skills,
    ...(params.skillsSnapshot.skillFilter === undefined
      ? {}
      : { skillFilter: params.skillsSnapshot.skillFilter }),
    ...(params.skillsSnapshot.skillOverrides
      ? { skillOverrides: params.skillsSnapshot.skillOverrides }
      : {}),
    ...(params.skillsSnapshot.nodeSkillsEligibility
      ? { nodeSkillsEligibility: params.skillsSnapshot.nodeSkillsEligibility }
      : {}),
  };
}

export function resolveSandboxSkillRuntimeInputs(params: {
  sandbox?: SandboxSkillRuntimeContext | null;
  effectiveWorkspace: string;
  skillsSnapshot?: SkillSnapshot;
}): {
  skillsEligibility?: SkillEligibilityContext;
  skillsPromptWorkspaceDir: string;
  skillsSnapshot?: SkillSnapshot;
  skillsWorkspaceDir: string;
  workspaceOnly: boolean;
} {
  if (params.sandbox?.enabled === true) {
    const skillsWorkspaceDir = params.sandbox.skillsWorkspaceDir ?? params.effectiveWorkspace;
    const skillsPromptWorkspaceDir =
      params.sandbox.workspaceAccess === "rw" &&
      params.sandbox.skillsWorkspaceDir &&
      params.sandbox.containerWorkdir
        ? containerJoin(
            params.sandbox.containerWorkdir,
            ...MATERIALIZED_SKILLS_WORKSPACE_CONTAINER_PARTS,
          )
        : (params.sandbox.containerWorkdir ?? skillsWorkspaceDir);
    // Prefer the sync-published materialized catalog over a live rescan of the
    // shared skills directory. Host-path snapshots remain suppressed.
    const materializedSnapshot = params.sandbox.skillsSnapshot
      ? remapMaterializedSkillsSnapshotForPrompt({
          skillsSnapshot: params.sandbox.skillsSnapshot,
          skillsWorkspaceDir,
          skillsPromptWorkspaceDir,
          ...(params.sandbox.skillsEligibility
            ? { skillsEligibility: params.sandbox.skillsEligibility }
            : {}),
        })
      : undefined;
    return {
      ...(params.sandbox.skillsEligibility
        ? { skillsEligibility: params.sandbox.skillsEligibility }
        : {}),
      skillsPromptWorkspaceDir,
      skillsSnapshot: materializedSnapshot,
      skillsWorkspaceDir,
      workspaceOnly: true,
    };
  }
  return {
    skillsPromptWorkspaceDir: params.effectiveWorkspace,
    skillsSnapshot: params.skillsSnapshot,
    skillsWorkspaceDir: params.effectiveWorkspace,
    workspaceOnly: false,
  };
}
