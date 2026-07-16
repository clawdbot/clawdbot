import { describe, expect, it, vi } from "vitest";
import {
  TerminalConnection,
  type TerminalGatewayClient,
  TerminalOpenTimeoutError,
} from "./terminal-connection.ts";

const TERMINAL_LIVENESS_IDLE_MS = 20_000;
const TERMINAL_LIVENESS_PROBE_TIMEOUT_MS = 5_000;
const TERMINAL_OPEN_WATCHDOG_MS = 35_000;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, resolve, reject };
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
    nextResponse: {
      sessionId: "s1",
      agentId: "main",
      shell: "/bin/zsh",
      cwd: "/work",
      confined: false,
    },
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

describe("TerminalConnection", () => {
  it("opens a session and routes its data to the registered sink", async () => {
    const client = makeFakeClient();
    const conn = new TerminalConnection(client);
    const data: string[] = [];
    const result = await conn.open(
      { cols: 80, rows: 24 },
      { onData: (d) => data.push(d), onExit: () => {} },
    );

    expect(result.sessionId).toBe("s1");
    expect(client.requests[0]).toEqual({
      method: "terminal.open",
      params: { cols: 80, rows: 24 },
      options: { timeoutMs: TERMINAL_OPEN_WATCHDOG_MS },
    });

    client.emit("terminal.data", { sessionId: "s1", seq: 5, data: "hello" });
    client.emit("terminal.data", { sessionId: "s1", seq: 6, data: "!" });
    expect(data).toEqual(["hello", "!"]);
  });

  it("accepts a coalesced frame whose seq marks the chunk end", async () => {
    const client = makeFakeClient();
    const conn = new TerminalConnection(client);
    const data: string[] = [];
    await conn.open({ cols: 80, rows: 24 }, { onData: (d) => data.push(d), onExit: () => {} });

    client.emit("terminal.data", { sessionId: "s1", seq: 6, data: "abcdef" });

    expect(data).toEqual(["abcdef"]);
    expect(client.requests.filter((request) => request.method === "terminal.attach")).toHaveLength(
      0,
    );
  });

  it("keeps shipped protocol-4 counter jumps diagnostic-only during version skew", async () => {
    const client = makeFakeClient();
    const conn = new TerminalConnection(client);
    const data: string[] = [];
    await conn.open({ cols: 80, rows: 24 }, { onData: (d) => data.push(d), onExit: () => {} });

    client.emit("terminal.data", { sessionId: "s1", seq: 0, data: "hello" });
    client.emit("terminal.data", { sessionId: "s1", seq: 7, data: "world" });

    expect(data).toEqual(["hello", "world"]);
    expect(client.requests.filter((request) => request.method === "terminal.attach")).toHaveLength(
      0,
    );
  });

  it("does not combine a legacy recovery snapshot with indistinguishable queued frames", async () => {
    const client = makeFakeClient();
    const conn = new TerminalConnection(client);
    const data: string[] = [];
    const replays: string[] = [];
    const exits: unknown[] = [];
    const recovery = deferred<{
      sessionId: string;
      agentId: string;
      shell: string;
      cwd: string;
      confined: boolean;
      buffer: string;
    }>();
    await conn.open(
      { cols: 80, rows: 24 },
      {
        onData: (chunk) => data.push(chunk),
        onReplay: (snapshot) => replays.push(snapshot),
        onExit: (info) => exits.push(info),
      },
    );
    const baseRequest = client.request.bind(client);
    client.request = ((
      method: string,
      params: unknown,
      options?: { timeoutMs?: number | null },
    ) => {
      if (method === "terminal.attach") {
        client.requests.push({ method, params });
        return recovery.promise;
      }
      return baseRequest(method, params, options);
    }) as typeof client.request;

    // A non-zero first counter is ambiguous until attach reveals an old peer.
    client.emit("terminal.data", { sessionId: "s1", seq: 7, data: "first" });
    client.emit("terminal.data", { sessionId: "s1", seq: 8, data: "second" });
    client.emit("terminal.exit", {
      sessionId: "s1",
      exitCode: null,
      signal: null,
      reason: "detached",
    });
    recovery.resolve({
      sessionId: "s1",
      agentId: "main",
      shell: "/bin/zsh",
      cwd: "/work",
      confined: false,
      buffer: "legacy snapshot containing first",
    });

    await vi.waitFor(() => expect(data).toEqual(["first", "second"]));
    expect(replays).toEqual([]);
    expect(exits).toEqual([]);
    expect(client.requests.filter((request) => request.method === "terminal.attach")).toHaveLength(
      1,
    );
  });

  it("repairs a sequence gap with one authoritative attach replay", async () => {
    const client = makeFakeClient();
    const conn = new TerminalConnection(client);
    const data: string[] = [];
    const replays: Array<{ snapshot: string; newlyObservedFrom: number }> = [];
    const recovery = deferred<{
      sessionId: string;
      agentId: string;
      shell: string;
      cwd: string;
      confined: boolean;
      buffer: string;
      seq: number;
    }>();
    await conn.open(
      { cols: 80, rows: 24 },
      {
        onData: (chunk) => data.push(chunk),
        onReplay: (snapshot, newlyObservedFrom) => replays.push({ snapshot, newlyObservedFrom }),
        onExit: () => {},
      },
    );
    const baseRequest = client.request.bind(client);
    client.request = ((
      method: string,
      params: unknown,
      options?: { timeoutMs?: number | null },
    ) => {
      if (method === "terminal.attach") {
        client.requests.push({ method, params });
        return recovery.promise;
      }
      return baseRequest(method, params, options);
    }) as typeof client.request;

    client.emit("terminal.data", { sessionId: "s1", seq: 5, data: "hello" });
    // startOfChunk=7, but expected=5. The missing bytes are already in the ring.
    client.emit("terminal.data", { sessionId: "s1", seq: 12, data: "world" });
    // This frame races before the server takes its attach snapshot. It must be
    // covered by replay, not rendered twice or treated as another gap.
    client.emit("terminal.data", { sessionId: "s1", seq: 19, data: "covered" });
    recovery.resolve({
      sessionId: "s1",
      agentId: "main",
      shell: "/bin/zsh",
      cwd: "/work",
      confined: false,
      buffer: "hello??worldcovered",
      seq: 19,
    });

    await vi.waitFor(() =>
      expect(replays).toEqual([{ snapshot: "hello??worldcovered", newlyObservedFrom: 5 }]),
    );
    expect(data).toEqual(["hello"]);
    expect(client.requests.filter((request) => request.method === "terminal.attach")).toHaveLength(
      1,
    );

    client.emit("terminal.data", { sessionId: "s1", seq: 20, data: "!" });
    expect(data).toEqual(["hello", "!"]);
  });

  it("never appends a recovery snapshot when the sink cannot reset", async () => {
    const client = makeFakeClient();
    const conn = new TerminalConnection(client);
    const data: string[] = [];
    await conn.open(
      { cols: 80, rows: 24 },
      { onData: (chunk) => data.push(chunk), onExit: () => {} },
    );
    client.nextResponse = {
      sessionId: "s1",
      agentId: "main",
      shell: "/bin/zsh",
      cwd: "/work",
      confined: false,
      buffer: "authoritative snapshot",
      seq: 12,
    };

    client.emit("terminal.data", { sessionId: "s1", seq: 5, data: "hello" });
    client.emit("terminal.data", { sessionId: "s1", seq: 12, data: "world" });

    await vi.waitFor(() =>
      expect(client.forceReconnects).toEqual(["terminal replay reset unavailable"]),
    );
    expect(data).toEqual(["hello"]);
  });

  it("serializes a terminal exit behind an in-flight gap replay", async () => {
    const client = makeFakeClient();
    const conn = new TerminalConnection(client);
    const data: string[] = [];
    const replays: string[] = [];
    const exits: unknown[] = [];
    const recovery = deferred<{
      sessionId: string;
      agentId: string;
      shell: string;
      cwd: string;
      confined: boolean;
      buffer: string;
      seq: number;
    }>();
    await conn.open(
      { cols: 80, rows: 24 },
      {
        onData: (chunk) => data.push(chunk),
        onReplay: (snapshot) => replays.push(snapshot),
        onExit: (info) => exits.push(info),
      },
    );
    const baseRequest = client.request.bind(client);
    client.request = ((method: string, params: unknown) => {
      if (method === "terminal.attach") {
        client.requests.push({ method, params });
        return recovery.promise;
      }
      return baseRequest(method, params);
    }) as typeof client.request;

    client.emit("terminal.data", { sessionId: "s1", seq: 5, data: "hello" });
    client.emit("terminal.data", { sessionId: "s1", seq: 12, data: "world" });
    client.emit("terminal.exit", { sessionId: "s1", exitCode: 0, signal: null });
    expect(exits).toEqual([]);
    recovery.resolve({
      sessionId: "s1",
      agentId: "main",
      shell: "/bin/zsh",
      cwd: "/work",
      confined: false,
      buffer: "complete output",
      seq: 12,
    });

    await vi.waitFor(() => expect(exits).toHaveLength(1));
    expect(data).toEqual(["hello"]);
    expect(replays).toEqual(["complete output"]);
    expect(conn.size).toBe(0);
  });

  it("discards a detached exit that predates a successful recovery rebind", async () => {
    const client = makeFakeClient();
    const conn = new TerminalConnection(client);
    const data: string[] = [];
    const replays: string[] = [];
    const exits: unknown[] = [];
    const recovery = deferred<{
      sessionId: string;
      agentId: string;
      shell: string;
      cwd: string;
      confined: boolean;
      buffer: string;
      seq: number;
    }>();
    await conn.open(
      { cols: 80, rows: 24 },
      {
        onData: (chunk) => data.push(chunk),
        onReplay: (snapshot) => replays.push(snapshot),
        onExit: (info) => exits.push(info),
      },
    );
    const baseRequest = client.request.bind(client);
    client.request = ((method: string, params: unknown) => {
      if (method === "terminal.attach") {
        client.requests.push({ method, params });
        return recovery.promise;
      }
      return baseRequest(method, params);
    }) as typeof client.request;

    client.emit("terminal.data", { sessionId: "s1", seq: 5, data: "hello" });
    client.emit("terminal.data", { sessionId: "s1", seq: 12, data: "world" });
    client.emit("terminal.exit", {
      sessionId: "s1",
      exitCode: null,
      signal: null,
      reason: "detached",
    });
    recovery.resolve({
      sessionId: "s1",
      agentId: "main",
      shell: "/bin/zsh",
      cwd: "/work",
      confined: false,
      buffer: "complete output",
      seq: 12,
    });

    await vi.waitFor(() => expect(replays).toEqual(["complete output"]));
    client.emit("terminal.data", { sessionId: "s1", seq: 13, data: "!" });
    expect(data).toEqual(["hello", "!"]);
    expect(exits).toEqual([]);
    expect(conn.size).toBe(1);
  });

  it("delivers the received tail and exit when recovery loses the finished session", async () => {
    const client = makeFakeClient();
    const conn = new TerminalConnection(client);
    const data: string[] = [];
    const exits: unknown[] = [];
    const recovery = deferred<never>();
    await conn.open(
      { cols: 80, rows: 24 },
      {
        onData: (chunk) => data.push(chunk),
        onReplay: () => {},
        onExit: (info) => exits.push(info),
      },
    );
    const baseRequest = client.request.bind(client);
    client.request = ((method: string, params: unknown) => {
      if (method === "terminal.attach") {
        client.requests.push({ method, params });
        return recovery.promise;
      }
      return baseRequest(method, params);
    }) as typeof client.request;

    client.emit("terminal.data", { sessionId: "s1", seq: 5, data: "hello" });
    client.emit("terminal.data", { sessionId: "s1", seq: 12, data: "world" });
    client.emit("terminal.data", { sessionId: "s1", seq: 13, data: "!" });
    client.emit("terminal.exit", { sessionId: "s1", exitCode: 0, signal: null });
    recovery.reject(new Error("unknown terminal session"));

    await vi.waitFor(() => expect(exits).toHaveLength(1));
    expect(data).toEqual(["hello", "world", "!"]);
    expect(client.forceReconnects).toEqual([]);
    expect(conn.size).toBe(0);
  });

  it("keeps a queued exit behind recovery started while flushing early events", async () => {
    const client = makeFakeClient();
    const conn = new TerminalConnection(client);
    const openResult = deferred<{
      sessionId: string;
      agentId: string;
      shell: string;
      cwd: string;
      confined: boolean;
    }>();
    const recovery = deferred<{
      sessionId: string;
      agentId: string;
      shell: string;
      cwd: string;
      confined: boolean;
      buffer: string;
      seq: number;
    }>();
    client.request = ((method: string, params: unknown) => {
      client.requests.push({ method, params });
      return method === "terminal.open" ? openResult.promise : recovery.promise;
    }) as typeof client.request;
    const replays: string[] = [];
    const exits: unknown[] = [];

    const opening = conn.open(
      { cols: 80, rows: 24 },
      {
        onData: () => {},
        onReplay: (snapshot) => replays.push(snapshot),
        onExit: (info) => exits.push(info),
      },
    );
    client.emit("terminal.data", { sessionId: "s1", seq: 7, data: "first" });
    client.emit("terminal.exit", { sessionId: "s1", exitCode: 0, signal: null });
    openResult.resolve({
      sessionId: "s1",
      agentId: "main",
      shell: "/bin/zsh",
      cwd: "/work",
      confined: false,
    });
    await opening;
    expect(exits).toEqual([]);

    recovery.resolve({
      sessionId: "s1",
      agentId: "main",
      shell: "/bin/zsh",
      cwd: "/work",
      confined: false,
      buffer: "complete output",
      seq: 7,
    });

    await vi.waitFor(() => expect(exits).toHaveLength(1));
    expect(replays).toEqual(["complete output"]);
    expect(conn.size).toBe(0);
  });

  it("forwards the selected agent when opening a session", async () => {
    const client = makeFakeClient();
    const conn = new TerminalConnection(client);
    await conn.open(
      { agentId: "ops", cols: 100, rows: 30 },
      { onData: () => {}, onExit: () => {} },
    );

    expect(client.requests[0]).toEqual({
      method: "terminal.open",
      params: { agentId: "ops", cols: 100, rows: 30 },
      options: { timeoutMs: TERMINAL_OPEN_WATCHDOG_MS },
    });
  });

  it("maps the Gateway's request-scoped terminal open deadline", async () => {
    const client = makeFakeClient();
    client.request = <T>(
      method: string,
      params?: unknown,
      options?: { timeoutMs?: number | null },
    ) => {
      client.requests.push({ method, params, ...(options ? { options } : {}) });
      return Promise.reject(new Error("terminal open timed out")) as Promise<T>;
    };
    const conn = new TerminalConnection(client);

    await expect(
      conn.open({ cols: 80, rows: 24 }, { onData: () => {}, onExit: () => {} }),
    ).rejects.toBeInstanceOf(TerminalOpenTimeoutError);
    expect(client.requests[0]?.options).toEqual({ timeoutMs: TERMINAL_OPEN_WATCHDOG_MS });
    expect(client.forceReconnects).toEqual([]);
  });

  it("reconnects when the browser watchdog cannot receive the Gateway deadline", async () => {
    const client = makeFakeClient();
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
    const conn = new TerminalConnection(client);

    await expect(
      conn.open({ cols: 80, rows: 24 }, { onData: () => {}, onExit: () => {} }),
    ).rejects.toBeInstanceOf(TerminalOpenTimeoutError);
    expect(client.forceReconnects).toEqual(["terminal open watchdog timeout"]);
  });

  it("forwards a typed catalog reference and preserves the returned title", async () => {
    const client = makeFakeClient();
    client.nextResponse = {
      sessionId: "s1",
      agentId: "main",
      shell: "/bin/zsh",
      cwd: "/work",
      confined: false,
      title: "codex resume 0d5c…",
    };
    const conn = new TerminalConnection(client);
    const catalog = { catalogId: "codex", hostId: "node:mac", threadId: "thread" };
    const result = await conn.open(
      { cols: 100, rows: 30, catalog },
      { onData: () => {}, onExit: () => {} },
    );

    expect(client.requests[0]).toEqual({
      method: "terminal.open",
      params: { cols: 100, rows: 30, catalog },
      options: { timeoutMs: TERMINAL_OPEN_WATCHDOG_MS },
    });
    expect(result.title).toBe("codex resume 0d5c…");
  });

  it("does not deliver data to the wrong session", async () => {
    const client = makeFakeClient();
    const conn = new TerminalConnection(client);
    const data: string[] = [];
    await conn.open({ cols: 80, rows: 24 }, { onData: (d) => data.push(d), onExit: () => {} });
    client.emit("terminal.data", { sessionId: "other", seq: 0, data: "nope" });
    expect(data).toEqual([]);
  });

  it("delivers exit info to the owning session", async () => {
    const client = makeFakeClient();
    const conn = new TerminalConnection(client);
    let exit: unknown;
    await conn.open({ cols: 80, rows: 24 }, { onData: () => {}, onExit: (info) => (exit = info) });
    client.emit("terminal.exit", {
      sessionId: "s1",
      exitCode: 0,
      signal: null,
      reason: "process_exit",
    });
    expect(exit).toEqual({ exitCode: 0, signal: null, reason: "process_exit", error: undefined });
    // The connection drops its own sink on exit so nothing leaks.
    expect(conn.size).toBe(0);
    expect(client.listenerCount()).toBe(0);
  });

  it("sends input, resize, and close RPCs", async () => {
    const client = makeFakeClient();
    const conn = new TerminalConnection(client);
    await conn.open({ cols: 80, rows: 24 }, { onData: () => {}, onExit: () => {} });
    await conn.input("s1", "ls\n");
    await conn.resize("s1", 120, 40);
    await conn.close("s1");
    expect(client.requests.map((r) => r.method)).toEqual([
      "terminal.open",
      "terminal.input",
      "terminal.resize",
      "terminal.close",
    ]);
  });

  it("buffers output that races ahead of sink registration and replays it in order", async () => {
    const client = makeFakeClient();
    const conn = new TerminalConnection(client);
    const data: string[] = [];
    // Hold the open response so data can arrive before the sink registers.
    let resolveOpen: (() => void) | undefined;
    client.request = ((method: string, params: unknown) => {
      client.requests.push({ method, params });
      if (method === "terminal.open") {
        return new Promise<unknown>((resolve) => {
          resolveOpen = () =>
            resolve({
              sessionId: "s1",
              agentId: "main",
              shell: "/bin/zsh",
              cwd: "/work",
              confined: false,
            });
        });
      }
      return Promise.resolve({});
    }) as typeof client.request;

    const openPromise = conn.open(
      { cols: 80, rows: 24 },
      { onData: (d) => data.push(d), onExit: () => {} },
    );
    // Server streams the shell prompt before the client has a sink for s1.
    client.emit("terminal.data", { sessionId: "s1", seq: 6, data: "prompt" });
    client.emit("terminal.data", { sessionId: "s1", seq: 8, data: "$ " });
    expect(data).toEqual([]); // buffered, not dropped

    resolveOpen?.();
    await openPromise;
    expect(data).toEqual(["prompt", "$ "]); // replayed in arrival order on registration
  });

  it("buffers an instant exit that races ahead of registration", async () => {
    const client = makeFakeClient();
    const conn = new TerminalConnection(client);
    const data: string[] = [];
    let exit: unknown;
    let resolveOpen: (() => void) | undefined;
    client.request = ((method: string, params: unknown) => {
      client.requests.push({ method, params });
      if (method === "terminal.open") {
        return new Promise<unknown>((resolve) => {
          resolveOpen = () =>
            resolve({
              sessionId: "s1",
              agentId: "main",
              shell: "/bad/shell",
              cwd: "/work",
              confined: false,
            });
        });
      }
      return Promise.resolve({});
    }) as typeof client.request;

    const openPromise = conn.open(
      { cols: 80, rows: 24 },
      { onData: (d) => data.push(d), onExit: (info) => (exit = info) },
    );
    // A shell that fails to exec exits before the client has a sink.
    client.emit("terminal.data", { sessionId: "s1", seq: 4, data: "boom" });
    client.emit("terminal.exit", {
      sessionId: "s1",
      exitCode: 127,
      signal: null,
      reason: "process_exit",
    });
    expect(exit).toBeUndefined();

    resolveOpen?.();
    await openPromise;
    expect(data).toEqual(["boom"]);
    expect(exit).toEqual({ exitCode: 127, signal: null, reason: "process_exit", error: undefined });
    // Replaying the early exit releases the session — no leaked sink/listener.
    expect(conn.size).toBe(0);
    expect(client.listenerCount()).toBe(0);
  });

  it("unsubscribes from the event stream once no sessions remain", async () => {
    const client = makeFakeClient();
    const conn = new TerminalConnection(client);
    await conn.open({ cols: 80, rows: 24 }, { onData: () => {}, onExit: () => {} });
    expect(client.listenerCount()).toBe(1);
    await conn.close("s1");
    expect(client.listenerCount()).toBe(0);
    expect(conn.size).toBe(0);
  });

  it("drops the listener when an open fails so failures do not leak subscriptions", async () => {
    const client = makeFakeClient();
    const conn = new TerminalConnection(client);
    client.request = ((method: string, params: unknown) => {
      client.requests.push({ method, params });
      // Rejected open: sandboxed agent, disabled terminal, missing PTY, etc.
      return Promise.reject(new Error("terminal open refused"));
    }) as typeof client.request;

    await expect(
      conn.open({ cols: 80, rows: 24 }, { onData: () => {}, onExit: () => {} }),
    ).rejects.toThrow("terminal open refused");
    // The failed open subscribed but never registered a sink; repeated failures
    // across reconnects must not accumulate listeners on the gateway client.
    expect(conn.size).toBe(0);
    expect(client.listenerCount()).toBe(0);
  });

  it("keeps the listener while an open is in flight even if every session closes", async () => {
    const client = makeFakeClient();
    const conn = new TerminalConnection(client);
    await conn.open({ cols: 80, rows: 24 }, { onData: () => {}, onExit: () => {} });

    // Second open held in flight while the only registered session closes.
    let resolveOpen: (() => void) | undefined;
    client.request = ((method: string, params: unknown) => {
      client.requests.push({ method, params });
      if (method === "terminal.open") {
        return new Promise<unknown>((resolve) => {
          resolveOpen = () =>
            resolve({
              sessionId: "s2",
              agentId: "main",
              shell: "/bin/zsh",
              cwd: "/work",
              confined: false,
            });
        });
      }
      return Promise.resolve({});
    }) as typeof client.request;
    const data: string[] = [];
    const openPromise = conn.open(
      { cols: 80, rows: 24 },
      { onData: (d) => data.push(d), onExit: () => {} },
    );

    await conn.close("s1");
    // The in-flight open must keep the subscription so s2's early output
    // is buffered instead of silently lost.
    expect(client.listenerCount()).toBe(1);
    client.emit("terminal.data", { sessionId: "s2", seq: 5, data: "early" });

    resolveOpen?.();
    await openPromise;
    expect(data).toEqual(["early"]);
  });

  it("drops the final exit the server emits while a close RPC is in flight", async () => {
    const client = makeFakeClient();
    const conn = new TerminalConnection(client);
    await conn.open({ cols: 80, rows: 24 }, { onData: () => {}, onExit: () => {} });
    // A second session keeps the event subscription alive across the close.
    client.nextResponse = {
      sessionId: "s2",
      agentId: "main",
      shell: "/bin/zsh",
      cwd: "/work",
      confined: false,
    };
    await conn.open({ cols: 80, rows: 24 }, { onData: () => {}, onExit: () => {} });

    // The server finalizes the session (emitting terminal.exit) before it
    // responds to terminal.close, so the event arrives with no sink.
    const baseRequest = client.request.bind(client);
    client.request = ((method: string, params: unknown) => {
      if (method === "terminal.close") {
        client.emit("terminal.exit", {
          sessionId: "s1",
          exitCode: null,
          signal: null,
          reason: "closed",
        });
      }
      return baseRequest(method, params);
    }) as typeof client.request;
    await conn.close("s1");

    // If that exit were buffered, reusing the id would replay it into the new
    // session's sink and instantly mark a live tab as exited.
    client.nextResponse = {
      sessionId: "s1",
      agentId: "main",
      shell: "/bin/zsh",
      cwd: "/work",
      confined: false,
    };
    let staleExit = false;
    await conn.open(
      { cols: 80, rows: 24 },
      {
        onData: () => {},
        onExit: () => {
          staleExit = true;
        },
      },
    );
    expect(staleExit).toBe(false);
    expect(conn.size).toBe(2);
  });

  it("attach replays the buffer before events that raced ahead, then resumes live", async () => {
    const client = makeFakeClient();
    const conn = new TerminalConnection(client);
    const data: string[] = [];
    let resolveAttach: (() => void) | undefined;
    client.request = ((method: string, params: unknown) => {
      client.requests.push({ method, params });
      if (method === "terminal.attach") {
        return new Promise<unknown>((resolve) => {
          resolveAttach = () =>
            resolve({
              sessionId: "s1",
              agentId: "main",
              shell: "/bin/zsh",
              cwd: "/work",
              confined: false,
              buffer: "replayed history",
              seq: 16,
            });
        });
      }
      return Promise.resolve({});
    }) as typeof client.request;

    const attachPromise = conn.attach("s1", {
      onData: (d) => data.push(d),
      onExit: () => {},
    });
    // Post-snapshot bytes the server emits between rebind and the response.
    client.emit("terminal.data", { sessionId: "s1", seq: 21, data: " tail" });
    expect(data).toEqual([]);

    resolveAttach?.();
    const result = await attachPromise;
    expect(result.buffer).toBe("replayed history");
    expect(client.requests[0]).toEqual({
      method: "terminal.attach",
      params: { sessionId: "s1" },
    });
    // Buffer first, then the raced event, then live data.
    client.emit("terminal.data", { sessionId: "s1", seq: 26, data: " live" });
    expect(data).toEqual(["replayed history", " tail", " live"]);
  });

  it("discards a detached exit that predates successful session adoption", async () => {
    const client = makeFakeClient();
    const conn = new TerminalConnection(client);
    const replays: string[] = [];
    const data: string[] = [];
    const exits: unknown[] = [];
    const attached = deferred<{
      sessionId: string;
      agentId: string;
      shell: string;
      cwd: string;
      confined: boolean;
      buffer: string;
      seq: number;
    }>();
    client.request = ((method: string, params: unknown) => {
      client.requests.push({ method, params });
      return attached.promise;
    }) as typeof client.request;

    const attachPromise = conn.attach("s1", {
      onData: (chunk) => data.push(chunk),
      onReplay: (snapshot) => replays.push(snapshot),
      onExit: (info) => exits.push(info),
    });
    client.emit("terminal.exit", {
      sessionId: "s1",
      exitCode: null,
      signal: null,
      reason: "detached",
    });
    attached.resolve({
      sessionId: "s1",
      agentId: "main",
      shell: "/bin/zsh",
      cwd: "/work",
      confined: false,
      buffer: "snapshot",
      seq: 8,
    });

    await attachPromise;
    client.emit("terminal.data", { sessionId: "s1", seq: 9, data: "!" });
    expect(replays).toEqual(["snapshot"]);
    expect(data).toEqual(["!"]);
    expect(exits).toEqual([]);
    expect(conn.size).toBe(1);
  });

  it("preserves output that races an older gateway replay with no offset", async () => {
    const client = makeFakeClient();
    const conn = new TerminalConnection(client);
    const data: string[] = [];
    let resolveAttach: (() => void) | undefined;
    client.request = ((method: string, params: unknown) => {
      client.requests.push({ method, params });
      return new Promise<unknown>((resolve) => {
        resolveAttach = () =>
          resolve({
            sessionId: "s1",
            agentId: "main",
            shell: "/bin/zsh",
            cwd: "/work",
            confined: false,
            buffer: "legacy replay",
          });
      });
    }) as typeof client.request;

    const attachPromise = conn.attach("s1", {
      onData: (chunk) => data.push(chunk),
      onExit: () => {},
    });
    client.emit("terminal.data", { sessionId: "s1", seq: 41, data: "raced" });
    resolveAttach?.();
    await attachPromise;
    client.emit("terminal.data", { sessionId: "s1", seq: 42, data: "live" });
    client.emit("terminal.data", { sessionId: "s1", seq: 43, data: "more" });

    expect(data).toEqual(["legacy replay", "raced", "live", "more"]);
    expect(client.requests.filter((request) => request.method === "terminal.attach")).toHaveLength(
      1,
    );
  });

  it("drops the listener when an attach fails so failures do not leak subscriptions", async () => {
    const client = makeFakeClient();
    const conn = new TerminalConnection(client);
    client.request = ((method: string, params: unknown) => {
      client.requests.push({ method, params });
      // Expired/unknown session after the detach grace period.
      return Promise.reject(new Error("unknown terminal session"));
    }) as typeof client.request;

    await expect(conn.attach("gone", { onData: () => {}, onExit: () => {} })).rejects.toThrow(
      "unknown terminal session",
    );
    expect(conn.size).toBe(0);
    expect(client.listenerCount()).toBe(0);
  });

  it("lists attachable sessions and tolerates a missing sessions field", async () => {
    const client = makeFakeClient();
    const conn = new TerminalConnection(client);
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

  it("forces reconnect when a terminal liveness probe gets no inbound response", async () => {
    vi.useFakeTimers();
    try {
      const client = makeFakeClient();
      client.request = ((
        method: string,
        params: unknown,
        options?: { timeoutMs?: number | null },
      ) => {
        client.requests.push({ method, params, ...(options ? { options } : {}) });
        if (method === "terminal.list") {
          return new Promise((_, reject) => {
            setTimeout(() => reject(new Error("request timed out")), options?.timeoutMs ?? 0);
          });
        }
        return Promise.resolve(client.nextResponse);
      }) as typeof client.request;
      const conn = new TerminalConnection(client);
      await conn.open({ cols: 80, rows: 24 }, { onData: () => {}, onExit: () => {} });

      await vi.advanceTimersByTimeAsync(TERMINAL_LIVENESS_IDLE_MS);
      expect(client.requests.at(-1)).toEqual({
        method: "terminal.list",
        params: undefined,
        options: { timeoutMs: TERMINAL_LIVENESS_PROBE_TIMEOUT_MS },
      });
      await vi.advanceTimersByTimeAsync(TERMINAL_LIVENESS_PROBE_TIMEOUT_MS);

      expect(client.forceReconnects).toEqual(["terminal liveness timeout"]);
      conn.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the socket when other inbound traffic arrives during a failed probe", async () => {
    vi.useFakeTimers();
    try {
      const client = makeFakeClient();
      client.request = ((
        method: string,
        params: unknown,
        options?: { timeoutMs?: number | null },
      ) => {
        client.requests.push({ method, params, ...(options ? { options } : {}) });
        if (method === "terminal.list") {
          return new Promise((_, reject) => {
            setTimeout(() => reject(new Error("request timed out")), options?.timeoutMs ?? 0);
          });
        }
        return Promise.resolve(client.nextResponse);
      }) as typeof client.request;
      const conn = new TerminalConnection(client);
      await conn.open({ cols: 80, rows: 24 }, { onData: () => {}, onExit: () => {} });

      await vi.advanceTimersByTimeAsync(TERMINAL_LIVENESS_IDLE_MS);
      client.emitActivity();
      await vi.advanceTimersByTimeAsync(TERMINAL_LIVENESS_PROBE_TIMEOUT_MS);

      expect(client.forceReconnects).toEqual([]);
      conn.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("dispose() drops the gateway subscription and clears buffered state", async () => {
    const client = makeFakeClient();
    const conn = new TerminalConnection(client);
    await conn.open({ cols: 80, rows: 24 }, { onData: () => {}, onExit: () => {} });
    expect(client.listenerCount()).toBe(1);
    // Panel teardown (disconnect/disable) discards the connection.
    conn.dispose();
    expect(client.listenerCount()).toBe(0);
    expect(conn.size).toBe(0);
  });
});
