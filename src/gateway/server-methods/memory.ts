// Read-only persisted memory enumeration for operator-read clients.
// Lists the default agent workspace memory area (memory/<YYYY-MM-DD>.md
// daily files plus the optional root MEMORY.md) so desktop/control clients
// can see what the agent has persisted without an in-turn tool call.
// Deliberately no write/delete/mutation surface.
//
// DESIGN NOTE: memory.list is a gateway RPC rather than an
// agents.workspace.* method because the memory/ directory is semantically
// a persistent agent-context store, not a general workspace file browser.
// The listing order (newest-first daily files + optional root MEMORY.md),
// the date-prefixed file-name pattern, and the implicit "memory/" prefix
// are domain-specific conventions that a generic workspace browser should
// not need to replicate.  Keeping the surface read-only also avoids
// conflating file-editing permission with memory management policy.
import path from "node:path";
import {
  ErrorCodes,
  errorShape,
  type MemoryFileEntry,
  validateMemoryListParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { root as fsSafeRoot, type FsSafeRoot } from "../../infra/fs-safe.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";
import { toUpdatedAtMs } from "./workspace-fs.js";

const DEFAULT_LIST_LIMIT = 90;
const MAX_LIST_LIMIT = 366;
const DEFAULT_CONTENT_MAX_BYTES = 64 * 1024;
const MAX_CONTENT_MAX_BYTES = 256 * 1024;

/** Gateway frame limit: ~25 MiB. Leave margin for JSON framing overhead. */
const AGGREGATE_CONTENT_BUDGET_BYTES = 20 * 1024 * 1024;

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

async function buildEntry(
  workspaceRoot: FsSafeRoot,
  params: {
    relativePath: string;
    name: string;
    includeContent: boolean;
    maxContentBytes: number;
  },
): Promise<MemoryFileEntry | null> {
  let stat: Awaited<ReturnType<FsSafeRootType["stat"]>>;
  try {
    stat = await workspaceRoot.stat(params.relativePath);
  } catch (err: unknown) {
    // "not-found" means the file disappeared between listing and stat (race).
    // Other errors (EACCES, EIO, ELOOP) should propagate.
    if ((err as { code?: string }).code !== "not-found") {
      throw err;
    }
    return null;
  }
  if (!stat.isFile) {
    return null;
  }
  const entry: MemoryFileEntry = {
    path: params.relativePath,
    name: params.name,
    sizeBytes: (stat as { size?: number }).size ?? 0,
    updatedAtMs: toUpdatedAtMs((stat as { mtimeMs?: number }).mtimeMs ?? Date.now()),
  };
  if (params.includeContent) {
    try {
      const readResult = await workspaceRoot.read(params.relativePath, {
        hardlinks: "reject",
        maxBytes: params.maxContentBytes,
        nonBlockingRead: true,
        symlinks: "reject",
      });
      entry.content = readResult.buffer.toString("utf8");
      if (readResult.buffer.length < entry.sizeBytes) {
        entry.truncated = true;
      }
    } catch (err: unknown) {
      // "too-large" means the file exceeds maxContentBytes — truncate instead of failing.
      if ((err as { code?: string }).code === "too-large") {
        const readResult = await workspaceRoot.read(params.relativePath, {
          hardlinks: "reject",
          nonBlockingRead: true,
          symlinks: "reject",
        });
        entry.content = readResult.buffer.subarray(0, params.maxContentBytes).toString("utf8");
        entry.truncated = true;
      } else {
        throw err;
      }
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

      // Route all workspace fs access through fs-safe workspace boundary
      // (symlink/hardlink rejection) so memory files cannot escape the
      // workspace root through symbolic-link tricks or hard-link aliasing.
      const workspaceRoot = await fsSafeRoot(workspaceDir, {
        hardlinks: "reject",
        maxBytes: MAX_CONTENT_MAX_BYTES,
        nonBlockingRead: true,
        symlinks: "reject",
      });
      if (!workspaceRoot) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, "memory list failed: workspace root unavailable"),
        );
        return;
      }

      // Newest-first daily file listing; a missing memory directory is an
      // empty result, not an error (startup-safe before any memory exists).
      // Only "not-found" is treated as absent — other fs errors propagate.
      let entries: Array<{ name: string; kind?: string }>;
      try {
        entries = await workspaceRoot.list("memory", { withFileTypes: true });
      } catch (err: unknown) {
        if ((err as { code?: string }).code !== "not-found") {
          throw err;
        }
        entries = [];
      }
      const dailyNames = entries
        .filter((entry) => entry.isFile && DAILY_MEMORY_FILE_PATTERN.test(entry.name))
        .map((entry) => entry.name)
        .toSorted(compareDailyFileNames);

      const files: MemoryFileEntry[] = [];

      // Root curated memory is opt-in and always leads the listing.
      let rootMemoryIncluded = false;
      if (p.includeRootMemory === true) {
        const rootEntry = await buildEntry(workspaceRoot, {
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

      // Root memory counts against the file limit so returnedFiles never
      // exceeds the caller's cap.
      const dailyLimit = Math.max(0, limit - (rootMemoryIncluded ? 1 : 0));
      for (const name of dailyNames.slice(0, dailyLimit)) {
        const entry = await buildEntry(workspaceRoot, {
          relativePath: toWorkspaceRelativePath("memory", name),
          name,
          includeContent,
          maxContentBytes,
        });
        if (entry) {
          files.push(entry);
        }
      }

      // Enforce aggregate response budget so the serialised frame stays
      // under the Gateway 25 MiB limit (with headroom for JSON overhead).
      let aggregateContentBytes = 0;
      for (const file of files) {
        if (file.content) {
          aggregateContentBytes += file.content.length;
        }
      }
      if (aggregateContentBytes > AGGREGATE_CONTENT_BUDGET_BYTES) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_PARAMS,
            `memory list content (${aggregateContentBytes} bytes) exceeds response budget`,
          ),
        );
        return;
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
