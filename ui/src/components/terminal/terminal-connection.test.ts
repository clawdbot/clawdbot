// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import {
  TerminalConnection,
  type TerminalGatewayClient,
  TerminalOpenTimeoutError,
  TerminalOpenUnusableSessionError,
} from "./terminal-connection.ts";

const TERMINAL_LIVENESS_IDLE_MS = 20_000;
const TERMINAL_LIVENESS_PROBE_TIMEOUT_MS = 5_000;
const TERMINAL_LIVENESS_FAILURE_RETRY_MS = 5_000;
const TERMINAL_OPEN_WATCHDOG_MS = 35_000;
// Idle window elapses, then one probe times out: the interval after which a probe resolves failed.
const IDLE_PLUS_PROBE_MS = TERMINAL_LIVENESS_IDLE_MS + TERMINAL_LIVENESS_PROBE_TIMEOUT_MS;

type TerminalSink = Parameters<TerminalConnection["open"]>[1];
type TerminalOpenParams = Parameters<TerminalConnection["open"]>[0];
type TestSessionResult = {
  sessionId: string;
  agentId: string;
  shell: string;
  cwd: string;
  confined: boolean;
  buffer?: string;
  seq?: number;
  title?: string;
};

function sessionResult(overrides: Partial<TestSessionResult> = {}): TestSessionResult {
  return {
    sessionId: "s1",
    agentId: "main",
    shell: "/bin/zsh",
    cwd: "/work",
    confined: false,
    ...overrides,
  };
}

/** Fake gateway client that records requests and lets tests push events. */
function makeFakeClient() {
  const listeners = new Set<(evt: { event: string; payload: unknown }) => void>();
  const requests: Array<{
    method: string;
    params: unknown;
    options?: { timeoutMs?: number | null };
  }> = [];
  const forceReconnects: string[] = [];
  const client: TerminalGatewayClient & {
    requests: typeof requests;
    emit: (event: string, payload: unknown) => void;
    emitActivity: () => void;
    listenerCount: () => number;
    forceReconnects: string[];
    nextResponse: unknown;
  } = {
    requests,
    nextResponse: sessionResult(),
    forceReconnects,
    inboundActivitySeq: 0,
    request: <T>(method: string, params?: unknown, options?: { timeoutMs?: number | null }) => {
      requests.push({ method, params, ...(options ? { options } : {}) });
      return Promise.resolve(client.nextResponse as T);
    },
    addEventListener: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit: (event, payload) => {
      client.inboundActivitySeq! += 1;
      for (const l of listeners) {
        l({ event, payload });
      }
    },
    emitActivity: () => {
      client.inboundActivitySeq! += 1;
    },
    forceReconnect: (reason) => forceReconnects.push(reason),
    listenerCount: () => listeners.size,
  };
  return client;
}

type FakeClient = ReturnType<typeof makeFakeClient>;

function makeHarness() {
  const client = makeFakeClient();
  return { client, conn: new TerminalConnection(client) };
}

function testSink(overrides: Partial<TerminalSink> = {}): TerminalSink {
  const onData = overrides.onData ?? (() => {});
  return {
    onData,
    onReplay: ({ data }) => onData(data),
    onExit: () => {},
    ...overrides,
  };
}

function openSession(
  conn: TerminalConnection,
  overrides: Partial<TerminalSink> = {},
  params: Partial<TerminalOpenParams> = {},
) {
  return conn.open({ cols: 80, rows: 24, ...params }, testSink(overrides));
}

function emitData(client: FakeClient, seq: number, data: string, sessionId = "s1"): void {
  client.emit("terminal.data", { sessionId, seq, data });
}

function emitExit(
  client: FakeClient,
  info: { exitCode: number | null; signal: number | null; reason?: string },
  sessionId = "s1",
): void {
  client.emit("terminal.exit", { sessionId, ...info });
}

function deferRequest<T>(
  client: FakeClient,
  method: string,
  pending: ReturnType<typeof createDeferred<T>>,
): void {
  const baseRequest = client.request.bind(client);
  client.request = (<R>(
    candidate: string,
    params?: unknown,
    options?: { timeoutMs?: number | null },
  ): Promise<R> => {
    if (candidate === method) {
      client.requests.push({ method: candidate, params, ...(options ? { options } : {}) });
      return pending.promise as unknown as Promise<R>;
    }
    return baseRequest<R>(candidate, params, options);
  }) as typeof client.request;
}

async function withFakeTimers(run: () => Promise<void>): Promise<void> {
  vi.useFakeTimers();
  try {
    await run();
  } finally {
    vi.useRealTimers();
  }
}

