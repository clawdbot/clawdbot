import fs from "node:fs/promises";
import path from "node:path";
import { sha256Hex } from "../../infra/crypto-digest.js";
import { removePathWithinRoot } from "../../infra/fs-safe-remove.js";
import { pathExists, root, walkDirectory } from "../../infra/fs-safe.js";
import { scanSkillContent, scanSource } from "../security/scanner.js";
import { restoreSkillCollectionBackup } from "./collection-rollback.js";
import {
  isUtf8Buffer,
  MAX_EVALUATION_BUNDLE_BYTES,
  MAX_EVALUATION_FILE_BYTES,
} from "./proposal-bundle.js";

export const MAX_WORKSHOP_REVIEW_ENTRIES = 10_000;
const MAX_WORKSHOP_REVIEW_DEPTH = 6;

export type WorkshopReviewSkillFile = {
  kind: "file" | "symlink";
  relativeDir: string;
  relativePath: string;
  filePath: string;
  contentHash: string;
};

export async function inspectWorkshopReviewTree(params: {
  skillsRoot: string;
  backupDir: string;
  beforeFiles: ReadonlyMap<string, WorkshopReviewSkillFile>;
  beforeLoadedDirs: ReadonlySet<string>;
  resolveAfterLoadedDirs: () => Promise<ReadonlySet<string>>;
  assertCurrent: () => void;
}): Promise<{
  afterFiles: Map<string, WorkshopReviewSkillFile>;
  reviewErrors: string[];
}> {
  const afterFiles = await snapshotWorkshopSkillFiles(params.skillsRoot, params.beforeLoadedDirs);
  const beforeFileDirs = new Set([...params.beforeFiles.values()].map((file) => file.relativeDir));
  const afterFileDirs = new Set([...afterFiles.values()].map((file) => file.relativeDir));
  const revertedDirs = new Set<string>();
  const reviewErrors: string[] = [];
  const changedPaths = new Set(
    [...new Set([...params.beforeFiles.keys(), ...afterFiles.keys()])].filter(
      (relativePath) =>
        params.beforeFiles.get(relativePath)?.kind !== afterFiles.get(relativePath)?.kind ||
        params.beforeFiles.get(relativePath)?.contentHash !==
          afterFiles.get(relativePath)?.contentHash,
    ),
  );
  const changedDirs = new Set(
    [...params.beforeFiles.values(), ...afterFiles.values()]
      .filter((file) => changedPaths.has(file.relativePath))
      .map((file) => file.relativeDir),
  );
  const changedFiles = [...afterFiles.values()].filter((file) =>
    changedPaths.has(file.relativePath),
  );
  const criticalFilesByDir = new Map<string, WorkshopReviewSkillFile>();
  const skillsRootAccess = await root(params.skillsRoot);
  for (const file of changedFiles) {
    params.assertCurrent();
    const restorePath = file.relativeDir === "." ? file.relativePath : file.relativeDir;
    if (file.kind === "symlink") {
      // Unlink every changed link before restoring its directory; removing only
      // the first link would make the safe directory remover reject the next one.
      await fs.rm(file.filePath, { force: true });
      if (!criticalFilesByDir.has(restorePath)) {
        criticalFilesByDir.set(restorePath, file);
      }
      continue;
    }
    const findings = await scanWorkshopReviewFile(file, skillsRootAccess);
    if (findings.some((finding) => finding.severity === "critical")) {
      if (!criticalFilesByDir.has(restorePath)) {
        criticalFilesByDir.set(restorePath, file);
      }
    }
  }
  for (const { relativeDir, relativePath, kind } of criticalFilesByDir.values()) {
    params.assertCurrent();
    await restoreWorkshopReviewPath({
      skillsRoot: params.skillsRoot,
      backupDir: params.backupDir,
      relativeDir,
      relativePath,
      existedBefore:
        relativeDir === "."
          ? params.beforeFiles.has(relativePath)
          : beforeFileDirs.has(relativeDir),
    });
    revertedDirs.add(relativeDir);
    reviewErrors.push(
      kind === "symlink"
        ? `review created a symbolic link at ${relativePath}`
        : `security scan rejected ${relativePath}`,
    );
  }
  const afterLoadedDirs = await params.resolveAfterLoadedDirs();
  for (const [relativeDir, relativePath] of beforeFilesByDirectory(params.beforeFiles)) {
    if (
      !changedDirs.has(relativeDir) ||
      relativeDir === "." ||
      afterFileDirs.has(relativeDir) ||
      params.beforeLoadedDirs.has(relativeDir)
    ) {
      continue;
    }
    params.assertCurrent();
    await restoreWorkshopReviewPath({
      skillsRoot: params.skillsRoot,
      backupDir: params.backupDir,
      relativeDir,
      relativePath,
      existedBefore: true,
    });
    revertedDirs.add(relativeDir);
    reviewErrors.push(`review removed ${relativeDir}, which was not a loaded skill`);
  }
  const afterSkillDirs = new Set(
    [...afterFiles.values()]
      .filter((file) => file.relativePath === path.join(file.relativeDir, "SKILL.md"))
      .map((file) => file.relativeDir),
  );
  for (const relativeDir of afterSkillDirs) {
    if (
      relativeDir === "." ||
      afterLoadedDirs.has(relativeDir) ||
      revertedDirs.has(relativeDir) ||
      params.beforeLoadedDirs.has(relativeDir) ||
      beforeFileDirs.has(relativeDir)
    ) {
      continue;
    }
    params.assertCurrent();
    await restoreWorkshopReviewPath({
      skillsRoot: params.skillsRoot,
      backupDir: params.backupDir,
      relativeDir,
      relativePath: path.join(relativeDir, "SKILL.md"),
      existedBefore: false,
    });
    revertedDirs.add(relativeDir);
    reviewErrors.push(`review created ${relativeDir} with an unloadable SKILL.md`);
  }
  for (const file of afterFiles.values()) {
    if (
      file.relativeDir === "." ||
      !changedDirs.has(file.relativeDir) ||
      afterLoadedDirs.has(file.relativeDir) ||
      revertedDirs.has(file.relativeDir) ||
      (!params.beforeLoadedDirs.has(file.relativeDir) && !beforeFileDirs.has(file.relativeDir))
    ) {
      continue;
    }
    params.assertCurrent();
    await restoreWorkshopReviewPath({
      skillsRoot: params.skillsRoot,
      backupDir: params.backupDir,
      relativeDir: file.relativeDir,
      relativePath: file.relativePath,
      existedBefore:
        file.relativeDir === "."
          ? params.beforeFiles.has(file.relativePath)
          : beforeFileDirs.has(file.relativeDir),
    });
    revertedDirs.add(file.relativeDir);
    reviewErrors.push(`review left ${file.relativeDir} unloadable`);
  }
  return {
    afterFiles:
      revertedDirs.size > 0 ? await snapshotWorkshopSkillFiles(params.skillsRoot) : afterFiles,
    reviewErrors,
  };
}

