import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { retainLegacyDefaultAgentId } from "../../config/legacy.default-agent-owner.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { clearAgentRunContext, registerAgentRunContext } from "../../infra/agent-run-registry.js";
import type { ChatAbortControllerEntry } from "../chat-abort.types.js";
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

vi.mock("../session-event-payload.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../session-event-payload.js")>();
  return {
    ...actual,
    buildGatewaySessionEventFields: ({
      sessionRow,
      hasActiveRun,
      activeRunIds,
    }: {
      sessionRow: { key: string; label: string };
      hasActiveRun?: boolean;
      activeRunIds?: string[] | null;
    }) => ({
      key: sessionRow.key,
      label: sessionRow.label,
      ...(hasActiveRun === undefined ? {} : { hasActiveRun }),
      ...(activeRunIds === undefined ? {} : { activeRunIds }),
    }),
  };
});

const { emitSessionsChanged, flushPendingSessionsChangedEvents, readSessionsMutationVersion } =
  await import("./session-change-event.js");

function createContext(
  receivers = new Set(["conn-1"]),
  config: OpenClawConfig = {},
  chatAbortControllers: GatewayRequestContext["chatAbortControllers"] = new Map(),
) {
  return {
    broadcastToConnIds: vi.fn(),
    chatAbortControllers,
    getRuntimeConfig: () => config,
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

  it("emits the latest trailing row by the sustained-mutation deadline", () => {
    const context = createContext();
    const sessionKey = "agent:main:chat";

    emitSessionsChanged(context, { reason: "leading", sessionKey });
    emitSessionsChanged(context, { reason: "update-0", sessionKey });
    for (let index = 1; index <= 5; index += 1) {
      vi.advanceTimersByTime(90);
      mocks.rowLabel = `state-${index}`;
      emitSessionsChanged(context, { reason: `update-${index}`, sessionKey });
    }

    vi.advanceTimersByTime(49);
    expect(context.broadcastToConnIds).toHaveBeenCalledOnce();

    vi.advanceTimersByTime(1);
    expect(context.broadcastToConnIds).toHaveBeenCalledTimes(2);
    expect(vi.mocked(context.broadcastToConnIds).mock.calls[1]?.[1]).toMatchObject({
      label: "state-5",
      reason: "update-5",
    });
  });

  it.each([false, true])("never samples a replacement for a delete (trailing: %s)", (trailing) => {
    const context = createContext();
    const sessionKey = "agent:main:chat";
    if (trailing) {
      emitSessionsChanged(context, { reason: "update", sessionKey });
    }
    mocks.loadRow.mockClear();
    const deletion = { reason: "delete", sessionKey, sessionId: "generation-a", agentId: "main" };
    emitSessionsChanged(context, deletion);
    mocks.rowLabel = "replacement-b";
    vi.advanceTimersByTime(100);
    const payload = vi.mocked(context.broadcastToConnIds).mock.calls.at(-1)?.[1];
    expect(payload).toEqual({
      ...deletion,
      agentId: "main",
      ts: expect.any(Number),
    });
    expect(mocks.loadRow).not.toHaveBeenCalled();
  });

  it("keeps different session keys independent", () => {
    const context = createContext();

    emitSessionsChanged(context, { reason: "update", sessionKey: "agent:main:first" });
    emitSessionsChanged(context, { reason: "update", sessionKey: "agent:main:second" });

    expect(context.broadcastToConnIds).toHaveBeenCalledTimes(2);
    expect(mocks.loadRow).toHaveBeenCalledTimes(2);
  });

  it("does not adopt the compatibility owner's ownerless run for another agent", () => {
    const config = retainLegacyDefaultAgentId(
      {
        agents: { ownership: "explicit", entries: { ops: {}, research: {} } },
      },
      "ops",
    );
    const sessionId = "agent:research:shared-session-id";
    const context = createContext(
      new Set(["conn-1"]),
      config,
      new Map([
        [
          "compat-owner-run",
          {
            controller: new AbortController(),
            expiresAtMs: 60_000,
            sessionId,
            sessionKey: "legacy-unscoped",
            startedAtMs: 0,
          } satisfies ChatAbortControllerEntry,
        ],
      ]),
    );

    emitSessionsChanged(context, {
      reason: "update",
      sessionKey: "agent:research:shared-session",
    });

    expect(context.broadcastToConnIds).toHaveBeenCalledWith(
      "sessions.changed",
      expect.objectContaining({ hasActiveRun: false, activeRunIds: [] }),
      expect.anything(),
      expect.anything(),
    );
  });

  it("projects active bare-global runs through the persisted fixed-store owner", () => {
    const config = {
      session: { scope: "global", store: "/stores/shared.sqlite" },
      agents: {
        ownership: "explicit",
        defaults: { sessionStore: { agentId: "ops" } },
        entries: { ops: {}, research: {} },
      },
    } satisfies OpenClawConfig;
    const context = createContext(
      new Set(["conn-1"]),
      config,
      new Map([
        [
          "ops-global-run",
          {
            agentId: "ops",
            controller: new AbortController(),
            expiresAtMs: 60_000,
            sessionId: "global-id",
            sessionKey: "global",
            startedAtMs: 0,
          } satisfies ChatAbortControllerEntry,
        ],
      ]),
    );

    emitSessionsChanged(context, { reason: "update", sessionKey: "global" });

    expect(context.broadcastToConnIds).toHaveBeenCalledWith(
      "sessions.changed",
      expect.objectContaining({
        activeRunIds: ["ops-global-run"],
        hasActiveRun: true,
      }),
      expect.anything(),
      expect.objectContaining({
        agentId: "ops",
        sessionKeys: ["global"],
      }),
    );
    const payload = vi.mocked(context.broadcastToConnIds).mock.calls[0]?.[1];
    expect(payload).not.toHaveProperty("agentId");
    expect(payload).not.toHaveProperty("goal");
  });

  it("keeps a retired fixed-store owner private after the mutation commits", () => {
    const config = {
      session: { scope: "global", store: "/stores/shared.sqlite" },
      agents: {
        ownership: "explicit",
        defaults: { sessionStore: { agentId: "ops" } },
        entries: { research: {} },
      },
    } satisfies OpenClawConfig;
    const context = createContext(new Set(["conn-1"]), config);

    emitSessionsChanged(context, { reason: "update", sessionKey: "global" });

    expect(mocks.loadRow).not.toHaveBeenCalled();
    expect(context.broadcastToConnIds).toHaveBeenCalledWith(
      "sessions.changed",
      expect.objectContaining({ sessionKey: "global", reason: "update" }),
      new Set(["conn-1"]),
      {
        agentId: "ops",
        dropIfSlow: true,
        sessionKeys: ["agent:ops:global"],
      },
    );
    const payload = vi.mocked(context.broadcastToConnIds).mock.calls[0]?.[1];
    for (const field of [
      "agentId",
      "key",
      "label",
      "session",
      "goal",
      "status",
      "hasActiveRun",
      "activeRunIds",
    ]) {
      expect(payload, field).not.toHaveProperty(field);
    }
  });

  it("tombstones exact run ids when lifecycle projection takes ownership", () => {
    const sessionKey = "agent:main:projected";
    const sessionId = `${sessionKey}-id`;
    const chatAbortControllers = new Map([
      [
        "direct-run",
        {
          agentId: "main",
          controller: new AbortController(),
          expiresAtMs: 60_000,
          sessionId,
          sessionKey,
          startedAtMs: 0,
        } satisfies ChatAbortControllerEntry,
      ],
    ]);
    const context = createContext(new Set(["conn-1"]), {}, chatAbortControllers);

    emitSessionsChanged(context, { reason: "update", sessionKey });
    expect(vi.mocked(context.broadcastToConnIds).mock.calls[0]?.[1]).toMatchObject({
      hasActiveRun: true,
      activeRunIds: ["direct-run"],
    });

    chatAbortControllers.clear();
    registerAgentRunContext("hidden-worker-run", {
      isControlUiVisible: false,
      projectSessionActive: true,
      sessionKey,
    });
    try {
      emitSessionsChanged(context, { reason: "update", sessionKey });
      flushPendingSessionsChangedEvents(context);

      const payload = vi.mocked(context.broadcastToConnIds).mock.calls[1]?.[1];
      expect(payload).toMatchObject({ hasActiveRun: true });
      expect(payload).toHaveProperty("activeRunIds", null);
    } finally {
      clearAgentRunContext("hidden-worker-run");
    }
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
