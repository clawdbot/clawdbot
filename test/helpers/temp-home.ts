import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

type EnvValue = string | undefined | ((home: string) => string | undefined);

type EnvSnapshot = {
  home: string | undefined;
  userProfile: string | undefined;
  homeDrive: string | undefined;
  homePath: string | undefined;
  stateDir: string | undefined;
};

function snapshotEnv(): EnvSnapshot {
  return {
    home: process.env.HOME,
    userProfile: process.env.USERPROFILE,
    homeDrive: process.env.HOMEDRIVE,
    homePath: process.env.HOMEPATH,
    stateDir: process.env.CLAWDBOT_STATE_DIR,
  };
}

function restoreEnv(snapshot: EnvSnapshot) {
  const restoreKey = (key: string, value: string | undefined) => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };
  restoreKey("HOME", snapshot.home);
  restoreKey("USERPROFILE", snapshot.userProfile);
  restoreKey("HOMEDRIVE", snapshot.homeDrive);
  restoreKey("HOMEPATH", snapshot.homePath);
  restoreKey("CLAWDBOT_STATE_DIR", snapshot.stateDir);
}

function snapshotExtraEnv(keys: string[]): Record<string, string | undefined> {
  const snapshot: Record<string, string | undefined> = {};
  for (const key of keys) snapshot[key] = process.env[key];
  return snapshot;
}

function restoreExtraEnv(snapshot: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function setTempHome(base: string) {
  process.env.HOME = base;
  process.env.USERPROFILE = base;
  process.env.CLAWDBOT_STATE_DIR = path.join(base, ".clawdbot");

  if (process.platform !== "win32") return;
  const match = base.match(/^([A-Za-z]:)(.*)$/);
  if (!match) return;
  process.env.HOMEDRIVE = match[1];
  process.env.HOMEPATH = match[2] || "\\";
}

export async function withTempHome<T>(
  fn: (home: string) => Promise<T>,
  opts: { env?: Record<string, EnvValue>; prefix?: string } = {},
): Promise<T> {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), opts.prefix ?? "moltbot-test-home-"));
  const snapshot = snapshotEnv();
  const envKeys = Object.keys(opts.env ?? {});
  for (const key of envKeys) {
    if (key === "HOME" || key === "USERPROFILE" || key === "HOMEDRIVE" || key === "HOMEPATH") {
      throw new Error(`withTempHome: use built-in home env (got ${key})`);
    }
  }
  const envSnapshot = snapshotExtraEnv(envKeys);

  setTempHome(base);
  await fs.mkdir(path.join(base, ".clawdbot", "agents", "main", "sessions"), { recursive: true });
  if (opts.env) {
    for (const [key, raw] of Object.entries(opts.env)) {
      const value = typeof raw === "function" ? raw(base) : raw;
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }

  try {
    return await fn(base);
  } finally {
    restoreExtraEnv(envSnapshot);
    restoreEnv(snapshot);
    try {
      await fs.rm(base, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 50,
      });
    } catch {
      // ignore cleanup failures in tests
    }
  }
}
