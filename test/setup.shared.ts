import { vi } from "vitest";

declare global {
  // Optional per-test delegate for the shared OAuth mock.
  var __OPENCLAW_TEST_REFRESH_OPENAI_CODEX_TOKEN__: ((...args: unknown[]) => unknown) | undefined;
}

vi.mock("@mariozechner/pi-ai/oauth", () => ({
  getOAuthApiKey: () => undefined,
  getOAuthProviders: () => [],
  loginOpenAICodex: vi.fn(),
  refreshOpenAICodexToken: vi.fn((...args: unknown[]) =>
    globalThis.__OPENCLAW_TEST_REFRESH_OPENAI_CODEX_TOKEN__?.(...args),
  ),
}));

vi.mock("@mariozechner/clipboard", () => ({
  availableFormats: () => [],
  getText: async () => "",
  setText: async () => {},
  hasText: () => false,
  getImageBinary: async () => [],
  getImageBase64: async () => "",
  setImageBinary: async () => {},
  setImageBase64: async () => {},
  hasImage: () => false,
  getHtml: async () => "",
  setHtml: async () => {},
  hasHtml: () => false,
  getRtf: async () => "",
  setRtf: async () => {},
  hasRtf: () => false,
  clear: async () => {},
  watch: () => {},
  callThreadsafeFunction: () => {},
}));

// Ensure Vitest environment is properly set.
process.env.VITEST = "true";
// Config validation walks plugin manifests; keep an aggressive cache in tests to avoid
// repeated filesystem discovery across suites/workers.
process.env.OPENCLAW_PLUGIN_MANIFEST_CACHE_MS ??= "60000";
// Vitest fork workers can load transitive lockfile helpers many times per worker.
// Raise listener budget to avoid noisy MaxListeners warnings and warning-stack overhead.
const TEST_PROCESS_MAX_LISTENERS = 256;
if (process.getMaxListeners() > 0 && process.getMaxListeners() < TEST_PROCESS_MAX_LISTENERS) {
  process.setMaxListeners(TEST_PROCESS_MAX_LISTENERS);
}

import { installProcessWarningFilter } from "../src/infra/warning-filter.js";
import { withIsolatedTestHome } from "./test-env.js";

type SharedTestSetupOptions = {
  loadProfileEnv?: boolean;
};

const SHARED_TEST_SETUP = Symbol.for("openclaw.sharedTestSetup");

type SharedTestSetupHandle = {
  cleanup: () => void;
  tempHome: string;
};

export function installSharedTestSetup(options?: SharedTestSetupOptions): {
  cleanup: () => void;
  tempHome: string;
} {
  const globalState = globalThis as typeof globalThis & {
    [SHARED_TEST_SETUP]?: SharedTestSetupHandle;
  };
  const existing = globalState[SHARED_TEST_SETUP];
  if (existing) {
    return existing;
  }

  const testEnv = withIsolatedTestHome({
    loadProfileEnv: options?.loadProfileEnv,
  });
  installProcessWarningFilter();

  let cleaned = false;
  const handle: SharedTestSetupHandle = {
    tempHome: testEnv.tempHome,
    cleanup: () => {
      if (cleaned) {
        return;
      }
      cleaned = true;
      testEnv.cleanup();
      delete globalState[SHARED_TEST_SETUP];
    },
  };
  process.once("exit", handle.cleanup);
  globalState[SHARED_TEST_SETUP] = handle;
  return handle;
}
