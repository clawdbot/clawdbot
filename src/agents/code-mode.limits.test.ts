/** Tests Code Mode runtime and output limits. */

import { expectDefined } from "@openclaw/normalization-core";
import { QuickJS } from "quickjs-wasi";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { EMPTY_CODE_MODE_OUTPUT } from "./code-mode-json.js";
import { codeModeFailureCode } from "./code-mode-runtime.js";
import { applyCodeModeCatalog, createCodeModeTools, resolveCodeModeConfig } from "./code-mode.js";
import {
  expectOriginalCodeModeMarker,
  expectCodeModeSharedBudget,
  pluginToolWithExecute,
  resetCodeModeTestState,
  pluginTool,
  mcpTool,
  resultDetails,
  createCodeModeHarness,
  testing,
} from "./code-mode.test-support.js";
import { projectMcpCallToolResult } from "./mcp-content.js";
import { createToolSearchCatalogRef } from "./tool-search.js";

describe("Code Mode runtime and output limits", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetCodeModeTestState();
  });

  it("bounds oversized values on completed exec calls", async () => {
    const catalogRef = createToolSearchCatalogRef();
    const config = {
      tools: {
        codeMode: {
          enabled: true,
          maxOutputBytes: 1024,
        },
      },
    } as never;
    const ctx = {
      config,
      runtimeConfig: config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    };
    const tools = createCodeModeTools(ctx);
    applyCodeModeCatalog({
      tools: [...tools, pluginTool("fake_noop", "Noop")],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    });

    const details = resultDetails(
      await expectDefined(tools[0], "tools[0] test invariant").execute("code-call-large", {
        code: "return 'x'.repeat(2048);",
      }),
    );

    expect(details.status).toBe("completed");
    expect(details.value).toMatchObject({
      truncated: true,
      guidance: expect.stringContaining("rerun with narrower args"),
    });
  });

  it("bounds oversized output before suspending runs", async () => {
    const catalogRef = createToolSearchCatalogRef();
    const config = {
      tools: {
        codeMode: {
          enabled: true,
          maxOutputBytes: 1024,
        },
      },
    } as never;
    const ctx = {
      config,
      runtimeConfig: config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    };
    const tools = createCodeModeTools(ctx);
    applyCodeModeCatalog({
      tools: [...tools, pluginTool("fake_noop", "Noop")],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    });

    const beforeRunCount = testing.activeRuns.size;
    const details = resultDetails(
      await expectDefined(tools[0], "tools[0] test invariant").execute("code-call-large-suspend", {
        code: "text('x'.repeat(2048)); await yield_control('pause'); return 1;",
      }),
    );

    expect(details.status).toBe("waiting");
    expect(JSON.stringify(details.output)).toContain("rerun with narrower args");
    expect(testing.activeRuns.size).toBe(beforeRunCount + 1);

    const completed = resultDetails(
      await expectDefined(tools[1], "Code Mode wait test invariant").execute(
        "code-wait-large-suspend",
        { runId: details.runId },
      ),
    );
    expect(completed.status).toBe("completed");
    expect(testing.activeRuns.size).toBe(beforeRunCount);
  });

  it.each([
    { name: "original 1KiB", cap: 1024, firstText: "🦞".repeat(140), lastText: "é".repeat(240) },
    {
      name: "default budget",
      cap: undefined,
      firstText: "🦞".repeat(9000),
      lastText: "é".repeat(18000),
    },
    {
      name: "clipped first leg",
      cap: 1024,
      firstText: "🦞".repeat(1000),
      lastText: '\\"\n\té'.repeat(30),
    },
  ])(
    "bounds cumulative original output across yielded waits: $name",
    async ({ cap, firstText, lastText }) => {
      const { ctx } = createCodeModeHarness();
      const config = {
        tools: { codeMode: { enabled: true, ...(cap ? { maxOutputBytes: cap } : {}) } },
      };
      const tools = createCodeModeTools({ ...ctx, config, runtimeConfig: config });
      applyCodeModeCatalog({ ...ctx, config, tools });
      const exec = expectDefined(tools[0], "exec");
      const wait = expectDefined(tools[1], "wait");
      const original = [
        { type: "text", text: firstText },
        { type: "text", text: lastText },
      ];
      const first = resultDetails(
        await exec.execute("cumulative", {
          code: `text(${JSON.stringify(firstText)}); await yield_control(); await yield_control(); text(${JSON.stringify(lastText)}); await yield_control(); return true;`,
        }),
      );
      expect(first.status).toBe("waiting");
      if (Buffer.byteLength(JSON.stringify([original[0]])) > (cap ?? 65536)) {
        expectOriginalCodeModeMarker((first.output as unknown[])[0], [original[0]]);
      } else {
        expect(first.output).toEqual([original[0]]);
      }
      const empty = resultDetails(await wait.execute("empty-leg", { runId: first.runId }));
      expect(empty.status).toBe("waiting");
      expect(empty.output).toEqual([]);
      const changed = resultDetails(await wait.execute("new-leg", { runId: first.runId }));
      expect(changed.status).toBe("waiting");
      expectOriginalCodeModeMarker((changed.output as unknown[])[0], original);
      const final = resultDetails(await wait.execute("final", { runId: first.runId }));
      expect(final.status).toBe("completed");
      expect(final.value).toBe(true);
      expectOriginalCodeModeMarker((final.output as unknown[])[0], original);
      for (const frame of [first, empty, changed, final]) {
        expectCodeModeSharedBudget(frame, cap ?? 65536);
      }
      expect(testing.activeRuns.size).toBe(0);
    },
  );

  it.each(["exec", "wait"])(
    "preserves output and cancels earlier tools when a %s resume exceeds the snapshot cap",
    async (mode) => {
      const { ctx, config, tools } = createCodeModeHarness();
      const pendingStarted = createDeferred<AbortSignal>();
      const pending = pluginToolWithExecute(
        "snapshot_pending",
        "Pending snapshot fixture",
        async (_toolCallId, _input, signal) => {
          const pendingSignal = expectDefined(signal, "pending bridge signal");
          pendingStarted.resolve(pendingSignal);
          await new Promise<void>((resolve) => {
            pendingSignal.addEventListener("abort", () => resolve(), { once: true });
          });
          return { content: [], details: true };
        },
      );
      const fixture = pluginToolWithExecute("output_fixture", "Output fixture", async () => {
        await pendingStarted.promise;
        return { content: [], details: true };
      });
      const fresh = pluginTool("snapshot_fresh", "Fresh snapshot fixture");
      applyCodeModeCatalog({ ...ctx, config, tools: [...tools, pending, fixture, fresh] });
      const exec = expectDefined(tools[0], "exec");
      const wait = expectDefined(tools[1], "wait");
      const input = {
        code: `${mode === "wait" ? 'text("delivered"); await yield_control();' : ""}
          void snapshot_pending({});
          text("accepted first");
          await output_fixture({});
          const retained = new Uint8Array(16 * 1024 * 1024);
          retained[0] = 7;
          text("accepted inline");
          await yield_control();
          await snapshot_fresh({});
          return retained[0];`,
      };
      const first = mode === "wait" ? resultDetails(await exec.execute("park", input)) : undefined;
      if (first) {
        expect(first).toMatchObject({
          status: "waiting",
          output: [{ type: "text", text: "delivered" }],
        });
      }
      const result = resultDetails(
        await (first
          ? wait.execute("resume", { runId: first.runId })
          : exec.execute("inline", input)),
      );
      expect(result).toMatchObject({ status: "failed", code: "snapshot_limit_exceeded" });
      expect(pending.execute).toHaveBeenCalledOnce();
      expect(fixture.execute).toHaveBeenCalledOnce();
      expect(fresh.execute).not.toHaveBeenCalled();
      expect((await pendingStarted.promise).aborted).toBe(true);
      expect(result.output).toEqual([
        { type: "text", text: "accepted first" },
        { type: "text", text: "accepted inline" },
      ]);
      expect(testing.activeRuns.size).toBe(0);
    },
  );

  it.each(["abort", "restart-safe"])(
    "shares the output budget with %s diagnostics",
    async (mode) => {
      const { ctx } = createCodeModeHarness();
      const config = { tools: { codeMode: { enabled: true, maxOutputBytes: 1024 } } };
      const tools = createCodeModeTools({ ...ctx, config, runtimeConfig: config });
      const controller = new AbortController();
      const fixture = pluginToolWithExecute("output_fixture", "Output fixture", async () => {
        controller.abort();
        return { content: [], details: true };
      });
      applyCodeModeCatalog({ ...ctx, config, tools: [...tools, fixture] });
      const result = resultDetails(
        await expectDefined(tools[0], "exec").execute(
          "failure",
          {
            code: 'text("🦞".repeat(1000)); await output_fixture({}); return true;',
            restartSafe: mode === "restart-safe",
          },
          controller.signal,
        ),
      );
      expect(result).toMatchObject({
        status: "failed",
        code: mode === "abort" ? "aborted" : "invalid_input",
      });
      expect(fixture.execute).toHaveBeenCalledTimes(mode === "abort" ? 1 : 0);
      expectOriginalCodeModeMarker((result.output as unknown[])[0], [
        { type: "text", text: "🦞".repeat(1000) },
      ]);
      expectCodeModeSharedBudget(result, 1024);
      expect(testing.activeRuns.size).toBe(0);
    },
  );

  it("bounds output before auto-draining namespace calls", async () => {
    const catalogRef = createToolSearchCatalogRef();
    const config = {
      tools: {
        codeMode: {
          enabled: true,
          maxOutputBytes: 1024,
        },
      },
    } as never;
    const ctx = {
      config,
      runtimeConfig: config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    };
    const tools = createCodeModeTools(ctx);
    const executeListIssues = vi.fn(async () =>
      projectMcpCallToolResult({ content: [{ type: "text", text: '{"ok":true}' }] }),
    );
    const listIssues = mcpTool({
      name: "tickets__list",
      serverName: "tickets",
      toolName: "list",
      execute: executeListIssues,
    });
    applyCodeModeCatalog({
      tools: [...tools, listIssues],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    });

    const details = resultDetails(
      await expectDefined(tools[0], "tools[0] test invariant").execute(
        "code-call-large-namespace",
        {
          code: 'text("x".repeat(2048)); await MCP.tickets.list({ state: "open" }); return 1;',
        },
      ),
    );

    expect(details.status).toBe("completed");
    expect(JSON.stringify(details.output)).toContain("rerun with narrower args");
    expect(executeListIssues).toHaveBeenCalledOnce();
  });

  it("preserves guest output when a run fails", async () => {
    const { config, catalogRef, tools } = createCodeModeHarness();
    applyCodeModeCatalog({
      tools: [...tools, pluginTool("fake_noop", "Noop")],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    });

    const details = resultDetails(
      await expectDefined(tools[0], "tools[0] test invariant").execute(
        "code-call-output-before-error",
        {
          code: 'text("before"); throw new Error("boom");',
        },
      ),
    );

    expect(details.status).toBe("failed");
    expect(String(details.error)).toContain("Error: boom");
    expect(details.output).toEqual([{ type: "text", text: "before" }]);
    expect(details.failurePhase).toBe("guest");
    expect(details.bridgeDispatchStarted).toBe(false);
  });

  it("enforces the exact encoded snapshot byte limit", async () => {
    const config = resolveCodeModeConfig({ tools: { codeMode: true } } as never);
    const execute = (maxSnapshotBytes = config.maxSnapshotBytes) =>
      testing.runCodeModeWorker(
        {
          kind: "exec",
          source: 'const value = "x".repeat(100000); await yield_control("pause"); return value;',
          config: { ...config, maxSnapshotBytes },
          catalog: [],
        },
        5_000,
      );
    const probe = await execute();
    expect(probe.status).toBe("waiting");
    if (probe.status !== "waiting") {
      throw new Error("expected a suspended guest to measure its snapshot");
    }
    const encodedBytes = QuickJS.serializeSnapshot(probe.snapshot).byteLength;

    expect(await execute(encodedBytes)).toMatchObject({ status: "waiting" });
    expect(await execute(encodedBytes - 1)).toMatchObject({
      status: "failed",
      code: "snapshot_limit_exceeded",
      error: "code mode snapshot limit exceeded",
    });
  });

  it("terminates hostile infinite loops outside the main event loop", async () => {
    const catalogRef = createToolSearchCatalogRef();
    const config = {
      tools: {
        codeMode: {
          enabled: true,
          timeoutMs: 100,
        },
      },
    } as never;
    const ctx = {
      config,
      runtimeConfig: config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    };
    const tools = createCodeModeTools(ctx);
    applyCodeModeCatalog({
      tools: [...tools, pluginTool("fake_noop", "Noop")],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    });

    const heartbeat = Promise.resolve("main-event-loop-alive");
    const details = resultDetails(
      await expectDefined(tools[0], "tools[0] test invariant").execute("code-call-loop", {
        code: "while (true) {}",
      }),
    );

    await expect(heartbeat).resolves.toBe("main-event-loop-alive");
    expect(details.status).toBe("failed");
    expect(String(details.error)).toContain("timeout exceeded");
    expect(details.code).toBe("timeout");
  });

  it("normalizes QuickJS interrupt timeout errors", () => {
    expect(
      codeModeFailureCode(new Error("interrupted", { cause: new Error("worker stopped") })),
    ).toBe("timeout");
    expect(
      testing.normalizeCodeModeTimeoutResult({
        status: "failed",
        code: "timeout",
        error: "interrupted",
        failurePhase: "guest",
        bridgeDispatchStarted: false,
        output: EMPTY_CODE_MODE_OUTPUT,
      }),
    ).toMatchObject({
      code: "timeout",
      error: "code mode timeout exceeded",
    });

    expect(
      testing.normalizeCodeModeTimeoutResult({
        status: "failed",
        code: "internal_error",
        error: "interrupted",
        failurePhase: "guest",
        bridgeDispatchStarted: false,
        output: EMPTY_CODE_MODE_OUTPUT,
      }),
    ).toMatchObject({
      code: "internal_error",
      error: "interrupted",
    });
  });

  it("classifies missing worker runtime as unavailable", async () => {
    const config = resolveCodeModeConfig({ tools: { codeMode: true } } as never);
    const missingWorkerUrl = new URL("./missing-code-mode.worker.js", import.meta.url);

    const result = await testing.runCodeModeWorker(
      {
        kind: "exec",
        source: "return 1;",
        config,
        catalog: [],
      },
      500,
      missingWorkerUrl,
    );

    expect(result.status).toBe("failed");
    expect(result).toMatchObject({
      code: "runtime_unavailable",
    });
  });

  it("classifies nonzero worker exits as unavailable", async () => {
    const config = resolveCodeModeConfig({ tools: { codeMode: true } } as never);
    const exitingWorkerUrl = new URL("data:text/javascript,process.exit(1)");

    const result = await testing.runCodeModeWorker(
      {
        kind: "exec",
        source: "return 1;",
        config,
        catalog: [],
      },
      500,
      exitingWorkerUrl,
    );

    expect(result.status).toBe("failed");
    expect(result).toMatchObject({
      code: "runtime_unavailable",
    });
  });

  it("classifies clean worker exits without a result as unavailable", async () => {
    const config = resolveCodeModeConfig({ tools: { codeMode: true } } as never);
    const exitingWorkerUrl = new URL("data:text/javascript,");

    const result = await testing.runCodeModeWorker(
      {
        kind: "exec",
        source: "return 1;",
        config,
        catalog: [],
      },
      5_000,
      exitingWorkerUrl,
    );

    expect(result).toMatchObject({
      status: "failed",
      code: "runtime_unavailable",
      error: expect.stringContaining("worker exited with code 0"),
    });
  });

  it("does not classify guest interrupted errors as timeouts", async () => {
    const config = resolveCodeModeConfig({ tools: { codeMode: true } } as never);

    const result = await testing.runCodeModeWorker(
      {
        kind: "exec",
        source: 'throw new Error("interrupted");',
        config,
        catalog: [],
      },
      10_000,
    );

    expect(result.status).toBe("failed");
    // A guest error whose message happens to be "interrupted" must stay
    // internal_error and not be misclassified as a QuickJS interrupt/timeout.
    expect(result).toMatchObject({ code: "internal_error" });
    if (result.status === "failed") {
      expect(result.error).toContain("interrupted");
    }
  });
});
