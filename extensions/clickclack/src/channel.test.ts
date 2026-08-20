import { describe, expect, it } from "vitest";
import { clickClackPlugin } from "../channel-plugin-api.js";

describe("ClickClack channel capabilities", () => {
  it("advertises media delivery through the public plugin descriptor", () => {
    expect(clickClackPlugin.capabilities).toEqual({
      chatTypes: ["direct", "group"],
      threads: true,
      media: true,
      blockStreaming: true,
    });
  });
});
