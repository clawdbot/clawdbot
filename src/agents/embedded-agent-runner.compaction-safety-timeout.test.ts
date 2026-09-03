// Covers safety timeouts around embedded-agent compaction calls.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  bindContextEngineCompaction,
  inheritRuntimeCompactionDelegate,
  markRuntimeCompactionDelegate,
} from "../context-engine/compaction-watchdog.js";
import { isRuntimeCompactionDelegate } from "../context-engine/delegate.js";
import { LegacyContextEngine } from "../context-engine/legacy.js";
import type { CompactResult, ContextEngine } from "../context-engine/types.js";
import {
  compactContextEngineWithSafetyTimeout,
  compactWithSafetyTimeout,
  resolveCompactionTimeoutMs,
} from "./embedded-agent-runner/compaction-safety-timeout.js";

const EMBEDDED_COMPACTION_TIMEOUT_MS = 180_000;

describe("compactWithSafetyTimeout", () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("rejects with timeout when compaction never settles", async () => {
    // Hung compaction must not stall the agent turn indefinitely.
    vi.useFakeTimers();
    const compactPromise = compactWithSafetyTimeout(() => new Promise<never>(() => {}));
    const timeoutAssertion = expect(compactPromise).rejects.toThrow("Compaction timed out");

    await vi.advanceTimersByTimeAsync(EMBEDDED_COMPACTION_TIMEOUT_MS);
    await timeoutAssertion;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("returns result and clears timer when compaction settles first", async () => {
    vi.useFakeTimers();
    const compactPromise = compactWithSafetyTimeout(
      () =>
        new Promise<string>((resolve) => {
          setTimeout(() => resolve("ok"), 10);
        }),
      30,
    );

    await vi.advanceTimersByTimeAsync(10);
    await expect(compactPromise).resolves.toBe("ok");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("refreshes the safety window when serial compaction starts another model request", async () => {
    vi.useFakeTimers();
    const compactPromise = compactWithSafetyTimeout(async (_signal, resetTimeout) => {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 20);
      });
      resetTimeout();
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 20);
      });
      return "ok";
    }, 30);

    await vi.advanceTimersByTimeAsync(20);
    await vi.advanceTimersByTimeAsync(20);

    await expect(compactPromise).resolves.toBe("ok");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves compaction errors and clears timer", async () => {
    vi.useFakeTimers();
    const error = new Error("provider exploded");

    await expect(
      compactWithSafetyTimeout(async () => {
        throw error;
      }, 30),
    ).rejects.toBe(error);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("calls onCancel when compaction times out", async () => {
    vi.useFakeTimers();
    const onCancel = vi.fn();

    const compactPromise = compactWithSafetyTimeout(() => new Promise<never>(() => {}), 30, {
      onCancel,
    });
    const timeoutAssertion = expect(compactPromise).rejects.toThrow("Compaction timed out");

    await vi.advanceTimersByTimeAsync(30);
    await timeoutAssertion;
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts early on external abort signal and calls onCancel once", async () => {
    // Run-level aborts should win over the safety timer and still trigger one
    // cancellation path.
    vi.useFakeTimers();
    const controller = new AbortController();
    const onCancel = vi.fn();
    const reason = new Error("request timed out");

    const compactPromise = compactWithSafetyTimeout(() => new Promise<never>(() => {}), 100, {
      abortSignal: controller.signal,
      onCancel,
    });
    const abortAssertion = expect(compactPromise).rejects.toBe(reason);

    controller.abort(reason);
    await abortAssertion;
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ignores onCancel errors and still rejects with the timeout", async () => {
    vi.useFakeTimers();
    const compactPromise = compactWithSafetyTimeout(() => new Promise<never>(() => {}), 30, {
      onCancel: () => {
        throw new Error("abortCompaction failed");
      },
    });
    const timeoutAssertion = expect(compactPromise).rejects.toThrow("Compaction timed out");

    await vi.advanceTimersByTimeAsync(30);
    await timeoutAssertion;
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("resolveCompactionTimeoutMs", () => {
  it("returns default when config is undefined", () => {
    expect(resolveCompactionTimeoutMs(undefined)).toBe(EMBEDDED_COMPACTION_TIMEOUT_MS);
  });

  it("returns default when compaction config is missing", () => {
    expect(resolveCompactionTimeoutMs({ agents: { defaults: {} } })).toBe(
      EMBEDDED_COMPACTION_TIMEOUT_MS,
    );
  });

  it("returns default when timeoutSeconds is not set", () => {
    expect(
      resolveCompactionTimeoutMs({ agents: { defaults: { compaction: { mode: "safeguard" } } } }),
    ).toBe(EMBEDDED_COMPACTION_TIMEOUT_MS);
  });

  it("converts timeoutSeconds to milliseconds", () => {
    expect(
      resolveCompactionTimeoutMs({
        agents: { defaults: { compaction: { timeoutSeconds: 120 } } },
      }),
    ).toBe(120_000);
  });

  it("preserves explicit timeoutSeconds above 600", () => {
    expect(
      resolveCompactionTimeoutMs({
        agents: { defaults: { compaction: { timeoutSeconds: 1800 } } },
      }),
    ).toBe(1_800_000);
  });

  it("floors fractional seconds", () => {
    expect(
      resolveCompactionTimeoutMs({
        agents: { defaults: { compaction: { timeoutSeconds: 120.7 } } },
      }),
    ).toBe(120_000);
  });

  it("returns default for zero", () => {
    expect(
      resolveCompactionTimeoutMs({ agents: { defaults: { compaction: { timeoutSeconds: 0 } } } }),
    ).toBe(EMBEDDED_COMPACTION_TIMEOUT_MS);
  });

  it("returns default for negative values", () => {
    expect(
      resolveCompactionTimeoutMs({ agents: { defaults: { compaction: { timeoutSeconds: -5 } } } }),
    ).toBe(EMBEDDED_COMPACTION_TIMEOUT_MS);
  });

  it("returns default for NaN", () => {
    expect(
      resolveCompactionTimeoutMs({
        agents: { defaults: { compaction: { timeoutSeconds: Number.NaN } } },
      }),
    ).toBe(EMBEDDED_COMPACTION_TIMEOUT_MS);
  });

  it("returns default for Infinity", () => {
    expect(
      resolveCompactionTimeoutMs({
        agents: { defaults: { compaction: { timeoutSeconds: Infinity } } },
      }),
    ).toBe(EMBEDDED_COMPACTION_TIMEOUT_MS);
  });
});

describe("compactContextEngineWithSafetyTimeout", () => {
  type CompactFn = ContextEngine["compact"];
  const baseParams: Parameters<CompactFn>[0] = {
    sessionId: "session-1",
    sessionKey: "agent:main:session-1",
    tokenBudget: 100_000,
    force: true,
  };
  const makeEngine = (
    compact: CompactFn,
    ownsCompaction = true,
  ): Pick<ContextEngine, "compact" | "info"> => ({
    compact,
    info: { id: "test", name: "Test", ownsCompaction },
  });

  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("bounds a hung plugin compact() and rejects with a timeout error", async () => {
    vi.useFakeTimers();
    const compact = vi.fn<CompactFn>(() => new Promise<CompactResult>(() => {}));

    const pending = compactContextEngineWithSafetyTimeout(makeEngine(compact), baseParams, 30);
    const assertion = expect(pending).rejects.toThrow("Compaction timed out");

    await vi.advanceTimersByTimeAsync(30);
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    { marked: false, outcome: "result" },
    { marked: true, outcome: "result" },
    { marked: false, outcome: "error" },
    { marked: true, outcome: "error" },
  ] as const)(
    "binds one captured compactor to its receiver and preserves child params ($marked, $outcome)",
    async ({ marked, outcome }) => {
      vi.useFakeTimers();
      const result: CompactResult = {
        ok: true,
        compacted: true,
        result: { tokensBefore: 1000, tokensAfter: 200 },
      };
      const error = new Error("engine compaction failed");
      const compact = vi.fn(function (
        this: { result: CompactResult; error: Error },
        _params: Parameters<CompactFn>[0],
      ) {
        return outcome === "error" ? Promise.reject(this.error) : Promise.resolve(this.result);
      });
      const replacement = vi.fn<CompactFn>(async () => {
        throw new Error("replacement compactor must not be invoked");
      });
      const captured = marked ? markRuntimeCompactionDelegate(compact) : compact;
      const later = marked ? replacement : markRuntimeCompactionDelegate(replacement);
      let reads = 0;
      const engine = {
        result,
        error,
        get compact() {
          reads += 1;
          return reads === 1 ? captured : later;
        },
      };
      const bound = bindContextEngineCompaction(engine);
      const forward = vi.fn<CompactFn>((params) => bound(params));
      const ownedCompact = inheritRuntimeCompactionDelegate(bound, forward);
      const controller = new AbortController();
      const runtimeContext = { tokenBudget: 100_000 };
      const request = { ...baseParams, runtimeContext };
      const pending = compactContextEngineWithSafetyTimeout(
        makeEngine(ownedCompact),
        request,
        30,
        controller.signal,
      );

      if (outcome === "error") {
        await expect(pending).rejects.toBe(error);
      } else {
        await expect(pending).resolves.toBe(result);
      }
      expect(reads).toBe(1);
      expect(compact).toHaveBeenCalledOnce();
      expect(compact.mock.contexts[0]).toBe(engine);
      expect(replacement).not.toHaveBeenCalled();
      expect(forward).toHaveBeenCalledOnce();
      const backendParams = forward.mock.calls[0]?.[0];
      expect(compact.mock.calls[0]?.[0]).toBe(backendParams);
      expect(backendParams).toMatchObject(request);
      expect(backendParams).not.toBe(request);
      expect(backendParams?.abortSignal).toBeInstanceOf(AbortSignal);
      expect(backendParams?.abortSignal).not.toBe(controller.signal);
      expect(backendParams?.abortSignal?.aborted).toBe(false);
      expect(isRuntimeCompactionDelegate(bound)).toBe(marked);
      expect(isRuntimeCompactionDelegate(ownedCompact)).toBe(marked);
      expect(typeof backendParams?.runtimeContext?.compactionTimeoutReset).toBe(
        marked ? "function" : "undefined",
      );
      if (marked) {
        expect(backendParams?.runtimeContext).not.toBe(runtimeContext);
      } else {
        expect(backendParams?.runtimeContext).toBe(runtimeContext);
      }
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("keeps a non-owning custom engine bounded", async () => {
    vi.useFakeTimers();
    const compact = vi.fn<CompactFn>(() => new Promise<CompactResult>(() => {}));

    const pending = compactContextEngineWithSafetyTimeout(
      makeEngine(compact, false),
      baseParams,
      30,
    );
    const assertion = expect(pending).rejects.toThrow("Compaction timed out");

    await vi.advanceTimersByTimeAsync(30);
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("recognizes only the canonical built-in runtime delegate", () => {
    const engine = new LegacyContextEngine();
    const wrapped = async (params: Parameters<ContextEngine["compact"]>[0]) =>
      engine.compact(params);

    expect(isRuntimeCompactionDelegate(engine.compact)).toBe(true);
    expect(isRuntimeCompactionDelegate(wrapped)).toBe(false);
  });

  it("does not start the built-in delegate after caller cancellation", async () => {
    const controller = new AbortController();
    const reason = new Error("run aborted before compaction");
    const compact = markRuntimeCompactionDelegate(
      vi.fn<CompactFn>(async () => ({ ok: true, compacted: false })),
    );
    controller.abort(reason);

    await expect(
      compactContextEngineWithSafetyTimeout(
        makeEngine(compact),
        baseParams,
        EMBEDDED_COMPACTION_TIMEOUT_MS,
        controller.signal,
      ),
    ).rejects.toBe(reason);
    expect(compact).not.toHaveBeenCalled();
  });

  it("rejects promptly when caller cancellation interrupts built-in preparation", async () => {
    const controller = new AbortController();
    const reason = new Error("run aborted during compaction preparation");
    const compact = markRuntimeCompactionDelegate(
      vi.fn<CompactFn>(() => new Promise<CompactResult>(() => {})),
    );
    const pending = compactContextEngineWithSafetyTimeout(
      makeEngine(compact),
      baseParams,
      EMBEDDED_COMPACTION_TIMEOUT_MS,
      controller.signal,
    );

    controller.abort(reason);
    const settled = Promise.race([
      pending,
      new Promise<"still pending">((resolve) => {
        setImmediate(() => resolve("still pending"));
      }),
    ]);

    await expect(settled).rejects.toBe(reason);
  });

  it("bounds built-in preparation before the native watchdog starts", async () => {
    vi.useFakeTimers();
    const compact = markRuntimeCompactionDelegate(
      vi.fn<CompactFn>(() => new Promise<CompactResult>(() => {})),
    );
    const pending = compactContextEngineWithSafetyTimeout(makeEngine(compact), baseParams, 30);
    const assertion = expect(pending).rejects.toThrow("Compaction timed out");

    await vi.advanceTimersByTimeAsync(30);
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([false, true])(
    "honors progress resets only for marked bound compactors (marked=%s)",
    async (marked) => {
      vi.useFakeTimers();
      let resolveCompact!: (result: CompactResult) => void;
      let resetTimeout: unknown;
      const result: CompactResult = { ok: true, compacted: false };
      const compact = vi.fn<CompactFn>((params) => {
        resetTimeout = params.runtimeContext?.compactionTimeoutReset;
        return new Promise<CompactResult>((resolve) => {
          resolveCompact = resolve;
        });
      });
      const engine = makeEngine(marked ? markRuntimeCompactionDelegate(compact) : compact);
      const bound = bindContextEngineCompaction(engine);
      const ownedCompact = inheritRuntimeCompactionDelegate(bound, (params) => bound(params));
      const pending = compactContextEngineWithSafetyTimeout(
        makeEngine(ownedCompact),
        baseParams,
        30,
      );
      const assertion = marked
        ? expect(pending).resolves.toBe(result)
        : expect(pending).rejects.toThrow("Compaction timed out");

      await vi.advanceTimersByTimeAsync(20);
      expect(typeof resetTimeout).toBe(marked ? "function" : "undefined");
      if (typeof resetTimeout === "function") {
        resetTimeout();
      }
      await vi.advanceTimersByTimeAsync(20);
      resolveCompact(result);

      await assertion;
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("threads a signal that follows the run abort signal into the plugin compact() params", async () => {
    // Plugin context engines receive an abort signal derived from the run signal
    // so they can stop work promptly.
    vi.useFakeTimers();
    const controller = new AbortController();
    const reason = new Error("run aborted");
    let compactAbortSignal: AbortSignal | undefined;
    const compact = vi.fn<CompactFn>((params) => {
      compactAbortSignal = params.abortSignal;
      return new Promise<CompactResult>(() => {});
    });

    const pending = compactContextEngineWithSafetyTimeout(
      makeEngine(compact),
      baseParams,
      30,
      controller.signal,
    );
    const assertion = expect(pending).rejects.toBe(reason);

    expect(compact).toHaveBeenCalledTimes(1);
    expect(compactAbortSignal).toBeInstanceOf(AbortSignal);
    expect(compactAbortSignal?.aborted).toBe(false);

    controller.abort(reason);
    await assertion;
    expect(compactAbortSignal?.aborted).toBe(true);
    expect(compactAbortSignal?.reason).toBe(reason);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("threads the host timeout abort signal into the plugin compact() params", async () => {
    // Timeout cancellation is delivered through the same plugin abort signal as
    // external run cancellation.
    vi.useFakeTimers();
    let compactAbortSignal: AbortSignal | undefined;
    const compact = vi.fn<CompactFn>((params) => {
      compactAbortSignal = params.abortSignal;
      return new Promise<CompactResult>(() => {});
    });

    const pending = compactContextEngineWithSafetyTimeout(makeEngine(compact), baseParams, 30);
    const assertion = expect(pending).rejects.toThrow("Compaction timed out");

    expect(compactAbortSignal).toBeInstanceOf(AbortSignal);
    expect(compactAbortSignal?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(30);
    await assertion;
    expect(compactAbortSignal?.aborted).toBe(true);
    expect(compactAbortSignal?.reason).toBeInstanceOf(Error);
    expect((compactAbortSignal?.reason as Error | undefined)?.message).toBe("Compaction timed out");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects promptly when the run abort signal fires before the timeout", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const abortError = new Error("run aborted");
    const compact = vi.fn<CompactFn>(() => new Promise<CompactResult>(() => {}));

    const pending = compactContextEngineWithSafetyTimeout(
      makeEngine(compact),
      baseParams,
      EMBEDDED_COMPACTION_TIMEOUT_MS,
      controller.signal,
    );
    const assertion = expect(pending).rejects.toBe(abortError);

    controller.abort(abortError);
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });
});
