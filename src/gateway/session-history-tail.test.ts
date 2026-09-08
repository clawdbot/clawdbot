import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import { replaceTranscriptEvents } from "../config/sessions/session-accessor.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { readIncrementalChatHistoryTail } from "./session-history-tail.js";

it("does not serialize transcript batches when the extended sparse byte guard is unused", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const sessionId = "history-byte-accounting";
    const readScope = {
      agentId: "main",
      sessionId,
      sessionKey: `agent:main:${sessionId}`,
      storePath: `${state.sessionsDir()}/sessions.json`,
    };
    // Wide records exceed the initial 1 MiB byte cap, so the ordinary window
    // needs additional pages even though it stays below the message-count limit.
    const events = Array.from({ length: 400 }, (_, index) => ({
      type: "message",
      id: `row-${index}`,
      parentId: index === 0 ? null : `row-${index - 1}`,
      message: {
        role: "toolResult",
        toolName: "exec",
        toolCallId: `call-${index}`,
        content: [{ type: "text", text: "output ".repeat(600) }],
      },
    }));
    await replaceTranscriptEvents(readScope, [
      { type: "session", version: 3, id: sessionId },
      ...events,
    ]);

    const stringify = vi.spyOn(JSON, "stringify");
    try {
      const tail = await readIncrementalChatHistoryTail({
        entry: undefined,
        readScope,
        effectiveMaxChars: 8000,
        max: 800,
        maxBytes: 1024,
      });
      expect(tail.readPage.messages.length).toBeLessThan(events.length);
      expect(tail.rawPageMessages).toBe(events.length);
      expect(tail.projected).toHaveLength(events.length);
      expect(tail.projected.at(-1)).toMatchObject({ __openclaw: { id: "row-399", seq: 400 } });
      const serializedRows = stringify.mock.calls.reduce(
        (count, [value]) =>
          count + (Array.isArray(value) && asOptionalRecord(value[0])?.role ? value.length : 0),
        0,
      );
      expect(serializedRows).toBe(0);
    } finally {
      stringify.mockRestore();
    }
  });
});
