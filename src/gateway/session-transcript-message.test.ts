import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it } from "vitest";
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
