import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import {
  clearToolSearchCatalog,
  createToolSearchCatalogRef,
  registerHeadlessToolSearchCatalog,
  restrictToolSearchCatalog,
} from "./tool-search-catalog.js";
import { ToolSearchRuntime } from "./tool-search-runtime.js";
import type { ToolSearchConfig, ToolSearchToolContext } from "./tool-search-types.js";
import { jsonResult, type AnyAgentTool } from "./tools/common.js";

const config: ToolSearchConfig = {
  enabled: true,
  mode: "tools",
  codeTimeoutMs: 10000,
  searchDefaultLimit: 8,
  maxSearchLimit: 50,
};

function fixture(tools: AnyAgentTool[], extra: Partial<ToolSearchToolContext> = {}) {
  const catalogRef = createToolSearchCatalogRef();
  registerHeadlessToolSearchCatalog({ catalogRef, tools });
  const ctx: ToolSearchToolContext = { catalogRef, ...extra };
  return { ctx, catalogRef, runtime: new ToolSearchRuntime(ctx, config) };
}

function gated(name: string, executionMode: AnyAgentTool["executionMode"], events: string[]) {
  const started = createDeferredCore();
  const release = createDeferredCore();
  const tool: AnyAgentTool = {
    name,
    label: name,
    description: name,
    parameters: Type.Object({}),
    executionMode,
    execute: vi.fn(async () => {
      events.push(`${name}:start`);
      started.resolve();
      await release.promise;
      events.push(`${name}:done`);
      return jsonResult({ name });
    }),
  };
  return { tool, started: started.promise, release: () => release.resolve() };
}

