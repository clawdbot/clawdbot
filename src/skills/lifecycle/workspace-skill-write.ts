import fs from "node:fs/promises";
import path from "node:path";
import { pathExists, root } from "../../infra/fs-safe.js";
import { isPathInside } from "../../infra/path-safety.js";
import { findContainingAllowedSkillSymlinkTarget } from "../loading/symlink-targets.js";

const ALLOWED_SUPPORT_FILE_ROOTS = new Set(
  "assets examples references scripts templates".split(" "),
);
export const MAX_WORKSPACE_SKILL_SUPPORT_FILE_BYTES = 256 * 1024;

type WorkspaceSkillSymlinkWritePolicy = {
  allowWrites: boolean;
  allowedTargetRealPaths: readonly string[];
};
type WorkspaceSkillSupportFileWrite = { path: string; content: string };

type WorkspaceSkillWriteTargetParams = {
  workspaceDir: string;
  filePath: string;
  symlinkPolicy: WorkspaceSkillSymlinkWritePolicy;
};

type PreviousSupportFile = { path: string; existed: boolean; previousContent?: string };

export function normalizeWorkspaceSkillSupportPath(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("Support file path is required.");
  }
  if (trimmed.includes("\\")) {
    throw new Error("Support file paths must use forward slashes.");
  }
  if (path.posix.isAbsolute(trimmed)) {
    throw new Error("Support file paths must be relative.");
  }
  if (
    trimmed
      .split("/")
      .some((part) => !part || part === "." || part === ".." || part.startsWith("."))
  ) {
    throw new Error("Support file paths must use plain relative path segments.");
  }
  if (!ALLOWED_SUPPORT_FILE_ROOTS.has(trimmed.split("/")[0] ?? "")) {
    throw new Error(
      `Support file paths must be under one of: ${[...ALLOWED_SUPPORT_FILE_ROOTS].join(", ")}.`,
    );
  }
  if (trimmed === "PROPOSAL.md" || trimmed === "SKILL.md") {
    throw new Error("Support files cannot replace the proposal or skill markdown file.");
  }
  return trimmed;
}

export function assertWorkspaceSkillSupportPathSetIsFileOnly(paths: readonly string[]): void {
  const sorted = paths.toSorted((a, b) => a.localeCompare(b));
  for (const filePath of sorted) {
    if (!filePath.includes("/")) {
      throw new Error("Support file paths must include a file below an allowed support directory.");
    }
  }
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1];
    const current = sorted[index];
    if (previous && current?.startsWith(`${previous}/`)) {
      throw new Error(`Support file paths cannot overlap: ${previous} and ${current}`);
    }
  }
}

export async function readWorkspaceSkillFile(filePath: string): Promise<string | null> {
  if (!(await pathExists(filePath))) {
    return null;
  }
  const skillRoot = await root(path.dirname(filePath));
  const read = await skillRoot.read(path.basename(filePath), {
    hardlinks: "reject",
    maxBytes: 1024 * 1024,
    symlinks: "reject",
  });
  return read.buffer.toString("utf8");
}

export async function readWorkspaceSupportFile(params: {
  skillDir: string;
  relativePath: string;
}): Promise<string | null> {
  const relativePath = normalizeWorkspaceSkillSupportPath(params.relativePath);
  if (!(await pathExists(path.join(params.skillDir, ...relativePath.split("/"))))) {
    return null;
  }
  const skillRoot = await root(params.skillDir);
  const read = await skillRoot.read(relativePath, {
    hardlinks: "reject",
    maxBytes: MAX_WORKSPACE_SKILL_SUPPORT_FILE_BYTES,
    symlinks: "reject",
  });
  return read.buffer.toString("utf8");
}

export async function assertWorkspaceSkillWriteTarget(
  params: WorkspaceSkillWriteTargetParams,
): Promise<void> {
  await resolveWorkspaceSkillWriteTarget(params);
}

