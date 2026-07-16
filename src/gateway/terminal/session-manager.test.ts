import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import type { spawnTerminalPty } from "../../process/terminal-pty.js";
import type { TerminalBackend } from "./backend.js";
import { TerminalSessionManager } from "./session-manager.js";

type TerminalOpenRequest = Parameters<TerminalSessionManager["open"]>[0];
type TerminalPtyHandle = Awaited<ReturnType<typeof spawnTerminalPty>>;
const TERMINAL_EVENT_DATA = "terminal.data";
const TERMINAL_EVENT_EXIT = "terminal.exit";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

/** A controllable fake PTY that records writes and lets tests drive data/exit. */
function makeFakePty() {
  let dataListener: ((chunk: string) => void) | undefined;
  let exitListener: ((event: { exitCode: number; signal?: number }) => void) | undefined;
  const handle: TerminalPtyHandle & {
    writes: string[];
    resizes: Array<[number, number]>;
    killed: boolean;
    paused: boolean;
    pauseCalls: number;
    resumeCalls: number;
    deliveredChunks: number;
    emitData: (chunk: string) => void;
    emitExit: (code: number, signal?: number) => void;
  } = {
    pid: 4242,
    writes: [],
    resizes: [],
    killed: false,
    paused: false,
    pauseCalls: 0,
    resumeCalls: 0,
    deliveredChunks: 0,
    write: (data) => handle.writes.push(data),
    resize: (cols, rows) => handle.resizes.push([cols, rows]),
    pause: () => {
      handle.paused = true;
      handle.pauseCalls += 1;
    },
    resume: () => {
      handle.paused = false;
      handle.resumeCalls += 1;
    },
    onData: (listener) => {
      dataListener = listener;
    },
    onExit: (listener) => {
      exitListener = listener;
    },
    kill: () => {
      handle.killed = true;
    },
    emitData: (chunk) => {
      if (!handle.paused) {
        handle.deliveredChunks += 1;
        dataListener?.(chunk);
      }
    },
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
  it("kills a backend that finishes after its open request is cancelled", async () => {
    const spawned = deferred<TerminalPtyHandle>();
    const controller = new AbortController();
    const first = makeFakePty();
    const second = makeFakePty();
    let spawnCount = 0;
    const manager = new TerminalSessionManager({
      emit: vi.fn(),
      maxSessions: 1,
      spawn: () => (spawnCount++ === 0 ? spawned.promise : Promise.resolve(second)),
    });
    const opening = manager.open(baseRequest({ signal: controller.signal }));

    controller.abort(new Error("terminal open timed out"));
    const next = await manager.open(baseRequest({ connId: "conn-2" }));
    expect(next.ok).toBe(true);
    spawned.resolve(first);

    await expect(opening).resolves.toEqual({
      ok: false,
      code: "closed",
      message: "terminal open timed out",
    });
    expect(first.killed).toBe(true);
    expect(manager.size).toBe(1);
    if (next.ok) {
      expect(manager.close("conn-2", next.sessionId)).toBe(true);
    }
    expect(second.killed).toBe(true);
    expect(manager.size).toBe(0);
  });

  it("bounds cancelled backend operations until they settle", async () => {
    const firstSpawn = deferred<TerminalPtyHandle>();
    const secondSpawn = deferred<TerminalPtyHandle>();
    const firstController = new AbortController();
    const secondController = new AbortController();
    let spawnCount = 0;
    const manager = new TerminalSessionManager({
      emit: vi.fn(),
      maxSessions: 1,
      spawn: () => (spawnCount++ === 0 ? firstSpawn.promise : secondSpawn.promise),
    });

    const firstOpening = manager.open(baseRequest({ signal: firstController.signal }));
    firstController.abort(new Error("first cancelled"));
    const secondOpening = manager.open(
      baseRequest({ connId: "conn-2", signal: secondController.signal }),
    );
    secondController.abort(new Error("second cancelled"));

    await expect(manager.open(baseRequest({ connId: "conn-3" }))).resolves.toEqual({
      ok: false,
      code: "limit",
      message: "terminal spawn limit reached (2)",
    });

    const first = makeFakePty();
    const second = makeFakePty();
    firstSpawn.resolve(first);
    secondSpawn.resolve(second);
    await expect(firstOpening).resolves.toMatchObject({ ok: false, code: "closed" });
    await expect(secondOpening).resolves.toMatchObject({ ok: false, code: "closed" });
    expect(first.killed).toBe(true);
    expect(second.killed).toBe(true);
  });

  it("runs relay backends through the same stream, input, resize, and close lifecycle", async () => {
    let onData: ((data: string) => void) | undefined;
    let onExit:
      | ((exit: { exitCode?: number; signal?: number; error?: string }) => void)
      | undefined;
    const write = vi.fn();
    const resize = vi.fn();
    const kill = vi.fn();
    const backend: TerminalBackend = {
      write,
      resize,
      pause: vi.fn(),
      resume: vi.fn(),
      kill,
      onData: (callback) => {
        onData = callback;
      },
      onExit: (callback) => {
        onExit = callback;
      },
    };
    const emit = vi.fn();
    const manager = new TerminalSessionManager({ emit });
    const opened = await manager.open(baseRequest({ createBackend: async () => backend }));
    if (!opened.ok) {
      throw new Error("expected relay backend open");
    }

    onData?.("relay output");
    await vi.waitFor(() => expect(emit).toHaveBeenCalledOnce());
    expect(emit).toHaveBeenCalledWith("conn-1", TERMINAL_EVENT_DATA, {
      sessionId: opened.sessionId,
      seq: "relay output".length,
      data: "relay output",
    });
    expect(manager.write("conn-1", opened.sessionId, "input")).toBe(true);
    expect(write).toHaveBeenCalledWith("input");
    expect(manager.resize("conn-1", opened.sessionId, 120, 40)).toBe(true);
    expect(resize).toHaveBeenCalledWith(120, 40);
    expect(manager.close("conn-1", opened.sessionId)).toBe(true);
    expect(kill).toHaveBeenCalledOnce();

    onExit?.({ exitCode: 0 });
    expect(manager.size).toBe(0);
  });

  it("finalizes a session when backend resize throws", async () => {
    const emit = vi.fn();
    const kill = vi.fn();
    const backend: TerminalBackend = {
      write: vi.fn(),
      resize: () => {
        throw new Error("dead PTY");
      },
      pause: vi.fn(),
      resume: vi.fn(),
      kill,
      onData: vi.fn(),
      onExit: vi.fn(),
    };
    const manager = new TerminalSessionManager({ emit });
    const opened = await manager.open(baseRequest({ createBackend: async () => backend }));
    if (!opened.ok) {
      throw new Error("expected relay backend open");
    }

    expect(manager.resize("conn-1", opened.sessionId, 120, 40)).toBe(false);
    expect(manager.size).toBe(0);
    expect(kill).toHaveBeenCalledOnce();
    expect(emit).toHaveBeenCalledWith("conn-1", TERMINAL_EVENT_EXIT, {
      sessionId: opened.sessionId,
      exitCode: null,
      signal: null,
      reason: "error",
      error: "resize failed",
    });
  });

  it("delivers relay backend errors to the owning connection", async () => {
    let onExit:
      | ((exit: { exitCode?: number; signal?: number; error?: string }) => void)
      | undefined;
    const backend: TerminalBackend = {
      write: vi.fn(),
      resize: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
      kill: vi.fn(),
      onData: vi.fn(),
      onExit: (callback) => {
        onExit = callback;
      },
    };
    const emit = vi.fn();
    const manager = new TerminalSessionManager({ emit });
    const opened = await manager.open(baseRequest({ createBackend: async () => backend }));
    if (!opened.ok) {
      throw new Error("expected relay backend open");
    }

    onExit?.({ error: "ROUTE_CHANGED: node connection changed before dispatch" });

    expect(emit).toHaveBeenCalledWith("conn-1", TERMINAL_EVENT_EXIT, {
      sessionId: opened.sessionId,
      exitCode: null,
      signal: null,
      reason: "error",
      error: "ROUTE_CHANGED: node connection changed before dispatch",
    });
  });

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
    await vi.waitFor(() => expect(emit).toHaveBeenCalledOnce());
    expect(emit).toHaveBeenCalledWith("conn-1", TERMINAL_EVENT_DATA, {
      sessionId: outcome.sessionId,
      seq: 10,
      data: "helloworld",
    });
  });

  it("coalesces thousands of PTY chunks into a bounded number of data frames", async () => {
    vi.useFakeTimers();
    try {
      const emit = vi.fn();
      const fake = makeFakePty();
      const manager = new TerminalSessionManager({ emit, spawn: async () => fake });
      const outcome = await manager.open(baseRequest());
      if (!outcome.ok) {
        throw new Error("expected open");
      }

      const chunk = "12345678";
      for (let index = 0; index < 10_000; index += 1) {
        fake.emitData(chunk);
      }
      await vi.advanceTimersByTimeAsync(4);

      const frames = emit.mock.calls.filter(([, event]) => event === TERMINAL_EVENT_DATA);
      expect(frames.length).toBeLessThan(10);
      expect(frames.map((call) => (call[2] as { seq: number }).seq)).toEqual([65_536, 80_000]);
      expect(
        frames.every(
          (call) => Buffer.byteLength((call[2] as { data: string }).data, "utf8") <= 64 * 1024,
        ),
      ).toBe(true);
      expect(frames.map((call) => (call[2] as { data: string }).data).join("")).toBe(
        chunk.repeat(10_000),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("flushes small output immediately after terminal input", async () => {
    const emit = vi.fn();
    const fake = makeFakePty();
    const manager = new TerminalSessionManager({ emit, spawn: async () => fake });
    const outcome = await manager.open(baseRequest());
    if (!outcome.ok) {
      throw new Error("expected open");
    }

    expect(manager.write("conn-1", outcome.sessionId, "x")).toBe(true);
    fake.emitData("x");

    expect(emit).toHaveBeenCalledWith("conn-1", TERMINAL_EVENT_DATA, {
      sessionId: outcome.sessionId,
      seq: 1,
      data: "x",
    });
  });

  it("pauses local PTY reads above the socket watermark and reasserts resume below it", async () => {
    vi.useFakeTimers();
    try {
      let bufferedAmount = Number.MAX_SAFE_INTEGER;
      const fake = makeFakePty();
      const manager = new TerminalSessionManager({
        emit: vi.fn(),
        getBufferedAmount: () => bufferedAmount,
        spawn: async () => fake,
      });
      const outcome = await manager.open(baseRequest());
      if (!outcome.ok) {
        throw new Error("expected open");
      }

      for (let index = 0; index < 2_000; index += 1) {
        fake.emitData("chunk");
      }
      expect(fake.pauseCalls).toBe(1);
      expect(fake.deliveredChunks).toBe(1);
      expect(manager.snapshot(outcome.sessionId)).toBe("chunk");

      bufferedAmount = 0;
      await vi.advanceTimersByTimeAsync(5_000);
      expect(fake.resumeCalls).toBeGreaterThanOrEqual(1);
      fake.emitData("resumed");
      expect(fake.deliveredChunks).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("counts streamed output in UTF-16 code units", async () => {
    const emit = vi.fn();
    const fake = makeFakePty();
    const manager = new TerminalSessionManager({ emit, spawn: async () => fake });
    const outcome = await manager.open(baseRequest());
    if (!outcome.ok) {
      throw new Error("expected open");
    }

    fake.emitData("😀");
    await vi.waitFor(() => expect(emit).toHaveBeenCalledOnce());

    expect(emit).toHaveBeenCalledWith("conn-1", TERMINAL_EVENT_DATA, {
      sessionId: outcome.sessionId,
      seq: 2,
      data: "😀",
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

  it("stages uploads only through the owning session host", async () => {
    const fake = makeFakePty();
    const stageUpload = vi.fn(async () => ({ path: "/tmp/node/report.pdf", size: 4 }));
    const manager = new TerminalSessionManager({ emit: vi.fn(), spawn: async () => fake });
    const outcome = await manager.open(baseRequest({ stageUpload }));
    if (!outcome.ok) {
      throw new Error("expected open");
    }
    const file = { name: "report.pdf", contentBase64: "dGVzdA==" };

    await expect(manager.upload("conn-2", outcome.sessionId, file)).resolves.toBeUndefined();
    expect(stageUpload).not.toHaveBeenCalled();
    await expect(manager.upload("conn-1", outcome.sessionId, file)).resolves.toEqual({
      path: "/tmp/node/report.pdf",
      size: 4,
    });
    expect(stageUpload).toHaveBeenCalledWith(file);
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

  it("does not retain a leading lone low surrogate from an oversized chunk", async () => {
    const fake = makeFakePty();
    const manager = new TerminalSessionManager({
      emit: vi.fn(),
      spawn: async () => fake,
      scrollbackChars: 3,
    });
    const outcome = await manager.open(baseRequest());
    if (!outcome.ok) {
      throw new Error("expected open");
    }

    fake.emitData("ab😀cd");

    expect(manager.snapshot(outcome.sessionId)).toBe("cd");
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
      expect(attached?.seq).toBe(12);
      expect(attached?.agentId).toBe("main");
      // The reaper is cancelled: the session survives past the grace deadline.
      vi.advanceTimersByTime(120_000);
      expect(fake.killed).toBe(false);

      fake.emitData("live");
      await vi.advanceTimersByTimeAsync(4);
      expect(emit).toHaveBeenCalledWith("conn-2", TERMINAL_EVENT_DATA, {
        sessionId,
        seq: 16,
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
        { connId: "conn-1", sessionId, seq: 5, data: "first" },
        { connId: "conn-2", sessionId, seq: 19, data: "second" },
        { connId: "conn-3", sessionId, seq: 24, data: "third" },
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
