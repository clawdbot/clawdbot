import { beforeEach, describe, expect, it, vi } from "vitest";
import { emitAgentEvent, resetAgentEventsForTest } from "../infra/agent-events.js";
import { AgentTurnRegistry } from "./agent-turn-registry.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

describe("AgentTurnRegistry", () => {
  beforeEach(() => {
    resetAgentEventsForTest();
  });

  it("registers the handle before execution and removes it after settlement", async () => {
    const registry = new AgentTurnRegistry<{ phase: string }, string>();
    const gate = deferred<string>();
    let registeredDuringExecution = false;
    const execute = vi.fn(async () => {
      registeredDuringExecution = registry.get("run-1") !== undefined;
      return await gate.promise;
    });

    const handle = registry.submit({
      runId: "run-1",
      sessionKey: "agent:main:main",
      state: { phase: "queued" },
      execute,
    });

    expect(registry.get("run-1")).toBe(handle);
    expect(execute).toHaveBeenCalledOnce();
    expect(registeredDuringExecution).toBe(true);

    gate.resolve("done");
    await expect(handle.result).resolves.toBe("done");
    expect(registry.get("run-1")).toBeUndefined();
  });

  it("routes only turn-owned events to the adapter", async () => {
    const registry = new AgentTurnRegistry<Record<string, never>, void>();
    const events: string[] = [];
    const handle = registry.submit({
      runId: "owned-run",
      sessionKey: "agent:main:main",
      state: {},
      onEvent: (event) => events.push(`${event.runId}:${String(event.data.delta)}`),
      execute: async () => {
        emitAgentEvent({
          runId: "owned-run",
          stream: "assistant",
          data: { delta: "owned" },
        });
        emitAgentEvent({
          runId: "other-run",
          stream: "assistant",
          data: { delta: "ignored" },
        });
      },
    });

    await handle.result;
    expect(events).toEqual(["owned-run:owned"]);
  });

  it("keeps the handle active after lifecycle end until execution settles", async () => {
    const registry = new AgentTurnRegistry<Record<string, never>, void>();
    const gate = deferred<void>();
    const handle = registry.submit({
      runId: "maintenance-run",
      sessionKey: "agent:main:main",
      state: {},
      execute: async () => {
        emitAgentEvent({
          runId: "maintenance-run",
          stream: "lifecycle",
          data: { phase: "end" },
        });
        await gate.promise;
      },
    });

    await vi.waitFor(() => expect(registry.get("maintenance-run")).toBe(handle));
    expect(handle.cancel("stop maintenance")).toBe(true);
    expect(handle.signal.aborted).toBe(true);
    gate.resolve();
    await handle.result;
  });

  it("cancels each handle at most once", async () => {
    const registry = new AgentTurnRegistry<Record<string, never>, void>();
    const gate = deferred<void>();
    const handle = registry.submit({
      runId: "cancel-run",
      sessionKey: "agent:main:main",
      state: {},
      execute: async (signal) => {
        signal.addEventListener("abort", () => gate.resolve(), { once: true });
        await gate.promise;
      },
    });
    await vi.waitFor(() => expect(registry.get("cancel-run")).toBe(handle));

    expect(handle.cancel("first")).toBe(true);
    expect(handle.cancel("second")).toBe(false);
    await handle.result;
  });

  it("isolates registries even when adapters reuse a run id", async () => {
    const first = new AgentTurnRegistry<Record<string, never>, void>();
    const second = new AgentTurnRegistry<Record<string, never>, void>();
    const firstGate = deferred<void>();
    const secondGate = deferred<void>();
    const firstEvents: string[] = [];
    const secondEvents: string[] = [];

    const firstHandle = first.submit({
      runId: "shared-run",
      sessionKey: "agent:main:first",
      state: {},
      onEvent: (event) => firstEvents.push(String(event.data.owner)),
      execute: async () => {
        await Promise.resolve();
        emitAgentEvent({
          runId: "shared-run",
          stream: "assistant",
          data: { owner: "first" },
        });
        await firstGate.promise;
      },
    });
    const secondHandle = second.submit({
      runId: "shared-run",
      sessionKey: "agent:main:second",
      state: {},
      onEvent: (event) => secondEvents.push(String(event.data.owner)),
      execute: async () => {
        await Promise.resolve();
        emitAgentEvent({
          runId: "shared-run",
          stream: "assistant",
          data: { owner: "second" },
        });
        await secondGate.promise;
      },
    });

    await vi.waitFor(() => {
      expect(firstEvents).toEqual(["first"]);
      expect(secondEvents).toEqual(["second"]);
    });
    firstGate.resolve();
    secondGate.resolve();
    await Promise.all([firstHandle.result, secondHandle.result]);
  });

  it("isolates adapter event failures from execution", async () => {
    const registry = new AgentTurnRegistry<Record<string, never>, string>();
    const handle = registry.submit({
      runId: "listener-error",
      sessionKey: "agent:main:main",
      state: {},
      onEvent: () => {
        throw new Error("render failed");
      },
      execute: async () => {
        emitAgentEvent({
          runId: "listener-error",
          stream: "assistant",
          data: { delta: "hello" },
        });
        return "done";
      },
    });

    await expect(handle.result).resolves.toBe("done");
  });

  it("detaches unsettled turns and ignores their late events", async () => {
    const registry = new AgentTurnRegistry<Record<string, never>, void>();
    const gate = deferred<void>();
    const events: string[] = [];
    const handle = registry.submit({
      runId: "detached-run",
      sessionKey: "agent:main:main",
      state: {},
      onEvent: (event) => events.push(String(event.data.delta)),
      execute: async () => {
        await gate.promise;
        emitAgentEvent({
          runId: "detached-run",
          stream: "assistant",
          data: { delta: "late" },
        });
      },
    });

    expect(registry.detachAll("shutdown")).toEqual([handle]);
    expect(handle.signal.aborted).toBe(true);
    expect(registry.list()).toEqual([]);

    gate.resolve();
    await handle.result;
    expect(events).toEqual([]);
  });

  it("does not route stale async events to a replacement handle with the same run id", async () => {
    const registry = new AgentTurnRegistry<Record<string, never>, void>();
    const staleEventGate = deferred<void>();
    const replacementGate = deferred<void>();
    const events: string[] = [];
    const first = registry.submit({
      runId: "reused-run",
      sessionKey: "agent:main:first",
      state: {},
      onEvent: (event) => events.push(String(event.data.delta)),
      execute: async () => {
        void staleEventGate.promise.then(() => {
          emitAgentEvent({
            runId: "reused-run",
            stream: "assistant",
            data: { delta: "stale" },
          });
        });
      },
    });
    await first.result;

    const replacement = registry.submit({
      runId: "reused-run",
      sessionKey: "agent:main:replacement",
      state: {},
      onEvent: (event) => events.push(String(event.data.delta)),
      execute: async () => {
        emitAgentEvent({
          runId: "reused-run",
          stream: "assistant",
          data: { delta: "fresh" },
        });
        await replacementGate.promise;
      },
    });

    staleEventGate.resolve();
    await Promise.resolve();
    expect(events).toEqual(["fresh"]);

    replacementGate.resolve();
    await replacement.result;
  });

  it("rejects duplicate active ids and submissions after sealing", async () => {
    const registry = new AgentTurnRegistry<Record<string, never>, void>();
    const gate = deferred<void>();
    registry.submit({
      runId: "duplicate-run",
      sessionKey: "agent:main:main",
      state: {},
      execute: async (signal) => {
        if (signal.aborted) {
          return;
        }
        signal.addEventListener("abort", () => gate.resolve(), { once: true });
        await gate.promise;
      },
    });

    expect(() =>
      registry.submit({
        runId: "duplicate-run",
        sessionKey: "agent:main:main",
        state: {},
        execute: async () => undefined,
      }),
    ).toThrow('Agent turn "duplicate-run" is already active');

    const sealed = registry.seal();
    expect(sealed.map((handle) => handle.runId)).toEqual(["duplicate-run"]);
    expect(() =>
      registry.submit({
        runId: "late-run",
        sessionKey: "agent:main:main",
        state: {},
        execute: async () => undefined,
      }),
    ).toThrow("Agent turn registry is sealed");

    expect(registry.cancelAll("shutdown")).toEqual(["duplicate-run"]);
    await Promise.all(sealed.map((handle) => handle.result));
    expect(registry.list()).toEqual([]);
  });
});
