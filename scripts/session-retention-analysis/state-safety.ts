import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resetConfigRuntimeState } from "../../src/config/config.js";
import { closeOpenClawStateDatabaseByPath } from "../../src/state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../src/state/openclaw-state-db.paths.js";

export const RETENTION_TEMP_PREFIX = "openclaw-session-retention-";

const RETENTION_ENV_KEYS = [
  "OPENCLAW_STATE_DIR",
  "OPENCLAW_CONFIG_PATH",
  "OPENCLAW_AGENT_DIR",
] as const;

type DisposableRetentionState = {
  stateDir: string;
  sessionsDir: string;
  cleanup: () => Promise<void>;
};

function canonicalPath(targetPath: string): string {
  return fs.realpathSync(targetPath);
}

export function assertDisposableOpenClawStateDir(stateDir: string): string {
  const canonicalStateDir = canonicalPath(stateDir);
  const canonicalTempDir = canonicalPath(os.tmpdir());
  const relative = path.relative(canonicalTempDir, canonicalStateDir);
  const rootName = relative.split(path.sep)[0] ?? "";
  if (
    !relative ||
    relative.startsWith("..") ||
    path.isAbsolute(relative) ||
    !rootName.startsWith(RETENTION_TEMP_PREFIX)
  ) {
    throw new Error(
      "Session retention analysis requires an isolated mkdtemp state directory under os.tmpdir()",
    );
  }
  return canonicalStateDir;
}

export function assertIsolatedStateEnvironment(stateDir: string): void {
  const canonicalStateDir = assertDisposableOpenClawStateDir(stateDir);
  const configuredStateDir = process.env.OPENCLAW_STATE_DIR;
  if (!configuredStateDir || canonicalPath(configuredStateDir) !== canonicalStateDir) {
    throw new Error("OPENCLAW_STATE_DIR must point at the disposable analysis state directory");
  }
}

export async function createDisposableRetentionState(): Promise<DisposableRetentionState> {
  const root = await fs.promises.realpath(
    await fs.promises.mkdtemp(path.join(os.tmpdir(), RETENTION_TEMP_PREFIX)),
  );
  const stateDir = path.join(root, "state");
  const sessionsDir = path.join(stateDir, "agents", "main", "sessions");
  const stateDatabasePath = resolveOpenClawStateSqlitePath({
    ...process.env,
    OPENCLAW_STATE_DIR: stateDir,
  });
  await fs.promises.mkdir(stateDir, { recursive: true });

  const previousEnv = Object.fromEntries(
    RETENTION_ENV_KEYS.map((key) => [key, process.env[key]]),
  ) as Record<(typeof RETENTION_ENV_KEYS)[number], string | undefined>;
  resetConfigRuntimeState();
  process.env.OPENCLAW_STATE_DIR = stateDir;
  process.env.OPENCLAW_CONFIG_PATH = path.join(stateDir, "openclaw.json");
  Reflect.deleteProperty(process.env, "OPENCLAW_AGENT_DIR");

  let cleaned = false;
  return {
    stateDir,
    sessionsDir,
    cleanup: async () => {
      if (cleaned) {
        return;
      }
      cleaned = true;
      try {
        closeOpenClawStateDatabaseByPath(stateDatabasePath);
      } finally {
        for (const key of RETENTION_ENV_KEYS) {
          const value = previousEnv[key];
          if (value === undefined) {
            Reflect.deleteProperty(process.env, key);
          } else {
            process.env[key] = value;
          }
        }
        try {
          resetConfigRuntimeState();
        } finally {
          await fs.promises.rm(root, {
            recursive: true,
            force: true,
            maxRetries: 20,
            retryDelay: 25,
          });
        }
      }
    },
  };
}
