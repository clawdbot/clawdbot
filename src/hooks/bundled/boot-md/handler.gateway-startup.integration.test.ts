import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveAgentWorkspaceDir } from "../../../agents/agent-scope.js";
import type { CliDeps } from "../../../cli/deps.js";
import type { OpenClawConfig } from "../../../config/config.js";

const runBootOnce = vi.fn();

function createMockLogger() {
  return {
    warn: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(() => createMockLogger()),
  };
}

vi.mock("../../../gateway/boot.js", () => ({ runBootOnce }));
vi.mock("../../../logging/subsystem.js", () => ({
  createSubsystemLogger: () => createMockLogger(),
}));

const { default: runBootChecklist } = await import("./handler.js");
const { clearInternalHooks, createInternalHookEvent, registerInternalHook, triggerInternalHook } =
  await import("../../internal-hooks.js");

function expectBootCall(
  index: number,
  expected: { cfg: OpenClawConfig; deps: CliDeps; workspaceDir: string; agentId: string },
) {
  const params = runBootOnce.mock.calls[index]?.[0] as
    | { cfg?: unknown; deps?: unknown; workspaceDir?: unknown; agentId?: unknown }
    | undefined;
  if (!params) {
    throw new Error(`missing boot call ${index}`);
  }
  expect(params.cfg).toBe(expected.cfg);
  expect(params.deps).toBe(expected.deps);
  expect(params.workspaceDir).toBe(expected.workspaceDir);
  expect(params.agentId).toBe(expected.agentId);
}

describe("boot-md startup hook integration", () => {
  beforeEach(() => {
    runBootOnce.mockClear();
    clearInternalHooks();
  });

  afterEach(() => {
    clearInternalHooks();
  });

  it("dispatches gateway:startup through internal hooks and runs BOOT for each configured agent scope", async () => {
    const cfg = {
      hooks: { internal: { enabled: true } },
      agents: {
        list: [
          { id: "main", default: true, workspace: "/ws/main" },
          { id: "ops", workspace: "/ws/ops" },
        ],
      },
    } as OpenClawConfig;
    const deps = {} as CliDeps;
    runBootOnce.mockResolvedValue({ status: "ran" });

    registerInternalHook("gateway:startup", runBootChecklist);
    const event = createInternalHookEvent("gateway", "startup", "gateway:startup", { cfg, deps });
    await triggerInternalHook(event);

    const mainWorkspaceDir = resolveAgentWorkspaceDir(cfg, "main");
    const opsWorkspaceDir = resolveAgentWorkspaceDir(cfg, "ops");

    expect(runBootOnce).toHaveBeenCalledTimes(2);
    expectBootCall(0, { cfg, deps, workspaceDir: mainWorkspaceDir, agentId: "main" });
    expectBootCall(1, { cfg, deps, workspaceDir: opsWorkspaceDir, agentId: "ops" });
  });
});
