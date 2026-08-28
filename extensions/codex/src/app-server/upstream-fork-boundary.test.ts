import type { SessionTranscriptMessageEntry } from "openclaw/plugin-sdk/session-transcript-runtime";
import { describe, expect, it, vi } from "vitest";
import type { CodexThreadItem, CodexTurn } from "./protocol.js";
import {
  attachCodexMirrorAttestation,
  fingerprintCodexMirrorSourceMessage,
} from "./transcript-mirror-attestation.js";
import { resolveCodexUpstreamForkBoundary } from "./upstream-fork-boundary.js";
import { attachCodexMirrorIdentity, attachUpstreamUserText } from "./upstream-prompt-provenance.js";

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
  return item("userMessage", {
    id: `${text}-user`,
    content: [{ type: "text", text, text_elements: [] }],
  });
}

function turn(id: string, items: CodexThreadItem[], overrides: Partial<CodexTurn> = {}): CodexTurn {
  return { id, status: "completed", items, ...overrides };
}

async function resolveFromTurns(params: {
  turns: readonly CodexTurn[];
  userMessageOrdinal: number;
  localPrefixTexts: readonly (string | undefined)[];
  localIdentities?: readonly (string | undefined)[];
}) {
  const identities =
    params.localIdentities ??
    params.turns
      .flatMap((turn) =>
        turn.items
          .filter((item) => item.type === "userMessage")
          .map((item) => `${turn.id}:${item.id}`),
      )
      .slice(-params.localPrefixTexts.length);
  const entries: SessionTranscriptMessageEntry[] = params.localPrefixTexts.map((text, index) => ({
    entryId: `entry-${index}`,
    parentId: index > 0 ? `entry-${index - 1}` : null,
    seq: index,
    role: "user",
    message: identities[index]
      ? attachCodexMirrorIdentity(
          {
            role: "user",
            content: text ?? [{ type: "image", data: "", mimeType: "image/png" }],
            timestamp: index,
          },
          identities[index],
        )
      : { role: "user", content: text ?? "", timestamp: index },
  }));
  return await resolveEntries(params.turns, entries, `entry-${params.userMessageOrdinal}`);
}

async function resolveEntries(
  turns: readonly CodexTurn[],
  entries: SessionTranscriptMessageEntry[],
  entryId: string,
) {
  transcriptMocks.readVisibleEntries.mockResolvedValue(entries);
  const result = await resolveCodexUpstreamForkBoundary({
    agentId: "main",
    sessionId: "session-1",
    sessionKey: "agent:main:upstream",
    storePath: "/tmp/does-not-matter",
    entryId,
    threadId: "thread-1",
    control: {
      readThread: vi.fn(async () => ({ id: "thread-1" })),
      listTurnPage: vi.fn(async () => ({ data: [...turns] })),
    } as unknown as Parameters<typeof resolveCodexUpstreamForkBoundary>[0]["control"],
  });
  return result.ok ? { ok: true as const, boundary: result.boundary } : result;
}

describe("resolveCodexUpstreamForkBoundaryFromTurns", () => {
  it("maps the recorded user identity to the upstream turn", async () => {
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

  it("locates the retained user after review history", async () => {
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

  it.each([undefined, "unknown:item"])(
    "rejects an unrecognized mirror identity %s",
    async (identity) => {
      const result = await resolveFromTurns({
        turns: [turn("turn-1", [user("one")])],
        userMessageOrdinal: 0,
        localPrefixTexts: ["one"],
        localIdentities: [identity],
      });

      expect(result).toMatchObject({ ok: false, code: "drift-mismatch" });
    },
  );

  it("rejects equal targets over divergent prefixes", async () => {
    const result = await resolveFromTurns({
      turns: [turn("turn-1", [user("upstream-old")]), turn("turn-2", [user("target")])],
      userMessageOrdinal: 1,
      localPrefixTexts: ["local-old", "target"],
    });

    expect(result).toMatchObject({ ok: false, code: "drift-mismatch" });
  });

  it("rejects inherited history absent from native projection even when a canonical target matches", async () => {
    const result = await resolveFromTurns({
      // Ordinary injected ResponseItems do not project into native turns.
      turns: [turn("canonical-turn", [user("target")])],
      userMessageOrdinal: 1,
      localPrefixTexts: ["one", "target"],
      localIdentities: ["source-turn:source-user", "canonical-turn:prompt"],
    });

    expect(result).toMatchObject({ ok: false, code: "drift-mismatch" });
  });

  it.each([false, true])(
    "validates a recorded harness prompt and its local content (edited: %s)",
    async (edited) => {
      const prompt = attachUpstreamUserText(
        attachCodexMirrorIdentity(
          { role: "user", content: "visible question", timestamp: 0 },
          "turn-1:prompt",
        ),
        "harness context\nvisible question",
      );
      const message = attachCodexMirrorAttestation(
        prompt,
        fingerprintCodexMirrorSourceMessage(prompt),
      );
      if (message.role !== "user") {
        throw new Error("Attestation changed the user fixture's role");
      }
      const result = await resolveEntries(
        [turn("turn-1", [user("harness context\nvisible question")])],
        [
          {
            entryId: "entry-0",
            parentId: null,
            seq: 0,
            role: "user",
            message: edited ? { ...message, content: "changed question" } : message,
          },
        ],
        "entry-0",
      );

      expect(result).toMatchObject(
        edited
          ? { ok: false, code: "drift-mismatch" }
          : {
              ok: true,
              boundary: { beforeTurnId: "turn-1" },
            },
      );
    },
  );

  it("rejects upstream messages carrying semantic non-text inputs", async () => {
    const result = await resolveFromTurns({
      turns: [
        turn("turn-1", [
          item("userMessage", {
            content: [
              { type: "text", text: "one", text_elements: [] },
              { type: "skill", name: "reviewer", path: "/skills/reviewer" },
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
