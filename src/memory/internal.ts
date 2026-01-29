import crypto from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

export type MemoryFileEntry = {
  path: string;
  absPath: string;
  mtimeMs: number;
  size: number;
  hash: string;
};

export type MemoryChunk = {
  startLine: number;
  endLine: number;
  text: string;
  hash: string;
};

export function ensureDir(dir: string): string {
  try {
    fsSync.mkdirSync(dir, { recursive: true });
  } catch {}
  return dir;
}

export function normalizeRelPath(value: string): string {
  const trimmed = value.trim().replace(/^[./]+/, "");
  return trimmed.replace(/\\/g, "/");
}

export function isMemoryPath(relPath: string): boolean {
  const normalized = normalizeRelPath(relPath);
  if (!normalized) return false;
  if (normalized === "MEMORY.md" || normalized === "memory.md") return true;
  return normalized.startsWith("memory/");
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function walkDir(
  dir: string,
  files: string[],
  workspaceDir: string,
  logger?: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string, err?: unknown) => void;
  },
) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkDir(full, files, workspaceDir, logger);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(".md")) continue;

    // Check if this is an old-format file in memory/ root
    const relPath = path.relative(workspaceDir, full).replace(/\\/g, "/");
    if (isOldMemoryFormat(relPath)) {
      // Auto-migrate to new format
      const result = await migrateMemoryFile(full, workspaceDir, logger);
      if (result.status !== "failed") {
        files.push(result.path);
      }
      continue;
    }

    files.push(full);
  }
}

/**
 * Check if a path matches old memory format (memory/YYYY-MM-DD.md)
 * Old format = files directly in memory/ directory, not in subdirectories
 */
export function isOldMemoryFormat(relPath: string): boolean {
  // Matches: memory/2025-01-27.md or memory/2025-01-27-slug.md
  // But NOT: memory/2025/01/2025-01-27.md (new hierarchical format)
  // But NOT: memory/notes/2025-01-27.md (user subdirectory)
  const oldFormatRegex = /^memory\/\d{4}-\d{2}-\d{2}(?:-[^./]+)?\.md$/;
  return oldFormatRegex.test(relPath);
}

/**
 * Result of migrating a memory file
 */
export type MigrationResult =
  | { status: "migrated"; path: string }
  | { status: "skipped"; path: string }
  | { status: "failed" };

/**
 * Migrate an old-format memory file to new hierarchical structure
 * @param oldPath Absolute path to old-format file
 * @param workspaceDir Workspace directory
 * @param logger Optional logger for migration messages
 * @returns MigrationResult with status and path
 */
export async function migrateMemoryFile(
  oldPath: string,
  workspaceDir: string,
  logger?: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string, err?: unknown) => void;
  },
): Promise<MigrationResult> {
  const log = logger || { info: console.log, warn: console.warn, error: console.error };

  try {
    const filename = path.basename(oldPath);
    const match = filename.match(/^(\d{4})-(\d{2})-(\d{2})(?:-.*)?\.md$/);

    if (!match) {
      log.error(`[memory] Invalid filename format for migration: ${filename}`);
      return { status: "failed" };
    }

    const [, year, month, day] = match;

    // Validate date (prevent invalid dates like 2025-99-99)
    const dateStr = `${year}-${month}-${day}`;
    const parsedDate = new Date(dateStr);
    if (isNaN(parsedDate.getTime()) || parsedDate.toISOString().split("T")[0] !== dateStr) {
      log.error(`[memory] Invalid date in filename: ${filename} (parsed: ${dateStr})`);
      return { status: "failed" };
    }

    const newDir = path.join(workspaceDir, "memory", year, month);

    // Ensure new directory exists
    await fs.mkdir(newDir, { recursive: true });

    const newPath = path.join(newDir, filename);

    // Check if new file already exists
    if (await exists(newPath)) {
      // New file exists, keep it and skip migration
      log.warn(`[memory] New format file exists, skipping migration: ${filename}`);
      return { status: "skipped", path: newPath };
    }

    // Atomic file creation with exclusive flag to prevent race conditions
    let fileHandle;
    try {
      // Try to open file exclusively (fails if exists)
      fileHandle = await fs.open(newPath, "wx");
      await fileHandle.close();
    } catch (err: any) {
      if (err.code === "EEXIST") {
        // Another process created it first
        log.warn(`[memory] File created by another process, skipping: ${filename}`);
        return { status: "skipped", path: newPath };
      }
      throw err;
    }

    // Copy file content to new location
    await fs.copyFile(oldPath, newPath);

    // Optional: Remove old file after successful migration
    // For now, keep both as backup
    log.info(
      `[memory] Migrated old-format memory file: ${filename} -> memory/${year}/${month}/${filename}`,
    );

    return { status: "migrated", path: newPath };
  } catch (err) {
    log.error(`[memory] Failed to migrate memory file: ${path.basename(oldPath)}`, err);
    return { status: "failed" };
  }
}

