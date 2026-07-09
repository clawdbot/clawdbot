// Tests session maintenance warning formatting and suppression.
import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

type DeliveryCall = {
  channel?: string;
  to?: string;
  session?: {
    agentId?: string;
    key?: string;
  };
};

const mocks = vi.hoisted(() => ({
  resolveSessionAgentId: vi.fn(() => "agent-from-key"),
  deliveryContextFromSession: vi.fn(() => ({
    channel: "mobilechat",
    to: "+15550001",
    accountId: "acct-1",
    threadId: "thread-1",
  })),
  normalizeMessageChannel: vi.fn((channel: string) => channel),
  isDeliverableMessageChannel: vi.fn(() => true),
  deliverOutboundPayloads: vi.fn(async (_params: DeliveryCall) => []),
  enqueueSystemEvent: vi.fn(),
}));

vi.mock("./outbound/deliver.js", () => ({
  deliverOutboundPayloads: mocks.deliverOutboundPayloads,
  deliverOutboundPayloadsInternal: mocks.deliverOutboundPayloads,
}));

type SessionMaintenanceWarningModule = typeof import("./session-maintenance-warning.js");

let deliverSessionMaintenanceWarning: SessionMaintenanceWarningModule["deliverSessionMaintenanceWarning"];
let resetSessionMaintenanceWarningForTests: SessionMaintenanceWarningModule["testing"]["resetSessionMaintenanceWarningForTests"];

function createParams(
  overrides: Partial<Parameters<typeof deliverSessionMaintenanceWarning>[0]> = {},
): Parameters<typeof deliverSessionMaintenanceWarning>[0] {
  const sessionKey = overrides.sessionKey ?? `agent:${randomUUID()}:main`;
  return {
    cfg: {},
    sessionKey,
    entry: {} as never,
    warning: {
      activeSessionKey: sessionKey,
      pruneAfterMs: 1_000,
      maxEntries: 100,
      wouldPrune: true,
      wouldCap: false,
      ...(overrides.warning as object),
    } as never,
    ...overrides,
  };
}

function expectedMaintenanceWarning(reasonText: string): string {
  return (
    `\u26A0\uFE0F Session maintenance warning: this active session would be evicted (${reasonText}). ` +
    `Maintenance is set to warn-only, so nothing was reset. ` +
    `To enforce cleanup, set \`session.maintenance.mode: "enforce"\` or increase the limits.`
  );
}

function firstDeliveryParams(): DeliveryCall | undefined {
  return mocks.deliverOutboundPayloads.mock.calls[0]?.[0];
}

function firstSystemEventCall() {
  return mocks.enqueueSystemEvent.mock.calls[0];
}

