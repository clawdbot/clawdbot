import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  appendTranscriptMessage,
  replaceSessionEntry,
  replaceTranscriptEvents,
} from "../../config/sessions/session-accessor.js";
import { readTranscriptDisplayDelta } from "../../config/sessions/session-accessor.sqlite-history-events.js";
import { buildGatewaySessionSnapshot } from "../session-event-payload.js";
import { readChatHistoryDelta } from "./chat-history-delta.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const maxBytes = 1_000_000;
const sessionKey = "agent:main:delta-budget";
const sessionId = "delta-budget-session";
const sessionSnapshot = buildGatewaySessionSnapshot({
  agentId: "main",
  includeSession: true,
  sessionRow: { key: sessionKey, sessionId, kind: "direct", updatedAt: 42 },
});

async function readContents(contents: string[], requestedMaxBytes?: number) {
  const byteLimit = Math.min(requestedMaxBytes ?? maxBytes, maxBytes);
  const scope = {
    agentId: "main",
    sessionKey,
    sessionId,
    storePath: path.join(tempDirs.make("openclaw-delta-budget-"), "sessions.json"),
  };
  await replaceSessionEntry(scope, { sessionId, updatedAt: 42 });
  await replaceTranscriptEvents(scope, [{ type: "session", version: 3, id: sessionId }]);
  const head = readTranscriptDisplayDelta(scope);
  if (head.kind !== "page") {
    throw new Error("Expected an initial transcript cursor");
  }
  for (const [index, content] of contents.entries()) {
    await appendTranscriptMessage(scope, {
      eventId: `result-${index}`,
      now: 42,
      message: {
        role: "toolResult",
        toolName: "read",
        toolCallId: `call-${index}`,
        content,
        providerReplay: { private: "PRIVATE_REPLAY" },
        __openclaw: { upstreamUserText: "PRIVATE_UPSTREAM" },
      },
    });
  }
  const raw = readTranscriptDisplayDelta(scope, {
    cursor: head.cursor,
    maxBytes: byteLimit,
    maxEvents: 200,
  });
  expect(raw).toMatchObject({
    kind: "page",
    hasMore: false,
    events: contents.map((_, index) => ({ messageSeq: index + 1 })),
  });
  if (raw.kind !== "page") {
    throw new Error("Expected a complete raw delta");
  }
  expect(raw.serializedBytes).toBeLessThan(byteLimit);
  expect(JSON.stringify(raw.events)).toContain("PRIVATE_REPLAY");
  return readChatHistoryDelta({
    agentId: "main",
    cursor: head.cursor,
    maxBytes: requestedMaxBytes,
    scope,
    sessionKey,
    sessionSnapshot,
  });
}

describe("chat history delta display budget", () => {
  it.each([
    [1, 0, undefined],
    [1, 1, undefined],
    [2, 0, undefined],
    [2, 1, undefined],
    [2, 0, 64 * 1024],
    [2, 1, 64 * 1024],
    [2, 0, 2 * maxBytes],
    [2, 1, 2 * maxBytes],
  ] as const)(
    "preserves the UTF-8 boundary with %i envelopes at limit + %i bytes (requested maxBytes: %s)",
    async (count, extraBytes, requestedMaxBytes) => {
      const byteLimit = Math.min(requestedMaxBytes ?? maxBytes, maxBytes);
      const prefix = 'escaped: "\\\n🤖\ud800';
      const contents = Array.from({ length: count }, () => prefix);
      const small = await readContents(contents, requestedMaxBytes);
      if (small.kind !== "delta") {
        throw new Error("Expected the small delta");
      }
      contents[0] =
        prefix +
        "x".repeat(
          byteLimit - Buffer.byteLength(JSON.stringify(small.messages), "utf8") + extraBytes,
        );
      const result = await readContents(contents, requestedMaxBytes);
      if (extraBytes > 0) {
        expect(result).toEqual({ kind: "reset" });
        return;
      }
      expect(result).toMatchObject({
        kind: "delta",
        activeLeafEntryId: `result-${count - 1}`,
        messages: contents.map((content, index) => ({
          messageId: `result-${index}`,
          messageSeq: index + 1,
          message: { content },
        })),
      });
      if (result.kind !== "delta") {
        throw new Error("Expected the exact-limit delta");
      }
      const serialized = JSON.stringify(result.messages);
      expect(Buffer.byteLength(serialized, "utf8")).toBe(byteLimit);
      expect(serialized).not.toContain("PRIVATE_REPLAY");
      expect(serialized).not.toContain("PRIVATE_UPSTREAM");
    },
  );
});
