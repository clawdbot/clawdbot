import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import type { TerminalBackend } from "./backend.js";
import { composeTerminalIntroBanner } from "./intro-banner.js";
import { TerminalSessionManager } from "./session-manager.js";
import {
  agentTerminalOwner,
  baseOpenRequest as baseRequest,
  expectTerminalOpen,
  makeFakePty,
} from "./session-manager.test-helpers.js";
const TERMINAL_EVENT_DATA = "terminal.data";
const TERMINAL_EVENT_EXIT = "terminal.exit";
const OPERATOR_INTRO = composeTerminalIntroBanner();

describe("TerminalSessionManager", () => {
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
      seq: OPERATOR_INTRO.length + "relay output".length,
      data: `${OPERATOR_INTRO}relay output`,
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

  it("retains manager ownership until backend teardown has been invoked", async () => {
    const manager = new TerminalSessionManager({ emit: vi.fn() });
    const kill = vi.fn(() => {
      expect(manager.size).toBe(1);
    });
    const backend: TerminalBackend = {
      write: vi.fn(),
      resize: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
      kill,
      onData: vi.fn(),
      onExit: vi.fn(),
    };
    const opened = await manager.open(baseRequest({ createBackend: async () => backend }));
    if (!opened.ok) {
      throw new Error("expected relay backend open");
    }

    expect(manager.close("conn-1", opened.sessionId)).toBe(true);
    expect(kill).toHaveBeenCalledOnce();
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
      seq: OPERATOR_INTRO.length + 10,
      data: `${OPERATOR_INTRO}helloworld`,
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
      await vi.advanceTimersByTimeAsync(4);
      emit.mockClear();

      const chunk = "12345678";
      for (let index = 0; index < 10_000; index += 1) {
        fake.emitData(chunk);
      }
      await vi.advanceTimersByTimeAsync(4);

      const frames = emit.mock.calls.filter(([, event]) => event === TERMINAL_EVENT_DATA);
      expect(frames.length).toBeLessThan(10);
      expect(frames.map((call) => (call[2] as { seq: number }).seq)).toEqual([
        OPERATOR_INTRO.length + 65_536,
        OPERATOR_INTRO.length + 80_000,
      ]);
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
    await vi.waitFor(() => expect(emit).toHaveBeenCalledOnce());
    emit.mockClear();

    expect(manager.write("conn-1", outcome.sessionId, "x")).toBe(true);
    fake.emitData("x");

    expect(emit).toHaveBeenCalledWith("conn-1", TERMINAL_EVENT_DATA, {
      sessionId: outcome.sessionId,
      seq: OPERATOR_INTRO.length + 1,
      data: "x",
    });
  });

  it("pauses local PTY reads above the socket watermark and reasserts resume below it", async () => {
    vi.useFakeTimers();
    try {
      let bufferedAmount = 0;
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
      await vi.advanceTimersByTimeAsync(4);
      bufferedAmount = Number.MAX_SAFE_INTEGER;

      for (let index = 0; index < 2_000; index += 1) {
        fake.emitData("chunk");
      }
      expect(fake.pauseCalls).toBe(1);
      expect(fake.deliveredChunks).toBe(1);
      expect(manager.snapshot(outcome.sessionId)).toBe(`${OPERATOR_INTRO}chunk`);

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
    await vi.waitFor(() => expect(emit).toHaveBeenCalledOnce());
    emit.mockClear();

    fake.emitData("😀");
    await vi.waitFor(() => expect(emit).toHaveBeenCalledOnce());

    expect(emit).toHaveBeenCalledWith("conn-1", TERMINAL_EVENT_DATA, {
      sessionId: outcome.sessionId,
      seq: OPERATOR_INTRO.length + 2,
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
      baseRequest({
        agentId: "locked",
        owner: { kind: "conn", connId: "conn-2" },
        cwd: "/pending",
      }),
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
    await manager.open(baseRequest({ owner: { kind: "conn", connId: "conn-2" } }));
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

  it.each([
    {
      label: "owns the terminal",
      request: { owner: { kind: "conn" as const, connId: "conn-x" } },
    },
    {
      label: "is the initial viewer",
      request: {
        owner: {
          kind: "agent" as const,
          agentSessionKey: "agent:main:ui-session",
          agentSessionId: "ui-session-id",
          agentId: "main",
        },
        viewerConnId: "conn-x",
      },
    },
  ])("kills a pending open when its connection $label and disconnects", async ({ request }) => {
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
    const openPromise = manager.open(baseRequest(request));
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

describe("TerminalSessionManager agent ownership", () => {
  const agentOwner = agentTerminalOwner("agent:main:main");

  it.each([
    ["none", "close", false],
    ["none", "disconnect", false],
    ["resize", "close", true],
    ["resize", "disconnect", true],
    ["agent read", "close", true],
    ["attach", "close", true],
  ] as const)(
    "%s adoption then %s leaves the UI-created shared terminal alive=%s",
    async (adoption, removal, survives) => {
      const fake = makeFakePty();
      const manager = new TerminalSessionManager({
        emit: vi.fn(),
        spawn: async () => fake,
        maxSessions: 1,
      });
      const outcome = expectTerminalOpen(
        await manager.open(baseRequest({ owner: agentOwner, viewerConnId: "viewer-1" })),
      );

      expect(manager.close("stranger", outcome.sessionId)).toBe(false);
      if (adoption === "resize") {
        manager.resize("viewer-1", outcome.sessionId, 120, 40);
      } else if (adoption === "agent read") {
        manager.snapshotAgent(agentOwner, outcome.sessionId);
      } else if (adoption === "attach") {
        manager.attach("viewer-2", outcome.sessionId);
      }
      if (removal === "close") {
        expect(manager.close("viewer-1", outcome.sessionId)).toBe(true);
      } else {
        manager.handleDisconnect("viewer-1");
      }
      expect([manager.size, fake.killed]).toEqual([survives ? 1 : 0, !survives]);
      if (!survives && removal === "close") {
        expect((await manager.open(baseRequest())).ok).toBe(true);
      }
      manager.disposeAll();
    },
  );

  it("continues live offsets after output buffered before the first viewer", async () => {
    vi.useFakeTimers();
    try {
      const emit = vi.fn();
      const fake = makeFakePty();
      const manager = new TerminalSessionManager({ emit, spawn: async () => fake });
      const outcome = expectTerminalOpen(await manager.open(baseRequest({ owner: agentOwner })));

      fake.emitData("before");
      await vi.advanceTimersByTimeAsync(4);
      const attached = manager.attach("viewer-1", outcome.sessionId);
      expect(attached).toMatchObject({
        buffer: "before",
        seq: 6,
        owner: `agent:${agentOwner.agentSessionKey}`,
      });

      fake.emitData("after");
      await vi.advanceTimersByTimeAsync(4);
      expect(emit).toHaveBeenCalledWith("viewer-1", TERMINAL_EVENT_DATA, {
        sessionId: outcome.sessionId,
        seq: 11,
        data: "after",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps an agent-owned session alive across viewer disconnect and closes by agent", async () => {
    vi.useFakeTimers();
    try {
      const emit = vi.fn();
      const fake = makeFakePty();
      const manager = new TerminalSessionManager({ emit, spawn: async () => fake });
      const outcome = expectTerminalOpen(await manager.open(baseRequest({ owner: agentOwner })));

      expect(manager.attach("viewer-1", outcome.sessionId)?.sessionId).toBe(outcome.sessionId);
      expect(manager.write("viewer-1", outcome.sessionId, "human\n")).toBe(true);
      expect(manager.resize("viewer-1", outcome.sessionId, 120, 40)).toBe(true);
      expect(fake.writes).toEqual(["human\n"]);
      expect(fake.resizes).toEqual([[120, 40]]);

      fake.emitData("visible");
      await vi.advanceTimersByTimeAsync(4);
      expect(emit).toHaveBeenCalledWith("viewer-1", TERMINAL_EVENT_DATA, {
        sessionId: outcome.sessionId,
        seq: 7,
        data: "visible",
      });

      manager.handleDisconnect("viewer-1");
      emit.mockClear();
      fake.emitData("buffered");
      await vi.advanceTimersByTimeAsync(4);
      expect(manager.size).toBe(1);
      expect(fake.killed).toBe(false);
      expect(emit).not.toHaveBeenCalled();
      expect(manager.snapshotAgent(agentOwner, outcome.sessionId)).toBe("visiblebuffered");

      expect(manager.closeAgent(agentOwner, outcome.sessionId)).toEqual({ ok: true });
      expect(fake.killed).toBe(true);
      expect(manager.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets a co-attached viewer upload into an agent-owned session", async () => {
    const emit = vi.fn();
    const stageUpload = vi.fn(async () => ({ path: "/tmp/node/report.pdf", size: 4 }));
    const manager = new TerminalSessionManager({ emit, spawn: async () => makeFakePty() });
    const outcome = expectTerminalOpen(
      await manager.open(baseRequest({ owner: agentOwner, stageUpload })),
    );
    const file = { name: "report.pdf", contentBase64: "dGVzdA==" };

    // A connection that never attached as a viewer cannot upload.
    await expect(manager.upload("stranger", outcome.sessionId, file)).resolves.toBeUndefined();
    expect(stageUpload).not.toHaveBeenCalled();

    expect(manager.attach("viewer-1", outcome.sessionId)?.sessionId).toBe(outcome.sessionId);
    await expect(manager.upload("viewer-1", outcome.sessionId, file)).resolves.toEqual({
      path: "/tmp/node/report.pdf",
      size: 4,
    });
    expect(stageUpload).toHaveBeenCalledWith(file);
  });

  it("co-attaches viewers without take-over and cleans each viewer independently", async () => {
    vi.useFakeTimers();
    try {
      const emit = vi.fn();
      const fake = makeFakePty();
      const manager = new TerminalSessionManager({ emit, spawn: async () => fake });
      const outcome = expectTerminalOpen(await manager.open(baseRequest({ owner: agentOwner })));

      expect(manager.attach("viewer-1", outcome.sessionId)).toBeDefined();
      expect(manager.attach("viewer-2", outcome.sessionId)).toBeDefined();
      expect(emit).not.toHaveBeenCalledWith(
        "viewer-1",
        TERMINAL_EVENT_EXIT,
        expect.objectContaining({ reason: "detached" }),
      );

      fake.emitData("both");
      await vi.advanceTimersByTimeAsync(4);
      const dataRecipients = emit.mock.calls
        .filter(([, event]) => event === TERMINAL_EVENT_DATA)
        .map(([connId]) => connId)
        .toSorted((a, b) => String(a).localeCompare(String(b)));
      expect(dataRecipients).toEqual(["viewer-1", "viewer-2"]);

      manager.handleDisconnect("viewer-1");
      emit.mockClear();
      fake.emitData("one");
      await vi.advanceTimersByTimeAsync(4);
      expect(emit).toHaveBeenCalledWith(
        "viewer-2",
        TERMINAL_EVENT_DATA,
        expect.objectContaining({ data: "one" }),
      );
      expect(emit).not.toHaveBeenCalledWith("viewer-1", TERMINAL_EVENT_DATA, expect.anything());

      // Browser close removes the view; agent lifecycle ownership remains.
      expect(manager.close("viewer-2", outcome.sessionId)).toBe(true);
      expect(manager.size).toBe(1);
      expect(fake.killed).toBe(false);
      expect(manager.list()).toEqual([
        expect.objectContaining({
          sessionId: outcome.sessionId,
          attached: false,
          owner: "agent:agent:main:main",
        }),
      ]);
      expect(manager.close("stranger", outcome.sessionId)).toBe(false);
      expect(manager.attach("viewer-2", outcome.sessionId)).toBeDefined();
      expect(manager.closeAgent(agentOwner, outcome.sessionId)).toEqual({ ok: true });
      expect(manager.size).toBe(0);
      expect(fake.killed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["disconnect", "close"] as const)(
    "immediately resumes a shared terminal when its slow viewer leaves via %s",
    async (removal) => {
      vi.useFakeTimers();
      const fake = makeFakePty();
      const emit = vi.fn();
      const bufferedAmounts = new Map([
        ["viewer-slow", Number.MAX_SAFE_INTEGER],
        ["viewer-healthy", 0],
      ]);
      const manager = new TerminalSessionManager({
        emit,
        getBufferedAmount: (connId) => bufferedAmounts.get(connId),
        spawn: async () => fake,
      });

      try {
        const outcome = expectTerminalOpen(await manager.open(baseRequest({ owner: agentOwner })));
        manager.attach("viewer-slow", outcome.sessionId);
        manager.attach("viewer-healthy", outcome.sessionId);

        fake.emitData("pressure");
        await vi.advanceTimersByTimeAsync(4);
        expect(fake.paused).toBe(true);

        if (removal === "disconnect") {
          manager.handleDisconnect("viewer-slow");
        } else {
          expect(manager.close("viewer-slow", outcome.sessionId)).toBe(true);
        }

        expect(fake.paused).toBe(false);
        emit.mockClear();
        fake.emitData("resumed");
        await vi.advanceTimersByTimeAsync(4);
        expect(emit).toHaveBeenCalledWith(
          "viewer-healthy",
          TERMINAL_EVENT_DATA,
          expect.objectContaining({ data: "resumed" }),
        );
        expect(emit).not.toHaveBeenCalledWith(
          "viewer-slow",
          TERMINAL_EVENT_DATA,
          expect.anything(),
        );
      } finally {
        manager.disposeAll();
        vi.useRealTimers();
      }
    },
  );

  it("keeps a shared terminal paused when its remaining viewer is still slow", async () => {
    vi.useFakeTimers();
    const fake = makeFakePty();
    const bufferedAmounts = new Map([
      ["viewer-slow", Number.MAX_SAFE_INTEGER],
      ["viewer-healthy", 0],
    ]);
    const manager = new TerminalSessionManager({
      emit: vi.fn(),
      getBufferedAmount: (connId) => bufferedAmounts.get(connId),
      spawn: async () => fake,
    });

    try {
      const outcome = expectTerminalOpen(await manager.open(baseRequest({ owner: agentOwner })));
      manager.attach("viewer-slow", outcome.sessionId);
      manager.attach("viewer-healthy", outcome.sessionId);

      fake.emitData("pressure");
      await vi.advanceTimersByTimeAsync(4);
      expect(fake.paused).toBe(true);

      manager.handleDisconnect("viewer-healthy");

      expect(fake.paused).toBe(true);
      expect(fake.resumeCalls).toBe(0);
    } finally {
      manager.disposeAll();
      vi.useRealTimers();
    }
  });

  it("resumes a pressured PTY immediately when its last viewer disconnects", async () => {
    const fake = makeFakePty();
    const manager = new TerminalSessionManager({
      emit: vi.fn(),
      getBufferedAmount: () => Number.MAX_SAFE_INTEGER,
      spawn: async () => fake,
    });
    const outcome = expectTerminalOpen(await manager.open(baseRequest({ owner: agentOwner })));
    manager.attach("viewer-1", outcome.sessionId);

    fake.emitData("pressure");
    expect(fake.paused).toBe(true);
    expect(fake.pauseCalls).toBe(1);

    manager.handleDisconnect("viewer-1");
    expect(fake.paused).toBe(false);
    expect(fake.resumeCalls).toBeGreaterThanOrEqual(1);
    expect(manager.size).toBe(1);
  });
});
