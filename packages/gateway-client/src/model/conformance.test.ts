import { describe, expect, it, vi } from "vitest";
import {
  CONTROL_MODEL_APPROVAL_AUTHORIZATION_CONFORMANCE_FIXTURES,
  CONTROL_MODEL_ARTIFACT_CONFORMANCE_FIXTURES,
  CONTROL_MODEL_BOUNDS_CONFORMANCE_FIXTURES,
  CONTROL_MODEL_CATALOG_REFRESH_CONFORMANCE_FIXTURES,
  CONTROL_MODEL_CONVERSATION_OVERLAP_CONFORMANCE_FIXTURES,
  CONTROL_MODEL_CONVERSATION_RECONNECT_CONFORMANCE_FIXTURES,
  CONTROL_MODEL_QUESTION_LIFECYCLE_CONFORMANCE_FIXTURES,
  CONTROL_MODEL_RUN_LIFECYCLE_CONFORMANCE_FIXTURES,
  CONTROL_MODEL_TOOL_LIFECYCLE_CONFORMANCE_FIXTURES,
} from "./conformance-fixtures.js";
import {
  activatedConversation,
  createHarness,
  flush,
  message,
  messageIds,
  uiArtifact,
} from "./conversation.test-harness.js";
import {
  createControlModel,
  createControlModelCatalog,
  type ControlModelGatewayBinding,
  type ControlModelGatewayEventFrame,
} from "./index.js";

const SESSION_KEY = "agent:main:one";

