/** Tests Code Mode bridge settlement and cancellation. */

import { expectDefined } from "@openclaw/normalization-core";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { buildBlockedToolResult } from "./agent-tools.before-tool-call.js";
import { applyCodeModeCatalog, createCodeModeTools } from "./code-mode.js";
import {
  resetCodeModeTestState,
  pluginTool,
  pluginToolWithExecute,
  resultDetails,
  createCodeModeHarness,
  runUntilCompleted,
  testing,
} from "./code-mode.test-support.js";
import { createToolSearchCatalogRef } from "./tool-search.js";
import { jsonResult } from "./tools/common.js";

describe("Code Mode bridge settlement and cancellation", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetCodeModeTestState();
  });

  it("drains a nested combinator after its outer race wins", async () => {
    const { config, catalogRef, tools: codeModeTools } = createCodeModeHarness();
    let nestedAborted = false;
    const never = pluginToolWithExecute(
      "fake_nested_race_never",
      "Never-settling nested race helper",
      async (_toolCallId, _input, signal) => {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 25);
          signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              nestedAborted = true;
              reject(new Error("aborted"));
            },
            { once: true },
          );
        });
        return jsonResult({ winner: "nested" });
      },
    );
    const fast = pluginToolWithExecute(
      "fake_nested_race_fast",
      "Fast nested race helper",
      async () => jsonResult({ winner: "fast" }),
    );
    applyCodeModeCatalog({
      tools: [...codeModeTools, never, fast],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    });

    const details = resultDetails(
      await expectDefined(codeModeTools[0], "Code Mode exec test invariant").execute(
        "code-call-nested-combinator-race",
        {
          code: `return await Promise.race([
            Promise.all([tools.callValue("fake_nested_race_never", {})]),
            tools.callValue("fake_nested_race_fast", {}),
          ]);`,
        },
      ),
    );

    expect(details).toMatchObject({ status: "completed", value: { winner: "fast" } });
    expect(never.execute).toHaveBeenCalledOnce();
    expect(fast.execute).toHaveBeenCalledOnce();
    expect(nestedAborted).toBe(false);
    expect(testing.activeRuns.size).toBe(0);
  });

  it("resolves sequential bridge tool calls inline within one exec instead of a wait per call", async () => {
    const catalogRef = createToolSearchCatalogRef();
    // maxPendingToolCalls stays a per-batch concurrency cap; five sequential
    // awaits must drain inline even with a cap of 2.
    const config = {
      tools: { codeMode: { enabled: true, maxPendingToolCalls: 2 } },
    } as never;
    const ctx = {
      config,
      runtimeConfig: config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    };
    const codeModeTools = createCodeModeTools(ctx);
    const ticket = pluginTool("fake_create_ticket", "Create a fake ticket");
    applyCodeModeCatalog({
      tools: [...codeModeTools, ticket],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    });

    // Five separate awaits would each suspend to the model under a wait-per-call
    // design; inline resumption collapses them into a single completed exec so
    // the model spends one turn instead of six.
    const details = resultDetails(
      await expectDefined(codeModeTools[0], "codeModeTools[0] test invariant").execute(
        "code-call-inline",
        {
          code: `
            const ids = [];
            for (let index = 0; index < 5; index += 1) {
              const called = await tools.callValue("fake_create_ticket", { value: index });
              ids.push(called.input.value);
            }
            return ids;
          `,
        },
      ),
    );

    expect(details.status).toBe("completed");
    expect(details.value).toEqual([0, 1, 2, 3, 4]);
    expect(ticket.execute).toHaveBeenCalledTimes(5);
    expect(testing.activeRuns.size).toBe(0);
  });

  it("keeps the actual winner when the later-started nested tool settles first", async () => {
    const { config, catalogRef, tools: codeModeTools } = createCodeModeHarness();
    let firstAborted = false;
    const first = pluginToolWithExecute(
      "fake_first",
      "Earlier slow helper",
      async (_toolCallId, _input, signal) => {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 25);
          signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              firstAborted = true;
              reject(new Error("aborted"));
            },
            { once: true },
          );
        });
        return jsonResult({ winner: "first" });
      },
    );
    const second = pluginToolWithExecute("fake_second", "Later fast helper", async () =>
      jsonResult({ winner: "second" }),
    );
    applyCodeModeCatalog({
      tools: [...codeModeTools, first, second],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    });

    const details = resultDetails(
      await expectDefined(codeModeTools[0], "Code Mode exec test invariant").execute(
        "code-call-later-winner",
        {
          code: `return await Promise.race([
            tools.callValue("fake_first", {}),
            tools.callValue("fake_second", {}),
          ]);`,
        },
      ),
    );

    expect(details).toMatchObject({ status: "completed", value: { winner: "second" } });
    expect(first.execute).toHaveBeenCalledOnce();
    expect(second.execute).toHaveBeenCalledOnce();
    expect(firstAborted).toBe(false);
    expect(testing.activeRuns.size).toBe(0);
  });

  it.each([
    {
      label: "directly",
      auditCode: 'void tools.callValue("fake_early_audit", {});',
    },
    {
      label: "in a detached already-settled Promise.race",
      auditCode: 'void Promise.race([tools.callValue("fake_early_audit", {}), Promise.resolve()]);',
    },
    {
      label: "in a detached Promise.all",
      auditCode: 'void Promise.all([tools.callValue("fake_early_audit", {})]);',
    },
    {
      label: "in a detached Promise.allSettled",
      auditCode: 'void Promise.allSettled([tools.callValue("fake_early_audit", {})]);',
    },
    {
      label: "in a detached Promise.any",
      auditCode: 'void Promise.any([tools.callValue("fake_early_audit", {})]);',
    },
    {
      label: "in a detached Promise.race",
      auditCode: 'void Promise.race([tools.callValue("fake_early_audit", {})]);',
    },
  ])(
    "drains a detached audit started $label before an awaited nested call",
    async ({ auditCode }) => {
      const { config, catalogRef, tools: codeModeTools } = createCodeModeHarness();
      let auditCompleted = false;
      let auditAborted = false;
      const auditStarted = createDeferred();
      const auditRelease = createDeferred();
      const audit = pluginToolWithExecute(
        "fake_early_audit",
        "Early detached audit",
        async (_toolCallId, _input, signal) => {
          auditStarted.resolve();
          signal?.addEventListener("abort", () => (auditAborted = true), { once: true });
          await auditRelease.promise;
          auditCompleted = true;
          return jsonResult({ recorded: true });
        },
      );
      const fast = pluginToolWithExecute("fake_awaited_fast", "Awaited fast helper", async () => {
        await auditStarted.promise;
        setImmediate(() => auditRelease.resolve());
        return jsonResult({ winner: "fast" });
      });
      applyCodeModeCatalog({
        tools: [...codeModeTools, audit, fast],
        config,
        sessionId: "session-code-mode",
        sessionKey: "agent:main:main",
        runId: "run-code-mode",
        catalogRef,
      });

      const details = resultDetails(
        await expectDefined(codeModeTools[0], "Code Mode exec test invariant").execute(
          "code-call-early-detached-audit",
          {
            code: `${auditCode}
            return await tools.callValue("fake_awaited_fast", {});`,
          },
        ),
      );

      expect(details).toMatchObject({ status: "completed", value: { winner: "fast" } });
      expect(audit.execute).toHaveBeenCalledOnce();
      expect(fast.execute).toHaveBeenCalledOnce();
      expect(auditCompleted).toBe(true);
      expect(auditAborted).toBe(false);
      expect(testing.activeRuns.size).toBe(0);
    },
  );

  it("drains a race winner's detached audit and its slower race branch", async () => {
    const { config, catalogRef, tools: codeModeTools } = createCodeModeHarness();
    let loserAborted = false;
    const winner = pluginToolWithExecute("fake_race_winner", "Race winner", async () =>
      jsonResult({ winner: "fast" }),
    );
    const loser = pluginToolWithExecute(
      "fake_race_loser",
      "Race loser",
      async (_toolCallId, _input, signal) => {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 25);
          signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              loserAborted = true;
              reject(new Error("aborted"));
            },
            { once: true },
          );
        });
        return jsonResult({ winner: "slow" });
      },
    );
    const audit = pluginToolWithExecute("fake_race_audit", "Detached audit", async () =>
      jsonResult({ recorded: true }),
    );
    applyCodeModeCatalog({
      tools: [...codeModeTools, winner, loser, audit],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    });

    const details = resultDetails(
      await expectDefined(codeModeTools[0], "Code Mode exec test invariant").execute(
        "code-call-race-detached-audit",
        {
          code: `return Promise.race([
            tools.callValue("fake_race_winner", {}),
            tools.callValue("fake_race_loser", {}),
          ]).then((value) => {
            void tools.callValue("fake_race_audit", {});
            return value;
          });`,
        },
      ),
    );

    expect(details).toMatchObject({ status: "completed", value: { winner: "fast" } });
    expect(winner.execute).toHaveBeenCalledOnce();
    expect(loser.execute).toHaveBeenCalledOnce();
    expect(audit.execute).toHaveBeenCalledOnce();
    expect(loserAborted).toBe(false);
    expect(testing.activeRuns.size).toBe(0);
  });

  it("drains every detached nested tool before completing the guest", async () => {
    const { config, catalogRef, tools: codeModeTools } = createCodeModeHarness();
    const first = pluginToolWithExecute("fake_detached_first", "First detached helper", async () =>
      jsonResult({ name: "first" }),
    );
    const second = pluginToolWithExecute(
      "fake_detached_second",
      "Second detached helper",
      async () => jsonResult({ name: "second" }),
    );
    applyCodeModeCatalog({
      tools: [...codeModeTools, first, second],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    });

    const details = resultDetails(
      await expectDefined(codeModeTools[0], "Code Mode exec test invariant").execute(
        "code-call-detached",
        {
          code: `void tools.callValue("fake_detached_first", {});
            void tools.callValue("fake_detached_second", {});
            return "done";`,
        },
      ),
    );

    expect(details).toMatchObject({ status: "completed", value: "done" });
    expect(first.execute).toHaveBeenCalledOnce();
    expect(second.execute).toHaveBeenCalledOnce();
    expect(testing.activeRuns.size).toBe(0);
  });

  it.each(["race", "any"] as const)(
    "preserves the Promise.%s winner while draining the slower nested tool",
    async (combinator) => {
      const { config, catalogRef, tools: codeModeTools } = createCodeModeHarness();
      let slowAborted = false;
      let slowCompleted = false;
      const fast = pluginToolWithExecute("fake_fast", "Fast helper", async () =>
        jsonResult({ winner: "fast" }),
      );
      const slow = pluginToolWithExecute(
        "fake_slow",
        "Slow helper",
        async (_toolCallId, _input, signal) => {
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(resolve, 25);
            signal?.addEventListener(
              "abort",
              () => {
                clearTimeout(timer);
                slowAborted = true;
                reject(new Error("aborted"));
              },
              { once: true },
            );
          });
          slowCompleted = true;
          return jsonResult({ winner: "slow" });
        },
      );
      applyCodeModeCatalog({
        tools: [...codeModeTools, fast, slow],
        config,
        sessionId: "session-code-mode",
        sessionKey: "agent:main:main",
        runId: "run-code-mode",
        catalogRef,
      });

      const details = resultDetails(
        await expectDefined(codeModeTools[0], "Code Mode exec test invariant").execute(
          `code-call-${combinator}-fast`,
          {
            code: `return await Promise.${combinator}([
              tools.callValue("fake_fast", {}),
              tools.callValue("fake_slow", {}),
            ]);`,
          },
        ),
      );

      expect(details).toMatchObject({ status: "completed", value: { winner: "fast" } });
      expect(fast.execute).toHaveBeenCalledOnce();
      expect(slow.execute).toHaveBeenCalledOnce();
      expect(slowCompleted).toBe(true);
      expect(slowAborted).toBe(false);
      expect(testing.activeRuns.size).toBe(0);
    },
  );

  it("preserves fail-fast Promise.all while draining the slower nested tool", async () => {
    const { config, catalogRef, tools: codeModeTools } = createCodeModeHarness();
    let slowAborted = false;
    let slowCompleted = false;
    const failed = pluginToolWithExecute("fake_failed", "Failed helper", async () => {
      throw new Error("fast failure");
    });
    const slow = pluginToolWithExecute(
      "fake_slow",
      "Slow helper",
      async (_toolCallId, _input, signal) => {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 25);
          signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              slowAborted = true;
              reject(new Error("aborted"));
            },
            { once: true },
          );
        });
        slowCompleted = true;
        return jsonResult({ winner: "slow" });
      },
    );
    applyCodeModeCatalog({
      tools: [...codeModeTools, failed, slow],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    });

    const details = resultDetails(
      await expectDefined(codeModeTools[0], "Code Mode exec test invariant").execute(
        "code-call-fail-fast",
        {
          code: `try {
            await Promise.all([
              tools.callValue("fake_failed", {}),
              tools.callValue("fake_slow", {}),
            ]);
            return "unexpected success";
          } catch (error) {
            return error.message;
          }`,
        },
      ),
    );

    expect(details).toMatchObject({ status: "completed", value: "fast failure" });
    expect(failed.execute).toHaveBeenCalledOnce();
    expect(slow.execute).toHaveBeenCalledOnce();
    expect(slowCompleted).toBe(true);
    expect(slowAborted).toBe(false);
    expect(testing.activeRuns.size).toBe(0);
  });

  it("marks failures after nested tool dispatch as non-retryable bridge failures", async () => {
    const { config, catalogRef, tools: codeModeTools } = createCodeModeHarness();
    const sideEffect = pluginToolWithExecute("fake_side_effect", "Side effect", async () =>
      jsonResult({ ok: true }),
    );
    applyCodeModeCatalog({
      tools: [...codeModeTools, sideEffect],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    });

    const details = resultDetails(
      await expectDefined(codeModeTools[0], "Code Mode exec test invariant").execute(
        "code-call-post-dispatch-failure",
        {
          code: `
            await tools.callValue("fake_side_effect", {});
            throw new Error("after dispatch");
          `,
        },
      ),
    );

    expect(sideEffect.execute).toHaveBeenCalledOnce();
    expect(details).toMatchObject({
      status: "failed",
      failurePhase: "bridge",
      bridgeDispatchStarted: true,
    });
  });

  it("fails fast without parking a suspended run when the exec call is aborted", async () => {
    const catalogRef = createToolSearchCatalogRef();
    // Long timeout so a missing abort short-circuit would block the whole test.
    const config = {
      tools: { codeMode: { enabled: true, timeoutMs: 30_000 } },
    } as never;
    const ctx = {
      config,
      runtimeConfig: config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    };
    const codeModeTools = createCodeModeTools(ctx);
    applyCodeModeCatalog({
      tools: [
        ...codeModeTools,
        // A tool that never settles and ignores its abort signal; only the
        // host-level abort race can free the cancelled exec.
        pluginToolWithExecute("fake_stuck", "Stuck helper", async () => {
          await new Promise<never>(() => {});
          return null as never;
        }),
      ],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    });

    const controller = new AbortController();
    controller.abort();
    const details = resultDetails(
      await expectDefined(codeModeTools[0], "codeModeTools[0] test invariant").execute(
        "code-call-abort",
        { code: "await tools.fake_stuck({}); return 'done';" },
        controller.signal,
      ),
    );

    // Abort drops the run instead of parking it; a cancelled call must not pin
    // one of the process-global suspended-run slots until TTL expiry.
    expect(details.status).toBe("failed");
    expect(details.error).toBe("code mode execution aborted");
    expect(details.code).toBe("aborted");
    expect(testing.activeRuns.size).toBe(0);
  });

  it("terminates a running guest promptly when the exec call is aborted", async () => {
    const catalogRef = createToolSearchCatalogRef();
    // Long timeout so only the abort race can end the hostile loop quickly.
    const config = {
      tools: { codeMode: { enabled: true, timeoutMs: 30_000 } },
    } as never;
    const ctx = {
      config,
      runtimeConfig: config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    };
    const codeModeTools = createCodeModeTools(ctx);
    applyCodeModeCatalog({
      tools: [...codeModeTools, pluginTool("fake_noop", "Noop")],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    });

    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), 200);
    const startedAt = Date.now();
    try {
      const details = resultDetails(
        await expectDefined(codeModeTools[0], "codeModeTools[0] test invariant").execute(
          "code-call-abort-live",
          { code: "while (true) {}" },
          controller.signal,
        ),
      );
      expect(details.status).toBe("failed");
      expect(details.error).toBe("code mode execution aborted");
      expect(details.code).toBe("aborted");
    } finally {
      clearTimeout(abortTimer);
    }
    expect(Date.now() - startedAt).toBeLessThan(10_000);
    expect(testing.activeRuns.size).toBe(0);
  });

  it("surfaces policy blocks as guest call errors for declared outputs", async () => {
    const { config, catalogRef, tools: codeModeTools } = createCodeModeHarness();
    const target = pluginTool("fake_policy_block", "Return policy-controlled rows");
    target.outputSchema = Type.Array(
      Type.Object({ id: Type.String() }, { additionalProperties: false }),
    );
    target.execute = vi.fn(async () =>
      buildBlockedToolResult({ reason: "blocked by orchard policy" }),
    );
    applyCodeModeCatalog({
      tools: [...codeModeTools, target],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    });

    const details = await runUntilCompleted({
      execTool: expectDefined(codeModeTools[0], "codeModeTools[0] test invariant"),
      waitTool: expectDefined(codeModeTools[1], "codeModeTools[1] test invariant"),
      code: `
        try {
          const rows = await tools.callValue("fake_policy_block", {});
          return rows.map((row) => row.id);
        } catch (error) {
          return error.message;
        }
      `,
    });

    expect(details.status).toBe("completed");
    expect(details.value).toContain("was blocked before execution: blocked by orchard policy");
  });
});
