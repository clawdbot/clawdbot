import { describe, expect, it } from "vitest";
import {
  buildClickClackTarget,
  normalizeClickClackTarget,
  parseClickClackTarget,
} from "./target.js";

describe("ClickClack targets", () => {
  it("parses channel targets", () => {
    expect(parseClickClackTarget("channel:general")).toEqual({
      chatType: "group",
      kind: "channel",
      id: "general",
    });
    expect(normalizeClickClackTarget("general")).toBe("channel:general");
  });

  it("parses thread and dm targets", () => {
    expect(buildClickClackTarget(parseClickClackTarget("thread:msg_1"))).toBe("thread:msg_1");
    expect(parseClickClackTarget("dm:usr_1")).toEqual({
      chatType: "direct",
      kind: "dm",
      id: "usr_1",
    });
  });
});
