import { describe, expect, it, vi } from "vitest";
import {
  getActiveAgentRingZeroTools,
  runWithAgentRingZeroTools,
} from "./agent-tools.ring-zero-context.js";
import type { AnyAgentTool } from "./agent-tools.types.js";
import { stubTool } from "./test-helpers/fast-tool-stubs.js";

function ringZeroTool(name: string) {
  return {
    ...stubTool(name),
    label: name,
    execute: async () => ({ content: [], details: {} }),
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function deferredValue<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("agent ring-zero tool context", () => {
  it("isolates concurrent async runs and clears the scope after settlement", async () => {
    const firstTool = ringZeroTool("first-ring-zero");
    const secondTool = ringZeroTool("second-ring-zero");
    const firstReady = deferred();
    const secondReady = deferred();
    const release = deferred();

    const first = runWithAgentRingZeroTools([firstTool], async () => {
      firstReady.resolve();
      await release.promise;
      return getActiveAgentRingZeroTools();
    });
    const second = runWithAgentRingZeroTools([secondTool], async () => {
      secondReady.resolve();
      await release.promise;
      return getActiveAgentRingZeroTools();
    });

    await Promise.all([firstReady.promise, secondReady.promise]);
    expect(getActiveAgentRingZeroTools()).toEqual([]);
    release.resolve();

    expect((await first).map((tool) => tool.name)).toEqual([firstTool.name]);
    expect((await second).map((tool) => tool.name)).toEqual([secondTool.name]);
    expect(getActiveAgentRingZeroTools()).toEqual([]);
  });

  it("lets nested normal runs explicitly clear inherited authority", () => {
    const tool = ringZeroTool("ring-zero");

    runWithAgentRingZeroTools([tool], () => {
      expect(getActiveAgentRingZeroTools().map((activeTool) => activeTool.name)).toEqual([
        tool.name,
      ]);
      runWithAgentRingZeroTools([], () => {
        expect(getActiveAgentRingZeroTools()).toEqual([]);
      });
      expect(getActiveAgentRingZeroTools().map((activeTool) => activeTool.name)).toEqual([
        tool.name,
      ]);
    });

    expect(getActiveAgentRingZeroTools()).toEqual([]);
  });

  it("revokes authority from detached callbacks after the run settles", async () => {
    const tool = ringZeroTool("ring-zero");
    const detachedResult = deferredValue<readonly { name: string }[]>();

    await runWithAgentRingZeroTools([tool], async () => {
      expect(getActiveAgentRingZeroTools().map((activeTool) => activeTool.name)).toEqual([
        tool.name,
      ]);
      setTimeout(() => {
        detachedResult.resolve(getActiveAgentRingZeroTools());
      }, 0);
    });

    expect(getActiveAgentRingZeroTools()).toEqual([]);
    expect(await detachedResult.promise).toEqual([]);
  });

  it("revokes retained executable handles after the run settles", async () => {
    const execute = vi.fn(async () => ({ content: [], details: {} }));
    const tool = { ...ringZeroTool("ring-zero"), execute };
    let retainedTool: AnyAgentTool | undefined;

    await runWithAgentRingZeroTools([tool], async () => {
      retainedTool = getActiveAgentRingZeroTools()[0];
      await retainedTool?.execute("inside", {}, undefined, undefined);
    });

    expect(execute).toHaveBeenCalledTimes(1);
    if (!retainedTool) {
      throw new Error("expected a retained ring-zero tool handle");
    }
    await expect(retainedTool.execute("outside", {}, undefined, undefined)).rejects.toThrow(
      'host-scoped tool "ring-zero" is no longer authorized for this run',
    );
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
