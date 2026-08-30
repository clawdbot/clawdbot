import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { applyCodeModeCatalog, runCodeModeScriptHeadless } from "./code-mode.js";
import {
  createCodeModeHarness,
  createHeadlessCodeModeHarness,
  pluginToolWithExecute,
  resetCodeModeTestState,
  resultDetails,
  testing,
} from "./code-mode.test-support.js";
import { clearToolSearchCatalog } from "./tool-search.js";
import { jsonResult } from "./tools/common.js";

afterEach(() => {
  resetCodeModeTestState();
  vi.useRealTimers();
});

it.each(
  (["exec", "wait", "headless"] as const).flatMap((phase) =>
    [
      { close: "catalog", honorsAbort: false },
      { close: "catalog", honorsAbort: true },
      { close: "context", honorsAbort: false },
      { close: "call", honorsAbort: false },
    ].map((params) => Object.assign({ phase }, params)),
  ),
)(
  "closes $phase bridge work via $close with honorsAbort=$honorsAbort without reviving a guest",
  async ({ phase, close, honorsAbort }) => {
    const entered = createDeferred();
    const release = createDeferred();
    const finished = createDeferred();
    const callController = new AbortController();
    const contextController = new AbortController();
    let aborts = 0;
    const gate = pluginToolWithExecute(
      "lifetime_gate",
      "Controlled bridge work",
      async (_id, _args, signal) => {
        const onAbort = () => {
          aborts += 1;
          if (honorsAbort) {
            release.reject(new Error("fixture observed cancellation"));
          }
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        entered.resolve();
        try {
          await release.promise;
          return jsonResult("late external completion");
        } finally {
          signal?.removeEventListener("abort", onAbort);
          finished.resolve();
        }
      },
    );
    const after = pluginToolWithExecute("lifetime_after", "Must not execute", async () =>
      jsonResult(true),
    );
    const h = createCodeModeHarness();
    applyCodeModeCatalog({ ...h.ctx, tools: [...h.tools, gate, after] });
    const headless =
      phase === "headless" ? createHeadlessCodeModeHarness([gate, after]) : undefined;
    const ctx = Object.assign(headless ?? h.ctx, { abortSignal: contextController.signal });
    const code =
      'try { await lifetime_gate({}); } catch {} text("STALE AFTER CLOSE"); await lifetime_after({}); await yield_control(); return "stale";';
    let execution: Promise<unknown>;
    let runId: unknown;
    if (phase === "wait") {
      const parked = resultDetails(
        await h.tools[0]!.execute("park", { code: `await yield_control(); ${code}` }),
      );
      expect(parked.status).toBe("waiting");
      runId = parked.runId;
      execution = h.tools[1]!.execute("resume", { runId }, callController.signal).then(
        resultDetails,
      );
    } else if (headless) {
      execution = runCodeModeScriptHeadless({ ctx: headless, code, signal: callController.signal });
    } else {
      execution = h.tools[0]!.execute("initial", { code }, callController.signal).then(
        resultDetails,
      );
    }
    try {
      await entered.promise;
      if (close === "catalog") {
        clearToolSearchCatalog(ctx);
        clearToolSearchCatalog(ctx);
      } else {
        (close === "context" ? contextController : callController).abort();
      }
      expect(aborts).toBe(1);
      // Cancellation must settle the cell before an uncooperative external operation finishes.
      const result = await execution;
      expect(result).toMatchObject({ status: "failed", code: "aborted", output: [] });
      expect(after.execute).not.toHaveBeenCalled();
      expect(testing.activeRuns.size).toBe(0);
      expect(testing.resumingRunIds.size).toBe(0);
      expect(ctx.catalogRef?.onDispose?.size ?? 0).toBe(0);
      release.resolve();
      await finished.promise;
      expect(after.execute).not.toHaveBeenCalled();
      if (runId) {
        await expect(h.tools[1]!.execute("closed", { runId })).rejects.toThrow(
          /unavailable|expired/,
        );
      }
      const healthy = createCodeModeHarness();
      applyCodeModeCatalog({ ...healthy.ctx, tools: healthy.tools });
      expect(
        resultDetails(await healthy.tools[0]!.execute("healthy", { code: "return 7;" })),
      ).toMatchObject({ status: "completed", value: 7 });
      expect(healthy.catalogRef.onDispose?.size ?? 0).toBe(0);
      clearToolSearchCatalog(healthy.ctx);
    } finally {
      release.resolve();
      clearToolSearchCatalog(ctx);
      clearToolSearchCatalog(h.ctx);
      await execution;
    }
  },
);

it("keeps pending work bound to the cell after a newer wait replaces its call observer", async () => {
  const prior = new AbortController();
  const current = new AbortController();
  const entered = createDeferred();
  const release = createDeferred();
  let aborts = 0;
  const gate = pluginToolWithExecute("gate", "Pending work", async (_id, _args, signal) => {
    signal?.addEventListener(
      "abort",
      () => {
        aborts += 1;
      },
      { once: true },
    );
    entered.resolve();
    await release.promise;
    return jsonResult("healthy");
  });
  const h = createCodeModeHarness();
  applyCodeModeCatalog({ ...h.ctx, tools: [...h.tools, gate] });
  let resumed: Promise<unknown> | undefined;
  try {
    const parked = resultDetails(
      await h.tools[0]!.execute(
        "initial",
        {
          code: "const pending = gate({}); await yield_control(); return await pending;",
        },
        prior.signal,
      ),
    );
    expect(parked.status).toBe("waiting");
    await entered.promise;
    resumed = h.tools[1]!.execute("current", { runId: parked.runId }, current.signal).then(
      resultDetails,
    );
    prior.abort(new Error("obsolete call observer"));
    expect(aborts).toBe(0);
    release.resolve();
    expect(await resumed).toMatchObject({ status: "completed", value: "healthy" });
    expect(gate.execute).toHaveBeenCalledOnce();
    expect(aborts).toBe(0);
    expect(h.catalogRef.onDispose?.size ?? 0).toBe(0);
  } finally {
    release.resolve();
    await resumed;
    clearToolSearchCatalog(h.ctx);
  }
});

it("keeps the 64-slot limit on suspensions, including a reserved active resume, not CPU-only exec", async () => {
  const entered = createDeferred();
  const release = createDeferred();
  let aborts = 0;
  const gate = pluginToolWithExecute(
    "capacity_gate",
    "Hold a resumed slot",
    async (_id, _args, signal) => {
      signal?.addEventListener(
        "abort",
        () => {
          aborts += 1;
        },
        { once: true },
      );
      entered.resolve();
      await release.promise;
      return jsonResult(true);
    },
  );
  const owners = Array.from({ length: 64 }, () => {
    const h = createCodeModeHarness();
    applyCodeModeCatalog({ ...h.ctx, tools: [...h.tools, gate] });
    return h;
  });
  const ids: unknown[] = [];
  const extra = createCodeModeHarness();
  applyCodeModeCatalog({ ...extra.ctx, tools: extra.tools });
  let active: Promise<unknown> | undefined;
  try {
    // Four real VM starts at a time; no fabricated map entries or worker-count quota.
    for (let offset = 0; offset < owners.length; offset += 4) {
      await Promise.all(
        owners.slice(offset, offset + 4).map(async (h, index) => {
          const result = resultDetails(
            await h.tools[0]!.execute(`capacity-${offset + index}`, {
              code: "await yield_control(); await yield_control(); await capacity_gate({}); return true;",
            }),
          );
          expect(result.status).toBe("waiting");
          ids[offset + index] = result.runId;
        }),
      );
    }
    expect(new Set(ids).size).toBe(64);
    expect(testing.activeRuns.size).toBe(64);
    expect(
      resultDetails(
        await extra.tools[0]!.execute("cpu-at-capacity", {
          code: "let n=0; for(let i=0;i<1000;i++) n+=i; return n;",
        }),
      ),
    ).toMatchObject({ status: "completed", value: 499500 });
    const rejectSuspension = async () => {
      const result = resultDetails(
        await extra.tools[0]!.execute("overflow", { code: "await yield_control(); return true;" }),
      );
      expect(result).toMatchObject({
        status: "failed",
        code: "invalid_input",
        error: expect.stringContaining("too many suspended"),
      });
    };
    await rejectSuspension();
    const first = owners[0]!;
    const repark = resultDetails(
      await first.tools[1]!.execute("repark-at-capacity", { runId: ids[0] }),
    );
    expect(repark.status).toBe("waiting");
    ids[0] = repark.runId;
    active = first.tools[1]!.execute("active-at-capacity", { runId: ids[0] }).then(resultDetails);
    await entered.promise;
    expect(testing.activeRuns.size).toBe(63);
    await rejectSuspension();
    clearToolSearchCatalog(first.ctx);
    expect(await active).toMatchObject({ status: "failed", code: "aborted" });
    expect(aborts).toBe(1);
    const healthy = resultDetails(
      await extra.tools[0]!.execute("new-slot", {
        code: "await yield_control(); return 'healthy';",
      }),
    );
    expect(healthy.status).toBe("waiting");
    expect(testing.activeRuns.size).toBe(64);
    clearToolSearchCatalog(owners[1]!.ctx);
    expect(
      resultDetails(await extra.tools[1]!.execute("healthy-resume", { runId: healthy.runId })),
    ).toMatchObject({ status: "completed", value: "healthy" });
  } finally {
    release.resolve();
    owners.forEach((h) => clearToolSearchCatalog(h.ctx));
    clearToolSearchCatalog(extra.ctx);
    await active;
  }
  expect(testing.activeRuns.size).toBe(0);
  expect(testing.resumingRunIds.size).toBe(0);
});
