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
) {
  return new MeetingSessionTranscriptStore({
    getSession: (sessionId) => (sessionId === session.id ? session : undefined),
    isBrowserSession: () => true,
    isTranscribeSession: () => true,
    hasBrowserTab: () => true,
    capture: async () => snapshots.shift(),
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
});
