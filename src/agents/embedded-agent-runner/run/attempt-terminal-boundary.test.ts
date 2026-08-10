import { describe, expect, it, vi } from "vitest";
import { createAgentTerminalBoundary } from "./attempt-terminal-boundary.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("createAgentTerminalBoundary", () => {
  it("contains observer failures without changing task settlement", async () => {
    const observerError = new Error("observer failed");
    const onObserverError = vi.fn();
    const boundary = createAgentTerminalBoundary(() => {
      throw observerError;
    }, onObserverError);

    await expect(boundary.settle(Promise.resolve("done"))).resolves.toBe("done");
    boundary.mark();

    expect(onObserverError).toHaveBeenCalledOnce();
    expect(onObserverError).toHaveBeenCalledWith(observerError);
  });

  it.each([
    { name: "ok", error: undefined },
    { name: "assistant error", error: new Error("assistant error") },
    { name: "timeout", error: new Error("timeout") },
    { name: "cancel", error: new Error("cancel") },
  ])("marks $name before delayed cleanup and never recomputes it", async ({ error }) => {
    const cleanupGate = deferred();
    const order: string[] = [];
    const markTerminal = vi.fn(() => order.push("terminal"));
    const boundary = createAgentTerminalBoundary(markTerminal);
    const cleanup = vi.fn(async () => {
      order.push("cleanup-start");
      await cleanupGate.promise;
      order.push("cleanup-end");
    });
    const pending = (async () => {
      try {
        return await boundary.settle(
          (async () => {
            if (error) {
              throw error;
            }
            return "done";
          })(),
        );
      } finally {
        await cleanup();
      }
    })();
    const observed = pending.then(
      (value) => ({ value }),
      (caught: unknown) => ({ error: caught }),
    );

    await vi.waitFor(() => expect(cleanup).toHaveBeenCalledTimes(1));
    expect(order).toEqual(["terminal", "cleanup-start"]);
    expect(markTerminal).toHaveBeenCalledTimes(1);

    cleanupGate.resolve();
    const outcome = await observed;
    boundary.mark();
    expect(markTerminal).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["terminal", "cleanup-start", "cleanup-end"]);
    if (error) {
      expect(outcome).toEqual({ error });
    } else {
      expect(outcome).toEqual({ value: "done" });
    }
  });
});
