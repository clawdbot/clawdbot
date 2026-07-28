// Read-only persisted memory enumeration for operator-read clients.
// Lists the default agent workspace memory area (memory/<YYYY-MM-DD>.md
// daily files plus the optional root MEMORY.md) so desktop/control clients
// can see what the agent has persisted without an in-turn tool call.
// Deliberately no write/delete/mutation surface.
import fs from "node:fs/promises";
import path from "node:path";
import {
  ErrorCodes,
  errorShape,
  type MemoryFileEntry,
  validateMemoryListParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";
import { toUpdatedAtMs } from "./workspace-fs.js";

const DEFAULT_LIST_LIMIT = 90;
const MAX_LIST_LIMIT = 366;
const DEFAULT_CONTENT_MAX_BYTES = 64 * 1024;
const MAX_CONTENT_MAX_BYTES = 256 * 1024;

// Daily memory files: memory/<YYYY-MM-DD>.md and slugged variants such as
// memory/<YYYY-MM-DD>-<slug>.md.
const DAILY_MEMORY_FILE_PATTERN = /^\d{4}-\d{2}-\d{2}(?:-.+)?\.md$/;
const ROOT_MEMORY_FILE_NAME = "MEMORY.md";

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(Math.max(Math.trunc(value), min), max);
}

function toWorkspaceRelativePath(...segments: string[]): string {
  // Advertise posix-style workspace-relative paths regardless of host OS.
  return path.posix.join(...segments);
}

/** Newest-first: date prefix descending, then name ascending so the plain daily file leads its slugged siblings. */
function compareDailyFileNames(a: string, b: string): number {
  const dateA = a.slice(0, 10);
  const dateB = b.slice(0, 10);
  if (dateA !== dateB) {
    return dateA < dateB ? 1 : -1;
  }
  // Plain daily files lead their slugged siblings for the same date
  // ("-" sorts before "." lexicographically, so compare slugs explicitly).
  const slugA = a.slice(10);
  const slugB = b.slice(10);
  const plainA = slugA === ".md";
  const plainB = slugB === ".md";
  if (plainA !== plainB) {
    return plainA ? -1 : 1;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

async function readBoundedContent(
  absolutePath: string,
  sizeBytes: number,
  maxBytes: number,
): Promise<{ content: string; truncated: boolean }> {
  if (sizeBytes <= maxBytes) {
    const buffer = await fs.readFile(absolutePath);
    return { content: buffer.toString("utf8"), truncated: false };
  }
  const handle = await fs.open(absolutePath, "r");
  try {
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    return { content: buffer.subarray(0, bytesRead).toString("utf8"), truncated: true };
  } finally {
    await handle.close();
  }
}

async function buildEntry(params: {
  absolutePath: string;
  relativePath: string;
  name: string;
  includeContent: boolean;
  maxContentBytes: number;
}): Promise<MemoryFileEntry | null> {
  const stat = await fs.stat(params.absolutePath).catch(() => null);
  if (!stat || !stat.isFile()) {
    return null;
  }
  const entry: MemoryFileEntry = {
    path: params.relativePath,
    name: params.name,
    sizeBytes: stat.size,
    updatedAtMs: toUpdatedAtMs(stat.mtimeMs),
  };
  if (params.includeContent) {
    const { content, truncated } = await readBoundedContent(
      params.absolutePath,
      stat.size,
      params.maxContentBytes,
    );
    entry.content = content;
    if (truncated) {
      entry.truncated = true;
    }
  }
  return entry;
}

/** Gateway handlers for read-only persisted memory enumeration. */
export const memoryHandlers: GatewayRequestHandlers = {
  "memory.list": async ({ params, respond, context }) => {
    if (!assertValidParams(params, validateMemoryListParams, "memory.list", respond)) {
      return;
    }
    const p = params as {
      limit?: number;
      includeContent?: boolean;
      includeRootMemory?: boolean;
      maxContentBytes?: number;
    };
    const limit = clampInt(p.limit, DEFAULT_LIST_LIMIT, 1, MAX_LIST_LIMIT);
    const maxContentBytes = clampInt(
      p.maxContentBytes,
      DEFAULT_CONTENT_MAX_BYTES,
      1,
      MAX_CONTENT_MAX_BYTES,
    );
    const includeContent = p.includeContent === true;

    try {
      const cfg = context.getRuntimeConfig();
      const agentId = resolveDefaultAgentId(cfg);
      const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
      const memoryDir = path.join(workspaceDir, "memory");

      // Newest-first daily file listing; a missing memory directory is an
      // empty result, not an error (startup-safe before any memory exists).
      const dirents = await fs.readdir(memoryDir, { withFileTypes: true }).catch(() => []);
      const dailyNames = dirents
        .filter((dirent) => dirent.isFile() && DAILY_MEMORY_FILE_PATTERN.test(dirent.name))
        .map((dirent) => dirent.name)
        .sort(compareDailyFileNames);

      const files: MemoryFileEntry[] = [];

      // Root curated memory is opt-in and always leads the listing.
      let rootMemoryIncluded = false;
      if (p.includeRootMemory === true) {
        const rootEntry = await buildEntry({
          absolutePath: path.join(workspaceDir, ROOT_MEMORY_FILE_NAME),
          relativePath: ROOT_MEMORY_FILE_NAME,
          name: ROOT_MEMORY_FILE_NAME,
          includeContent,
          maxContentBytes,
        });
        if (rootEntry) {
          files.push(rootEntry);
          rootMemoryIncluded = true;
        }
      }

      for (const name of dailyNames.slice(0, limit)) {
        const entry = await buildEntry({
          absolutePath: path.join(memoryDir, name),
          relativePath: toWorkspaceRelativePath("memory", name),
          name,
          includeContent,
          maxContentBytes,
        });
        if (entry) {
          files.push(entry);
        }
      }

      const totalFiles = dailyNames.length + (rootMemoryIncluded ? 1 : 0);
      respond(true, {
        agentId,
        files,
        totalFiles,
        returnedFiles: files.length,
      });
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, `memory list failed: ${String(err)}`),
      );
    }
  },
};
