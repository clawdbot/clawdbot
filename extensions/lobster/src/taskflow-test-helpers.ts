// Lobster helper module supports taskflow test helpers behavior.
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
    notifyPolicy: "done_only" as const,
    createdAt: 1,
    updatedAt: 1,
  };
  let current: NonNullable<ReturnType<BoundTaskFlow["get"]>> = {
    ...baseFlow,
    status: "waiting",
    revision: 4,
    waitJson: {
      kind: "lobster_approval",
      prompt: "Continue?",
      items: [],
      resumeToken: "resume-1",
      approvalId: "approval-1",
    },
  };
  const createManaged = vi.fn(
    (_params: Parameters<BoundTaskFlow["createManaged"]>[0]) => (current = { ...baseFlow }),
  );
  const mutate = (input: { expectedRevision: number }, status: typeof current.status) => {
    current = { ...current, revision: input.expectedRevision + 1, status };
    return { applied: true, flow: current };
  };

  return {
    sessionKey: "agent:main:main",
    createManaged,
    tryCreateManaged: vi.fn((params) => createManaged(params)),
    get: vi.fn(() => current),
    list: vi.fn().mockReturnValue([]),
    findLatest: vi.fn(),
    resolve: vi.fn(),
    getTaskSummary: vi.fn(),
    setWaiting: vi.fn().mockImplementation((input) => mutate(input, "waiting")),
    resume: vi.fn().mockImplementation((input) => mutate(input, "running")),
    finish: vi.fn().mockImplementation((input) => mutate(input, "succeeded")),
    fail: vi.fn().mockImplementation((input) => mutate(input, "failed")),
    requestCancel: vi.fn(),
    cancel: vi.fn(),
    runTask: vi.fn(),
    ...overrides,
  };
}
