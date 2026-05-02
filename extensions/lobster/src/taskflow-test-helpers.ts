import { vi } from "vitest";
import type { OpenClawPluginApi } from "../runtime-api.js";

type BoundTaskFlow = ReturnType<
  NonNullable<OpenClawPluginApi["runtime"]>["tasks"]["managedFlows"]["bindSession"]
>;

export function createFakeTaskFlow(overrides?: Partial<BoundTaskFlow>): BoundTaskFlow {
  const baseFlow = {
    flowId: "flow-1",
    revision: 1,
    syncMode: "managed" as const,
    controllerId: "tests/lobster",
    ownerKey: "agent:main:main",
    status: "running" as const,
    goal: "Run Lobster workflow",
  };

  return {
    sessionKey: "agent:main:main",
    createManaged: vi.fn().mockReturnValue(baseFlow),
    get: vi.fn(),
    list: vi.fn().mockReturnValue([]),
    findLatest: vi.fn(),
    resolve: vi.fn(),
    getTaskSummary: vi.fn(),
    setWaiting: vi.fn().mockImplementation((input) => ({
      applied: true,
      flow: { ...baseFlow, revision: input.expectedRevision + 1, status: "waiting" as const },
    })),
    resume: vi.fn().mockImplementation((input) => ({
      applied: true,
      flow: { ...baseFlow, revision: input.expectedRevision + 1, status: "running" as const },
    })),
    finish: vi.fn().mockImplementation((input) => ({
      applied: true,
      flow: { ...baseFlow, revision: input.expectedRevision + 1, status: "completed" as const },
    })),
    fail: vi.fn().mockImplementation((input) => ({
      applied: true,
      flow: { ...baseFlow, revision: input.expectedRevision + 1, status: "failed" as const },
    })),
    requestCancel: vi.fn(),
    cancel: vi.fn(),
    runTask: vi.fn(),
    ...overrides,
  };
}
