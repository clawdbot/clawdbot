/**
 * Sandbox skill runtime input selection.
 *
 * Sandboxed runs must build prompt-facing skill entries from readable in-sandbox
 * copies instead of reusing host-path snapshots.
 */
import path from "node:path";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { escapeSkillXml, type Skill } from "../../skills/loading/skill-contract.js";
import { compactPromptSkills } from "../../skills/loading/skill-paths.js";
import { resolveSkillsPrompt } from "../../skills/loading/workspace-skill-prompt.js";
import { resolveEmbeddedRunSkillEntries } from "../../skills/runtime/embedded-run-entries.js";
import type {
  SkillEligibilityContext,
  SkillEntry,
  SkillSnapshot,
  SkillUsagePath,
} from "../../skills/types.js";
import { readPublishedSandboxSkills } from "../sandbox/published-skills-handoff.js";
import type { SandboxContext, SandboxWorkspaceInfo } from "../sandbox/types.js";

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
  // documents its host path keeps the rest of the prompt byte-for-byte. The
  // caller passes the path exactly as the renderer serialized it.
  const from = `<location>${escapeSkillXml(params.hostPath)}</location>`;
  const to = `<location>${escapeSkillXml(params.mappedPath)}</location>`;
  return from === to ? params.prompt : params.prompt.replaceAll(from, to);
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
  // The renderer compacts $HOME-rooted locations to "~/…" and the materialized
  // skills dir lives under the state dir, so match the serialized form. Matching
  // the absolute path silently leaves host "~/…" locations in the prompt.
  const serializedHostPaths = compactPromptSkills(hostSkills).map((skill) => skill.filePath);
  let prompt = params.skillsSnapshot.prompt;
  for (let index = 0; index < hostSkills.length; index += 1) {
    const hostPath = serializedHostPaths[index];
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
  publishedSkillsOwner?: object | null;
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
    // Use the catalog attached to this sandbox/run, not the workspace-global
    // publisher cache. Concurrent sessions can publish different eligibility
    // snapshots into the same skills directory; peeking the last writer would
    // inject the wrong catalog into this run's prompt.
    const publishedSnapshot = readPublishedSandboxSkills(
      params.publishedSkillsOwner ?? params.sandbox,
    );
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

// CLI and command inspection share this assembly.
export function resolveSandboxedWorkspaceSkillsPrompt(params: {
  agentId: string;
  config?: OpenClawConfig;
  workspace: SandboxWorkspaceInfo;
}): string {
  const {
    skillsEligibility,
    skillsPromptWorkspaceDir,
    skillsSnapshot,
    skillsWorkspaceDir,
    workspaceOnly,
  } = resolveSandboxSkillRuntimeInputs({
    sandbox: {
      enabled: true,
      ...(params.workspace.containerWorkdir
        ? { containerWorkdir: params.workspace.containerWorkdir }
        : {}),
      ...(params.workspace.skillsEligibility
        ? { skillsEligibility: params.workspace.skillsEligibility }
        : {}),
      ...(params.workspace.skillsWorkspaceDir
        ? { skillsWorkspaceDir: params.workspace.skillsWorkspaceDir }
        : {}),
      ...(params.workspace.workspaceAccess
        ? { workspaceAccess: params.workspace.workspaceAccess }
        : {}),
    },
    effectiveWorkspace: params.workspace.workspaceDir,
    publishedSkillsOwner: params.workspace,
  });
  const { shouldLoadSkillEntries, skillEntries } = resolveEmbeddedRunSkillEntries({
    workspaceDir: skillsWorkspaceDir,
    config: params.config,
    agentId: params.agentId,
    eligibility: skillsEligibility,
    skillsSnapshot,
    workspaceOnly,
  });
  return resolveSkillsPrompt({
    skillsSnapshot,
    entries: mapSandboxSkillEntriesForPrompt({
      entries: shouldLoadSkillEntries ? skillEntries : undefined,
      skillsWorkspaceDir,
      skillsPromptWorkspaceDir,
    }),
    workspaceDir: skillsPromptWorkspaceDir,
    config: params.config,
    agentId: params.agentId,
    eligibility: skillsEligibility,
  });
}
