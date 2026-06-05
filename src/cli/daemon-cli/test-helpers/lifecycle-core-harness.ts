// Vitest harness for daemon lifecycle-core service and runtime dependencies.
import { vi } from "vitest";
import type { GatewayService } from "../../../daemon/service.js";
import type { MockFn } from "../../../test-utils/vitest-mock-fn.js";
import { createCliRuntimeCapture } from "../../test-runtime-capture.js";

const lifecycleRuntimeCapture = createCliRuntimeCapture();
export const runtimeLogs = lifecycleRuntimeCapture.runtimeLogs;
type LifecycleRuntimeHarness = typeof lifecycleRuntimeCapture.defaultRuntime;

type LifecycleServiceHarness = GatewayService & {
  stage: MockFn<GatewayService["stage"]>;
  install: MockFn<GatewayService["install"]>;
  uninstall: MockFn<GatewayService["uninstall"]>;
  stop: MockFn<GatewayService["stop"]>;
  isLoaded: MockFn<GatewayService["isLoaded"]>;
  readCommand: MockFn<GatewayService["readCommand"]>;
  readRuntime: MockFn<GatewayService["readRuntime"]>;
  restart: MockFn<GatewayService["restart"]>;
};

export const defaultRuntime: LifecycleRuntimeHarness = lifecycleRuntimeCapture.defaultRuntime;

export const service: LifecycleServiceHarness = {
  label: "TestService",
  loadedText: "loaded",
  notLoadedText: "not loaded",
  stage: vi.fn(),
  install: vi.fn(),
  uninstall: vi.fn(),
  stop: vi.fn(),
  isLoaded: vi.fn(),
  readCommand: vi.fn(),
  readRuntime: vi.fn(),
  restart: vi.fn(),
};

export function resetLifecycleRuntimeLogs() {
  lifecycleRuntimeCapture.resetRuntimeCapture();
}

export function resetLifecycleServiceMocks() {
  service.stage.mockReset();
  service.install.mockReset();
  service.uninstall.mockReset();
  service.stop.mockReset();
  service.isLoaded.mockReset();
  service.readCommand.mockReset();
  service.readRuntime.mockReset();
  service.restart.mockReset();
  service.isLoaded.mockResolvedValue(true);
  service.readCommand.mockResolvedValue({ programArguments: [], environment: {} });
  service.readRuntime.mockResolvedValue({ status: "running" });
  service.stop.mockResolvedValue(undefined);
  service.uninstall.mockResolvedValue(undefined);
  service.restart.mockResolvedValue({ outcome: "completed" });
}

export function stubEmptyGatewayEnv() {
  vi.unstubAllEnvs();
  vi.stubEnv("OPENCLAW_GATEWAY_TOKEN", "");
  vi.stubEnv("OPENCLAW_GATEWAY_URL", "");
}