export async function listMemoryFiles(
  workspaceDir: string,
  logger?: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string, err?: unknown) => void;
  },
): Promise<string[]> {
  const result: string[] = [];
  const memoryFile = path.join(workspaceDir, "MEMORY.md");
  const altMemoryFile = path.join(workspaceDir, "memory.md");
  if (await exists(memoryFile)) result.push(memoryFile);
  if (await exists(altMemoryFile)) result.push(altMemoryFile);
  const memoryDir = path.join(workspaceDir, "memory");
  if (await exists(memoryDir)) {
    await walkDir(memoryDir, result, workspaceDir, logger);
  }
  if (result.length <= 1) return result;
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const entry of result) {
    let key = entry;
    try {
      key = await fs.realpath(entry);
    } catch {}
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(entry);
  }
  return deduped;
}

export function hashText(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export async function buildFileEntry(
  absPath: string,
  workspaceDir: string,
): Promise<MemoryFileEntry> {
  const stat = await fs.stat(absPath);
  const content = await fs.readFile(absPath, "utf-8");
  const hash = hashText(content);
  return {
    path: path.relative(workspaceDir, absPath).replace(/\\/g, "/"),
    absPath,
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    hash,
  };
}

export function chunkMarkdown(
  content: string,
  chunking: { tokens: number; overlap: number },
): MemoryChunk[] {
  const lines = content.split("\n");
  if (lines.length === 0) return [];
  const maxChars = Math.max(32, chunking.tokens * 4);
  const overlapChars = Math.max(0, chunking.overlap * 4);
  const chunks: MemoryChunk[] = [];

  let current: Array<{ line: string; lineNo: number }> = [];
  let currentChars = 0;

  const flush = () => {
    if (current.length === 0) return;
    const firstEntry = current[0];
    const lastEntry = current[current.length - 1];
    if (!firstEntry || !lastEntry) return;
    const text = current.map((entry) => entry.line).join("\n");
    const startLine = firstEntry.lineNo;
    const endLine = lastEntry.lineNo;
    chunks.push({
      startLine,
      endLine,
      text,
      hash: hashText(text),
    });
  };

  const carryOverlap = () => {
    if (overlapChars <= 0 || current.length === 0) {
      current = [];
      currentChars = 0;
      return;
    }
    let acc = 0;
    const kept: Array<{ line: string; lineNo: number }> = [];
    for (let i = current.length - 1; i >= 0; i -= 1) {
      const entry = current[i];
      if (!entry) continue;
      acc += entry.line.length + 1;
      kept.unshift(entry);
      if (acc >= overlapChars) break;
    }
    current = kept;
    currentChars = kept.reduce((sum, entry) => sum + entry.line.length + 1, 0);
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const lineNo = i + 1;
    const segments: string[] = [];
    if (line.length === 0) {
      segments.push("");
    } else {
      for (let start = 0; start < line.length; start += maxChars) {
        segments.push(line.slice(start, start + maxChars));
      }
    }
    for (const segment of segments) {
      const lineSize = segment.length + 1;
      if (currentChars + lineSize > maxChars && current.length > 0) {
        flush();
        carryOverlap();
      }
      current.push({ line: segment, lineNo });
      currentChars += lineSize;
    }
  }
  flush();
  return chunks;
}

export function parseEmbedding(raw: string): number[] {
  try {
    const parsed = JSON.parse(raw) as number[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const len = Math.min(a.length, b.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < len; i += 1) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export type MigrateAllOptions = {
  /** If true, only simulate migration without actual file operations */
  dryRun?: boolean;
  /** Optional logger for migration messages */
  logger?: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string, err?: unknown) => void;
  };
};

export type MigrateAllResult = {
  migrated: number;
  skipped: number;
  failed: number;
  /** Total bytes migrated */
  totalBytes: number;
  /** Migration duration in milliseconds */
  durationMs: number;
  /** List of migrated file paths (relative to workspace) */
  migratedFiles: string[];
  /** List of failed file paths with error messages */
  failedFiles: Array<{ path: string; error: string }>;
};

/**
 * Recursively find all old-format memory files in a directory
 */
async function findOldFormatFiles(
  dir: string,
  workspaceDir: string,
  results: string[] = [],
): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const memoryDir = path.join(workspaceDir, "memory");

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        // Skip year directories (already new format) only in memory/ root
        const isMemoryRoot = path.normalize(dir) === path.normalize(memoryDir);
        if (isMemoryRoot && /^\d{4}$/.test(entry.name)) {
          continue;
        }
        // Recurse into all other subdirectories
        await findOldFormatFiles(fullPath, workspaceDir, results);
        continue;
      }

      if (entry.isFile() && entry.name.endsWith(".md")) {
        const relPath = path.relative(workspaceDir, fullPath).replace(/\\/g, "/");
        if (isOldMemoryFormat(relPath)) {
          results.push(fullPath);
        }
      }
    }
  } catch {
    // Ignore permission errors and continue
  }
  return results;
}

