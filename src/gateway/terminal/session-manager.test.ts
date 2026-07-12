import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import type { TerminalPtyHandle } from "./pty.js";
import {
  TERMINAL_EVENT_DATA,
  TERMINAL_EVENT_EXIT,
  TerminalSessionManager,
  type TerminalOpenRequest,
} from "./session-manager.js";

/** A controllable fake PTY that records writes and lets tests drive data/exit. */
function makeFakePty() {
  let dataListener: ((chunk: string) => void) | undefined;
  let exitListener: ((event: { exitCode: number; signal?: number }) => void) | undefined;
  const handle: TerminalPtyHandle & {
    writes: string[];
    resizes: Array<[number, number]>;
    killed: boolean;
    emitData: (chunk: string) => void;
    emitExit: (code: number, signal?: number) => void;
  } = {
    pid: 4242,
    writes: [],
    resizes: [],
    killed: false,
    write: (data) => handle.writes.push(data),
    resize: (cols, rows) => handle.resizes.push([cols, rows]),
    onData: (listener) => {
      dataListener = listener;
    },
    onExit: (listener) => {
      exitListener = listener;
    },
    kill: () => {
      handle.killed = true;
    },
    emitData: (chunk) => dataListener?.(chunk),
    emitExit: (code, signal) => exitListener?.({ exitCode: code, signal }),
  };
  return handle;
}

function baseRequest(overrides?: Partial<TerminalOpenRequest>): TerminalOpenRequest {
  return {
    connId: "conn-1",
    agentId: "main",
    cwd: "/work",
    shell: "/bin/zsh",
    args: ["-l"],
    cols: 80,
    rows: 24,
    env: { TERM: "xterm-256color" },
    ...overrides,
  };
}

