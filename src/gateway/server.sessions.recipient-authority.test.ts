import { afterEach, expect, test, vi } from "vitest";
import { enqueueContinuationReturnDeliveries } from "../auto-reply/continuation/targeting.js";
import {
  captureSessionRecipientAuthority,
  isSessionRecipientAuthorityCurrent,
  loadSessionEntry,
} from "../config/sessions/session-accessor.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { setupGatewaySessionsTestHarness } from "./test/server-sessions.test-helpers.js";

const { seedActiveMainSession } = setupGatewaySessionsTestHarness();

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
});

test.each(["new", "reset"] as const)(
  "gateway /%s preserves accepted recipient authority through return enqueue",
  async (reason) => {
    const { storePath } = await seedActiveMainSession();
    const sessionKey = "agent:main:main";
    const scope = { agentId: "main", sessionKey, storePath };
    const beforeReset = loadSessionEntry(scope);
    const recipientAuthority = captureSessionRecipientAuthority(scope);
    const { performGatewaySessionReset } = await import("./session-reset-service.js");

    const reset = await performGatewaySessionReset({
      key: "main",
      reason,
      commandSource: "gateway:agent",
      workerPlacementContext: {},
    });

    expect(reset).toMatchObject({ ok: true, key: sessionKey });
    if (!reset.ok || !("entry" in reset)) {
      throw new Error(`gateway /${reason} did not return a replacement session entry`);
    }
    expect(reset.entry.lifecycleRevision).toEqual(expect.any(String));
    expect(reset.entry.lifecycleRevision).not.toBe(beforeReset?.lifecycleRevision);
    expect(loadSessionEntry(scope)?.lifecycleRevision).toBe(reset.entry.lifecycleRevision);
    expect(isSessionRecipientAuthorityCurrent(scope, recipientAuthority)).toBe(true);

    const enqueueSessionDelivery = vi.fn(async () => `delivery-${reason}`);
    const enqueueSystemEvent = vi.fn(() => true);
    const requestHeartbeatNow = vi.fn();
    const result = await enqueueContinuationReturnDeliveries(
      {
        targetSessionKeys: [sessionKey],
        text: "accepted delegate result",
        idempotencyKeyBase: `continuation-return:${reason}`,
        recipientAuthorities: new Map([[sessionKey, recipientAuthority]]),
        wakeRecipients: true,
      },
      {
        enqueueSessionDelivery,
        ackSessionDelivery: vi.fn(async () => undefined),
        enqueueSystemEvent,
        requestHeartbeatNow,
        isRecipientAuthorityCurrent: (resolvedKey, authority) =>
          isSessionRecipientAuthorityCurrent(
            { agentId: "main", sessionKey: resolvedKey, storePath },
            authority,
          ),
      },
    );

    expect(result).toEqual({
      enqueued: 1,
      delivered: 1,
      deliveryIds: [`delivery-${reason}`],
    });
    expect(enqueueSessionDelivery).toHaveBeenCalledWith(
      expect.objectContaining({
        recipientAuthority,
        awaitPromptAdoption: true,
        sessionKey,
      }),
      undefined,
    );
    expect(enqueueSystemEvent).toHaveBeenCalledOnce();
    expect(requestHeartbeatNow).toHaveBeenCalledOnce();
  },
);
