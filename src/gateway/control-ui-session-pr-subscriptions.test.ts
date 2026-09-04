import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { ControlUiSessionPullRequests } from "./control-ui-contract.js";
import {
  createControlUiSessionPullRequestSubscriptions,
  parseControlUiSessionPullRequestsSubscribeParams,
} from "./control-ui-session-pr-subscriptions.js";
import type { ControlUiSessionPullRequestsParams } from "./control-ui-session-prs.js";

const CHANGED_EVENT = "controlUi.sessionPullRequests.changed";

const READY: ControlUiSessionPullRequests = {
  pullRequests: [],
  rateLimited: false,
};

let active: ReturnType<typeof createControlUiSessionPullRequestSubscriptions> | undefined;

afterEach(() => {
  active?.stop();
  active = undefined;
  vi.useRealTimers();
});

describe("control UI session PR subscriptions", () => {
  it("bounds retained subscription keys", () => {
    expect(
      parseControlUiSessionPullRequestsSubscribeParams({
        sessionKeys: Array.from({ length: 201 }, (_value, index) => `session-${index}`),
      }),
    ).toBeNull();
    expect(
      parseControlUiSessionPullRequestsSubscribeParams({ sessionKeys: ["x".repeat(513)] }),
    ).toBeNull();
    expect(
      parseControlUiSessionPullRequestsSubscribeParams({ sessionKeys: ["x".repeat(512)] }),
    ).not.toBeNull();
    expect(
      parseControlUiSessionPullRequestsSubscribeParams({
        sessionKeys: ["watched"],
        refreshSessionKeys: ["watched"],
      }),
    ).toEqual({ sessionKeys: ["watched"], refreshSessionKeys: ["watched"] });
    expect(
      parseControlUiSessionPullRequestsSubscribeParams({
        sessionKeys: ["watched"],
        refreshSessionKeys: ["other"],
      }),
    ).toBeNull();
  });

  it("pushes an initial snapshot and only changed snapshots afterwards", async () => {
    vi.useFakeTimers();
    let state = "open" as "open" | "merged";
    const load = vi.fn(async () => ({
      pullRequests: [
        {
          number: 1,
          owner: "openclaw",
          repo: "openclaw",
          branch: "feature/demo",
          title: "Demo",
          url: "https://example.test/pr/1",
          state,
        },
      ],
      rateLimited: false,
    }));
    const broadcastToConnIds = vi.fn();
    active = createControlUiSessionPullRequestSubscriptions({ broadcastToConnIds, load });

    await active.replace("conn-a", ["agent:main:demo"]);
    expect(broadcastToConnIds).toHaveBeenCalledTimes(1);
    expect(broadcastToConnIds).toHaveBeenLastCalledWith(
      CHANGED_EVENT,
      {
        sessions: {
          "agent:main:demo": expect.objectContaining({ status: "ready" }),
        },
      },
      new Set(["conn-a"]),
    );

    broadcastToConnIds.mockClear();
    await active.pollNow();
    expect(broadcastToConnIds).not.toHaveBeenCalled();

    state = "merged";
    await active.pollNow();
    expect(broadcastToConnIds).toHaveBeenCalledTimes(1);
    expect(
      broadcastToConnIds.mock.calls[0]?.[1].sessions["agent:main:demo"].pullRequests[0].state,
    ).toBe("merged");
  });

  it("deduplicates overlapping watchers to one load per key per poll cycle", async () => {
    vi.useFakeTimers();
    const load = vi.fn<
      (params: ControlUiSessionPullRequestsParams) => Promise<ControlUiSessionPullRequests>
    >(async () => READY);
    const broadcastToConnIds = vi.fn();
    active = createControlUiSessionPullRequestSubscriptions({ broadcastToConnIds, load });

    await active.replace("conn-a", ["shared", "only-a"]);
    await active.replace("conn-b", ["shared", "only-b"]);
    expect(load.mock.calls.map(([params]) => params.sessionKey)).toEqual([
      "shared",
      "only-a",
      "only-b",
    ]);

    load.mockClear();
    await active.pollNow();
    expect(
      load.mock.calls
        .map(([params]) => params.sessionKey)
        .toSorted((left, right) => left.localeCompare(right)),
    ).toEqual(["only-a", "only-b", "shared"]);
  });

  it("shares the four-load limit across connections, hydration, and polling", async () => {
    vi.useFakeTimers();
    const releases: Array<() => void> = [];
    const load = vi.fn(
      async () =>
        await new Promise<ControlUiSessionPullRequests>((resolve) => {
          releases.push(() => resolve(READY));
        }),
    );
    active = createControlUiSessionPullRequestSubscriptions({
      broadcastToConnIds: vi.fn(),
      load,
    });
    const sessionKeys = Array.from({ length: 6 }, (_value, index) => `session-${index}`);

    const finishLimitedLoads = async (operation: Promise<unknown>, total = 6) => {
      await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(4));
      for (const release of releases.splice(0)) {
        release();
      }
      await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(total));
      for (const release of releases.splice(0)) {
        release();
      }
      await operation;
    };

    await finishLimitedLoads(
      Promise.all([
        active.replace("conn-a", sessionKeys.slice(0, 3)),
        active.replace("conn-b", sessionKeys.slice(3)),
      ]),
    );
    load.mockClear();
    await finishLimitedLoads(
      Promise.all([active.pollNow(), active.replace("conn-c", ["new-1", "new-2"])]),
      8,
    );
  });

  it("hydrates and broadcasts only newly added keys across replacement sets", async () => {
    vi.useFakeTimers();
    const load = vi.fn(async () => READY);
    const broadcastToConnIds = vi.fn();
    active = createControlUiSessionPullRequestSubscriptions({ broadcastToConnIds, load });
    await active.replace("conn-a", ["first", "second"]);
    load.mockClear();
    broadcastToConnIds.mockClear();

    await active.replace("conn-a", ["second", "first"]);

    expect(load).not.toHaveBeenCalled();
    expect(broadcastToConnIds).not.toHaveBeenCalled();

    await active.replace("conn-a", ["first", "second", "added"]);

    expect(load).toHaveBeenCalledExactlyOnceWith({ sessionKey: "added" });
    expect(broadcastToConnIds).toHaveBeenCalledExactlyOnceWith(
      CHANGED_EVENT,
      { sessions: { added: { ...READY, status: "ready" } } },
      new Set(["conn-a"]),
    );
  });

  it.each([
    { polling: false, refresh: false },
    { polling: false, refresh: true },
    { polling: true, refresh: false },
    { polling: true, refresh: true },
  ])(
    "does not revive retired queued work with polling=$polling, refresh=$refresh",
    async ({ polling, refresh }) => {
      vi.useFakeTimers();
      const blocked = createDeferred<ControlUiSessionPullRequests>();
      const load = vi.fn(async ({ sessionKey }: ControlUiSessionPullRequestsParams) =>
        sessionKey.startsWith("blocked-") ? await blocked.promise : READY,
      );
      const broadcastToConnIds = vi.fn();
      active = createControlUiSessionPullRequestSubscriptions({ broadcastToConnIds, load });
      if (polling) {
        await active.replace("old", ["session"]);
        load.mockClear();
        broadcastToConnIds.mockClear();
      }
      const blockers = active.replace(
        "blockers",
        Array.from({ length: 4 }, (_, index) => `blocked-${index}`),
      );
      await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(4));
      const retired = polling ? active.pollNow() : active.replace("old", ["session"]);
      active.unsubscribe("old");
      const current = active.replace("new", ["session"], new Set(refresh ? ["session"] : []));
      blocked.resolve(READY);
      await Promise.all([blockers, retired, current]);

      expect(load.mock.calls.filter(([params]) => params.sessionKey === "session")).toEqual([
        [refresh ? { sessionKey: "session", refresh: true } : { sessionKey: "session" }],
      ]);
      expect(broadcastToConnIds.mock.calls.filter((call) => "session" in call[1].sessions)).toEqual(
        [
          [
            CHANGED_EVENT,
            { sessions: { session: { ...READY, status: "ready" } } },
            new Set(["new"]),
          ],
        ],
      );
    },
  );

  it("does not revive a retired forced refresh when another watcher joins its normal load", async () => {
    vi.useFakeTimers();
    const normal = createDeferred<ControlUiSessionPullRequests>();
    const load = vi.fn(() => normal.promise);
    const broadcastToConnIds = vi.fn();
    active = createControlUiSessionPullRequestSubscriptions({ broadcastToConnIds, load });
    const initial = active.replace("old", ["session"]);
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    const forced = active.replace("old", ["session"], new Set(["session"]));
    const current = active.replace("new", ["session"]);
    active.unsubscribe("old");
    normal.resolve(READY);
    await Promise.all([initial, forced, current]);

    expect(load).toHaveBeenCalledExactlyOnceWith({ sessionKey: "session" });
    expect(broadcastToConnIds).toHaveBeenCalledExactlyOnceWith(
      CHANGED_EVENT,
      { sessions: { session: { ...READY, status: "ready" } } },
      new Set(["new"]),
    );
  });

  it("discards an orphaned load before hydrating a new watcher", async () => {
    vi.useFakeTimers();
    const retired = createDeferred<ControlUiSessionPullRequests>();
    const fresh = createDeferred<ControlUiSessionPullRequests>();
    const load = vi
      .fn()
      .mockImplementationOnce(() => retired.promise)
      .mockImplementationOnce(() => fresh.promise);
    const broadcastToConnIds = vi.fn();
    active = createControlUiSessionPullRequestSubscriptions({ broadcastToConnIds, load });
    const initial = active.replace("old", ["session"]);
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    const forced = active.replace("old", ["session"], new Set(["session"]));
    active.unsubscribe("old");
    const current = active.replace("new", ["session"]);
    retired.resolve({ ...READY, rateLimited: true });
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2));

    expect(broadcastToConnIds).not.toHaveBeenCalled();
    expect(load.mock.calls).toEqual([[{ sessionKey: "session" }], [{ sessionKey: "session" }]]);
    fresh.resolve(READY);
    await Promise.all([initial, forced, current]);

    expect(broadcastToConnIds).toHaveBeenCalledExactlyOnceWith(
      CHANGED_EVENT,
      { sessions: { session: { ...READY, status: "ready" } } },
      new Set(["new"]),
    );
  });

  it("loads agent-scoped global watch keys from the owning agent store", async () => {
    vi.useFakeTimers();
    const load = vi.fn(async () => READY);
    active = createControlUiSessionPullRequestSubscriptions({
      broadcastToConnIds: vi.fn(),
      load,
    });

    await active.replace("conn-a", ["agent:work:global"]);

    expect(load).toHaveBeenCalledWith({ sessionKey: "global", agentId: "work" });
  });

  it("forces only requested watched keys through the shared loader", async () => {
    vi.useFakeTimers();
    const load = vi.fn(async ({ refresh }: ControlUiSessionPullRequestsParams) => ({
      ...READY,
      rateLimited: refresh === true,
    }));
    const broadcastToConnIds = vi.fn();
    active = createControlUiSessionPullRequestSubscriptions({ broadcastToConnIds, load });
    await active.replace("conn-a", ["refresh-me", "leave-cached"]);
    await active.replace("conn-b", ["refresh-me"]);
    load.mockClear();
    broadcastToConnIds.mockClear();

    await active.replace("conn-a", ["refresh-me", "leave-cached"], new Set(["refresh-me"]));

    expect(load).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledWith({ sessionKey: "refresh-me", refresh: true });
    expect(broadcastToConnIds).toHaveBeenCalledExactlyOnceWith(
      CHANGED_EVENT,
      { sessions: { "refresh-me": { ...READY, rateLimited: true, status: "rate-limited" } } },
      new Set(["conn-a", "conn-b"]),
    );
  });

  it.each([false, true])(
    "acknowledges unchanged forced results with failing=%s",
    async (failing) => {
      vi.useFakeTimers();
      const load = vi.fn(async () => {
        if (failing) {
          throw new Error("GitHub unavailable");
        }
        return READY;
      });
      const broadcastToConnIds = vi.fn();
      active = createControlUiSessionPullRequestSubscriptions({ broadcastToConnIds, load });
      await active.replace("requester", ["session"]);
      await active.replace("sibling", ["session"]);
      broadcastToConnIds.mockClear();

      await active.replace("requester", ["session"], new Set(["session"]));

      expect(broadcastToConnIds).toHaveBeenCalledExactlyOnceWith(
        CHANGED_EVENT,
        { sessions: { session: { ...READY, status: failing ? "unavailable" : "ready" } } },
        new Set(["requester"]),
      );
    },
  );

  it("serializes forced refreshes behind older normal polls", async () => {
    vi.useFakeTimers();
    let resolveNormal!: (value: ControlUiSessionPullRequests) => void;
    let resolveForced!: (value: ControlUiSessionPullRequests) => void;
    const normal = new Promise<ControlUiSessionPullRequests>((resolve) => {
      resolveNormal = resolve;
    });
    const forced = new Promise<ControlUiSessionPullRequests>((resolve) => {
      resolveForced = resolve;
    });
    const load = vi
      .fn()
      .mockResolvedValueOnce(READY)
      .mockImplementationOnce(async () => await normal)
      .mockImplementationOnce(async () => await forced);
    const broadcastToConnIds = vi.fn();
    active = createControlUiSessionPullRequestSubscriptions({ broadcastToConnIds, load });
    await active.replace("conn-a", ["session"]);
    await active.replace("conn-b", ["session"]);
    broadcastToConnIds.mockClear();

    const poll = active.pollNow();
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    const refresh = active.replace("conn-a", ["session"], new Set(["session"]));
    await vi.advanceTimersByTimeAsync(0);
    resolveNormal({ pullRequests: [], rateLimited: true });
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(3));
    resolveForced(READY);
    await Promise.all([poll, refresh]);

    expect(broadcastToConnIds).toHaveBeenLastCalledWith(
      CHANGED_EVENT,
      { sessions: { session: { ...READY, status: "ready" } } },
      new Set(["conn-a", "conn-b"]),
    );
  });

  it("stops polling keys orphaned by replace-set or disconnect cleanup", async () => {
    vi.useFakeTimers();
    const load = vi.fn(async () => READY);
    const broadcastToConnIds = vi.fn();
    active = createControlUiSessionPullRequestSubscriptions({ broadcastToConnIds, load });

    await active.replace("conn-a", ["replace-orphan"]);
    await active.replace("conn-a", []);
    load.mockClear();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(load).not.toHaveBeenCalled();

    await active.replace("conn-b", ["disconnect-orphan"]);
    active.unsubscribe("conn-b");
    load.mockClear();
    await active.pollNow();
    expect(load).not.toHaveBeenCalled();
  });

  it.each(["poll", "refresh"])(
    "keeps a pending %s current when a replacement retains its watched key",
    async (kind) => {
      vi.useFakeTimers();
      const pending = createDeferred<ControlUiSessionPullRequests>();
      const load = vi
        .fn()
        .mockResolvedValueOnce(READY)
        .mockImplementationOnce(() => pending.promise)
        .mockResolvedValue(READY);
      const broadcastToConnIds = vi.fn();
      active = createControlUiSessionPullRequestSubscriptions({ broadcastToConnIds, load });
      await active.replace("conn-a", ["session"]);
      const pendingLoad =
        kind === "poll"
          ? active.pollNow()
          : active.replace("conn-a", ["session"], new Set(["session"]));
      await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2));
      await active.replace("conn-a", ["session", "other"]);
      broadcastToConnIds.mockClear();
      pending.resolve({ ...READY, rateLimited: true });
      await pendingLoad;

      expect(broadcastToConnIds).toHaveBeenCalledExactlyOnceWith(
        CHANGED_EVENT,
        { sessions: { session: { ...READY, rateLimited: true, status: "rate-limited" } } },
        new Set(["conn-a"]),
      );
    },
  );

  it.each(["stop", "disconnect", "empty replace"])(
    "retires queued forced refreshes on %s while settling their callers",
    async (cleanup) => {
      vi.useFakeTimers();
      const normal = createDeferred<ControlUiSessionPullRequests>();
      const load = vi
        .fn()
        .mockResolvedValueOnce(READY)
        .mockImplementationOnce(() => normal.promise)
        .mockResolvedValue(READY);
      const broadcastToConnIds = vi.fn();
      active = createControlUiSessionPullRequestSubscriptions({ broadcastToConnIds, load });
      await active.replace("conn-a", ["session"]);
      const poll = active.pollNow();
      await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2));
      const refresh = active.replace("conn-a", ["session"], new Set(["session"]));
      await vi.advanceTimersByTimeAsync(0);

      if (cleanup === "stop") {
        active.stop();
      } else if (cleanup === "disconnect") {
        active.unsubscribe("conn-a");
      } else {
        await active.replace("conn-a", []);
      }
      broadcastToConnIds.mockClear();
      normal.resolve(READY);
      await Promise.all([poll, refresh]);

      expect(load).toHaveBeenCalledTimes(2);
      expect(broadcastToConnIds).not.toHaveBeenCalled();
    },
  );

  it("rejects replace-sets from inactive connections before loading", async () => {
    const load = vi.fn(async () => READY);
    const broadcastToConnIds = vi.fn();
    active = createControlUiSessionPullRequestSubscriptions({
      broadcastToConnIds,
      load,
      isConnectionActive: () => false,
    });

    await active.replace("conn-closed", ["orphan"]);

    expect(load).not.toHaveBeenCalled();
    expect(broadcastToConnIds).not.toHaveBeenCalled();
  });

  it("keeps a pending poll current through a cached watcher handoff", async () => {
    vi.useFakeTimers();
    const pending = createDeferred<ControlUiSessionPullRequests>();
    const load = vi
      .fn()
      .mockResolvedValueOnce(READY)
      .mockImplementationOnce(() => pending.promise);
    const broadcastToConnIds = vi.fn();
    active = createControlUiSessionPullRequestSubscriptions({ broadcastToConnIds, load });
    await active.replace("conn-a", ["session"]);
    const poll = active.pollNow();
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    await active.replace("conn-b", ["session"]);
    active.unsubscribe("conn-a");
    broadcastToConnIds.mockClear();
    pending.resolve({ ...READY, rateLimited: true });
    await poll;

    expect(broadcastToConnIds).toHaveBeenCalledExactlyOnceWith(
      CHANGED_EVENT,
      { sessions: { session: { ...READY, rateLimited: true, status: "rate-limited" } } },
      new Set(["conn-b"]),
    );
  });

  it("does not publish a superseded replace-set after its load completes", async () => {
    vi.useFakeTimers();
    let resolveFirst!: (value: ControlUiSessionPullRequests) => void;
    const first = new Promise<ControlUiSessionPullRequests>((resolve) => {
      resolveFirst = resolve;
    });
    const load = vi.fn(async ({ sessionKey }: { sessionKey: string }) =>
      sessionKey === "old" ? await first : READY,
    );
    const broadcastToConnIds = vi.fn();
    active = createControlUiSessionPullRequestSubscriptions({ broadcastToConnIds, load });

    const oldReplace = active.replace("conn-a", ["old", "current"]);
    await vi.waitFor(() => expect(load).toHaveBeenCalledWith({ sessionKey: "old" }));
    await active.replace("conn-a", ["current"]);
    resolveFirst(READY);
    await oldReplace;

    expect(broadcastToConnIds.mock.calls.flatMap((call) => Object.keys(call[1].sessions))).toEqual([
      "current",
    ]);
  });

  it("delivers a shared cached key after its earlier hydration was superseded", async () => {
    vi.useFakeTimers();
    let resolveBlocked!: (value: ControlUiSessionPullRequests) => void;
    const blocked = new Promise<ControlUiSessionPullRequests>((resolve) => {
      resolveBlocked = resolve;
    });
    const load = vi.fn(async ({ sessionKey }: { sessionKey: string }) =>
      sessionKey.startsWith("blocked") ? await blocked : READY,
    );
    const broadcastToConnIds = vi.fn();
    active = createControlUiSessionPullRequestSubscriptions({ broadcastToConnIds, load });

    const oldReplace = active.replace("conn-a", [
      "blocked-1",
      "blocked-2",
      "blocked-3",
      "blocked-4",
      "shared",
    ]);
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(4));
    const replacement = active.replace("conn-a", ["blocked-1"]);
    resolveBlocked(READY);
    await replacement;
    await active.replace("conn-b", ["shared"]);
    broadcastToConnIds.mockClear();

    await active.replace("conn-a", ["shared"]);
    await oldReplace;

    expect(load).toHaveBeenCalledTimes(5);
    expect(broadcastToConnIds).toHaveBeenCalledExactlyOnceWith(
      CHANGED_EVENT,
      { sessions: { shared: { ...READY, status: "ready" } } },
      new Set(["conn-a"]),
    );
  });

  it("propagates rate-limit and failure states per key", async () => {
    vi.useFakeTimers();
    const load = vi.fn(async ({ sessionKey }: { sessionKey: string }) => {
      if (sessionKey === "limited") {
        return { pullRequests: [], rateLimited: true };
      }
      throw new Error("GitHub unavailable");
    });
    const broadcastToConnIds = vi.fn();
    active = createControlUiSessionPullRequestSubscriptions({ broadcastToConnIds, load });

    await active.replace("conn-a", ["limited", "failed"]);
    expect(broadcastToConnIds).toHaveBeenCalledTimes(2);
    const sessions = Object.assign(
      {},
      ...broadcastToConnIds.mock.calls.map((call) => call[1].sessions),
    );
    expect(sessions).toEqual({
      limited: { pullRequests: [], rateLimited: true, status: "rate-limited" },
      failed: { pullRequests: [], rateLimited: false, status: "unavailable" },
    });
  });
});
