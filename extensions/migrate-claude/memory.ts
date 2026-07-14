// Migrate Claude plugin module implements memory behavior.
import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { createMigrationItem, MIGRATION_REASON_TARGET_EXISTS } from "openclaw/plugin-sdk/migration";
import type { MigrationItem } from "openclaw/plugin-sdk/plugin-entry";
import {
  canonicalPathFromExistingAncestor,
  isPathInside,
} from "openclaw/plugin-sdk/security-runtime";
import { exists } from "./helpers.js";
import {
  CLAUDE_AUTO_MEMORY_MAX_FILES,
  CLAUDE_AUTO_MEMORY_MAX_SCAN_ENTRIES,
  type ClaudeSource,
} from "./source.js";
import type { PlannedTargets } from "./targets.js";

async function addMemoryItem(params: {
  items: MigrationItem[];
  id: string;
  source?: string;
  target: string;
  sourceLabel: string;
  copyWhenMissing?: boolean;
  overwrite?: boolean;
}): Promise<void> {
  if (!params.source) {
    return;
  }
  const targetExists = await exists(params.target);
  const action = params.copyWhenMissing && !targetExists ? "copy" : "append";
  params.items.push(
    createMigrationItem({
      id: params.id,
      kind: ["AGENTS.md", "USER.md"].includes(path.basename(params.target))
        ? "workspace"
        : "memory",
      action,
      source: params.source,
      target: params.target,
      status: action === "copy" && targetExists && !params.overwrite ? "conflict" : "planned",
      reason:
        action === "copy" && targetExists && !params.overwrite
          ? MIGRATION_REASON_TARGET_EXISTS
          : undefined,
      details: { sourceLabel: params.sourceLabel },
    }),
  );
}

async function readMemoryDir(dir: string): Promise<Dirent[]> {
  try {
    return await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    throw new Error(`Unable to read Claude Code auto-memory directory: ${dir}`, {
      cause: error,
    });
  }
}

type MarkdownFileScan = {
  files: string[];
  truncatedBy?: "files" | "entries";
};

async function listMarkdownFiles(root: string, maxFiles: number): Promise<MarkdownFileScan> {
  const files: string[] = [];
  const pending = [""];
  let visited = 0;
  let truncatedBy: MarkdownFileScan["truncatedBy"];
  scan: while (pending.length > 0) {
    const relativeDir = pending.pop();
    if (relativeDir === undefined) {
      break;
    }
    for (const entry of await readMemoryDir(path.join(root, relativeDir))) {
      visited += 1;
      if (visited > CLAUDE_AUTO_MEMORY_MAX_SCAN_ENTRIES) {
        truncatedBy = "entries";
        break scan;
      }
      const relativePath = path.join(relativeDir, entry.name);
      if (entry.isDirectory()) {
        pending.push(relativePath);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
        files.push(relativePath);
        if (files.length > maxFiles) {
          truncatedBy = "files";
          break scan;
        }
      }
    }
  }
  return {
    files: files.toSorted((left, right) => left.localeCompare(right)),
    ...(truncatedBy ? { truncatedBy } : {}),
  };
}

function collectionSlug(label: string, id: string): string {
  const slug = label
    .normalize("NFKD")
    .replaceAll(/[^a-zA-Z0-9._-]+/gu, "-")
    .replaceAll(/^[._-]+|[._-]+$/gu, "")
    .slice(0, 72);
  return `${slug || "project"}-${id}`;
}

type MemoryDestinationBoundary = {
  source: string;
  workspace: string;
};

async function resolveMemoryDestinationBoundary(
  sourceRoot: string,
  workspaceDir: string,
): Promise<MemoryDestinationBoundary> {
  return {
    source: await fs.realpath(sourceRoot),
    workspace: await canonicalPathFromExistingAncestor(workspaceDir),
  };
}

