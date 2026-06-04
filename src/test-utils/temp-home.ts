// Creates isolated temporary home directories for config-heavy tests.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { captureEnv } from "./env.js";
import { cleanupSessionStateForTest } from "./session-state-cleanup.js";

const HOME_ENV_KEYS = [
  "HOME",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "OPENCLAW_STATE_DIR",
] as const;

export type TempHomeEnv = {
  home: string;
  restore: () => Promise<void>;
};

// Reuse prefix roots to keep temp-home-heavy suites fast without sharing per-test homes.
const prefixRoots = new Map<string, string>();
const pendingPrefixRoots = new Map<string, Promise<string>>();
let nextHomeIndex = 0;

async function ensurePrefixRoot(prefix: string): Promise<string> {
  const cached = prefixRoots.get(prefix);
  if (cached) {
    return cached;
  }
  const pending = pendingPrefixRoots.get(prefix);
  if (pending) {
    return await pending;
  }
  const create = fs.mkdtemp(path.join(os.tmpdir(), prefix));
  pendingPrefixRoots.set(prefix, create);
  try {
    const root = await create;
    prefixRoots.set(prefix, root);
    return root;
  } finally {
    pendingPrefixRoots.delete(prefix);
  }
}

/** Creates a temporary OpenClaw home and process env override for stateful tests. */
export async function createTempHomeEnv(prefix: string): Promise<TempHomeEnv> {
  const prefixRoot = await ensurePrefixRoot(prefix);
  const home = path.join(prefixRoot, `home-${String(nextHomeIndex)}`);
  nextHomeIndex += 1;
  await fs.rm(home, { recursive: true, force: true });
  await fs.mkdir(path.join(home, ".openclaw"), { recursive: true });

  const snapshot = captureEnv([...HOME_ENV_KEYS]);
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.OPENCLAW_STATE_DIR = path.join(home, ".openclaw");

  if (process.platform === "win32") {
    const match = home.match(/^([A-Za-z]:)(.*)$/);
    if (match) {
      process.env.HOMEDRIVE = match[1];
      process.env.HOMEPATH = match[2] || "\\";
    }
  }

  return {
    home,
    restore: async () => {
      await cleanupSessionStateForTest().catch(() => undefined);
      snapshot.restore();
      await fs.rm(home, { recursive: true, force: true });
    },
  };
}
