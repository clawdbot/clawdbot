/** Tests Code Mode wait, scope, and suspended runs. */

import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runWithAgentToolExecutionContext } from "../../packages/agent-core/src/tool-execution-context.js";
import { applyCodeModeCatalog, createCodeModeTools } from "./code-mode.js";
import {
  resetCodeModeTestState,
  pluginTool,
  pluginToolWithExecute,
  resultDetails,
  createCodeModeHarness,
  testing,
} from "./code-mode.test-support.js";
import { createToolSearchCatalogRef } from "./tool-search.js";

describe("Code Mode wait, scope, and suspended runs", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetCodeModeTestState();
  });

  it("marks yield suspensions and resumes the snapshot with wait", async () => {
    const { config, catalogRef, tools: codeModeTools } = createCodeModeHarness();
    applyCodeModeCatalog({
      tools: [...codeModeTools, pluginTool("fake_noop", "Noop")],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    });

    const first = resultDetails(
      await expectDefined(codeModeTools[0], "codeModeTools[0] test invariant").execute(
        "code-call-yield",
        {
          restartSafe: true,
          code: `
          text("before");
          await yield_control("pause");
          text("after");
          return "done";
        `,
        },
      ),
    );

    expect(first.status).toBe("waiting");
    expect(first.reason).toBe("yield");
    expect(first.replaySafe).toBe(true);
    expect(first.output).toEqual([{ type: "text", text: "before" }]);

    const runId = first.runId;
    expect(typeof runId).toBe("string");
    const resumed = resultDetails(
      await expectDefined(codeModeTools[1], "codeModeTools[1] test invariant").execute(
        "code-wait-yield",
        { runId },
      ),
    );

    expect(resumed.status).toBe("completed");
    expect(resumed.value).toBe("done");
    expect(resumed.output).toEqual([{ type: "text", text: "after" }]);
  });

  it("delivers each yielded output block exactly once across repeated waits", async () => {
    const { config, catalogRef, tools: codeModeTools } = createCodeModeHarness();
    applyCodeModeCatalog({
      tools: [...codeModeTools, pluginTool("fake_noop", "Noop")],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    });

    const execTool = expectDefined(codeModeTools[0], "Code Mode exec test invariant");
    const waitTool = expectDefined(codeModeTools[1], "Code Mode wait test invariant");
    const first = resultDetails(
      await execTool.execute("code-call-incremental-output", {
        code: `
          text("phase 1");
          await yield_control("first pause");
          text("phase 2");
          await yield_control("second pause");
          text("phase 3");
          return "done";
        `,
      }),
    );

    expect(first.status).toBe("waiting");
    expect(first.output).toEqual([{ type: "text", text: "phase 1" }]);

    const second = resultDetails(
      await waitTool.execute("code-wait-incremental-output-1", { runId: first.runId }),
    );

    expect(second.status).toBe("waiting");
    expect(second.output).toEqual([{ type: "text", text: "phase 2" }]);

    const third = resultDetails(
      await waitTool.execute("code-wait-incremental-output-2", { runId: second.runId }),
    );

    expect(third.status).toBe("completed");
    expect(third.value).toBe("done");
    expect(third.output).toEqual([{ type: "text", text: "phase 3" }]);
  });

  it("returns only newly emitted output when a resumed guest fails", async () => {
    const { config, catalogRef, tools: codeModeTools } = createCodeModeHarness();
    applyCodeModeCatalog({
      tools: [...codeModeTools, pluginTool("fake_noop", "Noop")],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    });

    const first = resultDetails(
      await expectDefined(codeModeTools[0], "Code Mode exec test invariant").execute(
        "code-call-incremental-failure",
        {
          code: `
            text("before pause");
            await yield_control("pause");
            text("before failure");
            throw new Error("resumed failure");
          `,
        },
      ),
    );

    expect(first.status).toBe("waiting");
    expect(first.output).toEqual([{ type: "text", text: "before pause" }]);

    const second = resultDetails(
      await expectDefined(codeModeTools[1], "Code Mode wait test invariant").execute(
        "code-wait-incremental-failure",
        { runId: first.runId },
      ),
    );

    expect(second.status).toBe("failed");
    expect(second.error).toContain("resumed failure");
    expect(second.output).toEqual([{ type: "text", text: "before failure" }]);
    expect(testing.activeRuns.has(first.runId as string)).toBe(false);
  });

  it("preserves the original exec identity for tool calls after yield and wait", async () => {
    const { config, catalogRef, tools: codeModeTools } = createCodeModeHarness();
    const target = pluginTool("fake_resumed_identity", "Resumed identity helper");
    applyCodeModeCatalog({
      tools: [...codeModeTools, target],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    });

    const suspended = resultDetails(
      await expectDefined(codeModeTools[0], "Code Mode exec test invariant").execute(
        "code-call-original-parent",
        {
          code: 'await yield_control("pause"); return await tools.callValue("fake_resumed_identity", {});',
        },
      ),
    );
    expect(suspended.status).toBe("waiting");

    const resumed = resultDetails(
      await expectDefined(codeModeTools[1], "Code Mode wait test invariant").execute(
        "code-wait-different-parent",
        { runId: suspended.runId },
      ),
    );

    expect(resumed.status).toBe("completed");
    expect(target.execute).toHaveBeenCalledOnce();
    expect(vi.mocked(target.execute).mock.calls[0]?.[0]).toContain("code-call-original-parent");
    expect(vi.mocked(target.execute).mock.calls[0]?.[0]).not.toContain(
      "code-wait-different-parent",
    );
  });

  it("allocates distinct replay identities when a later turn reuses a tool-call id", async () => {
    const { config, catalogRef, tools: codeModeTools } = createCodeModeHarness();
    applyCodeModeCatalog({
      tools: [...codeModeTools, pluginTool("fake_noop", "Noop")],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    });
    const execTool = expectDefined(codeModeTools[0], "codeModeTools[0] test invariant");
    const input = { code: 'await yield_control("pause"); return "done";' };
    const executionContext = (turnId: string) =>
      ({
        assistantMessage: { responseId: " ", turnId },
        toolCall: { type: "toolCall", id: "reused-call-id", name: "exec", arguments: input },
      }) as never;

    const first = resultDetails(
      await runWithAgentToolExecutionContext(executionContext("response-turn-1"), () =>
        execTool.execute("reused-call-id", input),
      ),
    );
    const second = resultDetails(
      await runWithAgentToolExecutionContext(executionContext("response-turn-2"), () =>
        execTool.execute("reused-call-id", input),
      ),
    );

    expect(first.status).toBe("waiting");
    expect(second.status).toBe("waiting");
    expect(second.runId).not.toBe(first.runId);
    expect(testing.activeRuns.size).toBe(2);
    expect(new Set([...testing.activeRuns.values()].map((state) => state.replayId)).size).toBe(2);
  });

  it("fails yield suspension when snapshot expiry would exceed the Date range", async () => {
    const { config, catalogRef, tools: codeModeTools } = createCodeModeHarness();
    applyCodeModeCatalog({
      tools: [...codeModeTools, pluginTool("fake_noop", "Noop")],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    });
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(8_640_000_000_000_000);
    let details: Record<string, unknown>;
    try {
      details = resultDetails(
        await expectDefined(codeModeTools[0], "codeModeTools[0] test invariant").execute(
          "code-call-yield-overflow",
          {
            code: 'await yield_control("pause"); return "done";',
          },
        ),
      );
    } finally {
      nowSpy.mockRestore();
    }

    expect(details.status).toBe("failed");
    expect(details.error).toBe("code mode run expiry is unavailable.");
    expect(testing.activeRuns.size).toBe(0);
  });

  it("expires suspended runs with invalid expiry timestamps", async () => {
    const { tools: codeModeTools } = createCodeModeHarness();
    testing.activeRuns.set("invalid-expiry-run", {
      expiresAt: 8_640_000_000_000_001,
    } as never);

    await expect(
      expectDefined(codeModeTools[1], "codeModeTools[1] test invariant").execute(
        "code-wait-invalid-expiry",
        { runId: "invalid-expiry-run" },
      ),
    ).rejects.toThrow("code mode run is unavailable or expired");
    expect(testing.activeRuns.has("invalid-expiry-run")).toBe(false);
  });

  it("rejects wait calls from a different session scope", async () => {
    const { config, catalogRef, tools: codeModeTools } = createCodeModeHarness();
    applyCodeModeCatalog({
      tools: [...codeModeTools, pluginTool("fake_noop", "Noop")],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    });

    const first = resultDetails(
      await expectDefined(codeModeTools[0], "codeModeTools[0] test invariant").execute(
        "code-call-wrong-session",
        {
          code: 'await yield_control("pause"); return "done";',
        },
      ),
    );
    expect(first.status).toBe("waiting");
    const otherWaitTool = expectDefined(
      createCodeModeTools({
        config,
        runtimeConfig: config,
        sessionId: "other-session",
        sessionKey: "agent:other:main",
        runId: "run-code-mode",
        catalogRef,
      })[1],
      'createCodeModeTools({ config, runtimeConfig: config, sessionId: "othe... test invariant',
    );

    await expect(
      otherWaitTool.execute("code-wait-wrong-session", { runId: first.runId }),
    ).rejects.toThrow("different session");
  });

  it.each(["runId", "sessionId", "sessionKey", "agentId"] as const)(
    "rejects suspended-run callers missing the owner %s",
    async (missingIdentity) => {
      const {
        config,
        catalogRef,
        ctx,
        tools: codeModeTools,
      } = createCodeModeHarness({
        agentId: "owner",
      });
      applyCodeModeCatalog({
        tools: [...codeModeTools, pluginTool("fake_noop", "Noop")],
        config,
        sessionId: ctx.sessionId,
        sessionKey: ctx.sessionKey,
        agentId: ctx.agentId,
        runId: ctx.runId,
        catalogRef,
      });

      const suspended = resultDetails(
        await expectDefined(codeModeTools[0], "Code Mode exec test invariant").execute(
          "code-call-scoped-owner",
          { code: 'await yield_control("pause"); return "owner-secret";' },
        ),
      );
      expect(suspended.status).toBe("waiting");

      const missingIdentityWait = expectDefined(
        createCodeModeTools({
          config,
          runtimeConfig: config,
          catalogRef,
          ...(missingIdentity === "runId" ? {} : { runId: ctx.runId }),
          ...(missingIdentity === "sessionId" ? {} : { sessionId: ctx.sessionId }),
          ...(missingIdentity === "sessionKey" ? {} : { sessionKey: ctx.sessionKey }),
          ...(missingIdentity === "agentId" ? {} : { agentId: ctx.agentId }),
        })[1],
        "Unscoped Code Mode wait test invariant",
      );

      await expect(
        missingIdentityWait.execute("code-wait-missing-owner", { runId: suspended.runId }),
      ).rejects.toThrow(missingIdentity === "runId" ? "different agent run" : "different session");
      expect(testing.activeRuns.has(suspended.runId as string)).toBe(true);

      const rightfulResult = resultDetails(
        await expectDefined(codeModeTools[1], "Owner Code Mode wait test invariant").execute(
          "code-wait-rightful-owner",
          { runId: suspended.runId },
        ),
      );
      expect(rightfulResult.status).toBe("completed");
      expect(rightfulResult.value).toBe("owner-secret");
    },
  );

  it("rejects concurrent waits for the same suspended run", async () => {
    const catalogRef = createToolSearchCatalogRef();
    const config = {
      tools: {
        codeMode: {
          enabled: true,
          timeoutMs: 500,
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
    const codeModeTools = createCodeModeTools(ctx);
    applyCodeModeCatalog({
      tools: [
        ...codeModeTools,
        pluginToolWithExecute(
          "fake_slow",
          "Slow helper",
          async () => await new Promise<never>(() => {}),
        ),
      ],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    });

    const first = resultDetails(
      await expectDefined(codeModeTools[0], "codeModeTools[0] test invariant").execute(
        "code-call-concurrent-wait",
        {
          code: "await tools.fake_slow({}); return 'done';",
        },
      ),
    );
    expect(first.status).toBe("waiting");

    const firstWait = expectDefined(codeModeTools[1], "codeModeTools[1] test invariant").execute(
      "code-wait-concurrent-a",
      {
        runId: first.runId,
      },
    );
    await expect(
      expectDefined(codeModeTools[1], "codeModeTools[1] test invariant").execute(
        "code-wait-concurrent-b",
        { runId: first.runId },
      ),
    ).rejects.toThrow("already being resumed");
    const stillWaiting = resultDetails(await firstWait);

    expect(stillWaiting.status).toBe("waiting");
    expect(stillWaiting.runId).toBe(first.runId);
  });

  it("resumes and reparks a yielding run at the suspended-run capacity limit", async () => {
    const { config, catalogRef, tools: codeModeTools } = createCodeModeHarness();
    applyCodeModeCatalog({
      tools: [...codeModeTools, pluginTool("fake_noop", "Noop")],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    });

    const first = resultDetails(
      await expectDefined(codeModeTools[0], "Code Mode exec test invariant").execute(
        "code-call-at-capacity",
        {
          code: `
            await yield_control("first");
            await yield_control("second");
            return "done";
          `,
        },
      ),
    );
    expect(first.status).toBe("waiting");
    const firstRunId = first.runId;
    expect(typeof firstRunId).toBe("string");
    if (typeof firstRunId !== "string") {
      throw new Error("expected a parked Code Mode run");
    }
    const parked = testing.activeRuns.get(firstRunId);
    expect(parked).toBeDefined();
    if (!parked) {
      throw new Error("expected a parked Code Mode snapshot");
    }

    // Inert snapshots occupy real capacity without starting 63 extra workers.
    for (let index = 0; index < 63; index += 1) {
      const runId = `cm_code_mode_capacity_${index}`;
      testing.activeRuns.set(runId, { ...parked, runId, pending: [] });
    }

    const second = resultDetails(
      await expectDefined(codeModeTools[1], "Code Mode wait test invariant").execute(
        "code-wait-at-capacity",
        { runId: firstRunId },
      ),
    );

    expect(second.status).toBe("waiting");
    expect(second.reason).toBe("yield");
    expect(testing.activeRuns.size).toBe(64);

    const completed = resultDetails(
      await expectDefined(codeModeTools[1], "Code Mode wait test invariant").execute(
        "code-wait-after-capacity",
        { runId: second.runId },
      ),
    );

    expect(completed).toMatchObject({ status: "completed", value: "done" });
    expect(testing.activeRuns.size).toBe(63);
  });

  it("reports only unsettled pending tool calls when wait times out", async () => {
    const catalogRef = createToolSearchCatalogRef();
    const config = {
      tools: {
        codeMode: {
          enabled: true,
          timeoutMs: 500,
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
    const codeModeTools = createCodeModeTools(ctx);
    applyCodeModeCatalog({
      tools: [
        ...codeModeTools,
        pluginTool("fake_fast", "Fast helper"),
        pluginToolWithExecute(
          "fake_slow",
          "Slow helper",
          async () => await new Promise<never>(() => {}),
        ),
      ],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    });

    const first = resultDetails(
      await expectDefined(codeModeTools[0], "codeModeTools[0] test invariant").execute(
        "code-call-timeout",
        {
          code: `
          text("before timeout");
          const fast = tools.fake_fast({});
          const slow = tools.fake_slow({});
          await fast;
          await slow;
          return "done";
        `,
        },
      ),
    );
    expect(first.status).toBe("waiting");
    expect(first.output).toEqual([{ type: "text", text: "before timeout" }]);
    expect(first.pendingToolCalls).toEqual([expect.objectContaining({ method: "callValue" })]);
    const runId = first.runId;
    expect(typeof runId).toBe("string");
    if (typeof runId !== "string") {
      throw new Error("expected code mode run id");
    }

    const activeRun = testing.activeRuns.get(runId);
    expect(activeRun).toBeDefined();
    activeRun!.config.timeoutMs = 100;

    const second = resultDetails(
      await expectDefined(codeModeTools[1], "codeModeTools[1] test invariant").execute(
        "code-wait-timeout",
        { runId },
      ),
    );

    expect(second.status).toBe("waiting");
    expect(second.output).toEqual([]);
    expect(second.pendingToolCalls).toEqual([expect.objectContaining({ method: "callValue" })]);

    const third = resultDetails(
      await expectDefined(codeModeTools[1], "codeModeTools[1] test invariant").execute(
        "code-wait-timeout-again",
        { runId },
      ),
    );

    expect(third.status).toBe("waiting");
    expect(third.output).toEqual([]);
    expect(third.pendingToolCalls).toEqual([expect.objectContaining({ method: "callValue" })]);
  });
});
