import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { root } from "openclaw/plugin-sdk/memory-core-host-engine-fs";
// Doctor enumeration cold-loads this closure; memory-host-events pulls the
// event-store/kysely graph, so the path resolver loads lazily in async bodies.
import { resolveConfiguredWorkspaces } from "./doctor-workspaces.js";

export type LegacyMemoryHostEventSource =
  | {
      kind: "ready";
      workspaceDir: string;
      filePath: string;
      relativePath: string;
      root: Awaited<ReturnType<typeof root>>;
      storage: "active" | "claim" | "archive";
      archiveRelativePath?: string;
      generationKey?: string;
    }
  | {
      kind: "rejected";
      workspaceDir: string;
      filePath: string;
      reason: string;
    };

export type ReadyLegacyMemoryHostEventSource = Extract<
  LegacyMemoryHostEventSource,
  { kind: "ready" }
>;

function normalizeMemoryHostWorkspaceKey(workspaceDir: string): string {
  const resolved = path.resolve(workspaceDir).replace(/\\/g, "/");
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function memoryHostWorkspacePrefix(workspaceDir: string): string {
  return crypto
    .createHash("sha256")
    .update(normalizeMemoryHostWorkspaceKey(workspaceDir))
    .digest("hex")
    .slice(0, 24);
}

export async function collectLegacyMemoryHostEventSources(
  config: unknown,
  env: NodeJS.ProcessEnv,
): Promise<LegacyMemoryHostEventSource[]> {
  const { resolveMemoryHostEventLogPath } = await import("openclaw/plugin-sdk/memory-host-events");
  const sources: LegacyMemoryHostEventSource[] = [];
  const seenWorkspaces = new Set<string>();
  for (const workspaceDir of await resolveConfiguredWorkspaces(config, env)) {
    let canonicalWorkspaceDir = path.resolve(workspaceDir);
    let filePath = resolveMemoryHostEventLogPath(canonicalWorkspaceDir);
    try {
      const workspaceRoot = await root(workspaceDir, {
        hardlinks: "reject",
        // Legacy doctor import previously read the complete JSONL source.
        maxBytes: Number.MAX_SAFE_INTEGER,
        mkdir: false,
        symlinks: "reject",
      });
      canonicalWorkspaceDir = workspaceRoot.rootReal;
      if (seenWorkspaces.has(canonicalWorkspaceDir)) {
        continue;
      }
      seenWorkspaces.add(canonicalWorkspaceDir);
      filePath = resolveMemoryHostEventLogPath(canonicalWorkspaceDir);
      const relativePath = path.relative(canonicalWorkspaceDir, filePath);
      const directoryRelativePath = path.dirname(relativePath);
      if (!(await workspaceRoot.exists(directoryRelativePath))) {
        continue;
      }
      const directoryStat = await workspaceRoot.stat(directoryRelativePath);
      if (!directoryStat.isDirectory) {
        continue;
      }
      const baseName = path.basename(relativePath).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
      const archivePattern = new RegExp(`^${baseName}\\.migrated(?:\\.([2-9]|[1-9][0-9]+))?$`, "u");
      const claimPattern = new RegExp(
        `^\\.${baseName}\\.doctor-importing(?:\\.([2-9]|[1-9][0-9]+))?$`,
        "u",
      );
      const entries = await fs.readdir(path.join(workspaceRoot.rootReal, directoryRelativePath));
      const candidates: Array<{
        entry: string;
        storage: "active" | "claim" | "archive";
        generation: bigint | undefined;
      }> = [];
      for (const entry of entries) {
        if (entry === path.basename(relativePath)) {
          candidates.push({ entry, storage: "active", generation: undefined });
          continue;
        }
        const claim = claimPattern.exec(entry);
        if (claim) {
          candidates.push({ entry, storage: "claim", generation: BigInt(claim[1] ?? "1") });
          continue;
        }
        const archive = archivePattern.exec(entry);
        if (archive) {
          candidates.push({ entry, storage: "archive", generation: BigInt(archive[1] ?? "1") });
        }
      }
      candidates.sort((left, right) => {
        if (left.generation === undefined) {
          return 1;
        }
        if (right.generation === undefined) {
          return -1;
        }
        return left.generation < right.generation ? -1 : left.generation > right.generation ? 1 : 0;
      });
      for (const candidate of candidates) {
        const candidateRelativePath = path.join(directoryRelativePath, candidate.entry);
        filePath = path.join(canonicalWorkspaceDir, candidateRelativePath);
        const stat = await workspaceRoot.stat(candidateRelativePath);
        if (!stat.isFile) {
          continue;
        }
        const generationText = candidate.generation?.toString();
        const generationKey = generationText?.padStart(20, "0");
        sources.push({
          kind: "ready",
          workspaceDir: canonicalWorkspaceDir,
          filePath,
          relativePath: candidateRelativePath,
          root: workspaceRoot,
          storage: candidate.storage,
          ...(candidate.storage === "active"
            ? {}
            : {
                archiveRelativePath: `${relativePath}.migrated${candidate.generation === 1n ? "" : `.${candidate.generation}`}`,
                generationKey,
              }),
        });
      }
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (code === "ENOENT" || code === "ENOTDIR" || code === "not-found") {
        continue;
      }
      if (!seenWorkspaces.has(canonicalWorkspaceDir)) {
        seenWorkspaces.add(canonicalWorkspaceDir);
      }
      sources.push({
        kind: "rejected",
        workspaceDir: canonicalWorkspaceDir,
        filePath,
        reason: `Skipped unsafe Memory Core host event source ${filePath}: ${String(error)}. Check permissions and use regular files and directories inside the workspace, then rerun openclaw doctor --fix. For shared notes, use canonical paths in memory.search.extraPaths; this does not migrate legacy events.`,
      });
    }
  }
  return sources;
}

export async function resolveMemoryHostEventArchivePath(
  source: ReadyLegacyMemoryHostEventSource,
): Promise<{ archiveRelativePath: string; claimRelativePath: string; generationKey: string }> {
  const { resolveMemoryHostEventLogPath } = await import("openclaw/plugin-sdk/memory-host-events");
  const activeRelativePath = path.relative(
    source.workspaceDir,
    resolveMemoryHostEventLogPath(source.workspaceDir),
  );
  const directoryPath = path.join(source.root.rootReal, path.dirname(activeRelativePath));
  const baseName = path.basename(activeRelativePath).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const archivePattern = new RegExp(`^${baseName}\\.migrated(?:\\.([2-9]|[1-9][0-9]+))?$`, "u");
  const claimPattern = new RegExp(
    `^\\.${baseName}\\.doctor-importing(?:\\.([2-9]|[1-9][0-9]+))?$`,
    "u",
  );
  let latestGeneration = 0n;
  for (const entry of await fs.readdir(directoryPath)) {
    const match = archivePattern.exec(entry) ?? claimPattern.exec(entry);
    if (!match) {
      continue;
    }
    const generation = BigInt(match[1] ?? "1");
    if (generation > latestGeneration) {
      latestGeneration = generation;
    }
  }
  const generation = latestGeneration + 1n;
  const generationText = generation.toString();
  if (generationText.length > 20) {
    throw new RangeError("Memory Core host event archive generation is too large");
  }
  const generationSuffix = generation === 1n ? "" : `.${generation}`;
  return {
    archiveRelativePath: `${activeRelativePath}.migrated${generationSuffix}`,
    claimRelativePath: path.join(
      path.dirname(activeRelativePath),
      `.${path.basename(activeRelativePath)}.doctor-importing${generationSuffix}`,
    ),
    // Fixed-width decimal order keeps key-range reads chronological across archives.
    generationKey: generationText.padStart(20, "0"),
  };
}
