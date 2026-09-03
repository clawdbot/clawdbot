import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "openclaw/plugin-sdk/hook-runtime";
import { createMockPluginRegistry } from "openclaw/plugin-sdk/plugin-test-runtime";
import { readSessionTranscriptEvents } from "openclaw/plugin-sdk/session-transcript-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerCopilotActiveRun } from "./attempt-active-run.js";
import type { AttemptTranscriptJournal } from "./attempt-transcript-journal.js";
import {
  cleanupAttemptTranscriptJournalFixtures,
  createFixture,
  event,
  transcriptMessages,
} from "./attempt-transcript-journal.test-helpers.js";
import type { AttemptParamsLike } from "./attempt-types.js";
import type { SessionLike } from "./event-bridge.js";
import type { CopilotUserInputBridge } from "./user-input-bridge.js";

const harnessMocks = vi.hoisted(() => ({
  cancelPendingAgentQuestionForSession: vi.fn(async () => false),
  claimPendingAgentQuestionAnswer: vi.fn(async () => false),
  setActiveEmbeddedRun: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/agent-harness-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/agent-harness-runtime")>();
  return {
    ...actual,
    cancelPendingAgentQuestionForSession: harnessMocks.cancelPendingAgentQuestionForSession,
    claimPendingAgentQuestionAnswer: harnessMocks.claimPendingAgentQuestionAnswer,
    setActiveEmbeddedRun: harnessMocks.setActiveEmbeddedRun,
  };
});

function registerTestRun(params?: {
  canAcceptSteering?: () => boolean;
  isAborted?: () => boolean;
  isSettled?: () => boolean;
  startedAtMs?: number;
  receipt?: Promise<void>;
  send?: SessionLike["send"];
  session?: SessionLike;
  journal?: AttemptTranscriptJournal;
}) {
  const send = params?.send ?? vi.fn(async () => "steer-1");
  const waitForSdkUserPersisted = vi.fn(() => params?.receipt ?? Promise.resolve());
  const session: SessionLike = params?.session ?? {
    abort: vi.fn(async () => undefined),
    disconnect: vi.fn(async () => undefined),
    on: vi.fn() as SessionLike["on"],
    send,
    sendAndWait: vi.fn(async () => undefined),
  };
  const handle = registerCopilotActiveRun({
    abortActiveSession: vi.fn(),
    bridge: undefined,
    canAcceptSteering: params?.canAcceptSteering ?? (() => true),
    startedAtMs: params?.startedAtMs ?? 1_750_000_000_000,
    input: { runId: "run-1", sessionId: "session-1" } as AttemptParamsLike,
    isAborted: params?.isAborted ?? (() => false),
    isSettled: params?.isSettled ?? (() => false),
    session,
    transcriptJournal:
      params?.journal ??
      ({
        waitForSdkUserPersisted,
        sendSdkUser: (submit: () => Promise<string>) => submit(),
      } as unknown as AttemptTranscriptJournal),
    userInputBridge: {
      cancelPending: vi.fn(),
      onUserInputRequest: vi.fn(),
    } as unknown as CopilotUserInputBridge,
  });
  return { handle, send, waitForSdkUserPersisted };
}

function createSteeringRecorder(
  recorder: NonNullable<AttemptParamsLike["userTurnTranscriptRecorder"]>,
  sourceSessionKey = "agent:other:source",
) {
  const message = {
    role: "user" as const,
    content: "change course",
    timestamp: 1,
    provenance: { kind: "inter_session" as const, sourceSessionKey, sourceTool: "sessions_send" },
  };
  return {
    ...recorder,
    message,
    resolveMessage: vi.fn(async () => message),
    markSentToProvider: vi.fn(),
    markRuntimePersisted: vi.fn(),
  };
}

describe("registerCopilotActiveRun", () => {
  afterEach(cleanupAttemptTranscriptJournalFixtures);
  afterEach(resetGlobalHookRunner);
  beforeEach(() => {
    harnessMocks.cancelPendingAgentQuestionForSession.mockClear();
    harnessMocks.claimPendingAgentQuestionAnswer.mockReset();
    harnessMocks.claimPendingAgentQuestionAnswer.mockResolvedValue(false);
    harnessMocks.setActiveEmbeddedRun.mockClear();
  });

  it("reports acceptance after send while the transcript receipt is still pending", async () => {
    const receipt = createDeferred<void>();
    const onQueueAccepted = vi.fn();
    const { handle, send, waitForSdkUserPersisted } = registerTestRun({
      receipt: receipt.promise,
    });

    let deliverySettled = false;
    const delivery = handle
      .queueMessage("change course", { onQueueAccepted, waitForTranscriptCommit: true })
      .then(() => {
        deliverySettled = true;
      });

    await vi.waitFor(() => expect(onQueueAccepted).toHaveBeenCalledWith(true));
    expect(send).toHaveBeenCalledWith({ prompt: "change course" });
    expect(waitForSdkUserPersisted).toHaveBeenCalledWith("steer-1");
    expect(deliverySettled).toBe(false);

    receipt.resolve();
    await expect(delivery).resolves.toBeUndefined();
    expect(onQueueAccepted).toHaveBeenCalledOnce();
  });

  it.each(["before response", "after response", "during tools", "hook replacement"])(
    "persists decorated reply steering with selected mentions once: %s",
    async (timing) => {
      const { journal, recorder, session, target } = await createFixture();
      await journal.persistInitialUser();
      session.emit(event("user.message", "initial-user", { content: "inspect both files" }));
      const mentions = [{ profileId: "profile-taylor", start: 3, end: 10 }];
      const message = {
        role: "user" as const,
        content: "Hi @Taylor",
        timestamp: 1,
        provenance: { kind: "external_user" as const },
        __openclaw: { humanMentions: mentions },
      };
      const steeringRecorder = {
        ...recorder,
        message,
        resolveMessage: vi.fn(async () => message),
        markSentToProvider: vi.fn(),
        markRuntimePersisted: vi.fn(),
      };
      const modelPrompt = `Reply context: earlier message\n\n${message.content}`;
      const { provenance } = message;
      if (timing === "hook replacement") {
        initializeGlobalHookRunner(
          createMockPluginRegistry([
            {
              hookName: "before_message_write",
              handler: () => ({
                message: { role: "user", content: message.content, timestamp: 1 },
              }),
            },
          ]),
        );
      }
      const sdkUserEvent = (options: Parameters<SessionLike["send"]>[0]) =>
        event("user.message", "steer-1", {
          content: options.displayPrompt ?? options.prompt,
          transformedContent: options.prompt,
        });
      const response = createDeferred<string>();
      const send = vi.fn<SessionLike["send"]>((options) => {
        if (timing !== "after response") {
          session.emit(sdkUserEvent(options));
        }
        return response.promise;
      });
      session.send = send;
      if (timing === "during tools") {
        session.emit(
          event("assistant.message", "assistant-tools", {
            content: "checking",
            messageId: "assistant-tools",
            toolRequests: [{ name: "read", arguments: {}, toolCallId: "read-1" }],
          }),
        );
        session.emit(
          event("tool.execution_start", "start-read", { toolCallId: "read-1", toolName: "read" }),
        );
      }
      const { handle } = registerTestRun({ journal, session });
      const onQueueAccepted = vi.fn();
      let confirmed = false;
      const delivery = handle
        .queueMessage(modelPrompt, {
          userTurnTranscriptRecorder: steeringRecorder,
          onQueueAccepted,
          waitForTranscriptCommit: true,
        })
        .then((result) => {
          confirmed = true;
          return result;
        });
      await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
      const sdkUser = sdkUserEvent(send.mock.calls[0]![0]);
      expect(onQueueAccepted).not.toHaveBeenCalled();
      response.resolve("steer-1");
      await vi.waitFor(() => expect(onQueueAccepted).toHaveBeenCalledWith(true));
      if (timing === "after response" || timing === "during tools") {
        expect(confirmed).toBe(false);
      }
      if (timing === "after response") {
        session.emit(sdkUser);
      } else if (timing === "during tools") {
        session.emit(
          event("tool.execution_complete", "result-read", {
            toolCallId: "read-1",
            success: true,
            result: { content: "done" },
          }),
        );
      }
      await expect(delivery).resolves.toBeUndefined();
      session.emit(sdkUser);
      await journal.barrier("steering replay");
      const rows = transcriptMessages(await readSessionTranscriptEvents(target));
      const steered = rows.filter(
        (row) => row.message.idempotencyKey === "copilot-sdk:sdk-session:steer-1",
      );
      expect(send).toHaveBeenCalledExactlyOnceWith({
        prompt: modelPrompt,
        displayPrompt: message.content,
      });
      expect(steered).toHaveLength(1);
      expect(steered[0]?.message).toMatchObject({
        role: "user",
        content: message.content,
        provenance,
        __openclaw: { humanMentions: mentions },
        idempotencyKey: "copilot-sdk:sdk-session:steer-1",
      });
      expect(steeringRecorder.markRuntimePersisted).toHaveBeenCalledExactlyOnceWith(
        steered[0]?.message,
        expect.objectContaining({ entryId: steered[0]?.id }),
        { appended: true },
      );
      expect(steeringRecorder.persistApproved).not.toHaveBeenCalled();
      expect(steeringRecorder.markSentToProvider).toHaveBeenCalledOnce();
    },
  );

  it.each([false, true])(
    "correlates concurrent identical steering by SDK id and releases rejected sends: reject=%s",
    async (rejectFirst) => {
      const { journal, recorder, session, target } = await createFixture();
      await journal.persistInitialUser();
      session.emit(event("user.message", "initial-user", { content: "inspect both files" }));
      const first = createSteeringRecorder(recorder, "agent:first:source");
      const second = createSteeringRecorder(recorder, "agent:second:source");
      const response = createDeferred<string>();
      const send = vi
        .fn()
        .mockImplementationOnce(() => response.promise)
        .mockImplementationOnce(async () => {
          session.emit(event("user.message", "second", { content: second.message.content }));
          return "second";
        });
      session.send = send;
      const { handle } = registerTestRun({ journal, session });
      const firstDelivery = handle.queueMessage(first.message.content, {
        userTurnTranscriptRecorder: first,
        waitForTranscriptCommit: true,
      });
      const firstOutcome = firstDelivery.catch((error: unknown) => error);
      await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
      const secondAccepted = vi.fn();
      const secondDelivery = handle.queueMessage(second.message.content, {
        userTurnTranscriptRecorder: second,
        waitForTranscriptCommit: true,
        onQueueAccepted: secondAccepted,
      });
      await vi.waitFor(() => expect(secondAccepted).toHaveBeenCalledWith(true));
      if (rejectFirst) {
        response.reject(new Error("send rejected"));
        await expect(firstOutcome).resolves.toMatchObject({ message: "send rejected" });
      } else {
        session.emit(event("user.message", "first", { content: first.message.content }));
        response.resolve("first");
        await expect(firstOutcome).resolves.toBeUndefined();
      }
      await expect(secondDelivery).resolves.toBeUndefined();
      session.emit(event("user.message", "native", { content: first.message.content }));
      await journal.barrier("concurrent steering");
      const users = transcriptMessages(await readSessionTranscriptEvents(target))
        .filter((row) => row.message.role === "user")
        .slice(1);
      expect(users.map((row) => row.message)).toEqual([
        expect.objectContaining({
          idempotencyKey: "copilot-sdk:sdk-session:second",
          provenance: second.message.provenance,
        }),
        ...(!rejectFirst
          ? [
              expect.objectContaining({
                idempotencyKey: "copilot-sdk:sdk-session:first",
                provenance: first.message.provenance,
              }),
            ]
          : []),
        expect.not.objectContaining({ provenance: expect.anything() }),
      ]);
      expect(first.markRuntimePersisted).toHaveBeenCalledTimes(rejectFirst ? 0 : 1);
      expect(second.markRuntimePersisted).toHaveBeenCalledOnce();
      expect(recorder.persistApproved).not.toHaveBeenCalled();
    },
  );

  it("reports a claimed pending question as accepted without sending steering", async () => {
    harnessMocks.claimPendingAgentQuestionAnswer.mockResolvedValueOnce(true);
    const onQueueAccepted = vi.fn();
    const { handle, send } = registerTestRun();

    await expect(
      handle.queueMessage("answer", { isInboundUserMessage: true, onQueueAccepted }),
    ).resolves.toBeUndefined();

    expect(onQueueAccepted).toHaveBeenCalledOnce();
    expect(onQueueAccepted).toHaveBeenCalledWith(true);
    expect(send).not.toHaveBeenCalled();
  });

  it("exposes pending-question cancellation for queued image fallback", async () => {
    const { handle } = registerTestRun();

    await expect(handle.cancelPendingUserInput?.("image-reply")).resolves.toBe(false);

    expect(harnessMocks.cancelPendingAgentQuestionForSession).toHaveBeenCalledWith({
      sessionKey: "session-1",
      resolvedBy: "image-reply",
    });
  });

  it("reports pre-ownership validation failure as rejected", async () => {
    const onQueueAccepted = vi.fn();
    const { handle, send } = registerTestRun({ canAcceptSteering: () => false });

    await expect(handle.queueMessage("too early", { onQueueAccepted })).rejects.toThrow(
      "unavailable before initial user validation",
    );

    expect(onQueueAccepted).toHaveBeenCalledOnce();
    expect(onQueueAccepted).toHaveBeenCalledWith(false);
    expect(send).not.toHaveBeenCalled();
  });

  it.each(["settled", "aborted", "unavailable"] as const)(
    "revalidates steering after resolving source text when the run becomes %s",
    async (changedState) => {
      const { recorder } = await createFixture();
      const resolution = createDeferred<Awaited<ReturnType<typeof recorder.resolveMessage>>>();
      recorder.resolveMessage.mockReturnValue(resolution.promise);
      let stateChanged = false;
      const { handle, send } = registerTestRun({
        isSettled: () => stateChanged && changedState === "settled",
        isAborted: () => stateChanged && changedState === "aborted",
        canAcceptSteering: () => !stateChanged || changedState !== "unavailable",
      });
      const onQueueAccepted = vi.fn();
      const outcome = handle
        .queueMessage("Reply context: earlier message\n\ninspect both files", {
          userTurnTranscriptRecorder: recorder,
          onQueueAccepted,
        })
        .catch((error: unknown) => error);

      await vi.waitFor(() => expect(recorder.resolveMessage).toHaveBeenCalledOnce());
      expect(send).not.toHaveBeenCalled();
      expect(onQueueAccepted).not.toHaveBeenCalled();
      stateChanged = true;
      resolution.resolve(recorder.message);

      await expect(outcome).resolves.toMatchObject({
        message:
          changedState === "unavailable"
            ? "Copilot steering is unavailable before initial user validation"
            : "Copilot steering is unavailable after the active run ended",
      });
      expect(send).not.toHaveBeenCalled();
      expect(onQueueAccepted).toHaveBeenCalledExactlyOnceWith(false);
    },
  );

  it("reports a rejected send as rejected", async () => {
    const onQueueAccepted = vi.fn();
    const sendError = new Error("send rejected");
    const { handle } = registerTestRun({
      send: vi.fn(async () => {
        throw sendError;
      }),
    });

    await expect(handle.queueMessage("change course", { onQueueAccepted })).rejects.toBe(sendError);
    expect(onQueueAccepted).toHaveBeenCalledOnce();
    expect(onQueueAccepted).toHaveBeenCalledWith(false);
  });

  it("keeps acceptance irrevocable when transcript confirmation fails", async () => {
    const receipt = createDeferred<void>();
    const onQueueAccepted = vi.fn();
    const { handle } = registerTestRun({ receipt: receipt.promise });
    const delivery = handle.queueMessage("change course", {
      onQueueAccepted,
      waitForTranscriptCommit: true,
    });

    await vi.waitFor(() => expect(onQueueAccepted).toHaveBeenCalledWith(true));
    receipt.reject(new Error("journal failed"));

    await expect(delivery).resolves.toEqual({
      transcriptCommit: "unconfirmed",
      errorMessage: "journal failed",
    });
    expect(onQueueAccepted).toHaveBeenCalledOnce();
  });
});

it("threads the attempt start timestamp onto the embedded run handle", () => {
  const startedAtMs = 1_750_000_000_000;
  const { handle } = registerTestRun({ startedAtMs });
  expect(handle.startedAtMs).toBe(startedAtMs);
});
