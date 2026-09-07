/** Filesystem discovery and bounded JSON readers for local secret storage audits. */
import fs from "node:fs";
import path from "node:path";
import { isRecord as isJsonObject } from "@openclaw/normalization-core/record-coerce";
import { listAgentIds, resolveAgentDir } from "../agents/agent-scope.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { resolveUserPath } from "../utils.js";
import { parseEnvValue } from "./shared.js";

/** Parses one .env assignment value using the shared shell-ish env parser. */
export function parseEnvAssignmentValue(raw: string): string {
  return parseEnvValue(raw);
}

/** Lists global dotenv files that can supply secrets for the selected config and state roots. */
export function listSecretsDotEnvPaths(params: { configPath: string; stateDir: string }): string[] {
  const candidates = [
    path.join(params.stateDir, ".env"),
    path.join(path.dirname(params.configPath), ".env"),
  ];
  return [...new Map(candidates.map((candidate) => [path.resolve(candidate), candidate])).values()];
}

/**
 * Lists deduplicated models.json paths that may contain materialized provider credentials.
 * Includes active env override, discovered state dirs, and configured agents.
 */
export function listAgentModelsJsonPaths(
  config: OpenClawConfig,
  stateDir: string,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const resolvedStateDir = resolveUserPath(stateDir);
  const scopedEnv = { ...env, OPENCLAW_STATE_DIR: stateDir };
  const paths = new Set<string>();
  const activeAgentDir = env.OPENCLAW_AGENT_DIR?.trim() || env.PI_CODING_AGENT_DIR?.trim();
  if (activeAgentDir) {
    paths.add(path.join(resolveUserPath(activeAgentDir, scopedEnv), "models.json"));
  }

  const agentsRoot = path.join(resolvedStateDir, "agents");
  if (fs.existsSync(agentsRoot)) {
    for (const entry of fs.readdirSync(agentsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      paths.add(path.join(agentsRoot, entry.name, "agent", "models.json"));
    }
  }

  for (const agentId of listAgentIds(config)) {
    paths.add(path.join(resolveAgentDir(config, agentId, scopedEnv), "models.json"));
  }

  return [...paths];
}

/** Limits for safe opportunistic JSON reads during local storage scans. */
type ReadJsonObjectOptions = {
  /** Reject files larger than this byte count before reading content. */
  maxBytes?: number;
  /** Reject directories, symlinks, and other non-regular paths before JSON parsing. */
  requireRegularFile?: boolean;
};

/**
 * Reads a JSON object if the file exists, returning parse/stat errors without throwing.
 * Non-object JSON values are treated as absent because scanners expect record-shaped stores.
 */
export function readJsonObjectIfExists(filePath: string): {
  value: Record<string, unknown> | null;
  error?: string;
};
export function readJsonObjectIfExists(
  filePath: string,
  options: ReadJsonObjectOptions,
): {
  value: Record<string, unknown> | null;
  error?: string;
};
export function readJsonObjectIfExists(
  filePath: string,
  options: ReadJsonObjectOptions = {},
): {
  value: Record<string, unknown> | null;
  error?: string;
} {
  if (!fs.existsSync(filePath)) {
    return { value: null };
  }
  try {
    const stats = fs.statSync(filePath);
    if (options.requireRegularFile && !stats.isFile()) {
      return {
        value: null,
        error: `Refusing to read non-regular file: ${filePath}`,
      };
    }
    if (
      typeof options.maxBytes === "number" &&
      Number.isFinite(options.maxBytes) &&
      options.maxBytes >= 0 &&
      stats.size > options.maxBytes
    ) {
      return {
        value: null,
        error: `Refusing to read oversized JSON (${stats.size} bytes): ${filePath}`,
      };
    }
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!isJsonObject(parsed)) {
      return { value: null };
    }
    return { value: parsed };
  } catch (err) {
    return {
      value: null,
      error: formatErrorMessage(err),
    };
  }
}
