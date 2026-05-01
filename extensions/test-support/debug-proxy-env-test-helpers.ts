import { afterEach, vi } from "vitest";

const DEBUG_PROXY_ENV_KEYS = [
  "OPENCLAW_DEBUG_PROXY_ENABLED",
  "OPENCLAW_DEBUG_PROXY_DB_PATH",
  "OPENCLAW_DEBUG_PROXY_BLOB_DIR",
  "OPENCLAW_DEBUG_PROXY_SESSION_ID",
] as const;

type DebugProxyEnvKey = (typeof DEBUG_PROXY_ENV_KEYS)[number];
type DebugProxyEnvSnapshot = Partial<Record<DebugProxyEnvKey, string | undefined>>;

function snapshotDebugProxyEnv(): DebugProxyEnvSnapshot {
  return Object.fromEntries(
    DEBUG_PROXY_ENV_KEYS.map((key) => [key, process.env[key]]),
  ) as DebugProxyEnvSnapshot;
}

function restoreDebugProxyEnv(snapshot: DebugProxyEnvSnapshot): void {
  for (const key of DEBUG_PROXY_ENV_KEYS) {
    const value = snapshot[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

export function installDebugProxyTestResetHooks() {
  const originalFetch = globalThis.fetch;
  let priorProxyEnv: DebugProxyEnvSnapshot = {};

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    restoreDebugProxyEnv(priorProxyEnv);
    priorProxyEnv = {};
  });

  return {
    captureProxyEnv() {
      priorProxyEnv = snapshotDebugProxyEnv();
    },
    originalFetch,
  };
}
