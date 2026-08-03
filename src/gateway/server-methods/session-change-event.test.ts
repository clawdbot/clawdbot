import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayRequestContext } from "./types.js";

const mocks = vi.hoisted(() => ({
  invalidate: vi.fn(),
  loadRow: vi.fn(),
  rowLabel: "first",
}));

vi.mock("../session-sharing.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../session-sharing.js")>();
  return { ...actual, invalidateSessionSharingSnapshot: mocks.invalidate };
});

vi.mock("../session-utils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../session-utils.js")>();
  return {
    ...actual,
    loadGatewaySessionRow: mocks.loadRow.mockImplementation((key: string) => ({
      key,
      label: mocks.rowLabel,
      sessionId: `${key}-id`,
    })),
  };
});

vi.mock("../session-event-payload.js", () => ({
  buildGatewaySessionEventFields: ({
    sessionRow,
  }: {
    sessionRow: { key: string; label: string };
  }) => ({ key: sessionRow.key, label: sessionRow.label }),
}));

vi.mock("./session-active-runs.js", () => ({
  resolveVisibleActiveSessionRunState: () => ({ active: false, runIds: [] }),
}));

const { emitSessionsChanged, flushPendingSessionsChangedEvents, readSessionsMutationVersion } =
  await import("./session-change-event.js");

function createContext(receivers = new Set(["conn-1"])) {
  return {
    broadcastToConnIds: vi.fn(),
    chatAbortControllers: new Map(),
    getRuntimeConfig: () => ({}),
    getSessionEventSubscriberConnIds: () => receivers,
  } as unknown as GatewayRequestContext;
}

beforeEach(() => {
  vi.useFakeTimers();
  mocks.invalidate.mockClear();
  mocks.loadRow.mockClear();
  mocks.rowLabel = "first";
});

afterEach(() => {
  flushPendingSessionsChangedEvents();
  vi.useRealTimers();
});

describe("sessions.changed coalescing", () => {
  it("emits a leading row and one trailing row with the latest state", () => {
    const context = createContext();
    const initialVersion = readSessionsMutationVersion(context);

    emitSessionsChanged(context, { reason: "create", sessionKey: "agent:main:chat" });
    mocks.rowLabel = "latest";
    emitSessionsChanged(context, { reason: "update", sessionKey: "agent:main:chat" });
    emitSessionsChanged(context, { reason: "send", sessionKey: "agent:main:chat" });

    expect(context.broadcastToConnIds).toHaveBeenCalledOnce();
    expect(mocks.loadRow).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(100);

    expect(context.broadcastToConnIds).toHaveBeenCalledTimes(2);
    expect(mocks.loadRow).toHaveBeenCalledTimes(2);
    expect(vi.mocked(context.broadcastToConnIds).mock.calls[1]?.[1]).toMatchObject({
      label: "latest",
      reason: "send",
    });
    expect(readSessionsMutationVersion(context)).toBe(initialVersion + 3);
    expect(mocks.invalidate).toHaveBeenCalledTimes(3);
  });

  it("keeps different session keys independent", () => {
    const context = createContext();

    emitSessionsChanged(context, { reason: "update", sessionKey: "agent:main:first" });
    emitSessionsChanged(context, { reason: "update", sessionKey: "agent:main:second" });

    expect(context.broadcastToConnIds).toHaveBeenCalledTimes(2);
    expect(mocks.loadRow).toHaveBeenCalledTimes(2);
  });

  it("advances the mutation fence without loading rows when nobody receives events", () => {
    const context = createContext(new Set());
    const initialVersion = readSessionsMutationVersion(context);

    emitSessionsChanged(context, { reason: "update", sessionKey: "agent:main:chat" });

    expect(readSessionsMutationVersion(context)).toBe(initialVersion + 1);
    expect(mocks.invalidate).toHaveBeenCalledOnce();
    expect(mocks.loadRow).not.toHaveBeenCalled();
    expect(context.broadcastToConnIds).not.toHaveBeenCalled();
  });

  it("flushes the latest trailing row and clears its shutdown timer", () => {
    const context = createContext();
    emitSessionsChanged(context, { reason: "create", sessionKey: "agent:main:chat" });
    mocks.rowLabel = "shutdown-latest";
    emitSessionsChanged(context, { reason: "send", sessionKey: "agent:main:chat" });

    flushPendingSessionsChangedEvents(context);
    expect(context.broadcastToConnIds).toHaveBeenCalledTimes(2);
    expect(vi.mocked(context.broadcastToConnIds).mock.calls[1]?.[1]).toMatchObject({
      label: "shutdown-latest",
      reason: "send",
    });

    vi.advanceTimersByTime(100);
    expect(context.broadcastToConnIds).toHaveBeenCalledTimes(2);
  });
});
