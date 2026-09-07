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
  resolveWorkerPlacementCapabilities,
  resolveWorkerPlacementExecutionMode,
  resolveWorkerPlacementSessionRuntime,
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
      name: "ignores an unlocked historical runtime after selecting a different provider",
      entry: { agentHarnessId: "codex" },
      expected: "openclaw",
    },
    {
      name: "ignores an unlocked historical runtime behind the default override",
      entry: { agentHarnessId: "codex", agentRuntimeOverride: "default" },
      expected: "openclaw",
    },
    {
      name: "preserves locked transcript ownership",
      entry: { agentHarnessId: "codex", modelSelectionLocked: true },
      expected: "codex",
    },
    {
      name: "does not let a historical embedded runtime override a Codex model",
      entry: {
        agentHarnessId: "openclaw",
        providerOverride: "openai",
        modelOverride: "gpt-5.6-sol",
      },
      expected: "codex",
    },
    {
      name: "honors an explicit compatible runtime override",
      entry: {
        agentRuntimeOverride: "codex",
        providerOverride: "openai",
        modelOverride: "gpt-test",
      },
      expected: "codex",
    },
  ])("$name", ({ entry, expected }) => {
    expect(
      resolveWorkerPlacementSessionRuntime({
        cfg: {},
        entry: {
          sessionId: "placement-runtime-session",
          updatedAt: 0,
          providerOverride: "anthropic",
          modelOverride: "claude-test",
          ...entry,
        },
        agentId: "main",
        sessionKey: "agent:main:placement-runtime",
      }),
    ).toBe(expected);
  });

  it.each([
    {
      name: "embedded worker turns support paired devices",
      runtimeId: "openclaw",
      executionMode: "worker-turn",
      devicePlacementSupported: true,
      devicePlacement: { requiredNodeCommands: [], consumesWorkerSlot: true },
    },
    {
      name: "remote execution projects exact device commands without consuming a worker slot",
      runtimeId: "device-harness",
      cloudPlacement: {
        mode: "remote-exec",
        devicePlacement: {
          requiredNodeCommands: ["runtime.exec-server.v1"],
          consumesWorkerSlot: false,
        },
      },
      executionMode: "remote-exec",
      devicePlacementSupported: true,
      devicePlacement: {
        requiredNodeCommands: ["runtime.exec-server.v1"],
        consumesWorkerSlot: false,
      },
    },
    {
      name: "device command requirements are deterministic and deduplicated",
      runtimeId: "ordered-harness",
      cloudPlacement: {
        mode: "remote-exec",
        devicePlacement: {
          requiredNodeCommands: ["runtime.zeta.v1", "runtime.alpha.v1", "runtime.zeta.v1"],
          consumesWorkerSlot: false,
        },
      },
      executionMode: "remote-exec",
      devicePlacementSupported: true,
      devicePlacement: {
        requiredNodeCommands: ["runtime.alpha.v1", "runtime.zeta.v1"],
        consumesWorkerSlot: false,
      },
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
    expect(resolveWorkerPlacementCapabilities(runtimeId)).toEqual({
      ...(executionMode ? { executionMode } : {}),
      ...("devicePlacement" in declaration ? { devicePlacement: declaration.devicePlacement } : {}),
    });
    expect(resolveWorkerPlacementCapabilities(runtimeId).devicePlacement !== undefined).toBe(
      devicePlacementSupported,
    );
    expect(projectWorkerPlacementAgentRuntime({ id: runtimeId, source: "model" })).toEqual({
      id: runtimeId,
      cloudPlacementSupported: executionMode !== undefined,
      ...(executionMode ? { cloudPlacementExecutionMode: executionMode } : {}),
      ...("devicePlacement" in declaration ? { devicePlacement: declaration.devicePlacement } : {}),
      devicePlacementSupported,
      source: "model",
    });
  });

  it("fails closed when a harness requires more than the bounded command count", () => {
    registerAgentHarness({
      id: "oversized-harness",
      label: "oversized-harness",
      cloudPlacement: {
        mode: "remote-exec",
        devicePlacement: {
          requiredNodeCommands: Array.from({ length: 33 }, (_, index) => `runtime.${index}.v1`),
          consumesWorkerSlot: false,
        },
      },
      supports: () => ({ supported: true }),
      async runAttempt() {
        throw new Error("not used");
      },
    });

    expect(resolveWorkerPlacementCapabilities("oversized-harness").devicePlacement).toBeUndefined();
    expect(
      projectWorkerPlacementAgentRuntime({ id: "oversized-harness", source: "model" }),
    ).toEqual({
      id: "oversized-harness",
      cloudPlacementSupported: true,
      cloudPlacementExecutionMode: "remote-exec",
      devicePlacementSupported: false,
      source: "model",
    });
  });
});
