// Temp home test helpers create isolated OpenClaw home directories for plugin tests.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { captureEnv, deleteTestEnvValue, setTestEnvValue } from "../../test-utils/env.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";

type EnvValue = string | undefined | ((home: string) => string | undefined);

type SharedHomeRootState = {
  rootPromise: Promise<string>;
  nextCaseId: number;
};

const SHARED_HOME_ROOTS = new Map<string, SharedHomeRootState>();

function setTempHome(base: string) {
  setTestEnvValue("HOME", base);
  setTestEnvValue("USERPROFILE", base);
  // Ensure tests using HOME isolation aren't affected by leaked OPENCLAW_HOME.
  deleteTestEnvValue("OPENCLAW_HOME");
  setTestEnvValue("OPENCLAW_STATE_DIR", path.join(base, ".openclaw"));

  if (process.platform !== "win32") {
    return;
  }
  const match = base.match(/^([A-Za-z]:)(.*)$/);
  if (!match) {
    return;
  }
  setTestEnvValue("HOMEDRIVE", expectDefined(match[1], "temp home regex capture 1"));
  setTestEnvValue("HOMEPATH", match[2] || "\\");
}

async function allocateTempHomeBase(prefix: string): Promise<string> {
  let state = SHARED_HOME_ROOTS.get(prefix);
  if (!state) {
    state = {
      rootPromise: fs.mkdtemp(path.join(os.tmpdir(), prefix)).catch((error: unknown) => {
        // Only the creator evicts a failed acquisition; current waiters keep its
        // rejection and cannot evict a later caller's replacement root.
        SHARED_HOME_ROOTS.delete(prefix);
        throw error;
      }),
      nextCaseId: 0,
    };
    SHARED_HOME_ROOTS.set(prefix, state);
  }
  const root = await state.rootPromise;
  return path.join(root, `case-${state.nextCaseId++}`);
}

export async function withTempHomeCore<T>(
  fn: (home: string) => Promise<T>,
  opts: {
    env?: Record<string, EnvValue>;
    prefix?: string;
    skipHomeCleanup?: boolean;
    skipSessionCleanup?: boolean;
  } = {},
): Promise<T> {
  const envKeys = Object.keys(opts.env ?? {});
  for (const key of envKeys) {
    if (key === "HOME" || key === "USERPROFILE" || key === "HOMEDRIVE" || key === "HOMEPATH") {
      throw new Error(`withTempHome: use built-in home env (got ${key})`);
    }
  }
  const base = await allocateTempHomeBase(opts.prefix ?? "openclaw-test-home-");
  const snapshot = captureEnv([
    "HOME",
    "USERPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
    "OPENCLAW_HOME",
    "OPENCLAW_STATE_DIR",
    ...envKeys,
  ]);
  let initialized = false;
  try {
    await fs.mkdir(base, { recursive: true });
    setTempHome(base);
    await fs.mkdir(path.join(base, ".openclaw", "agents", "main", "sessions"), { recursive: true });
    if (opts.env) {
      for (const [key, raw] of Object.entries(opts.env)) {
        const value = typeof raw === "function" ? raw(base) : raw;
        if (value === undefined) {
          deleteTestEnvValue(key);
        } else {
          setTestEnvValue(key, value);
        }
      }
    }
    initialized = true;
    return await fn(base);
  } finally {
    if (!opts.skipSessionCleanup) {
      await cleanupSessionStateForTest({ stateDir: path.join(base, ".openclaw") }).catch(
        () => undefined,
      );
    }
    snapshot.restore();
    // Retention belongs to the body; failed acquisition has no caller-owned home.
    if (!initialized || !opts.skipHomeCleanup) {
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
