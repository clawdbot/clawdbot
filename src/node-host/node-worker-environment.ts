import path from "node:path";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";

const POSIX_WORKER_ENV_KEYS = new Set([
  "PATH",
  "HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LANGUAGE",
  "TZ",
  "NODE_EXTRA_CA_CERTS",
  "NODE_USE_SYSTEM_CA",
  "OPENCLAW_ALLOW_INSECURE_PRIVATE_WS",
]);
const WINDOWS_WORKER_ENV_KEYS = new Set([
  ...POSIX_WORKER_ENV_KEYS,
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
]);

/** Freeze the minimal non-secret environment inherited by node-host workers. */
export function snapshotNodeWorkerEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const windows = process.platform === "win32";
  const snapshot: NodeJS.ProcessEnv = {};
  const retainedWindowsKeys = new Map<string, string>();
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) {
      continue;
    }
    const normalized = windows ? key.toUpperCase() : key;
    const allowed =
      (windows ? WINDOWS_WORKER_ENV_KEYS : POSIX_WORKER_ENV_KEYS).has(normalized) ||
      normalized.startsWith("LC_");
    if (!allowed) {
      continue;
    }
    if (windows) {
      const previousKey = retainedWindowsKeys.get(normalized);
      if (previousKey) {
        delete snapshot[previousKey];
      }
      retainedWindowsKeys.set(normalized, key);
    }
    snapshot[key] = value;
  }
  if (source.NODE_DISABLE_COMPILE_CACHE === undefined) {
    snapshot.NODE_COMPILE_CACHE =
      source.NODE_COMPILE_CACHE?.trim() ||
      path.join(resolvePreferredOpenClawTmpDir(), "node-worker-compile-cache");
  } else {
    snapshot.NODE_DISABLE_COMPILE_CACHE = "1";
  }
  // The supervised start gate is carried by Node IPC. Launcher respawns do not
  // inherit that channel, so workers must stay in the owned child process.
  snapshot.OPENCLAW_NO_RESPAWN = "1";
  return snapshot;
}
