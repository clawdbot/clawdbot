import { describe, expect, it } from "vitest";
import { MeetingSessionTranscriptStore } from "./session-transcript-store.js";
import type { MeetingSessionRecord, MeetingTranscriptSnapshot } from "./session-types.js";

function createSession(): MeetingSessionRecord<"chrome", "transcribe"> {
  return {
    id: "session-1",
    url: "https://meeting.example/room",
    transport: "chrome",
    mode: "transcribe",
    agentId: "main",
    state: "active",
    createdAt: "2026-07-17T00:00:00.000Z",
    updatedAt: "2026-07-17T00:00:00.000Z",
    participantIdentity: "OpenClaw",
    realtime: { enabled: false, toolPolicy: "none" },
    notes: [],
  };
}

function createStore(
  session: MeetingSessionRecord<"chrome", "transcribe">,
  snapshots: MeetingTranscriptSnapshot[],
  onLines?: (lines: MeetingTranscriptSnapshot["lines"]) => Promise<void>,
) {
  return new MeetingSessionTranscriptStore({
    getSession: (sessionId) => (sessionId === session.id ? session : undefined),
    isBrowserSession: () => true,
    isTranscribeSession: () => true,
    hasBrowserTab: () => true,
    capture: async () => snapshots.shift(),
    ...(onLines ? { onLines: async (_session, lines) => await onLines(lines) } : {}),
  });
}

