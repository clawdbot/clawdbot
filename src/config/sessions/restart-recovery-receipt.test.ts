import { describe, expect, it } from "vitest";
import {
  beginRestartRecoveryTerminalDelivery,
  cancelRestartRecoveryTerminalDelivery,
  completeRestartRecoveryTerminalDelivery,
} from "./restart-recovery-receipt.js";
import { loadSessionEntry, replaceSessionEntry } from "./session-accessor.js";
import { useTempSessionsFixture } from "./test-helpers.js";

describe("restart recovery terminal delivery receipt", () => {
  const fixture = useTempSessionsFixture("restart-receipt-");
  const sessionKey = "agent:main:discord:direct:123";

  async function seedClaim(params?: { sessionId?: string; sourceTurnId?: string }) {
    await replaceSessionEntry(
      { sessionKey, storePath: fixture.storePath() },
      {
        sessionId: params?.sessionId ?? "session-1",
        status: "running",
        restartRecoveryDeliveryRunId: "recovery-1",
        restartRecoveryDeliverySourceRunId: params?.sourceTurnId ?? "source-1",
        updatedAt: 1,
      },
    );
  }

  function scope(params?: { sessionId?: string; sourceTurnId?: string }) {
    return {
      sessionId: params?.sessionId ?? "session-1",
      sessionKey,
      sourceTurnId: params?.sourceTurnId ?? "source-1",
      storePath: fixture.storePath(),
      toolCallId: "message-call-1",
    };
  }

  it("persists pending before delivery and completion after provider success", async () => {
    await seedClaim();

    await expect(beginRestartRecoveryTerminalDelivery(scope())).resolves.toBe("started");
    expect(
      loadSessionEntry({ sessionKey, storePath: fixture.storePath() })
        ?.restartRecoveryDeliveryReceiptState,
    ).toBe("terminal-pending");
    expect(
      loadSessionEntry({ sessionKey, storePath: fixture.storePath() })
        ?.restartRecoveryDeliveryToolCallId,
    ).toBe("message-call-1");

    await expect(completeRestartRecoveryTerminalDelivery(scope())).resolves.toBe("recorded");
    expect(
      loadSessionEntry({ sessionKey, storePath: fixture.storePath() })
        ?.restartRecoveryDeliveryReceiptState,
    ).toBe("delivered-terminal");
  });

  it("blocks a repeated terminal send while its outcome is already durable", async () => {
    await seedClaim();
    await beginRestartRecoveryTerminalDelivery(scope());

    await expect(beginRestartRecoveryTerminalDelivery(scope())).resolves.toBe("blocked");
  });

  it.each([undefined, "done" as const])(
    "does not arm a receipt for a live claimless turn with status %s",
    async (status) => {
      await replaceSessionEntry(
        { sessionKey, storePath: fixture.storePath() },
        {
          sessionId: "session-1",
          status,
          updatedAt: 1,
        },
      );

      await expect(beginRestartRecoveryTerminalDelivery(scope())).resolves.toBe("not-applicable");
      expect(
        loadSessionEntry({ sessionKey, storePath: fixture.storePath() })
          ?.restartRecoveryDeliveryReceiptState,
      ).toBeUndefined();
    },
  );

  it("fails closed when the claimless live capability names a replaced session", async () => {
    await replaceSessionEntry(
      { sessionKey, storePath: fixture.storePath() },
      {
        sessionId: "session-2",
        updatedAt: 1,
      },
    );

    await expect(beginRestartRecoveryTerminalDelivery(scope())).resolves.toBe("stale");
  });

  it("blocks a completed source after its active recovery claim is cleared", async () => {
    await replaceSessionEntry(
      { sessionKey, storePath: fixture.storePath() },
      {
        sessionId: "session-1",
        restartRecoveryTerminalRunIds: ["source-1"],
        updatedAt: 1,
      },
    );

    await expect(beginRestartRecoveryTerminalDelivery(scope())).resolves.toBe("blocked");
  });

  it("clears pending only after a proven non-delivery", async () => {
    await seedClaim();
    await beginRestartRecoveryTerminalDelivery(scope());

    await expect(cancelRestartRecoveryTerminalDelivery(scope())).resolves.toBe("cleared");
    expect(
      loadSessionEntry({ sessionKey, storePath: fixture.storePath() })
        ?.restartRecoveryDeliveryReceiptState,
    ).toBeUndefined();
    expect(
      loadSessionEntry({ sessionKey, storePath: fixture.storePath() })
        ?.restartRecoveryDeliveryToolCallId,
    ).toBeUndefined();
  });

  it("does not mutate a replacement session", async () => {
    await seedClaim({ sessionId: "session-2", sourceTurnId: "source-2" });

    await expect(beginRestartRecoveryTerminalDelivery(scope())).resolves.toBe("stale");
    await expect(completeRestartRecoveryTerminalDelivery(scope())).resolves.toBe("stale");
    await expect(cancelRestartRecoveryTerminalDelivery(scope())).resolves.toBe("stale");
    expect(
      loadSessionEntry({ sessionKey, storePath: fixture.storePath() })
        ?.restartRecoveryDeliveryReceiptState,
    ).toBeUndefined();
  });
});

