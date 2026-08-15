import { afterEach, describe, expect, it } from "vitest";
import { registerAgentHarness } from "../../agents/harness/registry.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import {
  getActivePluginRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";
import {
  resolveWorkerPlacementExecutionMode,
  resolveWorkerPlacementSessionRuntime,
} from "./placement-session-runtime.js";

describe("worker placement session runtime", () => {
  const originalRegistry = getActivePluginRegistry();

  afterEach(() => {
    if (originalRegistry) {
      setActivePluginRegistry(originalRegistry, "placement-runtime-test", "default");
    } else {
      resetPluginRuntimeStateForTest();
    }
  });

  it.each([
    ["openclaw", "worker-turn"],
    ["unknown", undefined],
  ] as const)("resolves %s placement mode", (runtime, expected) => {
    setActivePluginRegistry(createEmptyPluginRegistry(), "placement-runtime-test", "default");
    expect(resolveWorkerPlacementExecutionMode(runtime)).toBe(expected);
  });

  it("resolves a registered harness capability", () => {
    setActivePluginRegistry(createEmptyPluginRegistry(), "placement-runtime-test", "default");
    const harness = {
      id: "codex",
      label: "Codex",
      cloudPlacement: { mode: "remote-exec" },
      supports: () => ({ supported: true, priority: 10 }),
      async runAttempt() {
        throw new Error("not used");
      },
    } as const;
    registerAgentHarness(harness);

    expect(resolveWorkerPlacementExecutionMode("codex")).toBe("remote-exec");
  });

  it("uses a persisted runtime before model policy", () => {
    setActivePluginRegistry(createEmptyPluginRegistry(), "placement-runtime-test", "default");
    const harness = {
      id: "codex",
      label: "Codex",
      cloudPlacement: { mode: "remote-exec" },
      supports: () => ({ supported: true, priority: 10 }),
      async runAttempt() {
        throw new Error("not used");
      },
    } as const;
    registerAgentHarness(harness);
    const runtime = resolveWorkerPlacementSessionRuntime({
      cfg: {},
      entry: { sessionId: "persisted-runtime", updatedAt: 1, agentRuntimeOverride: "codex" },
      agentId: "main",
      sessionKey: "agent:main:persisted-runtime",
    });

    expect(runtime).toBe("codex");
    expect(resolveWorkerPlacementExecutionMode(runtime)).toBe("remote-exec");
  });
});