describe("deliverSessionMaintenanceWarning", () => {
  let prevVitest: string | undefined;
  let prevNodeEnv: string | undefined;

  beforeAll(async () => {
    vi.doMock("../agents/agent-scope.js", () => ({
      resolveSessionAgentId: mocks.resolveSessionAgentId,
    }));
    vi.doMock("../utils/message-channel.js", () => ({
      normalizeMessageChannel: mocks.normalizeMessageChannel,
      isDeliverableMessageChannel: mocks.isDeliverableMessageChannel,
    }));
    vi.doMock("../utils/delivery-context.shared.js", () => ({
      deliveryContextFromSession: mocks.deliveryContextFromSession,
    }));
    vi.doMock("./outbound/deliver-runtime.js", () => ({
      deliverOutboundPayloads: mocks.deliverOutboundPayloads,
    }));
    vi.doMock("./system-events.js", () => ({
      enqueueSystemEvent: mocks.enqueueSystemEvent,
    }));
    ({
      deliverSessionMaintenanceWarning,
      testing: { resetSessionMaintenanceWarningForTests },
    } = await import("./session-maintenance-warning.js"));
  });

  beforeEach(() => {
    prevVitest = process.env.VITEST;
    prevNodeEnv = process.env.NODE_ENV;
    delete process.env.VITEST;
    process.env.NODE_ENV = "development";
    resetSessionMaintenanceWarningForTests();
    mocks.resolveSessionAgentId.mockClear();
    mocks.deliveryContextFromSession.mockReset();
    mocks.deliveryContextFromSession.mockReturnValue({
      channel: "mobilechat",
      to: "+15550001",
      accountId: "acct-1",
      threadId: "thread-1",
    });
    mocks.normalizeMessageChannel.mockClear();
    mocks.isDeliverableMessageChannel.mockClear();
    mocks.deliverOutboundPayloads.mockClear();
    mocks.enqueueSystemEvent.mockClear();
  });

  afterEach(() => {
    if (prevVitest === undefined) {
      delete process.env.VITEST;
    } else {
      process.env.VITEST = prevVitest;
    }
    if (prevNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = prevNodeEnv;
    }
  });

  it("forwards session context to outbound delivery", async () => {
    const params = createParams({ sessionKey: "agent:main:main" });

    await deliverSessionMaintenanceWarning(params);

    const deliveryParams = firstDeliveryParams();
    expect(deliveryParams?.channel).toBe("mobilechat");
    expect(deliveryParams?.to).toBe("+15550001");
    expect(deliveryParams?.session).toEqual({
      key: "agent:main:main",
      agentId: "agent-from-key",
    });
    expect(mocks.enqueueSystemEvent).not.toHaveBeenCalled();
  });

  it("suppresses duplicate warning contexts for the same session", async () => {
    const params = createParams();

    await deliverSessionMaintenanceWarning(params);
    await deliverSessionMaintenanceWarning(params);

    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledTimes(1);
  });

  it("falls back to a system event when the last target is not deliverable", async () => {
    mocks.deliveryContextFromSession.mockReturnValueOnce({
      channel: "debug",
      to: "+15550001",
      accountId: "acct-1",
      threadId: "thread-1",
    });
    mocks.isDeliverableMessageChannel.mockReturnValueOnce(false);

    const params = createParams({
      warning: {
        pruneAfterMs: 3_600_000,
        maxEntries: 10,
        wouldPrune: false,
        wouldCap: true,
      } as never,
    });

    await deliverSessionMaintenanceWarning(params);

    expect(mocks.deliverOutboundPayloads).not.toHaveBeenCalled();
    expect(mocks.enqueueSystemEvent).toHaveBeenCalledTimes(1);
    expect(firstSystemEventCall()).toEqual([
      expectedMaintenanceWarning("not in the most recent 10 sessions"),
      { sessionKey: params.sessionKey },
    ]);
  });

  it("skips warning delivery in test mode", async () => {
    process.env.NODE_ENV = "test";

    await deliverSessionMaintenanceWarning(createParams());

    expect(mocks.deliveryContextFromSession).not.toHaveBeenCalled();
    expect(mocks.deliverOutboundPayloads).not.toHaveBeenCalled();
    expect(mocks.enqueueSystemEvent).not.toHaveBeenCalled();
  });

  it("enqueues a system event when outbound delivery fails", async () => {
    mocks.deliverOutboundPayloads.mockRejectedValueOnce(new Error("boom"));
    const params = createParams();

    await deliverSessionMaintenanceWarning(params);

    expect(mocks.enqueueSystemEvent).toHaveBeenCalledTimes(1);
    expect(firstSystemEventCall()).toEqual([
      expectedMaintenanceWarning("older than 1 second"),
      { sessionKey: params.sessionKey },
    ]);
  });

  it.each([
    [59_500, "60 seconds", "1 minute"],
    [3_570_000, "60 minutes", "1 hour"],
    [86_370_000, "24 hours", "1 day"],
  ])(
    "formatDuration rolls over %dms to next unit instead of %s",
    async (pruneAfterMs, _buggyOutput, expected) => {
      mocks.deliverOutboundPayloads.mockRejectedValueOnce(new Error("force system event"));
      const params = createParams({
        warning: { pruneAfterMs, wouldPrune: true, wouldCap: false, maxEntries: 100 } as never,
      });

      await deliverSessionMaintenanceWarning(params);

      expect(firstSystemEventCall()?.[0]).toContain(`older than ${expected}`);
    },
  );

  it.each([
    [30_000, "30 seconds"],
    [89_500, "1 minute"],
    [1_800_000, "30 minutes"],
    [5_370_000, "1 hour"],
    [43_200_000, "12 hours"],
    [129_570_000, "1 day"],
  ])("formatDuration keeps %dms in its own unit as %s", async (pruneAfterMs, expected) => {
    mocks.deliverOutboundPayloads.mockRejectedValueOnce(new Error("force system event"));
    const params = createParams({
      warning: { pruneAfterMs, wouldPrune: true, wouldCap: false, maxEntries: 100 } as never,
    });

    await deliverSessionMaintenanceWarning(params);

    expect(firstSystemEventCall()?.[0]).toContain(`older than ${expected}`);
  });

  it("keeps a recently used context while evicting the least-recently-used entry", async () => {
    const maxEntries = 4096;
    const createSessionParams = (sessionKey: string) =>
      createParams({
        sessionKey,
        warning: {
          activeSessionKey: sessionKey,
          pruneAfterMs: 1_000,
          maxEntries: 100,
          wouldPrune: true,
          wouldCap: false,
        } as never,
      });
    mocks.deliveryContextFromSession.mockReturnValue(undefined as never);

    for (let i = 0; i < maxEntries; i++) {
      await deliverSessionMaintenanceWarning(createSessionParams(`session:${i}`));
    }
    expect(mocks.enqueueSystemEvent).toHaveBeenCalledTimes(4096);

    // A duplicate read promotes session:0 from the LRU head without re-delivering.
    await deliverSessionMaintenanceWarning(createSessionParams("session:0"));
    expect(mocks.enqueueSystemEvent).toHaveBeenCalledTimes(4096);

    // Overflow evicts session:1 instead of the recently used session:0.
    await deliverSessionMaintenanceWarning(createSessionParams("session:extra"));
    expect(mocks.enqueueSystemEvent).toHaveBeenCalledTimes(4097);
    await deliverSessionMaintenanceWarning(createSessionParams("session:0"));
    expect(mocks.enqueueSystemEvent).toHaveBeenCalledTimes(4097);
    await deliverSessionMaintenanceWarning(createSessionParams("session:1"));
    expect(mocks.enqueueSystemEvent).toHaveBeenCalledTimes(4098);
  });

  it("re-delivers when the warning context changes for the same session", async () => {
    const sessionKey = `agent:${randomUUID()}:main`;
    const params = createParams({ sessionKey });
    await deliverSessionMaintenanceWarning(params);
    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledTimes(1);

    const changedParams = createParams({
      sessionKey,
      warning: {
        activeSessionKey: sessionKey,
        pruneAfterMs: 86_400_000,
        maxEntries: 500,
        wouldPrune: true,
        wouldCap: true,
      } as never,
    });
    await deliverSessionMaintenanceWarning(changedParams);
    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledTimes(2);
  });
});