describe("Control Model shared conformance fixtures", () => {
  for (const fixture of CONTROL_MODEL_CATALOG_REFRESH_CONFORMANCE_FIXTURES) {
    it(fixture.id, async () => {
      const eventListeners = new Set<(frame: ControlModelGatewayEventFrame) => void>();
      const gateway: ControlModelGatewayBinding = {
        getConnectionSnapshot: () => ({ status: "connected", epoch: 1 }),
        subscribeConnection: () => () => undefined,
        subscribeSessionCatalogInvalidations: () => () => undefined,
        subscribeEvents(listener) {
          eventListeners.add(listener);
          return () => eventListeners.delete(listener);
        },
        request: vi.fn(async () => fixture.response as never),
      };
      const model = createControlModelCatalog({ gateway });

      model.start();
      await vi.waitFor(() => {
        expect(model.getSnapshot().sessionCatalog.status).toBe(fixture.expected.status);
      });

      const snapshot = model.getSnapshot().sessionCatalog;
      expect(snapshot.sessions.map((session) => session.key)).toEqual(fixture.expected.sessionKeys);
      expect(snapshot.error?.code ?? null).toBe(fixture.expected.errorCode);
      model.dispose();
    });
  }

  for (const fixture of CONTROL_MODEL_CONVERSATION_OVERLAP_CONFORMANCE_FIXTURES) {
    it(fixture.id, async () => {
      const harness = createHarness(
        { status: "connected", epoch: 1 },
        {
          history: {
            messages: fixture.initialHistory,
            completeSnapshot: true,
            totalMessages: fixture.initialHistory.length,
          },
        },
      );
      const { model, conversation } = await activatedConversation(harness);
      const refresh = harness.defer("chat.history");
      for (const liveMessage of fixture.liveMessages) {
        harness.emit({
          event: "session.message",
          payload: { sessionKey: SESSION_KEY, message: liveMessage },
        });
      }
      refresh.resolve({
        messages: fixture.authoritativeHistory,
        completeSnapshot: true,
        totalMessages: fixture.expectedMessageIds.length,
      });

      await vi.waitFor(() => {
        expect(messageIds(conversation.getSnapshot())).toEqual(fixture.expectedMessageIds);
      });
      model.dispose();
    });
  }

  for (const fixture of CONTROL_MODEL_CONVERSATION_RECONNECT_CONFORMANCE_FIXTURES) {
    it(fixture.id, async () => {
      const harness = createHarness({ status: "connected", epoch: fixture.retiredEpoch });
      const backgroundErrors: unknown[] = [];
      const model = createControlModel({
        gateway: harness.gateway,
        onBackgroundError: (error) => backgroundErrors.push(error),
      });
      model.start();
      const conversation = model.conversation(SESSION_KEY);
      await vi.waitFor(() => expect(harness.callsFor("chat.history")).toHaveLength(1));

      const authoritative = harness.defer("chat.history");
      harness.emit({
        event: "session.message",
        gap: true,
        payload: { sessionKey: SESSION_KEY, message: fixture.gapMessage },
      });
      await vi.waitFor(() => expect(harness.callsFor("chat.history")).toHaveLength(2));
      expect(conversation.getSnapshot().partialReasons).toContain(fixture.expectedPartialReason);
      authoritative.resolve({
        messages: fixture.authoritativeHistory,
        completeSnapshot: true,
        totalMessages: fixture.authoritativeHistory.length,
      });
      await vi.waitFor(() => expect(conversation.getSnapshot().history.status).toBe("ready"));

      const oldHistory = harness.defer("chat.history");
      harness.emit({ event: "session.message", payload: { sessionKey: SESSION_KEY } });
      await vi.waitFor(() => expect(harness.callsFor("chat.history")).toHaveLength(3));
      harness.setConnection({ status: "connected", epoch: fixture.nextEpoch });
      harness.emit({
        connectionEpoch: fixture.retiredEpoch,
        event: "session.message",
        payload: { sessionKey: SESSION_KEY, message: fixture.retiredLiveMessage },
      });
      oldHistory.reject(Object.assign(new Error("retired"), { code: "UNAVAILABLE" }));
      await vi.waitFor(() => expect(harness.callsFor("chat.history")).toHaveLength(4));
      await flush();

      expect(messageIds(conversation.getSnapshot())).not.toContain(
        fixture.expectedRetiredMessageId,
      );
      expect(conversation.getSnapshot().history.error).toBeNull();
      expect(backgroundErrors).toEqual([]);
      model.dispose();
    });
  }

  for (const fixture of CONTROL_MODEL_APPROVAL_AUTHORIZATION_CONFORMANCE_FIXTURES) {
    it(fixture.id, async () => {
      const harness = createHarness(
        { status: "connected", epoch: 1 },
        { approvalReplay: { approvals: [fixture.approval], truncated: false } },
      );
      const { model, conversation } = await activatedConversation(harness);
      expect(conversation.getSnapshot().approvals).toContainEqual(
        expect.objectContaining({ id: fixture.approval.id }),
      );

      await expect(
        conversation.resolveApproval(fixture.approval.id, fixture.deniedDecision),
      ).rejects.toMatchObject({ category: fixture.expectedDeniedCategory });
      expect(harness.callsFor("approval.resolve")).toHaveLength(0);

      await expect(
        conversation.resolveApproval(fixture.approval.id, fixture.allowedDecision),
      ).resolves.toEqual({ applied: true });
      expect(harness.callsFor("approval.resolve")[0]?.params).toMatchObject({
        id: fixture.approval.id,
        decision: fixture.allowedDecision,
      });

      harness.emit({
        event: "session.approval",
        payload: { approval: { ...fixture.approval, status: fixture.terminalStatus } },
      });
      expect(conversation.getSnapshot().approvals).toContainEqual(
        expect.objectContaining({
          id: fixture.approval.id,
          status: fixture.terminalStatus,
        }),
      );
      model.dispose();
    });
  }

  for (const fixture of CONTROL_MODEL_RUN_LIFECYCLE_CONFORMANCE_FIXTURES) {
    it(fixture.id, async () => {
      const { harness, model, conversation } = await activatedConversation();
      for (const event of fixture.events) {
        harness.emit(event);
      }
      await conversation.abort(fixture.abortRunId);
      expect(harness.callsFor("chat.abort")[0]?.params).toMatchObject({
        sessionKey: SESSION_KEY,
        runId: fixture.abortRunId,
      });

      for (const expected of fixture.expectedRuns) {
        expect(conversation.getSnapshot().runs).toContainEqual(expect.objectContaining(expected));
      }
      expect(conversation.getSnapshot().activeRun).toMatchObject({
        runId: fixture.expectedActiveRunId,
        status: "streaming",
      });
      model.dispose();
    });
  }

  for (const fixture of CONTROL_MODEL_TOOL_LIFECYCLE_CONFORMANCE_FIXTURES) {
    it(fixture.id, async () => {
      const { harness, model, conversation } = await activatedConversation();
      for (const event of fixture.events) {
        harness.emit(event);
      }

      for (const expected of fixture.expectedTools) {
        expect(conversation.getSnapshot().tools).toContainEqual(expect.objectContaining(expected));
      }
      model.dispose();
    });
  }

  for (const fixture of CONTROL_MODEL_QUESTION_LIFECYCLE_CONFORMANCE_FIXTURES) {
    it(fixture.id, async () => {
      const harness = createHarness(
        { status: "connected", epoch: 1 },
        { questions: [fixture.initialQuestion] },
      );
      const { model, conversation } = await activatedConversation(harness);

      await conversation.answerQuestion(String(fixture.initialQuestion.id), fixture.answer);
      expect(harness.callsFor("question.resolve")[0]?.params).toMatchObject({
        id: fixture.initialQuestion.id,
        answers: { answers: fixture.answer },
      });

      harness.emit({
        event: "question.requested",
        payload: { question: fixture.requestedQuestion },
      });
      await conversation.cancelQuestion(String(fixture.requestedQuestion.id));
      harness.emit({
        event: "question.resolved",
        payload: {
          id: fixture.requestedQuestion.id,
          status: fixture.terminalStatus,
        },
      });
      expect(harness.callsFor("question.resolve")[1]?.params).toMatchObject({
        id: fixture.requestedQuestion.id,
        cancel: true,
      });
      expect(conversation.getSnapshot().questions).toContainEqual(
        expect.objectContaining({
          id: fixture.requestedQuestion.id,
          status: fixture.terminalStatus,
        }),
      );
      model.dispose();
    });
  }

  for (const fixture of CONTROL_MODEL_ARTIFACT_CONFORMANCE_FIXTURES) {
    it(fixture.id, async () => {
      const harness = createHarness(
        { status: "connected", epoch: 1 },
        {
          history: {
            messages: [fixture.historyMessage],
            completeSnapshot: true,
            totalMessages: 1,
          },
        },
      );
      const { model, conversation } = await activatedConversation(harness);
      const artifact = conversation
        .getSnapshot()
        .artifacts.find((candidate) => candidate.id === fixture.artifactId);
      expect(artifact).toMatchObject({
        id: fixture.artifactId,
        revision: fixture.artifactRevision,
        source: {
          messageId: "message-2",
          toolCallId: "tool-artifact",
        },
      });
      expect(artifact).not.toHaveProperty("module");
      expect(artifact).not.toHaveProperty("registerComponent");
      harness.queue("artifact.materialize", fixture.materializedResponse);

      await expect(
        conversation.materializeView({
          artifactId: fixture.artifactId,
          artifactRevision: fixture.artifactRevision,
          viewId: fixture.selectedViewId,
        }),
      ).resolves.toMatchObject({
        id: fixture.selectedViewId,
        availability: "inline",
      });
      expect(harness.callsFor("artifact.materialize")).toEqual([
        expect.objectContaining({
          params: {
            sessionKey: SESSION_KEY,
            artifactId: fixture.artifactId,
            artifactRevision: fixture.artifactRevision,
            viewId: fixture.selectedViewId,
          },
        }),
      ]);
      const projectedArtifact = conversation
        .getSnapshot()
        .artifacts.find((candidate) => candidate.id === fixture.artifactId);
      expect(projectedArtifact?.views).toEqual([
        expect.objectContaining({
          id: "calendar",
          availability: "deferred",
        }),
        expect.objectContaining({
          id: fixture.selectedViewId,
          availability: "inline",
          data: { rows: [{ id: "one" }] },
        }),
      ]);
      model.dispose();
    });
  }

  for (const fixture of CONTROL_MODEL_BOUNDS_CONFORMANCE_FIXTURES) {
    it(fixture.id, async () => {
      const harness = createHarness({ status: "connected", epoch: 1 });
      const { model, conversation } = await activatedConversation(harness, {
        maxConversationMessages: fixture.limits.messages,
        maxConversationRuns: fixture.limits.runs,
        maxConversationTools: fixture.limits.tools,
        maxConversationQuestions: fixture.limits.questions,
        maxConversationArtifacts: fixture.limits.artifacts,
        maxConversationProgressUpdates: fixture.limits.progressUpdates,
        maxConversationProgressBytes: fixture.limits.progressBytes,
      });

      for (let index = 1; index <= fixture.inputCount; index += 1) {
        harness.emit({
          event: "session.message",
          payload: { sessionKey: SESSION_KEY, message: message(index) },
        });
        harness.emit({
          event: "chat",
          payload: {
            sessionKey: SESSION_KEY,
            runId: `run-${index}`,
            state: "final",
            message: message(index),
          },
        });
        const toolCallId = `tool-${index}`;
        harness.emit({
          event: "agent",
          payload: {
            sessionKey: SESSION_KEY,
            runId: `run-${index}`,
            stream: "tool",
            data: {
              phase: "start",
              toolCallId,
              args: "x".repeat(fixture.limits.progressBytes),
            },
          },
        });
        harness.emit({
          event: "agent",
          payload: {
            sessionKey: SESSION_KEY,
            runId: `run-${index}`,
            stream: "tool",
            data: {
              phase: "update",
              toolCallId,
              output: "first",
            },
          },
        });
        harness.emit({
          event: "agent",
          payload: {
            sessionKey: SESSION_KEY,
            runId: `run-${index}`,
            stream: "tool",
            data: {
              phase: "update",
              toolCallId,
              output: "second",
            },
          },
        });
        harness.emit({
          event: "agent",
          payload: {
            sessionKey: SESSION_KEY,
            runId: `run-${index}`,
            stream: "tool",
            data: {
              phase: "result",
              toolCallId,
              output: "x".repeat(fixture.limits.progressBytes),
              uiArtifacts: [uiArtifact(index, { id: `artifact-${index}` })],
            },
          },
        });
        harness.emit({
          event: "question.requested",
          payload: {
            question: {
              id: `question-${index}`,
              status: "pending",
              sessionKey: SESSION_KEY,
            },
          },
        });
      }

      const snapshot = conversation.getSnapshot();
      expect(snapshot.messages).toHaveLength(fixture.limits.messages);
      expect(snapshot.runs).toHaveLength(fixture.limits.runs);
      expect(snapshot.tools).toHaveLength(fixture.limits.tools);
      expect(snapshot.questions).toHaveLength(fixture.limits.questions);
      expect(snapshot.artifacts).toHaveLength(fixture.limits.artifacts);
      expect(snapshot.bounds).toMatchObject({
        messagesTruncated: true,
        runsTruncated: true,
        toolsTruncated: true,
        questionsTruncated: true,
        artifactsTruncated: true,
      });
      expect(snapshot.tools.at(-1)?.progress).toMatchObject({
        bytes: expect.any(Number),
        updates: fixture.limits.progressUpdates,
        truncated: true,
      });
      expect(snapshot.tools.at(-1)?.progress.bytes).toBeLessThanOrEqual(
        fixture.limits.progressBytes,
      );
      model.dispose();
    });
  }
});
