import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../shared/deferred.js";
import { finalizeAgentTools } from "./agent-tools.finalize.js";
import {
  createCodeModeActivityOwner,
  discardCodeModeRunActivity,
  registerCodeModeRunActivity,
  sampleCodeModeRunFinalQuiescence,
  type CodeModeActivityOwner,
} from "./code-mode-activity.js";
import type { SettledBridgeRequest } from "./code-mode-runtime.js";
import { CodeModeBridgeDispatchQueue } from "./code-mode-state.js";
import {
  applyCodeModeCatalog,
  createCodeModeTools,
  runCodeModeScriptHeadless,
} from "./code-mode.js";
import {
  pluginTool,
  pluginToolWithExecute,
  resetCodeModeTestState,
  resultDetails,
  testing,
} from "./code-mode.test-support.js";
import {
  createToolSearchCatalogRef,
  registerHeadlessToolSearchCatalog,
  type ToolSearchToolContext,
} from "./tool-search.js";
import { jsonResult, type AnyAgentTool } from "./tools/common.js";

function headlessTool(name: string, execute: AnyAgentTool["execute"]): AnyAgentTool {
  return {
    name,
    label: name,
    description: `Test tool ${name}`,
    parameters: { type: "object", properties: {} },
    execute: vi.fn(execute) as AnyAgentTool["execute"],
  };
}

function createHeadlessContext(tools: AnyAgentTool[]): ToolSearchToolContext {
  const config = {
    tools: { codeMode: { enabled: false, timeoutMs: 60_000 } },
  } as never;
  const catalogRef = createToolSearchCatalogRef();
  registerHeadlessToolSearchCatalog({ catalogRef, tools });
  return {
    config,
    runtimeConfig: config,
    agentId: "main",
    catalogRef,
  };
}

let activityOwner: CodeModeActivityOwner;

beforeEach(() => {
  activityOwner = createCodeModeActivityOwner();
});

afterEach(() => {
  resetCodeModeTestState();
  discardCodeModeRunActivity(activityOwner);
});

