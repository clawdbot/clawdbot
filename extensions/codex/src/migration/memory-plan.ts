// Codex memory plans validate source/destination separation before exposing copy items.
import fs from "node:fs/promises";
import path from "node:path";
import { createMigrationItem, MIGRATION_REASON_TARGET_EXISTS } from "openclaw/plugin-sdk/migration";
import type { MigrationItem } from "openclaw/plugin-sdk/plugin-entry";
import {
  canonicalPathFromExistingAncestor,
  isPathInside,
} from "openclaw/plugin-sdk/security-runtime";
import type { CodexMemorySource } from "./source-files.js";

const MIGRATION_REASON_TARGET_NOT_REGULAR = "target is not a regular file";

async function lstatIfExists(filePath: string) {
  try {
    return await fs.lstat(filePath);
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? String((error as { code?: unknown }).code)
        : undefined;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return undefined;
    }
    throw error;
  }
}

async function assertSafeMemoryDestination(params: {
  source: string;
  workspaceDir: string;
  target: string;
}): Promise<void> {
  const [canonicalSource, canonicalWorkspace, canonicalTarget] = await Promise.all([
    fs.realpath(path.dirname(params.source)),
    canonicalPathFromExistingAncestor(params.workspaceDir),
    canonicalPathFromExistingAncestor(params.target),
  ]);
  if (!isPathInside(canonicalWorkspace, canonicalTarget)) {
    throw new Error("Codex memory import destination must stay in the selected workspace.");
  }
  if (
    isPathInside(canonicalSource, canonicalTarget) ||
    isPathInside(canonicalTarget, canonicalSource)
  ) {
    throw new Error("Codex memory source and OpenClaw import destination must be separate paths.");
  }
}

export async function buildCodexMemoryItems(params: {
  memoryFiles: readonly CodexMemorySource[];
  workspaceDir: string;
  overwrite?: boolean;
}): Promise<MigrationItem[]> {
  const items: MigrationItem[] = [];
  for (const memory of params.memoryFiles) {
    const target = path.join(
      params.workspaceDir,
      "memory",
      "imports",
      "codex",
      path.basename(memory.path),
    );
    const targetStat = await lstatIfExists(target);
    const targetExists = targetStat !== undefined;
    const targetNotRegular = targetExists && !targetStat.isFile();
    if (!targetNotRegular) {
      await assertSafeMemoryDestination({
        source: memory.path,
        workspaceDir: params.workspaceDir,
        target,
      });
    }
    const targetConflict = targetNotRegular || (targetExists && !params.overwrite);
    items.push(
      createMigrationItem({
        id: memory.id,
        kind: "memory",
        action: "copy",
        source: memory.path,
        target,
        status: targetConflict ? "conflict" : "planned",
        reason: targetNotRegular
          ? MIGRATION_REASON_TARGET_NOT_REGULAR
          : targetConflict
            ? MIGRATION_REASON_TARGET_EXISTS
            : undefined,
        message: "Copy consolidated Codex memory into the OpenClaw memory index.",
        details: {
          sourceType: "codex-memory",
          sourceLabel: memory.label,
          collectionId: "codex",
          collectionLabel: "Codex",
          relativePath: path.basename(memory.path),
        },
      }),
    );
  }
  return items;
}
