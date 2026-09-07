// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import { SessionActivityController } from "./session-activity-controller.ts";

const active: GatewaySessionRow = {
  key: "agent:work:release",
  agentId: "work",
  sessionId: "release-session",
  kind: "direct",
  updatedAt: 100,
  status: "running",
  hasActiveRun: true,
  activeRunIds: ["release-run"],
};
const listing = (sessions: GatewaySessionRow[]): SessionsListResult => ({
  ts: 100,
  path: "",
  count: sessions.length,
  totalCount: sessions.length,
  hasMore: false,
  sessions,
  defaults: { model: null, modelProvider: null, contextTokens: null },
});

function setup() {
  const client = new GatewayBrowserClient({ url: "ws://fixture.invalid" });
  const request = vi.spyOn(client, "request").mockResolvedValue(listing([active]));
  const publications: Array<readonly GatewaySessionRow[] | undefined> = [];
  const controller = new SessionActivityController({
    addController() {},
    removeController() {},
    requestUpdate() {
      publications.push(controller.result?.sessions);
    },
    updateComplete: Promise.resolve(true),
  });
  return { client, request, controller, publications };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("loads a bounded current-work query independently of chat, people, and recency", async () => {
  const { client, request, controller } = setup();
  try {
    controller.load(client, "current");
    await vi.waitFor(() => expect(controller.result?.sessions).toEqual([active]));
    expect(request).toHaveBeenCalledExactlyOnceWith(
      "sessions.list",
      {
        activeOnly: true,
        archived: "all",
        includeGlobal: true,
        includeUnknown: true,
        includeDerivedTitles: true,
        limit: 100,
      },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  } finally {
    controller.hostDisconnected();
  }
});

it.each([false, true])(
  "publishes usable snapshots while new work keeps starting (refresh: %s)",
  async (refresh) => {
    vi.useFakeTimers();
    const { client, request, controller } = setup();
    try {
      if (refresh) {
        request.mockResolvedValueOnce(listing([]));
        controller.load(client, "current");
        await vi.advanceTimersByTimeAsync(0);
      }
      const responses = Array.from({ length: 4 }, () => createDeferred<SessionsListResult>());
      for (const response of responses) {
        request.mockReturnValueOnce(response.promise);
      }
      controller.load(client, "current", refresh ? "refresh" : "query");
      const observed: Array<GatewaySessionRow[] | undefined> = [];
      for (let round = 0; round < 3; round += 1) {
        const transient = {
          key: `agent:work:transient-${round}`,
          agentId: "work",
          sessionId: `transient-session-${round}`,
          runId: `transient-run-${round}`,
          updatedAt: 200 + round * 2,
        };
        controller.invalidate({
          ...transient,
          hasActiveRun: true,
          activeRunIds: [transient.runId],
          status: "running",
        });
        responses[round]!.resolve(listing([active]));
        await vi.advanceTimersByTimeAsync(0);
        observed.push(controller.result?.sessions);
        // This short turn finishes before the next snapshot captures membership.
        controller.invalidate({
          ...transient,
          updatedAt: transient.updatedAt + 1,
          hasActiveRun: false,
          activeRunIds: [],
          status: "done",
        });
        await vi.advanceTimersByTimeAsync(200);
      }
      expect(controller.incomplete).toBe(true);
      responses[3]!.resolve(listing([active]));
      await vi.advanceTimersByTimeAsync(0);
      expect(controller.result?.sessions).toEqual([active]);
      expect(controller.loading).toBe(false);
      expect(observed).toEqual([[active], [active], [active]]);
      expect(request).toHaveBeenCalledTimes(refresh ? 5 : 4);
    } finally {
      controller.hostDisconnected();
    }
  },
);

it("keeps an incomplete empty snapshot loading and permits retry after catch-up fails", async () => {
  vi.useFakeTimers();
  const { client, request, controller } = setup();
  try {
    const pending = createDeferred<SessionsListResult>();
    request.mockReturnValueOnce(pending.promise).mockRejectedValueOnce(new Error("Unavailable"));
    controller.load(client, "current");
    controller.invalidate({ ...active, updatedAt: 200 });
    pending.resolve(listing([]));
    await vi.advanceTimersByTimeAsync(0);
    expect(controller.result?.sessions).toEqual([]);
    expect(controller.incomplete).toBe(true);
    expect(controller.loading).toBe(true);
    await vi.advanceTimersByTimeAsync(200);
    expect(controller.error).toBe("Unavailable");
    expect(controller.loading).toBe(false);
    controller.load(client, "current", "retry");
    await vi.advanceTimersByTimeAsync(0);
    expect(controller.error).toBeUndefined();
    expect(controller.result?.sessions).toEqual([active]);
    expect(controller.incomplete).toBe(false);
  } finally {
    controller.hostDisconnected();
  }
});

it.each([false, true])(
  "does not resurrect completed work after a stale snapshot (another turn: %s)",
  async (anotherTurn) => {
    vi.useFakeTimers();
    const { client, request, controller, publications } = setup();
    try {
      controller.load(client, "current");
      await vi.advanceTimersByTimeAsync(0);
      const stale = createDeferred<SessionsListResult>();
      request.mockReturnValueOnce(stale.promise).mockResolvedValue(listing([]));
      controller.load(client, "current", "refresh");
      controller.invalidate({
        ...active,
        updatedAt: 200,
        hasActiveRun: false,
        activeRunIds: [],
        status: "done",
      });
      expect(controller.result?.sessions).toEqual([]);
      if (anotherTurn) {
        controller.invalidate({
          ...active,
          updatedAt: 201,
          runId: "next-run",
          activeRunIds: ["next-run"],
          status: "running",
        });
        controller.invalidate({
          ...active,
          updatedAt: 202,
          runId: "next-run",
          hasActiveRun: false,
          activeRunIds: [],
          status: "done",
        });
      }
      const terminalPublication = publications.length;
      stale.resolve(listing([active]));
      await vi.advanceTimersByTimeAsync(200);
      expect(controller.result?.sessions).toEqual([]);
      expect(
        publications
          .slice(terminalPublication)
          .some((rows) => rows?.some((row) => row.hasActiveRun)),
      ).toBe(false);
      expect(request).toHaveBeenCalledTimes(3);
    } finally {
      controller.hostDisconnected();
    }
  },
);

it("retires current work on disconnect and only accepts the replacement query", async () => {
  vi.useFakeTimers();
  const { client, request, controller } = setup();
  try {
    controller.load(client, "current");
    await vi.advanceTimersByTimeAsync(0);
    const stale = createDeferred<SessionsListResult>();
    request.mockReturnValueOnce(stale.promise);
    controller.load(client, "current", "refresh");
    controller.load(null, null);
    expect(controller.result).toBeUndefined();
    expect(controller.incomplete).toBe(false);
    request.mockResolvedValue(listing([]));
    controller.load(client, "current");
    stale.resolve(listing([active]));
    await vi.advanceTimersByTimeAsync(0);
    expect(controller.result?.sessions).toEqual([]);
  } finally {
    controller.hostDisconnected();
  }
});

it.each([false, true])(
  "reconciles overlapping completions during a snapshot (both finish: %s)",
  async (bothFinish) => {
    vi.useFakeTimers();
    const { client, request, controller, publications } = setup();
    const overlap = { ...active, activeRunIds: ["release-run", "overlap-run"] };
    try {
      request.mockResolvedValue(listing([overlap]));
      controller.load(client, "current");
      await vi.advanceTimersByTimeAsync(0);
      const stale = createDeferred<SessionsListResult>();
      const remaining = { ...active, activeRunIds: ["overlap-run"] };
      request
        .mockReturnValueOnce(stale.promise)
        .mockResolvedValue(listing(bothFinish ? [] : [remaining]));
      controller.load(client, "current", "refresh");
      const terminal = {
        key: active.key,
        agentId: active.agentId,
        sessionId: active.sessionId,
        status: "done",
      };
      controller.invalidate({ ...terminal, runId: "release-run" });
      expect(controller.result?.sessions[0]?.activeRunIds).toEqual(["overlap-run"]);
      if (bothFinish) {
        controller.invalidate({ ...terminal, runId: "overlap-run" });
        expect(controller.result?.sessions).toEqual([]);
      }
      const terminalPublication = publications.length;
      stale.resolve(listing([overlap]));
      await vi.advanceTimersByTimeAsync(0);
      expect(controller.result?.sessions.map((row) => row.activeRunIds)).toEqual(
        bothFinish ? [] : [["overlap-run"]],
      );
      expect(
        publications
          .slice(terminalPublication)
          .some((rows) => rows?.some((row) => row.activeRunIds?.includes("release-run"))),
      ).toBe(false);
      await vi.advanceTimersByTimeAsync(200);
      expect(request).toHaveBeenCalledTimes(3);
    } finally {
      controller.hostDisconnected();
    }
  },
);

it.each([{ activeRunIds: ["next-run"] }, { activeRunIds: null }])(
  "uses canonical replacement liveness before a delayed old completion (run IDs: %j)",
  async ({ activeRunIds }) => {
    vi.useFakeTimers();
    const { client, request, controller } = setup();
    const replacement = {
      ...active,
      updatedAt: 200,
      status: "queued" as const,
      activeRunIds: activeRunIds ?? undefined,
    };
    try {
      controller.load(client, "current");
      await vi.advanceTimersByTimeAsync(0);
      const stale = createDeferred<SessionsListResult>();
      request.mockReturnValueOnce(stale.promise).mockResolvedValue(listing([replacement]));
      controller.load(client, "current", "refresh");
      controller.invalidate({ ...replacement, runId: "next-run", activeRunIds });
      expect(controller.result?.sessions).toEqual([replacement]);
      controller.invalidate({
        ...active,
        key: "agent:work:another-session",
        sessionId: "another-session",
        updatedAt: 200,
      });
      controller.invalidate({
        key: active.key,
        agentId: active.agentId,
        sessionId: active.sessionId,
        updatedAt: 201,
        runId: "release-run",
        hasActiveRun: false,
        activeRunIds: [],
        status: "done",
      });
      expect(controller.result?.sessions).toEqual([replacement]);
      stale.resolve(listing([active]));
      await vi.advanceTimersByTimeAsync(0);
      expect(controller.result?.sessions).toEqual([replacement]);
      await vi.advanceTimersByTimeAsync(200);
      expect(controller.result?.sessions).toEqual([replacement]);
      expect(request).toHaveBeenCalledTimes(3);
    } finally {
      controller.hostDisconnected();
    }
  },
);

it.each([false, undefined])(
  "keeps a replacement run after an older terminal event (active flag: %s)",
  async (hasActiveRun) => {
    vi.useFakeTimers();
    const { client, controller } = setup();
    try {
      controller.load(client, "current");
      await vi.advanceTimersByTimeAsync(0);
      controller.invalidate({
        key: active.key,
        agentId: active.agentId,
        sessionId: active.sessionId,
        runId: "retired-run",
        status: "done",
        hasActiveRun,
      });
      expect(controller.result?.sessions).toEqual([active]);
    } finally {
      controller.hostDisconnected();
    }
  },
);

it("keeps globals owned by other agents, literal global keys and replacement sessions distinct", async () => {
  vi.useFakeTimers();
  const { client, request, controller } = setup();
  const main = { ...active, key: "global", agentId: "main", sessionId: "main-global" };
  const work = { ...active, key: "global", agentId: "work", sessionId: "work-global" };
  const literal = { ...active, key: "agent:work:global", sessionId: "literal-global" };
  try {
    const pending = createDeferred<SessionsListResult>();
    request.mockReturnValueOnce(pending.promise).mockResolvedValue(listing([work, literal]));
    controller.load(client, "current");
    controller.invalidate({
      ...main,
      updatedAt: 200,
      hasActiveRun: false,
      activeRunIds: [],
      status: "done",
    });
    controller.invalidate({
      ...work,
      sessionId: "retired-work-global",
      updatedAt: 201,
      hasActiveRun: false,
      activeRunIds: [],
      status: "done",
    });
    pending.resolve(listing([main, work, literal]));
    await vi.advanceTimersByTimeAsync(0);
    expect(controller.result?.sessions).toEqual([work, literal]);
  } finally {
    controller.hostDisconnected();
  }
});
