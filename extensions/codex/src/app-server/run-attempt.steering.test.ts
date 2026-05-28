import path from "node:path";
import { abortAgentHarnessRun } from "openclaw/plugin-sdk/agent-harness-runtime";
import { describe, expect, it, vi } from "vitest";
import { CODEX_GPT5_BEHAVIOR_CONTRACT } from "../../prompt-overlay.js";
import type { CodexServerNotification } from "./protocol.js";
import {
  createParams,
  createStartedThreadHarness,
  fastWait,
  queueActiveRunMessageForTest,
  runCodexAppServerAttempt,
  setCodexAppServerClientFactoryForTest,
  setupRunAttemptTestHooks,
  tempDir,
  threadStartResult,
  turnStartResult,
} from "./run-attempt-test-harness.js";

setupRunAttemptTestHooks();

describe("runCodexAppServerAttempt steering", () => {
  it("forwards queued user input and aborts the active app-server turn", async () => {
    const { requests, waitForMethod } = createStartedThreadHarness();

    const run = runCodexAppServerAttempt(
      createParams(path.join(tempDir, "session.jsonl"), path.join(tempDir, "workspace")),
      { pluginConfig: { appServer: { mode: "yolo" } } },
    );
    await waitForMethod("turn/start");

    expect(queueActiveRunMessageForTest("session-1", "more context", { debounceMs: 1 })).toBe(true);
    await vi.waitFor(() => expect(requests.map((entry) => entry.method)).toContain("turn/steer"), {
      interval: 1,
    });
    expect(abortAgentHarnessRun("session-1")).toBe(true);
    await vi.waitFor(
      () => expect(requests.map((entry) => entry.method)).toContain("turn/interrupt"),
      { interval: 1 },
    );

    const result = await run;
    expect(result.aborted).toBe(true);
    const threadStart = requests.find((entry) => entry.method === "thread/start");
    const threadStartParams = threadStart?.params as
      | {
          approvalPolicy?: string;
          approvalsReviewer?: string;
          developerInstructions?: string;
          model?: string;
          sandbox?: string;
        }
      | undefined;
    expect(threadStartParams?.model).toBe("gpt-5.4-codex");
    expect(threadStartParams?.approvalPolicy).toBe("never");
    expect(threadStartParams?.sandbox).toBe("danger-full-access");
    expect(threadStartParams?.approvalsReviewer).toBe("user");
    expect(threadStartParams?.developerInstructions).not.toContain(CODEX_GPT5_BEHAVIOR_CONTRACT);
    const steer = requests.find((entry) => entry.method === "turn/steer");
    expect(steer?.params).toEqual({
      threadId: "thread-1",
      expectedTurnId: "turn-1",
      input: [{ type: "text", text: "more context", text_elements: [] }],
    });
    const interrupt = requests.find((entry) => entry.method === "turn/interrupt");
    expect(interrupt?.params).toEqual({ threadId: "thread-1", turnId: "turn-1" });
  });

  it("accepts message-tool-only steering for active Codex app-server source replies", async () => {
    const { requests, waitForMethod, completeTurn } = createStartedThreadHarness();
    const params = createParams(
      path.join(tempDir, "session.jsonl"),
      path.join(tempDir, "workspace"),
    );
    params.sourceReplyDeliveryMode = "message_tool_only";

    const run = runCodexAppServerAttempt(params);
    await waitForMethod("turn/start");

    expect(
      queueActiveRunMessageForTest("session-1", "subagent complete", {
        debounceMs: 1,
        steeringMode: "all",
        sourceReplyDeliveryMode: "message_tool_only",
      }),
    ).toBe(true);

    await vi.waitFor(
      () =>
        expect(requests.filter((entry) => entry.method === "turn/steer")).toEqual([
          {
            method: "turn/steer",
            params: {
              threadId: "thread-1",
              expectedTurnId: "turn-1",
              input: [{ type: "text", text: "subagent complete", text_elements: [] }],
            },
          },
        ]),
      { interval: 1 },
    );

    await completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await run;
  });

  it("batches default queued steering before sending turn/steer", async () => {
    const { requests, waitForMethod, completeTurn } = createStartedThreadHarness();

    const run = runCodexAppServerAttempt(
      createParams(path.join(tempDir, "session.jsonl"), path.join(tempDir, "workspace")),
    );
    await waitForMethod("turn/start");

    expect(queueActiveRunMessageForTest("session-1", "first", { debounceMs: 5 })).toBe(true);
    expect(queueActiveRunMessageForTest("session-1", "second", { debounceMs: 5 })).toBe(true);

    await vi.waitFor(
      () =>
        expect(requests.filter((entry) => entry.method === "turn/steer")).toEqual([
          {
            method: "turn/steer",
            params: {
              threadId: "thread-1",
              expectedTurnId: "turn-1",
              input: [
                { type: "text", text: "first", text_elements: [] },
                { type: "text", text: "second", text_elements: [] },
              ],
            },
          },
        ]),
      { interval: 1 },
    );

    await completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await run;
  });

  it("flushes pending default queued steering during normal turn cleanup", async () => {
    const { requests, waitForMethod, completeTurn } = createStartedThreadHarness();

    const run = runCodexAppServerAttempt(
      createParams(path.join(tempDir, "session.jsonl"), path.join(tempDir, "workspace")),
    );
    await waitForMethod("turn/start");

    expect(queueActiveRunMessageForTest("session-1", "late steer", { debounceMs: 30_000 })).toBe(
      true,
    );

    await completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await run;

    expect(requests.filter((entry) => entry.method === "turn/steer")).toEqual([
      {
        method: "turn/steer",
        params: {
          threadId: "thread-1",
          expectedTurnId: "turn-1",
          input: [{ type: "text", text: "late steer", text_elements: [] }],
        },
      },
    ]);
  });

  it("batches explicit all-mode steering before sending turn/steer", async () => {
    const { requests, waitForMethod, completeTurn } = createStartedThreadHarness();

    const run = runCodexAppServerAttempt(
      createParams(path.join(tempDir, "session.jsonl"), path.join(tempDir, "workspace")),
    );
    await waitForMethod("turn/start");

    expect(
      queueActiveRunMessageForTest("session-1", "first", { debounceMs: 5, steeringMode: "all" }),
    ).toBe(true);
    expect(
      queueActiveRunMessageForTest("session-1", "second", { debounceMs: 5, steeringMode: "all" }),
    ).toBe(true);

    await vi.waitFor(
      () =>
        expect(requests.filter((entry) => entry.method === "turn/steer")).toEqual([
          {
            method: "turn/steer",
            params: {
              threadId: "thread-1",
              expectedTurnId: "turn-1",
              input: [
                { type: "text", text: "first", text_elements: [] },
                { type: "text", text: "second", text_elements: [] },
              ],
            },
          },
        ]),
      { interval: 1 },
    );

    await completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await run;
  });

  it("routes request_user_input prompts through the active run follow-up queue", async () => {
    let notify: (notification: CodexServerNotification) => Promise<void> = async () => undefined;
    let handleRequest:
      | ((request: { id: string; method: string; params?: unknown }) => Promise<unknown>)
      | undefined;
    const request = vi.fn(async (method: string) => {
      if (method === "thread/start") {
        return threadStartResult();
      }
      if (method === "turn/start") {
        return turnStartResult();
      }
      return {};
    });
    setCodexAppServerClientFactoryForTest(
      async () =>
        ({
          request,
          addNotificationHandler: (handler: typeof notify) => {
            notify = handler;
            return () => undefined;
          },
          addRequestHandler: (
            handler: (request: {
              id: string;
              method: string;
              params?: unknown;
            }) => Promise<unknown>,
          ) => {
            handleRequest = handler;
            return () => undefined;
          },
        }) as never,
    );

    const params = createParams(
      path.join(tempDir, "session.jsonl"),
      path.join(tempDir, "workspace"),
    );
    params.onBlockReply = vi.fn();
    const run = runCodexAppServerAttempt(params);
    await vi.waitFor(
      () => expect(request.mock.calls.map(([method]) => method)).toContain("turn/start"),
      { interval: 1 },
    );
    await vi.waitFor(() => expect(handleRequest).toBeTypeOf("function"), fastWait);

    const response = handleRequest?.({
      id: "request-input-1",
      method: "item/tool/requestUserInput",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "ask-1",
        questions: [
          {
            id: "mode",
            header: "Mode",
            question: "Pick a mode",
            isOther: false,
            isSecret: false,
            options: [
              { label: "Fast", description: "Use less reasoning" },
              { label: "Deep", description: "Use more reasoning" },
            ],
          },
        ],
      },
    });

    await vi.waitFor(() => expect(params.onBlockReply).toHaveBeenCalledTimes(1), fastWait);
    expect(queueActiveRunMessageForTest("session-1", "2")).toBe(true);
    await expect(response).resolves.toEqual({
      answers: { mode: { answers: ["Deep"] } },
    });
    const requestCalls = request.mock.calls as unknown as Array<[string, unknown]>;
    expect(
      requestCalls.some(
        ([method, callParams]) =>
          method === "turn/steer" &&
          (callParams as { expectedTurnId?: string } | undefined)?.expectedTurnId === "turn-1",
      ),
    ).toBe(false);

    await notify({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        turn: { id: "turn-1", status: "completed" },
      },
    });
    await run;
  });
});
