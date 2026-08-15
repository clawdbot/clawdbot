import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { isPathInside } from "../../infra/path-guards.js";
import type { SkillStatusEntry } from "../discovery/status.js";
import { assertInsideWorkspace } from "../lifecycle/workspace-skill-write.js";
import { tryRealpath } from "../loading/symlink-targets.js";
import { resolveSkillWorkshopConfig } from "./config.js";

export const WRITABLE_WORKSPACE_SOURCES = new Set(["openclaw-workspace", "agents-skills-project"]);
export const WORKSHOP_WRITABLE_SOURCE = "openclaw-workshop";

type SkillTargetLike = {
  skillDir: string;
  skillFile: string;
  source?: string;
  authorizedRootRealPath?: string;
};

function matchingWorkshopRoots(filePath: string, config?: OpenClawConfig): string[] {
  const realPath = tryRealpath(filePath);
  if (!realPath) {
    return [];
  }
  return resolveSkillWorkshopConfig(config).writableRoots.filter((root) =>
    isPathInside(root, realPath),
  );
}

/** Returns the one configured real root that authorizes a discovered workshop target. */
export function resolveWorkshopTargetRoot(
  skill: Pick<SkillStatusEntry, "source" | "filePath">,
  config?: OpenClawConfig,
): string | undefined {
  if (skill.source !== WORKSHOP_WRITABLE_SOURCE) {
    return undefined;
  }
  const roots = matchingWorkshopRoots(skill.filePath, config);
  if (roots.length > 1) {
    throw new Error(
      `Skill target is ambiguous across configured writable roots: ${skill.filePath}`,
    );
  }
  return roots[0];
}

/** Resolves and authorizes an update target using the same policy as writable-skill listing. */
export function resolveWritableSkillTarget(params: {
  workspaceDir: string;
  skill: SkillStatusEntry;
  config?: OpenClawConfig;
}): string | undefined {
  if (WRITABLE_WORKSPACE_SOURCES.has(params.skill.source)) {
    assertInsideWorkspace(params.workspaceDir, params.skill.filePath, "skill file");
    assertInsideWorkspace(params.workspaceDir, params.skill.baseDir, "skill directory");
    assertSkillMarkdownTarget(params.skill.filePath);
    return undefined;
  }
  if (params.skill.source !== WORKSHOP_WRITABLE_SOURCE) {
    throw new Error(`Skill source is not writable by Skill Workshop: ${params.skill.source}`);
  }
  const root = resolveWorkshopTargetRoot(params.skill, params.config);
  if (!root) {
    throw new Error(
      `Skill target is not inside a configured writable root: ${params.skill.filePath}`,
    );
  }
  assertSkillMarkdownTarget(params.skill.filePath);
  return root;
}

/** Revalidates a persisted proposal target immediately before revision or apply. */
export function assertWritableProposalTarget(params: {
  workspaceDir: string;
  target: SkillTargetLike;
  config?: OpenClawConfig;
}): string[] {
  const { target } = params;
  if (WRITABLE_WORKSPACE_SOURCES.has(target.source ?? "")) {
    assertInsideWorkspace(params.workspaceDir, target.skillFile, "skill file");
    assertInsideWorkspace(params.workspaceDir, target.skillDir, "skill directory");
    assertSkillMarkdownTarget(target.skillFile);
    return [];
  }
  if (target.source !== WORKSHOP_WRITABLE_SOURCE) {
    throw new Error(`Skill source is not writable by Skill Workshop: ${target.source}`);
  }
  assertSkillMarkdownTarget(target.skillFile);
  const authorizedRoot = target.authorizedRootRealPath;
  if (!authorizedRoot) {
    throw new Error("Skill proposal is missing its authorized writable root.");
  }
  const configuredRoots = resolveSkillWorkshopConfig(params.config).writableRoots;
  if (!configuredRoots.includes(authorizedRoot)) {
    throw new Error("Skill proposal writable root is no longer authorized.");
  }
  const fileRealPath = tryRealpath(target.skillFile);
  const dirRealPath = tryRealpath(target.skillDir);
  if (
    !fileRealPath ||
    !dirRealPath ||
    !isPathInside(authorizedRoot, fileRealPath) ||
    !isPathInside(authorizedRoot, dirRealPath)
  ) {
    throw new Error("Skill proposal target escaped its authorized writable root.");
  }
  return [authorizedRoot];
}

export function isWritableSkillStatusEntry(params: {
  workspaceDir: string;
  skill: SkillStatusEntry;
  config?: OpenClawConfig;
}): boolean {
  try {
    resolveWritableSkillTarget(params);
    return true;
  } catch {
    return false;
  }
}

function assertSkillMarkdownTarget(filePath: string): void {
  if (filePath.split(/[\\/]/).pop() !== "SKILL.md") {
    throw new Error("Skill Workshop can only update SKILL.md targets.");
  }
}
