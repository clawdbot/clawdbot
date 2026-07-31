import { Buffer } from "node:buffer";
import type { SessionTranscriptMessageEntry } from "openclaw/plugin-sdk/session-transcript-runtime";
import { describe, expect, it, vi } from "vitest";
import type { CodexThreadItem, CodexTurn } from "./protocol.js";
import { resolveCodexUpstreamForkBoundary } from "./upstream-fork-boundary.js";
import { attachImportedHistoryProvenance } from "./upstream-prompt-provenance.js";

const transcriptMocks = vi.hoisted(() => ({
  readVisibleEntries: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/session-transcript-runtime", () => ({
  readVisibleSessionTranscriptMessageEntries: transcriptMocks.readVisibleEntries,
}));

function item(type: string, overrides: Record<string, unknown> = {}): CodexThreadItem {
  return { id: `${type}-item`, type, ...overrides } as CodexThreadItem;
}

function user(text: string): CodexThreadItem {
  return item("userMessage", { content: [{ type: "text", text, textElements: [] }] });
}

function turn(id: string, items: CodexThreadItem[], overrides: Partial<CodexTurn> = {}): CodexTurn {
  return { id, status: "completed", items, ...overrides };
}

async function resolveFromTurns(params: {
  turns: readonly CodexTurn[];
  userMessageOrdinal: number;
  localPrefixTexts: readonly (string | undefined)[];
  /** Which prefix rows came from bounded history import. Defaults to all of them, since
   * most cases here model an adopted thread; pass false to model a live local row. */
  localPrefixImported?: readonly boolean[];
}) {
  const entries: SessionTranscriptMessageEntry[] = params.localPrefixTexts.map((text, index) => {
    const message = {
      role: "user" as const,
      content: text ?? [{ type: "image", data: "", mimeType: "image/png" }],
      timestamp: index,
    };
    return {
      entryId: `entry-${index}`,
      parentId: index > 0 ? `entry-${index - 1}` : null,
      seq: index,
      role: "user",
      // Mark through the real producer so this cannot drift from what import writes.
      message:
        (params.localPrefixImported?.[index] ?? true)
          ? attachImportedHistoryProvenance(message as never)
          : message,
    } as SessionTranscriptMessageEntry;
  });
  transcriptMocks.readVisibleEntries.mockResolvedValue(entries);
  const result = await resolveCodexUpstreamForkBoundary({
    agentId: "main",
    sessionId: "session-1",
    sessionKey: "agent:main:upstream",
    storePath: "/tmp/does-not-matter",
    entryId: `entry-${params.userMessageOrdinal}`,
    threadId: "thread-1",
    control: {
      readThread: vi.fn(async () => ({ id: "thread-1" })),
      listTurnPage: vi.fn(async () => ({ data: [...params.turns] })),
    } as unknown as Parameters<typeof resolveCodexUpstreamForkBoundary>[0]["control"],
  });
  return result.ok ? { ok: true as const, boundary: result.boundary } : result;
}

