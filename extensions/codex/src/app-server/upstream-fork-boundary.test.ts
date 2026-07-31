import type { SessionTranscriptMessageEntry } from "openclaw/plugin-sdk/session-transcript-runtime";
import { describe, expect, it, vi } from "vitest";
import type { CodexThreadItem, CodexTurn } from "./protocol.js";
import { resolveCodexUpstreamForkBoundary } from "./upstream-fork-boundary.js";

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
}) {
  const entries: SessionTranscriptMessageEntry[] = params.localPrefixTexts.map((text, index) => ({
    entryId: `entry-${index}`,
    parentId: index > 0 ? `entry-${index - 1}` : null,
    seq: index,
    role: "user",
    message: {
      role: "user",
      content: text ?? [{ type: "image", data: "", mimeType: "image/png" }],
      timestamp: index,
    },
  }));
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