describe("Code Mode cancellation ownership", () => {
  it("does not resume an aborted guest when an active tool ignores cancellation", async () => {
    registerCodeModeRunActivity(activityOwner);
    const catalogRef = createToolSearchCatalogRef();
    const config = {
      tools: { codeMode: { enabled: true, maxPendingToolCalls: 1, timeoutMs: 30_000 } },
    } as never;
    const ctx = {
      config,
      runtimeConfig: config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      codeModeActivityOwner: activityOwner,
      catalogRef,
    };
    const codeModeTools = createCodeModeTools(ctx);
    const controller = new AbortController();
    const activeStarted = createDeferred();
    const activeCompletion = createDeferred();
    const activeFinished = createDeferred();
    let activeSawAbort = false;
    const activeTool = expectDefined(
      finalizeAgentTools({
        tools: [
          pluginToolWithExecute(
            "fake_ignore_cancel",
            "Cancellation-ignoring helper",
            async (_toolCallId, _input, signal) => {
              activeStarted.resolve();
              signal?.addEventListener("abort", () => {
                activeSawAbort = true;
              });
              await activeCompletion.promise;
              activeFinished.resolve();
              return jsonResult({ late: true });
            },
          ),
        ],
        hookContext: {},
        abortSignal: controller.signal,
      })[0],
      "finalized cancellation test tool",
    );
    const queuedTool = pluginTool("fake_queued_after_ignore", "Queued cancellation helper");
    const lateGuestTool = pluginTool("fake_guest_after_abort", "Late guest helper");
    applyCodeModeCatalog({
      tools: [...codeModeTools, activeTool, queuedTool, lateGuestTool],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    });

    const resultPromise = expectDefined(codeModeTools[0], "Code Mode exec test invariant").execute(
      "code-call-ignore-cancel",
      {
        code: `
          await Promise.all([
            tools.callValue("fake_ignore_cancel", {}),
            tools.callValue("fake_queued_after_ignore", {}),
          ]);
          return await tools.callValue("fake_guest_after_abort", {});
        `,
      },
      controller.signal,
    );
    await activeStarted.promise;
    controller.abort();
    const details = resultDetails(await resultPromise);

    expect(details).toMatchObject({
      status: "failed",
      code: "aborted",
      error: "code mode execution aborted",
    });
    expect(activeSawAbort).toBe(true);
    expect(queuedTool.execute).not.toHaveBeenCalled();
    expect(lateGuestTool.execute).not.toHaveBeenCalled();
    expect(sampleCodeModeRunFinalQuiescence(activityOwner)).toBe("non_quiescent");

    activeCompletion.resolve();
    await activeFinished.promise;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });

    expect(queuedTool.execute).not.toHaveBeenCalled();
    expect(lateGuestTool.execute).not.toHaveBeenCalled();
    expect(testing.activeRuns.size).toBe(0);
    expect(sampleCodeModeRunFinalQuiescence(activityOwner)).toBe("quiescent");
  });

  it("does not resume an aborted headless guest when an active tool ignores cancellation", async () => {
    registerCodeModeRunActivity(activityOwner);
    const activeStarted = createDeferred();
    const activeCompletion = createDeferred();
    const activeFinished = createDeferred();
    let activeSawAbort = false;
    const activeTool = headlessTool(
      "headless_ignore_cancel",
      async (_toolCallId, _input, signal) => {
        activeStarted.resolve();
        signal?.addEventListener("abort", () => {
          activeSawAbort = true;
        });
        await activeCompletion.promise;
        activeFinished.resolve();
        return jsonResult({ late: true });
      },
    );
    const queuedTool = headlessTool("headless_queued_after_ignore", async () =>
      jsonResult({ unexpected: true }),
    );
    const lateGuestTool = headlessTool("headless_guest_after_abort", async () =>
      jsonResult({ unexpected: true }),
    );
    const controller = new AbortController();
    const resultPromise = runCodeModeScriptHeadless({
      ctx: {
        ...createHeadlessContext([activeTool, queuedTool, lateGuestTool]),
        codeModeActivityOwner: activityOwner,
      },
      code: `
        await Promise.all([
          tools.callValue("openclaw:core:headless_ignore_cancel", {}),
          tools.callValue("openclaw:core:headless_queued_after_ignore", {}),
        ]);
        return await tools.callValue("openclaw:core:headless_guest_after_abort", {});
      `,
      overrides: { maxPendingToolCalls: 1 },
      wallClockMs: 30_000,
      signal: controller.signal,
    });
    await Promise.race([
      activeStarted.promise,
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("headless active tool did not start")), 5_000);
      }),
    ]);
    controller.abort();
    const result = await Promise.race([
      resultPromise,
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("headless cancellation did not settle visibly")), 5_000);
      }),
    ]);

    expect(result).toMatchObject({
      status: "failed",
      code: "aborted",
      error: "code mode execution aborted",
    });
    expect(activeSawAbort).toBe(true);
    expect(queuedTool.execute).not.toHaveBeenCalled();
    expect(lateGuestTool.execute).not.toHaveBeenCalled();
    expect(sampleCodeModeRunFinalQuiescence(activityOwner)).toBe("non_quiescent");

    activeCompletion.resolve();
    await activeFinished.promise;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });

    expect(queuedTool.execute).not.toHaveBeenCalled();
    expect(lateGuestTool.execute).not.toHaveBeenCalled();
    expect(testing.activeRuns.size).toBe(0);
    expect(sampleCodeModeRunFinalQuiescence(activityOwner)).toBe("quiescent");
  });

  it("retains an active slot until a cancelled tool really settles", async () => {
    const queue = new CodeModeBridgeDispatchQueue(1);
    const firstCompletion = createDeferred<SettledBridgeRequest>();
    const cancelActive = vi.fn();
    const first = queue.enqueue({
      id: "bridge:call:1",
      method: "callValue",
      start: () => firstCompletion.promise,
      cancelActive,
    });
    const secondStart = vi.fn(
      async (): Promise<SettledBridgeRequest> => ({
        id: "bridge:call:2",
        ok: true,
        value: "second",
      }),
    );
    const second = queue.enqueue({
      id: "bridge:call:2",
      method: "callValue",
      start: secondStart,
      cancelActive: vi.fn(),
    });

    first.cancel();
    expect(cancelActive).toHaveBeenCalledOnce();
    expect(secondStart).not.toHaveBeenCalled();
    await expect(first.promise).resolves.toEqual({
      id: "bridge:call:1",
      ok: false,
      error: "code mode bridge call cancelled",
    });
    expect(secondStart).not.toHaveBeenCalled();

    firstCompletion.resolve({ id: "bridge:call:1", ok: true, value: "late success" });

    await expect(second.promise).resolves.toEqual({
      id: "bridge:call:2",
      ok: true,
      value: "second",
    });
    expect(secondStart).toHaveBeenCalledOnce();
  });
});
