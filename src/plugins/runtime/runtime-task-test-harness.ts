import { vi } from "vitest";
import { resetDetachedTaskLifecycleRuntimeForTests } from "../../tasks/detached-task-runtime.js";
import {
  resetTaskRegistryControlRuntimeForTests,
  resetTaskRegistryDeliveryRuntimeForTests,
  resetTaskRegistryForTests,
  setTaskRegistryControlRuntimeForTests,
  setTaskRegistryDeliveryRuntimeForTests,
} from "../../tasks/runtime-internal.js";
import { resetTaskFlowRegistryForTests } from "../../tasks/task-flow-runtime-internal.js";

const runtimeTaskMocks = vi.hoisted(() => ({
  sendMessageMock: vi.fn(),
  cancelSessionMock: vi.fn(),
  killSubagentRunAdminMock: vi.fn(),
}));

export function getRuntimeTaskMocks() {
  return runtimeTaskMocks;
}

export function installRuntimeTaskDeliveryMock(): void {
  setTaskRegistryDeliveryRuntimeForTests({
    sendMessage: runtimeTaskMocks.sendMessageMock,
  });
  setTaskRegistryControlRuntimeForTests({
    getAcpSessionManager: () => ({
      cancelSession: runtimeTaskMocks.cancelSessionMock,
    }),
    killSubagentRunAdmin: (params: unknown) => runtimeTaskMocks.killSubagentRunAdminMock(params),
  });
}

export function resetRuntimeTaskTestState(
  taskRegistryOptions?: Parameters<typeof resetTaskRegistryForTests>[0],
): void {
  resetDetachedTaskLifecycleRuntimeForTests();
  resetTaskRegistryControlRuntimeForTests();
  resetTaskRegistryDeliveryRuntimeForTests();
  resetTaskRegistryForTests(taskRegistryOptions);
  resetTaskFlowRegistryForTests({ persist: false });
  vi.clearAllMocks();
}
