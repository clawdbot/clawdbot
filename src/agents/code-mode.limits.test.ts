/** Tests Code Mode runtime and output limits. */

import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { codeModeFailureCode } from "./code-mode-runtime.js";
import { applyCodeModeCatalog, createCodeModeTools, resolveCodeModeConfig } from "./code-mode.js";
import {
  resetCodeModeTestState,
  pluginTool,
  mcpTool,
  resultDetails,
  createCodeModeHarness,
  testing,
} from "./code-mode.test-support.js";
import { createToolSearchCatalogRef } from "./tool-search.js";
import { jsonResult } from "./tools/common.js";

describe("Code Mode runtime and output limits", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetCodeModeTestState();
  });

  it("enforces output limits on completed exec calls", async () => {
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

    expect(details.status).toBe("failed");
    expect(String(details.error)).toContain("output limit exceeded");
    expect(details.code).toBe("output_limit_exceeded");
  });

  it("enforces output limits before suspending runs", async () => {
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

    expect(details.status).toBe("failed");
    expect(String(details.error)).toContain("output limit exceeded");
    expect(details.code).toBe("output_limit_exceeded");
    expect(testing.activeRuns.size).toBe(beforeRunCount);
  });

  it("enforces the cumulative output limit across yielded waits", async () => {
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

    const first = resultDetails(
      await expectDefined(tools[0], "Code Mode exec test invariant").execute(
        "code-call-cumulative-output",
        {
          code: `
            text("a".repeat(600));
            await yield_control("pause");
            text("b".repeat(600));
            return "done";
          `,
        },
      ),
    );

    expect(first.status).toBe("waiting");
    expect(first.output).toEqual([{ type: "text", text: "a".repeat(600) }]);

    const second = resultDetails(
      await expectDefined(tools[1], "Code Mode wait test invariant").execute(
        "code-wait-cumulative-output",
        { runId: first.runId },
      ),
    );

    expect(second.status).toBe("failed");
    expect(second.code).toBe("output_limit_exceeded");
    expect(testing.activeRuns.has(first.runId as string)).toBe(false);
  });

  it("enforces output limits before auto-draining namespace calls", async () => {
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
    const executeListIssues = vi.fn(async () => jsonResult({ ok: true }));
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

    expect(details.status).toBe("failed");
    expect(String(details.error)).toContain("output limit exceeded");
    expect(details.code).toBe("output_limit_exceeded");
    expect(executeListIssues).not.toHaveBeenCalled();
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

  it("classifies snapshot limit failures", async () => {
    const config = resolveCodeModeConfig({
      tools: { codeMode: { enabled: true, maxSnapshotBytes: 1024 } },
    } as never);

    const result = await testing.runCodeModeWorker(
      {
        kind: "exec",
        source: 'const value = "x".repeat(100000); await yield_control("pause"); return value;',
        config,
        catalog: [],
      },
      5000,
    );

    expect(result.status).toBe("failed");
    expect(result).toMatchObject({
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
      testing.normalizeCodeModeWorkerResult({
        status: "failed",
        code: "timeout",
        error: "interrupted",
        failurePhase: "guest",
        bridgeDispatchStarted: false,
        output: [],
      }),
    ).toMatchObject({
      code: "timeout",
      error: "code mode timeout exceeded",
    });

    expect(
      testing.normalizeCodeModeWorkerResult({
        status: "failed",
        code: "internal_error",
        error: "interrupted",
        failurePhase: "guest",
        bridgeDispatchStarted: false,
        output: [],
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
      error: "code mode worker exited with code 0 before returning a result",
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
