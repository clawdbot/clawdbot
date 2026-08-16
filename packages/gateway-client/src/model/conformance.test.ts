import { describe, expect, it, vi } from "vitest";
import {
  CONTROL_MODEL_APPROVAL_AUTHORIZATION_CONFORMANCE_FIXTURES,
  CONTROL_MODEL_CATALOG_REFRESH_CONFORMANCE_FIXTURES,
  CONTROL_MODEL_CONVERSATION_OVERLAP_CONFORMANCE_FIXTURES,
  CONTROL_MODEL_CONVERSATION_RECONNECT_CONFORMANCE_FIXTURES,
} from "./conformance-fixtures.js";
import {
  activatedConversation,
  createHarness,
  flush,
  messageIds,
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
      for (const message of fixture.liveMessages) {
        harness.emit({ event: "session.message", payload: { sessionKey: SESSION_KEY, message } });
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
});