function beforeFilesByDirectory(
  beforeFiles: ReadonlyMap<string, WorkshopReviewSkillFile>,
): Map<string, string> {
  const files = new Map<string, string>();
  for (const file of beforeFiles.values()) {
    if (!files.has(file.relativeDir)) {
      files.set(file.relativeDir, file.relativePath);
    }
  }
  return files;
}

export async function snapshotWorkshopSkillFiles(
  skillsRoot: string,
  knownSkillDirs: ReadonlySet<string> = new Set(),
): Promise<Map<string, WorkshopReviewSkillFile>> {
  const walked = await walkDirectory(skillsRoot, {
    // fs-safe silently stops at maxDepth. Probe one extra level to reject
    // deeper mutations instead of accepting an incomplete snapshot (2026-09-05).
    maxDepth: MAX_WORKSHOP_REVIEW_DEPTH + 1,
    maxEntries: MAX_WORKSHOP_REVIEW_ENTRIES,
    symlinks: "include",
  });
  const exceedsInventory =
    walked.truncated || walked.entries.some((entry) => entry.depth > MAX_WORKSHOP_REVIEW_DEPTH);
  if (exceedsInventory || walked.failedDirs.length > 0) {
    throw new Error(
      exceedsInventory
        ? "Skill collection review inventory exceeds 10,000 entries or six directory levels. Split or prune the Workshop directory by hand, then run the review again."
        : "Could not fully inspect the Skill Workshop directory.",
    );
  }
  const skillsRootAccess = await root(skillsRoot);
  // A deleted manifest must not detach surviving support files from their skill.
  const skillDirs = new Set([
    ...knownSkillDirs,
    ...walked.entries
      .filter((entry) => entry.kind === "file" && entry.name === "SKILL.md")
      .map((entry) => path.dirname(entry.relativePath)),
  ]);
  const snapshots: WorkshopReviewSkillFile[] = [];
  let totalBytes = 0;
  // Read one file at a time so in-flight buffers and the aggregate snapshot stay bounded.
  for (const entry of walked.entries.toSorted((left, right) =>
    left.relativePath.localeCompare(right.relativePath),
  )) {
    if (entry.kind !== "file" && entry.kind !== "symlink") {
      continue;
    }
    if (entry.kind === "symlink") {
      const linkTarget = await fs.readlink(entry.path, "utf8");
      snapshots.push({
        kind: "symlink",
        relativeDir: resolveWorkshopSkillDirectory(entry.relativePath, skillDirs),
        relativePath: entry.relativePath,
        filePath: entry.path,
        contentHash: sha256Hex(Buffer.from(linkTarget)),
      });
      continue;
    }
    const read = await skillsRootAccess.read(entry.relativePath, {
      hardlinks: "reject",
      maxBytes: MAX_EVALUATION_FILE_BYTES,
      symlinks: "reject",
    });
    totalBytes += read.buffer.byteLength;
    if (totalBytes > MAX_EVALUATION_BUNDLE_BYTES) {
      throw new Error(
        `Skill collection review inventory exceeds ${MAX_EVALUATION_BUNDLE_BYTES} total bytes.`,
      );
    }
    snapshots.push({
      kind: "file",
      relativeDir: resolveWorkshopSkillDirectory(entry.relativePath, skillDirs),
      relativePath: entry.relativePath,
      filePath: entry.path,
      contentHash: sha256Hex(read.buffer),
    });
  }
  return new Map(snapshots.map((snapshot) => [snapshot.relativePath, snapshot]));
}

