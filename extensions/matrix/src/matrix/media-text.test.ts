import { describe, expect, it } from "vitest";
import { formatMatrixMessageText, resolveMatrixMessageAttachment } from "./media-text.js";
import { summarizeMatrixMessageContextEvent } from "./monitor/context-summary.js";
import type { MatrixRawEvent } from "./monitor/types.js";

describe("Matrix media kind resolution", () => {
  it.each(["toString", "constructor", "valueOf", "__proto__"])(
    "treats msgtype %s as a non-media message",
    (msgtype) => {
      expect(resolveMatrixMessageAttachment({ body: "hello", msgtype })).toBeUndefined();
      expect(formatMatrixMessageText({ body: "hello", msgtype })).toBe("hello");
    },
  );

  it("keeps a filename-shaped body when msgtype inherits from Object.prototype", () => {
    expect(formatMatrixMessageText({ body: "report.pdf", msgtype: "toString" })).toBe("report.pdf");
  });

  it("summarizes a remote event with an Object.prototype msgtype as plain text", () => {
    const event = {
      event_id: "$evt",
      sender: "@mallory:example.org",
      type: "m.room.message",
      origin_server_ts: 1,
      content: { body: "hello", msgtype: "toString" },
    } as unknown as MatrixRawEvent;
    expect(summarizeMatrixMessageContextEvent(event)).toBe("hello");
  });

  it("still resolves real media msgtypes", () => {
    expect(resolveMatrixMessageAttachment({ body: "cat.png", msgtype: "m.image" })).toEqual({
      kind: "image",
      caption: undefined,
      filename: "cat.png",
    });
  });
});
