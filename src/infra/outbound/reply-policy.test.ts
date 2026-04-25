import { describe, expect, it } from "vitest";
import { createReplyToFanout } from "./reply-policy.js";

describe("createReplyToFanout", () => {
  it("consumes implicit single-use replies once", () => {
    const next = createReplyToFanout({
      replyToId: "reply-1",
      replyToIdSource: "implicit",
      replyToMode: "first",
    });

    expect([next(), next(), next()]).toEqual(["reply-1", undefined, undefined]);
  });

  it("keeps explicit replies reusable even in single-use modes", () => {
    const next = createReplyToFanout({
      replyToId: "reply-1",
      replyToIdSource: "explicit",
      replyToMode: "first",
    });

    expect([next(), next()]).toEqual(["reply-1", "reply-1"]);
  });

  it("keeps all-mode replies reusable", () => {
    const next = createReplyToFanout({
      replyToId: "reply-1",
      replyToIdSource: "implicit",
      replyToMode: "all",
    });

    expect([next(), next()]).toEqual(["reply-1", "reply-1"]);
  });
});