describe("restart recovery receipt when the scope names a session that is not the sessionId owner", () => {
  // A caller can hold a session key that is not the durable run session: a runtime
  // that sandboxes tool calls keeps a separate policy key, and the gateway-owned
  // receipt path scopes with the request's identity session key, which is that
  // policy key. Only the sessionId is reliable on every path.
  const fixture = useTempSessionsFixture("restart-receipt-scope-");
  const REQUESTED_KEY = "agent:main:telegram:default:direct:123";
  const OWNING_KEY = "agent:main:main";

  function scope() {
    return {
      sessionId: "session-live",
      sessionKey: REQUESTED_KEY,
      sourceTurnId: "source-1",
      storePath: fixture.storePath(),
      toolCallId: "message-call-1",
    };
  }

  /** The leftover the requested key points at, from an earlier session. */
  async function seedStaleRequestedEntry() {
    await replaceSessionEntry(
      { sessionKey: REQUESTED_KEY, storePath: fixture.storePath() },
      { sessionId: "session-old", status: "done", updatedAt: 1 },
    );
  }

  async function seedOwningEntry(entry: Record<string, unknown>) {
    await replaceSessionEntry({ sessionKey: OWNING_KEY, storePath: fixture.storePath() }, {
      sessionId: "session-live",
      updatedAt: 2,
      ...entry,
    } as Parameters<typeof replaceSessionEntry>[1]);
  }

  it("arms the receipt on the session that owns the sessionId", async () => {
    await seedStaleRequestedEntry();
    await seedOwningEntry({
      status: "running",
      restartRecoveryDeliveryRunId: "recovery-1",
      restartRecoveryDeliverySourceRunId: "source-1",
    });

    await expect(beginRestartRecoveryTerminalDelivery(scope())).resolves.toBe("started");
    expect(
      loadSessionEntry({ sessionKey: OWNING_KEY, storePath: fixture.storePath() })
        ?.restartRecoveryDeliveryReceiptState,
    ).toBe("terminal-pending");
    // The leftover the scope named must not be touched.
    expect(
      loadSessionEntry({ sessionKey: REQUESTED_KEY, storePath: fixture.storePath() })
        ?.restartRecoveryDeliveryReceiptState,
    ).toBeUndefined();
    // And the receipt must be completable through the same re-anchoring.
    await expect(completeRestartRecoveryTerminalDelivery(scope())).resolves.toBe("recorded");
  });

  it("treats a claimless live owner as not-applicable instead of refusing the reply", async () => {
    // The observed production case: the owning session carries no claim at all,
    // which the claimless-live path is meant to allow through. Scoped at the
    // leftover instead, that path cannot match and the send is refused.
    await seedStaleRequestedEntry();
    await seedOwningEntry({ status: "running" });

    await expect(beginRestartRecoveryTerminalDelivery(scope())).resolves.toBe("not-applicable");
  });

  it("stays stale when no entry owns the sessionId", async () => {
    await seedStaleRequestedEntry();

    await expect(beginRestartRecoveryTerminalDelivery(scope())).resolves.toBe("stale");
  });

  it("defers to the canonical session-id resolver when several keys share the sessionId", async () => {
    // Not a strict-uniqueness rule: resolvePreferredSessionKeyForSessionIdMatches
    // is the same selector session_status, usage and transcript lookups already
    // use, and it picks the freshest match. Pinning that here so the receipt is
    // never quietly given its own, divergent notion of which session wins.
    await seedStaleRequestedEntry();
    await replaceSessionEntry(
      { sessionKey: "agent:main:other", storePath: fixture.storePath() },
      { sessionId: "session-live", status: "running", updatedAt: 2 },
    );
    await seedOwningEntry({
      status: "running",
      restartRecoveryDeliveryRunId: "recovery-1",
      restartRecoveryDeliverySourceRunId: "source-1",
      updatedAt: 3,
    });

    await expect(beginRestartRecoveryTerminalDelivery(scope())).resolves.toBe("started");
    expect(
      loadSessionEntry({ sessionKey: OWNING_KEY, storePath: fixture.storePath() })
        ?.restartRecoveryDeliveryReceiptState,
    ).toBe("terminal-pending");
  });
});
