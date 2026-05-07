import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";

type EnvValue = string | undefined | ((home: string) => string | undefined);

type EnvSnapshot = {
  home: string | undefined;
  userProfile: string | undefined;
  homeDrive: string | undefined;
  homePath: string | undefined;
  openclawHome: string | undefined;
  stateDir: string | undefined;
};

type SharedHomeRootState = {
  rootPromise: Promise<string>;
  nextCaseId: number;
};

const SHARED_HOME_ROOTS = new Map<string, SharedHomeRootState>();

function snapshotEnv(): EnvSnapshot {
  return {
    home: process.env.HOME,
    userProfile: process.env.USERPROFILE,
    homeDrive: process.env.HOMEDRIVE,
    homePath: process.env.HOMEPATH,
    openclawHome: process.env.OPENCLAW_HOME,
    stateDir: process.env.OPENCLAW_STATE_DIR,
  };
}

function restoreEnv(snapshot: EnvSnapshot) {
  const restoreKey = (key: string, value: string | undefined) => {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  };
  restoreKey("HOME", snapshot.home);
  restoreKey("USERPROFILE", snapshot.userProfile);
  restoreKey("HOMEDRIVE", snapshot.homeDrive);
  restoreKey("HOMEPATH", snapshot.homePath);
  restoreKey("OPENCLAW_HOME", snapshot.openclawHome);
  restoreKey("OPENCLAW_STATE_DIR", snapshot.stateDir);
}

function snapshotExtraEnv(keys: string[]): Record<string, string | undefined> {
  const snapshot: Record<string, string | undefined> = {};
  for (const key of keys) {
    snapshot[key] = process.env[key];
  }
  return snapshot;
}

function restoreExtraEnv(snapshot: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function setTempHome(base: string) {
  process.env.HOME = base;
  process.env.USERPROFILE = base;
  // Ensure tests using HOME isolation aren't affected by leaked OPENCLAW_HOME.
  delete process.env.OPENCLAW_HOME;
  process.env.OPENCLAW_STATE_DIR = path.join(base, ".openclaw");

  if (process.platform !== "win32") {
    return;
  }
  const match = base.match(/^([A-Za-z]:)(.*)$/);
  if (!match) {
    return;
  }
  process.env.HOMEDRIVE = match[1];
  process.env.HOMEPATH = match[2] || "\\";
}

async function allocateTempHomeBase(prefix: string): Promise<string> {
  let state = SHARED_HOME_ROOTS.get(prefix);
  if (!state) {
    state = {
      rootPromise: fs.mkdtemp(path.join(os.tmpdir(), prefix)),
      nextCaseId: 0,
    };
    SHARED_HOME_ROOTS.set(prefix, state);
  }
  const root = await state.rootPromise;
  const base = path.join(root, `case-${state.nextCaseId++}`);
  await fs.mkdir(base, { recursive: true });
  return base;
}

export async function withTempHome<T>(
  fn: (home: string) => Promise<T>,
  opts: {
    env?: Record<string, EnvValue>;
    prefix?: string;
    skipHomeCleanup?: boolean;
    skipSessionCleanup?: boolean;
  } = {},
): Promise<T> {
  const prefix = opts.prefix ?? "openclaw-test-home-";
  const base = await allocateTempHomeBase(prefix);
  const snapshot = snapshotEnv();
  const envKeys = Object.keys(opts.env ?? {});
  for (const key of envKeys) {
    if (key === "HOME" || key === "USERPROFILE" || key === "HOMEDRIVE" || key === "HOMEPATH") {
      throw new Error(`withTempHome: use built-in home env (got ${key})`);
    }
  }
  const envSnapshot = snapshotExtraEnv(envKeys);

  setTempHome(base);
  await fs.mkdir(path.join(base, ".openclaw", "agents", "main", "sessions"), { recursive: true });
  if (opts.env) {
    for (const [key, raw] of Object.entries(opts.env)) {
      const value = typeof raw === "function" ? raw(base) : raw;
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }

  try {
    return await fn(base);
  } finally {
    if (!opts.skipSessionCleanup) {
      await cleanupSessionStateForTest().catch(() => undefined);
    }
    restoreExtraEnv(envSnapshot);
    restoreEnv(snapshot);
    if (!opts.skipHomeCleanup) {
      try {
        if (process.platform === "win32") {
          await fs.rm(base, {
            recursive: true,
            force: true,
            maxRetries: 10,
            retryDelay: 50,
          });
        } else {
          await fs.rm(base, {
            recursive: true,
            force: true,
          });
        }
      } catch {
        // ignore cleanup failures in tests
      }
    }
  }
}
