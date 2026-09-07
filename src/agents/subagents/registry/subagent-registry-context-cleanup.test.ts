import { afterEach, describe, expect, it, vi } from "vitest";
import { PluginRegistryResourceScope } from "../../../plugins/registry-resources.js";
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

  it.each(["loader", "resource admission"])(
    "completes ended-hook cleanup when %s rejects",
    async (failure) => {
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

      const invoke = () => cleanup.emitSubagentEndedHookForRun({ entry });
      let pending: Promise<void>;
      if (failure === "loader") {
        pending = invoke();
      } else {
        const resources = new PluginRegistryResourceScope();
        pending = resources.run(() => {
          resources.release();
          return invoke();
        });
      }
      await expect(pending).resolves.toBeUndefined();

      expect(warn).toHaveBeenCalledWith("subagent_ended hook failed (best-effort)", {
        phase: "plugin-runtime",
        err:
          failure === "loader"
            ? error
            : expect.objectContaining({
                message: "Plugin registry resource scope has been released",
              }),
      });
      expect(entry.endedHookEmittedAt).toBeUndefined();
      expect(persist).not.toHaveBeenCalled();
    },
  );

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
