import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  requiresExplicitMatrixDefaultAccount,
  resolveMatrixDefaultOrOnlyAccountId,
} from "../account-selection.js";
import { getMatrixRuntime } from "../runtime.js";
import {
  resolveMatrixCredentialsDir as resolveSharedMatrixCredentialsDir,
  resolveMatrixCredentialsPath as resolveSharedMatrixCredentialsPath,
} from "../storage-paths.js";

export type MatrixStoredCredentials = {
  homeserver: string;
  userId: string;
  accessToken: string;
  deviceId?: string;
  createdAt: string;
  lastUsedAt?: string;
};

type MatrixCredentialsSource = "current" | "legacy";

type MatrixCredentialsFileLoadResult =
  | {
      kind: "loaded";
      source: MatrixCredentialsSource;
      credentials: MatrixStoredCredentials | null;
    }
  | {
      kind: "missing";
    };

function resolveStateDir(env: NodeJS.ProcessEnv): string {
  try {
    return getMatrixRuntime().state.resolveStateDir(env, os.homedir);
  } catch {
    // Some config-only helpers read stored credentials before the Matrix plugin
    // runtime is installed. Fall back to the standard state-dir env contract.
    const override = env.OPENCLAW_STATE_DIR?.trim();
    if (override) {
      return path.resolve(override);
    }
    const homeDir = env.OPENCLAW_HOME?.trim() || env.HOME?.trim() || os.homedir();
    return path.join(homeDir, ".openclaw");
  }
}

function resolveLegacyMatrixCredentialsPath(env: NodeJS.ProcessEnv): string {
  return path.join(resolveMatrixCredentialsDir(env), "credentials.json");
}

function shouldReadLegacyCredentialsForAccount(accountId?: string | null): boolean {
  const normalizedAccountId = normalizeAccountId(accountId);
  const cfg = getMatrixRuntime().config.current() as OpenClawConfig;
  if (!cfg.channels?.matrix || typeof cfg.channels.matrix !== "object") {
    return normalizedAccountId === DEFAULT_ACCOUNT_ID;
  }
  if (requiresExplicitMatrixDefaultAccount(cfg)) {
    return false;
  }
  return normalizeAccountId(resolveMatrixDefaultOrOnlyAccountId(cfg)) === normalizedAccountId;
}

function resolveLegacyMigrationSourcePath(
  env: NodeJS.ProcessEnv,
  accountId?: string | null,
): string | null {
  if (!shouldReadLegacyCredentialsForAccount(accountId)) {
    return null;
  }
  const legacyPath = resolveLegacyMatrixCredentialsPath(env);
  return legacyPath === resolveMatrixCredentialsPath(env, accountId) ? null : legacyPath;
}

function parseMatrixCredentialsFile(filePath: string): MatrixStoredCredentials | null {
  const raw = fs.readFileSync(filePath, "utf-8");
  const parsed = JSON.parse(raw) as Partial<MatrixStoredCredentials>;
  if (
    typeof parsed.homeserver !== "string" ||
    typeof parsed.userId !== "string" ||
    typeof parsed.accessToken !== "string"
  ) {
    return null;
  }
  return parsed as MatrixStoredCredentials;
}

function loadMatrixCredentialsFile(
  filePath: string,
  source: MatrixCredentialsSource,
): MatrixCredentialsFileLoadResult {
  try {
    return {
      kind: "loaded",
      source,
      credentials: parseMatrixCredentialsFile(filePath),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return { kind: "missing" };
    }
    throw error;
  }
}

function loadLegacyMatrixCredentialsWithCurrentFallback(params: {
  legacyPath: string;
  currentPath: string;
}): MatrixCredentialsFileLoadResult {
  const legacy = loadMatrixCredentialsFile(params.legacyPath, "legacy");
  if (legacy.kind === "loaded") {
    return legacy;
  }
  return loadMatrixCredentialsFile(params.currentPath, "current");
}

export function resolveMatrixCredentialsDir(
  env: NodeJS.ProcessEnv = process.env,
  stateDir?: string,
): string {
  const resolvedStateDir = stateDir ?? resolveStateDir(env);
  return resolveSharedMatrixCredentialsDir(resolvedStateDir);
}

export function resolveMatrixCredentialsPath(
  env: NodeJS.ProcessEnv = process.env,
  accountId?: string | null,
): string {
  const resolvedStateDir = resolveStateDir(env);
  return resolveSharedMatrixCredentialsPath({ stateDir: resolvedStateDir, accountId });
}

export function loadMatrixCredentials(
  env: NodeJS.ProcessEnv = process.env,
  accountId?: string | null,
): MatrixStoredCredentials | null {
  const currentPath = resolveMatrixCredentialsPath(env, accountId);
  try {
    const current = loadMatrixCredentialsFile(currentPath, "current");
    if (current.kind === "loaded") {
      return current.credentials;
    }

    const legacyPath = resolveLegacyMigrationSourcePath(env, accountId);
    if (!legacyPath) {
      return null;
    }

    const loaded = loadLegacyMatrixCredentialsWithCurrentFallback({
      legacyPath,
      currentPath,
    });
    if (loaded.kind !== "loaded" || !loaded.credentials) {
      return null;
    }

    if (loaded.source === "legacy") {
      try {
        fs.mkdirSync(path.dirname(currentPath), { recursive: true });
        fs.renameSync(legacyPath, currentPath);
      } catch {
        // Keep returning the legacy credentials even if migration fails.
      }
    }

    return loaded.credentials;
  } catch {
    return null;
  }
}

export function clearMatrixCredentials(
  env: NodeJS.ProcessEnv = process.env,
  accountId?: string | null,
): void {
  const paths = [
    resolveMatrixCredentialsPath(env, accountId),
    resolveLegacyMigrationSourcePath(env, accountId),
  ];
  for (const filePath of paths) {
    if (!filePath) {
      continue;
    }
    try {
      fs.unlinkSync(filePath);
    } catch {
      // ignore
    }
  }
}

export function credentialsMatchConfig(
  stored: MatrixStoredCredentials,
  config: { homeserver: string; userId: string; accessToken?: string },
): boolean {
  if (!config.userId) {
    if (!config.accessToken) {
      return false;
    }
    return stored.homeserver === config.homeserver && stored.accessToken === config.accessToken;
  }
  return stored.homeserver === config.homeserver && stored.userId === config.userId;
}
