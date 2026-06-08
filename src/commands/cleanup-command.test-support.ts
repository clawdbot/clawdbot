// Cleanup command test support provides non-exiting runtimes and log captures for cleanup suites.
import { vi } from "vitest";
import { createNonExitingRuntime, type RuntimeEnv } from "../runtime.js";
import type { MockFn } from "../test-utils/vitest-mock-fn.js";

const resolveCleanupPlanFromDisk = vi.fn();
const removePath = vi.fn();
const listAgentSessionDirs = vi.fn();
export const removeStateAndLinkedPaths = vi.fn();
const removeWorkspaceDirs = vi.fn();
export const removeWorkspaceAttestationPaths = vi.fn();
export const clearExistingSqliteSessionStore = vi.fn();

vi.mock("../config/config.js", () => ({
  isNixMode: false,
}));

vi.mock("./cleanup-plan.js", () => ({
  resolveCleanupPlanFromDisk,
}));

vi.mock("./cleanup-utils.js", () => ({
  removePath,
  listAgentSessionDirs,
  removeStateAndLinkedPaths,
  removeWorkspaceAttestationPaths,
  removeWorkspaceDirs,
}));

vi.mock("../config/sessions/store-sqlite.js", () => ({
  clearExistingSqliteSessionStore,
}));

export function createCleanupCommandRuntime() {
  return createNonExitingRuntime();
}

export function resetCleanupCommandMocks() {
  vi.clearAllMocks();
  resolveCleanupPlanFromDisk.mockReturnValue({
    stateDir: "/tmp/.openclaw",
    configPath: "/tmp/.openclaw/openclaw.json",
    oauthDir: "/tmp/.openclaw/credentials",
    configInsideState: true,
    oauthInsideState: true,
    workspaceDirs: ["/tmp/.openclaw/workspace"],
  });
  removePath.mockResolvedValue({ ok: true });
  listAgentSessionDirs.mockResolvedValue(["/tmp/.openclaw/agents/main/sessions"]);
  removeStateAndLinkedPaths.mockResolvedValue(undefined);
  removeWorkspaceDirs.mockResolvedValue(undefined);
  removeWorkspaceAttestationPaths.mockResolvedValue(undefined);
  clearExistingSqliteSessionStore.mockReturnValue(false);
}

export function silenceCleanupCommandRuntime(runtime: RuntimeEnv) {
  vi.spyOn(runtime, "log").mockImplementation(() => {});
  vi.spyOn(runtime, "error").mockImplementation(() => {});
}

export function cleanupCommandLogMessages(runtime: RuntimeEnv): string[] {
  const calls = (runtime.log as MockFn<(...args: unknown[]) => void>).mock.calls;
  return calls.map((call) => String(call[0]));
}
