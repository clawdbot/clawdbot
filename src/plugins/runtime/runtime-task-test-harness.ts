// Runtime task test harness helpers build mocked plugin runtimes for task-flow tests.
import { vi } from "vitest";
import {
  resetDetachedTaskLifecycleRuntimeForTests,
  resetTaskFlowRegistryForTests,
  resetTaskRegistryControlRuntimeForTests,
  resetTaskRegistryDeliveryRuntimeForTests,
  resetTaskRegistryForTests,
  setTaskRegistryControlRuntimeForTests,
  setTaskRegistryDeliveryRuntimeForTests,
} from "../../tasks/task-runtime.test-helpers.js";

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
    cancelActiveCronTaskRun: () => false,
    getAcpSessionManager: () => ({
      cancelSession: runtimeTaskMocks.cancelSessionMock,
    }),
    killSubagentRunAdmin: (params: unknown) => runtimeTaskMocks.killSubagentRunAdminMock(params),
  });
}

// Runtime task tests write durable rows into the worker's shared state store.
// Skipping the reset write leaves those rows behind, and the next
// ensureTaskRegistryReady() restores them into the process registry as active
// restart blockers for every later test file in the same worker.
export function resetRuntimeTaskTestState(): void {
  resetDetachedTaskLifecycleRuntimeForTests();
  resetTaskRegistryControlRuntimeForTests();
  resetTaskRegistryDeliveryRuntimeForTests();
  resetTaskRegistryForTests();
  resetTaskFlowRegistryForTests();
  vi.clearAllMocks();
}