function setLivenessProbeOutcomes(
  client: ReturnType<typeof makeFakeClient>,
  outcomes: readonly ("success" | "timeout")[],
): void {
  const baseRequest = client.request.bind(client);
  let probeIndex = 0;
  client.request = (<T>(
    method: string,
    params?: unknown,
    options?: { timeoutMs?: number | null },
  ): Promise<T> => {
    if (method !== "terminal.list") {
      return baseRequest<T>(method, params, options);
    }
    client.requests.push({ method, params, ...(options ? { options } : {}) });
    const outcome = outcomes[probeIndex++] ?? "timeout";
    if (outcome === "success") {
      return Promise.resolve({ sessions: [] } as T);
    }
    return new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error("request timed out")), options?.timeoutMs ?? 0);
    });
  }) as typeof client.request;
}

describe("TerminalConnection", () => {
  // The gateway creates the session before answering, so a response that cannot
  // drive a tab must not simply throw: the live server session would keep its
  // slot against the connection cap with nothing able to close it.
  it.each(["shell", "agentId", "cwd"] as const)(
    "closes the opened session when the response omits %s",
    async (field) => {
      const { client, conn } = makeHarness();
      const { [field]: _dropped, ...incomplete } = sessionResult();
      client.nextResponse = incomplete;

      await expect(openSession(conn)).rejects.toBeInstanceOf(TerminalOpenUnusableSessionError);

      expect(client.requests.map((request) => request.method)).toEqual([
        "terminal.open",
        "terminal.close",
      ]);
      expect(client.requests[1]?.params).toEqual({ sessionId: "s1" });
    },
  );

  it("terminates a session-scoped open when its response is unusable", async () => {
    const { client, conn } = makeHarness();
    const { shell: _dropped, ...incomplete } = sessionResult();
    client.nextResponse = incomplete;

    await expect(openSession(conn, {}, { sessionKey: "agent:main:chat" })).rejects.toBeInstanceOf(
      TerminalOpenUnusableSessionError,
    );

    expect(client.requests.at(-1)).toMatchObject({
      method: "terminal.close",
      params: { sessionId: "s1", terminate: true },
    });
  });

  it("opens a session and routes its data to the registered sink", async () => {
    const { client, conn } = makeHarness();
    const data: string[] = [];
    const result = await openSession(conn, { onData: (chunk) => data.push(chunk) });

    expect(result.sessionId).toBe("s1");
    expect(client.requests[0]).toEqual({
      method: "terminal.open",
      params: { cols: 80, rows: 24 },
      options: { timeoutMs: TERMINAL_OPEN_WATCHDOG_MS },
    });

    emitData(client, 5, "hello");
    emitData(client, 6, "!");
    expect(data).toEqual(["hello", "!"]);
  });

  it("accepts a coalesced frame whose seq marks the chunk end", async () => {
    const { client, conn } = makeHarness();
    const data: string[] = [];
    await openSession(conn, { onData: (dataChunk) => data.push(dataChunk) });

    emitData(client, 6, "abcdef");

    expect(data).toEqual(["abcdef"]);
    expect(client.requests.filter((request) => request.method === "terminal.attach")).toHaveLength(
      0,
    );
  });

  it("keeps shipped protocol-4 counter jumps diagnostic-only during version skew", async () => {
    const { client, conn } = makeHarness();
    const data: string[] = [];
    await openSession(conn, { onData: (dataChunk) => data.push(dataChunk) });

    emitData(client, 0, "hello");
    emitData(client, 7, "world");

    expect(data).toEqual(["hello", "world"]);
    expect(client.requests.filter((request) => request.method === "terminal.attach")).toHaveLength(
      0,
    );
  });

  it("does not combine a legacy recovery snapshot with indistinguishable queued frames", async () => {
    const { client, conn } = makeHarness();
    const data: string[] = [];
    const replays: string[] = [];
    const exits: unknown[] = [];
    const recovery = createDeferred<TestSessionResult>();
    await openSession(conn, {
      onData: (chunk) => data.push(chunk),
      onReplay: ({ data: snapshot }) => {
        replays.push(snapshot);
      },
      onExit: (info) => exits.push(info),
    });
    deferRequest(client, "terminal.attach", recovery);

    // A non-zero first counter is ambiguous until attach reveals an old peer.
    emitData(client, 7, "first");
    emitData(client, 8, "second");
    emitExit(client, { exitCode: null, signal: null, reason: "detached" });
    recovery.resolve(sessionResult({ buffer: "legacy snapshot containing first" }));

    await vi.waitFor(() => expect(data).toEqual(["first", "second"]));
    expect(replays).toEqual([]);
    expect(exits).toEqual([]);
    expect(client.requests.filter((request) => request.method === "terminal.attach")).toHaveLength(
      1,
    );
  });

  it("repairs a sequence gap with one authoritative attach replay", async () => {
    const { client, conn } = makeHarness();
    const data: string[] = [];
    const replays: Array<{ snapshot: string; newlyObservedFrom: number }> = [];
    const recovery = createDeferred<TestSessionResult>();
    await openSession(conn, {
      onData: (chunk) => data.push(chunk),
      onReplay: ({ data: snapshot, newlyObservedFrom }) => {
        replays.push({ snapshot, newlyObservedFrom });
      },
    });
    deferRequest(client, "terminal.attach", recovery);

    emitData(client, 5, "hello");
    // startOfChunk=7, but expected=5. The missing bytes are already in the ring.
    emitData(client, 12, "world");
    // This frame races before the server takes its attach snapshot. It must be
    // covered by replay, not rendered twice or treated as another gap.
    emitData(client, 19, "covered");
    recovery.resolve(sessionResult({ buffer: "hello??worldcovered", seq: 19 }));

    await vi.waitFor(() =>
      expect(replays).toEqual([{ snapshot: "hello??worldcovered", newlyObservedFrom: 5 }]),
    );
    expect(data).toEqual(["hello"]);
    expect(client.requests.filter((request) => request.method === "terminal.attach")).toHaveLength(
      1,
    );

    emitData(client, 20, "!");
    expect(data).toEqual(["hello", "!"]);
  });

  it("does not let a superseded recovery drain the replacement stream queue", async () => {
    const { client, conn } = makeHarness();
    const oldReplay = createDeferred();
    const oldReplayEvents: string[] = [];
    let oldReplaySignal: AbortSignal | undefined;
    await openSession(conn, {
      onData: () => {},
      onReplay: async ({ signal }) => {
        oldReplaySignal = signal;
        oldReplayEvents.push("start");
        await oldReplay.promise;
        oldReplayEvents.push("done");
      },
    });
    client.nextResponse = sessionResult({ buffer: "old snapshot", seq: 12 });
    emitData(client, 5, "hello");
    emitData(client, 12, "world");
    await vi.waitFor(() => expect(oldReplayEvents).toEqual(["start"]));
    expect(oldReplaySignal?.aborted).toBe(false);

    const newReplay = createDeferred();
    const newReplayEvents: string[] = [];
    const newData: string[] = [];
    client.nextResponse = sessionResult({ buffer: "new snapshot", seq: 20 });
    const newAttach = conn.attach("s1", {
      onData: (chunk) => newData.push(chunk),
      onReplay: async () => {
        newReplayEvents.push("start");
        await newReplay.promise;
        newReplayEvents.push("done");
      },
      onExit: () => {},
    });
    await vi.waitFor(() => expect(newReplayEvents).toEqual(["start"]));
    expect(oldReplaySignal?.aborted).toBe(true);
    emitData(client, 21, "!");

    oldReplay.resolve();
    await vi.waitFor(() => expect(oldReplayEvents).toEqual(["start", "done"]));
    await Promise.resolve();
    newReplay.resolve();
    await newAttach;

    expect(newReplayEvents).toEqual(["start", "done"]);
    expect(newData).toEqual(["!"]);
  });

  it("serializes a terminal exit behind an in-flight gap replay", async () => {
    const { client, conn } = makeHarness();
    const data: string[] = [];
    const replays: string[] = [];
    const exits: unknown[] = [];
    const recovery = createDeferred<TestSessionResult>();
    await openSession(conn, {
      onData: (chunk) => data.push(chunk),
      onReplay: ({ data: snapshot }) => {
        replays.push(snapshot);
      },
      onExit: (info) => exits.push(info),
    });
    deferRequest(client, "terminal.attach", recovery);

    emitData(client, 5, "hello");
    emitData(client, 12, "world");
    emitExit(client, { exitCode: 0, signal: null });
    expect(exits).toEqual([]);
    recovery.resolve(sessionResult({ buffer: "complete output", seq: 12 }));

    await vi.waitFor(() => expect(exits).toHaveLength(1));
    expect(data).toEqual(["hello"]);
    expect(replays).toEqual(["complete output"]);
    expect(conn.size).toBe(0);
  });

  it("discards a detached exit that predates a successful recovery rebind", async () => {
    const { client, conn } = makeHarness();
    const data: string[] = [];
    const replays: string[] = [];
    const exits: unknown[] = [];
    const recovery = createDeferred<TestSessionResult>();
    await openSession(conn, {
      onData: (chunk) => data.push(chunk),
      onReplay: ({ data: snapshot }) => {
        replays.push(snapshot);
      },
      onExit: (info) => exits.push(info),
    });
    deferRequest(client, "terminal.attach", recovery);

    emitData(client, 5, "hello");
    emitData(client, 12, "world");
    emitExit(client, { exitCode: null, signal: null, reason: "detached" });
    recovery.resolve(sessionResult({ buffer: "complete output", seq: 12 }));

    await vi.waitFor(() => expect(replays).toEqual(["complete output"]));
    emitData(client, 13, "!");
    expect(data).toEqual(["hello", "!"]);
    expect(exits).toEqual([]);
    expect(conn.size).toBe(1);
  });

  it("delivers the received tail and exit when recovery loses the finished session", async () => {
    const { client, conn } = makeHarness();
    const data: string[] = [];
    const exits: unknown[] = [];
    const recovery = createDeferred<never>();
    await openSession(conn, {
      onData: (chunk) => data.push(chunk),
      onReplay: () => {},
      onExit: (info) => exits.push(info),
    });
    deferRequest(client, "terminal.attach", recovery);

    emitData(client, 5, "hello");
    emitData(client, 12, "world");
    emitData(client, 13, "!");
    emitExit(client, { exitCode: 0, signal: null });
    recovery.reject(new Error("unknown terminal session"));

    await vi.waitFor(() => expect(exits).toHaveLength(1));
    expect(data).toEqual(["hello", "world", "!"]);
    expect(client.forceReconnects).toEqual([]);
    expect(conn.size).toBe(0);
  });

  it("keeps a queued exit behind recovery started while flushing early events", async () => {
    const { client, conn } = makeHarness();
    const openResult = createDeferred<TestSessionResult>();
    const recovery = createDeferred<TestSessionResult>();
    client.request = ((method: string, params: unknown) => {
      client.requests.push({ method, params });
      return method === "terminal.open" ? openResult.promise : recovery.promise;
    }) as typeof client.request;
    const replays: string[] = [];
    const exits: unknown[] = [];

    const opening = openSession(conn, {
      onData: () => {},
      onReplay: ({ data: snapshot }) => {
        replays.push(snapshot);
      },
      onExit: (info) => exits.push(info),
    });
    emitData(client, 7, "first");
    emitExit(client, { exitCode: 0, signal: null });
    openResult.resolve(sessionResult());
    await opening;
    expect(exits).toEqual([]);

    recovery.resolve(sessionResult({ buffer: "complete output", seq: 7 }));

    await vi.waitFor(() => expect(exits).toHaveLength(1));
    expect(replays).toEqual(["complete output"]);
    expect(conn.size).toBe(0);
  });

  it("forwards the selected agent when opening a session", async () => {
    const { client, conn } = makeHarness();
    await openSession(conn, {}, { agentId: "ops", cols: 100, rows: 30 });

    expect(client.requests[0]).toEqual({
      method: "terminal.open",
      params: { agentId: "ops", cols: 100, rows: 30 },
      options: { timeoutMs: TERMINAL_OPEN_WATCHDOG_MS },
    });
  });

  it("maps the Gateway's request-scoped terminal open deadline", async () => {
    const { client, conn } = makeHarness();
    client.request = <T>(
      method: string,
      params?: unknown,
      options?: { timeoutMs?: number | null },
    ) => {
      client.requests.push({ method, params, ...(options ? { options } : {}) });
      return Promise.reject(new Error("terminal open timed out")) as Promise<T>;
    };
    await expect(openSession(conn)).rejects.toBeInstanceOf(TerminalOpenTimeoutError);
    expect(client.requests[0]?.options).toEqual({ timeoutMs: TERMINAL_OPEN_WATCHDOG_MS });
    expect(client.forceReconnects).toEqual([]);
  });

  it("reconnects when the browser watchdog cannot receive the Gateway deadline", async () => {
    const { client, conn } = makeHarness();
    client.request = <T>(
      method: string,
      params?: unknown,
      options?: { timeoutMs?: number | null },
    ) => {
      client.requests.push({ method, params, ...(options ? { options } : {}) });
      return Promise.reject(
        new Error(`gateway request timed out after ${options?.timeoutMs}ms: ${method}`),
      ) as Promise<T>;
    };
    await expect(openSession(conn)).rejects.toBeInstanceOf(TerminalOpenTimeoutError);
    expect(client.forceReconnects).toEqual(["terminal open watchdog timeout"]);
  });

  it("forwards a typed catalog reference and preserves the returned title", async () => {
    const { client, conn } = makeHarness();
    client.nextResponse = sessionResult({ title: "codex resume 0d5c…" });
    const catalog = { catalogId: "codex", hostId: "node:mac", threadId: "thread" };
    const result = await openSession(conn, {}, { cols: 100, rows: 30, catalog });

    expect(client.requests[0]).toEqual({
      method: "terminal.open",
      params: { cols: 100, rows: 30, catalog },
      options: { timeoutMs: TERMINAL_OPEN_WATCHDOG_MS },
    });
    expect(result.title).toBe("codex resume 0d5c…");
  });

  it("does not deliver data to the wrong session", async () => {
    const { client, conn } = makeHarness();
    const data: string[] = [];
    await openSession(conn, { onData: (dataChunk) => data.push(dataChunk) });
    emitData(client, 0, "nope", "other");
    expect(data).toEqual([]);
  });

  it("delivers exit info to the owning session", async () => {
    const { client, conn } = makeHarness();
    let exit: unknown;
    await openSession(conn, { onExit: (info) => (exit = info) });
    emitExit(client, { exitCode: 0, signal: null, reason: "process_exit" });
    expect(exit).toEqual({ exitCode: 0, signal: null, reason: "process_exit", error: undefined });
    // The connection drops its own sink on exit so nothing leaks.
    expect(conn.size).toBe(0);
    expect(client.listenerCount()).toBe(0);
  });

  it("sends input, resize, and close RPCs", async () => {
    const { client, conn } = makeHarness();
    await openSession(conn);
    await conn.input("s1", "ls\n");
    await conn.resize("s1", 120, 40);
    await conn.close("s1");
    expect(client.requests.map((r) => r.method)).toEqual([
      "terminal.open",
      "terminal.input",
      "terminal.resize",
      "terminal.close",
    ]);
    expect(client.requests.at(-1)?.params).toEqual({ sessionId: "s1" });
    await conn.close("s2", { terminate: true });
    expect(client.requests.at(-1)?.params).toEqual({ sessionId: "s2", terminate: true });
  });

  it.each([
    ["terminal.input", (conn: TerminalConnection) => conn.input("s1", "echo lost\n")],
    ["terminal.resize", (conn: TerminalConnection) => conn.resize("s1", 120, 40)],
  ] as const)("marks the session unavailable when %s rejects its live owner", async (_, act) => {
    const { client, conn } = makeHarness();
    const exits: unknown[] = [];
    await openSession(conn, { onExit: (info) => exits.push(info) });
    client.nextResponse = { ok: false };

    await act(conn);

    expect(exits).toEqual([
      {
        exitCode: null,
        signal: null,
        reason: "disconnected",
        error: "Terminal session is no longer available. Open a new terminal session.",
      },
    ]);
    expect(conn.size).toBe(0);
    expect(client.listenerCount()).toBe(0);
  });

  it("buffers output that races ahead of sink registration and replays it in order", async () => {
    const { client, conn } = makeHarness();
    const data: string[] = [];
    // Hold the open response so data can arrive before the sink registers.
    const opening = createDeferred<TestSessionResult>();
    deferRequest(client, "terminal.open", opening);
    const openPromise = openSession(conn, { onData: (chunk) => data.push(chunk) });
    // Server streams the shell prompt before the client has a sink for s1.
    emitData(client, 6, "prompt");
    emitData(client, 8, "$ ");
    expect(data).toEqual([]); // buffered, not dropped

    opening.resolve(sessionResult());
    await openPromise;
    expect(data).toEqual(["prompt", "$ "]); // replayed in arrival order on registration
  });

  it("buffers an instant exit that races ahead of registration", async () => {
    const { client, conn } = makeHarness();
    const data: string[] = [];
    let exit: unknown;
    const opening = createDeferred<TestSessionResult>();
    deferRequest(client, "terminal.open", opening);
    const openPromise = openSession(conn, {
      onData: (chunk) => data.push(chunk),
      onExit: (info) => (exit = info),
    });
    // A shell that fails to exec exits before the client has a sink.
    emitData(client, 4, "boom");
    emitExit(client, { exitCode: 127, signal: null, reason: "process_exit" });
    expect(exit).toBeUndefined();

    opening.resolve(sessionResult({ shell: "/bad/shell" }));
    await openPromise;
    expect(data).toEqual(["boom"]);
    expect(exit).toEqual({ exitCode: 127, signal: null, reason: "process_exit", error: undefined });
    // Replaying the early exit releases the session — no leaked sink/listener.
    expect(conn.size).toBe(0);
    expect(client.listenerCount()).toBe(0);
  });

  it("unsubscribes from the event stream once no sessions remain", async () => {
    const { client, conn } = makeHarness();
    await openSession(conn);
    expect(client.listenerCount()).toBe(1);
    await conn.close("s1");
    expect(client.listenerCount()).toBe(0);
    expect(conn.size).toBe(0);
  });

  it("drops the listener when an open fails so failures do not leak subscriptions", async () => {
    const { client, conn } = makeHarness();
    client.request = ((method: string, params: unknown) => {
      client.requests.push({ method, params });
      // Rejected open: sandboxed agent, disabled terminal, missing PTY, etc.
      return Promise.reject(new Error("terminal open refused"));
    }) as typeof client.request;

    await expect(openSession(conn)).rejects.toThrow("terminal open refused");
    // The failed open subscribed but never registered a sink; repeated failures
    // across reconnects must not accumulate listeners on the gateway client.
    expect(conn.size).toBe(0);
    expect(client.listenerCount()).toBe(0);
  });

  it("keeps the listener while an open is in flight even if every session closes", async () => {
    const { client, conn } = makeHarness();
    await openSession(conn);

    // Second open held in flight while the only registered session closes.
    const opening = createDeferred<TestSessionResult>();
    deferRequest(client, "terminal.open", opening);
    const data: string[] = [];
    const openPromise = openSession(conn, { onData: (chunk) => data.push(chunk) });

    await conn.close("s1");
    // The in-flight open must keep the subscription so s2's early output
    // is buffered instead of silently lost.
    expect(client.listenerCount()).toBe(1);
    emitData(client, 5, "early", "s2");

    opening.resolve(sessionResult({ sessionId: "s2" }));
    await openPromise;
    expect(data).toEqual(["early"]);
  });

  it("drops the final exit the server emits while a close RPC is in flight", async () => {
    const { client, conn } = makeHarness();
    await openSession(conn);
    // A second session keeps the event subscription alive across the close.
    client.nextResponse = sessionResult({ sessionId: "s2" });
    await openSession(conn);

    // The server finalizes the session (emitting terminal.exit) before it
    // responds to terminal.close, so the event arrives with no sink.
    const baseRequest = client.request.bind(client);
    client.request = ((method: string, params: unknown) => {
      if (method === "terminal.close") {
        emitExit(client, { exitCode: null, signal: null, reason: "closed" });
      }
      return baseRequest(method, params);
    }) as typeof client.request;
    await conn.close("s1");

    // If that exit were buffered, reusing the id would replay it into the new
    // session's sink and instantly mark a live tab as exited.
    client.nextResponse = sessionResult();
    let staleExit = false;
    await openSession(conn, {
      onExit: () => {
        staleExit = true;
      },
    });
    expect(staleExit).toBe(false);
    expect(conn.size).toBe(2);
  });

  it("attach replays the buffer before events that raced ahead, then resumes live", async () => {
    const { client, conn } = makeHarness();
    const data: string[] = [];
    const attached = createDeferred<TestSessionResult>();
    deferRequest(client, "terminal.attach", attached);

    const attachPromise = conn.attach("s1", testSink({ onData: (chunk) => data.push(chunk) }));
    // Post-snapshot bytes the server emits between rebind and the response.
    emitData(client, 21, " tail");
    expect(data).toEqual([]);

    attached.resolve(sessionResult({ buffer: "replayed history", seq: 16 }));
    const result = await attachPromise;
    expect(result.buffer).toBe("replayed history");
    expect(client.requests[0]).toEqual({
      method: "terminal.attach",
      params: { sessionId: "s1" },
    });
    // Buffer first, then the raced event, then live data.
    emitData(client, 26, " live");
    expect(data).toEqual(["replayed history", " tail", " live"]);
  });

  it("awaits asynchronous initial replay before flushing live output", async () => {
    const { client, conn } = makeHarness();
    const replay = createDeferred();
    const order: string[] = [];
    client.nextResponse = sessionResult({ buffer: "snapshot", seq: 8 });

    const attachPromise = conn.attach("s1", {
      onData: (chunk) => order.push(`data:${chunk}`),
      onReplay: async ({ data: snapshot, mode }) => {
        order.push(`${mode}:${snapshot}`);
        await replay.promise;
        order.push("replay:done");
      },
      onExit: () => {},
    });
    await vi.waitFor(() => expect(order).toEqual(["initial:snapshot"]));

    emitData(client, 9, "!");
    expect(order).toEqual(["initial:snapshot"]);
    replay.resolve();

    await attachPromise;
    expect(order).toEqual(["initial:snapshot", "replay:done", "data:!"]);
  });

  it("rejects initial replay failures without retaining a stream", async () => {
    const { client, conn } = makeHarness();
    client.nextResponse = sessionResult({ buffer: "snapshot", seq: 8 });

    let replaySignal: AbortSignal | undefined;
    await expect(
      conn.attach("s1", {
        onData: () => {},
        onReplay: async ({ signal }) => {
          replaySignal = signal;
          throw new Error("replay failed");
        },
        onExit: () => {},
      }),
    ).rejects.toThrow("replay failed");
    expect(replaySignal?.aborted).toBe(true);
    expect(conn.size).toBe(0);
    expect(client.listenerCount()).toBe(0);
  });

  it.each(["close", "exit", "dispose"] as const)(
    "aborts the replay lifetime when a stream ends via %s",
    async (ending) => {
      const { client, conn } = makeHarness();
      client.nextResponse = sessionResult({ buffer: "snapshot", seq: 8 });
      let replaySignal: AbortSignal | undefined;
      let abortedAtExit: boolean | undefined;
      await conn.attach("s1", {
        onData: () => {},
        onReplay: ({ signal }) => {
          replaySignal = signal;
        },
        onExit: () => {
          abortedAtExit = replaySignal?.aborted;
        },
      });

      if (ending === "close") {
        await conn.close("s1");
      } else if (ending === "exit") {
        emitExit(client, { exitCode: 0, signal: null });
      } else {
        conn.dispose();
      }

      expect(replaySignal?.aborted).toBe(true);
      if (ending === "exit") {
        expect(abortedAtExit).toBe(true);
      }
    },
  );

  it("discards a detached exit that predates successful session adoption", async () => {
    const { client, conn } = makeHarness();
    const replays: string[] = [];
    const data: string[] = [];
    const exits: unknown[] = [];
    const attached = createDeferred<TestSessionResult>();
    deferRequest(client, "terminal.attach", attached);

    const attachPromise = conn.attach("s1", {
      onData: (chunk) => data.push(chunk),
      onReplay: ({ data: snapshot }) => {
        replays.push(snapshot);
      },
      onExit: (info) => exits.push(info),
    });
    emitExit(client, { exitCode: null, signal: null, reason: "detached" });
    attached.resolve(sessionResult({ buffer: "snapshot", seq: 8 }));

    await attachPromise;
    emitData(client, 9, "!");
    expect(replays).toEqual(["snapshot"]);
    expect(data).toEqual(["!"]);
    expect(exits).toEqual([]);
    expect(conn.size).toBe(1);
  });

  it("preserves output that races an older gateway replay with no offset", async () => {
    const { client, conn } = makeHarness();
    const data: string[] = [];
    const attached = createDeferred<TestSessionResult>();
    deferRequest(client, "terminal.attach", attached);

    const attachPromise = conn.attach("s1", testSink({ onData: (chunk) => data.push(chunk) }));
    emitData(client, 41, "raced");
    attached.resolve(sessionResult({ buffer: "legacy replay" }));
    await attachPromise;
    emitData(client, 42, "live");
    emitData(client, 43, "more");

    expect(data).toEqual(["legacy replay", "raced", "live", "more"]);
    expect(client.requests.filter((request) => request.method === "terminal.attach")).toHaveLength(
      1,
    );
  });

  it("drops the listener when an attach fails so failures do not leak subscriptions", async () => {
    const { client, conn } = makeHarness();
    client.request = ((method: string, params: unknown) => {
      client.requests.push({ method, params });
      // Expired/unknown session after the detach grace period.
      return Promise.reject(new Error("unknown terminal session"));
    }) as typeof client.request;

    await expect(conn.attach("gone", testSink())).rejects.toThrow("unknown terminal session");
    expect(conn.size).toBe(0);
    expect(client.listenerCount()).toBe(0);
  });

  it("lists attachable sessions and tolerates a missing sessions field", async () => {
    const { client, conn } = makeHarness();
    const info = {
      sessionId: "s1",
      agentId: "main",
      shell: "/bin/zsh",
      cwd: "/work",
      confined: false,
      attached: false,
      createdAtMs: 1,
    };
    client.nextResponse = { sessions: [info] };
    expect(await conn.list()).toEqual([info]);
    client.nextResponse = {};
    expect(await conn.list()).toEqual([]);
  });

  it("keeps the socket after one failed liveness probe and retries on a short backoff", () =>
    withFakeTimers(async () => {
      const { client, conn } = makeHarness();
      setLivenessProbeOutcomes(client, ["timeout"]);
      await openSession(conn);
      const probes = () =>
        client.requests.filter((request) => request.method === "terminal.list").length;

      await vi.advanceTimersByTimeAsync(IDLE_PLUS_PROBE_MS);
      expect(probes()).toBe(1);
      // A single failure only schedules the short retry; it never tears down the socket.
      expect(client.forceReconnects).toEqual([]);
      await vi.advanceTimersByTimeAsync(TERMINAL_LIVENESS_FAILURE_RETRY_MS);
      expect(probes()).toBe(2);
      conn.dispose();
    }));

  it("forces exactly one reconnect after two consecutive failed liveness probes", () =>
    withFakeTimers(async () => {
      const { client, conn } = makeHarness();
      setLivenessProbeOutcomes(client, ["timeout", "timeout"]);
      await openSession(conn);

      await vi.advanceTimersByTimeAsync(IDLE_PLUS_PROBE_MS);
      expect(client.forceReconnects).toEqual([]);
      await vi.advanceTimersByTimeAsync(
        TERMINAL_LIVENESS_FAILURE_RETRY_MS + TERMINAL_LIVENESS_PROBE_TIMEOUT_MS,
      );
      expect(client.forceReconnects).toEqual(["terminal liveness timeout"]);
      conn.dispose();
    }));

  it("resets liveness failures after a successful probe", () =>
    withFakeTimers(async () => {
      const { client, conn } = makeHarness();
      setLivenessProbeOutcomes(client, ["timeout", "success", "timeout"]);
      await openSession(conn);

      // Probes: timeout (fail), success (clears the streak), timeout (fail again).
      await vi.advanceTimersByTimeAsync(IDLE_PLUS_PROBE_MS);
      await vi.advanceTimersByTimeAsync(TERMINAL_LIVENESS_FAILURE_RETRY_MS + IDLE_PLUS_PROBE_MS);
      // The middle success reset the streak, so the later lone failure cannot reconnect.
      expect(client.forceReconnects).toEqual([]);
      conn.dispose();
    }));

  it("keeps the socket when other inbound traffic arrives during a failed probe", () =>
    withFakeTimers(async () => {
      const { client, conn } = makeHarness();
      setLivenessProbeOutcomes(client, ["timeout", "timeout"]);
      await openSession(conn);

      await vi.advanceTimersByTimeAsync(TERMINAL_LIVENESS_IDLE_MS);
      // A frame delivered mid-probe proves the socket alive, so the probe timeout is not counted.
      client.emitActivity();
      await vi.advanceTimersByTimeAsync(TERMINAL_LIVENESS_PROBE_TIMEOUT_MS + IDLE_PLUS_PROBE_MS);

      expect(client.forceReconnects).toEqual([]);
      conn.dispose();
    }));

  it("restarts the full idle window when inbound traffic arrives during the retry backoff", () =>
    withFakeTimers(async () => {
      const { client, conn } = makeHarness();
      setLivenessProbeOutcomes(client, ["timeout", "timeout"]);
      await openSession(conn);

      const probeCount = () =>
        client.requests.filter((request) => request.method === "terminal.list").length;
      // First probe fails and schedules the short 5s retry.
      await vi.advanceTimersByTimeAsync(IDLE_PLUS_PROBE_MS);
      expect(probeCount()).toBe(1);

      // A non-terminal frame proves the socket alive during the backoff: the next check treats it
      // as fresh activity and waits a full idle window instead of re-probing on the short retry, so
      // no second probe fires and no reconnect happens.
      client.emitActivity();
      await vi.advanceTimersByTimeAsync(
        TERMINAL_LIVENESS_FAILURE_RETRY_MS + TERMINAL_LIVENESS_PROBE_TIMEOUT_MS,
      );
      expect(probeCount()).toBe(1);
      expect(client.forceReconnects).toEqual([]);
      conn.dispose();
    }));

  it("dispose() drops the gateway subscription and clears buffered state", async () => {
    const { client, conn } = makeHarness();
    await openSession(conn);
    expect(client.listenerCount()).toBe(1);
    // Panel teardown (disconnect/disable) discards the connection.
    conn.dispose();
    expect(client.listenerCount()).toBe(0);
    expect(conn.size).toBe(0);
  });
});
