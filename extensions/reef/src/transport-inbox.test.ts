import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReefInboxConnection, ReefInboxEntryParkedError, type WebSocketLike } from "./transport.js";
import {
  ControlledSocket,
  createClient,
  parseRequestUrl,
  receiptEntry,
} from "./transport.test-helpers.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("ReefInboxConnection recovery", () => {
  it("starts REST catch-up at the durable cursor and advances only processed entries", async () => {
    const requestedAfter: number[] = [];
    const persisted: number[] = [];
    const processed: number[] = [];
    const client = createClient(async (input) => {
      const after = Number(parseRequestUrl(input).searchParams.get("after"));
      requestedAfter.push(after);
      return after === 7
        ? Response.json({ entries: [receiptEntry(8)], cursor: 8 })
        : Response.json({ entries: [], cursor: after });
    });
    const inbox = new ReefInboxConnection(
      client,
      async (entries) => {
        processed.push(...entries.map((entry) => entry.seq));
      },
      () => {
        throw new Error("socket should not open during direct drain");
      },
      { initialCursor: 7, persistCursor: (cursor) => persisted.push(cursor) },
    );

    await inbox.drain();

    expect(requestedAfter).toEqual([7, 8]);
    expect(processed).toEqual([8]);
    expect(persisted).toEqual([8]);
  });

  it("does not advance past an entry that failed processing", async () => {
    const persisted: number[] = [];
    const client = createClient(async () =>
      Response.json({ entries: [receiptEntry(8), receiptEntry(9)], cursor: 9 }),
    );
    const inbox = new ReefInboxConnection(
      client,
      async ([entry]) => {
        if (entry?.seq === 9) {
          throw new Error("entry failed");
        }
      },
      () => {
        throw new Error("socket should not open during direct drain");
      },
      { initialCursor: 7, persistCursor: (cursor) => persisted.push(cursor) },
    );

    await expect(inbox.drain()).rejects.toThrow("entry failed");
    expect(persisted).toEqual([8]);
  });

  it("parks an entry without advancing the cursor and completes later entries", async () => {
    const persisted: number[] = [];
    const attempts: number[] = [];
    let parked = true;
    const client = createClient(async (input) => {
      const after = Number(parseRequestUrl(input).searchParams.get("after"));
      return after === 7
        ? Response.json({
            entries: [receiptEntry(8), receiptEntry(9), receiptEntry(10)],
            cursor: 10,
          })
        : Response.json({ entries: [], cursor: after });
    });
    const inbox = new ReefInboxConnection(
      client,
      async ([entry]) => {
        attempts.push(entry!.seq);
        if (entry!.seq === 8 && parked) {
          throw new ReefInboxEntryParkedError("review approval pending");
        }
      },
      () => {
        throw new Error("socket should not open during direct drain");
      },
      { initialCursor: 7, persistCursor: (cursor) => persisted.push(cursor) },
    );

    // First drain: entry 8 parks, 9 and 10 still complete, durable cursor holds.
    await inbox.drain();
    expect(attempts).toEqual([8, 9, 10]);
    expect(persisted).toEqual([]);

    // Re-poll while parked: only the parked entry is re-attempted.
    await inbox.poll();
    expect(attempts).toEqual([8, 9, 10, 8]);
    expect(persisted).toEqual([]);

    // Owner decision resolves the park; the cursor folds through the entries
    // that already completed above it.
    parked = false;
    await inbox.poll();
    expect(attempts).toEqual([8, 9, 10, 8, 8]);
    expect(persisted).toEqual([8, 9, 10]);
  });

  it("retries a parked live entry after a later separate frame completes", async () => {
    vi.useFakeTimers();
    const socket = new ControlledSocket();
    const retainedEntries: ReturnType<typeof receiptEntry>[] = [];
    const requestedAfter: number[] = [];
    const persisted: number[] = [];
    const attempts: number[] = [];
    const completed: number[] = [];
    let parked = true;
    const client = createClient(async (input) => {
      const after = Number(parseRequestUrl(input).searchParams.get("after"));
      requestedAfter.push(after);
      const entries = retainedEntries.filter((entry) => entry.seq > after);
      return Response.json({ entries, cursor: entries.at(-1)?.seq ?? after });
    });
    const abort = new AbortController();
    const inbox = new ReefInboxConnection(
      client,
      async ([entry]) => {
        attempts.push(entry!.seq);
        if (entry!.seq === 8 && parked) {
          throw new ReefInboxEntryParkedError("review approval pending");
        }
        completed.push(entry!.seq);
      },
      () => socket as unknown as WebSocketLike,
      { initialCursor: 7, persistCursor: (cursor) => persisted.push(cursor) },
    );

    const running = inbox.start(abort.signal);
    try {
      socket.emit("open");
      await vi.advanceTimersByTimeAsync(0);
      expect(requestedAfter).toEqual([7]);
      expect(attempts).toEqual([]);

      // The relay retains each entry before pushing its live notification.
      retainedEntries.push(receiptEntry(8));
      socket.emit("message", {
        data: JSON.stringify({ type: "entry", entry: retainedEntries[0] }),
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(attempts).toEqual([8]);
      expect(persisted).toEqual([]);

      retainedEntries.push(receiptEntry(9));
      socket.emit("message", {
        data: JSON.stringify({ type: "entry", entry: retainedEntries[1] }),
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(completed).toEqual([9]);
      expect(socket.closed).toBe(false);
      // Continue through recovery even if the earlier frame's cursor barrier was lost.
      expect.soft(persisted).toEqual([]);

      parked = false;
      const recoveryPullIndex = requestedAfter.length;
      const recoveryAttemptIndex = attempts.length;
      await inbox.poll(abort.signal);
      expect.soft(requestedAfter[recoveryPullIndex]).toBe(7);
      expect.soft(attempts.slice(recoveryAttemptIndex)).toEqual([8]);
      expect.soft(completed).toEqual([9, 8]);
      expect(persisted.at(-1)).toBe(9);
    } finally {
      abort.abort();
      await running;
      vi.useRealTimers();
    }
  });

  it("keeps the live socket up while an entry stays parked", async () => {
    const socket = new ControlledSocket();
    const errors: string[] = [];
    const client = createClient(async () =>
      Response.json({ entries: [receiptEntry(8)], cursor: 8 }),
    );
    const abort = new AbortController();
    const inbox = new ReefInboxConnection(
      client,
      async () => {
        throw new ReefInboxEntryParkedError("review approval pending");
      },
      () => socket as unknown as WebSocketLike,
      { initialCursor: 7, onError: (error) => errors.push(error.message) },
    );
    const running = inbox.start(abort.signal);
    socket.emit("open");
    await vi.waitFor(() => expect(socket.closed).toBe(false));
    // Give catch-up a macrotask to finish; a parked entry is a waiting state,
    // not a connection failure, so nothing may close or report.
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
    expect(errors).toEqual([]);
    expect(socket.closed).toBe(false);
    abort.abort();
    socket.emit("close");
    await running;
  });

  it("sends keepalive pings, absorbs pongs, and reconnects on a dead link", async () => {
    vi.useFakeTimers();
    const sockets: ControlledSocket[] = [];
    const client = createClient(async () => Response.json({ entries: [], cursor: 0 }));
    const abort = new AbortController();
    const inbox = new ReefInboxConnection(
      client,
      async () => {},
      () => {
        const socket = new ControlledSocket();
        sockets.push(socket);
        return socket as unknown as WebSocketLike;
      },
      {},
    );
    const running = inbox.start(abort.signal);
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    sockets[0]!.emit("open");
    await vi.advanceTimersByTimeAsync(45_000);
    expect(sockets[0]!.sent).toEqual(["ping"]);
    // A pong keeps the link alive through the next interval.
    sockets[0]!.emit("message", { data: "pong" });
    await vi.advanceTimersByTimeAsync(45_000);
    expect(sockets[0]!.sent).toEqual(["ping", "ping"]);
    expect(sockets[0]!.closed).toBe(false);
    // No pong before the next interval: the link is dead, reconnect.
    await vi.advanceTimersByTimeAsync(45_000);
    expect(sockets[0]!.closed).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sockets).toHaveLength(2);
    abort.abort();
    for (const socket of sockets) {
      socket.emit("close");
    }
    await vi.runOnlyPendingTimersAsync();
    await running;
  });

  it("rejects an inconsistent REST page before dispatch or persistence", async () => {
    const processed: number[] = [];
    const persisted: number[] = [];
    const client = createClient(async () =>
      Response.json({ entries: [receiptEntry(9)], cursor: 8 }),
    );
    const inbox = new ReefInboxConnection(
      client,
      async (entries) => {
        processed.push(...entries.map((entry) => entry.seq));
      },
      () => new ControlledSocket() as unknown as WebSocketLike,
      { initialCursor: 7, persistCursor: (cursor) => persisted.push(cursor) },
    );

    await expect(inbox.drain()).rejects.toThrow(
      "Reef relay inbox cursor does not match its entries",
    );
    expect(processed).toEqual([]);
    expect(persisted).toEqual([]);
  });

  it("persists cursor-only progress when retained entries have expired", async () => {
    const requestedAfter: number[] = [];
    const persisted: number[] = [];
    const client = createClient(async (input) => {
      requestedAfter.push(Number(parseRequestUrl(input).searchParams.get("after")));
      return Response.json({ entries: [], cursor: 12 });
    });
    const inbox = new ReefInboxConnection(
      client,
      async () => {},
      () => new ControlledSocket() as unknown as WebSocketLike,
      {
        initialCursor: 7,
        persistCursor: (cursor) => persisted.push(cursor),
      },
    );

    await inbox.drain();

    expect(requestedAfter).toEqual([7]);
    expect(persisted).toEqual([12]);
  });

  it("reports connected before a slow REST catch-up completes", async () => {
    const socket = new ControlledSocket();
    const states: string[] = [];
    const pullGate = createDeferred<void>();
    const pullStarted = createDeferred<void>();
    const client = createClient(async () => {
      pullStarted.resolve();
      await pullGate.promise;
      return Response.json({ entries: [], cursor: 0 });
    });
    const abort = new AbortController();
    const inbox = new ReefInboxConnection(
      client,
      async () => {},
      () => socket as unknown as WebSocketLike,
      { onState: (state) => states.push(state) },
    );

    const running = inbox.start(abort.signal);
    try {
      socket.emit("open");
      await vi.waitFor(() => pullStarted.promise);
      expect(states).toEqual(["connected"]);
    } finally {
      pullGate.resolve();
      abort.abort();
      await running;
    }
    expect(states).toEqual(["connected", "disconnected"]);
  });

  it("serializes socket frames behind catch-up and skips pull/socket duplicates", async () => {
    const socket = new ControlledSocket();
    const processed: number[] = [];
    const persisted: number[] = [];
    const firstPullGate = createDeferred<void>();
    const client = createClient(async (input) => {
      const after = Number(parseRequestUrl(input).searchParams.get("after"));
      if (after === 0) {
        await firstPullGate.promise;
        return Response.json({ entries: [receiptEntry(1), receiptEntry(2)], cursor: 2 });
      }
      return Response.json({ entries: [], cursor: after });
    });
    const abort = new AbortController();
    const inbox = new ReefInboxConnection(
      client,
      async (entries) => {
        processed.push(...entries.map((entry) => entry.seq));
      },
      () => socket as unknown as WebSocketLike,
      { persistCursor: (cursor) => persisted.push(cursor) },
    );

    const running = inbox.start(abort.signal);
    try {
      socket.emit("open");
      socket.emit("message", { data: JSON.stringify({ type: "entry", entry: receiptEntry(2) }) });
      socket.emit("message", { data: JSON.stringify({ type: "entry", entry: receiptEntry(3) }) });
      firstPullGate.resolve();
      await vi.waitFor(() => expect(processed).toEqual([1, 2, 3]));

      expect(persisted).toEqual([1, 2, 3]);
    } finally {
      firstPullGate.resolve();
      abort.abort();
      await running;
    }
  });

  it("reports a socket close immediately while catch-up is still pending", async () => {
    const socket = new ControlledSocket();
    const states: string[] = [];
    const pullGate = createDeferred<void>();
    const pullStarted = createDeferred<void>();
    const client = createClient(async () => {
      pullStarted.resolve();
      await pullGate.promise;
      return Response.json({ entries: [], cursor: 0 });
    });
    const abort = new AbortController();
    const inbox = new ReefInboxConnection(
      client,
      async () => {},
      () => socket as unknown as WebSocketLike,
      { onState: (state) => states.push(state) },
    );

    const running = inbox.start(abort.signal);
    try {
      socket.emit("open");
      await vi.waitFor(() => pullStarted.promise);
      socket.emit("close");
      await vi.waitFor(() => expect(states).toEqual(["connected", "disconnected"]));
    } finally {
      abort.abort();
      pullGate.resolve();
      await running;
    }
  });

  it("reports unexpected socket close details before retrying", async () => {
    const socket = new ControlledSocket();
    const states: string[] = [];
    const errors: string[] = [];
    let socketUrl = "";
    const client = createClient(async () => Response.json({ entries: [], cursor: 0 }));
    const abort = new AbortController();
    const inbox = new ReefInboxConnection(
      client,
      async () => {},
      (url) => {
        socketUrl = url;
        return socket as unknown as WebSocketLike;
      },
      {
        onState: (state) => states.push(state),
        onError: (error) => {
          errors.push(error.message);
          abort.abort();
        },
      },
    );

    const running = inbox.start(abort.signal);
    socket.emit("open");
    const signature = new URL(socketUrl).searchParams.get("sig");
    if (!signature) {
      throw new Error("Reef WebSocket test URL did not contain a signature");
    }
    socket.emit("close", { code: 1008, reason: `policy ${signature}` });
    await running;

    expect(states).toEqual(["connected", "disconnected"]);
    expect(errors).toEqual([
      "reef inbox socket closed unexpectedly code=1008 reason=policy <redacted>",
    ]);
  });

  it("resets reconnect backoff after a socket completes catch-up", async () => {
    vi.useFakeTimers();
    const sockets: ControlledSocket[] = [];
    const persisted: number[] = [];
    const client = createClient(async () => Response.json({ entries: [], cursor: 1 }));
    const abort = new AbortController();
    const inbox = new ReefInboxConnection(
      client,
      async () => {},
      () => {
        const socket = new ControlledSocket();
        sockets.push(socket);
        return socket as unknown as WebSocketLike;
      },
      { persistCursor: (cursor) => persisted.push(cursor) },
    );

    const running = inbox.start(abort.signal);
    sockets[0]!.emit("close");
    await vi.advanceTimersByTimeAsync(250);
    expect(sockets).toHaveLength(2);

    sockets[1]!.emit("open");
    await vi.waitFor(() => expect(persisted).toEqual([1]));
    await Promise.resolve();
    sockets[1]!.emit("close");

    await vi.advanceTimersByTimeAsync(249);
    expect(sockets).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(sockets).toHaveLength(3);

    abort.abort();
    await running;
  });

  it("waits for an in-flight handler before completing channel abort", async () => {
    const socket = new ControlledSocket();
    const persisted: number[] = [];
    const handlerGate = createDeferred<void>();
    const handlerStarted = createDeferred<void>();
    const client = createClient(async () =>
      Response.json({ entries: [receiptEntry(1)], cursor: 1 }),
    );
    const abort = new AbortController();
    const inbox = new ReefInboxConnection(
      client,
      async () => {
        handlerStarted.resolve();
        await handlerGate.promise;
      },
      () => socket as unknown as WebSocketLike,
      { persistCursor: (cursor) => persisted.push(cursor) },
    );

    let finished = false;
    const running = inbox.start(abort.signal).then(() => {
      finished = true;
    });
    try {
      socket.emit("open");
      await vi.waitFor(() => handlerStarted.promise);
      abort.abort();
      await Promise.resolve();
      expect(finished).toBe(false);
    } finally {
      handlerGate.resolve();
      abort.abort();
      await running;
    }
    expect(persisted).toEqual([1]);
  });

  it("bounds live frames during catch-up and reconnects through REST on overflow", async () => {
    const socket = new ControlledSocket();
    const errors: string[] = [];
    const pullGate = createDeferred<void>();
    const pullStarted = createDeferred<void>();
    const client = createClient(async () => {
      pullStarted.resolve();
      await pullGate.promise;
      return Response.json({ entries: [], cursor: 0 });
    });
    const abort = new AbortController();
    const inbox = new ReefInboxConnection(
      client,
      async () => {},
      () => socket as unknown as WebSocketLike,
      {
        onError: (error) => {
          errors.push(error.message);
          abort.abort();
        },
      },
    );

    const running = inbox.start(abort.signal);
    try {
      socket.emit("open");
      await vi.waitFor(() => pullStarted.promise);
      for (let seq = 1; seq <= 257; seq += 1) {
        socket.emit("message", {
          data: JSON.stringify({ type: "entry", entry: receiptEntry(seq) }),
        });
      }
      pullGate.resolve();
      await running;

      expect(errors).toEqual(["Reef inbox live buffer overflow; reconnecting for REST recovery"]);
    } finally {
      pullGate.resolve();
      abort.abort();
      await running;
    }
  });

  it("surfaces catch-up failures to channel diagnostics", async () => {
    const socket = new ControlledSocket();
    const states: string[] = [];
    const errors: string[] = [];
    const abort = new AbortController();
    const client = createClient(async () => {
      throw new Error("relay catch-up failed");
    });
    const inbox = new ReefInboxConnection(
      client,
      async () => {},
      () => socket as unknown as WebSocketLike,
      {
        onState: (state) => states.push(state),
        onError: (error) => {
          errors.push(error.message);
          abort.abort();
        },
      },
    );

    const running = inbox.start(abort.signal);
    socket.emit("open");
    await running;

    expect(states).toEqual(["connected", "disconnected"]);
    expect(errors).toEqual(["relay catch-up failed"]);
  });
});
