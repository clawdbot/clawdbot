// Codex tests cover run attempt.steering plugin behavior.
import path from "node:path";
import { GPT5_BEHAVIOR_CONTRACT as CODEX_GPT5_BEHAVIOR_CONTRACT } from "openclaw/plugin-sdk/provider-model-shared";
import { describe, expect, it, vi } from "vitest";
import type { CodexServerNotification } from "./protocol.js";
import {
  createParams,
  createStartedThreadHarness,
  fastWait,
  mockClientRuntimeMethods,
  queueActiveRunMessageForTest,
  runCodexAppServerAttempt,
  setCodexAppServerClientFactoryForTest,
  setupRunAttemptTestHooks,
  tempDir,
  threadStartResult,
  turnStartResult,
} from "./run-attempt-test-harness.js";

const activeRunRegistrationMocks = vi.hoisted(() => ({
  clearActiveEmbeddedRun: vi.fn(),
  setActiveEmbeddedRun: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/agent-harness-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/agent-harness-runtime")>();
  return {
    ...actual,
    clearActiveEmbeddedRun: (
      ...args: Parameters<typeof actual.clearActiveEmbeddedRun>
    ): ReturnType<typeof actual.clearActiveEmbeddedRun> => {
      activeRunRegistrationMocks.clearActiveEmbeddedRun(...args);
      return actual.clearActiveEmbeddedRun(...args);
    },
    setActiveEmbeddedRun: (
      ...args: Parameters<typeof actual.setActiveEmbeddedRun>
    ): ReturnType<typeof actual.setActiveEmbeddedRun> => {
      activeRunRegistrationMocks.setActiveEmbeddedRun(...args);
      return actual.setActiveEmbeddedRun(...args);
    },
  };
});

setupRunAttemptTestHooks();

const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

let steeringSessionIndex = 0;

function createSteeringParams() {
  const sessionId = `steering-session-${++steeringSessionIndex}`;
  const params = createParams(
    path.join(tempDir, `${sessionId}.jsonl`),
    path.join(tempDir, `${sessionId}-workspace`),
  );
  params.sessionId = sessionId;
  params.sessionKey = `agent:main:${sessionId}`;
  params.runId = `run-${sessionId}`;
  return params;
}

async function waitAndQueueActiveRunMessage(
  sessionId: string,
  text: string,
  options?: Parameters<typeof queueActiveRunMessageForTest>[2],
) {
  let queued = false;
  await vi.waitFor(() => {
    if (!queued) {
      queued = queueActiveRunMessageForTest(sessionId, text, options);
    }
    expect(queued).toBe(true);
  }, fastWait);
}

describe("runCodexAppServerAttempt steering", () => {
  it("forwards queued text and images to the active app-server turn", async () => {
    const { requests, waitForMethod, completeTurn, notify } = createStartedThreadHarness();
    const params = createSteeringParams();

    const run = runCodexAppServerAttempt(params, {
      pluginConfig: { appServer: { mode: "yolo" } },
    });
    await waitForMethod("turn/start");

    let handle:
      | {
          queueMessage: (
            text: string,
            options?: Parameters<typeof queueActiveRunMessageForTest>[2],
          ) => Promise<void>;
        }
      | undefined;
    await vi.waitFor(() => {
      handle = activeRunRegistrationMocks.setActiveEmbeddedRun.mock.calls.findLast(
        (call) => call[0] === params.sessionId,
      )?.[1] as typeof handle;
      expect(handle).toBeDefined();
    }, fastWait);
    const delivered = handle!.queueMessage("more context", {
      debounceMs: 0,
      images: [{ type: "image", data: PNG_1X1, mimeType: "image/png" }],
    });
    let deliverySettled = false;
    void delivered.finally(() => {
      deliverySettled = true;
    });
    await vi.waitFor(
      () => expect(requests.map((entry) => entry.method)).toContain("turn/steer"),
      fastWait,
    );
    const steer = requests.find((entry) => entry.method === "turn/steer");
    const clientUserMessageId = (steer?.params as { clientUserMessageId?: string } | undefined)
      ?.clientUserMessageId;
    expect(clientUserMessageId).toBe("openclaw:turn-1:steer:1");
    if (!clientUserMessageId) {
      throw new Error("turn/steer clientUserMessageId missing");
    }
    expect(deliverySettled).toBe(false);
    await notify({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: { id: "unrelated-user-message", type: "userMessage", clientId: "other-client-id" },
      },
    });
    expect(deliverySettled).toBe(false);
    await notify({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: { id: "steered-user-message", type: "userMessage", clientId: clientUserMessageId },
      },
    });
    await delivered;

    await completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await run;
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
    expect(steer?.params).toEqual({
      threadId: "thread-1",
      expectedTurnId: "turn-1",
      input: [
        { type: "text", text: "more context", text_elements: [] },
        { type: "image", url: `data:image/png;base64,${PNG_1X1}` },
      ],
      clientUserMessageId: "openclaw:turn-1:steer:1",
    });
  });

  it("accepts message-tool-only steering for active Codex app-server source replies", async () => {
    const { requests, waitForMethod, completeTurn } = createStartedThreadHarness();
    const params = createSteeringParams();
    params.sourceReplyDeliveryMode = "message_tool_only";

    const run = runCodexAppServerAttempt(params);
    await waitForMethod("turn/start");

    await waitAndQueueActiveRunMessage(params.sessionId, "subagent complete", {
      debounceMs: 0,
      steeringMode: "all",
      sourceReplyDeliveryMode: "message_tool_only",
    });

    await vi.waitFor(
      () =>
        expect(requests.filter((entry) => entry.method === "turn/steer")).toEqual([
          {
            method: "turn/steer",
            params: {
              threadId: "thread-1",
              expectedTurnId: "turn-1",
              input: [{ type: "text", text: "subagent complete", text_elements: [] }],
              clientUserMessageId: "openclaw:turn-1:steer:1",
            },
          },
        ]),
      { interval: 1 },
    );

    await completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await run;
  });

  it("passes session files through active Codex app-server registration for command lookup", async () => {
    const { requests, waitForMethod, completeTurn } = createStartedThreadHarness();
    const params = createSteeringParams();
    activeRunRegistrationMocks.setActiveEmbeddedRun.mockClear();
    activeRunRegistrationMocks.clearActiveEmbeddedRun.mockClear();

    const run = runCodexAppServerAttempt(params);
    await waitForMethod("turn/start");

    expect(activeRunRegistrationMocks.setActiveEmbeddedRun).toHaveBeenCalledWith(
      params.sessionId,
      expect.anything(),
      params.sessionKey,
      params.sessionFile,
    );

    await waitAndQueueActiveRunMessage(params.sessionId, "session-file registered", {
      debounceMs: 0,
    });

    await vi.waitFor(
      () =>
        expect(requests.filter((entry) => entry.method === "turn/steer")).toEqual([
          {
            method: "turn/steer",
            params: {
              threadId: "thread-1",
              expectedTurnId: "turn-1",
              input: [{ type: "text", text: "session-file registered", text_elements: [] }],
              clientUserMessageId: "openclaw:turn-1:steer:1",
            },
          },
        ]),
      fastWait,
    );

    await completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await run;

    expect(activeRunRegistrationMocks.clearActiveEmbeddedRun).toHaveBeenCalledWith(
      params.sessionId,
      expect.anything(),
      params.sessionKey,
      params.sessionFile,
    );
  });

  it("flushes batched default queued steering during normal turn cleanup", async () => {
    const { requests, waitForMethod, completeTurn } = createStartedThreadHarness();
    const params = createSteeringParams();

    const run = runCodexAppServerAttempt(params);
    await waitForMethod("turn/start");

    await waitAndQueueActiveRunMessage(params.sessionId, "first", { debounceMs: 30_000 });
    expect(queueActiveRunMessageForTest(params.sessionId, "second", { debounceMs: 30_000 })).toBe(
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
          input: [
            { type: "text", text: "first", text_elements: [] },
            { type: "text", text: "second", text_elements: [] },
          ],
          clientUserMessageId: "openclaw:turn-1:steer:1",
        },
      },
    ]);
  });

  it("flushes pending default queued steering during normal turn cleanup", async () => {
    const { requests, waitForMethod, completeTurn } = createStartedThreadHarness();
    const params = createSteeringParams();

    const run = runCodexAppServerAttempt(params);
    await waitForMethod("turn/start");

    await waitAndQueueActiveRunMessage(params.sessionId, "late steer", { debounceMs: 30_000 });

    await completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await run;

    expect(requests.filter((entry) => entry.method === "turn/steer")).toEqual([
      {
        method: "turn/steer",
        params: {
          threadId: "thread-1",
          expectedTurnId: "turn-1",
          input: [{ type: "text", text: "late steer", text_elements: [] }],
          clientUserMessageId: "openclaw:turn-1:steer:1",
        },
      },
    ]);
  });

  it("flushes batched explicit all-mode steering during normal turn cleanup", async () => {
    const { requests, waitForMethod, completeTurn } = createStartedThreadHarness();
    const params = createSteeringParams();

    const run = runCodexAppServerAttempt(params);
    await waitForMethod("turn/start");

    await waitAndQueueActiveRunMessage(params.sessionId, "first", {
      debounceMs: 30_000,
      steeringMode: "all",
    });
    expect(
      queueActiveRunMessageForTest(params.sessionId, "second", {
        debounceMs: 30_000,
        steeringMode: "all",
      }),
    ).toBe(true);

    await completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await run;

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
          clientUserMessageId: "openclaw:turn-1:steer:1",
        },
      },
    ]);
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
          ...mockClientRuntimeMethods(),
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

    const params = createSteeringParams();
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
    await waitAndQueueActiveRunMessage(params.sessionId, "2");
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