describe("resolveCodexUpstreamForkBoundaryFromTurns", () => {
  it("maps the local user ordinal to the upstream turn", async () => {
    const result = await resolveFromTurns({
      turns: [turn("turn-1", [user("one")]), turn("turn-2", [user("two")])],
      userMessageOrdinal: 1,
      localPrefixTexts: ["one", "two"],
    });

    expect(result).toEqual({
      ok: true,
      boundary: {
        beforeTurnId: "turn-2",
        targetTurnId: "turn-2",
        retainedMarker: { turnId: "turn-1", userMessageCount: 1 },
      },
    });
  });

  it("cuts before the first turn with an empty retained baseline", async () => {
    const result = await resolveFromTurns({
      turns: [turn("turn-1", [user("one")])],
      userMessageOrdinal: 0,
      localPrefixTexts: ["one"],
    });
    expect(result).toEqual({
      ok: true,
      boundary: {
        beforeTurnId: "turn-1",
        targetTurnId: "turn-1",
        retainedMarker: { turnId: null, userMessageCount: 0 },
      },
    });
  });

  it("rejects a selected steer message", async () => {
    const result = await resolveFromTurns({
      turns: [turn("turn-1", [user("one"), user("steer")])],
      userMessageOrdinal: 1,
      localPrefixTexts: ["one", "steer"],
    });

    expect(result).toMatchObject({ ok: false, code: "steer-message" });
  });

  it("skips prompts inside review spans", async () => {
    const result = await resolveFromTurns({
      turns: [
        turn("turn-review", [
          item("enteredReviewMode"),
          user("hidden review prompt"),
          item("exitedReviewMode"),
        ]),
        turn("turn-2", [user("visible")]),
      ],
      userMessageOrdinal: 0,
      localPrefixTexts: ["visible"],
    });

    expect(result).toEqual({
      ok: true,
      boundary: {
        beforeTurnId: "turn-2",
        targetTurnId: "turn-2",
        retainedMarker: { turnId: "turn-review", userMessageCount: 1 },
      },
    });
  });

  it("rejects an in-progress target turn", async () => {
    const result = await resolveFromTurns({
      turns: [turn("turn-1", [user("one")], { status: "inProgress" })],
      userMessageOrdinal: 0,
      localPrefixTexts: ["one"],
    });

    expect(result).toMatchObject({ ok: false, code: "in-progress-turn" });
  });

  it("rejects local and upstream text drift", async () => {
    const result = await resolveFromTurns({
      turns: [turn("turn-1", [user("persisted")])],
      userMessageOrdinal: 0,
      localPrefixTexts: ["local mirror"],
    });

    expect(result).toMatchObject({ ok: false, code: "drift-mismatch" });
  });

  it("forks when history import trimmed the stored copy of the upstream prompt", async () => {
    const result = await resolveFromTurns({
      turns: [turn("turn-1", [user(" \n  prompt  \n ")])],
      userMessageOrdinal: 0,
      localPrefixTexts: ["prompt"],
    });

    expect(result).toEqual({
      ok: true,
      boundary: {
        beforeTurnId: "turn-1",
        targetTurnId: "turn-1",
        retainedMarker: { turnId: null, userMessageCount: 0 },
      },
    });
  });

  it("keeps forking past a trimmed prefix message", async () => {
    const result = await resolveFromTurns({
      turns: [turn("turn-1", [user("  one  ")]), turn("turn-2", [user("two")])],
      userMessageOrdinal: 1,
      localPrefixTexts: ["one", "two"],
    });

    expect(result).toEqual({
      ok: true,
      boundary: {
        beforeTurnId: "turn-2",
        targetTurnId: "turn-2",
        retainedMarker: { turnId: "turn-1", userMessageCount: 1 },
      },
    });
  });

  it("forks when history import truncated an oversized upstream prompt", async () => {
    const oversized = "x".repeat(64 * 1024 + 10);
    const suffix = "\n\n[Message truncated during Codex history import.]";
    const stored = `${oversized.slice(0, 64 * 1024 - Buffer.byteLength(suffix, "utf8"))}${suffix}`;

    const result = await resolveFromTurns({
      turns: [turn("turn-1", [user(oversized)])],
      userMessageOrdinal: 0,
      localPrefixTexts: [stored],
    });

    expect(result).toEqual({
      ok: true,
      boundary: {
        beforeTurnId: "turn-1",
        targetTurnId: "turn-1",
        retainedMarker: { turnId: null, userMessageCount: 0 },
      },
    });
  });

  // Documented widening, pinned deliberately: past the retained prefix the local mirror
  // holds nothing to compare against, so a changed tail on an oversized message is
  // accepted. main rejected it, but only by rejecting every oversized message.
  it("accepts an oversized message whose discarded tail differs", async () => {
    const suffix = "\n\n[Message truncated during Codex history import.]";
    const retained = "x".repeat(64 * 1024 - Buffer.byteLength(suffix, "utf8"));
    const importedFromAnEarlierTail = `${retained}${suffix}`;

    const result = await resolveFromTurns({
      // The tail must exceed the suffix length, or the total stays under the cap and
      // nothing is truncated.
      turns: [turn("turn-1", [user(`${retained}${"a tail that differs. ".repeat(20)}`)])],
      userMessageOrdinal: 0,
      localPrefixTexts: [importedFromAnEarlierTail],
    });

    expect(result).toEqual({
      ok: true,
      boundary: {
        beforeTurnId: "turn-1",
        targetTurnId: "turn-1",
        retainedMarker: { turnId: null, userMessageCount: 0 },
      },
    });
  });

  it("keeps exact matching for a live row that history import did not write", async () => {
    const result = await resolveFromTurns({
      turns: [turn("turn-1", [user("  deploy  ")])],
      userMessageOrdinal: 0,
      localPrefixTexts: ["deploy"],
      localPrefixImported: [false],
    });

    expect(result).toMatchObject({ ok: false, code: "drift-mismatch" });
  });

  it("still rejects drift that trimming cannot explain", async () => {
    const result = await resolveFromTurns({
      turns: [turn("turn-1", [user("  upstream  ")])],
      userMessageOrdinal: 0,
      localPrefixTexts: ["local"],
    });

    expect(result).toMatchObject({ ok: false, code: "drift-mismatch" });
  });

  it("rejects equal targets over divergent prefixes", async () => {
    const result = await resolveFromTurns({
      turns: [turn("turn-1", [user("upstream-old")]), turn("turn-2", [user("target")])],
      userMessageOrdinal: 1,
      localPrefixTexts: ["local-old", "target"],
    });

    expect(result).toMatchObject({ ok: false, code: "drift-mismatch" });
  });

  it("rejects upstream messages carrying semantic non-text inputs", async () => {
    const result = await resolveFromTurns({
      turns: [
        turn("turn-1", [
          item("userMessage", {
            content: [
              { type: "text", text: "one", textElements: [] },
              { type: "skill", name: "reviewer" },
            ],
          }),
        ]),
        turn("turn-2", [user("target")]),
      ],
      userMessageOrdinal: 1,
      localPrefixTexts: ["one", "target"],
    });

    expect(result).toMatchObject({ ok: false, code: "drift-mismatch" });
  });

  it("rejects prefixes whose content identity cannot be verified", async () => {
    const result = await resolveFromTurns({
      turns: [turn("turn-1", [user("one")]), turn("turn-2", [user("target")])],
      userMessageOrdinal: 1,
      localPrefixTexts: [undefined, "target"],
    });

    expect(result).toMatchObject({ ok: false, code: "drift-mismatch" });
  });
});

describe("resolveCodexUpstreamForkBoundary", () => {
  it("rejects paginated-history threads before reading turns", async () => {
    const readThread = vi.fn(async () => ({ id: "thread-1", historyMode: "paginated" }));
    const result = await resolveCodexUpstreamForkBoundary({
      agentId: "main",
      sessionId: "session-1",
      sessionKey: "agent:main:upstream",
      storePath: "/tmp/does-not-matter",
      entryId: "entry-1",
      threadId: "thread-1",
      control: { readThread } as unknown as Parameters<
        typeof resolveCodexUpstreamForkBoundary
      >[0]["control"],
    });

    expect(result).toMatchObject({ ok: false, code: "upstream-unavailable" });
    expect(readThread).toHaveBeenCalledWith("thread-1", false);
  });
});
