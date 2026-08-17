// Cleanup command test support provides non-exiting runtimes and log captures for cleanup suites.
import { vi } from "vitest";
import { createNonExitingRuntime, type RuntimeEnv } from "../runtime.js";
import type { MockFn } from "../test-utils/vitest-mock-fn.js";

const resolveCleanupPlanForDryRun = vi.fn();
export const resolveCleanupPlanForRemoval = vi.fn();
const removePath = vi.fn();
export const listAgentSessionDirs = vi.fn();
export const prepareLegacyWorkspaceStateReset = vi.fn();
export const removeLegacyWorkspaceStateForReset = vi.fn();
export const removeStateAndLinkedPaths = vi.fn();
export const removeWorkspaceDirs = vi.fn();
const gatewayServiceState = vi.hoisted(() => ({
  notLoadedText: "is not installed",
  isLoaded: vi.fn(),
  stop: vi.fn(),
  uninstall: vi.fn(),
}));
export const gatewayService = gatewayServiceState;
const cleanupConfigState = vi.hoisted(() => ({ isNixMode: false }));

vi.mock("../agents/workspace-legacy-state.js", () => ({
  prepareLegacyWorkspaceStateReset,
  removeLegacyWorkspaceStateForReset,
}));

vi.mock("../config/config.js", () => ({
  get isNixMode() {
    return cleanupConfigState.isNixMode;
  },
  resolveConfigPath: () => "/tmp/.openclaw/openclaw.json",
}));

vi.mock("../daemon/service.js", () => ({
  resolveGatewayService: () => gatewayService,
}));

vi.mock("./cleanup-plan.js", () => ({
  resolveCleanupPlanForDryRun,
  resolveCleanupPlanForRemoval,
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
  const cleanupPlan = {
    stateDir: "/tmp/.openclaw",
    configPath: "/tmp/.openclaw/openclaw.json",
    oauthDir: "/tmp/.openclaw/credentials",
    configInsideState: true,
    oauthInsideState: true,
    workspaceDirs: ["/tmp/.openclaw/workspace"],
  };
  resolveCleanupPlanForDryRun.mockResolvedValue(cleanupPlan);
  resolveCleanupPlanForRemoval.mockResolvedValue(cleanupPlan);
  removePath.mockResolvedValue({ ok: true });
  listAgentSessionDirs.mockResolvedValue(["/tmp/.openclaw/agents/main/sessions"]);
  prepareLegacyWorkspaceStateReset.mockImplementation((workspaceDir: string) => ({ workspaceDir }));
  removeLegacyWorkspaceStateForReset.mockResolvedValue({ removedPaths: [], warnings: [] });
  removeStateAndLinkedPaths.mockResolvedValue(true);
  removeWorkspaceDirs.mockResolvedValue(undefined);
  gatewayService.isLoaded.mockReset().mockResolvedValue(true);
  gatewayService.stop.mockReset().mockResolvedValue(undefined);
  gatewayService.uninstall.mockReset().mockResolvedValue(undefined);
  cleanupConfigState.isNixMode = false;
}

export function setCleanupNixMode(value: boolean) {
  cleanupConfigState.isNixMode = value;
}

export function silenceCleanupCommandRuntime(runtime: RuntimeEnv) {
  vi.spyOn(runtime, "log").mockImplementation(() => {});
  vi.spyOn(runtime, "error").mockImplementation(() => {});
}

export function cleanupCommandLogMessages(runtime: RuntimeEnv): string[] {
  const calls = (runtime.log as MockFn<(...args: unknown[]) => void>).mock.calls;
  return calls.map((call) => String(call[0]));
}