/**
 * Migrate all old-format memory files in a workspace
 * @param workspaceDir Workspace directory
 * @param options Migration options (dry-run, logger)
 * @returns Object with detailed migration results
 */
export async function migrateAllMemoryFiles(
  workspaceDir: string,
  options: MigrateAllOptions = {},
): Promise<MigrateAllResult> {
  const { dryRun = false, logger } = options;
  const log = logger || { info: console.log, warn: console.warn, error: console.error };

  const startTime = Date.now();
  const memoryDir = path.join(workspaceDir, "memory");

  if (!(await exists(memoryDir))) {
    return {
      migrated: 0,
      skipped: 0,
      failed: 0,
      totalBytes: 0,
      durationMs: Date.now() - startTime,
      migratedFiles: [],
      failedFiles: [],
    };
  }

  // Find all old-format files recursively
  const oldFiles = await findOldFormatFiles(memoryDir, workspaceDir);

  if (oldFiles.length === 0) {
    log.info(`[memory] No old-format files found in ${memoryDir}`);
    return {
      migrated: 0,
      skipped: 0,
      failed: 0,
      totalBytes: 0,
      durationMs: Date.now() - startTime,
      migratedFiles: [],
      failedFiles: [],
    };
  }

  log.info(`[memory] Found ${oldFiles.length} old-format file(s) to migrate`);
  if (dryRun) {
    log.info(`[memory] DRY RUN: No files will be actually migrated`);
  }

  let migrated = 0;
  let skipped = 0;
  let failed = 0;
  let totalBytes = 0;
  const migratedFiles: string[] = [];
  const failedFiles: Array<{ path: string; error: string }> = [];

  for (const fullPath of oldFiles) {
    const relPath = path.relative(workspaceDir, fullPath).replace(/\\/g, "/");

    if (dryRun) {
      // In dry-run mode, just check if target exists
      const filename = path.basename(fullPath);
      const match = filename.match(/^(\d{4})-(\d{2})-(\d{2})(?:-.*)?\.md$/);
      if (match) {
        const [, year, month] = match;
        const newPath = path.join(workspaceDir, "memory", year, month, filename);
        if (await exists(newPath)) {
          log.info(`[memory] [DRY RUN] Would skip (exists): ${relPath}`);
          skipped++;
        } else {
          log.info(
            `[memory] [DRY RUN] Would migrate: ${relPath} -> memory/${year}/${month}/${filename}`,
          );
          migrated++;
          try {
            const stat = await fs.stat(fullPath);
            totalBytes += stat.size;
          } catch {}
        }
      }
      continue;
    }

    // Actual migration
    try {
      const stat = await fs.stat(fullPath);
      const result = await migrateMemoryFile(fullPath, workspaceDir, logger);

      if (result.status === "skipped") {
        skipped++;
      } else if (result.status === "migrated") {
        migrated++;
        totalBytes += stat.size;
        migratedFiles.push(path.relative(workspaceDir, result.path).replace(/\\/g, "/"));
      } else {
        failed++;
        failedFiles.push({ path: relPath, error: "Migration failed" });
      }
    } catch (err) {
      failed++;
      const errorMsg = err instanceof Error ? err.message : String(err);
      failedFiles.push({ path: relPath, error: errorMsg });
      log.error(`[memory] Failed to migrate ${relPath}:`, err);
    }
  }

  const durationMs = Date.now() - startTime;

  log.info(
    `[memory] Migration complete: ${migrated} migrated, ${skipped} skipped, ${failed} failed (${durationMs}ms, ${totalBytes} bytes)`,
  );

  return {
    migrated,
    skipped,
    failed,
    totalBytes,
    durationMs,
    migratedFiles,
    failedFiles,
  };
}
