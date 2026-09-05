import type { CodexAppServerStartOptions } from "./config.js";

const UNSAFE_ENVIRONMENT_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const RUNTIME_INJECTION_ENVIRONMENT_KEYS = new Set([
  "NODE_PATH",
  "LD_AUDIT",
  "LD_LIBRARY_PATH",
  "LD_PRELOAD",
]);
/** Merges app-server environment overrides while honoring clearEnv and unsafe key filtering. */
export function resolveCodexAppServerSpawnEnv(
  options: Pick<CodexAppServerStartOptions, "env" | "clearEnv">,
  baseEnv: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  // SAFETY: the new null-prototype object has no properties; only string environment values are copied below.
  const env = Object.create(null) as NodeJS.ProcessEnv;
  copySafeEnvironmentEntries(env, baseEnv);
  copySafeEnvironmentEntries(env, options.env ?? {});
  const keysToClear = normalizedEnvironmentKeys(options.clearEnv ?? []);
  if (platform === "win32") {
    const lowerCaseKeysToClear = new Set(keysToClear.map((key) => key.toLowerCase()));
    for (const candidate of Object.keys(env)) {
      if (lowerCaseKeysToClear.has(candidate.toLowerCase())) {
        delete env[candidate];
      }
    }
  } else {
    for (const key of keysToClear) {
      delete env[key];
    }
  }
  for (const key of Object.keys(env)) {
    if (isCodexRuntimeInjectionEnvironmentKey(key)) {
      // Package managers and agent hosts may inject loader paths into their children. Codex does
      // not need them, so strip them before attestation and spawn instead of self-failing setup.
      delete env[key];
    }
  }
  return env;
}

function isCodexRuntimeInjectionEnvironmentKey(rawKey: string): boolean {
  const key = rawKey.toUpperCase();
  return RUNTIME_INJECTION_ENVIRONMENT_KEYS.has(key) || key.startsWith("DYLD_");
}

function normalizedEnvironmentKeys(rawKeys: readonly string[]): string[] {
  const keys: string[] = [];
  for (const rawKey of rawKeys) {
    const key = rawKey.trim();
    if (key.length > 0) {
      keys.push(key);
    }
  }
  return keys;
}

function copySafeEnvironmentEntries(
  target: NodeJS.ProcessEnv,
  source: NodeJS.ProcessEnv | Record<string, string | undefined>,
): void {
  for (const [key, value] of Object.entries(source)) {
    if (UNSAFE_ENVIRONMENT_KEYS.has(key)) {
      continue;
    }
    target[key] = value;
  }
}
