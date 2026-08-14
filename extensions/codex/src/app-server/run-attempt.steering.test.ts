// Codex tests cover run attempt.steering plugin behavior.
import path from "node:path";
import { GPT5_BEHAVIOR_CONTRACT as CODEX_GPT5_BEHAVIOR_CONTRACT } from "openclaw/plugin-sdk/provider-model-shared";
import { describe, expect, it, vi } from "vitest";
import { readAttemptTerminal } from "./attempt-terminal.test-helper.js";
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
  cancelPendingAgentQuestionForSession: vi.fn(),
  clearActiveEmbeddedRun: vi.fn(),
  setActiveEmbeddedRun: vi.fn(),
  questionWaiters: new Map<string, (value: unknown) => void>(),
  cancelQuestionError: undefined as Error | undefined,
}));

vi.mock("openclaw/plugin-sdk/agent-harness-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/agent-harness-runtime")>();
  return {
    ...actual,
    cancelPendingAgentQuestionForSession: async (
      ...args: Parameters<typeof actual.cancelPendingAgentQuestionForSession>
    ) => {
      activeRunRegistrationMocks.cancelPendingAgentQuestionForSession(...args);
      const error = activeRunRegistrationMocks.cancelQuestionError;
      activeRunRegistrationMocks.cancelQuestionError = undefined;
      if (error) {
        throw error;
      }
      return await actual.cancelPendingAgentQuestionForSession(...args);
    },
    callGatewayTool: async (...args: Parameters<typeof actual.callGatewayTool>) => {
      const [method, , rawParams] = args;
      const params = rawParams as { id?: string; answers?: unknown; cancel?: boolean } | undefined;
      if (method === "question.request") {
        return { id: params?.id, expiresAtMs: Date.now() + 60_000 };
      }
      if (method === "question.waitAnswer") {
        return await new Promise((resolve) => {
          activeRunRegistrationMocks.questionWaiters.set(params?.id ?? "", resolve);
        });
      }
      if (method === "question.resolve") {
        const result = params?.cancel
          ? { status: "cancelled" as const }
          : { status: "answered" as const, answers: params?.answers };
        activeRunRegistrationMocks.questionWaiters.get(params?.id ?? "")?.(result);
        return result;
      }
      return await actual.callGatewayTool(...args);
    },
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
  params.toolAuthorityFingerprint = `authority-${sessionId}`;
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
  it("marks the active run aborted before asynchronous cleanup releases its handle", async () => {
    const { requests, waitForMethod } = createStartedThreadHarness();
    const params = createSteeringParams();
    activeRunRegistrationMocks.setActiveEmbeddedRun.mockClear();
    activeRunRegistrationMocks.clearActiveEmbeddedRun.mockClear();

    const run = runCodexAppServerAttempt(params);
    await waitForMethod("turn/start");

    let handle: { abort: () => void; isAborted?: () => boolean } | undefined;
    await vi.waitFor(() => {
      handle = activeRunRegistrationMocks.setActiveEmbeddedRun.mock.calls.findLast(
        (call) => call[0] === params.sessionId,
      )?.[1] as typeof handle;
      expect(handle).toBeDefined();
    }, fastWait);
    expect(handle?.isAborted?.()).toBe(false);

    handle?.abort();
    expect(handle?.isAborted?.()).toBe(true);
    expect(activeRunRegistrationMocks.clearActiveEmbeddedRun).not.toHaveBeenCalled();
    expect(readAttemptTerminal(await run).aborted).toBe(true);
    expect(activeRunRegistrationMocks.clearActiveEmbeddedRun).toHaveBeenCalledWith(
      params.sessionId,
      handle,
      params.sessionKey,
      params.sessionFile,
    );
    expect(requests).toContainEqual({
      method: "turn/interrupt",
      params: { threadId: "thread-1", turnId: "turn-1" },
    });
  });

  it("exposes pending-question cancellation for queued image fallback", async () => {
    const harness = createStartedThreadHarness();
    const params = createSteeringParams();
    activeRunRegistrationMocks.cancelPendingAgentQuestionForSession.mockClear();
    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");

    let handle: { cancelPendingUserInput?: (resolvedBy: string) => Promise<boolean> } | undefined;
    await vi.waitFor(() => {
      handle = activeRunRegistrationMocks.setActiveEmbeddedRun.mock.calls.findLast(
        (call) => call[0] === params.sessionId,
      )?.[1] as typeof handle;
      expect(handle?.cancelPendingUserInput).toBeTypeOf("function");
    }, fastWait);

    await expect(handle?.cancelPendingUserInput?.("image-reply")).resolves.toBe(false);
    expect(activeRunRegistrationMocks.cancelPendingAgentQuestionForSession).toHaveBeenCalledWith({
      sessionKey: params.sessionKey,
      resolvedBy: "image-reply",
    });

    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await run;
  });

  it("accepts Gateway transcript-backed steering for the active Codex turn", async () => {
    const { requests, waitForMethod, completeTurn, notify } = createStartedThreadHarness();
    const params = createSteeringParams();
    params.taskSuggestionDeliveryMode = "gateway";

    const run = runCodexAppServerAttempt(params, {
      pluginConfig: { appServer: { mode: "yolo" } },
    });
    await waitForMethod("turn/start");
    const onQueueAccepted = vi.fn();

    await vi.waitFor(() => {
      expect(
        activeRunRegistrationMocks.setActiveEmbeddedRun.mock.calls.findLast(
          (call) => call[0] === params.sessionId,
        )?.[1],
      ).toMatchObject({ taskSuggestionDeliveryMode: "gateway" });
    }, fastWait);

    // This public queue returns immediate eligibility; the handle's delivery
    // promise stays pending until the matching item/completed notification below.
    await waitAndQueueActiveRunMessage(params.sessionId, "steer this active turn", {
      debounceMs: 0,
      isInboundUserMessage: true,
      toolAuthorityFingerprint: params.toolAuthorityFingerprint,
      taskSuggestionDeliveryMode: "gateway",
      waitForTranscriptCommit: true,
      onQueueAccepted,
    });
    await vi.waitFor(
      () => expect(requests.map((entry) => entry.method)).toContain("turn/steer"),
      fastWait,
    );
    const steer = requests.find((entry) => entry.method === "turn/steer");
    const clientUserMessageId = (steer?.params as { clientUserMessageId?: string } | undefined)
      ?.clientUserMessageId;
    if (!clientUserMessageId) {
      throw new Error("turn/steer clientUserMessageId missing");
    }
    await vi.waitFor(() => expect(onQueueAccepted).toHaveBeenCalledWith(true), fastWait);

    await notify({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: { id: "steered-user-message", type: "userMessage", clientId: clientUserMessageId },
      },
    });
    await completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await run;

    expect(steer?.params).toMatchObject({
      threadId: "thread-1",
      expectedTurnId: "turn-1",
      input: [{ type: "text", text: "steer this active turn" }],
    });
  });

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

  it("still steers an image when gateway question cancellation fails", async () => {
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

    activeRunRegistrationMocks.cancelQuestionError = new Error("gateway unavailable");
    const delivered = handle!.queueMessage("inspect this", {
      debounceMs: 0,
      images: [{ type: "image", data: PNG_1X1, mimeType: "image/png" }],
      isInboundUserMessage: true,
    });
    await vi.waitFor(
      () => expect(requests.map((entry) => entry.method)).toContain("turn/steer"),
      fastWait,
    );
    const steer = requests.findLast((entry) => entry.method === "turn/steer");
    const clientUserMessageId = (steer?.params as { clientUserMessageId?: string } | undefined)
      ?.clientUserMessageId;
    if (!clientUserMessageId) {
      throw new Error("turn/steer clientUserMessageId missing");
    }
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

  it("seals unsent steering without erasing an earlier consumed dispatch", async () => {
    const { requests, waitForMethod, completeTurn, notify } = createStartedThreadHarness();
    const params = createSteeringParams();

    const run = runCodexAppServerAttempt(params);
    await waitForMethod("turn/start");
    let handle:
      | {
          queueMessage: (
            text: string,
            options: { debounceMs: number; onQueueAccepted?: (accepted: boolean) => void },
          ) => Promise<void>;
        }
      | undefined;
    await vi.waitFor(() => {
      handle = activeRunRegistrationMocks.setActiveEmbeddedRun.mock.calls.findLast(
        (call) => call[0] === params.sessionId,
      )?.[1] as typeof handle;
      expect(handle).toBeDefined();
    }, fastWait);
    const onDispatchedAccepted = vi.fn();
    const onUnsentAccepted = vi.fn();
    const onLateAccepted = vi.fn();
    const dispatchedDelivery = handle!.queueMessage("on the wire", {
      debounceMs: 0,
      onQueueAccepted: onDispatchedAccepted,
    });
    await vi.waitFor(
      () => expect(requests.filter((entry) => entry.method === "turn/steer")).toHaveLength(1),
      fastWait,
    );
    const steer = requests.find((entry) => entry.method === "turn/steer");
    const clientUserMessageId = (steer?.params as { clientUserMessageId?: string } | undefined)
      ?.clientUserMessageId;
    if (!clientUserMessageId) {
      throw new Error("turn/steer clientUserMessageId missing");
    }
    const unsentDelivery = handle!.queueMessage("still debounced", {
      debounceMs: 30_000,
      onQueueAccepted: onUnsentAccepted,
    });
    const unsentRejected = expect(unsentDelivery).rejects.toThrow("queue admission sealed");

    // Raw receipt seals admission immediately, while serialized projection still
    // honors the matching consumption notification already ahead of the terminal.
    const consumed = notify({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: { id: "steered-user-message", type: "userMessage", clientId: clientUserMessageId },
      },
    });
    const completed = completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await Promise.all([consumed, completed]);

    await expect(dispatchedDelivery).resolves.toBeUndefined();
    await unsentRejected;
    expect(onDispatchedAccepted).toHaveBeenCalledWith(true);
    expect(onUnsentAccepted).toHaveBeenCalledWith(false);
    await run;

    expect(requests.filter((entry) => entry.method === "turn/steer")).toEqual([
      expect.objectContaining({
        params: expect.objectContaining({ expectedTurnId: "turn-1", clientUserMessageId }),
      }),
    ]);
    await expect(
      handle!.queueMessage("too late", { debounceMs: 0, onQueueAccepted: onLateAccepted }),
    ).rejects.toThrow("steering queue cancelled");
    expect(onLateAccepted).toHaveBeenCalledWith(false);
  });

  it.each([
    { name: "gateway-backed", isSecret: false },
    { name: "secret", isSecret: true },
  ])("routes $name user prompts without consuming internal steering", async ({ isSecret }) => {
    let notify: (notification: CodexServerNotification) => Promise<void> = async () => undefined;
    let handleRequest:
      | ((request: { id: string; method: string; params?: unknown }) => Promise<unknown>)
      | undefined;
    const request = vi.fn(async (method: string, _params?: unknown) => {
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
    const onRunProgress = vi.fn();
    params.onRunProgress = onRunProgress;
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
        isBlocking: true,
        questions: [
          {
            id: "mode",
            header: "Mode",
            question: "Pick a mode",
            isOther: false,
            isSecret,
            options: [
              { label: "Fast", description: "Use less reasoning" },
              { label: "Deep", description: "Use more reasoning" },
            ],
          },
        ],
      },
    });

    await vi.waitFor(() => expect(params.onBlockReply).toHaveBeenCalledTimes(1), fastWait);
    await waitAndQueueActiveRunMessage(params.sessionId, "tool progress", { debounceMs: 0 });
    await vi.waitFor(
      () => expect(request.mock.calls.map(([method]) => method)).toContain("turn/steer"),
      fastWait,
    );
    const sourceSteer = request.mock.calls.findLast(([method]) => method === "turn/steer");
    const sourceMessageId = (sourceSteer?.[1] as { clientUserMessageId?: string } | undefined)
      ?.clientUserMessageId;
    if (!sourceMessageId) {
      throw new Error("source turn/steer clientUserMessageId missing");
    }
    await notify({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: { id: "source-message", type: "userMessage", clientId: sourceMessageId },
      },
    });
    expect(
      onRunProgress.mock.calls.some(
        ([event]) =>
          (event as { reason?: string }).reason === "request:item/tool/requestUserInput:response",
      ),
    ).toBe(false);
    const onQuestionAccepted = vi.fn();
    await waitAndQueueActiveRunMessage(params.sessionId, "2", {
      isInboundUserMessage: true,
      onQueueAccepted: onQuestionAccepted,
      toolAuthorityFingerprint: params.toolAuthorityFingerprint,
    });
    await expect(response).resolves.toEqual({
      answers: { mode: { answers: ["Deep"] } },
    });
    expect(onRunProgress).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "request:item/tool/requestUserInput:response" }),
    );
    expect(onQuestionAccepted).toHaveBeenCalledWith(true);
    expect(request.mock.calls.filter(([method]) => method === "turn/steer")).toHaveLength(1);

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
