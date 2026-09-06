import { readSessionMessageIdentity } from "@openclaw/gateway-client/browser";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it } from "vitest";
import { createNestedToolActivity } from "../sessions/nested-tool-activity.js";
import { projectChatDisplayMessage } from "./chat-display-projection.js";
import {
  projectSessionMessagePayload,
  projectTranscriptEntryMessage,
} from "./session-transcript-message.js";

const position = { source: "selected-snapshot", rawSeq: 4 };
const message = {
  role: "assistant",
  content: "done",
  __openclaw: { transcriptPosition: { source: "untrusted", rawSeq: 0 } },
};

describe("trusted transcript display metadata", () => {
  it("keeps nested activity run ownership distinct from entry deduplication in history and live events", () => {
    const activity = {
      ...createNestedToolActivity({
        runId: "owning-run",
        scopeId: "attempt",
        afterEntryId: "parent",
        startOrder: 0,
        parentToolCallId: "exec",
        toolCallId: "nested-read",
        toolName: "read",
        input: { path: "example.txt" },
        result: { content: [{ type: "text", text: "done" }] },
        isError: false,
        startedAt: 1,
        timestamp: 2,
      }),
      idempotencyKey: "attempt:nested-read",
    };
    const history = projectChatDisplayMessage(
      projectTranscriptEntryMessage(
        { type: "message", id: "entry", message: activity },
        2,
        position,
      ),
    );
    const live = projectSessionMessagePayload({
      message: activity,
      messageId: "entry",
      messageSeq: 2,
      transcriptPosition: position,
      sessionKey: "agent:main:dashboard:nested",
    }).payload?.message;
    for (const projected of [history, live]) {
      expect(readSessionMessageIdentity(projected)).toMatchObject({
        id: "entry",
        sequence: 2,
        runId: "owning-run",
        idempotencyKey: "attempt:nested-read",
        sendId: null,
      });
      expect(
        asOptionalRecord(asOptionalRecord(projected)?.["__openclaw"])?.transcriptPosition,
      ).toEqual(position);
    }
    expect(activity).not.toHaveProperty("__openclaw");
  });

  it.each([undefined, position])(
    "uses only reader-supplied placement (%j)",
    (transcriptPosition) => {
      const history = projectTranscriptEntryMessage(
        { type: "message", id: "entry", message },
        2,
        transcriptPosition,
      );
      const live = projectSessionMessagePayload({
        message,
        messageId: "entry",
        messageSeq: 2,
        transcriptPosition,
        sessionKey: "agent:main:main",
      }).payload?.message;
      for (const projected of [history, live]) {
        const metadata = asOptionalRecord(asOptionalRecord(projected)?.["__openclaw"]);
        expect(metadata?.transcriptPosition).toEqual(transcriptPosition);
        expect(metadata).toMatchObject({ id: "entry", seq: 2 });
      }
      expect(message["__openclaw"].transcriptPosition.source).toBe("untrusted");
    },
  );

  it.each(["compaction", "reset"])(
    "keeps %s markers in the same physical coordinate space",
    (type) => {
      const identity = { runId: "run-compaction", itemId: "item-compaction" };
      const projected = asOptionalRecord(
        projectTranscriptEntryMessage({ type, id: "boundary", __openclaw: identity }, 3, position),
      );
      expect(projected?.role).toBe("system");
      expect(projected?.["__openclaw"]).toEqual({
        kind: type,
        id: "boundary",
        seq: 3,
        transcriptPosition: position,
        ...(type === "compaction" ? identity : {}),
      });
    },
  );
});
