import fs from "node:fs/promises";
import path from "node:path";
import { resolveAgentWorkspaceDir, type OpenClawConfig } from "./memory-core-host-engine-foundation.js";
import { listMemoryFiles, normalizeExtraMemoryPaths } from "../memory/internal.js";
import { resolveMemoryBackendConfig } from "../memory/backend-config.js";

export { listMemoryFiles, normalizeExtraMemoryPaths, resolveMemoryBackendConfig };

export type MemorySearchResult = {
  path: string;
  startLine: number;
  endLine: number;
  score: number;
  snippet: string;
  source: "memory" | "sessions";
  citation?: string;
};

export type MemorySearchRuntimeDebug = {
  configuredMode?: string;
  effectiveMode?: string;
  fallback?: string;
};

export async function readAgentMemoryFile(params: {
  cfg: OpenClawConfig;
  agentId: string;
  relPath: string;
  from?: number;
  lines?: number;
}): Promise<{ text: string; path: string }> {
  const workspaceDir = resolveAgentWorkspaceDir(params.cfg, params.agentId);
  const normalizedRelPath = params.relPath.trim().replace(/\\/g, "/").replace(/^\/+/, "");
  const absolutePath = path.resolve(workspaceDir, normalizedRelPath);
  const relativeToWorkspace = path.relative(workspaceDir, absolutePath);
  if (
    !relativeToWorkspace ||
    relativeToWorkspace.startsWith("..") ||
    path.isAbsolute(relativeToWorkspace)
  ) {
    throw new Error(`Memory file is outside the workspace: ${params.relPath}`);
  }
  const raw = await fs.readFile(absolutePath, "utf8");
  if (params.from == null && params.lines == null) {
    return { text: raw, path: normalizedRelPath };
  }
  const allLines = raw.split(/\r?\n/);
  const startLine = Math.max(1, params.from ?? 1);
  const lineCount = Math.max(1, params.lines ?? allLines.length);
  const sliced = allLines.slice(startLine - 1, startLine - 1 + lineCount);
  return {
    text: sliced.join("\n"),
    path: normalizedRelPath,
  };
}
