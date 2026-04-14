import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import {
  isDangerousHostEnvOverrideVarName,
  isDangerousHostEnvVarName,
  normalizeEnvVarKey,
} from "../infra/host-env-security.js";
import { collectConfigServiceEnvVars } from "./config-env-vars.js";
import { resolveStateDir } from "./paths.js";
import type { OpenClawConfig } from "./types.js";

function isBlockedServiceEnvVar(key: string): boolean {
  return isDangerousHostEnvVarName(key) || isDangerousHostEnvOverrideVarName(key);
}

function parseStateDirDotEnvContent(content: string): Record<string, string> {
  const parsed = dotenv.parse(content);
  const entries: Record<string, string> = {};
  for (const [rawKey, value] of Object.entries(parsed)) {
    if (!value?.trim()) {
      continue;
    }
    const key = normalizeEnvVarKey(rawKey, { portable: true });
    if (!key) {
      continue;
    }
    if (isBlockedServiceEnvVar(key)) {
      continue;
    }
    entries[key] = value;
  }
  return entries;
}

export function readStateDirDotEnvVarsFromStateDir(stateDir: string): Record<string, string> {
  const dotEnvPath = path.join(stateDir, ".env");
  try {
    return parseStateDirDotEnvContent(fs.readFileSync(dotEnvPath, "utf8"));
  } catch {
    return {};
  }
}

/**
 * Read and parse `~/.openclaw/.env` (or `$OPENCLAW_STATE_DIR/.env`), returning
 * a filtered record of key-value pairs suitable for embedding in a service
 * environment (LaunchAgent plist, systemd unit, Scheduled Task).
 */
export function readStateDirDotEnvVars(
  env: Record<string, string | undefined>,
): Record<string, string> {
  const stateDir = resolveStateDir(env as NodeJS.ProcessEnv);
  return readStateDirDotEnvVarsFromStateDir(stateDir);
}

/**
 * Durable service env sources survive beyond the invoking shell and are safe to
 * persist into gateway install metadata.
 *
 * Precedence:
 * 1. state-dir `.env` file vars
 * 2. config service env vars
 */
export function collectDurableServiceEnvVars(params: {
  env: Record<string, string | undefined>;
  config?: OpenClawConfig;
}): Record<string, string> {
  return {
    ...readStateDirDotEnvVars(params.env),
    ...collectConfigServiceEnvVars(params.config),
  };
}
