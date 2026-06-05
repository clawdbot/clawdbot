/** Test helpers for exercising generic daemon service orchestration. */
import { vi } from "vitest";
import type { GatewayService } from "./service.js";

/** Creates a mock gateway service implementation for daemon service tests. */
export function createMockGatewayService(overrides: Partial<GatewayService> = {}): GatewayService {
  return {
    label: "LaunchAgent",
    loadedText: "loaded",
    notLoadedText: "not loaded",
    stage: vi.fn(async () => {}),
    install: vi.fn(async () => {}),
    uninstall: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    restart: vi.fn(async () => ({ outcome: "completed" as const })),
    isLoaded: vi.fn(async () => false),
    readCommand: vi.fn(async () => null),
    readRuntime: vi.fn(async () => ({ status: "stopped" as const })),
    ...overrides,
  };
}