describe("MeetingSessionTranscriptStore", () => {
  it("trims an oversized initial snapshot to the retained tail", async () => {
    const session = createSession();
    const store = createStore(session, [
      {
        droppedLines: 7,
        epoch: "page-1",
        lines: Array.from({ length: 2_005 }, (_, index) => ({ text: `line-${index}` })),
      },
    ]);

    const result = await store.read(session.id);

    expect(result).toMatchObject({
      found: true,
      startIndex: 12,
      nextIndex: 2_012,
      droppedLines: 12,
    });
    expect(result.lines).toHaveLength(2_000);
    expect(result.lines?.[0]?.text).toBe("line-5");
    expect(result.lines?.at(-1)?.text).toBe("line-2004");
  });

  it("drops a stale retained segment when the page cursor jumps past it", async () => {
    const session = createSession();
    const store = createStore(session, [
      {
        droppedLines: 0,
        epoch: "page-1",
        lines: [{ text: "old-0" }, { text: "old-1" }],
      },
      {
        droppedLines: 4,
        epoch: "page-1",
        lines: [{ text: "new-4" }, { text: "new-5" }],
      },
    ]);

    await store.read(session.id);
    const result = await store.read(session.id, { sinceIndex: 2 });

    expect(result).toMatchObject({ startIndex: 4, nextIndex: 6, droppedLines: 4 });
    expect(result.lines?.map((line) => line.text)).toEqual(["new-4", "new-5"]);
  });

  it("keeps only the new epoch tail when its first snapshot already has a gap", async () => {
    const session = createSession();
    const store = createStore(session, [
      {
        droppedLines: 0,
        epoch: "page-1",
        lines: [{ text: "old-0" }, { text: "old-1" }],
      },
      {
        droppedLines: 3,
        epoch: "page-2",
        lines: [{ text: "new-3" }, { text: "new-4" }],
      },
      {
        droppedLines: 3,
        epoch: "page-2",
        lines: [{ text: "new-3" }, { text: "new-4" }, { text: "new-5" }],
      },
    ]);

    await store.read(session.id);
    const afterReload = await store.read(session.id, { sinceIndex: 2 });
    const afterAppend = await store.read(session.id, { sinceIndex: 7 });

    expect(afterReload).toMatchObject({ startIndex: 5, nextIndex: 7, droppedLines: 5 });
    expect(afterReload.lines?.map((line) => line.text)).toEqual(["new-3", "new-4"]);
    expect(afterAppend).toMatchObject({ startIndex: 7, nextIndex: 8, droppedLines: 5 });
    expect(afterAppend.lines?.map((line) => line.text)).toEqual(["new-5"]);
  });

  it("retries durable delivery when a snapshot consumer fails", async () => {
    const session = createSession();
    const snapshot = {
      droppedLines: 0,
      epoch: "page-1",
      lines: [{ text: "retry me" }],
    };
    let attempts = 0;
    const delivered: string[][] = [];
    const store = createStore(session, [snapshot, snapshot], async (lines) => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("temporary store failure");
      }
      delivered.push(lines.map((line) => line.text));
    });

    await expect(store.read(session.id)).resolves.toMatchObject({ found: true });
    await expect(store.read(session.id)).resolves.toMatchObject({ found: true });

    expect(delivered).toEqual([["retry me"]]);
  });

  it("acknowledges a durable snapshot one line at a time", async () => {
    const session = createSession();
    const snapshot = {
      droppedLines: 0,
      epoch: "page-1",
      lines: [{ text: "first" }, { text: "second" }],
    };
    let failedSecond = false;
    const delivered: string[] = [];
    const store = createStore(session, [snapshot, snapshot], async (lines) => {
      const text = lines[0]?.text;
      if (text === "second" && !failedSecond) {
        failedSecond = true;
        throw new Error("temporary second-line failure");
      }
      if (text) {
        delivered.push(text);
      }
    });

    await expect(store.read(session.id)).resolves.toMatchObject({ found: true });
    await expect(store.read(session.id)).resolves.toMatchObject({ found: true });

    expect(delivered).toEqual(["first", "second"]);
  });

  it("treats a backward cursor without an epoch as a reset stream", async () => {
    const session = createSession();
    const delivered: string[] = [];
    const store = createStore(
      session,
      [
        { droppedLines: 0, lines: [{ text: "old-0" }, { text: "old-1" }] },
        { droppedLines: 0, lines: [{ text: "new-0" }] },
      ],
      async (lines) => {
        delivered.push(...lines.map((line) => line.text));
      },
    );

    await store.read(session.id);
    await store.read(session.id);

    expect(delivered).toEqual(["old-0", "old-1", "new-0"]);
  });

  it("detects a larger no-epoch reset after an empty snapshot", async () => {
    const session = createSession();
    const delivered: string[] = [];
    const store = createStore(
      session,
      [
        { droppedLines: 0, lines: [{ text: "old-0" }] },
        { droppedLines: 0, lines: [] },
        { droppedLines: 0, lines: [{ text: "new-0" }, { text: "new-1" }] },
      ],
      async (lines) => {
        delivered.push(...lines.map((line) => line.text));
      },
    );

    await store.read(session.id);
    await store.read(session.id);
    await store.read(session.id);

    expect(delivered).toEqual(["old-0", "new-0", "new-1"]);
  });

  it("strips the maximal suffix-prefix overlap from a no-epoch reset", async () => {
    const session = createSession();
    const delivered: string[] = [];
    const store = createStore(
      session,
      [
        { droppedLines: 0, lines: [{ text: "A" }, { text: "B" }] },
        { droppedLines: 0, lines: [{ text: "B" }, { text: "C" }] },
      ],
      async (lines) => {
        delivered.push(...lines.map((line) => line.text));
      },
    );

    await store.read(session.id);
    await store.read(session.id);

    expect(delivered).toEqual(["A", "B", "C"]);
  });

  it("keeps repeated text after a non-overlapping dropped prefix", async () => {
    const session = createSession();
    const delivered: string[] = [];
    const store = createStore(
      session,
      [
        { droppedLines: 0, lines: [{ text: "A" }, { text: "B" }] },
        { droppedLines: 2, lines: [{ text: "B" }, { text: "C" }] },
      ],
      async (lines) => {
        delivered.push(...lines.map((line) => line.text));
      },
    );

    await store.read(session.id);
    await store.read(session.id);

    expect(delivered).toEqual(["A", "B", "B", "C"]);
  });

  it("commits an empty no-epoch reset before repeated rows return", async () => {
    const session = createSession();
    const delivered: string[] = [];
    const store = createStore(
      session,
      [
        { droppedLines: 0, lines: [{ text: "A" }] },
        { droppedLines: 0, lines: [] },
        { droppedLines: 0, lines: [{ text: "A" }, { text: "B" }] },
      ],
      async (lines) => {
        delivered.push(...lines.map((line) => line.text));
      },
    );

    await store.read(session.id);
    await store.read(session.id);
    await store.read(session.id);

    expect(delivered).toEqual(["A", "A", "B"]);
  });

  it("queues newer final rows behind an unavailable pending batch", async () => {
    const session = createSession();
    let unavailable = true;
    const delivered: string[] = [];
    const store = createStore(
      session,
      [
        { droppedLines: 0, epoch: "page-1", lines: [{ text: "A" }] },
        { droppedLines: 0, epoch: "page-1", lines: [{ text: "A" }, { text: "B" }] },
      ],
      async (lines) => {
        if (unavailable) {
          throw new Error("store unavailable");
        }
        delivered.push(...lines.map((line) => line.text));
      },
    );

    await expect(store.captureNotes(session)).rejects.toThrow("store unavailable");
    await expect(store.captureNotes(session, { finalize: true })).rejects.toThrow(
      "store unavailable",
    );
    unavailable = false;
    await store.flushPending(session);

    expect(delivered).toEqual(["A", "B"]);
  });

  it("keeps polling snapshots while durable delivery is pending", async () => {
    const session = createSession();
    let unavailable = true;
    const delivered: string[] = [];
    const store = createStore(
      session,
      [
        { droppedLines: 0, epoch: "page-1", lines: [{ text: "A" }] },
        { droppedLines: 0, epoch: "page-1", lines: [{ text: "A" }, { text: "B" }] },
      ],
      async (lines) => {
        if (unavailable) {
          throw new Error("store unavailable");
        }
        delivered.push(...lines.map((line) => line.text));
      },
    );

    await expect(store.captureNotes(session)).rejects.toThrow("store unavailable");
    await expect(store.captureNotes(session)).rejects.toThrow("store unavailable");
    unavailable = false;
    await store.flushPending(session);

    expect(delivered).toEqual(["A", "B"]);
  });

  it("preserves pending delivery when the final browser snapshot also fails", async () => {
    const session = createSession();
    let captureCount = 0;
    const store = new MeetingSessionTranscriptStore({
      getSession: () => session,
      isBrowserSession: () => true,
      isTranscribeSession: () => true,
      hasBrowserTab: () => true,
      capture: async () => {
        captureCount += 1;
        if (captureCount === 1) {
          return { droppedLines: 0, lines: [{ text: "pending" }] };
        }
        throw new Error("browser snapshot unavailable");
      },
      onLines: async () => {
        throw new Error("store unavailable");
      },
    });

    await expect(store.captureNotes(session)).rejects.toThrow("store unavailable");
    await expect(store.captureNotes(session, { finalize: true })).rejects.toMatchObject({
      finalCaptureError: "browser snapshot unavailable",
    });
  });

  it("queues an empty reset marker while delivery is pending", async () => {
    const session = createSession();
    let unavailable = true;
    const delivered: string[] = [];
    const store = createStore(
      session,
      [
        { droppedLines: 0, lines: [{ text: "A" }] },
        { droppedLines: 0, lines: [] },
        { droppedLines: 0, lines: [{ text: "A" }, { text: "B" }] },
      ],
      async (lines) => {
        if (unavailable) {
          throw new Error("store unavailable");
        }
        delivered.push(...lines.map((line) => line.text));
      },
    );

    await expect(store.captureNotes(session)).rejects.toThrow("store unavailable");
    await expect(store.captureNotes(session)).rejects.toThrow("store unavailable");
    await expect(store.captureNotes(session)).rejects.toThrow("store unavailable");
    unavailable = false;
    await store.flushPending(session);

    expect(delivered).toEqual(["A", "A", "B"]);
  });
});