async function hostTurn() {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

describe("Tool Search execution scheduling", () => {
  it("shares FIFO exclusion across runtimes while allowing the parallel prefix", async () => {
    const events: string[] = [];
    const a = gated("a", undefined, events);
    const b = gated("b", "parallel", events);
    const c = gated("c", "sequential", events);
    const d = gated("d", "parallel", events);
    const e = gated("e", "sequential", events);
    const gates = [a, b, c, d, e];
    const { ctx, runtime, catalogRef } = fixture(gates.map((g) => g.tool));
    const sibling = new ToolSearchRuntime(ctx, config);
    const calls = [
      runtime.call("a"),
      sibling.call("b"),
      runtime.call("c"),
      sibling.call("d"),
      runtime.call("e"),
    ];
    try {
      await Promise.all([a.started, b.started]);
      expect(events).toEqual(["a:start", "b:start"]);
      a.release();
      await calls[0];
      expect(events).not.toContain("c:start");
      b.release();
      await c.started;
      expect(events).toEqual(["a:start", "b:start", "a:done", "b:done", "c:start"]);
      c.release();
      await d.started;
      expect(events).not.toContain("e:start");
      d.release();
      await e.started;
      e.release();
      await Promise.all(calls);
      expect(catalogRef.onDispose?.size ?? 0).toBe(0);
    } finally {
      gates.forEach((g) => g.release());
      await Promise.allSettled(calls);
      clearToolSearchCatalog(ctx);
    }
  });

  it.each(["call", "context"] as const)(
    "cancels queued work from the %s signal without releasing an active exclusive call",
    async (source) => {
      const events: string[] = [];
      const a = gated("a", "sequential", events);
      const b = gated("b", "sequential", events);
      const c = gated("c", "parallel", events);
      const { ctx, runtime } = fixture([a.tool, b.tool, c.tool]);
      const controller = new AbortController();
      const queuedRuntime =
        source === "context"
          ? new ToolSearchRuntime({ ...ctx, abortSignal: controller.signal }, config)
          : runtime;
      const first = runtime.call("a");
      await a.started;
      const queued = queuedRuntime.call(
        "b",
        {},
        { signal: source === "call" ? controller.signal : new AbortController().signal },
      );
      const rejected = expect(queued).rejects.toThrow(/aborted/i);
      const tail = runtime.call("c");
      try {
        controller.abort();
        await rejected;
        await hostTurn();
        expect(events).toEqual(["a:start"]);
        a.release();
        await c.started;
        c.release();
        await Promise.all([first, tail]);
        expect(b.tool.execute).not.toHaveBeenCalled();
      } finally {
        a.release();
        b.release();
        c.release();
        await Promise.allSettled([first, queued, tail]);
        clearToolSearchCatalog(ctx);
      }
    },
  );

  it("cancels a disposed generation without blocking a reopened catalog", async () => {
    const events: string[] = [];
    const old = gated("old", "sequential", events);
    const queued = gated("queued", "sequential", events);
    const fresh = gated("fresh", "sequential", events);
    const { ctx, catalogRef, runtime } = fixture([old.tool, queued.tool]);
    const active = runtime.call("old");
    await old.started;
    const waiting = runtime.call("queued");
    const rejected = expect(waiting).rejects.toThrow(/aborted/i);
    clearToolSearchCatalog(ctx);
    await rejected;
    registerHeadlessToolSearchCatalog({ catalogRef, tools: [fresh.tool] });
    const replacement = runtime.call("fresh");
    try {
      await fresh.started;
      old.release();
      await active;
      fresh.release();
      await replacement;
      expect(queued.tool.execute).not.toHaveBeenCalled();
      expect(catalogRef.onDispose?.size ?? 0).toBe(0);
    } finally {
      old.release();
      queued.release();
      fresh.release();
      await Promise.allSettled([active, waiting, replacement]);
      clearToolSearchCatalog(ctx);
    }
  });

  it.each(["remove", "replace", "append"] as const)(
    "revalidates queued targets after catalog %s",
    async (change) => {
      const events: string[] = [];
      const a = gated("a", "sequential", events);
      const b = gated("b", "sequential", events);
      const other = gated("other", "parallel", events);
      const { ctx, runtime, catalogRef } = fixture([a.tool, b.tool]);
      const active = runtime.call("a");
      await a.started;
      const queued = runtime.call("b");
      const result =
        change === "append" ? queued : expect(queued).rejects.toThrow(/changed|available/);
      if (change === "remove") {
        restrictToolSearchCatalog({ catalogRef, allowedToolNames: new Set(["a"]) });
      } else {
        registerHeadlessToolSearchCatalog({
          catalogRef,
          tools: change === "append" ? [a.tool, b.tool, other.tool] : [a.tool, { ...b.tool }],
        });
      }
      try {
        a.release();
        if (change === "append") {
          await b.started;
          b.release();
        }
        await Promise.all([active, result]);
        expect(b.tool.execute).toHaveBeenCalledTimes(change === "append" ? 1 : 0);
      } finally {
        a.release();
        b.release();
        other.release();
        await Promise.allSettled([active, queued]);
        clearToolSearchCatalog(ctx);
      }
    },
  );

  it("keeps exclusion until executor acceptance settles", async () => {
    const events: string[] = [];
    const a = gated("a", "sequential", events);
    const b = gated("b", "parallel", events);
    const accepting = createDeferredCore();
    const releaseAcceptance = createDeferredCore();
    const { ctx, runtime } = fixture([a.tool, b.tool], {
      executeTool: async (params) => {
        const result = await params.tool.execute(
          params.toolCallId,
          params.input,
          params.signal,
          params.onUpdate,
          undefined as never,
        );
        if (params.toolName === "a") {
          accepting.resolve();
          await releaseAcceptance.promise;
        }
        return await params.acceptResultBeforeProjection(result);
      },
    });
    const first = runtime.call("a");
    const second = runtime.call("b");
    try {
      await a.started;
      a.release();
      await accepting.promise;
      await hostTurn();
      expect(events).toEqual(["a:start", "a:done"]);
      releaseAcceptance.resolve();
      await b.started;
      b.release();
      await Promise.all([first, second]);
    } finally {
      a.release();
      b.release();
      releaseAcceptance.resolve();
      await Promise.allSettled([first, second]);
      clearToolSearchCatalog(ctx);
    }
  });

  it.each(["sequential", "parallel"] as const)(
    "rejects incompatible reentrancy from a %s caller rather than deadlocking",
    async (executionMode) => {
      const child: AnyAgentTool = {
        name: "child",
        label: "child",
        description: "child",
        parameters: Type.Object({}),
        executionMode: "sequential",
        execute: vi.fn(async () => jsonResult({ ok: true })),
      };
      const parent: AnyAgentTool = {
        ...child,
        name: "parent",
        executionMode,
        execute: async () => {
          await runtime.call("child");
          return jsonResult({ ok: true });
        },
      };
      const harness = fixture([parent, child]);
      const { runtime } = harness;
      try {
        await expect(runtime.call("parent")).rejects.toThrow("Reentrant tool call");
        expect(child.execute).not.toHaveBeenCalled();
        await expect(runtime.call("child")).resolves.toBeDefined();
      } finally {
        clearToolSearchCatalog(harness.ctx);
      }
    },
  );
});
