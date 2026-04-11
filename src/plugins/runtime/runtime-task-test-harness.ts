import { vi } from "vitest";
import {
  resetTaskRegistryDeliveryRuntimeForTests,
  resetTaskRegistryForTests,
  setTaskRegistryDeliveryRuntimeForTests,
} from "../../tasks/runtime-internal.js";
import { resetTaskFlowRegistryForTests } from "../../tasks/task-flow-runtime-internal.js";

const runtimeTaskMocks = vi.hoisted(() => ({
  sendMessageMock: vi.fn(),
  cancelSessionMock: vi.fn(),
  killSubagentRunAdminMock: vi.fn(),
}));

vi.mock("../../tasks/task-registry-control.runtime.js", () => ({
  getAcpSessionManager: () => ({
    cancelSession: runtimeTaskMocks.cancelSessionMock,
  }),
  killSubagentRunAdmin: (params: unknown) => runtimeTaskMocks.killSubagentRunAdminMock(params),
}));

export function getRuntimeTaskMocks() {
  return runtimeTaskMocks;
}

export function installRuntimeTaskDeliveryMock(): void {
  setTaskRegistryDeliveryRuntimeForTests({
    sendMessage: runtimeTaskMocks.sendMessageMock,
  });
}

export function resetRuntimeTaskTestState(
  taskRegistryOptions?: Parameters<typeof resetTaskRegistryForTests>[0],
): void {
  resetTaskRegistryDeliveryRuntimeForTests();
  resetTaskRegistryForTests(taskRegistryOptions);
  resetTaskFlowRegistryForTests({ persist: false });
  vi.clearAllMocks();
}
