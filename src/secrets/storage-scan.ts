import fs from "node:fs";
import path from "node:path";
import { listAgentIds, resolveAgentDir } from "../agents/agent-scope.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { resolveUserPath } from "../utils.js";
import { listAuthProfileStorePaths as listAuthProfileStorePathsFromAuthStorePaths } from "./auth-store-paths.js";
import { parseEnvValue } from "./shared.js";

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseEnvAssignmentValue(raw: string): string {
  return parseEnvValue(raw);
}

export function listAuthProfileStorePaths(config: OpenClawConfig, stateDir: string): string[] {
  return listAuthProfileStorePathsFromAuthStorePaths(config, stateDir);
}

export function listLegacyAuthJsonPaths(stateDir: string): string[] {
  const out: string[] = [];
  const agentsRoot = path.join(resolveUserPath(stateDir), "agents");
  if (!fs.existsSync(agentsRoot)) {
    return out;
  }
  for (const entry of fs.readdirSync(agentsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const candidate = path.join(agentsRoot, entry.name, "agent", "auth.json");
    if (fs.existsSync(candidate)) {
      out.push(candidate);
    }
  }
  return out;
}

function resolveActiveAgentDir(stateDir: string, env: NodeJS.ProcessEnv = process.env): string {
  const override = env.OPENCLAW_AGENT_DIR?.trim() || env.PI_CODING_AGENT_DIR?.trim();
  if (override) {
    return resolveUserPath(override);
  }
  return path.join(resolveUserPath(stateDir), "agents", "main", "agent");
}

export function listAgentModelsJsonPaths(
  config: OpenClawConfig,
  stateDir: string,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const resolvedStateDir = resolveUserPath(stateDir);
  const paths = new Set<string>();
  paths.add(path.join(resolvedStateDir, "agents", "main", "agent", "models.json"));
  paths.add(path.join(resolveActiveAgentDir(stateDir, env), "models.json"));

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
    if (agentId === "main") {
      paths.add(path.join(resolvedStateDir, "agents", "main", "agent", "models.json"));
      continue;
    }
    const agentDir = resolveAgentDir(config, agentId);
    paths.add(path.join(resolveUserPath(agentDir), "models.json"));
  }

  return [...paths];
}

export type ReadJsonObjectOptions = {
  maxBytes?: number;
  requireRegularFile?: boolean;
};

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
