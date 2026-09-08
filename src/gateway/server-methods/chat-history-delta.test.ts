import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { STREAM_ERROR_FALLBACK_TEXT } from "../../agents/stream-message-shared.js";
import {
  appendTranscriptMessage,
  replaceSessionEntry,
  replaceTranscriptEvents,
} from "../../config/sessions/session-accessor.js";
import { readTranscriptDisplayDelta } from "../../config/sessions/session-accessor.sqlite-history-events.js";
import { buildGatewaySessionSnapshot } from "../session-event-payload.js";
import { readChatHistoryDelta } from "./chat-history-delta.js";
import { readChatHistoryPage } from "./chat-history-pages.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const maxBytes = 1_000_000;
const sessionKey = "agent:main:delta-budget";
const sessionId = "delta-budget-session";
const sessionSnapshot = buildGatewaySessionSnapshot({
  agentId: "main",
  includeSession: true,
  sessionRow: { key: sessionKey, sessionId, kind: "direct", updatedAt: 42 },
});

async function createTranscript() {
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
  return { scope, cursor: head.cursor };
}

async function readContents(contents: string[], requestedMaxBytes?: number) {
  const byteLimit = Math.min(requestedMaxBytes ?? maxBytes, maxBytes);
  const { scope, cursor } = await createTranscript();
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
    cursor,
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
    cursor,
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

const failedAssistant = {
  role: "assistant",
  provider: "openai",
  model: "primary",
  content: [],
  stopReason: "error",
  errorMessage: "model unavailable",
  __openclaw: { runId: "run-recovery" },
};
const recoveredAssistant = {
  role: "assistant",
  provider: "openai",
  model: "backup",
  content: [{ type: "text", text: "Recovered answer" }],
  stopReason: "stop",
  __openclaw: { runId: "run-recovery" },
};

type TranscriptScope = Awaited<ReturnType<typeof createTranscript>>["scope"];

function readDelta(scope: TranscriptScope, cursor: string) {
  return readChatHistoryDelta({ agentId: "main", cursor, scope, sessionKey, sessionSnapshot });
}

function readTail(scope: TranscriptScope, offset?: number) {
  return readChatHistoryPage({
    entry: { sessionId, updatedAt: 42 },
    provider: "openai",
    sessionId,
    storePath: scope.storePath,
    sessionAgentId: "main",
    canonicalKey: sessionKey,
    max: 20,
    maxHistoryBytes: maxBytes,
    effectiveMaxChars: 10_000,
    offset,
    messageId: undefined,
    ignoreCliSessionImports: true,
  });
}

describe("chat history commentary cursor reconciliation", () => {
  it.each([false, true])(
    "preserves keyed commentary and its tool sibling on cursor refresh (tool=%s)",
    async (withTool) => {
      const { scope, cursor } = await createTranscript();
      const commentary = {
        type: "text",
        text: "First paragraph.\n\n- first file\n- second file",
        textSignature: JSON.stringify({ v: 1, id: "commentary-1", phase: "commentary" }),
      };
      const toolCall = {
        type: "toolCall",
        id: "read-1",
        name: "read",
        arguments: { path: "workspace.txt" },
      };
      const savedMessage = {
        role: "assistant",
        content: [commentary, ...(withTool ? [toolCall] : [])],
        stopReason: withTool ? "toolUse" : "stop",
        __openclaw: { runId: "run-commentary" },
      };
      await appendTranscriptMessage(scope, {
        eventId: "commentary-and-tool",
        message: savedMessage,
      });

      // A saved cursor must not accept a partial envelope and permanently skip commentary.
      expect(readDelta(scope, cursor)).toEqual({ kind: "reset" });
      const refreshed = await readTail(scope);
      expect(refreshed.messages).toMatchObject([
        {
          role: "assistant",
          content: [{ type: "text", text: commentary.text }],
          openclawStreamFallback: { source: "segment", itemId: "commentary-1" },
        },
        ...(withTool ? [{ role: "assistant", content: [toolCall] }] : []),
      ]);
      expect(refreshed.messages).toHaveLength(withTool ? 2 : 1);
      expect(readTranscriptDisplayDelta(scope, { cursor })).toMatchObject({
        kind: "page",
        events: [{ event: { message: savedMessage } }],
      });
      if (!refreshed.deltaCursor) {
        throw new Error("Reconciled commentary must resume incremental history");
      }
      await appendTranscriptMessage(scope, {
        eventId: "final-answer",
        message: { role: "assistant", content: [{ type: "text", text: "Done." }] },
      });
      expect(readDelta(scope, refreshed.deltaCursor)).toMatchObject({
        kind: "delta",
        messages: [{ messageId: "final-answer", message: { content: [{ text: "Done." }] } }],
      });
    },
  );
});

describe("chat history recovery cursor eligibility", () => {
  it.each([undefined, 0])(
    "keeps refreshes authoritative while a tail error can recover (offset=%s)",
    async (offset) => {
      const { scope, cursor } = await createTranscript();
      await appendTranscriptMessage(scope, {
        eventId: "failed-attempt",
        message: failedAssistant,
      });
      expect(readDelta(scope, cursor)).toEqual({ kind: "reset" });

      const pending = await readTail(scope, offset);
      expect(pending.messages).toContainEqual(
        expect.objectContaining({ __openclaw: expect.objectContaining({ id: "failed-attempt" }) }),
      );
      expect(pending).not.toHaveProperty("deltaCursor");

      await appendTranscriptMessage(scope, {
        eventId: "recovered-answer",
        message: recoveredAssistant,
      });
      const recovered = await readTail(scope, offset);
      expect(recovered.messages).toEqual([
        expect.objectContaining({
          __openclaw: expect.objectContaining({ id: "recovered-answer" }),
        }),
      ]);
      expect(recovered.deltaCursor).toEqual(expect.any(String));
      if (!recovered.deltaCursor) {
        throw new Error("Recovered history must resume incremental updates");
      }

      await appendTranscriptMessage(scope, {
        eventId: "next-user",
        message: { role: "user", content: "next turn" },
      });
      await appendTranscriptMessage(scope, {
        eventId: "next-answer",
        message: { ...recoveredAssistant, __openclaw: { runId: "run-next" } },
      });
      expect(readDelta(scope, recovered.deltaCursor)).toMatchObject({
        kind: "delta",
        deltaCursor: expect.any(String),
        messages: [{ messageId: "next-user" }, { messageId: "next-answer" }],
      });
    },
  );

  it.each([
    ["empty provider failure", failedAssistant],
    [
      "legacy stream placeholder",
      {
        ...failedAssistant,
        content: [{ type: "text", text: STREAM_ERROR_FALLBACK_TEXT }],
      },
    ],
  ])("resets a single delta containing %s and its recovered answer", async (_name, failure) => {
    const { scope, cursor } = await createTranscript();
    await appendTranscriptMessage(scope, { eventId: "failed-attempt", message: failure });
    await appendTranscriptMessage(scope, {
      eventId: "recovered-answer",
      message: recoveredAssistant,
    });

    expect(readDelta(scope, cursor)).toEqual({ kind: "reset" });
    const recovered = await readTail(scope);
    expect(recovered.messages).toEqual([
      expect.objectContaining({ __openclaw: expect.objectContaining({ id: "recovered-answer" }) }),
    ]);
    expect(recovered.deltaCursor).toEqual(expect.any(String));
  });

  it("retains incremental delivery for failed attempts with visible partial output", async () => {
    const { scope, cursor } = await createTranscript();
    await appendTranscriptMessage(scope, {
      eventId: "partial-failure",
      message: { ...failedAssistant, content: [{ type: "text", text: "Partial answer" }] },
    });
    expect(readDelta(scope, cursor)).toMatchObject({
      kind: "delta",
      messages: [{ messageId: "partial-failure" }],
    });
    expect((await readTail(scope)).deltaCursor).toEqual(expect.any(String));
  });
});
