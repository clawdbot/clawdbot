import { describe, expect, it, vi } from "vitest";
import {
  isTurnYieldAvailable,
  requestTurnYield,
  runPluginToolBodyWithTurnYieldLease,
  runWithPluginToolTurnYieldInvocation,
  type PluginTurnYieldCommitter,
} from "./tool-yield-context.js";

function createCommitter(): PluginTurnYieldCommitter {
  return {
    supported: true,
    commit: vi.fn(async () => undefined),
  };
}

async function runSupportedToolBody<T>(run: () => Promise<T>): Promise<T> {
  return await runPluginToolBodyWithTurnYieldLease({ run });
}

async function runSupportedInvocation<T>(run: () => Promise<T>) {
  return await runWithPluginToolTurnYieldInvocation({
    catalogMode: "direct-only",
    committer: createCommitter(),
    executionMode: "sequential",
    run,
  });
}

describe("plugin tool turn-yield context", () => {
  it("is unavailable outside a concrete plugin tool body", () => {
    expect(isTurnYieldAvailable()).toBe(false);
    expect(() => requestTurnYield("outside")).toThrow("requires an active plugin tool execution");
  });

  it("keeps hooks unavailable while allowing the concrete body", async () => {
    const execution = await runSupportedInvocation(async () => {
      expect(isTurnYieldAvailable()).toBe(false);
      await runSupportedToolBody(async () => {
        expect(isTurnYieldAvailable()).toBe(true);
        requestTurnYield("body request");
      });
      expect(isTurnYieldAvailable()).toBe(false);
      return "done";
    });

    expect(execution).toEqual({ result: "done", requestedMessage: "body request" });
  });

  it("keeps authority tied to the top-level dispatched tool across nested bodies", async () => {
    const execution = await runSupportedInvocation(
      async () =>
        await runSupportedToolBody(async () => {
          expect(isTurnYieldAvailable()).toBe(true);
          await runPluginToolBodyWithTurnYieldLease({
            run: async () => {
              expect(isTurnYieldAvailable()).toBe(true);
              requestTurnYield("nested");
            },
          });
          expect(isTurnYieldAvailable()).toBe(true);
        }),
    );

    expect(execution.requestedMessage).toBe("nested");
  });

  it("keeps the first request and treats repeats as idempotent", async () => {
    const execution = await runSupportedInvocation(
      async () =>
        await runSupportedToolBody(async () => {
          requestTurnYield("first");
          requestTurnYield("second");
        }),
    );

    expect(execution.requestedMessage).toBe("first");
  });

  it("bounds plugin-supplied handoff context", async () => {
    const execution = await runSupportedInvocation(
      async () =>
        await runSupportedToolBody(async () => {
          requestTurnYield("x".repeat(2_000));
        }),
    );

    expect(execution.requestedMessage).toHaveLength(1_000);
  });

  it("revokes detached work after synchronous and asynchronous settlement", async () => {
    let releaseDetached: (() => void) | undefined;
    const detachedGate = new Promise<void>((resolve) => {
      releaseDetached = resolve;
    });
    let detachedRequest: Promise<void> | undefined;
    await runSupportedInvocation(
      async () =>
        await runSupportedToolBody(async () => {
          detachedRequest = (async () => {
            await detachedGate;
            requestTurnYield("late");
          })();
        }),
    );

    releaseDetached?.();
    await expect(detachedRequest).rejects.toThrow("requires an active plugin tool execution");
  });

  it("isolates concurrent top-level invocations", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const run = (message: string) =>
      runSupportedInvocation(
        async () =>
          await runSupportedToolBody(async () => {
            requestTurnYield(message);
            await gate;
          }),
      );

    const first = run("first");
    const second = run("second");
    release?.();

    await expect(first).resolves.toMatchObject({ requestedMessage: "first" });
    await expect(second).resolves.toMatchObject({ requestedMessage: "second" });
  });
});