describe("TerminalSessionManager", () => {
  it("opens a session and streams output only to the owning connection", async () => {
    const emit = vi.fn();
    const fake = makeFakePty();
    const manager = new TerminalSessionManager({ emit, spawn: async () => fake });

    const outcome = await manager.open(baseRequest());
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    expect(manager.size).toBe(1);

    fake.emitData("hello");
    fake.emitData("world");
    expect(emit).toHaveBeenNthCalledWith(1, "conn-1", TERMINAL_EVENT_DATA, {
      sessionId: outcome.sessionId,
      seq: 0,
      data: "hello",
    });
    expect(emit).toHaveBeenNthCalledWith(2, "conn-1", TERMINAL_EVENT_DATA, {
      sessionId: outcome.sessionId,
      seq: 1,
      data: "world",
    });
  });

  it("routes input and resize to the pty for the owning connection", async () => {
    const fake = makeFakePty();
    const manager = new TerminalSessionManager({ emit: vi.fn(), spawn: async () => fake });
    const outcome = await manager.open(baseRequest());
    if (!outcome.ok) {
      throw new Error("expected open");
    }

    expect(manager.write("conn-1", outcome.sessionId, "ls\n")).toBe(true);
    expect(fake.writes).toEqual(["ls\n"]);
    expect(manager.resize("conn-1", outcome.sessionId, 120, 40)).toBe(true);
    expect(fake.resizes).toEqual([[120, 40]]);
  });

  it("refuses input from a different connection", async () => {
    const fake = makeFakePty();
    const manager = new TerminalSessionManager({ emit: vi.fn(), spawn: async () => fake });
    const outcome = await manager.open(baseRequest());
    if (!outcome.ok) {
      throw new Error("expected open");
    }
    expect(manager.write("conn-2", outcome.sessionId, "rm -rf /\n")).toBe(false);
    expect(fake.writes).toEqual([]);
  });

  it("emits an exit event and drops the session when the process exits", async () => {
    const emit = vi.fn();
    const fake = makeFakePty();
    const manager = new TerminalSessionManager({ emit, spawn: async () => fake });
    const outcome = await manager.open(baseRequest());
    if (!outcome.ok) {
      throw new Error("expected open");
    }

    fake.emitExit(0);
    expect(manager.size).toBe(0);
    expect(emit).toHaveBeenCalledWith("conn-1", TERMINAL_EVENT_EXIT, {
      sessionId: outcome.sessionId,
      exitCode: 0,
      signal: null,
      reason: "process_exit",
    });
    expect(fake.killed).toBe(true);
  });

  it("kills every session a disconnected connection owned without emitting", async () => {
    const emit = vi.fn();
    const ptys = [makeFakePty(), makeFakePty()];
    let idx = 0;
    const manager = new TerminalSessionManager({
      emit,
      spawn: async () => expectDefined(ptys[idx++], "ptys[idx++] test invariant"),
    });
    await manager.open(baseRequest());
    await manager.open(baseRequest());
    expect(manager.size).toBe(2);
    emit.mockClear();

    manager.handleDisconnect("conn-1");
    expect(manager.size).toBe(0);
    expect(expectDefined(ptys[0], "ptys[0] test invariant").killed).toBe(true);
    expect(expectDefined(ptys[1], "ptys[1] test invariant").killed).toBe(true);
    // Silent teardown: the socket is already gone.
    expect(emit).not.toHaveBeenCalled();
  });

  it("closes live and pending sessions when their agent becomes disallowed", async () => {
    const emit = vi.fn();
    const livePty = makeFakePty();
    const pendingPty = makeFakePty();
    let releasePending: (() => void) | undefined;
    const pendingGate = new Promise<void>((resolve) => {
      releasePending = resolve;
    });
    const manager = new TerminalSessionManager({
      emit,
      spawn: async (request) => {
        if (request.cwd === "/pending") {
          await pendingGate;
          return pendingPty;
        }
        return livePty;
      },
    });

    const live = await manager.open(baseRequest({ agentId: "locked" }));
    expect(live.ok).toBe(true);
    const pending = manager.open(
      baseRequest({ agentId: "locked", connId: "conn-2", cwd: "/pending" }),
    );

    manager.closeDisallowedAgents((agentId) => agentId !== "locked");
    expect(livePty.killed).toBe(true);
    expect(manager.size).toBe(0);
    expect(emit).toHaveBeenCalledWith(
      "conn-1",
      TERMINAL_EVENT_EXIT,
      expect.objectContaining({ reason: "closed" }),
    );

    releasePending?.();
    const pendingOutcome = await pending;
    expect(pendingOutcome.ok).toBe(false);
    expect(pendingPty.killed).toBe(true);
    expect(manager.size).toBe(0);
  });

  it("disposes every session silently (gateway shutdown)", async () => {
    const emit = vi.fn();
    const ptys = [makeFakePty(), makeFakePty()];
    let idx = 0;
    const manager = new TerminalSessionManager({
      emit,
      spawn: async () => expectDefined(ptys[idx++], "ptys[idx++] test invariant"),
    });
    await manager.open(baseRequest());
    await manager.open(baseRequest({ connId: "conn-2" }));
    emit.mockClear();

    manager.disposeAll();
    expect(manager.size).toBe(0);
    expect(expectDefined(ptys[0], "ptys[0] test invariant").killed).toBe(true);
    expect(expectDefined(ptys[1], "ptys[1] test invariant").killed).toBe(true);
    // Shutdown drops the sockets, so notifying clients is pointless.
    expect(emit).not.toHaveBeenCalled();
  });

  it("enforces the session limit", async () => {
    const manager = new TerminalSessionManager({
      emit: vi.fn(),
      spawn: async () => makeFakePty(),
      maxSessions: 1,
    });
    const first = await manager.open(baseRequest());
    expect(first.ok).toBe(true);
    const second = await manager.open(baseRequest());
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.code).toBe("limit");
    }
  });

  it("kills a pending open whose connection disconnects during spawn", async () => {
    const emit = vi.fn();
    const fake = makeFakePty();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const manager = new TerminalSessionManager({
      emit,
      spawn: async () => {
        await gate;
        return fake;
      },
    });
    const openPromise = manager.open(baseRequest({ connId: "conn-x" }));
    // Connection drops while the shell is still spawning.
    manager.handleDisconnect("conn-x");
    release?.();
    const outcome = await openPromise;
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.code).toBe("closed");
    }
    // The freshly spawned PTY is killed, not registered as an orphan.
    expect(fake.killed).toBe(true);
    expect(manager.size).toBe(0);
  });

  it("enforces the cap against concurrent opens racing on the async spawn", async () => {
    // Spawn resolves on a later tick so both opens await it before either registers.
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const manager = new TerminalSessionManager({
      emit: vi.fn(),
      spawn: async () => {
        await gate;
        return makeFakePty();
      },
      maxSessions: 1,
    });
    const both = Promise.all([manager.open(baseRequest()), manager.open(baseRequest())]);
    release?.();
    const [a, b] = await both;
    // Exactly one succeeds; the reserved slot blocks the concurrent open.
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    expect(manager.size).toBe(1);
  });

  it("reports a spawn failure instead of throwing", async () => {
    const manager = new TerminalSessionManager({
      emit: vi.fn(),
      spawn: async () => {
        throw new Error("node-pty missing");
      },
    });
    const outcome = await manager.open(baseRequest());
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.code).toBe("spawn_failed");
      expect(outcome.message).toContain("node-pty missing");
    }
  });
});

