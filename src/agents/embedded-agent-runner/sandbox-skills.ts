/**
 * Sandbox skill runtime input selection.
 *
 * Sandboxed runs must build prompt-facing skill entries from readable in-sandbox
 * copies instead of reusing host-path snapshots.
 */
import path from "node:path";
import { escapeSkillXml, type Skill } from "../../skills/loading/skill-contract.js";
import { peekPublishedSyncedSkillsSnapshot } from "../../skills/loading/workspace-skill-sync-cache.js";
import type {
  SkillEligibilityContext,
  SkillEntry,
  SkillSnapshot,
  SkillUsagePath,
} from "../../skills/types.js";
import type { SandboxContext } from "../sandbox/types.js";

const MATERIALIZED_SKILLS_WORKSPACE_CONTAINER_PARTS = [".openclaw", "sandbox-skills"] as const;
type SandboxSkillRuntimeContext = Pick<SandboxContext, "enabled"> &
  Partial<
    Pick<
      SandboxContext,
      "skillsEligibility" | "skillsWorkspaceDir" | "containerWorkdir" | "workspaceAccess"
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

function mapSandboxSkillForPrompt(params: {
  skill: Skill;
  skillsWorkspaceDir: string;
  skillsPromptWorkspaceDir: string;
}): Skill {
  const filePath =
    mapPathFromWorkspaceToContainer({
      filePath: params.skill.filePath,
      sourceWorkspaceDir: params.skillsWorkspaceDir,
      targetWorkspaceDir: params.skillsPromptWorkspaceDir,
    }) ?? params.skill.filePath;
  const baseDir =
    mapPathFromWorkspaceToContainer({
      filePath: params.skill.baseDir,
      sourceWorkspaceDir: params.skillsWorkspaceDir,
      targetWorkspaceDir: params.skillsPromptWorkspaceDir,
    }) ?? params.skill.baseDir;
  const sourceInfoPath =
    mapPathFromWorkspaceToContainer({
      filePath: params.skill.sourceInfo.path,
      sourceWorkspaceDir: params.skillsWorkspaceDir,
      targetWorkspaceDir: params.skillsPromptWorkspaceDir,
    }) ?? params.skill.sourceInfo.path;
  const sourceInfoBaseDir = mapPathFromWorkspaceToContainer({
    filePath: params.skill.sourceInfo.baseDir,
    sourceWorkspaceDir: params.skillsWorkspaceDir,
    targetWorkspaceDir: params.skillsPromptWorkspaceDir,
  });
  return {
    ...params.skill,
    filePath,
    baseDir,
    sourceInfo: {
      ...params.skill.sourceInfo,
      path: sourceInfoPath,
      ...(sourceInfoBaseDir === undefined ? {} : { baseDir: sourceInfoBaseDir }),
    },
  };
}

export function mapSandboxSkillEntriesForPrompt(params: {
  entries?: SkillEntry[];
  skillsWorkspaceDir: string;
  skillsPromptWorkspaceDir: string;
}): SkillEntry[] | undefined {
  if (!params.entries || params.skillsWorkspaceDir === params.skillsPromptWorkspaceDir) {
    return params.entries;
  }
  return params.entries.map((entry) => ({
    ...entry,
    skill: mapSandboxSkillForPrompt({
      skill: entry.skill,
      skillsWorkspaceDir: params.skillsWorkspaceDir,
      skillsPromptWorkspaceDir: params.skillsPromptWorkspaceDir,
    }),
  }));
}

function replaceSerializedSkillLocation(params: {
  prompt: string;
  hostPath: string;
  mappedPath: string;
}): string {
  // The catalog renderer serializes arbitrary description and location-note
  // prose next to <location>. Substitute only that element so a skill that
  // documents its host path keeps the rest of the prompt byte-for-byte.
  const pathPairs: Array<[string, string]> = [[params.hostPath, params.mappedPath]];
  const hostPosix = params.hostPath.replaceAll("\\", "/");
  if (hostPosix !== params.hostPath) {
    pathPairs.push([hostPosix, params.mappedPath.replaceAll("\\", "/")]);
  }
  let prompt = params.prompt;
  for (const [fromPath, toPath] of pathPairs) {
    const from = `<location>${escapeSkillXml(fromPath)}</location>`;
    const to = `<location>${escapeSkillXml(toPath)}</location>`;
    if (from !== to) {
      prompt = prompt.replaceAll(from, to);
    }
  }
  return prompt;
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
}): SkillSnapshot {
  if (params.skillsWorkspaceDir === params.skillsPromptWorkspaceDir) {
    return params.skillsSnapshot;
  }
  // Remap destination paths only. Rebuilding via buildSkillSnapshot would
  // re-apply default prompt limits and can shrink a complete published catalog.
  const hostSkills = params.skillsSnapshot.resolvedSkills ?? [];
  const mappedSkills = hostSkills.map((skill) =>
    mapSandboxSkillForPrompt({
      skill,
      skillsWorkspaceDir: params.skillsWorkspaceDir,
      skillsPromptWorkspaceDir: params.skillsPromptWorkspaceDir,
    }),
  );
  let prompt = params.skillsSnapshot.prompt;
  for (let index = 0; index < hostSkills.length; index += 1) {
    const hostPath = hostSkills[index]?.filePath;
    const mappedPath = mappedSkills[index]?.filePath;
    if (!hostPath || !mappedPath || hostPath === mappedPath) {
      continue;
    }
    prompt = replaceSerializedSkillLocation({ prompt, hostPath, mappedPath });
  }
  return {
    ...params.skillsSnapshot,
    prompt,
    resolvedSkills: mappedSkills,
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
    // shared skills directory. Host-path snapshots remain suppressed. A miss
    // still live-scans (first publish only); refresh races keep the previous
    // catalog in cache.
    const publishedSnapshot = peekPublishedSyncedSkillsSnapshot(skillsWorkspaceDir);
    const materializedSnapshot = publishedSnapshot
      ? remapMaterializedSkillsSnapshotForPrompt({
          skillsSnapshot: publishedSnapshot,
          skillsWorkspaceDir,
          skillsPromptWorkspaceDir,
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
