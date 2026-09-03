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

function attestedHarnessPrompt(upstreamText: string) {
  const prompt = attachUpstreamUserText(
    attachCodexMirrorIdentity(
      { role: "user", content: "visible question", timestamp: 0 },
      "turn-1:prompt",
    ),
    upstreamText,
  );
  return attachCodexMirrorAttestation(prompt, fingerprintCodexMirrorSourceMessage(prompt));
}

async function resolveFromTurns(params: {
  turns: readonly CodexTurn[];
  userMessageOrdinal: number;
  localPrefixTexts: readonly (string | undefined)[];
  localIdentities?: readonly (string | undefined)[];
  historyMode?: "legacy" | "paginated";
}) {
  const identities =
    params.localIdentities ??
    params.turns
      .flatMap((nativeTurn) =>
        nativeTurn.items
          .filter((nativeItem) => nativeItem.type === "userMessage")
          .map((nativeItem) => `${nativeTurn.id}:${nativeItem.id}`),
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
  return await resolveEntries(
    params.turns,
    entries,
    `entry-${params.userMessageOrdinal}`,
    params.historyMode,
  );
}

async function resolveEntries(
  turns: readonly CodexTurn[],
  entries: SessionTranscriptMessageEntry[],
  entryId: string,
  historyMode: "legacy" | "paginated" = "legacy",
  canonicalThreadId?: string,
) {
  transcriptMocks.readVisibleEntries.mockResolvedValue(entries);
  const result = await resolveCodexUpstreamForkBoundary({
    agentId: "main",
    sessionId: "session-1",
    sessionKey: "agent:main:upstream",
    storePath: "/tmp/does-not-matter",
    entryId,
    threadId: "thread-1",
    canonicalThreadId,
    control: {
      readThread: vi.fn(async (id: string) => ({ id, historyMode })),
      listTurnPage: vi.fn(async () => ({ data: [...turns] })),
    } as unknown as Parameters<typeof resolveCodexUpstreamForkBoundary>[0]["control"],
  });
  return result.ok
    ? {
        ok: true as const,
        boundary: result.boundary,
        ...(canonicalThreadId ? { canonical: result.canonical } : {}),
      }
    : result;
}

describe("resolveCodexUpstreamForkBoundaryFromTurns", () => {
  it.each(["legacy", "paginated"] as const)(
    "maps the recorded user identity to the upstream turn with %s history",
    async (historyMode) => {
      const result = await resolveFromTurns({
        turns: [turn("turn-1", [user("one")]), turn("turn-2", [user("two")])],
        userMessageOrdinal: 1,
        localPrefixTexts: ["one", "two"],
        historyMode,
      });

      expect(result).toEqual({
        ok: true,
        boundary: {
          beforeTurnId: "turn-2",

          lastRetainedTurnId: "turn-1",
        },
      });
    },
  );

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

        lastRetainedTurnId: null,
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

        lastRetainedTurnId: "turn-review",
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
      const message = attestedHarnessPrompt("harness context\nvisible question");
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

  it.each([
    { name: "matching long text", prefix: "x".repeat(70 * 1024), suffix: "Q1", matches: true },
    {
      name: "changed long-text suffix",
      prefix: "x".repeat(70 * 1024),
      suffix: "Q2",
      matches: false,
    },
    { name: "changed whitespace", prefix: "harness context\n", suffix: "Q1 \n", matches: false },
  ])(
    "compares complete attested harness prompts with $name",
    async ({ prefix, suffix, matches }) => {
      const entries: SessionTranscriptMessageEntry[] = [
        {
          entryId: "entry-0",
          parentId: null,
          seq: 0,
          role: "user",
          message: attestedHarnessPrompt(`${prefix}Q1`),
        },
        {
          entryId: "entry-1",
          parentId: "entry-0",
          seq: 1,
          role: "user",
          message: attachCodexMirrorIdentity(
            { role: "user", content: "target", timestamp: 1 },
            "turn-2:target-user",
          ),
        },
      ];
      const turns = [
        turn("turn-1", [
          item("userMessage", {
            id: "native-prompt",
            content: [{ type: "text", text: `${prefix}${suffix}`, text_elements: [] }],
          }),
        ]),
        turn("turn-2", [user("target")]),
      ];

      // Verify the full prompt both when selected and when retained before an unchanged target.
      for (const canonicalThreadId of [undefined, "canonical-thread"]) {
        for (const targetIndex of [0, 1]) {
          const result = await resolveEntries(
            turns,
            entries,
            `entry-${targetIndex}`,
            "legacy",
            canonicalThreadId,
          );
          expect(result).toMatchObject(
            matches
              ? {
                  ok: true,
                  boundary: { beforeTurnId: `turn-${targetIndex + 1}` },
                  ...(canonicalThreadId
                    ? { canonical: { thread: { id: canonicalThreadId } } }
                    : {}),
                }
              : { ok: false, code: "drift-mismatch" },
          );
        }
      }
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
