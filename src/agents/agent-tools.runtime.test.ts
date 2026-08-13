// Coverage for agent tool runtime execution and scoped authority.
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import "./test-helpers/fast-coding-tools.js";
import "./test-helpers/fast-openclaw-tools.js";
import { wrapToolWithAbortSignal } from "./agent-tools.abort.js";
import { createOpenClawCodingTools } from "./agent-tools.js";
import {
  getActiveAgentRingZeroTools,
  runWithAgentRingZeroTools,
} from "./agent-tools.ring-zero-context.js";
import type { AnyAgentTool } from "./agent-tools.types.js";
import {
  attachInternalToolExecutionPreparer,
  getInternalToolExecutionPreparer,
} from "./runtime/internal-hooks.js";
import { stubTool } from "./test-helpers/fast-tool-stubs.js";
import {
  getToolTerminalPresentation,
  setToolTerminalPresentation,
} from "./tool-terminal-presentation.js";
import { createSessionsYieldTool } from "./tools/sessions-yield-tool.js";

type ExecuteMock = ReturnType<typeof vi.fn>;

function asAgentTool(tool: { execute: ExecuteMock; name: string }): AnyAgentTool {
  return { description: tool.name, parameters: {}, ...tool } as unknown as AnyAgentTool;
}

function textResult(text: string) {
  return { content: [{ type: "text", text }], details: {} };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("wrapToolWithAbortSignal", () => {
  it("rejects with AbortError when the run aborts while the tool promise never settles", async () => {
    // A wedged tool handler that never observes the signal and never settles.
    const runAbort = new AbortController();
    const execute = vi.fn(() => new Promise(() => {}));
    const wrapped = wrapToolWithAbortSignal(
      asAgentTool({ name: "wedged", execute }),
      runAbort.signal,
    );

    const executePromise = wrapped.execute("call-1", {});
    let outcome: { error?: unknown; status: "rejected" | "resolved" } | undefined;
    void executePromise.then(
      () => {
        outcome = { status: "resolved" };
      },
      (error: unknown) => {
        outcome = { status: "rejected", error };
      },
    );
    await flushMicrotasks();
    expect(outcome).toBeUndefined();

    runAbort.abort();
    const rejection = await executePromise.then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(outcome?.status).toBe("rejected");
    expect(rejection).toMatchObject({ name: "AbortError", message: "Aborted" });
  });

  it("handles a tool rejection when execute aborts the run synchronously", async () => {
    const runAbort = new AbortController();
    let rejectTool!: (error: unknown) => void;
    const execute = vi.fn(() => {
      runAbort.abort();
      return new Promise((_, reject) => {
        rejectTool = reject;
      });
    });
    const wrapped = wrapToolWithAbortSignal(
      asAgentTool({ name: "synchronous-abort", execute }),
      runAbort.signal,
    );

    await expect(wrapped.execute("call-1", {})).rejects.toMatchObject({
      name: "AbortError",
      message: "Aborted",
    });
    rejectTool(new Error("tool observed the abort"));
    await flushMicrotasks();
  });

  it("preserves the successful result when sessions_yield intentionally aborts its own run", async () => {
    const runAbort = new AbortController();
    const handoffReason = { code: "sessions_yield", turnHandoff: true } as const;
    const beforeYield = vi.fn();
    const wrapped = wrapToolWithAbortSignal(
      createSessionsYieldTool({
        sessionId: "requester",
        onBeforeYield: beforeYield,
        onYield: () => {
          runAbort.abort(handoffReason);
        },
      }),
      runAbort.signal,
    );

    await expect(wrapped.execute("call-yield", {})).resolves.toMatchObject({
      details: { status: "yielded", message: "Turn yielded." },
    });
    expect(beforeYield).toHaveBeenCalledOnce();
    expect(runAbort.signal.reason).toBe(handoffReason);
  });

  it("still aborts a concurrent sibling when sessions_yield hands off the run", async () => {
    const runAbort = new AbortController();
    const handoffReason = { code: "sessions_yield", turnHandoff: true } as const;
    const sibling = wrapToolWithAbortSignal(
      asAgentTool({ name: "wedged", execute: vi.fn(() => new Promise<never>(() => {})) }),
      runAbort.signal,
    );
    const siblingAborted = expect(sibling.execute("call-sibling", {})).rejects.toMatchObject({
      name: "AbortError",
      message: "Aborted",
    });
    const yieldTool = wrapToolWithAbortSignal(
      createSessionsYieldTool({
        sessionId: "requester",
        onYield: () => {
          runAbort.abort(handoffReason);
        },
      }),
      runAbort.signal,
    );

    await expect(yieldTool.execute("call-yield", {})).resolves.toMatchObject({
      details: { status: "yielded" },
    });
    await siblingAborted;
  });

  it("preserves the handoff when distinct run and per-call signals both yield", async () => {
    const runAbort = new AbortController();
    const callAbort = new AbortController();
    const handoffReason = { code: "sessions_yield", turnHandoff: true } as const;
    const wrapped = wrapToolWithAbortSignal(
      createSessionsYieldTool({
        sessionId: "requester",
        onYield: () => {
          runAbort.abort(handoffReason);
          callAbort.abort(handoffReason);
        },
      }),
      runAbort.signal,
    );

    await expect(wrapped.execute("call-yield", {}, callAbort.signal)).resolves.toMatchObject({
      details: { status: "yielded" },
    });
    expect(runAbort.signal.reason).toBe(handoffReason);
    expect(callAbort.signal.reason).toBe(handoffReason);
  });

  it.each([
    { name: "ordinary caller cancellation", reason: new Error("operator cancelled") },
    {
      name: "a caller-authored lookalike handoff",
      reason: { code: "sessions_yield", turnHandoff: true },
    },
  ])("rejects sessions_yield for $name without an owner-authored handoff", async ({ reason }) => {
    const runAbort = new AbortController();
    const callAbort = new AbortController();
    const execute = vi.fn(() => new Promise<never>(() => {}));
    const wrapped = wrapToolWithAbortSignal(
      asAgentTool({ name: "sessions_yield", execute }),
      runAbort.signal,
    );

    const executePromise = wrapped.execute("call-yield", {}, callAbort.signal);
    callAbort.abort(reason);

    await expect(executePromise).rejects.toMatchObject({
      name: "AbortError",
      message: "Aborted",
    });
    expect(runAbort.signal.aborted).toBe(false);
  });

  it.each([
    { name: "ordinary cancellation", reason: new Error("operator cancelled") },
    { name: "a missing handoff flag", reason: { code: "sessions_yield" } },
    { name: "a disabled handoff flag", reason: { code: "sessions_yield", turnHandoff: false } },
    { name: "a different handoff owner", reason: { code: "different", turnHandoff: true } },
  ])("rejects sessions_yield when its run owner aborts with $name", async ({ reason }) => {
    const runAbort = new AbortController();
    const execute = vi.fn(async () => {
      runAbort.abort(reason);
      return textResult("late");
    });
    const wrapped = wrapToolWithAbortSignal(
      asAgentTool({ name: "sessions_yield", execute }),
      runAbort.signal,
    );

    await expect(wrapped.execute("call-yield", {})).rejects.toMatchObject({
      name: "AbortError",
      message: "Aborted",
    });
  });

  it("does not start sessions_yield when the run was already handed off", async () => {
    const runAbort = new AbortController();
    runAbort.abort({ code: "sessions_yield", turnHandoff: true });
    const onYield = vi.fn();
    const wrapped = wrapToolWithAbortSignal(
      createSessionsYieldTool({ sessionId: "requester", onYield }),
      runAbort.signal,
    );

    await expect(wrapped.execute("call-yield", {})).rejects.toMatchObject({
      name: "AbortError",
      message: "Aborted",
    });
    expect(onYield).not.toHaveBeenCalled();
  });

  it("preserves an actual sessions_yield failure after its owner starts the handoff", async () => {
    const runAbort = new AbortController();
    const yieldError = new Error("yield bookkeeping failed");
    const wrapped = wrapToolWithAbortSignal(
      createSessionsYieldTool({
        sessionId: "requester",
        onYield: () => {
          runAbort.abort({ code: "sessions_yield", turnHandoff: true });
          throw yieldError;
        },
      }),
      runAbort.signal,
    );

    await expect(wrapped.execute("call-yield", {})).rejects.toBe(yieldError);
  });

  it("rejects with AbortError when the per-call signal aborts through the combined signal", async () => {
    const runAbort = new AbortController();
    const callAbort = new AbortController();
    const execute = vi.fn(
      (_toolCallId: string, _params: unknown, _signal?: AbortSignal) => new Promise(() => {}),
    );
    const wrapped = wrapToolWithAbortSignal(
      asAgentTool({ name: "wedged", execute }),
      runAbort.signal,
    );

    const executePromise = wrapped.execute("call-1", {}, callAbort.signal);
    const passedSignal = execute.mock.calls[0]?.[2];
    expect(passedSignal).toBeInstanceOf(AbortSignal);
    expect(passedSignal).not.toBe(runAbort.signal);
    expect(passedSignal).not.toBe(callAbort.signal);

    callAbort.abort();
    expect(passedSignal?.aborted).toBe(true);
    await expect(executePromise).rejects.toMatchObject({ name: "AbortError", message: "Aborted" });
  });

  it("detaches a tool result that completes after the abort", async () => {
    const runAbort = new AbortController();
    let resolveTool!: (value: unknown) => void;
    const execute = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveTool = resolve;
        }),
    );
    const wrapped = wrapToolWithAbortSignal(
      asAgentTool({ name: "late", execute }),
      runAbort.signal,
    );

    const executePromise = wrapped.execute("call-1", {});
    runAbort.abort();
    await expect(executePromise).rejects.toMatchObject({ name: "AbortError", message: "Aborted" });

    // The tool finishes successfully after the run died; its result must not surface.
    resolveTool(textResult("late"));
    await flushMicrotasks();
    let lateOutcome: string | undefined;
    void executePromise.then(
      () => {
        lateOutcome = "resolved";
      },
      () => {
        lateOutcome = "rejected";
      },
    );
    await flushMicrotasks();
    expect(lateOutcome).toBe("rejected");
  });

  it("detaches a late tool rejection after the abort without an unhandled rejection", async () => {
    // Vitest fails the run on unhandled rejections, so a passing test proves the
    // background tool rejection stays handled after the race is lost.
    const runAbort = new AbortController();
    let rejectTool!: (error: unknown) => void;
    const execute = vi.fn(
      () =>
        new Promise((_, reject) => {
          rejectTool = reject;
        }),
    );
    const wrapped = wrapToolWithAbortSignal(
      asAgentTool({ name: "late", execute }),
      runAbort.signal,
    );

    const executePromise = wrapped.execute("call-1", {});
    runAbort.abort();
    await expect(executePromise).rejects.toMatchObject({ name: "AbortError", message: "Aborted" });

    rejectTool(new Error("tool failed after the abort"));
    await flushMicrotasks();
  });

  it("resolves with the tool result unchanged when the run is not aborted", async () => {
    const runAbort = new AbortController();
    const result = textResult("ok");
    const execute = vi.fn(async () => result);
    const wrapped = wrapToolWithAbortSignal(asAgentTool({ name: "ok", execute }), runAbort.signal);

    await expect(wrapped.execute("call-1", {})).resolves.toBe(result);
    expect(execute).toHaveBeenCalledWith("call-1", {}, runAbort.signal, undefined);
  });

  it("rejects with the tool error unchanged when the run is not aborted", async () => {
    const runAbort = new AbortController();
    const toolError = new Error("tool exploded");
    const execute = vi.fn(async () => {
      throw toolError;
    });
    const wrapped = wrapToolWithAbortSignal(
      asAgentTool({ name: "fails", execute }),
      runAbort.signal,
    );

    await expect(wrapped.execute("call-1", {})).rejects.toBe(toolError);
  });

  it("preserves a non-Error tool rejection value unchanged when not aborted", async () => {
    const runAbort = new AbortController();
    const toolRejection = "tool rejected with a string";
    const execute = vi.fn(async () => {
      // Intentional non-Error rejection to prove pass-through semantics.
      // oxlint-disable-next-line typescript/only-throw-error
      throw toolRejection;
    });
    const wrapped = wrapToolWithAbortSignal(
      asAgentTool({ name: "fails", execute }),
      runAbort.signal,
    );

    await expect(wrapped.execute("call-1", {})).rejects.toBe(toolRejection);
  });

  it("throws AbortError before invoking execute when the signal is already aborted", async () => {
    const runAbort = new AbortController();
    runAbort.abort();
    const execute = vi.fn();
    const wrapped = wrapToolWithAbortSignal(
      asAgentTool({ name: "skipped", execute }),
      runAbort.signal,
    );

    await expect(wrapped.execute("call-1", {})).rejects.toMatchObject({
      name: "AbortError",
      message: "Aborted",
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("preserves terminal presentation metadata on abort-wrapped tools", () => {
    const formatter = () => ({ text: "done" });
    const tool = setToolTerminalPresentation(
      asAgentTool({ name: "presented", execute: vi.fn() }),
      formatter,
    );

    const wrapped = wrapToolWithAbortSignal(tool, new AbortController().signal);

    expect(getToolTerminalPresentation(wrapped)).toBe(formatter);
  });

  it("does not enter private preparation when the run is already aborted", async () => {
    const sourcePreparer = vi.fn(async () => ({
      kind: "ready" as const,
      args: {},
      execute: vi.fn(async () => ({ content: [], details: {} })),
      dispose: vi.fn(),
    }));
    const tool = attachInternalToolExecutionPreparer(
      asAgentTool({ name: "prepared", execute: vi.fn() }),
      sourcePreparer,
    );
    const runAbort = new AbortController();
    runAbort.abort();
    const wrapped = wrapToolWithAbortSignal(tool, runAbort.signal);
    const preparer = expectDefined(
      getInternalToolExecutionPreparer(wrapped),
      "abort-adapted preparer",
    );

    await expect(preparer({ toolCallId: "already-aborted", args: {} })).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(sourcePreparer).not.toHaveBeenCalled();
  });

  it("disposes cancellation-ignoring private preparation after a later abort", async () => {
    let release!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const dispose = vi.fn();
    const body = vi.fn(async () => ({ content: [], details: {} }));
    const sourcePreparer = vi.fn(async () => {
      markStarted();
      await blocked;
      return { kind: "ready" as const, args: {}, execute: body, dispose };
    });
    const tool = attachInternalToolExecutionPreparer(
      asAgentTool({ name: "prepared", execute: vi.fn() }),
      sourcePreparer,
    );
    const runAbort = new AbortController();
    const wrapped = wrapToolWithAbortSignal(tool, runAbort.signal);
    const preparer = expectDefined(
      getInternalToolExecutionPreparer(wrapped),
      "abort-adapted preparer",
    );

    const preparing = preparer({ toolCallId: "later-aborted", args: {} });
    await started;
    runAbort.abort();
    await expect(preparing).rejects.toMatchObject({ name: "AbortError" });
    release();
    await flushMicrotasks();

    expect(dispose).toHaveBeenCalledOnce();
    expect(body).not.toHaveBeenCalled();
  });
});

vi.mock("./channel-tools.js", () => {
  const passthrough = <T>(tool: T) => tool;
  const channelStubTool = (name: string) => ({
    name,
    description: `${name} stub`,
    parameters: { type: "object", properties: {} },
    execute: vi.fn(),
  });
  return {
    listChannelAgentTools: () => [channelStubTool("plugin_login")],
    copyChannelAgentToolMeta: passthrough,
    getChannelAgentToolMeta: () => undefined,
  };
});

describe("tool availability", () => {
  it("keeps control-plane tools available", () => {
    const tools = createOpenClawCodingTools();
    const toolNames = tools.map((tool) => tool.name);
    expect(toolNames).toContain("plugin_login");
    expect(toolNames).toContain("automations");
    expect(toolNames).toContain("gateway");
    expect(toolNames).toContain("nodes");
    expect(toolNames).toContain("openclaw");
  });

  it("keeps canvas available by current trust model", () => {
    const tools = createOpenClawCodingTools();
    const toolNames = tools.map((tool) => tool.name);
    expect(toolNames).toContain("canvas");
  });

  it("restricts node-originated runs to the node-safe tool subset", () => {
    const tools = createOpenClawCodingTools({ messageProvider: "node" });
    const toolNames = tools.map((tool) => tool.name);
    expect(toolNames).toContain("canvas");
    expect(toolNames).not.toContain("exec");
    expect(toolNames).not.toContain("read");
    expect(toolNames).not.toContain("write");
    expect(toolNames).not.toContain("edit");
    expect(toolNames).not.toContain("message");
    expect(toolNames).not.toContain("sessions_send");
    expect(toolNames).not.toContain("subagents");
  });
});

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
