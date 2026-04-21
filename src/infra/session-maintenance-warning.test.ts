import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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
  deliverOutboundPayloads: vi.fn(async () => []),
  enqueueSystemEvent: vi.fn(),
}));

type SessionMaintenanceWarningModule = typeof import("./session-maintenance-warning.js");

let deliverSessionMaintenanceWarning: SessionMaintenanceWarningModule["deliverSessionMaintenanceWarning"];
let resetSessionMaintenanceWarningForTests: SessionMaintenanceWarningModule["__testing"]["resetSessionMaintenanceWarningForTests"];

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
      __testing: { resetSessionMaintenanceWarningForTests },
    } = await import("./session-maintenance-warning.js"));
  });

  beforeEach(() => {
    prevVitest = process.env.VITEST;
    prevNodeEnv = process.env.NODE_ENV;
    delete process.env.VITEST;
    process.env.NODE_ENV = "development";
    resetSessionMaintenanceWarningForTests();
    mocks.resolveSessionAgentId.mockClear();
    mocks.deliveryContextFromSession.mockClear();
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

    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "mobilechat",
        to: "+15550001",
        session: { key: "agent:main:main", agentId: "agent-from-key" },
      }),
    );
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

    await deliverSessionMaintenanceWarning(
      createParams({
        warning: {
          pruneAfterMs: 3_600_000,
          maxEntries: 10,
          wouldPrune: false,
          wouldCap: true,
        } as never,
      }),
    );

    expect(mocks.deliverOutboundPayloads).not.toHaveBeenCalled();
    expect(mocks.enqueueSystemEvent).toHaveBeenCalledWith(
      expect.stringContaining("most recent 10 sessions"),
      expect.objectContaining({ sessionKey: expect.stringContaining("agent:") }),
    );
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

    await deliverSessionMaintenanceWarning(createParams());

    expect(mocks.enqueueSystemEvent).toHaveBeenCalledWith(
      expect.stringContaining("older than 1 second"),
      expect.objectContaining({ sessionKey: expect.stringContaining("agent:") }),
    );
  });
});
