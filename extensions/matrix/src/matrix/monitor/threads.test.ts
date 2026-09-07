// Matrix tests cover threads plugin behavior.
import { describe, expect, it } from "vitest";
import { resolveMatrixReplyToEventId, resolveMatrixThreadRootId } from "../relations.js";
import { resolveMatrixThreadRouting } from "./threads.js";

describe("resolveMatrixThreadRouting", () => {
  it.each([undefined, false, true])(
    "keeps thread placement independent from reply fallback %s",
    (isFallingBack) => {
      const content = {
        "m.relates_to": {
          rel_type: "m.thread",
          event_id: "$root",
          is_falling_back: isFallingBack,
          "m.in_reply_to": { event_id: "$selected" },
        },
      };
      expect(resolveMatrixThreadRootId(content)).toBe("$root");
      expect(resolveMatrixReplyToEventId(content)).toBe(
        isFallingBack === true ? undefined : "$selected",
      );
    },
  );
  it("keeps sessions flat when threadReplies is off", () => {
    expect(
      resolveMatrixThreadRouting({
        isDirectMessage: false,
        threadReplies: "off",
        messageId: "$reply1",
        threadRootId: "$root",
      }),
    ).toEqual({
      threadId: undefined,
    });
  });

  it("uses the inbound thread root when replies arrive inside an existing thread", () => {
    expect(
      resolveMatrixThreadRouting({
        isDirectMessage: false,
        threadReplies: "inbound",
        messageId: "$reply1",
        threadRootId: "$root",
      }),
    ).toEqual({
      threadId: "$root",
    });
  });

  it("keeps top-level inbound messages flat when threadReplies is inbound", () => {
    expect(
      resolveMatrixThreadRouting({
        isDirectMessage: false,
        threadReplies: "inbound",
        messageId: "$root",
      }),
    ).toEqual({
      threadId: undefined,
    });
  });

  it("uses the triggering message as the thread id when threadReplies is always", () => {
    expect(
      resolveMatrixThreadRouting({
        isDirectMessage: false,
        threadReplies: "always",
        messageId: "$root",
      }),
    ).toEqual({
      threadId: "$root",
    });
  });

  it("lets dm.threadReplies override room threading behavior", () => {
    expect(
      resolveMatrixThreadRouting({
        isDirectMessage: true,
        threadReplies: "always",
        dmThreadReplies: "off",
        messageId: "$reply1",
        threadRootId: "$root",
      }),
    ).toEqual({
      threadId: undefined,
    });
  });
});