describe("TerminalSessionManager output ring", () => {
  it("bounds buffered output by evicting whole head chunks", async () => {
    const fake = makeFakePty();
    const manager = new TerminalSessionManager({
      emit: vi.fn(),
      spawn: async () => fake,
      scrollbackChars: 8,
    });
    const outcome = await manager.open(baseRequest());
    if (!outcome.ok) {
      throw new Error("expected open");
    }
    fake.emitData("abcd");
    fake.emitData("efgh");
    expect(manager.snapshot(outcome.sessionId)).toBe("abcdefgh");
    fake.emitData("ijkl");
    // Cap exceeded: the oldest whole chunk goes; boundaries stay intact.
    expect(manager.snapshot(outcome.sessionId)).toBe("efghijkl");
  });

  it("keeps only the tail of a single oversized chunk", async () => {
    const fake = makeFakePty();
    const manager = new TerminalSessionManager({
      emit: vi.fn(),
      spawn: async () => fake,
      scrollbackChars: 8,
    });
    const outcome = await manager.open(baseRequest());
    if (!outcome.ok) {
      throw new Error("expected open");
    }
    fake.emitData("0123456789AB");
    expect(manager.snapshot(outcome.sessionId)).toBe("456789AB");
  });

  it("returns undefined for unknown sessions", () => {
    const manager = new TerminalSessionManager({ emit: vi.fn() });
    expect(manager.snapshot("nope")).toBeUndefined();
  });
});

describe("TerminalSessionManager detach/reattach", () => {
  async function openDetachable(options?: {
    detachGraceMs?: number;
    maxDetachedSessions?: number;
  }) {
    const emit = vi.fn();
    const fake = makeFakePty();
    const manager = new TerminalSessionManager({
      emit,
      spawn: async () => fake,
      detachGraceMs: options?.detachGraceMs ?? 60_000,
      maxDetachedSessions: options?.maxDetachedSessions,
    });
    const outcome = await manager.open(baseRequest());
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

  it("attach rebinds a detached session, replays the buffer, and resumes streaming", async () => {
    vi.useFakeTimers();
    try {
      const { manager, fake, emit, sessionId } = await openDetachable();
      fake.emitData("before ");
      manager.handleDisconnect("conn-1");
      fake.emitData("away ");
      emit.mockClear();

      const attached = manager.attach("conn-2", sessionId);
      expect(attached?.buffer).toBe("before away ");
      expect(attached?.agentId).toBe("main");
      // The reaper is cancelled: the session survives past the grace deadline.
      vi.advanceTimersByTime(120_000);
      expect(fake.killed).toBe(false);

      fake.emitData("live");
      expect(emit).toHaveBeenCalledWith("conn-2", TERMINAL_EVENT_DATA, {
        sessionId,
        seq: 1,
        data: "live",
      });
      expect(manager.write("conn-2", sessionId, "ls\n")).toBe(true);
      expect(manager.write("conn-1", sessionId, "ls\n")).toBe(false);
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
    expect(emit).toHaveBeenCalledTimes(1);
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
      await manager.open(baseRequest({ connId: "conn-1" }));
      await manager.open(baseRequest({ connId: "conn-2" }));
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
      const first = await manager.open(baseRequest({ connId: "conn-1" }));
      vi.advanceTimersByTime(5);
      const second = await manager.open(baseRequest({ connId: "conn-2" }));
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
