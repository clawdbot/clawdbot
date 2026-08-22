import { afterEach, describe, expect, it, vi } from "vitest";
import { createSubagentRegistryContextCleanup } from "./subagent-registry-context-cleanup.js";
import {
  resetSubagentRegistryRuntimeLoadersForTests,
  setSubagentRegistryDepsForTest,
} from "./subagent-registry-deps.js";

describe("subagent registry context cleanup", () => {
  afterEach(() => {
    setSubagentRegistryDepsForTest();
    resetSubagentRegistryRuntimeLoadersForTests();
  });

  it("rechecks lifecycle ownership after resolving the context engine", async () => {
    let releaseResolution!: () => void;
    const resolutionGate = new Promise<void>((resolve) => {
      releaseResolution = resolve;
    });
    let resolutionStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      resolutionStarted = resolve;
    });
    const onSubagentEnded = vi.fn(async () => {});
    setSubagentRegistryDepsForTest({
      loadAgentRuntimePluginRegistryHandle: () => undefined,
      ensureContextEnginesInitialized: vi.fn(),
      resolveContextEngine: vi.fn(async () => {
        resolutionStarted();
        await resolutionGate;
        return { onSubagentEnded } as never;
      }),
    });
    const cleanup = createSubagentRegistryContextCleanup({
      deps: () => ({ getRuntimeConfig: () => ({}) }) as never,
      persist: vi.fn(),
      warn: vi.fn(),
    });
    let current = true;

    const pending = cleanup.notifyContextEngineSubagentEnded(
      {
        childSessionKey: "agent:main:subagent:retired",
        reason: "completed",
      },
      { isCurrent: () => current },
    );
    await started;
    current = false;
    releaseResolution();
    await pending;

    expect(onSubagentEnded).not.toHaveBeenCalled();
  });
});
