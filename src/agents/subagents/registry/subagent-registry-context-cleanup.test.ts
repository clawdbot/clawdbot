import { afterEach, describe, expect, it, vi } from "vitest";
import { createSubagentRunRecord } from "../../subagent-test-fixtures.test-helpers.js";
import { createSubagentRegistryContextCleanup } from "./subagent-registry-context-cleanup.js";
import {
  resetSubagentRegistryRuntimeLoadersForTests,
  setSubagentRegistryDepsForTest,
  subagentRegistryDeps,
} from "./subagent-registry-deps.js";

describe("subagent registry context cleanup", () => {
  afterEach(() => {
    setSubagentRegistryDepsForTest();
    resetSubagentRegistryRuntimeLoadersForTests();
  });

  it("completes ended-hook cleanup when the plugin runtime loader rejects", async () => {
    const error = new Error("plugin runtime import failed");
    setSubagentRegistryDepsForTest({
      getRuntimeConfig: () => ({}),
      loadAgentRuntimePluginRegistryHandle: () => {
        throw error;
      },
    });
    const warn = vi.fn();
    const persist = vi.fn();
    const cleanup = createSubagentRegistryContextCleanup({
      deps: () => subagentRegistryDeps,
      persist,
      warn,
    });
    const entry = createSubagentRunRecord({ runId: "run-ended", endedAt: 4_000 });

    await expect(cleanup.emitSubagentEndedHookForRun({ entry })).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith("subagent_ended hook failed (best-effort)", {
      phase: "plugin-runtime",
      err: error,
    });
    expect(entry.endedHookEmittedAt).toBeUndefined();
    expect(persist).not.toHaveBeenCalled();
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
