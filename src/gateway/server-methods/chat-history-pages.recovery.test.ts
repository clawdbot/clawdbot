import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appendTranscriptMessage,
  replaceSessionEntry,
  replaceTranscriptEvents,
} from "../../config/sessions/session-accessor.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { readChatHistoryMessageId } from "../session-history-tail.js";
import * as anchorReader from "../session-transcript-anchor-reader.js";
import { readSessionMessagesAsync } from "../session-transcript-readers.js";
import { readChatHistoryPage } from "./chat-history-pages.js";

afterEach(() => vi.restoreAllMocks());

const user = { role: "user", content: "Question" };
const failed = {
  role: "assistant",
  content: [],
  stopReason: "error",
  errorMessage: "The selected model is unavailable.",
  __openclaw: { runId: "recovered-run" },
};
const answer = {
  role: "assistant",
  content: [{ type: "text", text: "Recovered answer" }],
  stopReason: "stop",
  __openclaw: { runId: "recovered-run" },
};

type PageOptions = Pick<Parameters<typeof readChatHistoryPage>[0], "offset" | "messageId"> & {
  maxHistoryBytes?: number;
};

async function withTranscript(
  messages: Array<[id: string, message: Record<string, unknown>]>,
  use: (fixture: {
    append: (id: string, message: Record<string, unknown>) => Promise<unknown>;
    read: (options: PageOptions) => ReturnType<typeof readChatHistoryPage>;
    raw: () => ReturnType<typeof readSessionMessagesAsync>;
  }) => Promise<void>,
) {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const scope = {
      agentId: "main",
      sessionKey: "agent:main:page-recovery",
      sessionId: "page-recovery",
      storePath: path.join(state.sessionsDir(), "sessions.json"),
    };
    const entry = { sessionId: scope.sessionId, updatedAt: 1 };
    await replaceSessionEntry(scope, entry);
    await replaceTranscriptEvents(scope, [
      { type: "session", version: 3, id: scope.sessionId },
      ...messages.map(([id, message], index) => ({
        type: "message",
        id,
        parentId: messages[index - 1]?.[0] ?? null,
        message,
      })),
    ]);
    await use({
      append: (id, message) => appendTranscriptMessage(scope, { eventId: id, message }),
      read: (options) =>
        readChatHistoryPage({
          entry,
          provider: "openai",
          sessionId: scope.sessionId,
          storePath: scope.storePath,
          sessionAgentId: scope.agentId,
          canonicalKey: scope.sessionKey,
          max: 1,
          maxHistoryBytes: 100_000,
          effectiveMaxChars: 10_000,
          ignoreCliSessionImports: true,
          ...options,
        }),
      raw: () => readSessionMessagesAsync(scope, { mode: "full", reason: "recovery immutability" }),
    });
  });
}

describe("historical page recovery context", () => {
  it.each([
    { offset: 1, messageId: undefined, expectedIds: ["user"] },
    { offset: undefined, messageId: "failed", expectedIds: [] },
  ])(
    "omits a recovered failure outside the newer page (offset=$offset, anchor=$messageId)",
    async ({ expectedIds, ...options }) => {
      await withTranscript(
        [
          ["user", user],
          ["failed", failed],
          ["answer", answer],
        ],
        async ({ read, raw }) => {
          const original = await raw();
          const page = await read(options);

          expect(page.messages.map(readChatHistoryMessageId)).toEqual(expectedIds);
          if (options.offset !== undefined) {
            expect(page.pagination).toEqual({ offset: 1, totalMessages: 3, rawPageMessages: 2 });
          }
          expect(await raw()).toEqual(original);
        },
      );
    },
  );

  it("does not use a later turn to hide an unrecovered historical failure", async () => {
    await withTranscript(
      [
        ["user", user],
        ["failed", failed],
        ["next-user", user],
        ["answer", answer],
      ],
      async ({ read }) => {
        const page = await read({ offset: 2, messageId: undefined });
        expect(page.messages).toEqual([
          expect.objectContaining({
            stopReason: "error",
            __openclaw: expect.objectContaining({ id: "failed" }),
          }),
        ]);
      },
    );
  });

  it("keeps original page boundaries when messages append during recovery lookahead", async () => {
    await withTranscript(
      [
        ["user", user],
        ["failed", failed],
        ["answer", answer],
      ],
      async ({ append, read }) => {
        const readAround = anchorReader.readSessionMessagesAroundIdWithStatsAsync;
        vi.spyOn(anchorReader, "readSessionMessagesAroundIdWithStatsAsync").mockImplementationOnce(
          async (scope, options) => {
            await append("next-user", user);
            await append("next-answer", { ...answer, __openclaw: { runId: "next-run" } });
            return readAround(scope, options);
          },
        );

        const page = await read({ offset: 1, messageId: undefined });

        expect(page.messages.map(readChatHistoryMessageId)).toEqual(["user"]);
        expect(page.pagination).toEqual({ offset: 1, totalMessages: 3, rawPageMessages: 2 });
      },
    );
  });

  it("keeps the failure when newer recovery evidence exceeds the read byte budget", async () => {
    await withTranscript(
      [
        ["user", user],
        ["failed", failed],
        ["answer", answer],
      ],
      async ({ read }) => {
        const page = await read({ offset: 1, messageId: undefined, maxHistoryBytes: 1 });
        expect(page.messages.map(readChatHistoryMessageId)).toEqual(["failed"]);
      },
    );
  });

  it.each([
    { offset: 1, messageId: undefined, expectedReads: 0 },
    { offset: undefined, messageId: "answer", expectedReads: 1 },
  ])(
    "does not read recovery context for an ordinary page (offset=$offset, anchor=$messageId)",
    async ({ expectedReads, ...options }) => {
      await withTranscript(
        [
          ["user", user],
          ["answer", answer],
          ["next-user", user],
        ],
        async ({ read }) => {
          const reads = vi.spyOn(anchorReader, "readSessionMessagesAroundIdWithStatsAsync");
          const page = await read(options);
          expect(page.messages.map(readChatHistoryMessageId)).toEqual(["answer"]);
          expect(reads).toHaveBeenCalledTimes(expectedReads);
        },
      );
    },
  );
});
