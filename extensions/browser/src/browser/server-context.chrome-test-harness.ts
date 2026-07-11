/**
 * Shared Chrome module mocks for Browser server-context tests.
 */
import { vi } from "vitest";
import { installChromeUserDataDirHooks } from "./chrome-user-data-dir.test-harness.js";

const chromeUserDataDir = { dir: "/tmp/openclaw" };
installChromeUserDataDirHooks(chromeUserDataDir);

vi.mock("./chrome.js", () => ({
  ManagedChromeCleanupError: class ManagedChromeCleanupError extends Error {
    readonly code = "MANAGED_CHROME_CLEANUP_FAILED";

    constructor(
      message: string,
      readonly running: unknown,
    ) {
      super(message);
    }
  },
  diagnoseChromeCdp: vi.fn(async () => ({
    ok: false,
    code: "websocket_health_command_timeout",
    cdpUrl: "http://127.0.0.1:18800",
    message: "mock CDP diagnostic",
    elapsedMs: 1,
  })),
  formatChromeCdpDiagnostic: vi.fn((diagnostic: { ok: boolean; code?: string; message?: string }) =>
    diagnostic.ok
      ? "CDP diagnostic: ready."
      : `CDP diagnostic: ${diagnostic.code}; ${diagnostic.message}.`,
  ),
  isChromeCdpOwnedByPid: vi.fn(async () => true),
  isChromeCdpReady: vi.fn(async () => true),
  isChromeReachable: vi.fn(async () => true),
  launchOpenClawChrome: vi.fn(async () => {
    throw new Error("unexpected launch");
  }),
  resolveOpenClawUserDataDir: vi.fn(() => chromeUserDataDir.dir),
  stopOpenClawChrome: vi.fn(async () => {}),
}));
