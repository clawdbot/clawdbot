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
  return snapshot;
}
