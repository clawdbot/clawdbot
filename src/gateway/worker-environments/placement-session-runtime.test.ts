import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerAgentHarness } from "../../agents/harness/registry.js";
import type { AgentHarness } from "../../agents/harness/types.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import {
  getActivePluginRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";
import {
  projectWorkerPlacementAgentRuntime,
  resolveWorkerPlacementExecutionMode,
  supportsWorkerPlacementOnDevice,
} from "./placement-session-runtime.js";

const originalPluginRegistry = getActivePluginRegistry();

describe("worker placement runtime capabilities", () => {
  beforeEach(() => {
    setActivePluginRegistry(createEmptyPluginRegistry(), "placement-runtime-test", "default");
  });

  afterEach(() => {
    if (originalPluginRegistry) {
      setActivePluginRegistry(originalPluginRegistry, "placement-runtime-test-restore", "default");
      return;
    }
    resetPluginRuntimeStateForTest();
  });

  it.each([
    {
      name: "embedded worker turns support paired devices",
      runtimeId: "openclaw",
      executionMode: "worker-turn",
      devicePlacementSupported: true,
    },
    {
      name: "remote execution supports paired devices only when declared",
      runtimeId: "device-harness",
      cloudPlacement: { mode: "remote-exec", devicePlacement: true },
      executionMode: "remote-exec",
      devicePlacementSupported: true,
    },
    {
      name: "cloud-only remote execution does not support paired devices",
      runtimeId: "cloud-harness",
      cloudPlacement: { mode: "remote-exec" },
      executionMode: "remote-exec",
      devicePlacementSupported: false,
    },
    {
      name: "unknown runtimes support no placement",
      runtimeId: "missing-harness",
      executionMode: undefined,
      devicePlacementSupported: false,
    },
  ] as const)("$name", ({ runtimeId, executionMode, devicePlacementSupported, ...declaration }) => {
    if ("cloudPlacement" in declaration) {
      const harness: AgentHarness = {
        id: runtimeId,
        label: runtimeId,
        cloudPlacement: declaration.cloudPlacement,
        supports: () => ({ supported: true }),
        async runAttempt() {
          throw new Error("not used");
        },
      };
      registerAgentHarness(harness);
    }

    expect(resolveWorkerPlacementExecutionMode(runtimeId)).toBe(executionMode);
    expect(supportsWorkerPlacementOnDevice(runtimeId)).toBe(devicePlacementSupported);
    expect(projectWorkerPlacementAgentRuntime({ id: runtimeId, source: "model" })).toEqual({
      id: runtimeId,
      cloudPlacementSupported: executionMode !== undefined,
      ...(executionMode ? { cloudPlacementExecutionMode: executionMode } : {}),
      devicePlacementSupported,
      source: "model",
    });
  });
});
