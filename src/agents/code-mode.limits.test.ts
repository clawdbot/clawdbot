/** Tests Code Mode runtime and output limits. */

import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { codeModeFailureCode } from "./code-mode-runtime.js";
import { applyCodeModeCatalog, createCodeModeTools, resolveCodeModeConfig } from "./code-mode.js";
import {
  resetCodeModeTestState,
  pluginTool,
  pluginToolWithExecute,
  mcpTool,
  resultDetails,
  createCodeModeHarness,
  testing,
} from "./code-mode.test-support.js";
import { createToolSearchCatalogRef } from "./tool-search.js";
import { jsonResult } from "./tools/common.js";

const BRIDGE_ARGUMENT_BYTE_LIMIT = 8 * 1024 * 1024;
const BRIDGE_ARGUMENT_BYTES_ERROR =
  "code mode bridge arguments exceeded 8388608 bytes; pass references or split the work into smaller batches.";

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

    const result = await testing.runCodeModeWorker({
      workerData: {
        kind: "exec",
        source: 'const value = "x".repeat(100000); await yield_control("pause"); return value;',
        config,
        catalog: [],
      },
      timeoutMs: 5000,
    });

    expect(result.status).toBe("failed");
    expect(result).toMatchObject({
      code: "snapshot_limit_exceeded",
      error: "code mode snapshot limit exceeded",
      snapshotAttempt: {
        disposition: "rejected",
        rejectionReason: "size",
        measurement: {
          bytes: expect.any(Number),
          serializationMs: expect.any(Number),
        },
        coverage: "exact",
      },
    });
    expect(result.snapshotAttempt?.measurement?.bytes).toBeGreaterThan(1024);
  });

  it("accepts a pending frontier at the configured limit", async () => {
    const config = resolveCodeModeConfig({
      tools: { codeMode: { enabled: true, maxPendingToolCalls: 3 } },
    } as never);

    const result = await testing.runCodeModeWorker({
      workerData: {
        kind: "exec",
        source: `return await Promise.all(
          Array.from({ length: 3 }, (_, index) =>
            tools.callValue("fake_backlog", { index }),
          ),
        );`,
        config,
        catalog: [],
      },
      timeoutMs: 10_000,
    });

    expect(result.status).toBe("waiting");
    if (result.status !== "waiting") {
      return;
    }
    expect(result.pendingRequests).toHaveLength(3);
    expect(result.snapshotAttempt).toMatchObject({
      disposition: "accepted",
      measurement: {
        bytes: expect.any(Number),
        serializationMs: expect.any(Number),
      },
      coverage: "exact",
    });
  });

  it("rejects one bridge registration above the configured pending limit", async () => {
    const config = {
      tools: { codeMode: { enabled: true, maxPendingToolCalls: 3 } },
    } as never;
    const catalogRef = createToolSearchCatalogRef();
    const tools = createCodeModeTools({
      config,
      runtimeConfig: config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    });
    const executed: number[] = [];
    const target = pluginToolWithExecute(
      "fake_backlog",
      "Backlog limit helper",
      async (_toolCallId, input) => {
        executed.push((input as { index: number }).index);
        return jsonResult(input);
      },
    );
    applyCodeModeCatalog({
      tools: [...tools, target],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    });

    const details = resultDetails(
      await expectDefined(tools[0], "Code Mode exec test invariant").execute(
        "code-call-backlog-overflow",
        {
          code: `return await Promise.all(
            Array.from({ length: 4 }, (_, index) =>
              tools.callValue("fake_backlog", { index }),
            ),
          );`,
        },
      ),
    );

    expect(details).toMatchObject({
      status: "failed",
      code: "internal_error",
      error: "Error: too many pending code mode tool calls",
      bridgeDispatchStarted: true,
    });
    expect(target.execute).toHaveBeenCalledTimes(3);
    expect(executed).toEqual([0, 1, 2]);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(target.execute).toHaveBeenCalledTimes(3);
    expect(executed).toEqual([0, 1, 2]);
    expect(testing.activeRuns.size).toBe(0);
  });

  it("counts UTF-8 argument bytes before normal bridge dispatch", async () => {
    const catalogRef = createToolSearchCatalogRef();
    const config = {
      tools: {
        codeMode: {
          enabled: true,
          timeoutMs: 30_000,
          memoryLimitBytes: 128 * 1024 * 1024,
          maxPendingToolCalls: 128,
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
    const target = pluginTool("fake_argument_budget", "Argument budget helper");
    applyCodeModeCatalog({
      tools: [...tools, target],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    });

    const details = resultDetails(
      await expectDefined(tools[0], "Code Mode exec test invariant").execute(
        "code-call-argument-bytes",
        {
          // The string has half as many UTF-16 code units as the byte ceiling,
          // but its UTF-8 encoding fills the entire budget before JSON framing.
          code: `const payload = "é".repeat(${BRIDGE_ARGUMENT_BYTE_LIMIT / 2});
            return await tools.callValue("fake_argument_budget", { payload });`,
        },
      ),
    );

    expect(details).toMatchObject({
      status: "failed",
      code: "invalid_input",
      error: BRIDGE_ARGUMENT_BYTES_ERROR,
      bridgeDispatchStarted: false,
    });
    expect(target.execute).not.toHaveBeenCalled();
    expect(testing.activeRuns.size).toBe(0);
  });

  it("accepts a serialized bridge argument payload exactly at 8 MiB", async () => {
    const catalogRef = createToolSearchCatalogRef();
    const config = {
      tools: {
        codeMode: {
          enabled: true,
          timeoutMs: 30_000,
          memoryLimitBytes: 128 * 1024 * 1024,
          maxSnapshotBytes: 64 * 1024 * 1024,
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
    const toolId = "fake_argument_boundary";
    const target = pluginToolWithExecute(toolId, "Argument boundary helper", async () =>
      jsonResult({ accepted: true }),
    );
    applyCodeModeCatalog({
      tools: [...tools, target],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    });
    const framingBytes = Buffer.byteLength(JSON.stringify([toolId, { payload: "" }]), "utf8");
    const payloadBytes = BRIDGE_ARGUMENT_BYTE_LIMIT - framingBytes;

    const details = resultDetails(
      await expectDefined(tools[0], "Code Mode exec test invariant").execute(
        "code-call-argument-boundary",
        {
          code: `return await tools.callValue(${JSON.stringify(toolId)}, {
            payload: "x".repeat(${payloadBytes}),
          });`,
        },
      ),
    );

    expect(details).toMatchObject({
      status: "completed",
      value: { accepted: true },
    });
    expect(target.execute).toHaveBeenCalledOnce();
    expect(testing.activeRuns.size).toBe(0);
  });

  it("rejects cumulative small bridge arguments before dispatch", async () => {
    const catalogRef = createToolSearchCatalogRef();
    const config = {
      tools: {
        codeMode: {
          enabled: true,
          timeoutMs: 30_000,
          memoryLimitBytes: 128 * 1024 * 1024,
          maxPendingToolCalls: 128,
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
    const target = pluginTool("fake_argument_batch", "Argument batch helper");
    applyCodeModeCatalog({
      tools: [...tools, target],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    });

    const details = resultDetails(
      await expectDefined(tools[0], "Code Mode exec test invariant").execute(
        "code-call-argument-batch",
        {
          code: `const payload = "x".repeat(64 * 1024);
            return await Promise.all(
              Array.from({ length: 128 }, (_, index) =>
                tools.callValue("fake_argument_batch", { index, payload }),
              ),
            );`,
        },
      ),
    );

    expect(details).toMatchObject({
      status: "failed",
      code: "invalid_input",
      error: BRIDGE_ARGUMENT_BYTES_ERROR,
      bridgeDispatchStarted: false,
    });
    expect(target.execute).not.toHaveBeenCalled();
    expect(testing.activeRuns.size).toBe(0);
  });

  it("counts carried argument bytes when enforcing a resumed frontier", async () => {
    const config = resolveCodeModeConfig({
      tools: {
        codeMode: {
          enabled: true,
          timeoutMs: 30_000,
          memoryLimitBytes: 128 * 1024 * 1024,
          maxSnapshotBytes: 64 * 1024 * 1024,
        },
      },
    } as never);
    const first = await testing.runCodeModeWorker({
      workerData: {
        kind: "exec",
        source: `
          const carried = tools.callValue("fake_argument_budget", {
            payload: "x".repeat(6 * 1024 * 1024),
          });
          await tools.callValue("fake_gate", {});
          void tools.callValue("fake_argument_budget", {
            payload: "y".repeat(3 * 1024 * 1024),
          });
          return await carried;
        `,
        config,
        catalog: [],
      },
      timeoutMs: 30_000,
    });
    expect(first.status).toBe("waiting");
    if (first.status !== "waiting") {
      return;
    }
    expect(first.pendingRequests).toHaveLength(2);
    const gate = first.pendingRequests.at(-1);
    expect(gate).toBeDefined();
    if (!gate) {
      return;
    }

    const resumed = await testing.runCodeModeWorker({
      workerData: {
        kind: "resume",
        snapshotBytes: first.snapshotBytes,
        config,
        settledRequests: [{ id: gate.id, ok: true, value: {} }],
        pendingRequests: first.pendingRequests.slice(0, -1),
      },
      timeoutMs: 30_000,
    });

    expect(resumed).toMatchObject({
      status: "failed",
      code: "invalid_input",
      error: BRIDGE_ARGUMENT_BYTES_ERROR,
      bridgeDispatchStarted: false,
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

    const result = await testing.runCodeModeWorker({
      workerData: {
        kind: "exec",
        source: "return 1;",
        config,
        catalog: [],
      },
      timeoutMs: 500,
      workerUrl: missingWorkerUrl,
    });

    expect(result.status).toBe("failed");
    expect(result).toMatchObject({
      code: "runtime_unavailable",
    });
  });

  it("classifies nonzero worker exits as unavailable", async () => {
    const config = resolveCodeModeConfig({ tools: { codeMode: true } } as never);
    const exitingWorkerUrl = new URL("data:text/javascript,process.exit(1)");

    const result = await testing.runCodeModeWorker({
      workerData: {
        kind: "exec",
        source: "return 1;",
        config,
        catalog: [],
      },
      timeoutMs: 500,
      workerUrl: exitingWorkerUrl,
    });

    expect(result.status).toBe("failed");
    expect(result).toMatchObject({
      code: "runtime_unavailable",
    });
  });

  it("classifies clean worker exits without a result as unavailable", async () => {
    const config = resolveCodeModeConfig({ tools: { codeMode: true } } as never);
    const exitingWorkerUrl = new URL("data:text/javascript,");

    const result = await testing.runCodeModeWorker({
      workerData: {
        kind: "exec",
        source: "return 1;",
        config,
        catalog: [],
      },
      timeoutMs: 5_000,
      workerUrl: exitingWorkerUrl,
    });

    expect(result).toMatchObject({
      status: "failed",
      code: "runtime_unavailable",
      error: "code mode worker exited with code 0 before returning a result",
    });
  });

  it("does not classify guest interrupted errors as timeouts", async () => {
    const config = resolveCodeModeConfig({ tools: { codeMode: true } } as never);

    const result = await testing.runCodeModeWorker({
      workerData: {
        kind: "exec",
        source: 'throw new Error("interrupted");',
        config,
        catalog: [],
      },
      timeoutMs: 10_000,
    });

    expect(result.status).toBe("failed");
    // A guest error whose message happens to be "interrupted" must stay
    // internal_error and not be misclassified as a QuickJS interrupt/timeout.
    expect(result).toMatchObject({ code: "internal_error" });
    if (result.status === "failed") {
      expect(result.error).toContain("interrupted");
    }
  });
});