async function assertSafeMemoryDestination(
  boundary: MemoryDestinationBoundary,
  target: string,
): Promise<void> {
  const canonicalTarget = await canonicalPathFromExistingAncestor(target);
  if (!isPathInside(boundary.workspace, canonicalTarget)) {
    throw new Error("Claude Code memory import destination must stay in the selected workspace.");
  }
  if (
    isPathInside(boundary.source, canonicalTarget) ||
    isPathInside(canonicalTarget, boundary.source)
  ) {
    throw new Error(
      "Claude Code auto-memory source and OpenClaw import destination must be separate directories.",
    );
  }
}

async function buildAutoMemoryItems(params: {
  source: ClaudeSource;
  targets: PlannedTargets;
  overwrite?: boolean;
}): Promise<MigrationItem[]> {
  const items: MigrationItem[] = [];
  for (const collection of params.source.autoMemorySources) {
    const destinationBoundary = await resolveMemoryDestinationBoundary(
      collection.path,
      params.targets.workspaceDir,
    );
    const targetRoot = path.join(
      params.targets.workspaceDir,
      "memory",
      "imports",
      "claude-code",
      collectionSlug(collection.label, collection.id),
    );
    await assertSafeMemoryDestination(destinationBoundary, targetRoot);
    const remaining = CLAUDE_AUTO_MEMORY_MAX_FILES - items.length;
    const scan = await listMarkdownFiles(collection.path, remaining);
    if (scan.truncatedBy) {
      const limit =
        scan.truncatedBy === "files"
          ? `${CLAUDE_AUTO_MEMORY_MAX_FILES} Markdown files across all collections`
          : `${CLAUDE_AUTO_MEMORY_MAX_SCAN_ENTRIES} filesystem entries in one collection`;
      throw new Error(
        `Claude Code auto-memory exceeds the safe import limit of ${limit}. Narrow or split the source memory before importing.`,
      );
    }
    const files = scan.files;
    for (const relativePath of files) {
      const source = path.join(collection.path, relativePath);
      const target = path.join(targetRoot, relativePath);
      await assertSafeMemoryDestination(destinationBoundary, target);
      const targetExists = await exists(target);
      items.push(
        createMigrationItem({
          id: `memory:claude-auto:${collection.id}:${relativePath.replaceAll(path.sep, "/")}`,
          kind: "memory",
          action: "copy",
          source,
          target,
          status: targetExists && !params.overwrite ? "conflict" : "planned",
          reason: targetExists && !params.overwrite ? MIGRATION_REASON_TARGET_EXISTS : undefined,
          message: "Copy Claude Code auto-memory Markdown into the OpenClaw memory index.",
          details: {
            sourceType: "claude-auto-memory",
            sourceLabel: "Claude Code auto-memory",
            collectionId: collection.id,
            collectionLabel: collection.label,
            collectionFileCount: files.length,
            relativePath: relativePath.replaceAll(path.sep, "/"),
          },
        }),
      );
    }
  }
  return items;
}

export async function buildMemoryItems(params: {
  source: ClaudeSource;
  targets: PlannedTargets;
  overwrite?: boolean;
  includeInstructions?: boolean;
}): Promise<MigrationItem[]> {
  const items: MigrationItem[] = [];
  if (params.includeInstructions !== false) {
    await addMemoryItem({
      items,
      id: "workspace:CLAUDE.md",
      source: params.source.projectMemoryPath,
      target: path.join(params.targets.workspaceDir, "AGENTS.md"),
      sourceLabel: "project CLAUDE.md",
      copyWhenMissing: true,
      overwrite: params.overwrite,
    });
    await addMemoryItem({
      items,
      id: "workspace:.claude/CLAUDE.md",
      source: params.source.projectDotClaudeMemoryPath,
      target: path.join(params.targets.workspaceDir, "AGENTS.md"),
      sourceLabel: "project .claude/CLAUDE.md",
      overwrite: params.overwrite,
    });
    await addMemoryItem({
      items,
      id: "memory:user-CLAUDE.md",
      source: params.source.userMemoryPath,
      target: path.join(params.targets.workspaceDir, "USER.md"),
      sourceLabel: "user ~/.claude/CLAUDE.md",
      overwrite: params.overwrite,
    });
  }
  items.push(...(await buildAutoMemoryItems(params)));
  return items;
}
