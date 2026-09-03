import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  loadTranscriptEventsSync,
  replaceTranscriptEventsSync,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import {
  runWithSessionTranscriptReadFence,
  SessionTranscriptReadFenceError,
} from "../config/sessions/session-transcript-read-fence.js";
import {
  appendSessionTranscriptMessageByIdentity,
  readLatestAssistantTextByIdentity,
  readSessionTranscriptEvents,
  readSessionTranscriptRawDelta,
  readVisibleSessionTranscriptMessageEntries,
} from "./session-transcript-runtime.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("session transcript runtime read fence", () => {
  let storePath: string;

  beforeEach(() => {
    storePath = path.join(tempDirs.make("openclaw-sdk-transcript-fence-"), "sessions.json");
  });

  it("fences full and raw reads before the exact admitted row and resumes from its cursor", async () => {
    const scope = {
      agentId: "main",
      sessionId: "fenced-raw-session",
      sessionKey: "agent:main:fenced-raw",
      storePath,
    };
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 10 });
    const priorUser = await appendSessionTranscriptMessageByIdentity({
      ...scope,
      message: { role: "user", content: "same prompt" },
      now: 1_000,
    });
    const priorAssistant = await appendSessionTranscriptMessageByIdentity({
      ...scope,
      message: { role: "assistant", content: "prior answer" },
      parentId: priorUser?.messageId,
      now: 2_000,
    });
    const admitted = await appendSessionTranscriptMessageByIdentity({
      ...scope,
      message: { role: "user", content: "same prompt" },
      parentId: priorAssistant?.messageId,
      now: 3_000,
    });
    await appendSessionTranscriptMessageByIdentity({
      ...scope,
      message: { role: "assistant", content: "current answer" },
      parentId: admitted?.messageId,
      now: 4_000,
    });
    if (!priorUser || !priorAssistant || !admitted) {
      throw new Error("expected fenced transcript setup messages");
    }
    if (!admitted.anchor) {
      throw new Error("expected admitted transcript anchor");
    }
    const receipt = {
      ...admitted.anchor,
      logicalTurnId: "fenced-raw-session",
      role: "user" as const,
    };

    const fenced = await runWithSessionTranscriptReadFence(receipt, async () => {
      const syncEvents = loadTranscriptEventsSync(scope);
      const events = await readSessionTranscriptEvents(scope);
      const visible = await readVisibleSessionTranscriptMessageEntries(scope);
      const latest = await readLatestAssistantTextByIdentity(scope);
      const page = await readSessionTranscriptRawDelta({
        ...scope,
        maxBytes: 100_000,
        maxEvents: 100,
      });
      return { events, latest, page, syncEvents, visible };
    });

    expect(fenced.syncEvents).toEqual(fenced.events);
    expect(
      fenced.events.flatMap((event) =>
        event &&
        typeof event === "object" &&
        "type" in event &&
        event.type === "message" &&
        "id" in event
          ? [event.id]
          : [],
      ),
    ).toEqual([priorUser.messageId, priorAssistant.messageId]);
    expect(fenced.visible.map((entry) => entry.entryId)).toEqual([
      priorUser.messageId,
      priorAssistant.messageId,
    ]);
    expect(fenced.latest).toMatchObject({ id: priorAssistant.messageId, text: "prior answer" });
    expect(fenced.page).toMatchObject({ kind: "page", hasMore: false });
    if (fenced.page.kind !== "page") {
      throw new Error("expected fenced raw transcript page");
    }

    await expect(
      readSessionTranscriptRawDelta({
        ...scope,
        cursor: fenced.page.cursor,
        maxBytes: 100_000,
        maxEvents: 100,
      }),
    ).resolves.toMatchObject({
      kind: "page",
      events: [
        { event: { id: admitted.messageId, message: { content: "same prompt" } } },
        { event: { message: { content: "current answer" } } },
      ],
      hasMore: false,
    });
  });

  it("rejects a read fence when any immutable admission field changes", async () => {
    const scope = {
      agentId: "main",
      sessionId: "fenced-anchor-session",
      sessionKey: "agent:main:fenced-anchor",
      storePath,
    };
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 10 });
    const admitted = await appendSessionTranscriptMessageByIdentity({
      ...scope,
      message: { role: "user", content: "exact admission" },
      now: 1_000,
    });
    if (!admitted?.anchor) {
      throw new Error("expected admitted transcript anchor");
    }
    const receipt = {
      ...admitted.anchor,
      logicalTurnId: "fenced-anchor-turn",
      role: "user" as const,
    };
    const invalidReceipts = [
      { ...receipt, storePath: `${receipt.storePath}.other` },
      { ...receipt, sessionKey: `${receipt.sessionKey}:other` },
      { ...receipt, generation: `${receipt.generation}:other` },
      { ...receipt, rawSeq: receipt.rawSeq + 1 },
      { ...receipt, effectiveParentId: "other-parent" },
      { ...receipt, activeMessagePosition: receipt.activeMessagePosition + 1 },
      { ...receipt, role: "assistant" as const },
    ];

    for (const invalidReceipt of invalidReceipts) {
      expect(() =>
        runWithSessionTranscriptReadFence(invalidReceipt as unknown as typeof receipt, () =>
          loadTranscriptEventsSync(scope),
        ),
      ).toThrow(SessionTranscriptReadFenceError);
      await expect(
        runWithSessionTranscriptReadFence(
          invalidReceipt as unknown as typeof receipt,
          async () => await readSessionTranscriptEvents(scope),
        ),
      ).rejects.toBeInstanceOf(SessionTranscriptReadFenceError);
    }

    const events = loadTranscriptEventsSync(scope);
    expect(replaceTranscriptEventsSync(scope, events)).toBe(true);
    expect(() =>
      runWithSessionTranscriptReadFence(receipt, () => loadTranscriptEventsSync(scope)),
    ).toThrow(SessionTranscriptReadFenceError);
    expect(loadTranscriptEventsSync(scope)).toEqual(events);
  });
});
