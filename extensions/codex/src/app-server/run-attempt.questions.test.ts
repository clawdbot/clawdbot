import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodexSteeringQueueOptions } from "./attempt-steering.js";
import type { CodexServerNotification, JsonObject } from "./protocol.js";
import {
  createParams,
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

const questionWaiters = vi.hoisted(() => new Map<string, (value: unknown) => void>());

vi.mock("openclaw/plugin-sdk/agent-harness-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/agent-harness-runtime")>();
  return {
    ...actual,
    callGatewayTool: async (...args: Parameters<typeof actual.callGatewayTool>) => {
      const [method, , rawParams] = args;
      const params = rawParams as { id?: string; answers?: unknown; cancel?: boolean } | undefined;
      if (method === "question.request") {
        return { id: params?.id, expiresAtMs: Date.now() + 60_000 };
      }
      if (method === "question.waitAnswer") {
        return await new Promise((resolve) => {
          questionWaiters.set(params?.id ?? "", resolve);
        });
      }
      if (method === "question.resolve") {
        const result = params?.cancel
          ? { status: "cancelled" as const }
          : { status: "answered" as const, answers: params?.answers };
        questionWaiters.get(params?.id ?? "")?.(result);
        return result;
      }
      return await actual.callGatewayTool(...args);
    },
  };
});

setupRunAttemptTestHooks();
afterEach(() => questionWaiters.clear());

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

describe("runCodexAppServerAttempt pending questions", () => {
  it.each([
    { name: "gateway-backed", isSecret: false, snapshot: undefined, steersAnswer: false },
    { name: "unchanged context", isSecret: false, snapshot: "Existing task", steersAnswer: false },
    { name: "changed context", isSecret: false, snapshot: "Another task", steersAnswer: true },
    { name: "cleared context", isSecret: false, snapshot: null, steersAnswer: true },
    {
      name: "secret with changed context",
      isSecret: true,
      snapshot: "Another task",
      steersAnswer: false,
    },
  ])(
    "routes $name user prompts without consuming internal steering",
    async ({ isSecret, snapshot, steersAnswer }) => {
      const turnStarted = createDeferred<void>();
      let notify: (notification: CodexServerNotification) => Promise<void> = async () => undefined;
      let handleRequest:
        | ((request: { id: string; method: string; params?: unknown }) => Promise<unknown>)
        | undefined;
      const request = vi.fn(async (method: string, _params?: unknown) => {
        if (method === "thread/start") {
          return threadStartResult();
        }
        if (method === "turn/start") {
          turnStarted.resolve();
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

      const params = createParams(
        path.join(tempDir, "question-session.jsonl"),
        path.join(tempDir, "question-workspace"),
      );
      params.toolAuthorityFingerprint = "question-context-authority";
      params.trigger = "user";
      params.senderId = "sender-context-proof";
      params.permissionChange = {
        owner: {},
        baseExecOverrides: {},
        notice: "Permission context proof.",
        request: vi.fn(async () => true),
        applied: () => true,
        recordApplied: vi.fn(),
      };
      const recorder = (workContext: string | null) =>
        ({
          message: {
            role: "user" as const,
            content: "2",
            timestamp: 1,
            __openclaw: { workContext, workContextRevision: "question-context" },
          },
          async resolveMessage() {
            return this.message;
          },
          getAdmissionReceipt: () => undefined,
          markRuntimePersistencePending: vi.fn(),
          markRuntimePersisted: vi.fn(),
          markBlocked: vi.fn(),
          isBlocked: () => false,
          hasRuntimePersistencePending: () => false,
          waitForRuntimePersistence: async () => {},
          persistBlocked: async () => undefined,
          persistFallback: async () => undefined,
          persistApproved: vi.fn(async () => undefined),
          hasPersisted: () => true,
        }) satisfies NonNullable<CodexSteeringQueueOptions["userTurnTranscriptRecorder"]>;
      params.userTurnTranscriptRecorder = recorder("Existing task");
      params.onBlockReply = vi.fn();
      const onRunProgress = vi.fn();
      params.onRunProgress = onRunProgress;
      const run = runCodexAppServerAttempt(params);
      await turnStarted.promise;
      const retainedContext = {
        openclaw_current_sender: {
          kind: "untrusted",
          value: JSON.stringify({ sender: { id: params.senderId } }),
        },
        openclaw_permission_change: {
          kind: "application",
          value: params.permissionChange.notice,
        },
      };
      expect(request.mock.calls.find(([method]) => method === "turn/start")?.[1]).toMatchObject({
        additionalContext: retainedContext,
      });
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
      expect(sourceSteer?.[1]).toMatchObject({
        additionalContext: retainedContext,
      });
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
      const answerRecorder = snapshot === undefined ? undefined : recorder(snapshot);
      await waitAndQueueActiveRunMessage(params.sessionId, "2", {
        isInboundUserMessage: true,
        userTurnTranscriptRecorder: answerRecorder,
        onQueueAccepted: onQuestionAccepted,
        toolAuthorityFingerprint: params.toolAuthorityFingerprint,
      });
      if (steersAnswer) {
        await expect(response).resolves.toEqual({ answers: {} });
        await vi.waitFor(
          () =>
            expect(request.mock.calls.filter(([method]) => method === "turn/steer")).toHaveLength(
              2,
            ),
          fastWait,
        );
        const answerSteer = request.mock.calls.findLast(
          ([method]) => method === "turn/steer",
        )?.[1] as JsonObject;
        expect(answerSteer).toMatchObject({
          input: [{ type: "text", text: "2" }],
          additionalContext: {
            ...retainedContext,
            openclaw_work_context: {
              kind: "untrusted",
              value: expect.stringContaining(snapshot ?? "cleared"),
            },
          },
        });
        const answerMessageId = answerSteer.clientUserMessageId;
        if (typeof answerMessageId !== "string") {
          throw new Error("Expected a client message ID for the steered answer");
        }
        await notify({
          method: "item/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            item: {
              id: "answer-message",
              type: "userMessage",
              clientId: answerMessageId,
            },
          },
        });
      } else {
        await expect(response).resolves.toEqual({ answers: { mode: { answers: ["Deep"] } } });
      }
      expect(onRunProgress).toHaveBeenCalledWith(
        expect.objectContaining({ reason: "request:item/tool/requestUserInput:response" }),
      );
      expect(onQuestionAccepted).toHaveBeenCalledWith(true);
      expect(request.mock.calls.filter(([method]) => method === "turn/steer")).toHaveLength(
        steersAnswer ? 2 : 1,
      );
      if (isSecret) {
        expect(answerRecorder?.persistApproved).not.toHaveBeenCalled();
      }

      await notify({
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          turn: { id: "turn-1", status: "completed" },
        },
      });
      await run;
    },
  );
});