function resolveWorkshopSkillDirectory(
  relativePath: string,
  skillDirs: ReadonlySet<string>,
): string {
  const ownDirectory = path.dirname(relativePath);
  let directory = ownDirectory;
  while (directory !== ".") {
    if (skillDirs.has(directory)) {
      return directory;
    }
    const parent = path.dirname(directory);
    if (parent === directory) {
      break;
    }
    directory = parent;
  }
  return ownDirectory;
}

async function scanWorkshopReviewFile(
  file: WorkshopReviewSkillFile,
  skillsRootAccess: Awaited<ReturnType<typeof root>>,
) {
  const read = await skillsRootAccess.read(file.relativePath, {
    hardlinks: "reject",
    maxBytes: MAX_EVALUATION_FILE_BYTES,
    symlinks: "reject",
  });
  if (!isUtf8Buffer(read.buffer)) {
    return [];
  }
  const content = read.buffer.toString("utf8");
  return [...scanSkillContent(content, file.filePath), ...scanSource(content, file.filePath)];
}

async function restoreWorkshopReviewPath(params: {
  skillsRoot: string;
  backupDir: string;
  relativeDir: string;
  relativePath: string;
  existedBefore: boolean;
}): Promise<void> {
  if (params.relativeDir !== ".") {
    await restoreSkillCollectionBackup({
      skillsRoot: params.skillsRoot,
      backupDir: params.backupDir,
      skillDirs: params.existedBefore ? [params.relativeDir] : [],
      resultSkillDirs: [params.relativeDir],
    });
    return;
  }
  // Root-level files are not skills, but critical stray files still need per-file reversion.
  const livePath = path.join(params.skillsRoot, params.relativePath);
  if (await pathExists(livePath)) {
    await removePathWithinRoot({
      rootDir: params.skillsRoot,
      relativePath: params.relativePath,
      recursive: false,
      force: true,
    });
  }
  if (params.existedBefore) {
    await fs.cp(path.join(params.backupDir, "skills", params.relativePath), livePath, {
      errorOnExist: true,
      force: false,
      preserveTimestamps: true,
    });
  }
}
