// Codex memory plans validate source/destination separation before exposing copy items.
import fs from "node:fs/promises";
import path from "node:path";
import { createMigrationItem, MIGRATION_REASON_TARGET_EXISTS } from "openclaw/plugin-sdk/migration";
import type { MigrationItem } from "openclaw/plugin-sdk/plugin-entry";
import {
  canonicalPathFromExistingAncestor,
  isPathInside,
} from "openclaw/plugin-sdk/security-runtime";
import { exists } from "./helpers.js";
import type { CodexMemorySource } from "./source-files.js";

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
    await assertSafeMemoryDestination({
      source: memory.path,
      workspaceDir: params.workspaceDir,
      target,
    });
    const targetExists = await exists(target);
    items.push(
      createMigrationItem({
        id: memory.id,
        kind: "memory",
        action: "copy",
        source: memory.path,
        target,
        status: targetExists && !params.overwrite ? "conflict" : "planned",
        reason: targetExists && !params.overwrite ? MIGRATION_REASON_TARGET_EXISTS : undefined,
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
