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
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { config, catalogRef, tools: codeModeTools } = createCodeModeHarness();
    const events: string[] = [];
    const nestedStarted = createDeferred();
    const nestedRelease = createDeferred();
    let nestedAborted = false;
    const never = pluginToolWithExecute(
      "fake_nested_race_never",
      "Never-settling nested race helper",
      async (_toolCallId, _input, signal) => {
        events.push("nested:start");
        nestedStarted.resolve();
        signal?.addEventListener(
          "abort",
          () => {
            nestedAborted = true;
            nestedRelease.reject(new Error("aborted"));
          },
          { once: true },
        );
        await nestedRelease.promise;
        events.push("nested:done");
        return jsonResult({ winner: "nested" });
      },
    );
    const fast = pluginToolWithExecute(
      "fake_nested_race_fast",
      "Fast nested race helper",
      async () => {
        await nestedStarted.promise;
        events.push("fast:win");
        return jsonResult({ winner: "fast" });
      },
    );
    const release = pluginToolWithExecute(
      "fake_nested_race_release",
      "Release nested race helper",
      async () => {
        events.push("nested:release");
        nestedRelease.resolve();
        return jsonResult({ released: true });
      },
    );
    applyCodeModeCatalog({
      tools: [...codeModeTools, never, fast, release],
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
          code: `const value = await Promise.race([
              Promise.all([fake_nested_race_never({})]),
              fake_nested_race_fast({}),
            ]);
            void fake_nested_race_release({});
            return value;`,
        },
      ),
    );

    expect(details).toMatchObject({ status: "completed", value: { winner: "fast" } });
    expect(never.execute).toHaveBeenCalledOnce();
    expect(fast.execute).toHaveBeenCalledOnce();
    expect(release.execute).toHaveBeenCalledOnce();
    expect(events).toEqual(["nested:start", "fast:win", "nested:release", "nested:done"]);
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
              const called = await fake_create_ticket({ value: index });
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

  it("yields nested exec before the Code Mode deadline when continuation args are omitted", async () => {
    const catalogRef = createToolSearchCatalogRef();
    const config = {
      tools: { codeMode: { enabled: true, timeoutMs: 10_000 } },
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
    const shell = pluginToolWithExecute("exec", "Run shell", async (_toolCallId, input) =>
      jsonResult(input),
    );
    shell.parameters = Type.Object({
      command: Type.String(),
      yieldMs: Type.Optional(Type.Number()),
      background: Type.Optional(Type.Boolean()),
    });
    applyCodeModeCatalog({
      tools: [...codeModeTools, shell],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    });

    const details = resultDetails(
      await expectDefined(codeModeTools[0], "Code Mode exec test invariant").execute(
        "code-call-shell-yield",
        {
          code: `return [
            await exec({ command: "default" }),
            await exec({ command: "explicit", yieldMs: 4_000 }),
            await exec({ command: "background", background: true }),
          ];`,
        },
      ),
    );

    expect(details).toMatchObject({
      status: "completed",
      value: [
        { command: "default", yieldMs: 1_000 },
        { command: "explicit", yieldMs: 4_000 },
        { command: "background", background: true },
      ],
    });
    expect(testing.activeRuns.size).toBe(0);
  });

  it("bounds nested exec yield by the shared remaining deadline", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const catalogRef = createToolSearchCatalogRef();
    const config = {
      tools: { codeMode: { enabled: true, timeoutMs: 10_000 } },
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
    const consumeBudget = pluginToolWithExecute(
      "fake_consume_budget",
      "Consume most of the shared Code Mode deadline",
      async () => {
        vi.advanceTimersByTime(9_600);
        return jsonResult({ consumed: true });
      },
    );
    const shell = pluginToolWithExecute("exec", "Run shell", async (_toolCallId, input) =>
      jsonResult(input),
    );
    shell.parameters = Type.Object({
      command: Type.String(),
      yieldMs: Type.Optional(Type.Number()),
      background: Type.Optional(Type.Boolean()),
    });
    applyCodeModeCatalog({
      tools: [...codeModeTools, consumeBudget, shell],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    });

    const details = resultDetails(
      await expectDefined(codeModeTools[0], "Code Mode exec test invariant").execute(
        "code-call-late-shell-yield",
        {
          code: `
            await fake_consume_budget({});
            return await exec({ command: "late" });
          `,
        },
      ),
    );

    expect(details).toMatchObject({
      status: "completed",
      value: { command: "late", yieldMs: 100 },
    });
    expect(consumeBudget.execute).toHaveBeenCalledOnce();
    expect(shell.execute).toHaveBeenCalledOnce();
    expect(testing.activeRuns.size).toBe(0);
  });

  it("supports a guest timer between an action and its observation", async () => {
    const catalogRef = createToolSearchCatalogRef();
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
    const input = pluginTool("fake_terminal_input", "Send terminal input");
    const read = pluginTool("fake_terminal_read", "Read terminal output");
    applyCodeModeCatalog({
      tools: [...codeModeTools, input, read],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    });

    const details = resultDetails(
      await expectDefined(codeModeTools[0], "codeModeTools[0] test invariant").execute(
        "code-call-timer-observation",
        {
          code: `
            const cancelled = setTimeout(() => { throw new Error("cancelled timer fired"); }, 30_000);
            await fake_terminal_input({ data: "status\\n" });
            clearTimeout(cancelled);
            await new Promise((resolve) => setTimeout(resolve, 5));
            return await fake_terminal_read({});
          `,
        },
      ),
    );

    expect(details, JSON.stringify(details)).toMatchObject({
      status: "completed",
      value: { name: "fake_terminal_read" },
    });
    expect(input.execute).toHaveBeenCalledOnce();
    expect(read.execute).toHaveBeenCalledOnce();
    expect(testing.activeRuns.size).toBe(0);
  });

  it("keeps the actual winner when the later-started nested tool settles first", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { config, catalogRef, tools: codeModeTools } = createCodeModeHarness();
    const events: string[] = [];
    const firstStarted = createDeferred();
    const firstRelease = createDeferred();
    let firstAborted = false;
    const first = pluginToolWithExecute(
      "fake_first",
      "Earlier slow helper",
      async (_toolCallId, _input, signal) => {
        events.push("first:start");
        firstStarted.resolve();
        signal?.addEventListener(
          "abort",
          () => {
            firstAborted = true;
            firstRelease.reject(new Error("aborted"));
          },
          { once: true },
        );
        await firstRelease.promise;
        events.push("first:done");
        return jsonResult({ winner: "first" });
      },
    );
    const second = pluginToolWithExecute("fake_second", "Later fast helper", async () => {
      await firstStarted.promise;
      events.push("second:win");
      return jsonResult({ winner: "second" });
    });
    const release = pluginToolWithExecute(
      "fake_first_release",
      "Release earlier race helper",
      async () => {
        events.push("first:release");
        firstRelease.resolve();
        return jsonResult({ released: true });
      },
    );
    applyCodeModeCatalog({
      tools: [...codeModeTools, first, second, release],
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
          code: `const value = await Promise.race([
              fake_first({}),
              fake_second({}),
            ]);
            void fake_first_release({});
            return value;`,
        },
      ),
    );

    expect(details).toMatchObject({ status: "completed", value: { winner: "second" } });
    expect(first.execute).toHaveBeenCalledOnce();
    expect(second.execute).toHaveBeenCalledOnce();
    expect(release.execute).toHaveBeenCalledOnce();
    expect(events).toEqual(["first:start", "second:win", "first:release", "first:done"]);
    expect(firstAborted).toBe(false);
    expect(testing.activeRuns.size).toBe(0);
  });

  it.each([
    {
      label: "directly",
      auditCode: "void fake_early_audit({});",
    },
    {
      label: "in a detached already-settled Promise.race",
      auditCode: "void Promise.race([fake_early_audit({}), Promise.resolve()]);",
    },
    {
      label: "in a detached Promise.all",
      auditCode: "void Promise.all([fake_early_audit({})]);",
    },
    {
      label: "in a detached Promise.allSettled",
      auditCode: "void Promise.allSettled([fake_early_audit({})]);",
    },
    {
      label: "in a detached Promise.any",
      auditCode: "void Promise.any([fake_early_audit({})]);",
    },
    {
      label: "in a detached Promise.race",
      auditCode: "void Promise.race([fake_early_audit({})]);",
    },
  ])(
    "drains a detached audit started $label before an awaited nested call",
    async ({ auditCode }) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      const { config, catalogRef, tools: codeModeTools } = createCodeModeHarness();
      const events: string[] = [];
      let auditCompleted = false;
      let auditAborted = false;
      const auditStarted = createDeferred();
      const auditRelease = createDeferred();
      const audit = pluginToolWithExecute(
        "fake_early_audit",
        "Early detached audit",
        async (_toolCallId, _input, signal) => {
          events.push("audit:start");
          auditStarted.resolve();
          signal?.addEventListener(
            "abort",
            () => {
              auditAborted = true;
              auditRelease.reject(new Error("aborted"));
            },
            { once: true },
          );
          await auditRelease.promise;
          events.push("audit:done");
          auditCompleted = true;
          return jsonResult({ recorded: true });
        },
      );
      const fast = pluginToolWithExecute("fake_awaited_fast", "Awaited fast helper", async () => {
        await auditStarted.promise;
        events.push("awaited:done");
        return jsonResult({ winner: "fast" });
      });
      const release = pluginToolWithExecute(
        "fake_early_audit_release",
        "Release early detached audit",
        async () => {
          events.push("audit:release");
          auditRelease.resolve();
          return jsonResult({ released: true });
        },
      );
      applyCodeModeCatalog({
        tools: [...codeModeTools, audit, fast, release],
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
            const value = await fake_awaited_fast({});
            void fake_early_audit_release({});
            return value;`,
          },
        ),
      );

      expect(details).toMatchObject({ status: "completed", value: { winner: "fast" } });
      expect(audit.execute).toHaveBeenCalledOnce();
      expect(fast.execute).toHaveBeenCalledOnce();
      expect(release.execute).toHaveBeenCalledOnce();
      expect(events).toEqual(["audit:start", "awaited:done", "audit:release", "audit:done"]);
      expect(auditCompleted).toBe(true);
      expect(auditAborted).toBe(false);
      expect(testing.activeRuns.size).toBe(0);
    },
  );

  it("drains a race winner's detached audit and its slower race branch", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { config, catalogRef, tools: codeModeTools } = createCodeModeHarness();
    const events: string[] = [];
    const loserStarted = createDeferred();
    const loserRelease = createDeferred();
    const auditStarted = createDeferred();
    let loserAborted = false;
    const winner = pluginToolWithExecute("fake_race_winner", "Race winner", async () => {
      await loserStarted.promise;
      events.push("winner:win");
      return jsonResult({ winner: "fast" });
    });
    const loser = pluginToolWithExecute(
      "fake_race_loser",
      "Race loser",
      async (_toolCallId, _input, signal) => {
        events.push("loser:start");
        loserStarted.resolve();
        signal?.addEventListener(
          "abort",
          () => {
            loserAborted = true;
            loserRelease.reject(new Error("aborted"));
          },
          { once: true },
        );
        await loserRelease.promise;
        events.push("loser:done");
        return jsonResult({ winner: "slow" });
      },
    );
    const audit = pluginToolWithExecute("fake_race_audit", "Detached audit", async () => {
      events.push("audit:done");
      auditStarted.resolve();
      return jsonResult({ recorded: true });
    });
    const release = pluginToolWithExecute(
      "fake_race_loser_release",
      "Release race loser",
      async () => {
        await auditStarted.promise;
        events.push("loser:release");
        loserRelease.resolve();
        return jsonResult({ released: true });
      },
    );
    applyCodeModeCatalog({
      tools: [...codeModeTools, winner, loser, audit, release],
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
          code: `const value = await Promise.race([
              fake_race_winner({}),
              fake_race_loser({}),
            ]);
            void fake_race_audit({});
            void fake_race_loser_release({});
            return value;`,
        },
      ),
    );

    expect(details).toMatchObject({ status: "completed", value: { winner: "fast" } });
    expect(winner.execute).toHaveBeenCalledOnce();
    expect(loser.execute).toHaveBeenCalledOnce();
    expect(audit.execute).toHaveBeenCalledOnce();
    expect(release.execute).toHaveBeenCalledOnce();
    expect(events).toEqual([
      "loser:start",
      "winner:win",
      "audit:done",
      "loser:release",
      "loser:done",
    ]);
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
          code: `void fake_detached_first({});
            void fake_detached_second({});
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
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      const { config, catalogRef, tools: codeModeTools } = createCodeModeHarness();
      const events: string[] = [];
      const slowStarted = createDeferred();
      const slowRelease = createDeferred();
      let slowAborted = false;
      let slowCompleted = false;
      const fast = pluginToolWithExecute("fake_fast", "Fast helper", async () => {
        await slowStarted.promise;
        events.push("fast:win");
        return jsonResult({ winner: "fast" });
      });
      const slow = pluginToolWithExecute(
        "fake_slow",
        "Slow helper",
        async (_toolCallId, _input, signal) => {
          events.push("slow:start");
          slowStarted.resolve();
          signal?.addEventListener(
            "abort",
            () => {
              slowAborted = true;
              slowRelease.reject(new Error("aborted"));
            },
            { once: true },
          );
          await slowRelease.promise;
          events.push("slow:done");
          slowCompleted = true;
          return jsonResult({ winner: "slow" });
        },
      );
      const release = pluginToolWithExecute(
        "fake_slow_release",
        "Release slow helper",
        async () => {
          events.push("slow:release");
          slowRelease.resolve();
          return jsonResult({ released: true });
        },
      );
      applyCodeModeCatalog({
        tools: [...codeModeTools, fast, slow, release],
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
            code: `const value = await Promise.${combinator}([
                fake_slow({}),
                fake_fast({}),
              ]);
              void fake_slow_release({});
              return value;`,
          },
        ),
      );

      expect(details).toMatchObject({ status: "completed", value: { winner: "fast" } });
      expect(fast.execute).toHaveBeenCalledOnce();
      expect(slow.execute).toHaveBeenCalledOnce();
      expect(release.execute).toHaveBeenCalledOnce();
      expect(events).toEqual(["slow:start", "fast:win", "slow:release", "slow:done"]);
      expect(slowCompleted).toBe(true);
      expect(slowAborted).toBe(false);
      expect(testing.activeRuns.size).toBe(0);
    },
  );

  it("preserves fail-fast Promise.all while draining the slower nested tool", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { config, catalogRef, tools: codeModeTools } = createCodeModeHarness();
    const events: string[] = [];
    const slowStarted = createDeferred();
    const slowRelease = createDeferred();
    let slowAborted = false;
    let slowCompleted = false;
    const failed = pluginToolWithExecute("fake_failed", "Failed helper", async () => {
      events.push("failed:wait");
      await slowStarted.promise;
      events.push("failed:reject");
      throw new Error("fast failure");
    });
    const slow = pluginToolWithExecute(
      "fake_slow",
      "Slow helper",
      async (_toolCallId, _input, signal) => {
        events.push("slow:start");
        slowStarted.resolve();
        signal?.addEventListener(
          "abort",
          () => {
            slowAborted = true;
            slowRelease.reject(new Error("aborted"));
          },
          { once: true },
        );
        await slowRelease.promise;
        events.push("slow:done");
        slowCompleted = true;
        return jsonResult({ winner: "slow" });
      },
    );
    const release = pluginToolWithExecute("fake_slow_release", "Release slow helper", async () => {
      events.push("slow:release");
      slowRelease.resolve();
      return jsonResult({ released: true });
    });
    applyCodeModeCatalog({
      tools: [...codeModeTools, failed, slow, release],
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
              fake_failed({}),
              fake_slow({}),
            ]);
            return "unexpected success";
          } catch (error) {
            void fake_slow_release({});
            return error.message;
          }`,
        },
      ),
    );

    expect(details).toMatchObject({ status: "completed", value: "fast failure" });
    expect(failed.execute).toHaveBeenCalledOnce();
    expect(slow.execute).toHaveBeenCalledOnce();
    expect(release.execute).toHaveBeenCalledOnce();
    expect(events).toEqual([
      "failed:wait",
      "slow:start",
      "failed:reject",
      "slow:release",
      "slow:done",
    ]);
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
            await fake_side_effect({});
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

  it("returns an actionable bounded result when a nested tool result exceeds the output budget", async () => {
    const catalogRef = createToolSearchCatalogRef();
    const config = {
      tools: { codeMode: { enabled: true, maxOutputBytes: 1_024 } },
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
    const oversizedSearch = pluginToolWithExecute(
      "fake_oversized_search",
      "Oversized search result",
      async () =>
        jsonResult({
          matches: [
            { path: "src/first.ts", line: 1, text: "first useful match" },
            { path: "src/large.ts", line: 2, text: "🦞".repeat(2_048) },
          ],
        }),
    );
    applyCodeModeCatalog({
      tools: [...codeModeTools, oversizedSearch],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    });

    const details = resultDetails(
      await expectDefined(codeModeTools[0], "Code Mode exec test invariant").execute(
        "code-call-oversized-search",
        {
          code: "return await fake_oversized_search({});",
        },
      ),
    );

    expect(details.status).toBe("completed");
    expect(oversizedSearch.execute).toHaveBeenCalledOnce();
    expect(details.value).toMatchObject({
      truncated: true,
      omittedBytes: expect.any(Number),
      guidance: expect.stringContaining("rerun with narrower args"),
      prefix: expect.stringContaining("first useful match"),
    });
    const outputBytes = Buffer.byteLength(JSON.stringify(details.output), "utf8");
    const valueBytes = Buffer.byteLength(JSON.stringify(details.value), "utf8");
    expect(outputBytes + valueBytes).toBeLessThanOrEqual(1_024);
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
        { code: "await fake_stuck({}); return 'done';" },
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
          const rows = await fake_policy_block({});
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
