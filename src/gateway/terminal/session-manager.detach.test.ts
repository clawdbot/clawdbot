import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { composeTerminalIntroBanner } from "./intro-banner.js";
import { TerminalSessionManager } from "./session-manager.js";
import { baseOpenRequest as baseRequest, makeFakePty } from "./session-manager.test-helpers.js";
const TERMINAL_EVENT_DATA = "terminal.data";
const TERMINAL_EVENT_EXIT = "terminal.exit";
const OPERATOR_INTRO = composeTerminalIntroBanner();

describe("TerminalSessionManager detach/reattach", () => {
  async function openDetachable(options?: {
    detachGraceMs?: number;
    maxDetachedSessions?: number;
    title?: string;
  }) {
    const emit = vi.fn();
    const fake = makeFakePty();
    const manager = new TerminalSessionManager({
      emit,
      spawn: async () => fake,
      detachGraceMs: options?.detachGraceMs ?? 60_000,
      maxDetachedSessions: options?.maxDetachedSessions,
    });
    const outcome = await manager.open(baseRequest({ title: options?.title }));
    if (!outcome.ok) {
      throw new Error("expected open");
    }
    return { manager, fake, emit, sessionId: outcome.sessionId };
  }

  it("detaches sessions on disconnect and reaps them after the grace period", async () => {
    vi.useFakeTimers();
    try {
      const { manager, fake, emit } = await openDetachable();
      manager.handleDisconnect("conn-1");
      expect(manager.size).toBe(1);
      expect(fake.killed).toBe(false);
      // Output while detached is buffered, never emitted to a dead conn.
      emit.mockClear();
      fake.emitData("while away");
      expect(emit).not.toHaveBeenCalled();
      vi.advanceTimersByTime(59_999);
      expect(fake.killed).toBe(false);
      vi.advanceTimersByTime(1);
      expect(fake.killed).toBe(true);
      expect(manager.size).toBe(0);
      expect(emit).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([0, 2_000, 10_000, 30_000])(
    "applies a %ims timeout to the original detach time",
    async (graceMs) => {
      vi.useFakeTimers();
      try {
        const { manager, fake } = await openDetachable({ detachGraceMs: 20_000 });
        manager.handleDisconnect("conn-1");
        vi.advanceTimersByTime(5_000);
        manager.updateDetachGraceMs(graceMs);

        const remainingMs = graceMs - 5_000;
        if (remainingMs > 0) {
          vi.advanceTimersByTime(remainingMs - 1);
          expect(fake.killed).toBe(false);
          vi.advanceTimersByTime(1);
        }
        expect(fake.killed).toBe(true);
        expect(manager.size).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("preserves attached sessions and uses the new timeout on their next disconnect", async () => {
    vi.useFakeTimers();
    try {
      const { manager, fake, sessionId } = await openDetachable();
      manager.updateDetachGraceMs(10_000);
      vi.advanceTimersByTime(60_000);
      expect(fake.killed).toBe(false);

      manager.handleDisconnect("conn-1");
      vi.advanceTimersByTime(5_000);
      expect(manager.attach("conn-2", sessionId)).toBeDefined();
      manager.updateDetachGraceMs(0);
      vi.advanceTimersByTime(60_000);
      expect(manager.write("conn-2", sessionId, "still attached")).toBe(true);
      expect(fake.killed).toBe(false);
      manager.handleDisconnect("conn-2");
      expect(fake.killed).toBe(true);
      expect(manager.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("attach rebinds a detached session, replays the buffer, and resumes streaming", async () => {
    vi.useFakeTimers();
    try {
      const { manager, fake, emit, sessionId } = await openDetachable({ title: "codex" });
      fake.emitData("before ");
      manager.handleDisconnect("conn-1");
      fake.emitData("away ");
      emit.mockClear();

      const attached = manager.attach("conn-2", sessionId);
      expect(attached?.buffer).toBe(`${OPERATOR_INTRO}before away `);
      expect(attached?.seq).toBe(OPERATOR_INTRO.length + 12);
      expect(attached).toMatchObject({ agentId: "main", title: "codex", owner: "conn" });
      expect(manager.list()).toEqual([
        expect.objectContaining({ sessionId, title: "codex", owner: "conn" }),
      ]);
      // The reaper is cancelled: the session survives past the grace deadline.
      vi.advanceTimersByTime(120_000);
      expect(fake.killed).toBe(false);

      fake.emitData("live");
      await vi.advanceTimersByTimeAsync(4);
      expect(emit).toHaveBeenCalledWith("conn-2", TERMINAL_EVENT_DATA, {
        sessionId,
        seq: OPERATOR_INTRO.length + 16,
        data: "live",
      });
      expect(manager.write("conn-2", sessionId, "ls\n")).toBe(true);
      expect(manager.write("conn-1", sessionId, "ls\n")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps data sequence numbers monotonic across repeated detach and attach", async () => {
    vi.useFakeTimers();
    try {
      const { manager, fake, emit, sessionId } = await openDetachable();
      await vi.advanceTimersByTimeAsync(4);
      emit.mockClear();
      fake.emitData("first");
      await vi.advanceTimersByTimeAsync(4);
      manager.handleDisconnect("conn-1");
      fake.emitData("detached");
      manager.attach("conn-2", sessionId);
      fake.emitData("second");
      await vi.advanceTimersByTimeAsync(4);
      manager.handleDisconnect("conn-2");
      manager.attach("conn-3", sessionId);
      fake.emitData("third");
      await vi.advanceTimersByTimeAsync(4);

      const dataEvents = emit.mock.calls
        .filter(([, event]) => event === TERMINAL_EVENT_DATA)
        .map(([connId, , payload]) => {
          const data = payload as { sessionId: string; seq: number; data: string };
          return { connId, sessionId: data.sessionId, seq: data.seq, data: data.data };
        });
      expect(dataEvents).toEqual([
        { connId: "conn-1", sessionId, seq: OPERATOR_INTRO.length + 5, data: "first" },
        { connId: "conn-2", sessionId, seq: OPERATOR_INTRO.length + 19, data: "second" },
        { connId: "conn-3", sessionId, seq: OPERATOR_INTRO.length + 24, data: "third" },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("attach takes over a live session and notifies the previous owner", async () => {
    const { manager, fake, emit, sessionId } = await openDetachable();
    emit.mockClear();
    const attached = manager.attach("conn-2", sessionId);
    expect(attached?.sessionId).toBe(sessionId);
    expect(emit).toHaveBeenCalledWith("conn-1", TERMINAL_EVENT_EXIT, {
      sessionId,
      exitCode: null,
      signal: null,
      reason: "detached",
    });
    emit.mockClear();
    fake.emitData("output");
    await vi.waitFor(() => expect(emit).toHaveBeenCalledTimes(1));
    expect(expectDefined(emit.mock.calls[0], "emit.mock.calls[0] test invariant")[0]).toBe(
      "conn-2",
    );
    // The old owner's disconnect later must not tear down the stolen session.
    manager.handleDisconnect("conn-1");
    expect(manager.size).toBe(1);
    expect(manager.write("conn-2", sessionId, "x")).toBe(true);
  });

  it("attach returns undefined for unknown or reaped sessions", async () => {
    vi.useFakeTimers();
    try {
      const { manager, sessionId } = await openDetachable();
      expect(manager.attach("conn-2", "nope")).toBeUndefined();
      manager.handleDisconnect("conn-1");
      vi.advanceTimersByTime(60_000);
      expect(manager.attach("conn-2", sessionId)).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("re-detaches with a fresh grace period when the adopting connection drops", async () => {
    vi.useFakeTimers();
    try {
      const { manager, fake, sessionId } = await openDetachable();
      manager.handleDisconnect("conn-1");
      vi.advanceTimersByTime(30_000);
      expect(manager.attach("conn-2", sessionId)).toBeDefined();
      manager.handleDisconnect("conn-2");
      // The second detach restarts the clock; the original deadline is void.
      vi.advanceTimersByTime(59_999);
      expect(fake.killed).toBe(false);
      vi.advanceTimersByTime(1);
      expect(fake.killed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("caps detached sessions by killing the oldest", async () => {
    vi.useFakeTimers();
    try {
      const ptys = [makeFakePty(), makeFakePty()];
      let idx = 0;
      const manager = new TerminalSessionManager({
        emit: vi.fn(),
        spawn: async () => expectDefined(ptys[idx++], "ptys[idx++] test invariant"),
        detachGraceMs: 60_000,
        maxDetachedSessions: 1,
      });
      await manager.open(baseRequest({ owner: { kind: "conn", connId: "conn-1" } }));
      await manager.open(baseRequest({ owner: { kind: "conn", connId: "conn-2" } }));
      manager.handleDisconnect("conn-1");
      vi.advanceTimersByTime(1);
      manager.handleDisconnect("conn-2");
      expect(expectDefined(ptys[0], "ptys[0] test invariant").killed).toBe(true);
      expect(expectDefined(ptys[1], "ptys[1] test invariant").killed).toBe(false);
      expect(manager.size).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("lists sessions with attachment state, oldest first", async () => {
    vi.useFakeTimers();
    try {
      const ptys = [makeFakePty(), makeFakePty()];
      let idx = 0;
      const manager = new TerminalSessionManager({
        emit: vi.fn(),
        spawn: async () => expectDefined(ptys[idx++], "ptys[idx++] test invariant"),
        detachGraceMs: 60_000,
      });
      const first = await manager.open(baseRequest({ owner: { kind: "conn", connId: "conn-1" } }));
      vi.advanceTimersByTime(5);
      const second = await manager.open(baseRequest({ owner: { kind: "conn", connId: "conn-2" } }));
      if (!first.ok || !second.ok) {
        throw new Error("expected opens");
      }
      manager.handleDisconnect("conn-2");
      const listed = manager.list();
      expect(listed.map((s) => s.sessionId)).toEqual([first.sessionId, second.sessionId]);
      expect(listed[0]).toMatchObject({ attached: true, agentId: "main", shell: "/bin/zsh" });
      expect(listed[1]).toMatchObject({ attached: false });
      expect(expectDefined(listed[1], "listed[1] test invariant").createdAtMs).toBeGreaterThan(
        expectDefined(listed[0], "listed[0] test invariant").createdAtMs,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("shutdown hard-kills detached sessions and clears their reapers", async () => {
    vi.useFakeTimers();
    try {
      const { manager, fake } = await openDetachable();
      manager.handleDisconnect("conn-1");
      manager.disposeAll();
      expect(fake.killed).toBe(true);
      expect(manager.size).toBe(0);
      // No reaper left behind to fire against the disposed session.
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