export async function writeWorkspaceSkill(params: {
  workspaceDir: string;
  skillDir: string;
  skillFile: string;
  content: string;
  supportFiles?: readonly WorkspaceSkillSupportFileWrite[];
  mode: "create" | "update";
  symlinkPolicy: WorkspaceSkillSymlinkWritePolicy;
}): Promise<void> {
  assertInsideWorkspace(params.workspaceDir, params.skillDir, "skill directory");
  const supportFiles = normalizeSupportFiles(params.supportFiles ?? []);
  const previousSupportFiles = await prepareWorkspaceSkillWrite({
    mode: params.mode,
    workspaceDir: params.workspaceDir,
    skillDir: params.skillDir,
    skillFile: params.skillFile,
    supportFiles,
    symlinkPolicy: params.symlinkPolicy,
  });
  const writtenSupportPaths: string[] = [];
  try {
    for (const file of supportFiles) {
      await writeWorkspaceFile({
        workspaceDir: params.workspaceDir,
        filePath: path.join(params.skillDir, ...file.path.split("/")),
        content: file.content,
        overwrite: params.mode === "update",
        symlinkPolicy: params.symlinkPolicy,
      });
      writtenSupportPaths.push(file.path);
    }
    await writeWorkspaceFile({
      workspaceDir: params.workspaceDir,
      filePath: params.skillFile,
      content: params.content,
      overwrite: params.mode === "update",
      symlinkPolicy: params.symlinkPolicy,
    });
  } catch (error) {
    await restoreSupportFilesAfterFailedWrite({
      mode: params.mode,
      workspaceDir: params.workspaceDir,
      skillDir: params.skillDir,
      writtenSupportPaths,
      previousSupportFiles,
      symlinkPolicy: params.symlinkPolicy,
    });
    throw error;
  }
}

function normalizeSupportFiles(
  supportFiles: readonly WorkspaceSkillSupportFileWrite[],
): WorkspaceSkillSupportFileWrite[] {
  const normalized = supportFiles.map((file) => ({
    ...file,
    path: normalizeWorkspaceSkillSupportPath(file.path),
  }));
  assertWorkspaceSkillSupportPathSetIsFileOnly(normalized.map((file) => file.path));
  return normalized;
}

async function prepareWorkspaceSkillWrite(params: {
  mode: "create" | "update";
  workspaceDir: string;
  skillDir: string;
  skillFile: string;
  supportFiles: readonly WorkspaceSkillSupportFileWrite[];
  symlinkPolicy: WorkspaceSkillSymlinkWritePolicy;
}): Promise<PreviousSupportFile[]> {
  await resolveWorkspaceSkillWriteTarget({
    workspaceDir: params.workspaceDir,
    filePath: params.skillFile,
    symlinkPolicy: params.symlinkPolicy,
  });
  const previousContent = await readWorkspaceSkillFile(params.skillFile);
  if (params.mode === "create" && previousContent !== null) {
    throw new Error(`Target skill already exists: ${params.skillFile}`);
  }
  if (params.mode === "update" && previousContent === null) {
    throw new Error(`Target skill is missing: ${params.skillFile}`);
  }

  const previousSupportFiles: PreviousSupportFile[] = [];
  for (const file of params.supportFiles) {
    const filePath = path.join(params.skillDir, ...file.path.split("/"));
    await resolveWorkspaceSkillWriteTarget({
      workspaceDir: params.workspaceDir,
      filePath,
      symlinkPolicy: params.symlinkPolicy,
    });
    if (params.mode === "update") {
      const previousSupportContent = await readWorkspaceSupportFile({
        skillDir: params.skillDir,
        relativePath: file.path,
      });
      previousSupportFiles.push(
        previousSupportContent === null
          ? { path: file.path, existed: false }
          : { path: file.path, existed: true, previousContent: previousSupportContent },
      );
    }
  }
  return previousSupportFiles;
}

async function writeWorkspaceFile(params: {
  workspaceDir: string;
  filePath: string;
  content: string;
  overwrite: boolean;
  symlinkPolicy: WorkspaceSkillSymlinkWritePolicy;
}): Promise<void> {
  const target = await resolveWorkspaceSkillWriteTarget(params);
  const targetRoot = await root(target.rootDir);
  await targetRoot.write(target.relativePath, params.content, {
    encoding: "utf8",
    mkdir: true,
    overwrite: params.overwrite,
  });
}

async function removeWorkspaceFile(params: {
  workspaceDir: string;
  filePath: string;
  symlinkPolicy: WorkspaceSkillSymlinkWritePolicy;
}): Promise<void> {
  const target = await resolveWorkspaceSkillWriteTarget(params);
  const targetRoot = await root(target.rootDir);
  await targetRoot.remove(target.relativePath).catch((error: unknown) => {
    if ((error as { code?: string })?.code !== "ENOENT") {
      throw error;
    }
  });
}

