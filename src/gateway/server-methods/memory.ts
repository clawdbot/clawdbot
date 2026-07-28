// Read-only persisted memory browsing for operator clients.
import path from "node:path";
import {
  ErrorCodes,
  errorShape,
  type MemoryListFile,
  type MemoryListRootMemory,
  validateMemoryListParams,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  listAgentIds,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "../../agents/agent-scope.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { CANONICAL_ROOT_MEMORY_FILENAME } from "../../memory/root-memory-files.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import type { GatewayRequestHandlers, RespondFn } from "./types.js";
import { assertValidParams } from "./validation.js";
import {
  decodeUtf8Strict,
  listWorkspacePath,
  readWorkspaceFile,
  statWorkspacePath,
  workspaceStatKind,
} from "./workspace-fs.js";

const MEMORY_DIR = "memory";
const DEFAULT_FILE_LIMIT = 90;
const MAX_FILE_LIMIT = 366;
const DEFAULT_MAX_CONTENT_BYTES = 64 * 1024;
const MAX_CONTENT_BYTES = 256 * 1024;
const MEMORY_FILE_PATTERN = /^(\d{4}-\d{2}-\d{2})(?:-(.+))?\.md$/;

function memoryError(type: string, message: string, details?: Record<string, unknown>) {
  return errorShape(ErrorCodes.INVALID_REQUEST, message, {
    details: {
      type,
      ...details,
    },
  });
}

function clamp(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined) {
    return fallback;
  }
  return Math.min(value, max);
}

function resolveMemoryScopeOrRespond(
  params: { agentId?: string },
  cfg: OpenClawConfig,
  respond: RespondFn,
): { agentId: string; workspaceDir: string } | null {
  let agentId: string;
  try {
    agentId = normalizeAgentId(params.agentId ?? resolveDefaultAgentId(cfg));
  } catch (err) {
    respond(
      false,
      undefined,
      memoryError("memory_agent_unavailable", err instanceof Error ? err.message : "no agent"),
    );
    return null;
  }
  if (!new Set(listAgentIds(cfg)).has(agentId)) {
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unknown agent id"));
    return null;
  }
  return {
    agentId,
    workspaceDir: resolveAgentWorkspaceDir(cfg, agentId),
  };
}

async function readOptionalText(params: {
  workspaceDir: string;
  browserPath: string;
  maxContentBytes: number;
}): Promise<{ content?: string; truncated: boolean }> {
  const stat = await statWorkspacePath(params.workspaceDir, params.browserPath);
  if (!stat || workspaceStatKind(stat) !== "file") {
    return { truncated: false };
  }
  if (stat.size > params.maxContentBytes) {
    return { truncated: true };
  }
  const read = await readWorkspaceFile(params.workspaceDir, params.browserPath, {
    maxBytes: params.maxContentBytes,
  });
  if (!read || read === "too-large") {
    return { truncated: true };
  }
  return {
    content: decodeUtf8Strict(read.buffer) ?? read.buffer.toString("utf8"),
    truncated: false,
  };
}

async function listMemoryFiles(params: {
  workspaceDir: string;
  includeContent: boolean;
  limit: number;
  maxContentBytes: number;
}): Promise<{ files: MemoryListFile[]; totalFiles: number; truncated: boolean }> {
  const memoryStat = await statWorkspacePath(params.workspaceDir, MEMORY_DIR);
  const dirents =
    memoryStat && workspaceStatKind(memoryStat) === "directory"
      ? await listWorkspacePath(params.workspaceDir, MEMORY_DIR)
      : undefined;
  if (!dirents) {
    return { files: [], totalFiles: 0, truncated: false };
  }
  const candidates = dirents
    .flatMap((dirent) => {
      if (workspaceStatKind(dirent) !== "file") {
        return [];
      }
      const match = MEMORY_FILE_PATTERN.exec(dirent.name);
      if (!match) {
        return [];
      }
      return [
        {
          name: dirent.name,
          path: `${MEMORY_DIR}/${dirent.name}`,
          date: match[1]!,
          ...(match[2] ? { slug: match[2] } : {}),
        },
      ];
    })
    .toSorted((a, b) => b.date.localeCompare(a.date) || b.name.localeCompare(a.name));
  const files = await Promise.all(
    candidates.slice(0, params.limit).map(async (candidate): Promise<MemoryListFile> => {
      if (!params.includeContent) {
        return { ...candidate, truncated: false };
      }
      const read = await readOptionalText({
        workspaceDir: params.workspaceDir,
        browserPath: candidate.path,
        maxContentBytes: params.maxContentBytes,
      });
      return { ...candidate, ...read };
    }),
  );
  return {
    files,
    totalFiles: candidates.length,
    truncated: candidates.length > files.length,
  };
}

async function readRootMemory(params: {
  workspaceDir: string;
  includeContent: boolean;
  maxContentBytes: number;
}): Promise<MemoryListRootMemory | null> {
  const stat = await statWorkspacePath(params.workspaceDir, CANONICAL_ROOT_MEMORY_FILENAME);
  if (!stat || workspaceStatKind(stat) !== "file") {
    return null;
  }
  const base = {
    name: CANONICAL_ROOT_MEMORY_FILENAME,
    path: CANONICAL_ROOT_MEMORY_FILENAME,
  };
  if (!params.includeContent) {
    return { ...base, truncated: false };
  }
  return {
    ...base,
    ...(await readOptionalText({
      workspaceDir: params.workspaceDir,
      browserPath: CANONICAL_ROOT_MEMORY_FILENAME,
      maxContentBytes: params.maxContentBytes,
    })),
  };
}

/** Gateway handlers for read-only persisted memory browsing. */
export const memoryHandlers: GatewayRequestHandlers = {
  "memory.list": async ({ params, respond, context }) => {
    if (!assertValidParams(params, validateMemoryListParams, "memory.list", respond)) {
      return;
    }
    const scope = resolveMemoryScopeOrRespond(params, context.getRuntimeConfig(), respond);
    if (!scope) {
      return;
    }
    const limit = clamp(params.limit, DEFAULT_FILE_LIMIT, MAX_FILE_LIMIT);
    const maxContentBytes = clamp(
      params.maxContentBytes,
      DEFAULT_MAX_CONTENT_BYTES,
      MAX_CONTENT_BYTES,
    );
    const memory = await listMemoryFiles({
      workspaceDir: scope.workspaceDir,
      includeContent: params.includeContent === true,
      limit,
      maxContentBytes,
    });
    const rootMemory =
      params.includeRootMemory === true
        ? await readRootMemory({
            workspaceDir: scope.workspaceDir,
            includeContent: params.includeContent === true,
            maxContentBytes,
          })
        : undefined;
    respond(true, {
      agentId: scope.agentId,
      memoryDir: path.posix.normalize(MEMORY_DIR),
      totalFiles: memory.totalFiles,
      returnedFiles: memory.files.length,
      truncated: memory.truncated,
      files: memory.files,
      ...(params.includeRootMemory === true ? { rootMemory } : {}),
    });
  },
};
