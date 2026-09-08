/** Tests Code Mode wait, scope, and suspended runs. */

import { expectDefined } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runWithAgentToolExecutionContext } from "../../packages/agent-core/src/tool-execution-context.js";
import { createDeferred } from "../../test/helpers/promise.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import {
  createOperationalRunInstanceRef,
  getAdmittedRunDelegatedAuthority,
  prepareAgentRunAdmission,
} from "./admitted-run-context.js";
import * as worker from "./code-mode-worker.js";
import { applyCodeModeCatalog, createCodeModeTools } from "./code-mode.js";
import {
  resetCodeModeTestState,
  pluginTool,
  pluginToolWithExecute,
  resultDetails,
  createCodeModeHarness,
  testing,
} from "./code-mode.test-support.js";
import { clearToolSearchCatalog, createToolSearchCatalogRef } from "./tool-search.js";
import { jsonResult } from "./tools/common.js";
import {
  createAdmittedGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "./tools/gateway-caller-context.js";

function createTerminalBridgeHarness() {
  const harness = createCodeModeHarness();
  const config = { tools: { codeMode: { enabled: true, timeoutMs: 60_000 } } } as never;
  const ctx = { ...harness.ctx, config, runtimeConfig: config };
  return { ...harness, config, tools: createCodeModeTools(ctx) };
}

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

  it.each([
    { mode: "inline", outcome: "approve" },
    { mode: "yield", outcome: "approve" },
    { mode: "yield", outcome: "cancel" },
    { mode: "yield", outcome: "close" },
  ] as const)(
    "keeps $mode nested approval paused until $outcome without extending its budget",
    async ({ mode, outcome }) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
      const runId = "run-code-mode-inline-approval";
      const sessionId = "session-inline-approval";
      const sessionKey = "agent:main:inline-approval";
      const callAbort = new AbortController();
      const requested = createDeferred();
      const decision = createDeferred();
      const resumed = createDeferred();
      const runWorker = worker.runCodeModeWorker;
      const continuationBudgets: number[] = [];
      let restoreCharged = false;
      const workerSpy = vi
        .spyOn(worker, "runCodeModeWorker")
        .mockImplementation(async (...args) => {
          const inlineHost = args[4];
          if (!inlineHost) {
            return await runWorker(...args);
          }
          const isResume = isRecord(args[0]) && args[0].kind === "resume";
          return await runWorker(args[0], args[1], args[2], args[3], {
            ...inlineHost,
            onBoundary: async (...boundaryArgs) => {
              if (mode === "yield" && isResume && !restoreCharged) {
                // Charge active restore/guest time before entering the blocked host wait.
                restoreCharged = true;
                await vi.advanceTimersByTimeAsync(100);
                resumed.resolve();
              }
              const command = await inlineHost.onBoundary(...boundaryArgs);
              if (command.kind === "continue") {
                continuationBudgets.push(command.timeoutMs);
              }
              return command;
            },
          });
        });
      const admission = prepareAgentRunAdmission({
        cfg: {},
        facts: {
          runId,
          agentId: "main",
          ingress: { kind: "system", boundary: "code-mode-approval", state: "present" },
        },
        operationalRunInstance: createOperationalRunInstanceRef(runId),
      });
      const admittedRunContext = await admission.admit("embedded");
      const identity = createAdmittedGatewayToolCallerIdentity({
        admittedRunContext,
        agentId: "main",
        sessionKey,
        turnSourceChannel: "telegram",
      });
      const timeoutMs = 1_000;
      const config = { tools: { codeMode: { enabled: true, timeoutMs } } } as never;
      const catalogRef = createToolSearchCatalogRef();
      const context = { config, runtimeConfig: config, sessionId, sessionKey, runId, catalogRef };
      const controls = createCodeModeTools(context);
      const shell = pluginToolWithExecute("exec", "Run shell", async (toolCallId) => {
        const event = { runId, sessionId, stream: "lifecycle" as const };
        emitAgentEvent({
          ...event,
          data: { phase: "waiting-approval", approvalId: "approval-inline", toolCallId },
        });
        requested.resolve();
        await decision.promise;
        emitAgentEvent({
          ...event,
          data: { phase: "approval-resolved", approvalId: "approval-inline", toolCallId },
        });
        return jsonResult({ status: "completed", aggregated: "approved" });
      });
      applyCodeModeCatalog({ tools: [...controls, shell], ...context });

      let settled = false;
      try {
        const execution = withGatewayToolCallerIdentity(identity, async () => {
          let result = await expectDefined(controls[0], "Code Mode exec test invariant").execute(
            "inline-approval",
            {
              code:
                mode === "inline"
                  ? `return await exec({ value: "approval" });`
                  : `const pending = exec({ value: "approval" }); await yield_control(); return await pending;`,
            },
          );
          if (mode === "yield") {
            expect(resultDetails(result)).toMatchObject({ status: "waiting" });
            // Force the approval event to precede the next wait subscription.
            await requested.promise;
            // Parked approval time must not be credited to this next call.
            await vi.advanceTimersByTimeAsync(5_000);
            result = await expectDefined(controls[1], "Code Mode wait test invariant").execute(
              "yielded-approval",
              { runId: resultDetails(result).runId },
              callAbort.signal,
            );
          }
          settled = true;
          return result;
        });
        await requested.promise;
        // The real restore runs outside the fake host clock. Wait until it has
        // returned before advancing the pending-bridge deadline.
        if (mode === "yield") {
          await resumed.promise;
        }
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(timeoutMs + 1);

        expect(settled).toBe(false);
        expect(getAdmittedRunDelegatedAuthority(admittedRunContext)).toBeDefined();

        if (outcome === "cancel") {
          callAbort.abort();
        } else if (outcome === "close") {
          clearToolSearchCatalog(context);
        } else {
          decision.resolve();
        }
        expect(resultDetails(await execution)).toMatchObject(
          outcome === "approve"
            ? { status: "completed", value: { status: "completed", aggregated: "approved" } }
            : { status: "failed", code: "aborted" },
        );
        expect(testing.activeRuns.size).toBe(0);
        expect(getAdmittedRunDelegatedAuthority(admittedRunContext)).toBeDefined();
        if (outcome === "approve") {
          expect(continuationBudgets).toContain(mode === "yield" ? timeoutMs - 100 : timeoutMs);
        }
      } finally {
        decision.resolve();
        workerSpy.mockRestore();
        admission.close();
      }
      expect(getAdmittedRunDelegatedAuthority(admittedRunContext)).toBeUndefined();
    },
  );

  it("retains terminal bridge evidence until a yielded run completes through wait", async () => {
    const { config, catalogRef, tools } = createTerminalBridgeHarness();
    const terminal = pluginToolWithExecute("terminal_action", "Terminal action", async () => ({
      ...jsonResult({ terminal: true }),
      terminate: true,
    }));
    applyCodeModeCatalog({
      tools: [...tools, terminal],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    });

    const suspended = await expectDefined(tools[0], "exec tool").execute(
      "code-call-terminal-yield",
      {
        code: `
          await terminal_action({});
          await yield_control("pause");
          return "done";
        `,
      },
    );

    expect(resultDetails(suspended).status).toBe("waiting");
    expect(suspended.terminate).toBeUndefined();

    let resumed = await expectDefined(tools[1], "wait tool").execute("code-wait-terminal-yield", {
      runId: resultDetails(suspended).runId,
    });
    for (let index = 1; index < 8 && resultDetails(resumed).status === "waiting"; index += 1) {
      expect(resumed.terminate).toBeUndefined();
      resumed = await expectDefined(tools[1], "wait tool").execute(
        `code-wait-terminal-yield-${index}`,
        { runId: resultDetails(resumed).runId },
      );
    }

    expect(resultDetails(resumed)).toMatchObject({ status: "completed", value: "done" });
    expect(resumed.terminate).toBe(true);
  });

  it("preserves retained terminal bridge evidence when a yielded run fails", async () => {
    const { config, catalogRef, tools } = createTerminalBridgeHarness();
    const terminal = pluginToolWithExecute("terminal_action", "Terminal action", async () => ({
      ...jsonResult({ terminal: true }),
      terminate: true,
    }));
    applyCodeModeCatalog({
      tools: [...tools, terminal],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    });

    const suspended = await expectDefined(tools[0], "exec tool").execute(
      "code-call-terminal-yield-failure",
      {
        code: `
          await terminal_action({});
          await yield_control("pause");
          throw new Error("resumed failure");
        `,
      },
    );

    expect(resultDetails(suspended).status).toBe("waiting");
    expect(suspended.terminate).toBeUndefined();

    let resumed = await expectDefined(tools[1], "wait tool").execute(
      "code-wait-terminal-yield-failure",
      { runId: resultDetails(suspended).runId },
    );
    for (let index = 1; index < 8 && resultDetails(resumed).status === "waiting"; index += 1) {
      expect(resumed.terminate).toBeUndefined();
      resumed = await expectDefined(tools[1], "wait tool").execute(
        `code-wait-terminal-yield-failure-${index}`,
        { runId: resultDetails(resumed).runId },
      );
    }

    expect(resultDetails(resumed)).toMatchObject({
      status: "failed",
      error: expect.stringContaining("resumed failure"),
    });
    expect(resumed.terminate).toBe(true);
  });

  it("keeps a safe suspension clean and wraps network content after wait resumes it", async () => {
    const { config, catalogRef, tools } = createCodeModeHarness();
    const hostile = "Page instruction <|endoftext|>";
    const target = pluginToolWithExecute("fake_network_page", "Read a network page", async () => ({
      content: [{ type: "text", text: "Protected page content" }],
      details: { body: hostile },
    }));
    target.resultContentSource = "network";
    applyCodeModeCatalog({
      tools: [...tools, target],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    });

    const suspended = await expectDefined(tools[0], "exec tool").execute("code-call-late-network", {
      code: 'await yield_control("pause"); return await fake_network_page({});',
    });
    expect(resultDetails(suspended).status).toBe("waiting");
    expect(suspended.content[0]).not.toMatchObject({
      text: expect.stringContaining("EXTERNAL_UNTRUSTED_CONTENT"),
    });

    let resumed = await expectDefined(tools[1], "wait tool").execute("code-wait-late-network-0", {
      runId: resultDetails(suspended).runId,
    });
    for (let index = 1; index < 8 && resultDetails(resumed).status === "waiting"; index += 1) {
      resumed = await expectDefined(tools[1], "wait tool").execute(
        `code-wait-late-network-${index}`,
        { runId: resultDetails(resumed).runId },
      );
    }

    expect(resultDetails(resumed)).toMatchObject({ status: "completed", value: { body: hostile } });
    expect(resumed.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("EXTERNAL_UNTRUSTED_CONTENT"),
    });
    expect(resumed.content[0]).not.toMatchObject({
      text: expect.stringContaining("<|endoftext|>"),
    });
  });

  it("wraps uncaught network tool errors after a safe wait suspension", async () => {
    const { config, catalogRef, tools } = createCodeModeHarness();
    const hostile = "Suspended page instruction <|endoftext|>";
    const target = pluginToolWithExecute("fake_network_error", "Read a failing page", async () => {
      throw new Error(hostile);
    });
    target.resultContentSource = "network";
    applyCodeModeCatalog({
      tools: [...tools, target],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    });

    const suspended = await expectDefined(tools[0], "exec tool").execute(
      "code-call-suspended-network-error",
      { code: 'await yield_control("pause"); return await fake_network_error({});' },
    );
    expect(resultDetails(suspended).status).toBe("waiting");
    expect(suspended.content[0]).not.toMatchObject({
      text: expect.stringContaining("EXTERNAL_UNTRUSTED_CONTENT"),
    });

    let resumed = await expectDefined(tools[1], "wait tool").execute("code-wait-network-error-0", {
      runId: resultDetails(suspended).runId,
    });
    for (let index = 1; index < 8 && resultDetails(resumed).status === "waiting"; index += 1) {
      resumed = await expectDefined(tools[1], "wait tool").execute(
        `code-wait-network-error-${index}`,
        { runId: resultDetails(resumed).runId },
      );
    }

    expect(resultDetails(resumed)).toMatchObject({
      status: "failed",
      error: expect.stringContaining(hostile),
    });
    expect(resumed.content[0]).toMatchObject({
      text: expect.stringContaining("SECURITY NOTICE:"),
    });
    expect(resumed.content[0]).not.toMatchObject({
      text: expect.stringContaining("<|endoftext|>"),
    });
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
          code: 'await yield_control("pause"); return await fake_resumed_identity({});',
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

  it.each(["exec", "wait"])(
    "preserves accepted output when %s snapshot expiry would exceed the Date range",
    async (mode) => {
      const { ctx } = createCodeModeHarness();
      const config = { tools: { codeMode: { enabled: true, snapshotTtlSeconds: 1 } } };
      const tools = createCodeModeTools({ ...ctx, config, runtimeConfig: config });
      const fixture = pluginTool("expiry_fixture", "Expiry fixture");
      applyCodeModeCatalog({ ...ctx, config, tools: [...tools, fixture] });
      const exec = expectDefined(tools[0], "exec");
      const wait = expectDefined(tools[1], "wait");
      const dateLimit = 8_640_000_000_000_000;
      const nowSpy = vi.spyOn(Date, "now").mockReturnValue(dateLimit - 1_000);
      let details: Record<string, unknown>;
      try {
        const input = {
          code: `${mode === "wait" ? 'text("delivered"); await yield_control();' : ""}
            text("accepted first");
            await expiry_fixture({});
            text("accepted inline");
            await yield_control("pause");
            return "done";`,
        };
        const first =
          mode === "wait" ? resultDetails(await exec.execute("park", input)) : undefined;
        if (first) {
          expect(first).toMatchObject({
            status: "waiting",
            output: [{ type: "text", text: "delivered" }],
          });
        }
        // Admit wait before the parked run expires. Renewal overflows without
        // consuming the new call's execution budget before its guest resumes.
        nowSpy.mockReturnValue(dateLimit - 1);
        details = resultDetails(
          await (first
            ? wait.execute("resume", { runId: first.runId })
            : exec.execute("code-call-yield-overflow", input)),
        );
      } finally {
        nowSpy.mockRestore();
      }

      expect(details.status).toBe("failed");
      expect(details.error).toBe("code mode run expiry is unavailable.");
      expect(details.output).toEqual([
        { type: "text", text: "accepted first" },
        { type: "text", text: "accepted inline" },
      ]);
      expect(fixture.execute).toHaveBeenCalledOnce();
      expect(testing.activeRuns.size).toBe(0);
    },
  );

  it("expires suspended runs with invalid expiry timestamps", async () => {
    const { tools: codeModeTools } = createCodeModeHarness();
    testing.activeRuns.set("invalid-expiry-run", {
      expiresAt: 8_640_000_000_000_001,
      owner: { close: () => undefined },
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

  describe("suspended-run owner scope", () => {
    const missingOwnerIdentities = ["runId", "sessionId", "sessionKey", "agentId"] as const;
    const rejectionMessages = new Map<(typeof missingOwnerIdentities)[number], string>();
    let rightfulResult: Record<string, unknown>;

    beforeAll(async () => {
      const { config, catalogRef, ctx } = createCodeModeHarness({
        agentId: "owner",
      });
      const codeModeTools = createCodeModeTools(ctx);
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

      for (const missingIdentity of missingOwnerIdentities) {
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
        try {
          await missingIdentityWait.execute("code-wait-missing-owner", { runId: suspended.runId });
          throw new Error("expected missing owner identity to reject");
        } catch (error) {
          rejectionMessages.set(missingIdentity, String(error));
        }
        expect(testing.activeRuns.has(suspended.runId as string)).toBe(true);
      }

      rightfulResult = resultDetails(
        await expectDefined(codeModeTools[1], "Owner Code Mode wait test invariant").execute(
          "code-wait-rightful-owner",
          { runId: suspended.runId },
        ),
      );
    });

    it.each(missingOwnerIdentities)(
      "rejects suspended-run callers missing the owner %s",
      (missingIdentity) => {
        expect(rejectionMessages.get(missingIdentity)).toContain(
          missingIdentity === "runId" ? "different agent run" : "different session",
        );
        expect(rightfulResult).toMatchObject({ status: "completed", value: "owner-secret" });
      },
    );
  });

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
          code: "await fake_slow({}); return 'done';",
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
});