async function restoreSupportFilesAfterFailedWrite(params: {
  mode: "create" | "update";
  workspaceDir: string;
  skillDir: string;
  writtenSupportPaths: readonly string[];
  previousSupportFiles: readonly PreviousSupportFile[];
  symlinkPolicy: WorkspaceSkillSymlinkWritePolicy;
}): Promise<void> {
  const previousByPath = new Map(params.previousSupportFiles.map((file) => [file.path, file]));
  await Promise.allSettled(
    params.writtenSupportPaths.toReversed().map(async (relativePath) => {
      const filePath = path.join(params.skillDir, ...relativePath.split("/"));
      const previous = previousByPath.get(relativePath);
      if (params.mode === "update" && previous?.existed) {
        await writeWorkspaceFile({
          workspaceDir: params.workspaceDir,
          filePath,
          content: previous.previousContent ?? "",
          overwrite: true,
          symlinkPolicy: params.symlinkPolicy,
        });
      } else {
        await removeWorkspaceFile({
          workspaceDir: params.workspaceDir,
          filePath,
          symlinkPolicy: params.symlinkPolicy,
        });
      }
    }),
  );
}

async function resolveWorkspaceSkillWriteTarget(
  params: WorkspaceSkillWriteTargetParams,
): Promise<{ rootDir: string; relativePath: string }> {
  assertInsideWorkspace(params.workspaceDir, params.filePath, "skill file");
  const workspaceDir = path.resolve(params.workspaceDir);
  const filePath = path.resolve(params.filePath);
  const aliasTarget = await resolveWorkspaceAliasTarget({ workspaceDir, filePath });
  if (!aliasTarget) {
    return { rootDir: workspaceDir, relativePath: path.relative(workspaceDir, filePath) };
  }
  const allowedRoot = params.symlinkPolicy.allowWrites
    ? findContainingAllowedSkillSymlinkTarget(
        params.symlinkPolicy.allowedTargetRealPaths,
        aliasTarget.realTarget,
      )
    : null;
  if (!allowedRoot) {
    throw new Error(
      `Skill file resolves through an untrusted symlink target: ${params.filePath}. Configure skills.load.allowSymlinkTargets and enable skills.workshop.allowSymlinkTargetWrites for intentional Skill Workshop symlink writes.`,
    );
  }
  return {
    rootDir: allowedRoot,
    relativePath: path.relative(allowedRoot, aliasTarget.realTarget),
  };
}

async function resolveWorkspaceAliasTarget(params: {
  workspaceDir: string;
  filePath: string;
}): Promise<{ realTarget: string } | null> {
  const workspaceRealPath = (await tryRealpath(params.workspaceDir)) ?? params.workspaceDir;
  const realTarget = await resolveRealPathThroughExistingAncestors(
    params.workspaceDir,
    params.filePath,
  );
  return isPathInside(workspaceRealPath, realTarget) ? null : { realTarget };
}

async function resolveRealPathThroughExistingAncestors(
  workspaceDir: string,
  filePath: string,
): Promise<string> {
  const segments = path.relative(workspaceDir, filePath).split(path.sep).filter(Boolean);
  let lexicalCursor = workspaceDir;
  let realCursor = (await tryRealpath(workspaceDir)) ?? workspaceDir;
  for (const segment of segments) {
    lexicalCursor = path.join(lexicalCursor, segment);
    realCursor = (await tryRealpath(lexicalCursor)) ?? path.join(realCursor, segment);
  }
  return path.resolve(realCursor);
}

async function tryRealpath(filePath: string): Promise<string | null> {
  try {
    return await fs.realpath(filePath);
  } catch {
    return null;
  }
}

export function assertInsideWorkspace(
  workspaceDir: string,
  targetPath: string,
  label: string,
): void {
  const resolvedWorkspaceDir = path.resolve(workspaceDir);
  const resolvedTarget = path.resolve(targetPath);
  if (
    resolvedTarget !== resolvedWorkspaceDir &&
    !isPathInside(resolvedWorkspaceDir, resolvedTarget)
  ) {
    throw new Error(`${label} must stay inside the workspace.`);
  }
}
