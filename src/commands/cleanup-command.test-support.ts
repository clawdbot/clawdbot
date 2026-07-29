// Cleanup command test support provides non-exiting runtimes and log captures for cleanup suites.
import { vi } from "vitest";
import { createNonExitingRuntime, type RuntimeEnv } from "../runtime.js";
import type { MockFn } from "../test-utils/vitest-mock-fn.js";

const resolveCleanupPlanFromDisk = vi.fn();
const removePath = vi.fn();
const listAgentSessionDirs = vi.fn();
export const prepareLegacyWorkspaceStateReset = vi.fn();
export const removeLegacyWorkspaceStateForReset = vi.fn();
export const removeStateAndLinkedPaths = vi.fn();
export const removeWorkspaceDirs = vi.fn();

vi.mock("../agents/workspace-legacy-state.js", () => ({
  prepareLegacyWorkspaceStateReset,
  removeLegacyWorkspaceStateForReset,
}));

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
  removeWorkspaceDirs,
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
  prepareLegacyWorkspaceStateReset.mockImplementation((workspaceDir: string) => ({ workspaceDir }));
  removeLegacyWorkspaceStateForReset.mockResolvedValue({ removedPaths: [], warnings: [] });
  removeStateAndLinkedPaths.mockResolvedValue(true);
  removeWorkspaceDirs.mockResolvedValue(undefined);
}

export function silenceCleanupCommandRuntime(runtime: RuntimeEnv) {
  vi.spyOn(runtime, "log").mockImplementation(() => {});
  vi.spyOn(runtime, "error").mockImplementation(() => {});
}

export function cleanupCommandLogMessages(runtime: RuntimeEnv): string[] {
  const calls = (runtime.log as MockFn<(...args: unknown[]) => void>).mock.calls;
  return calls.map((call) => String(call[0]));
}
